/**
 * Every registry vault this build offers, read live and valued at spot — the one data source of
 * Markets and the vault page. Wraps the catalogue
 * (./useVaultCatalog.ts) with one reference-pool spot hook per chain (./useSpotPrices.ts) and the
 * spot math (./spot.ts, ./liveVaults.ts). Nothing invented: a figure the chain cannot give is
 * `undefined` and the caller renders "—".
 */
import type { Address } from 'viem';
import { DEPLOYMENTS } from './chains';
import { navPerShareUsd, vaultRouteId } from './liveVaults';
import { USD_ANCHOR_SYMBOL, valueBasket, type BasketValuation } from './spot';
import { useSpotPrices, type ChainSpots } from './useSpotPrices';
import { useVaultCatalog, type CatalogToken, type CatalogVault } from './useVaultCatalog';

export interface LiveVaultRow {
  /** `/vault/:id` segment (`<chainId>-<key>`). */
  id: string;
  v: CatalogVault;
  valuation: BasketValuation;
  /** Spot NAV per receipt token (USD, display only). */
  nav: number | undefined;
  spotsLoading: boolean;
}

/** The basket's USDG (the price anchor), if it holds one. */
export function anchorOf(tokens: readonly CatalogToken[]): CatalogToken | undefined {
  return tokens.find((t) => t.symbol === USD_ANCHOR_SYMBOL);
}

export function useLiveVaults(account?: Address): { rows: LiveVaultRow[]; spotsFor: (chainId: number) => ChainSpots } {
  const catalog = useVaultCatalog(account);
  // One spot hook per chain. The registry is a build-time constant, so the hook count is fixed.
  const spotsByChain = DEPLOYMENTS.map((d) => {
    const tokens = catalog.filter((v) => v.chainId === d.chainId).flatMap((v) => v.tokens);
    return useSpotPrices(d, anchorOf(tokens)?.address, tokens.map((t) => t.address));
  });
  const spotsFor = (chainId: number) => spotsByChain[DEPLOYMENTS.findIndex((d) => d.chainId === chainId)];

  const rows = catalog.map((v): LiveVaultRow => {
    const chainSpots = spotsFor(v.chainId);
    const valuation = valueBasket(v.tokens, anchorOf(v.tokens), chainSpots.spots);
    return {
      id: vaultRouteId(v.chainId, v.entry.key),
      v,
      valuation,
      nav: navPerShareUsd(valuation.usd, v.supply, v.decimals),
      spotsLoading: chainSpots.isLoading,
    };
  });
  return { rows, spotsFor };
}
