import { CHAINS, type ChainId } from '@/demo/data/chains';
import { cx } from '@/lib/format';

/** Chain marks. Robinhood Chain is its own feather on its own lime; the others are simplified marks in one neutral tone. */
export function ChainLogo({ chain, size = 16, className }: { chain: ChainId; size?: number; className?: string }) {
  const c = CHAINS[chain];
  return (
    <span
      className={cx('inline-flex items-center justify-center rounded-sm text-inverse-strong shrink-0', chain !== 'robinhood' && 'bg-weak', className)}
      style={{ width: size, height: size, ...(chain === 'robinhood' ? { background: c.color, color: '#000' } : {}) }}
      title={c.name}
      aria-label={c.name}
    >
      {chain === 'ethereum' && (
        <svg viewBox="0 0 16 16" width={size * 0.7} height={size * 0.7} fill="none" aria-hidden>
          <path d="M8 1.5v4.9l4 1.8L8 1.5Z" fill="currentColor" fillOpacity=".6" />
          <path d="M8 1.5 4 8.2l4-1.8V1.5Z" fill="currentColor" />
          <path d="M8 11.2v3.3l4-5.6-4 2.3Z" fill="currentColor" fillOpacity=".6" />
          <path d="M8 14.5v-3.3L4 8.9l4 5.6Z" fill="currentColor" />
          <path d="m8 10.4 4-2.2-4-1.8v4Z" fill="currentColor" fillOpacity=".2" />
          <path d="m4 8.2 4 2.2v-4L4 8.2Z" fill="currentColor" fillOpacity=".6" />
        </svg>
      )}
      {chain === 'robinhood' && (
        <svg viewBox="3 3 13.4 13.4" width={size * 0.78} height={size * 0.78} fill="none" aria-hidden>
          <path d="M4.7171 16.7H5.01282C5.06659 16.7 5.12036 16.6731 5.13828 16.6283C7.36967 10.9468 9.79822 8.13288 11.3217 6.44814C11.3844 6.37645 11.3575 6.32268 11.2679 6.32268H8.54362C8.44504 6.32268 8.3617 6.36211 8.2927 6.44814L6.33911 8.86772C6.05235 9.22618 5.98065 9.55775 5.98065 10.0327V12.5061C5.34439 14.2894 4.94113 15.4992 4.6454 16.5925C4.62748 16.6624 4.65437 16.7 4.7171 16.7ZM14.5478 3.66114C14.1266 3.21307 12.2268 3.19515 11.3485 3.53568C11.1657 3.60647 10.9901 3.72656 10.9094 3.79556C10.1029 4.48559 9.56522 5.03224 9.05442 5.56992C8.99169 5.63265 9.01857 5.69538 9.10819 5.69538H12.1282C12.406 5.69538 12.5673 5.85669 12.5673 6.13449V9.53983C12.5673 9.62944 12.639 9.65632 12.6928 9.57567L14.5119 7.2009C14.8076 6.81556 14.8973 6.69906 14.9779 6.16137C15.0854 5.37277 15.0227 4.16298 14.5478 3.66114ZM10.6496 12.6942L11.8952 10.6421C11.9221 10.5883 11.931 10.5256 11.931 10.4808V7.05751C11.931 6.9679 11.8683 6.93205 11.8056 7.00375C9.93264 9.09176 8.47193 11.2873 7.11875 13.9309C7.0847 13.9972 7.12772 14.0564 7.20837 14.0295L10.0043 13.1692C10.3198 13.0724 10.4972 12.9452 10.6496 12.6942Z" fill="currentColor" />
        </svg>
      )}
      {chain === 'arc' && (
        <svg viewBox="0 0 16 16" width={size * 0.7} height={size * 0.7} fill="none" aria-hidden>
          <path d="M3 11.5a5.5 5.5 0 0 1 10 0" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
          <circle cx="8" cy="12" r="1.2" fill="currentColor" />
        </svg>
      )}
    </span>
  );
}
