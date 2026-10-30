/**
 * Per-client page rate limiter of the demo worker (worker.js) — pure apart from the injected
 * counter state, so `node --test cf-worker/test/` covers it without a Workers runtime. Kept out of
 * the entry module: workerd treats the main module's named exports as entrypoints.
 */
export const WINDOW_MS = 60_000;
export const LIMITS = { page: 180 };
export const RETRY_AFTER_SEC = 30;
/** Above this many tracked clients, idle ones are swept (and, failing that, the oldest dropped). */
const MAX_CLIENTS = 10_000;

/**
 * The limiter key for a client IP: an IPv4 address as is; an IPv6 address by its /64 prefix
 * (privacy addresses rotate within a /64, so the full address is no key at all). IPv4-mapped
 * IPv6 (`::ffff:1.2.3.4`) keys as the IPv4. A missing/garbled header shares one `unknown` key.
 */
export function clientKey(ip) {
  const raw = (ip ?? '').trim().toLowerCase().replace(/%.*$/, '');
  if (!raw) return 'unknown';
  if (!raw.includes(':')) return raw;
  const mapped = raw.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return mapped[1];
  const [head, tail] = raw.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  // An embedded dotted IPv4 tail fills two hextets; it never reaches the /64 prefix anyway.
  const width = (parts) => parts.reduce((n, p) => n + (p.includes('.') ? 2 : 1), 0);
  const groups = tail === undefined ? left : [...left, ...Array(Math.max(0, 8 - width(left) - width(right))).fill('0'), ...right];
  const prefix = groups.slice(0, 4).map((g) => parseInt(g, 16));
  if (prefix.length < 4 || prefix.some((g) => !Number.isFinite(g) || g < 0 || g > 0xffff)) return raw;
  return `${prefix.map((g) => g.toString(16)).join(':')}::/64`;
}

/** Counter state: client key → timestamp log. Inject a fresh one per test. */
export function createLimiterState() {
  return { clients: new Map() };
}

function windowLog(state, key, nowMs) {
  let log = state.clients.get(key);
  if (!log) {
    if (state.clients.size >= MAX_CLIENTS) sweep(state, nowMs);
    log = [];
    state.clients.set(key, log);
  }
  // Slide the window: drop timestamps older than WINDOW_MS (the log is in time order).
  let stale = 0;
  while (stale < log.length && log[stale] <= nowMs - WINDOW_MS) stale++;
  if (stale) log.splice(0, stale);
  return log;
}

function sweep(state, nowMs) {
  const idle = (log) => log.length === 0 || log[log.length - 1] <= nowMs - WINDOW_MS;
  for (const [key, log] of state.clients) if (idle(log)) state.clients.delete(key);
  // Still full of active clients: drop the oldest-inserted ones rather than grow without bound.
  for (const key of state.clients.keys()) {
    if (state.clients.size < MAX_CLIENTS) break;
    state.clients.delete(key);
  }
}

/**
 * Admit or refuse one request. Pure apart from `state`: an admitted request is counted; a refused
 * one is not, so a looping client still gets exactly the cap through.
 */
export function checkLimit(state, ip, nowMs) {
  const log = windowLog(state, clientKey(ip), nowMs);
  if (log.length >= LIMITS.page) return { allowed: false, retryAfterSec: RETRY_AFTER_SEC };
  log.push(nowMs);
  return { allowed: true, retryAfterSec: 0 };
}
