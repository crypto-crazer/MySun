// @vitest-environment jsdom
/**
 * Poll failure-backoff (TASK-POLL-BACKOFF): a dead RPC once made one stuck tab poll ~10x the designed
 * rate (fixed interval × retries) and burned the Cloudflare request quota. `useReads` now:
 *  - polls a healthy query at exactly `POLL_MS`;
 *  - backs off 15s → 30s → 60s cap (`POLL_MS` → ×2 → cap) while every poll fails, without retries per poll;
 *  - returns to `POLL_MS` after the first successful poll;
 *  - still honours an explicit `retry`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { Address } from 'viem';
import type { ContractCall, ReadResult } from '@/chain/client';
import { POLL_BACKOFF_CAP_MS, POLL_MS, pollInterval, useReads } from '@/chain/useReads';

const readMany = vi.hoisted(() => vi.fn<(chainId: number, calls: readonly ContractCall[]) => Promise<ReadResult[]>>());
vi.mock('@/chain/client', async (orig) => ({ ...(await orig<typeof import('@/chain/client')>()), readMany }));

const CALLS: readonly ContractCall[] = [
  { address: '0x0000000000000000000000000000000000000001' as Address, abi: [], functionName: 'totalSupply' },
];
const OK: ReadResult[] = [{ status: 'success', result: 1n }];

let backendUp = true;
/** Timestamps (fake clock, ms since the test started) of every readMany call. */
let calls: number[] = [];
let t0 = 0;

function wrapper() {
  // App-like defaults (Providers.tsx retries once) — useReads must not inherit that retry.
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: 2_000, retry: 1 } } });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const gaps = (ts: number[]) => ts.slice(1).map((t, i) => t - ts[i]);

beforeEach(() => {
  vi.useFakeTimers();
  t0 = Date.now();
  calls = [];
  backendUp = true;
  readMany.mockReset();
  readMany.mockImplementation(async () => {
    calls.push(Date.now() - t0);
    if (!backendUp) throw new Error('fetch failed: RPC origin unreachable');
    return OK;
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useReads — failure backoff', () => {
  it('a healthy query keeps polling every POLL_MS (15s)', async () => {
    expect(POLL_MS).toBe(15_000);
    renderHook(() => useReads(CALLS, { chainId: 46630 }), { wrapper: wrapper() });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(60_000 / POLL_MS + 1); // t = 0, 15, 30, 45, 60s
    expect(new Set(gaps(calls))).toEqual(new Set([POLL_MS]));
  });

  it('a persistently failing backend is polled < 10 times in 5 minutes, at growing intervals capped at 60s', async () => {
    backendUp = false;
    renderHook(() => useReads(CALLS, { chainId: 46630 }), { wrapper: wrapper() });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    // Fixed 5s polling with retries made this ~60 polls × (1 + retries); now one request per poll:
    // t = 0, 15, 45, 105, 165, 225, 285s.
    expect(calls.length).toBeLessThan(10);
    expect(gaps(calls)).toEqual([POLL_MS, 2 * POLL_MS, 60_000, 60_000, 60_000, 60_000]);
    expect(Math.max(...gaps(calls))).toBe(POLL_BACKOFF_CAP_MS);
  });

  it('an outage after healthy polling backs off, and the first success restores the 15s cadence', async () => {
    renderHook(() => useReads(CALLS, { chainId: 46630 }), { wrapper: wrapper() });
    const healthyFor = 2 * POLL_MS;
    await vi.advanceTimersByTimeAsync(healthyFor); // healthy: t = 0, 15, 30s
    backendUp = false;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    const outage = calls.filter((t) => t > healthyFor);
    expect(outage.length).toBeLessThan(10);
    // The first 15s is the healthy cadence that discovers the outage; then the ladder.
    expect(gaps([healthyFor, ...outage]).slice(0, 6)).toEqual([15_000, 15_000, 30_000, 60_000, 60_000, 60_000]);

    // Recovery: the next (capped) poll succeeds, and from then on the cadence is 15s again.
    backendUp = true;
    const before = calls.length;
    await vi.advanceTimersByTimeAsync(POLL_BACKOFF_CAP_MS + 4 * POLL_MS);
    const after = calls.slice(before);
    expect(after.length).toBeGreaterThan(3);
    expect(new Set(gaps(after))).toEqual(new Set([POLL_MS]));
  });

  it('an explicit retry is still honoured', async () => {
    backendUp = false;
    renderHook(() => useReads(CALLS, { chainId: 46630, retry: 2, pollMs: 60_000 }), { wrapper: wrapper() });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls).toHaveLength(3); // 1 attempt + 2 retries, then the 60s interval
  });
});

describe('pollInterval', () => {
  const healthy = { dataUpdatedAt: 1_000, errorUpdatedAt: 0, errorUpdateCount: 0 };
  it('is pollMs while the last poll succeeded', () => {
    expect(pollInterval(healthy, POLL_MS)).toBe(POLL_MS);
    expect(pollInterval({ dataUpdatedAt: 50_000, errorUpdatedAt: 40_000, errorUpdateCount: 7 }, POLL_MS)).toBe(POLL_MS);
  });
  it('a first failure after a long pause (hidden tab) does not jump to the cap', () => {
    expect(pollInterval({ dataUpdatedAt: 1, errorUpdatedAt: 3_600_000, errorUpdateCount: 1 }, POLL_MS)).toBe(POLL_MS);
  });
  it('a new outage after an earlier one restarts the ladder from pollMs', () => {
    expect(pollInterval({ dataUpdatedAt: 100_000, errorUpdatedAt: 115_000, errorUpdateCount: 12 }, POLL_MS)).toBe(POLL_MS);
    expect(pollInterval({ dataUpdatedAt: 100_000, errorUpdatedAt: 130_000, errorUpdateCount: 13 }, POLL_MS)).toBe(30_000);
  });
  it('the 15s ladder: 15s → 30s → 60s cap while every poll fails', () => {
    const failing = (errors: number, sinceSuccess: number) =>
      pollInterval({ dataUpdatedAt: 0, errorUpdatedAt: sinceSuccess, errorUpdateCount: errors }, POLL_MS);
    expect([failing(1, 15_000), failing(2, 30_000), failing(3, 60_000), failing(4, 120_000)]).toEqual([
      15_000, 30_000, 60_000, 60_000,
    ]);
  });
  it('never polls slower than the cap, nor faster than a pollMs above it', () => {
    expect(pollInterval({ dataUpdatedAt: 0, errorUpdatedAt: 9e9, errorUpdateCount: 999 }, POLL_MS)).toBe(POLL_BACKOFF_CAP_MS);
    expect(pollInterval({ dataUpdatedAt: 0, errorUpdatedAt: 9e9, errorUpdateCount: 999 }, 300_000)).toBe(300_000);
  });
});
