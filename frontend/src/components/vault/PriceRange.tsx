import { useId, useState } from 'react';
import type { Vault } from '@/lib/types';
import * as m from '@/demo/math';
import type { MarketStatus } from '@/lib/market';
import { fmtQuote, fmtRelativeDays } from '@/lib/format';
import { useElementWidth } from '@/lib/useElementWidth';
import { Button } from '@/components/ui/Button';

interface Props {
  vault: Vault;
  market: MarketStatus;
  className?: string;
}

const HEIGHT = 330; // drawing height
const HORIZON = 262; // y of the ground line
const STONE_W = 20;
const STONE_H = 172;
const SUN_R = 30;

/** Round scale marks covering [min, max], about `count` of them. */
function niceTicks(min: number, max: number, count: number): number[] {
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-12; v += step) out.push(v);
  return out;
}

/**
 * Price range as the instrument itself: a sky, two stones standing on the bounds, the sun at the
 * current price, and a graduated horizon as the price axis. The stones' inner faces sit exactly
 * on Lower and Upper, so the gap between them is the range.
 * The price reads either way round: token1 per token0 as the pool quotes it, or flipped.
 */
export function PriceRange({ vault: v, market, className }: Props) {
  const id = useId();
  const [host, width] = useElementWidth<HTMLDivElement>();
  const W = Math.max(320, width);
  const [flipped, setFlipped] = useState(false);
  const g = m.rangeGeometry(v, market);
  const inRange = v.currentPrice >= g.lower && v.currentPrice <= g.upper;
  // Flipped, every price is its reciprocal, so the two bounds change places
  const price = flipped ? 1 / v.currentPrice : v.currentPrice;
  const lower = flipped ? 1 / g.upper : g.lower;
  const upper = flipped ? 1 / g.lower : g.upper;
  const [base, quote] = flipped ? [v.token1, v.token0] : [v.token0, v.token1];

  // price → x: the scale runs 24% of the range width past each bound
  const span = upper - lower, pad = 20;
  const d0 = lower - span * 0.24, d1 = upper + span * 0.24;
  const X = (p: number) => pad + ((p - d0) / (d1 - d0)) * (W - pad * 2);
  // a price beyond the scale stops at its end, so the sun never leaves the frame
  const sunX = Math.min(W - pad - SUN_R, Math.max(pad + SUN_R, X(price)));

  const ticks = niceTicks(d0, d1, Math.max(4, Math.floor(W / 110)));
  const step = ticks.length > 1 ? ticks[1] - ticks[0] : span;
  // scale figures carry just enough decimals for the step between them
  const tickDigits = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  const minor: Array<{ x: number; major: boolean }> = [];
  for (let t = ticks[0] - step; t <= d1; t += step / 5) {
    if (t < d0) continue;
    minor.push({ x: X(t), major: Math.abs(t / step - Math.round(t / step)) < 1e-6 });
  }
  // Two ridges of dunes: a paler one far off, a darker one nearer. The sun sets behind both.
  const ridge = (base: number, a1: number, f1: number, a2: number, f2: number, phase: number) => {
    let d = `M0 ${HORIZON}`;
    for (let x = 0; x <= W; x += 12) d += ` L${x} ${(HORIZON - base - a1 * Math.sin(x * f1 + phase) - a2 * Math.sin(x * f2 + phase * 2.1)).toFixed(1)}`;
    return `${d} L${W} ${HORIZON} Z`;
  };
  const farDunes = ridge(11, 5, 0.0085, 2.5, 0.021, 0.6);
  const nearDunes = ridge(5, 3.5, 0.013, 2, 0.031, 1.2);

  const stones = [
    { x: X(lower) - STONE_W, bound: X(lower), name: 'LOWER', value: lower },
    { x: X(upper), bound: X(upper), name: 'UPPER', value: upper },
  ].map((st) => {
    const centre = st.x + STONE_W / 2;
    // the face turned to the sun is lit; the shadow falls away from it across the ground
    const litLeft = sunX < centre;
    const lean = (centre - sunX) * 0.42;
    return { ...st, centre, litLeft, shadow: `M${st.x} ${HORIZON} H${st.x + STONE_W} L${st.x + STONE_W + lean * 1.12} ${HEIGHT} H${st.x + lean} Z` };
  });
  const top = HORIZON - STONE_H;

  // The price figure sits above the sun in the darker sky, joined to it by a hairline.
  // Near a stone it steps aside so it never lies across the stone.
  const priceText = fmtQuote(price);
  const half = (priceText.length * 13.5) / 2 + 8; // about half the figure's width at 24px, plus air
  let priceX = Math.min(W - half, Math.max(half, sunX));
  let priceAnchor: 'start' | 'middle' | 'end' = 'middle';
  let aside = false;
  for (const st of stones) {
    if (sunX > st.x - half && sunX < st.x + STONE_W + half) {
      aside = true;
      if (sunX >= st.centre) { priceX = st.x + STONE_W + 12; priceAnchor = 'start'; } else { priceX = st.x - 12; priceAnchor = 'end'; }
    }
  }

  const sky = `${id}-sky`, glow = `${id}-glow`, bloom = `${id}-bloom`, sun = `${id}-sun`;
  const face = `${id}-face`, side = `${id}-side`, warmL = `${id}-warm-l`, warmR = `${id}-warm-r`, foot = `${id}-foot`, grain = `${id}-grain`, plate = `${id}-plate`;
  const ground = `${id}-ground`, cast = `${id}-cast`, lane = `${id}-lane`, above = `${id}-above`;
  const label = { fontSize: 10, letterSpacing: '0.14em' } as const;

  return (
    <section className={className} aria-label="Price range">
      <div className="overflow-hidden rounded-lg border border-stroke-strong bg-fill-recessed">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-stroke-weak px-4 py-[11px] text-xs text-weaker">
          <h3 className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
            <b className="text-sm font-medium text-strong">Price range</b>
            <Button
              type="button"
              variant="secondary"
              size="xs"
              onClick={() => setFlipped(!flipped)}
              aria-label={`Priced in ${quote} per ${base}. Switch to ${base} per ${quote}`}
            >
              <span className="inline-flex items-center gap-1.5">
                {quote} per {base}
                <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" aria-hidden>
                  <path d="M3 5.5h10m0 0L10.5 3M13 5.5 10.5 8M13 10.5H3m0 0L5.5 8M3 10.5 5.5 13" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
            </Button>
          </h3>
          <span className="num">
            {g.defensive && <span className="text-warning">Widened while the US market is closed · </span>}
            {!g.defensive && !inRange && <span className="text-error">Out of range · </span>}
            Last rebalance {fmtRelativeDays(v.lastRebalanceDaysAgo)}
          </span>
        </header>
        <div ref={host}>
          <svg
            viewBox={`0 0 ${W} ${HEIGHT}`}
            className="block h-auto w-full"
            role="img"
            aria-label={`Price ${fmtQuote(price)} ${quote} per ${base}, ${inRange ? 'between' : 'outside'} the lower bound ${fmtQuote(lower)} and the upper bound ${fmtQuote(upper)}`}
          >
            <defs>
              <linearGradient id={sky} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#120a0e" />
                <stop offset=".34" stopColor="#22141b" />
                <stop offset=".62" stopColor="#47282f" />
                <stop offset=".86" stopColor="#84504a" />
                <stop offset="1" stopColor="#b26a4e" />
              </linearGradient>
              {/* a wide, slow falloff: no edge to the light */}
              <radialGradient id={glow} cx={sunX} cy={HORIZON} r={Math.max(280, W * 0.5)} gradientUnits="userSpaceOnUse">
                <stop offset="0" stopColor="#ff9d5c" stopOpacity=".46" />
                <stop offset=".18" stopColor="#ff9d5c" stopOpacity=".3" />
                <stop offset=".42" stopColor="#ff9d5c" stopOpacity=".13" />
                <stop offset=".7" stopColor="#ff9d5c" stopOpacity=".04" />
                <stop offset="1" stopColor="#ff9d5c" stopOpacity="0" />
              </radialGradient>
              <radialGradient id={bloom} cx={sunX} cy={HORIZON - 6} r={SUN_R * 3.2} gradientUnits="userSpaceOnUse">
                <stop offset="0" stopColor="#ffd9a0" stopOpacity=".55" />
                <stop offset=".35" stopColor="#ffb877" stopOpacity=".22" />
                <stop offset="1" stopColor="#ffb877" stopOpacity="0" />
              </radialGradient>
              <radialGradient id={sun}>
                <stop offset="0" stopColor="#fff6e0" />
                <stop offset=".5" stopColor="#ffd592" />
                <stop offset="1" stopColor="#ff9a4a" />
              </radialGradient>
              {/* the stone's face is in shade: the sun is behind it */}
              <linearGradient id={face} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#dcc3b1" />
                <stop offset=".5" stopColor="#b99889" />
                <stop offset="1" stopColor="#845f58" />
              </linearGradient>
              <linearGradient id={side} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#f7dcb8" />
                <stop offset=".6" stopColor="#f0bc8a" />
                <stop offset="1" stopColor="#e2955e" />
              </linearGradient>
              {/* sunlight creeping round the lit edge onto the face, from the left or from the right */}
              <linearGradient id={warmL} x1="0" y1="0" x2="1" y2="0">
                <stop offset="0" stopColor="#ffb877" stopOpacity=".34" />
                <stop offset=".7" stopColor="#ffb877" stopOpacity="0" />
              </linearGradient>
              <linearGradient id={warmR} x1="1" y1="0" x2="0" y2="0">
                <stop offset="0" stopColor="#ffb877" stopOpacity=".34" />
                <stop offset=".7" stopColor="#ffb877" stopOpacity="0" />
              </linearGradient>
              <linearGradient id={foot} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#2a161a" stopOpacity="0" />
                <stop offset="1" stopColor="#2a161a" stopOpacity=".38" />
              </linearGradient>
              {/* cut limestone: a fine grain, faint bedding courses lying across the block, and a few pits */}
              <filter id={grain} x="0" y="0" width="1" height="1" colorInterpolationFilters="sRGB">
                <feTurbulence type="fractalNoise" baseFrequency="1.15" numOctaves="2" seed="4" result="fineNoise" />
                <feColorMatrix in="fineNoise" type="matrix" values="1.3 0 0 0 -.15  1.3 0 0 0 -.15  1.3 0 0 0 -.15  0 0 0 0 1" result="fine" />
                <feTurbulence type="fractalNoise" baseFrequency="0.018 0.19" numOctaves="3" seed="9" result="bedNoise" />
                <feColorMatrix in="bedNoise" type="matrix" values=".5 0 0 0 .25  .5 0 0 0 .25  .5 0 0 0 .25  0 0 0 0 1" result="bed" />
                <feTurbulence type="fractalNoise" baseFrequency="0.42 0.3" numOctaves="2" seed="21" result="pitNoise" />
                <feColorMatrix in="pitNoise" type="matrix" values="0 0 0 0 .2  0 0 0 0 .12  0 0 0 0 .12  0 4.05 0 0 -2.97" result="pits" />
                <feBlend in="bed" in2="SourceGraphic" mode="soft-light" result="bedded" />
                <feBlend in="fine" in2="bedded" mode="soft-light" result="grained" />
                <feComposite in="pits" in2="grained" operator="over" result="pitted" />
                <feComposite in="pitted" in2="SourceGraphic" operator="in" />
              </filter>
              <filter id={plate} x="0" y="0" width="1" height="1" colorInterpolationFilters="sRGB">
                <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="2" />
                <feColorMatrix type="matrix" values="1.4 0 0 0 -.2  1.4 0 0 0 -.2  1.4 0 0 0 -.2  0 0 0 0 1" />
              </filter>
              <linearGradient id={ground} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#2a181c" />
                <stop offset="1" stopColor="#150d10" />
              </linearGradient>
              <linearGradient id={cast} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#0b0608" stopOpacity=".42" />
                <stop offset="1" stopColor="#0b0608" stopOpacity="0" />
              </linearGradient>
              <linearGradient id={lane} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#ffae3d" stopOpacity={inRange ? 0.24 : 0.08} />
                <stop offset="1" stopColor="#ffae3d" stopOpacity="0" />
              </linearGradient>
              <clipPath id={above}><rect x="0" y="0" width={W} height={HORIZON} /></clipPath>
            </defs>

            {/* sky */}
            <rect x="0" y="0" width={W} height={HORIZON} fill={`url(#${sky})`} />
            <rect x="0" y="0" width={W} height={HORIZON} fill={`url(#${glow})`} />
            <g clipPath={`url(#${above})`}>
              <circle cx={sunX} cy={HORIZON - 6} r={SUN_R * 3.2} fill={`url(#${bloom})`} />
              {/* the price: the sun, setting behind the dunes */}
              <circle cx={sunX} cy={HORIZON - 6} r={SUN_R} fill={`url(#${sun})`} />
            </g>
            <path d={farDunes} fill="#7a4a47" opacity=".7" />
            <path d={nearDunes} fill="#4f2e33" />

            {/* ground: the lit lane between the stones is where the position earns */}
            <rect x="0" y={HORIZON} width={W} height={HEIGHT - HORIZON} fill={`url(#${ground})`} />
            <rect x={X(lower)} y={HORIZON} width={X(upper) - X(lower)} height="34" fill={`url(#${lane})`} />
            {stones.map((st) => <path key={st.name} d={st.shadow} fill={`url(#${cast})`} />)}
            <rect x="0" y={HORIZON} width={W} height="1" className="fill-stroke-strong" />
            <rect x={X(lower)} y={HORIZON - 1} width={X(upper) - X(lower)} height="2" className="fill-accent" opacity={inRange ? 0.75 : 0.25} />

            {/* a faint grain over the whole plate, under the stones and the figures, so they stay crisp */}
            <rect x="0" y="0" width={W} height={HEIGHT} filter={`url(#${plate})`} opacity=".16" className="mix-blend-soft-light" />

            {/* the bounds: inner faces sit exactly on Lower and Upper */}
            {stones.map((st) => (
              <g key={st.name}>
                <g filter={`url(#${grain})`}>
                  <rect x={st.x} y={top} width={STONE_W} height={STONE_H} fill={`url(#${face})`} />
                  <rect x={st.x} y={top} width={STONE_W} height={STONE_H} fill={`url(#${st.litLeft ? warmL : warmR})`} />
                  <rect x={st.litLeft ? st.x : st.x + STONE_W - 4} y={top} width="4" height={STONE_H} fill={`url(#${side})`} />
                  <rect x={st.x} y={HORIZON - 26} width={STONE_W} height="26" fill={`url(#${foot})`} />
                </g>
                <rect x={st.x} y={top} width={STONE_W} height="1" fill="#fff3e0" opacity=".3" />
                <text x={st.centre} y={top - 32} textAnchor="middle" className="fill-weaker" {...label}>{st.name}</text>
                <text x={st.centre} y={top - 11} textAnchor="middle" fontSize="16" className="fill-strong num">{fmtQuote(st.value)}</text>
              </g>
            ))}

            {/* the price reading */}
            {!aside && <rect x={sunX} y={HORIZON - 96} width="1" height={96 - SUN_R - 14} className="fill-accent-bright" opacity=".55" />}
            <text x={priceX} y={HORIZON - 132} textAnchor={priceAnchor} className="fill-weak" {...label}>PRICE</text>
            <text x={priceX} y={HORIZON - 106} textAnchor={priceAnchor} fontSize="24" className="fill-accent-bright num">{priceText}</text>

            {/* the graduated horizon: the price axis */}
            {minor.map((t, i) => <rect key={i} x={t.x} y={HORIZON + 1} width="1" height={t.major ? 10 : 5} className="fill-weaker" opacity={t.major ? 0.9 : 0.45} />)}
            {ticks.map((t) => <text key={t} x={X(t)} y={HORIZON + 30} textAnchor="middle" fontSize="11" className="fill-weaker num">{t.toFixed(tickDigits)}</text>)}
          </svg>
        </div>
      </div>
    </section>
  );
}
