import { cx } from '@/lib/format';

/** APR that includes PMG rewards: the number, marked with a small spark in the reward colour. */
export function BoostedApr({ value, className }: { value: string; className?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-1.5', className)}>
      <svg viewBox="0 0 10 10" className="h-[0.5em] w-auto text-accent shrink-0" fill="currentColor" aria-hidden>
        <path d="M5 0 6.1 3.9 10 5 6.1 6.1 5 10 3.9 6.1 0 5 3.9 3.9Z" />
      </svg>
      <span className="text-strong">{value}</span>
    </span>
  );
}
