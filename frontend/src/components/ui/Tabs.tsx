import { useRef } from 'react';
import { cx } from '@/lib/format';
import { SlidingKey } from './SlidingKey';

interface Props<T extends string> {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: string; disabled?: boolean }>;
  size?: 'sm' | 'md';
  className?: string;
}

/**
 * Segmented control — used for 30D/7D, the analytics window, the Markets chain filter.
 * A groove like the deposit card's token choice: the options sit in the well, and the chosen one is
 * raised out of it as a glass key that slides to it.
 */
export function Segmented<T extends string>({ value, onChange, options, size = 'md', className }: Props<T>) {
  const track = useRef<HTMLDivElement>(null);

  return (
    <div ref={track} className={cx('well groove inline-flex', className)} role="tablist">
      <SlidingKey track={track} chosen='[aria-selected="true"]' />
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={value === o.value}
          disabled={o.disabled}
          onClick={() => onChange(o.value)}
          className={cx(
            'transition-colors duration-300 ease-dusk whitespace-nowrap disabled:opacity-40',
            size === 'sm' ? 'h-7 px-3 text-xs' : 'h-8 px-3 text-base',
            value === o.value ? 'text-strong' : 'text-weak hover:text-strong',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function UnderlineTabs<T extends string>({ value, onChange, options, className }: Props<T>) {
  return (
    <div className={cx('flex border-b border-stroke-weak', className)} role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx(
            'h-11 px-4 text-base font-medium -mb-px border-b-2 transition-colors',
            value === o.value ? 'border-stroke-selected text-strong' : 'border-transparent text-weaker hover:text-weak',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
