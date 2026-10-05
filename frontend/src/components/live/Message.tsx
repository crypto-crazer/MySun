import type { ReactNode } from 'react';
import { cx } from '@/lib/format';

const tones = {
  ok: 'border-stroke-success/40 bg-fill-success/10 text-success',
  warn: 'border-stroke-warning/40 bg-fill-warning/10 text-warning',
  error: 'border-stroke-error/40 bg-fill-error/10 text-error',
  info: 'border-stroke-strong bg-fill-recessed text-weak',
} as const;

/** Inline transaction/preview feedback. Errors are decoded contract errors, never raw hex. */
export function Message({ tone, children }: { tone: keyof typeof tones; children: ReactNode }) {
  return <div className={cx('rounded-md border px-3 py-2 text-xs leading-snug break-words', tones[tone])}>{children}</div>;
}
