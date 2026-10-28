import { useId, useMemo, useState } from 'react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from 'recharts';
import { illustrativeNavSeries } from '@/demo/series';
import { useNavHistory } from '@/chain/useNavHistory';
import { DemoBadge } from '@/components/ui/DataBadge';
import { Segmented } from '@/components/ui/Tabs';
import { cx, fmtPctSigned, fmtPrice } from '@/lib/format';
import { usePalette } from '@/lib/theme';
import { fontPx } from '@/lib/tokens';

type Window = '30D' | '7D';

const DAY_MS = 86_400_000;
const fmtDay = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const fmtHour = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' });
const fmtStamp = (d: Date) => `${fmtDay.format(d)}, ${fmtHour.format(d)} UTC`;
/** Axis ticks at the `2xs` step; recharts takes a number, not a class. */
const TICK_PX = fontPx('2xs');

/**
 * Vault token price over the period: one line, no panel around it. The spot NAV readout under the
 * title is live. The line is REAL when the NAV-history collector (`VITE_NAV_HISTORY_URL`, src/chain/useNavHistory)
 * has ≥ 6 snapshots for this vault — drawn at the snapshots' own timestamps. Otherwise it is
 * ILLUSTRATIVE (src/demo/series.ts), ends on the live spot NAV and carries an Illustrative badge.
 * The readout is live either way and never badged.
 */
export function NavChart({
  seed,
  chainId,
  vaultKey,
  symbol,
  liveNav,
  historyUrl,
  className,
}: {
  seed: string;
  chainId: number;
  vaultKey: string;
  symbol: string;
  liveNav: number | undefined;
  /** Overrides the build-time collector URL (tests). */
  historyUrl?: string;
  className?: string;
}) {
  const pal = usePalette();
  const fill = useId();
  const [win, setWin] = useState<Window>('30D');
  const history = useNavHistory(chainId, vaultKey, historyUrl);
  const real = history.isReal;
  const all = useMemo(
    () => (real ? history.points.map((p) => ({ date: p.ts, tdlp: p.navUsd })) : illustrativeNavSeries(seed, liveNav)),
    [real, history.points, seed, liveNav],
  );
  const data = useMemo(() => {
    if (!real) return win === '30D' ? all : all.slice(-7);
    const from = Date.parse(all[all.length - 1].date) - (win === '30D' ? 30 : 7) * DAY_MS;
    const cut = all.filter((d) => Date.parse(d.date) >= from);
    return cut.length >= 2 ? cut : all.slice(-2);
  }, [real, all, win]);
  const first = data[0];
  const last = data[data.length - 1];
  const tdlpRet = last.tdlp / first.tdlp - 1;
  const yMin = Math.min(...data.map((d) => d.tdlp));
  const yMax = Math.max(...data.map((d) => d.tdlp));
  const pad = (yMax - yMin) * 0.25 || 0.005;
  // Hourly snapshots spanning under ~2 days read better by the hour than as a row of identical dates.
  const byHour = real && Date.parse(last.date) - Date.parse(first.date) < 2 * DAY_MS;

  return (
    <section className={className}>
      <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="grid gap-2">
          <h2 className="title text-2xl leading-tight">Vault token price</h2>
          <span className="inline-flex items-center gap-2 text-xs text-weak num" data-testid="nav-live">
            Price now <span className="text-strong">{liveNav === undefined ? '—' : fmtPrice(liveNav)}</span>
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-4 text-xs">
          <span className="inline-flex items-center gap-2 text-weak num">
            <span className="h-[1.5px] w-4 bg-strong" /> {symbol} <span className={tdlpRet >= 0 ? 'text-success' : 'text-error'}>{fmtPctSigned(tdlpRet, 2)}</span>
            {real ? (
              <span className="text-weaker" data-testid="nav-history-until">
                snapshots until {fmtStamp(new Date(last.date))}
              </span>
            ) : (
              <DemoBadge label="Illustrative" />
            )}
          </span>
          <Segmented<Window> size="sm" value={win} onChange={setWin} options={[{ value: '30D', label: '30D' }, { value: '7D', label: '7D' }]} />
        </div>
      </header>
      <div className="h-56">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id={fill} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor={pal.strong} stopOpacity={0.12} />
                <stop offset="1" stopColor={pal.strong} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke={pal.strokeWeak} vertical={false} />
            <XAxis
              dataKey="date"
              tick={{ fill: pal.weaker, fontSize: TICK_PX }}
              tickLine={false}
              axisLine={{ stroke: pal.strokeStrong }}
              tickFormatter={(d: string) => (byHour ? fmtHour : fmtDay).format(new Date(d))}
              minTickGap={36}
            />
            <YAxis
              domain={[yMin - pad, yMax + pad]}
              tick={{ fill: pal.weaker, fontSize: TICK_PX }}
              tickLine={false}
              axisLine={false}
              width={52}
              tickFormatter={(n: number) => n.toFixed(4)}
            />
            <RTooltip
              cursor={{ stroke: pal.strokeStrong }}
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                const p = payload[0].payload as { tdlp: number };
                return (
                  <div className={cx('rounded-sm bg-fill-inverse px-2 py-1 text-xs font-medium text-inverse-strong num')}>
                    {real ? fmtStamp(new Date(String(label))) : label} · ${p.tdlp.toFixed(4)}
                  </div>
                );
              }}
            />
            {/* a price point is the one round mark on the chart */}
            <Area type="monotone" dataKey="tdlp" stroke={pal.strong} strokeWidth={1.6} fill={`url(#${fill})`} dot={false} activeDot={{ r: 3.5, fill: pal.strong, stroke: 'none' }} isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}
