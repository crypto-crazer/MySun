import { cx } from '@/lib/format';

const TURN = { right: '', down: 'rotate-90', left: 'rotate-180', up: '-rotate-90' } as const;

/** A drawn arrow, in place of a text arrow (→ ↓) that every font draws differently. It takes the text colour. */
export function Arrow({ dir = 'right', size = 12, className }: { dir?: keyof typeof TURN; size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 12 12" width={size} height={size} className={cx('shrink-0', TURN[dir], className)} fill="none" aria-hidden>
      <path d="M2 6h8M6.5 2.5L10 6l-3.5 3.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
