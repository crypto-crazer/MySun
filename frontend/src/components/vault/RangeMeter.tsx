import { useId } from 'react';
import type { Vault } from '@/lib/types';
import type { MarketStatus } from '@/lib/market';
import * as m from '@/demo/math';
import { fmtQuote } from '@/lib/format';

const TICKS = Array.from({ length: 21 }, (_, i) => i);

/**
 * A vault's range at a glance: two stones on a scale mark the bounds, the sun marks the price.
 * The scale runs 30% of the range width past each bound, so a price just outside still shows.
 */
export function RangeMeter({ vault: v, market }: { vault: Vault; market: MarketStatus }) {
  const clip = useId();
  const g = m.rangeGeometry(v, market);
  const span = g.upper - g.lower;
  const d0 = g.lower - span * 0.3, d1 = g.upper + span * 0.3;
  const pct = (x: number) => `${(((x - d0) / (d1 - d0)) * 100).toFixed(2)}%`;
  const inRange = v.currentPrice >= g.lower && v.currentPrice <= g.upper;
  // A price far outside stops at the end of the scale, so the sun and its figure stay in view
  const at = Math.min(0.97, Math.max(0.03, (v.currentPrice - d0) / (d1 - d0)));
  const sunX = `${(at * 100).toFixed(2)}%`;
  const anchor = at < 0.08 ? 'start' : at > 0.92 ? 'end' : 'middle';
  return (
    <svg
      className="block h-[62px] w-full overflow-visible"
      role="img"
      aria-label={`Price ${fmtQuote(v.currentPrice)} ${inRange ? 'inside' : 'outside'} the range ${fmtQuote(g.lower)} to ${fmtQuote(g.upper)}`}
    >
      <clipPath id={clip}><rect x="0" y="0" width="100%" height="40" /></clipPath>
      <rect x="0" y="40" width="100%" height="1" className="fill-stroke-strong" />
      {TICKS.map((i) => <rect key={i} x={`${i * 5}%`} y="41" width="1" height={i % 5 ? 3 : 6} className="fill-stroke-strong" />)}
      {/* the range, lit on the scale */}
      <rect x={pct(g.lower)} y="37" width={`${((span / (d1 - d0)) * 100).toFixed(2)}%`} height="3" className="fill-accent" opacity={inRange ? 0.35 : 0.12} />
      {/* the price: the sun, half set behind the scale */}
      <g clipPath={`url(#${clip})`}><circle cx={sunX} cy="38" r="7.5" className="fill-accent" /></g>
      {/* the bounds: inner faces sit exactly on the prices */}
      <rect x={pct(g.lower)} y="12" width="5" height="28" transform="translate(-5 0)" className="fill-strong" />
      <rect x={pct(g.upper)} y="12" width="5" height="28" className="fill-strong" />
      <text x={pct(g.lower)} dx="-9" y="23" textAnchor="end" fontSize="10.5" className="fill-weaker">{fmtQuote(g.lower)}</text>
      <text x={pct(g.upper)} dx="9" y="23" fontSize="10.5" className="fill-weaker">{fmtQuote(g.upper)}</text>
      <text x={sunX} y="58" textAnchor={anchor} fontSize="10.5" fontWeight="500" className="fill-accent-bright">{fmtQuote(v.currentPrice)}</text>
    </svg>
  );
}
