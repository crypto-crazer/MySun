/**
 * The vault chart's illustrative fallback line (`illustrativeNavSeries`): a seeded, smooth path,
 * deterministic per seed so it looks identical on every load.
 */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Smooth random walk from `start` to exactly `end` over `n` points.
 * `vol` is per-step noise (as a fraction), smoothed with an EMA so there are
 * no saw-tooth jumps.
 */
export function smoothPath(seed: number, n: number, start: number, end: number, vol: number): number[] {
  const rnd = mulberry32(seed);
  const noise: number[] = [];
  let ema = 0;
  for (let i = 0; i < n; i++) {
    const r = (rnd() - 0.5) * 2 * vol;
    ema = ema * 0.55 + r * 0.45;
    noise.push(ema);
  }
  // cumulative, then detrend so endpoints are exact
  const cum: number[] = [];
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += noise[i];
    cum.push(acc);
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const drift = start + (end - start) * t;
    const residual = cum[i] - cum[0] - (cum[n - 1] - cum[0]) * t; // zero at both ends
    out.push(drift * (1 + residual));
  }
  return out;
}

export interface NavPoint {
  day: number; // 0..n-1
  date: string; // ISO date
  tdlp: number;
  hodl: number;
}

/** 30-day NAV series: receipt-token price (pricePerShare) vs HODL 50/50 benchmark. */
export function navSeries(vaultId: string, ppsEnd: number, benchmarkLead: number, days = 30, now = new Date()): NavPoint[] {
  const s = hashSeed(vaultId);
  const tdlp = smoothPath(s, days, 1.0, ppsEnd, 0.0022);
  const hodl = smoothPath(s ^ 0x9e3779b9, days, 1.0, ppsEnd - benchmarkLead, 0.0062);
  const out: NavPoint[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - (days - 1 - i));
    out.push({ day: i, date: d.toISOString().slice(0, 10), tdlp: tdlp[i], hodl: hodl[i] });
  }
  return out;
}

/**
 * ILLUSTRATIVE receipt-token price path for a live vault page. The chain has no history to draw
 * (no indexer; RHC v3 TWAP observations are degenerate chain-wide), so the SHAPE is invented — but
 * its last point is pinned to the live spot NAV when one is known, so the chart never contradicts the
 * live readout beside it. Rendered under an Illustrative badge, always.
 */
export function illustrativeNavSeries(seed: string, liveNav: number | undefined, days = 30, now = new Date()): NavPoint[] {
  const raw = navSeries(seed, 1.006, 0, days, now);
  const k = liveNav === undefined ? 1 : liveNav / raw[raw.length - 1].tdlp;
  return raw.map((p) => ({ ...p, tdlp: p.tdlp * k, hodl: p.hodl * k }));
}
