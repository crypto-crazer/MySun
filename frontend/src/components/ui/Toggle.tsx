import { cx } from '@/lib/format';

interface Props {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
  tone?: 'primary' | 'accent';
}

export function Toggle({ checked, onChange, label, tone = 'primary' }: Props) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cx(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors duration-150',
        checked ? (tone === 'accent' ? 'bg-fill-accent border-stroke-accent' : 'bg-fill-primary border-stroke-primary') : 'bg-fill-track border-stroke-strong',
      )}
    >
      <span
        className={cx(
          'inline-block h-3.5 w-3.5 rounded-full bg-inverse-strong transition-transform duration-150',
          checked ? 'translate-x-[18px]' : 'translate-x-[2px]',
        )}
      />
    </button>
  );
}
