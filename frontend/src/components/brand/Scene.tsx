import { useId } from 'react';
import { cx } from '@/lib/format';

const TICKS = Array.from({ length: 81 }, (_, i) => i);

/**
 * The place the product is drawn in: a plaza at dusk, two stones, the sun setting between
 * them, a graduated scale along the ground. A still, decorative frame for the Earn page.
 * On wide screens the stones and the sun sit to the right so text can take the left.
 */
export function Scene({ className }: { className?: string }) {
  const id = useId();
  const sky = `${id}-sky`, glow = `${id}-glow`, sun = `${id}-sun`, plaza = `${id}-plaza`;
  return (
    <svg className={cx('block', className)} viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice" aria-hidden focusable="false">
      <defs>
        <linearGradient id={sky} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#120a0e" />
          <stop offset=".42" stopColor="#3f2430" />
          <stop offset=".62" stopColor="#94574f" />
        </linearGradient>
        <radialGradient id={glow} cx="800" cy="560" r="560" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#f59a5e" stopOpacity=".5" />
          <stop offset="1" stopColor="#f59a5e" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={sun}>
          <stop offset=".1" stopColor="#fff0cc" />
          <stop offset="1" stopColor="#ff9a4a" />
        </radialGradient>
        <linearGradient id={plaza} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#a5857a" />
          <stop offset="1" stopColor="#6a4d45" />
        </linearGradient>
      </defs>
      <rect width="1600" height="900" fill={`url(#${sky})`} />
      <rect width="1600" height="900" fill={`url(#${glow})`} />
      <g className="lg:translate-x-[360px]">
        <circle cx="800" cy="556" r="60" fill={`url(#${sun})`} />
      </g>
      <path d="M0 566 C200 548 360 556 520 562 C700 572 900 554 1080 558 C1260 562 1420 552 1600 558 V900 H0 Z" fill="#76493f" />
      <rect y="604" width="1600" height="296" fill={`url(#${plaza})`} />
      <g className="lg:translate-x-[360px]">
        <path d="M606 712 L120 900 H330 L690 712 Z" fill="#3e2622" opacity=".45" />
        <path d="M914 712 L1030 900 H1240 L996 712 Z" fill="#3e2622" opacity=".45" />
        <rect x="608" y="-10" width="84" height="722" fill="#d7bea9" />
        <rect x="908" y="-10" width="84" height="722" fill="#d7bea9" />
        <rect x="692" y="760" width="216" height="12" fill="#ffae3d" opacity=".28" />
      </g>
      <g fill="#4a2f2b">
        {TICKS.map((i) => {
          const major = i % 5 === 0;
          return <rect key={i} x={i * 20 - 1} y={major ? 748 : 756} width="2" height={major ? 22 : 14} />;
        })}
      </g>
      <rect x="0" y="772" width="1600" height="2" fill="#4a2f2b" />
    </svg>
  );
}
