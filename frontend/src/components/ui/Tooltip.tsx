import { useState, type ReactNode } from 'react';
import { cx } from '@/lib/format';

interface Props {
  content: ReactNode;
  children: ReactNode;
  side?: 'top' | 'bottom';
  align?: 'start' | 'center' | 'end';
  className?: string;
  wide?: boolean;
}

/** Hover/focus tooltip. Pure CSS positioning, no portal — fine for a demo. */
export function Tooltip({ content, children, side = 'top', align = 'center', className, wide }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <span
      className={cx('relative inline-flex', className)}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {children}
      {open && (
        <span
          role="tooltip"
          className={cx(
            'absolute z-40 rounded-sm bg-fill-inverse text-inverse-strong px-3 py-2 text-xs font-medium leading-snug animate-fade-in',
            wide ? 'w-72' : 'w-max max-w-[260px]',
            side === 'top' ? 'bottom-full mb-2' : 'top-full mt-2',
            align === 'center' && 'left-1/2 -translate-x-1/2',
            align === 'start' && 'left-0',
            align === 'end' && 'right-0',
          )}
        >
          {content}
        </span>
      )}
    </span>
  );
}

/** The dashed underline that marks a term as one with more to say. It stands in for an info icon. */
export const HINT_UNDERLINE = 'underline decoration-stroke-stronger decoration-dashed decoration-1 underline-offset-[3px]';

/** A term that explains itself: underlined, with the explanation on hover or focus. */
export function Hint({ tip, children, wide, align }: { tip: ReactNode; children: ReactNode; wide?: boolean; align?: Props['align'] }) {
  return (
    <Tooltip content={tip} wide={wide} align={align}>
      <span
        tabIndex={0}
        className={cx(HINT_UNDERLINE, 'cursor-help focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-stroke-focused')}
      >
        {children}
      </span>
    </Tooltip>
  );
}
