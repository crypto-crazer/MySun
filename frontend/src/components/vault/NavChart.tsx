import { useId, useMemo, useState } from 'react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from 'recharts';
import type { Vault } from '@/lib/types';
import { navSeries } from '@/demo/series';
import { Segmented } from '@/components/ui/Tabs';
import { cx, fmtPctSigned } from '@/lib/format';
import { usePalette } from '@/lib/theme';

type Window = '30D' | '7D';

/** Vault token price over the period: one line, no panel around it. */
export function NavChart({ vault: v, className }: { vault: Vault; className?: string }) {
  const pal = usePalette();
  const fill = useId();
  const [win, setWin] = useState<Window>('30D');
  const all = useMemo(() => navSeries(v.id, v.pricePerShare, v.benchmarkLead), [v]);
  const data = win === '30D' ? all : all.slice(-7);
  const first = data[0];
  const last = data[data.length - 1];
  const tdlpRet = last.tdlp / first.tdlp - 1;
  const yMin = Math.min(...data.map((d) => d.tdlp));
  const yMax = Math.max(...data.map((d) => d.tdlp));
  const pad = (yMax - yMin) * 0.25 || 0.005;

  return (
    <section className={className}>
      <header className="mb-3.5 flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="title text-2xl leading-tight">Vault token price</h2>
        <div className="flex flex-wrap items-center gap-3.5 text-xs">
          <span className="inline-flex items-center gap-2 text-weak num">
            <span className="h-[1.5px] w-3.5 bg-strong" /> {v.receiptSymbol} <span className={tdlpRet >= 0 ? 'text-success' : 'text-error'}>{fmtPctSigned(tdlpRet, 2)}</span>
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
              tick={{ fill: pal.weaker, fontSize: 10.5 }}
              tickLine={false}
              axisLine={{ stroke: pal.strokeStrong }}
              tickFormatter={(d: string) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(d))}
              minTickGap={36}
            />
            <YAxis
              domain={[yMin - pad, yMax + pad]}
              tick={{ fill: pal.weaker, fontSize: 10.5 }}
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
                  <div className={cx('rounded-sm bg-fill-inverse px-2 py-[5px] text-xs font-medium text-inverse-strong num')}>
                    {label} · ${p.tdlp.toFixed(4)}
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
