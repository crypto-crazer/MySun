import { tokenHex } from './tokens';

export type Theme = 'light' | 'dark';

/** Colours a chart library needs as plain hex. Keys are the semantic token names, camel-cased. */
export interface Palette {
  strong: string; weak: string; weaker: string; strokeWeak: string; strokeStrong: string; fillHover: string;
  success: string; error: string; warning: string; accent: string; chartSecondary: string;
}

// Dusk is dark only, so there is one palette. It is read from lib/tokens.ts, never typed in by hand.
const DUSK: Palette = {
  strong: tokenHex('strong'), weak: tokenHex('weak'), weaker: tokenHex('weaker'),
  strokeWeak: tokenHex('stroke-weak'), strokeStrong: tokenHex('stroke-strong'), fillHover: tokenHex('fill-hover'),
  success: tokenHex('success'), error: tokenHex('error'), warning: tokenHex('warning'),
  accent: tokenHex('accent'), chartSecondary: tokenHex('chart-secondary'),
};

/** Hex palette for chart libraries that can't read CSS variables. */
export function usePalette(): Palette {
  return DUSK;
}
