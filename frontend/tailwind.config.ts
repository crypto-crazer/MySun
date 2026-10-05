import type { Config } from 'tailwindcss';
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
      // `display` is the emphasis face for numbers and UI titles; the serif is for page-level titles.
      // "Switzer Figures" holds only figures and their signs (src/index.css), so it leads both stacks:
      // every figure is set in Switzer, every letter in Geist.
      display: ['"Switzer Figures"', 'Geist', '"Helvetica Neue"', 'Helvetica', 'Arial', 'sans-serif'],
      sans: ['"Switzer Figures"', 'Geist', '"Helvetica Neue"', 'Helvetica', 'Arial', 'sans-serif'],
      serif: ['Zodiak', '"Iowan Old Style"', '"Palatino Linotype"', 'Georgia', 'serif'],
      mono: ['"Geist Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
    },
    // Geist carries emphasis at 500; 600 is the ceiling.
    fontWeight: { thin: '100', light: '300', normal: '400', medium: '500', semibold: '500', bold: '600' },
    borderRadius: { none: '0', sm: '2px', DEFAULT: '3px', md: '3px', lg: '4px', full: '2px', circle: '50%' },
    extend: {
      fontSize: {
        '2xs': ['11px', '14px'],
        xs: ['12px', '16px'],
        sm: ['13px', '18px'],
        base: ['14px', '20px'],
        md: ['15px', '22px'],
        lg: ['17px', '24px'],
        xl: ['20px', '26px'],
        '2xl': ['24px', '30px'],
        '3xl': ['30px', '36px'],
        '4xl': ['38px', '44px'],
      },
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
