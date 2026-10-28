/**
 * Pure helpers behind the live vault surfaces (Markets, the vault page). No React, no
 * network: inputs are chain reads already landed (src/chain/useVaultCatalog.ts) and the spot
 * valuation (src/chain/spot.ts). USD stays OFF-CHAIN DISPLAY ONLY — nothing here feeds a write.
 *
 * Imports are relative (not `@/`), like spot.ts: plain module, runnable under tsx.
 */
import { USD_ANCHOR_SYMBOL, spotUsdPerToken, type SpotPrice } from './spot';

/** The `/vault/:id` segment for a registry vault: `<chainId>-<key>` (keys are unique per chain). */
export function vaultRouteId(chainId: number, key: string): string {
  return `${chainId}-${key}`;
}

/** `<chainId>-<key>` → its parts; undefined for anything else (old demo ids such as `eth-usdg`). */
export function parseVaultRouteId(id: string | undefined): { chainId: number; key: string } | undefined {
  const m = id ? /^(\d+)-(.+)$/.exec(id) : null;
  return m ? { chainId: Number(m[1]), key: m[2] } : undefined;
}

export interface VaultRef {
  chainId: number;
  key: string;
}

/**
 * A `/vault/:id` segment → the registry vault(s) it names, against `deployments` (pure, so the rule
 * is testable with any registry):
 *  - `<chainId>-<key>` → that vault, when the chain lists the key;
 *  - a classic bare `<key>` (`/vault/pons`) → the one vault with that key, when exactly one chain
 *    lists it; several chains → `ambiguous` with every match (the page lets the visitor pick);
 *  - anything else (old demo ids such as `eth-usdg`) → `missing`.
 * Registry keys start with a letter, so a leading `<digits>-` is always a chain id.
 */
export function resolveVaultRouteId(
  id: string | undefined,
  deployments: readonly { chainId: number; vaults: readonly { key: string }[] }[],
): { kind: 'found'; ref: VaultRef } | { kind: 'ambiguous'; matches: VaultRef[] } | { kind: 'missing' } {
  const listed = (chainId: number, key: string) => deployments.some((d) => d.chainId === chainId && d.vaults.some((v) => v.key === key));
  const ref = parseVaultRouteId(id);
  if (ref) return listed(ref.chainId, ref.key) ? { kind: 'found', ref } : { kind: 'missing' };
  if (!id) return { kind: 'missing' };
  const matches = deployments.filter((d) => d.vaults.some((v) => v.key === id)).map((d) => ({ chainId: d.chainId, key: id }));
  if (matches.length === 1) return { kind: 'found', ref: matches[0] };
  return matches.length > 1 ? { kind: 'ambiguous', matches } : { kind: 'missing' };
}

/**
 * USD per whole token for a basket, display only: USDG at its $1 peg, every other token at the live
 * spot of its reference pool (`spots`, keyed by lowercase address); a token with no pool is absent.
 */
export function tokenUsdPrices(
  tokens: readonly { address: string; symbol: string; decimals: number }[],
  spots: ReadonlyMap<string, SpotPrice>,
): Map<string, number> {
  const anchor = tokens.find((t) => t.symbol === USD_ANCHOR_SYMBOL);
  const out = new Map<string, number>();
  for (const t of tokens) {
    if (t.symbol === USD_ANCHOR_SYMBOL) out.set(t.address.toLowerCase(), 1);
    else {
      const spot = spots.get(t.address.toLowerCase());
      if (spot && anchor && spot.anchor.toLowerCase() === anchor.address.toLowerCase()) out.set(t.address.toLowerCase(), spotUsdPerToken(spot, t.decimals, anchor.decimals));
    }
  }
  return out;
}

/**
 * Spot NAV per receipt token, in USD: the basket's spot value over the receipt supply. Undefined when
 * either side is unknown or the vault has no supply yet (nothing to divide by — never a made-up 1.00).
 */
export function navPerShareUsd(tvlUsd: number | undefined, supply: bigint | undefined, decimals: number): number | undefined {
  if (tvlUsd === undefined || supply === undefined || supply === 0n) return undefined;
  const shares = Number(supply) / 10 ** decimals;
  return shares > 0 ? tvlUsd / shares : undefined;
}

/** A wallet's slice of the basket's spot value: balance / supply × TVL. */
export function holdingUsd(balance: bigint | undefined, supply: bigint | undefined, tvlUsd: number | undefined): number | undefined {
  if (balance === undefined || supply === undefined || tvlUsd === undefined || supply === 0n) return undefined;
  return (Number(balance) / Number(supply)) * tvlUsd;
}

/**
 * The name a token goes by in names and labels: wrapped ETH reads as ETH. Amount fields, approvals
 * and transactions keep the on-chain symbol, since the vault takes WETH, not native ETH.
 */
export function displaySymbol(symbol: string): string {
  return symbol === 'WETH' ? 'ETH' : symbol;
}

/**
 * The ON-CHAIN symbols in the order a basket reads: the anchor (USDG) last, like a pool pair, the
 * rest as on chain. Names and icon rows both take it, so the marks line up with the words.
 */
export function basketOrder(symbols: readonly string[]): string[] {
  const others = symbols.filter((s) => s !== USD_ANCHOR_SYMBOL);
  return others.length === symbols.length ? [...symbols] : [...others, USD_ANCHOR_SYMBOL];
}

/**
 * The basket as a display name, from the ON-CHAIN symbols in `basketOrder` ("ETH / USDG"); the
 * registry label without its parenthetical until the symbols land.
 */
export function basketName(symbols: readonly string[], fallbackLabel: string): string {
  if (symbols.length === 0) return fallbackLabel.replace(/\s*\([^)]*\)\s*$/, '').replace(/\bWETH\b/g, 'ETH');
  return basketOrder(symbols).map(displaySymbol).join(' / ');
}

/** `performanceFeeBps` → "10%", or "12.50%" when there are hundredths; "—" until read. */
export function feeLabel(bps: number | undefined): string {
  if (bps === undefined) return '—';
  return `${bps % 100 === 0 ? bps / 100 : (bps / 100).toFixed(2)}%`;
}
