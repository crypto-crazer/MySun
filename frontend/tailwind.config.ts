import type { Config } from 'tailwindcss';
import defaultTheme from 'tailwindcss/defaultTheme';
import plugin from 'tailwindcss/plugin';
import { cssVariables, tailwindColors } from './src/lib/tokens';

// Design tokens — Dusk direction.
//
// Colour comes in two layers, both defined in src/lib/tokens.ts: primitives (the palette) and
// semantic tokens (roles). Only the semantic names become utilities, so a component cannot reach
// a primitive: `text-strong`, `bg-fill-weak`, `border-stroke-weak`. The plugin at the bottom writes
// both layers out as CSS variables. See docs/design-system.md and the gallery at /design-system.
//
// Dusk is dark only. One rule shapes it: only the price is round. The sun, the price needle
// and price points are circles; everything structural (ranges, controls, cards, token tiles)
// is square-cut. That is why the radius scale below is small all the way up to `full`.
// Draw a real circle with `rounded-circle`.

export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    colors: tailwindColors(),
    fontFamily: {
      // The serif (Newsreader, light) sets every title, from the page title down to a card's.
      // `display` names the emphasis role for readings. "Switzer Figures" holds only figures and their
      // signs (src/index.css), so it leads both sans stacks: every figure in them is Switzer, every letter Geist.
      display: ['"Switzer Figures"', 'Geist', '"Helvetica Neue"', 'Helvetica', 'Arial', 'sans-serif'],
      sans: ['"Switzer Figures"', 'Geist', '"Helvetica Neue"', 'Helvetica', 'Arial', 'sans-serif'],
      serif: ['Newsreader', '"Iowan Old Style"', '"Palatino Linotype"', 'Georgia', 'serif'],
      mono: ['"Geist Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
    },
    // The serif is set at light (300), and at regular (400) for vault names. Geist carries emphasis at 500; 600 is the ceiling.
    fontWeight: { light: '300', normal: '400', medium: '500', semibold: '500', bold: '600' },
    borderRadius: { none: '0', sm: '2px', DEFAULT: '3px', md: '3px', lg: '4px', full: '2px', circle: '50%' },
    // Even sizes on 4px line heights, and the whole scale: Tailwind's own sizes are replaced, not extended.
    // There is no `sm`; supporting text is `base` in a weaker colour.
    fontSize: {
      '2xs': ['10px', '12px'],
      xs: ['12px', '16px'],
      base: ['14px', '20px'],
      md: ['16px', '24px'],
      lg: ['18px', '24px'],
      xl: ['20px', '28px'],
      '2xl': ['24px', '32px'],
      '3xl': ['32px', '40px'],
      '4xl': ['40px', '48px'],
    },
    // Tailwind's 4px scale without its 6, 10 and 14px half steps. `0.5` (2px) stays for a nudge.
    spacing: Object.fromEntries(Object.entries(defaultTheme.spacing).filter(([step]) => !['1.5', '2.5', '3.5'].includes(step))),
    extend: {
      letterSpacing: { label: '0.14em' },
      boxShadow: {
        pop: '0 20px 50px rgb(var(--color-black) / 0.5), 0 0 0 1px rgb(var(--color-stroke-strong))',
        sheet: '-30px 0 80px rgb(var(--color-black) / 0.5)',
        // A recess cut into a surface: shade under the top edge, and the bottom rim catching the light.
        well: 'inset 0 1px 2px rgb(var(--color-black) / 0.55), inset 0 3px 6px rgb(var(--color-black) / 0.3), 0 1px 0 rgb(var(--color-strong) / 0.08)',
      },
      transitionTimingFunction: { dusk: 'cubic-bezier(0.65, 0, 0.35, 1)' },
      keyframes: {
        'fade-in': { from: { opacity: '0', transform: 'translateY(4px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        'slide-in': { from: { opacity: '0', transform: 'translateX(40px)' }, to: { opacity: '1', transform: 'translateX(0)' } },
        rise: { from: { transform: 'translateY(8px)' }, to: { transform: 'translateY(-2px)' } },
        spin: { to: { transform: 'rotate(360deg)' } },
      },
      animation: {
        'fade-in': 'fade-in 160ms ease-out',
        'slide-in': 'slide-in 450ms cubic-bezier(0.65, 0, 0.35, 1)',
        rise: 'rise 2s cubic-bezier(0.65, 0, 0.35, 1) infinite alternate',
        spin: 'spin 800ms linear infinite',
      },
    },
  },
  plugins: [
    plugin(({ addBase }) => addBase({ ':root, .dark': { 'color-scheme': 'dark', ...cssVariables() } })),
  ],
} satisfies Config;
