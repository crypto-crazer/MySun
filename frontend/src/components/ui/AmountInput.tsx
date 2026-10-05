import { cx, fmtToken } from '@/lib/format';

interface Props {
  value: string;
  onChange: (v: string) => void;
  token: string;
  balance?: number;
  balanceLabel?: string;
  onMax?: () => void;
  error?: string | null;
  hint?: string;
  autoFocus?: boolean;
}

export function AmountInput({ value, onChange, token, balance, balanceLabel = 'Balance', onMax, error, hint, autoFocus }: Props) {
  return (
    <div>
      <div className={cx('flex items-center gap-2 bg-fill-recessed border rounded px-3 h-12', error ? 'border-stroke-error/70' : 'border-stroke-weak focus-within:border-stroke-stronger')}>
        <input
          type="number"
          inputMode="decimal"
          min={0}
          step="any"
          autoFocus={autoFocus}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="0.00"
          className="flex-1 min-w-0 bg-transparent text-lg num text-strong placeholder:text-weaker outline-none"
        />
        <span className="text-sm text-weak font-medium">{token}</span>
        {onMax && (
          <button onClick={onMax} className="h-6 px-2 rounded bg-fill-weak text-2xs font-medium text-strong hover:brightness-110">
            Max
          </button>
        )}
      </div>
      <div className="flex justify-between mt-1.5 text-xs">
        <span className={cx(error ? 'text-error' : 'text-weaker')}>{error ?? hint ?? ''}</span>
        {balance !== undefined && (
          <span className="text-weaker num">
            {balanceLabel}: <span className="text-weak">{fmtToken(balance)}</span>
          </span>
        )}
      </div>
    </div>
  );
}
