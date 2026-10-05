import { useId } from 'react';
import { cx } from '@/lib/format';

/**
 * The mark: two stones on a horizon with the sun setting between them.
 * Stones are the range bounds, the sun is the price. The sun is the only round shape.
 */
export function Mark({ size = 24, className }: { size?: number; className?: string }) {
  const clip = useId();
  return (
    <svg viewBox="0 0 48 48" width={size} height={size} className={cx('block shrink-0', className)} aria-hidden>
      <clipPath id={clip} clipPathUnits="userSpaceOnUse"><rect x="0" y="0" width="48" height="40" /></clipPath>
      <circle cx="24" cy="38.5" r="7.5" clipPath={`url(#${clip})`} className="fill-accent" />
      <rect x="10" y="4" width="6" height="36" fill="currentColor" />
      <rect x="32" y="4" width="6" height="36" fill="currentColor" />
      <rect x="0" y="40" width="48" height="1.8" fill="currentColor" />
    </svg>
  );
}

/** The mark as a busy indicator: the sun rises and sets between the stones. */
export function MarkLoader({ className }: { className?: string }) {
  const clip = useId();
  return (
    <svg viewBox="0 0 26 16" className={cx('block shrink-0', className)} aria-hidden>
      <clipPath id={clip}><rect x="0" y="0" width="26" height="13" /></clipPath>
      <g clipPath={`url(#${clip})`}><circle className="animate-rise" cx="13" cy="10" r="4" fill="currentColor" /></g>
      <rect x="5" y="1" width="2.5" height="12" fill="currentColor" />
      <rect x="18.5" y="1" width="2.5" height="12" fill="currentColor" />
      <rect x="1" y="13" width="24" height="1.2" fill="currentColor" />
    </svg>
  );
}
