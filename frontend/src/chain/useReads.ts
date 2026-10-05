/**
 * `useReadContracts` without wagmi.
 *
 * React Query stays (it is a generic async cache, not a wallet library) and does the three jobs
 * the live page actually depends on: dedupe identical reads across components, poll on a fixed
 * cadence, and expose loading/fetching/error/refetch. Everything wallet-shaped underneath it is
 * plain viem — see src/chain/client.ts.
 */
import { useQuery } from '@tanstack/react-query';
import { callsKey, readMany, type ContractCall, type ReadResult } from './client';

/** Polling beats block-watching here: Anvil only mines on demand, so a timer is the honest cadence. */
export const POLL_MS = 5_000;

export interface UseReadsOptions {
  /** The chain to read from — the live pages pass the target chain. Part of the cache key. */
  chainId: number;
  /**
   * What the reads belong to — the live pages pass the vault address. Part of the cache key, so the
   * reads of one vault (its tokens' metadata, its adapters) never answer for another vault, even
   * where the calls themselves are identical (two baskets sharing mUSDG).
   */
  scope?: string;
  enabled?: boolean;
  pollMs?: number;
  /** `false` for reads whose revert IS the answer (previewDeposit), so a failure shows at once. */
  retry?: boolean | number;
}

export interface ReadsResult {
  data: ReadResult[] | undefined;
  error: Error | null;
  isLoading: boolean;
  isFetching: boolean;
  refetch: () => void;
}

export function useReads(
  calls: readonly ContractCall[],
  { chainId, scope, enabled = true, pollMs = POLL_MS, retry }: UseReadsOptions,
): ReadsResult {
  const active = enabled && calls.length > 0;
  const query = useQuery({
    // The key is chain + scope + the calls themselves, so two components reading the same thing for
    // the same vault share one request — while the same address on two chains (CREATE3 deploys) or
    // the same call on behalf of two vaults never shares a cache entry.
    queryKey: ['reads', chainId, scope?.toLowerCase() ?? null, callsKey(calls)],
    queryFn: () => readMany(chainId, calls),
    enabled: active,
    refetchInterval: pollMs,
    ...(retry === undefined ? {} : { retry }),
  });
  return {
    data: query.data,
    error: (query.error as Error | null) ?? null,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    refetch: () => void query.refetch(),
  };
}

/** Read one entry out of a `useReads` result, or undefined when that call failed. */
export function pick<T>(data: readonly ReadResult[] | undefined, i: number): T | undefined {
  const entry = data?.[i];
  return entry && entry.status === 'success' ? (entry.result as T) : undefined;
}
