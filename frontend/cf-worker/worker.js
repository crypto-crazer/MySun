/**
 * MySun demo edge worker — serves the static frontend build (Workers Static Assets) to everyone,
 * always. It proxies nothing: the demo chain left the public frontend (TASK-RETIRE-DEMO-CHAIN-WORKER,
 * 2026-10-23), so the public demo makes zero requests toward the home Mac. `/rpc` is just an
 * unknown path (the ASSETS binding's SPA fallback answers it).
 *
 * Per-client page rate caps (TASK-QUOTA-GUARDS): on 2026-10-22 one looping visitor burned the
 * account's whole 100k/day free Workers quota (error 1027 took the demo + analytics down for
 * hours). Every client — IPv4 address, or IPv6 /64 — gets a sliding 60s window of 180 requests
 * (3/s — no human reloads that fast). The decision logic is pure and lives in ratelimit.js; the
 * counters live in this isolate's memory.
 */
import { RETRY_AFTER_SEC, checkLimit, createLimiterState } from './ratelimit.js';

// Per isolate: a client's requests mostly land on one colo's warm isolate, which is what a
// stuck tab or reload loop looks like. Not a global guarantee — see the commit for why not the
// Rate Limiting binding.
const limiter = createLimiterState();

export default {
  async fetch(request, env) {
    const ip = request.headers.get('cf-connecting-ip');
    if (!checkLimit(limiter, ip, Date.now()).allowed) {
      return new Response('rate limited\n', {
        status: 429,
        headers: { 'retry-after': String(RETRY_AFTER_SEC), 'content-type': 'text/plain' },
      });
    }

    // Everything is a static asset; unmatched GETs get the SPA shell
    // (not_found_handling is applied by the ASSETS binding).
    return env.ASSETS.fetch(request);
  },
};
