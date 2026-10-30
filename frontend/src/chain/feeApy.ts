/**
 * The fee APR (the design's "Your APR: from trading fees, annualised"), from the NAV-history collector's
 * rows (./navHistory.ts). Pure: no React, no network.
 *
 * The collector snapshots each adapter's `fees()` — the PENDING (unharvested) fees. That is a level, not
 * a running total: when the keeper harvests, the pending amount drops back toward zero and the value it
 * carried disappears from the series. Reading the window as "last − first" therefore loses every harvest
 * inside the window (measured on the live series: 37–59% of a multi-day figure on the three mainnet
 * vaults). So the accrual is integrated instead: per token, only the UPWARD steps of the pending series
 * count. A harvest is a downward step and contributes nothing, while the accrual around it still does.
 * That reproduces the honest identity  claimed in the window + ending pending − starting pending  without
 * needing the harvest transactions. Its one blind spot: a harvest larger than the accrual inside a
 * single hourly interval hides that interval's accrual (≤ one hour of fees, and only when a sweep
 * lands mid-interval).
 *
 * The result is NET of the vault's performance fee (10% today; read from the row's `performanceFeeBps`,
 * with `DEFAULT_PERFORMANCE_FEE_BPS` covering rows written before that field existed) — the share LPs
 * keep. Fees are the yield; never the NAV slope, which goes negative whenever a basket token's price
 * drop. The window is the last 24 hours (`FEE_APR_WINDOW_DAYS`), or all the history there is when the
 * vault is younger — from `MIN_FEE_APR_DAYS` (a day of rows, less an hour of slack for the cron's
 * drifting second) up, so a fresh vault shows a figure after a day.
 * Shorter than that → undefined (rendered "—"; never a fabricated figure).
 *
 * Imports are relative (not `@/`), like navHistory.ts: plain module, runnable under tsx.
 */
import type { NavHistoryRow } from './navHistory';

const DAY_MS = 86_400_000;

/** The window the frontend shows: the last 24 hours, annualised. */
export const FEE_APR_WINDOW_DAYS = 1;

/**
 * The shortest history that may produce a figure: 1 − 1/12 day = 22 h. A full day of hourly rows
 * spans a few seconds UNDER 24 h (rows land at the cron's own second: 09:00:33, 10:00:30 …), and one
 * missed row leaves about 23 h; both must still show, so the floor sits a whole sampling interval
 * below the day. From here up the figure is annualised over the history there is, and showing nothing
 * for a week would hide every fresh vault.
 */
export const MIN_FEE_APR_DAYS = 1 - 1 / 12;

/** Every deployed vault charges 10% of harvested fees; rows carry the real value in `performanceFeeBps`. */
export const DEFAULT_PERFORMANCE_FEE_BPS = 1000;

/** One snapshot of a vault's fee series. */
export interface FeePoint {
  t: number;
  feesUsd: number;
  tvlUsd: number;
}

/** One token's pending fee amount at a snapshot. */
interface LegFees {
  raw: bigint;
  decimals: number;
  priceUsd: number;
}

/** A snapshot with its legs' pending fees, for the accrual integration. */
interface FeeSnapshot {
  t: number;
  tvlUsd: number;
  /** Pending fees in USD as the collector summed them — the fallback when a row carries no legs. */
  feesUsd: number | undefined;
  legs: Map<string, LegFees>;
}

/**
 * One vault's snapshots that carry both fees and TVL, oldest first (any input order).
 * `chainId` narrows the cut: a vault key (`pons`, `tri`) repeats across chains in the cross-chain file.
 */
export function feeSeriesFor(rows: readonly NavHistoryRow[], vaultKey: string, chainId?: number): FeePoint[] {
  return rows
    .filter((r) => r.vaultKey === vaultKey && (chainId === undefined || r.chainId === chainId) && r.feesUsd !== undefined && r.tvlUsd !== undefined)
    .map((r) => ({ t: r.t, feesUsd: r.feesUsd as number, tvlUsd: r.tvlUsd as number }))
    .sort((a, b) => a.t - b.t);
}

/** The same cut with each snapshot's legs parsed, for the accrual math. */
function snapshotsFor(rows: readonly NavHistoryRow[], vaultKey: string, chainId?: number): FeeSnapshot[] {
  return rows
    .filter((r) => r.vaultKey === vaultKey && (chainId === undefined || r.chainId === chainId) && r.tvlUsd !== undefined)
    .map((r) => {
      const legs = new Map<string, LegFees>();
      for (const leg of r.tokens ?? []) {
        let raw: bigint;
        try {
          raw = BigInt(leg.feeRaw);
        } catch {
          continue;
        }
        legs.set(leg.address.toLowerCase(), { raw, decimals: leg.decimals, priceUsd: leg.priceUsd });
      }
      return { t: r.t, tvlUsd: r.tvlUsd as number, feesUsd: r.feesUsd, legs };
    })
    .sort((a, b) => a.t - b.t);
}

/**
 * Gross fees accrued across `slice`: for each leg, the sum of the upward steps in its pending series,
 * priced at the step's own snapshot. A harvest (a downward step) is skipped, never netted — that is what
 * keeps a claimed fee counted. A leg missing from the previous snapshot (a basket change) is skipped
 * too: its baseline is unknown. Rows carrying no legs fall back to the USD series, clamped at ≥ 0.
 */
function accruedUsd(slice: readonly FeeSnapshot[]): number {
  let usd = 0;
  for (let i = 1; i < slice.length; i++) {
    const prev = slice[i - 1] as FeeSnapshot;
    const cur = slice[i] as FeeSnapshot;
    if (cur.legs.size === 0) {
      const d = (cur.feesUsd ?? 0) - (prev.feesUsd ?? 0);
      if (d > 0) usd += d;
      continue;
    }
    for (const [address, leg] of cur.legs) {
      const before = prev.legs.get(address);
      if (!before) continue;
      const d = leg.raw - before.raw;
      if (d > 0n) usd += (Number(d) / 10 ** leg.decimals) * leg.priceUsd;
    }
  }
  return usd;
}

/**
 * The slice to annualise over, and how many days it really covers: the last `windowDays`, or the whole
 * series when it is younger than that (from `MIN_FEE_APR_DAYS` up — a shorter series → undefined, never a
 * fabricated figure). The boundary is the last row at or before `lastTs − days`; when the series itself is
 * the window, the whole series is the slice.
 */
function windowFor(s: readonly FeeSnapshot[], windowDays: number): { slice: readonly FeeSnapshot[]; days: number } | undefined {
  const first = s[0];
  const last = s[s.length - 1];
  if (!first || !last || !(windowDays > 0)) return undefined;
  const covered = (last.t - first.t) / DAY_MS;
  if (!(covered >= MIN_FEE_APR_DAYS)) return undefined;
  if (covered <= windowDays) return { slice: s, days: covered };
  const cutoff = last.t - windowDays * DAY_MS;
  for (let i = s.length - 1; i >= 0; i--) {
    const p = s[i] as FeeSnapshot;
    if (p.t <= cutoff) return { slice: s.slice(i), days: windowDays };
  }
  return undefined;
}

/** Mean TVL across a slice (the APR's denominator), or undefined when it is not positive. */
function meanTvl(slice: readonly FeeSnapshot[]): number | undefined {
  if (slice.length === 0) return undefined;
  const avg = slice.reduce((sum, p) => sum + p.tvlUsd, 0) / slice.length;
  return avg > 0 ? avg : undefined;
}

/** The vault's performance-fee cut in bps, from its newest row that carries one. */
export function performanceFeeBpsOf(rows: readonly NavHistoryRow[], vaultKey: string, chainId?: number): number {
  let bps: number | undefined;
  let t = -Infinity;
  for (const r of rows) {
    if (r.vaultKey !== vaultKey) continue;
    if (chainId !== undefined && r.chainId !== chainId) continue;
    if (r.performanceFeeBps === undefined || r.t <= t) continue;
    bps = r.performanceFeeBps;
    t = r.t;
  }
  return bps ?? DEFAULT_PERFORMANCE_FEE_BPS;
}

/**
 * Gross trading fees accrued over the last `windowDays`, in USD: claimed fees plus the change in the
 * pending balance (see the module note). A younger series is measured over what it covers (see
 * windowFor); undefined only below `MIN_FEE_APR_DAYS`.
 */
export function grossFeesUsd(rows: readonly NavHistoryRow[], vaultKey: string, windowDays: number, chainId?: number): number | undefined {
  const w = windowFor(snapshotsFor(rows, vaultKey, chainId), windowDays);
  return w === undefined ? undefined : accruedUsd(w.slice);
}

/**
 * The days {@link feeApy} actually annualises over for this vault right now: `windowDays`, capped by the
 * history the series covers, or undefined when it covers less than `MIN_FEE_APR_DAYS`.
 */
export function feeAprWindowDays(rows: readonly NavHistoryRow[], vaultKey: string, windowDays: number, chainId?: number): number | undefined {
  return windowFor(snapshotsFor(rows, vaultKey, chainId), windowDays)?.days;
}

/**
 * Gross trading fees earned since collection began — the opening pending balance plus every accrual,
 * in USD. That is what "Fees earned" means on the vault page. undefined without a series.
 */
export function feesEarnedUsd(rows: readonly NavHistoryRow[], vaultKey: string, chainId?: number): number | undefined {
  const s = snapshotsFor(rows, vaultKey, chainId);
  const first = s[0];
  if (!first) return undefined;
  return (first.feesUsd ?? 0) + accruedUsd(s);
}

/**
 * Annualised NET fee yield over the last `windowDays` of the series, as a fraction (0.05 = 5%):
 * gross accrual × (1 − performanceFeeBps/10000) ÷ the mean TVL of the window's snapshots,
 * × 365 ÷ the days actually covered. Simple annualisation, no compounding — the figure is an
 * extrapolation either way (a day of fees × 365), so a young vault's number is shown as soon as
 * `MIN_FEE_APR_DAYS` exist and only sharpens as the window fills toward `windowDays`.
 * undefined below that floor or when the mean TVL is not positive.
 */
export function feeApy(rows: readonly NavHistoryRow[], vaultKey: string, windowDays: number, chainId?: number): number | undefined {
  const w = windowFor(snapshotsFor(rows, vaultKey, chainId), windowDays);
  if (w === undefined) return undefined;
  const avgTvl = meanTvl(w.slice);
  if (avgTvl === undefined) return undefined;
  const net = accruedUsd(w.slice) * (1 - performanceFeeBpsOf(rows, vaultKey, chainId) / 10_000);
  return ((net / avgTvl) * 365) / w.days;
}

/** {@link feeApy} as a percent rounded to 2 decimals (5.123% → 5.12), or undefined. */
export function feeApyPct(rows: readonly NavHistoryRow[], vaultKey: string, windowDays: number, chainId?: number): number | undefined {
  const apy = feeApy(rows, vaultKey, windowDays, chainId);
  return apy === undefined ? undefined : Math.round(apy * 100 * 100) / 100;
}

/** A percent from {@link feeApyPct} for display: "0.00%", or "—" when undefined. */
export function fmtFeeApr(pct: number | undefined): string {
  return pct === undefined ? '—' : `${pct.toFixed(2)}%`;
}

/**
 * The one APR hint, shared by every surface that shows the figure — the designer's rule (PR #9: "One
 * APR hint, shared by the header tooltip and the row's title"): the vault list's column header, the
 * row's `title`, and the vault page's "Your APR". Short and plain, in the house style of the design
 * system's own tips ("The 7-day average, annualised."): what the number is over, and what the "—"
 * means. The precise definition lives in docs/LIVE-DATA.md, for integrators.
 */
export const FEE_APR_HINT = 'Trading fees over the last 24 hours, annualised. Shows — until a vault has 24 hours of history.';

/**
 * The vault page's "average over …" line under the APR, for the window {@link feeAprWindowDays} reports:
 * the full window once covered, else the history there is — in hours below two days, so a day-old vault
 * does not claim a "1-day average" it cannot back. undefined while there is no figure at all.
 */
export function fmtFeeAprWindow(days: number | undefined, windowDays: number = FEE_APR_WINDOW_DAYS): string | undefined {
  if (days === undefined) return undefined;
  const label = (d: number) => (d === 1 ? '24h' : `${d}-day`);
  if (days >= windowDays) return `${label(windowDays)} average, annualised`;
  return days < 2 ? `${Math.round(days * 24)}h average, annualised` : `${Math.floor(days)}-day average, annualised`;
}
