/**
 * The NAV history the off-chain collector writes (backend `collect-nav`): one JSON object per line,
 * appended hourly per deployed vault, ts ascending. No React, no network — the fetch lives in
 * ./useNavHistory.ts.
 *
 * Only the fields the chart needs are kept (`ts / chainId / vaultKey / navUsd`, plus `tvlUsd` /
 * `feesUsd` for later). The collector's USD is the same display-only spot valuation the app does
 * (docs/LIVE-DATA.md) — nothing here is an on-chain NAV.
 *
 * Imports are relative (not `@/`), like spot.ts: plain module, runnable under tsx.
 */

/** A real series needs at least this many snapshots for one vault; fewer → the chart stays illustrative. */
export const MIN_NAV_HISTORY_POINTS = 6;

/**
 * One basket leg of a snapshot: its pending (unharvested) fee amount, as the collector read it from the
 * adapter's `fees()`. `feeRaw` stays a decimal string — the amounts are bigints and the row is JSON.
 */
export interface NavHistoryTokenRow {
  address: string;
  symbol?: string;
  decimals: number;
  /** Display-only spot price the collector valued the leg at. */
  priceUsd: number;
  /** Pending fee amount in the token's base units. NOT cumulative: a harvest resets it. */
  feeRaw: string;
  feeUsd?: number;
}

/** One collector snapshot, reduced to what the app reads. */
export interface NavHistoryRow {
  /** Epoch ms of the snapshot. */
  t: number;
  /** The snapshot's ISO timestamp, as written. */
  ts: string;
  chainId: number;
  vaultKey: string;
  /** Spot NAV in USD; undefined when the collector could not price it (e.g. zero supply). */
  navUsd: number | undefined;
  tvlUsd: number | undefined;
  /** Pending (unharvested) fees in USD — a level, not a cumulative total (see NavHistoryTokenRow). */
  feesUsd: number | undefined;
  /** The legs' pending fees, for accrual math that survives a harvest. Absent on older rows. */
  tokens?: NavHistoryTokenRow[];
  /** The vault's performance-fee cut in bps. Absent on older rows. */
  performanceFeeBps?: number;
}

/** One point of a vault's real NAV series. */
export interface NavHistoryPoint {
  t: number;
  ts: string;
  navUsd: number;
}

const num = (x: unknown): number | undefined => {
  const n = typeof x === 'string' && x.trim() !== '' ? Number(x) : x;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};

const str = (x: unknown): string | undefined => {
  if (typeof x === 'string' && x.trim() !== '') return x;
  if (typeof x === 'number' && Number.isFinite(x)) return String(x);
  return undefined;
};

/** The legs' pending fees, when the row carries them (rows written before this field → undefined). */
function toTokenRows(x: unknown): NavHistoryTokenRow[] | undefined {
  if (!Array.isArray(x)) return undefined;
  const out: NavHistoryTokenRow[] = [];
  for (const raw of x) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    const address = str(o.address);
    const decimals = num(o.decimals);
    const priceUsd = num(o.priceUsd);
    const feeRaw = str(o.feeRaw);
    if (address === undefined || decimals === undefined || priceUsd === undefined || feeRaw === undefined) continue;
    const feeUsd = num(o.feeUsd);
    out.push({ address, symbol: str(o.symbol), decimals, priceUsd, feeRaw, ...(feeUsd === undefined ? {} : { feeUsd }) });
  }
  return out.length > 0 ? out : undefined;
}

/** One parsed line → a row, or undefined when it is not a usable snapshot. */
function toRow(o: unknown): NavHistoryRow | undefined {
  if (!o || typeof o !== 'object') return undefined;
  const r = o as Record<string, unknown>;
  const chainId = num(r.chainId);
  if (typeof r.ts !== 'string' || typeof r.vaultKey !== 'string' || chainId === undefined) return undefined;
  const t = Date.parse(r.ts);
  if (!Number.isFinite(t)) return undefined;
  const tokens = toTokenRows(r.tokens);
  const bps = num(r.performanceFeeBps);
  return {
    t,
    ts: r.ts,
    chainId,
    vaultKey: r.vaultKey,
    navUsd: num(r.navUsd),
    tvlUsd: num(r.tvlUsd),
    feesUsd: num(r.feesUsd),
    ...(tokens === undefined ? {} : { tokens }),
    ...(bps === undefined ? {} : { performanceFeeBps: bps }),
  };
}

/**
 * Parse the JSONL body line by line. Empty lines, a trailing partial line (the file is being appended
 * to) and any line that is not a snapshot are skipped — one bad line never loses the rest.
 */
export function parseNavHistoryJsonl(text: string): NavHistoryRow[] {
  const rows: NavHistoryRow[] = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let o: unknown;
    try {
      o = JSON.parse(s);
    } catch {
      continue;
    }
    const row = toRow(o);
    if (row) rows.push(row);
  }
  return rows;
}

/**
 * One vault's priced snapshots, oldest first (registry key on its chain: `main` / `pons` / `tri` on
 * 4663, `demo` / `pons` / `tri` on the demo chain 46630). Sorted defensively; rows with no NAV are
 * dropped. Pure filter: callers only ask for vaults the build offers (chains.ts `DEPLOYMENTS`), so a
 * production build never asks for a 46630 series even if the collector file carries one.
 */
export function navHistoryFor(rows: readonly NavHistoryRow[], chainId: number, vaultKey: string): NavHistoryPoint[] {
  return rows
    .filter((r) => r.chainId === chainId && r.vaultKey === vaultKey && r.navUsd !== undefined && r.navUsd > 0)
    .map((r) => ({ t: r.t, ts: r.ts, navUsd: r.navUsd as number }))
    .sort((a, b) => a.t - b.t);
}
