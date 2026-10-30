/**
 * `useReadContracts` without wagmi.
 *
 * React Query stays (it is a generic async cache, not a wallet library) and does the three jobs
 * the live page actually depends on: dedupe identical reads across components, poll on a fixed
 * cadence (backing off while the RPC keeps failing — see `pollInterval`), and expose
 * loading/fetching/error/refetch. Everything wallet-shaped underneath it is
 * plain viem — see src/chain/client.ts.
 */
import { useQuery, type QueryState } from '@tanstack/react-query';
import { callsKey, readMany, type ContractCall, type ReadResult } from './client';

/**
 * Polling beats block-watching here: Anvil only mines on demand, so a timer is the honest cadence.
 * 15s, not 5s (TASK-QUOTA-GUARDS): every read goes through the demo worker, and the Cloudflare
 * account's free Workers quota (100k requests/day) is shared by the demo site and analytics. One
 * active vault tab then costs ~28 req/min ≈ 40k/day instead of ~84 req/min ≈ 121k/day — a single
 * tab on 5s alone exhausted the day (error 1027 for the whole account).
 */
export const POLL_MS = 15_000;

/**
 * Ceiling of the failure backoff. A dead RPC is polled at most once a minute per query: a stuck tab
 * then costs ~1 req/min per read group instead of ~16 req/s (TASK-POLL-BACKOFF incident), and a
 * recovered backend is noticed within a minute — the first success drops straight back to `pollMs`.
 */
export const POLL_BACKOFF_CAP_MS = 60_000;

type PollState = Pick<QueryState, 'dataUpdatedAt' | 'errorUpdatedAt' | 'errorUpdateCount'>;

/**
 * The next poll delay: `pollMs` while healthy; after consecutive failed polls it doubles
 * (15s → 30s → 60s cap) and snaps back to `pollMs` on the first success.
 *
 * Derived from React Query's own state, no parallel counter. Not `fetchFailureCount`: the query
 * resets it at the start of every fetch, so it never sees more than one poll's failures. Instead,
 * two persisted upper bounds of the doubling ladder, taking the smaller:
 *  - time since the last success — exactly the ladder when every poll in between failed (each
 *    interval equals the outage so far), but it overshoots after a pause (a hidden tab);
 *  - `pollMs · 2^(errors − 1)` over ALL errors — exactly the ladder for a query that never
 *    succeeded, but it overshoots after an earlier, recovered outage.
 */
export function pollInterval(state: PollState, pollMs: number): number {
  if (state.errorUpdateCount === 0 || state.errorUpdatedAt <= state.dataUpdatedAt) return pollMs;
  const sinceSuccess = state.errorUpdatedAt - state.dataUpdatedAt;
  const byCount = pollMs * 2 ** Math.min(state.errorUpdateCount - 1, 16);
  return Math.min(Math.max(Math.min(sinceSuccess, byCount), pollMs), Math.max(POLL_BACKOFF_CAP_MS, pollMs));
}

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
  /**
   * Defaults to no retry: the next poll is the retry, so a dead backend costs one request per
   * interval rather than 1 + retries. `false` is also what reads whose revert IS the answer
   * (previewDeposit) pass explicitly, so a failure shows at once.
   */
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
  { chainId, scope, enabled = true, pollMs = POLL_MS, retry = false }: UseReadsOptions,
): ReadsResult {
  const active = enabled && calls.length > 0;
  const query = useQuery({
    // The key is chain + scope + the calls themselves, so two components reading the same thing for
    // the same vault share one request — while the same address on two chains (CREATE3 deploys) or
    // the same call on behalf of two vaults never shares a cache entry.
    queryKey: ['reads', chainId, scope?.toLowerCase() ?? null, callsKey(calls)],
    queryFn: () => readMany(chainId, calls),
    enabled: active,
    refetchInterval: (q) => pollInterval(q.state, pollMs),
    retry,
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
