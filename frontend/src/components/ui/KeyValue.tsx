import type { ReactNode } from 'react';
import { cx } from '@/lib/format';

export function KV({ rows, className }: { rows: Array<{ k: ReactNode; v: ReactNode; tone?: string; sub?: boolean }>; className?: string }) {
  return (
    <dl className={cx('divide-y divide-stroke-weak', className)}>
      {rows.map((r, i) => (
        <div key={i} className={cx('flex items-center justify-between gap-4 py-2 text-sm', r.sub && 'pl-4')}>
          <dt className={cx('text-weak', r.sub && 'text-weaker text-xs')}>{r.k}</dt>
          <dd className={cx('num font-medium text-right', r.tone ?? 'text-strong')}>{r.v}</dd>
        </div>
      ))}
    </dl>
  );
}
