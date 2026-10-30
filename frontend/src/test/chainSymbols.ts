/**
 * Basket token symbols on screen, for the suites that render against the local chain (render / network).
 * Only chain reads put a basket symbol on the page — the deposit card names its zap token by the symbol the
 * chain gave it, never a hard-coded one — so any match anywhere means real reads have landed.
 */
import { screen } from '@testing-library/react';

/** A basket token symbol: the mock stack's m-prefixed tokens, or the RHC fork's REAL USDG / WETH / PONS. */
export const BASKET_SYMBOL = /^(m[A-Z]+|USDG|WETH|PONS)$/;

/** Every element whose text is a basket token symbol. */
export const chainSymbols = () => screen.queryAllByText(BASKET_SYMBOL);
