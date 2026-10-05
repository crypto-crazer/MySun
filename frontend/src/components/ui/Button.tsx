import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cx } from '@/lib/format';
import { Spinner } from './Spinner';

type Variant = 'primary' | 'accent' | 'secondary' | 'ghost' | 'danger';
type Size = 'xs' | 'sm' | 'md' | 'lg';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  block?: boolean;
  children: ReactNode;
}

const variants: Record<Variant, string> = {
  primary: 'btn-key btn-key-primary text-inverse-strong disabled:text-disabled',
  accent: 'btn-key btn-key-accent text-on-accent disabled:text-disabled',
  secondary: 'btn-glass text-strong disabled:text-disabled',
  ghost: 'bg-transparent text-weak hover:text-strong hover:bg-fill-hover disabled:text-disabled',
  danger: 'btn-glass btn-glass-danger text-error',
};

const sizes: Record<Size, string> = {
  xs: 'h-7 px-2.5 text-xs [--btn-radius:8px]',
  sm: 'h-9 px-3 text-sm',
  md: 'h-11 px-[18px] text-base',
  lg: 'h-12 px-5 text-md',
};

export function Button({ variant = 'primary', size = 'md', loading, block, className, children, disabled, ...rest }: Props) {
  // The spinner stays mounted while its slot closes, so it fades out with the slot instead of vanishing.
  const [spinnerHeld, setSpinnerHeld] = useState(false);
  useEffect(() => {
    if (loading) setSpinnerHeld(true);
  }, [loading]);

  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cx(
        'btn inline-flex items-center justify-center font-medium select-none whitespace-nowrap disabled:cursor-not-allowed',
        variants[variant],
        sizes[size],
        block && 'w-full',
        className,
      )}
    >
      {/* Only the label is baseline-aligned, so the button still sits on its label's baseline, not on the empty spinner slot. */}
      <span className="inline-flex items-center">
        <span
          aria-hidden
          className={cx('btn-spinner', loading && 'is-on')}
          onTransitionEnd={(e) => { if (!loading && e.propertyName === 'width') setSpinnerHeld(false); }}
        >
          {(loading || spinnerHeld) && <Spinner className="h-4 w-[26px]" />}
        </span>
        <span className={cx('self-baseline transition-opacity duration-300 ease-dusk', loading && 'opacity-80')}>{children}</span>
      </span>
    </button>
  );
}
