import type { BasketLeg } from '@/chain/spot';
import { TOKEN_COLORS } from '@/demo/data/vaults';
import { cx, fmtPct, fmtUsd } from '@/lib/format';
import { Tooltip } from '@/components/ui/Tooltip';

/** For a token with no logo colour (the local mock stack): the chart inks, in turn. */
const BAR_FALLBACK = ['rgb(var(--color-strong))', 'rgb(var(--color-chart-secondary))', 'rgb(var(--color-weaker))'];

/**
 * Each token's share of the spot value, in the order given, drawn in its logo's colour: a bar with
 * the share and value on hover, and a legend under it naming every colour. `legs[i]` is `tokens[i]`'s.
 */
export function BasketBar({ tokens, legs, className }: { tokens: string[]; legs: (BasketLeg | undefined)[]; className?: string }) {
  const items = tokens.map((symbol, i) => ({ symbol, share: legs[i]?.share, usd: legs[i]?.usd, color: TOKEN_COLORS[symbol] ?? BAR_FALLBACK[i % BAR_FALLBACK.length] }));
  const pct = (share: number | undefined) => (share === undefined ? '—' : fmtPct(share));
  return (
    <div className={cx('grid gap-3', className)}>
      <div className="flex h-2 w-full gap-px rounded-full bg-fill-track">
        {items.map((t, i) => (
          <span key={t.symbol} className="flex" style={{ width: `${(t.share ?? 0) * 100}%` }}>
            <Tooltip content={`${t.symbol} · ${pct(t.share)} · ${t.usd === undefined ? '—' : fmtUsd(t.usd, { cents: true })}`} className="w-full">
              {/* the taller hit area makes the 8px bar easy to hover */}
              <span className="-my-2 flex w-full cursor-help py-2">
                {/* the ends are rounded on the coloured bar itself: clipping the track would cut the hit area */}
                <span className={cx('h-2 w-full', i === 0 && 'rounded-l-full', i === items.length - 1 && 'rounded-r-full')} style={{ background: t.color }} />
              </span>
            </Tooltip>
          </span>
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-weak num">
        {items.map((t) => (
          <li key={t.symbol} className="inline-flex items-center gap-2">
            <span className="h-2 w-2 rounded-sm" style={{ background: t.color }} aria-hidden />
            {t.symbol} <span className="text-strong">{pct(t.share)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
