import { cx } from '@/lib/format';

interface Props {
  value: string;
  onChange: (v: string) => void;
  ariaLabel: string;
  /** Rings the edge in stroke-error. Say what is wrong next to the field. */
  error?: boolean;
  className?: string;
}

/**
 * A short percentage, typed — the deposit card's slippage tolerance. A small well with the % set
 * after the figure, recessed like the amount box: focused, the edge lights; wrong, it turns to error.
 * The whole well is the label, so a click anywhere in it reaches the field.
 */
export function PercentInput({ value, onChange, ariaLabel, error, className }: Props) {
  return (
    <label
      className={cx(
        'well inline-flex h-8 cursor-text items-center gap-1 px-3 text-xs num transition-shadow duration-150',
        error ? 'well-field-error' : 'well-field',
        className,
      )}
    >
      <input
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={ariaLabel}
        aria-invalid={error || undefined}
        // the well's ring is the focus mark, so the global input outline stays off (as in the amount box)
        className="w-12 bg-transparent text-right text-strong outline-none focus-visible:outline-none placeholder:text-weaker"
      />
      <span className="text-weaker">%</span>
    </label>
  );
}
