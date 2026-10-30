import { tokenHex } from './tokens';

/** Colours a chart library needs as plain hex. Keys are the semantic token names, camel-cased. */
export interface Palette {
  strong: string; weaker: string; strokeWeak: string; strokeStrong: string;
}

// Dusk is dark only, so there is one palette. It is read from lib/tokens.ts, never typed in by hand.
const DUSK: Palette = {
  strong: tokenHex('strong'), weaker: tokenHex('weaker'),
  strokeWeak: tokenHex('stroke-weak'), strokeStrong: tokenHex('stroke-strong'),
};

/** Hex palette for chart libraries that can't read CSS variables. */
export function usePalette(): Palette {
  return DUSK;
}
