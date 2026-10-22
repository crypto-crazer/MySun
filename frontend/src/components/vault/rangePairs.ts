/**
 * The pairs the range drawings show for a live basket: every non-USDG token priced in USDG at its
 * live reference-pool spot, between the adapters' on-chain range for that token (src/chain/ranges.ts).
 * A token without a band (no live position on its USDG pair, or the reads have not landed) is left out.
 * `base` is the display name (WETH reads as ETH), since the pair only ever labels the drawing.
 */
import { displaySymbol } from '@/chain/liveVaults';
import { USD_ANCHOR_SYMBOL } from '@/chain/spot';
import type { PriceBand } from '@/chain/ranges';
import type { RangePair } from './PriceRange';

export function rangePairsFor(
  tokens: readonly { address: string; symbol: string }[],
  usdPrices: ReadonlyMap<string, number>,
  bands: ReadonlyMap<string, PriceBand>,
): RangePair[] {
  return tokens.flatMap((t) => {
    const price = usdPrices.get(t.address.toLowerCase());
    const band = bands.get(t.address.toLowerCase());
    if (t.symbol === USD_ANCHOR_SYMBOL || price === undefined || !(price > 0) || !band) return [];
    return [{ base: displaySymbol(t.symbol), quote: USD_ANCHOR_SYMBOL, price, lower: band.lower, upper: band.upper }];
  });
}
