/**
 * The real vault catalogue: every registry deployment (chain × vault), read live over RPC — what the
 * homepage's vault table is made of. No invented numbers: basket tokens, in-kind totals, receipt
 * supply, paused state and the connected wallet's own balances; a figure the chain cannot provide is
 * simply absent (the caller renders "—"), never synthesised.
 *
 * One `useReads` round per chain (RPC clients are per-chain), so the reads stay cache-keyed by
 * chainId + scope and two components asking for the same chain share one request. The vault list
 * round covers `tokens / totalTokens / totalSupply / paused / decimals / balanceOf / performanceFeeBps /
 * maxTotalSupply / isKeeper(registry keeper)`; a second round
 * fetches the basket tokens' symbols + decimals; a third the wallet's balance of each basket token
 * (only with an account). A vault lists its tokens only once the second round has answered: a token is
 * never shown under a placeholder symbol or assumed decimals.
 *
 * Team mode (src/lib/teamMode.ts): a `staging` vault is dropped from the list BEFORE the reads are
 * built — while locked it is neither shown nor read (no RPC call at all). Filtering the result instead
 * would shift every positional offset below (`STRIDE`, `pick` by index).
 */
import { useMemo } from 'react';
import type { Address } from 'viem';
import { erc20Abi } from 'viem';
import { vaultAbi } from '@/config/generated';
import { DEPLOYMENTS, type ChainDeployment, type VaultEntry } from './chains';
import { teamMode, useTeamUnlocked } from '@/lib/teamMode';
import { shortHex } from './amounts';
import { pick, useReads } from './useReads';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;

/**
 * Calls per vault in the first round: tokens, totalTokens, totalSupply, paused, decimals, balanceOf,
 * performanceFeeBps, maxTotalSupply, isKeeper(registry keeper).
 */
const STRIDE = 9;

export interface CatalogToken {
  address: Address;
  /** On-chain symbol; the short address only when its `symbol()` read failed (a non-standard token). */
  symbol: string;
  decimals: number;
  /** The vault's total for this token (idle + everything the adapters hold), from `totalTokens`. */
  total: bigint;
  /** The connected wallet's own balance, when an account was given and the read landed. */
  balance: bigint | undefined;
}

export interface CatalogVault {
  chainId: number;
  chainName: string;
  isLocal: boolean;
  entry: VaultEntry;
  address: Address;
  /** The receipt token's decimals (18 until read). */
  decimals: number;
  /** The basket, once its symbols and decimals are read; empty until then. */
  tokens: CatalogToken[];
  supply: bigint | undefined;
  paused: boolean | undefined;
  /** The wallet's receipt balance (zero included); undefined when no account / the read failed. */
  receiptBalance: bigint | undefined;
  /** Performance fee on harvested fees, in bps (`performanceFeeBps`). */
  performanceFeeBps: number | undefined;
  /** Receipt supply cap (`maxTotalSupply`; 0 = uncapped). */
  maxTotalSupply: bigint | undefined;
  /** The registry's keeper, confirmed on-chain with `isKeeper` (false = the registry is stale). */
  keeperConfirmed: boolean | undefined;
  /** The basket is known: the first round landed and its tokens' symbols + decimals are read. */
  ready: boolean;
  /** The chain could not be reached at all — every read in the first round failed. */
  failed: boolean;
  isLoading: boolean;
}

/**
 * Every registry vault this visitor may see (team mode: staging vaults only while unlocked), live.
 * Pass the connected account (or undefined) to also read its balances.
 */
export function useVaultCatalog(account?: Address): CatalogVault[] {
  const unlocked = useTeamUnlocked();
  // The registry is a build-time constant (a new chain or vault means a new build + sync), so the
  // hook order here is fixed for the life of a mount: the deployed-chain list never changes length
  // between renders. One catalogue hook per chain keeps each `useReads` on a single chainId. Team
  // mode filters each chain's DATA (its vault list), never the hook count; unlocking changes the
  // query keys, so that one refetch is expected.
  const perChain = DEPLOYMENTS.map((d) => useChainCatalog(d, account, unlocked));
  return useMemo(() => perChain.flat(), perChain);
}

/**
 * The build's deployments with each chain's vault list cut to what this visitor may see (team mode) —
 * for resolving a route or a `?deposit=` id, so a hidden vault resolves exactly like an unknown one.
 */
export function useVisibleDeployments(): readonly ChainDeployment[] {
  const unlocked = useTeamUnlocked();
  return useMemo(() => DEPLOYMENTS.map((d) => ({ ...d, vaults: teamMode.visibleVaults(d.vaults, unlocked) })), [unlocked]);
}

function useChainCatalog(deployment: ChainDeployment, account: Address | undefined, unlocked: boolean): CatalogVault[] {
  const vaults = useMemo(() => teamMode.visibleVaults(deployment.vaults, unlocked), [deployment.vaults, unlocked]);

  const round1 = useReads(
    vaults.flatMap((v) => [
      { address: v.vault, abi: vaultAbi, functionName: 'tokens' } as const,
      { address: v.vault, abi: vaultAbi, functionName: 'totalTokens' } as const,
      { address: v.vault, abi: vaultAbi, functionName: 'totalSupply' } as const,
      { address: v.vault, abi: vaultAbi, functionName: 'paused' } as const,
      { address: v.vault, abi: vaultAbi, functionName: 'decimals' } as const,
      { address: v.vault, abi: vaultAbi, functionName: 'balanceOf', args: [account ?? ZERO_ADDRESS] } as const,
      { address: v.vault, abi: vaultAbi, functionName: 'performanceFeeBps' } as const,
      { address: v.vault, abi: vaultAbi, functionName: 'maxTotalSupply' } as const,
      { address: v.vault, abi: vaultAbi, functionName: 'isKeeper', args: [v.keeper] } as const,
    ]),
    { chainId: deployment.chainId, scope: 'catalog' },
  );

  const basketAddrs = vaults.map((_, i) => pick<readonly Address[]>(round1.data, i * STRIDE) ?? []);
  const flatTokens = basketAddrs.flat();

  // Symbols + decimals of every basket token, in one round (two calls per token).
  const round2 = useReads(
    flatTokens.flatMap((t) => [
      { address: t, abi: erc20Abi, functionName: 'symbol' } as const,
      { address: t, abi: erc20Abi, functionName: 'decimals' } as const,
    ]),
    { chainId: deployment.chainId, scope: 'catalog', enabled: flatTokens.length > 0 },
  );

  // The wallet's own balance of each basket token — only asked for with an account.
  const round3 = useReads(
    account
      ? flatTokens.map((t) => ({ address: t, abi: erc20Abi, functionName: 'balanceOf', args: [account] }) as const)
      : [],
    { chainId: deployment.chainId, scope: 'catalog', enabled: Boolean(account) && flatTokens.length > 0 },
  );

  const failed = Boolean(round1.error);
  // The metadata round has answered (a whole-round failure too: the tokens then go by their addresses)
  const metaSettled = round2.data !== undefined || round2.error !== null;
  let offset = 0;
  return vaults.map((entry, i): CatalogVault => {
    const base = i * STRIDE;
    const addrs = basketAddrs[i];
    const first = offset;
    offset += addrs.length;

    const totalsRead = pick<readonly [readonly Address[], readonly bigint[]]>(round1.data, base + 1);
    const totals = addrs.map((t) => {
      if (!totalsRead) return 0n;
      const [toks, amounts] = totalsRead;
      const idx = toks.findIndex((x) => x.toLowerCase() === t.toLowerCase());
      return idx === -1 ? 0n : (amounts[idx] ?? 0n);
    });

    const tokens: CatalogToken[] = !metaSettled ? [] : addrs.map((t, j) => ({
      address: t,
      symbol: pick<string>(round2.data, (first + j) * 2) ?? shortHex(t),
      decimals: Number(pick<number>(round2.data, (first + j) * 2 + 1) ?? 18),
      total: totals[j] ?? 0n,
      balance: account ? pick<bigint>(round3.data, first + j) : undefined,
    }));

    return {
      chainId: deployment.chainId,
      chainName: deployment.name,
      isLocal: deployment.local === true,
      entry,
      address: entry.vault,
      decimals: Number(pick<number>(round1.data, base + 4) ?? 18),
      tokens,
      supply: pick<bigint>(round1.data, base + 2),
      paused: pick<boolean>(round1.data, base + 3),
      receiptBalance: account ? pick<bigint>(round1.data, base + 5) : undefined,
      performanceFeeBps: ((x) => (x === undefined ? undefined : Number(x)))(pick<number>(round1.data, base + 6)),
      maxTotalSupply: pick<bigint>(round1.data, base + 7),
      keeperConfirmed: pick<boolean>(round1.data, base + 8),
      ready: pick<readonly Address[]>(round1.data, base) !== undefined && (addrs.length === 0 || metaSettled),
      failed,
      isLoading: round1.isLoading || (flatTokens.length > 0 && round2.isLoading),
    };
  });
}
