/**
 * The fixed fees() ABI shape, the row schema and the KV cycle — against an in-memory fake chain
 * (no network). The fake answers `readContract` and `multicall` by (address, functionName) only, and
 * counts the calls it serves — one per `readContract` / `multicall` = one HTTP subrequest in production.
 */
import { describe, expect, it } from 'vitest';
import type { Address, PublicClient } from 'viem';

import {
  assembleRow,
  bucketFees,
  collectOnce,
  priceUsdFromSpot,
  runCycle,
  type AdapterFees,
  type ChainPrices,
  type CollectDeps,
  type VaultReads,
} from '../src/collect.js';
import type { DeployedChain } from '../src/registry.js';

const Q192 = 2n ** 192n;
const ZERO = '0x0000000000000000000000000000000000000000' as Address;
const USDG = '0x00000000000000000000000000000000000000a1' as Address;
const WETH = '0x00000000000000000000000000000000000000b2' as Address;
const VAULT = '0x00000000000000000000000000000000000000c3' as Address;
const AD1 = '0x00000000000000000000000000000000000000d4' as Address;
const AD2 = '0x00000000000000000000000000000000000000d5' as Address;
const AD3 = '0x00000000000000000000000000000000000000d6' as Address; // no fees() view
const ZAP = '0x00000000000000000000000000000000000000e7' as Address;
const POOL = '0x00000000000000000000000000000000000000f8' as Address;
const SQRT_2400 = BigInt(Math.round(Math.sqrt(2.4e-9 * Number(Q192)))); // WETH token0, ~2400 USDG

const CHAIN: DeployedChain = {
  chainId: 4663,
  name: 'Robinhood Chain',
  rpcUrl: 'https://rpc.invalid',
  testnet: false,
  status: 'deployed',
  periphery: { zapIn: ZAP },
  vaults: [
    {
      key: 'main',
      label: 'USDG / WETH',
      receipt: { name: 'sunEthLP', symbol: 'sunEthLP' },
      vault: VAULT,
      implementation: VAULT,
      keeper: VAULT,
    },
  ],
};

interface FakeState {
  supply: bigint;
  totals: [Address[], bigint[]];
  wethSqrt: bigint;
  /** Overrides per adapter: a fees() result, or 'revert'. */
  fees: Record<string, readonly [Address[], bigint[]] | 'revert'>;
  /** The vault's performance-fee cut; the real vaults all read 1000 (10%). */
  performanceFeeBps: bigint;
  routeRevert?: boolean;
  /** Extra vault addresses that answer exactly like VAULT (the multi-vault cap test). */
  twins?: Address[];
  /** Vaults whose totalTokens() reverts. */
  totalsRevert?: Address[];
}

interface Counter {
  subrequests: number;
}

function fakeClient(s: FakeState, counter: Counter = { subrequests: 0 }): PublicClient {
  const answer = ({ address, functionName }: { address: Address; functionName: string }): unknown => {
    let a = address.toLowerCase();
    if (functionName === 'totalTokens' && s.totalsRevert?.includes(a as Address)) throw new Error('execution reverted');
    if (s.twins?.includes(a as Address)) a = VAULT;
    const key = `${a}:${functionName}`;
    switch (key) {
      case `${VAULT}:tokens`:
        return [USDG, WETH];
      case `${VAULT}:totalSupply`:
        return s.supply;
      case `${VAULT}:totalTokens`:
        return s.totals;
      case `${VAULT}:adapters`:
        return [AD1, AD2, AD3];
      case `${VAULT}:performanceFeeBps`:
        return s.performanceFeeBps;
      case `${USDG}:symbol`:
        return 'USDG';
      case `${USDG}:decimals`:
        return 6;
      case `${WETH}:symbol`:
        return 'WETH';
      case `${WETH}:decimals`:
        return 18;
      case `${ZAP}:routes`:
        if (s.routeRevert) throw new Error('execution reverted');
        return [POOL, 500, 1800, 50, 200];
      case `${POOL}:token0`:
        return WETH;
      case `${POOL}:token1`:
        return USDG;
      case `${POOL}:slot0`:
        return [s.wethSqrt, 0, 0, 0, 0, 0, true];
    }
    if (functionName === 'fees') {
      const f = s.fees[a];
      if (f === undefined || f === 'revert') throw new Error('execution reverted');
      return f;
    }
    throw new Error(`unexpected call ${key}`);
  };
  const readContract = async (call: { address: Address; functionName: string }) => {
    counter.subrequests++;
    return answer(call);
  };
  // viem's shape with allowFailure: one { status, result | error } per contract, never a throw.
  const multicall = async ({ contracts }: { contracts: { address: Address; functionName: string }[] }) => {
    counter.subrequests++;
    return contracts.map((c) => {
      try {
        return { status: 'success', result: answer(c) };
      } catch (error) {
        return { status: 'failure', error };
      }
    });
  };
  return { readContract, multicall } as unknown as PublicClient;
}

function baseState(): FakeState {
  return {
    supply: 200n * 10n ** 18n,
    totals: [[USDG, WETH], [100_000_000n, 50_000_000_000_000_000n]], // 100 USDG + 0.05 WETH
    wethSqrt: SQRT_2400,
    performanceFeeBps: 1000n,
    fees: {
      // Adapter 1: (USDG, WETH) pair. Adapter 2: same tokens in REVERSE order + a zero-address slot.
      [AD1]: [[USDG, WETH], [1_500_000n, 1_000_000_000_000_000n]],
      [AD2]: [[WETH, ZERO, USDG], [2_000_000_000_000_000n, 999n, 500_000n]],
    },
  };
}

const deps = (s: FakeState): CollectDeps => ({ chains: [CHAIN], clientFor: () => fakeClient(s) });

describe('bucketFees (fees() = address[] tokens, uint256[] amounts)', () => {
  it('buckets 2-token arrays per returned token, summing across adapters', () => {
    const m = bucketFees([
      [[USDG, WETH], [10n, 20n]],
      [[WETH, USDG], [5n, 7n]],
    ]);
    expect(m.get(USDG)).toBe(17n);
    expect(m.get(WETH)).toBe(25n);
    expect(m.size).toBe(2);
  });

  it('skips zero-address tokens and adapters without the view (undefined)', () => {
    const m = bucketFees([undefined, [[ZERO, WETH], [123n, 4n]]]);
    expect(m.has(ZERO)).toBe(false);
    expect(m.get(WETH)).toBe(4n);
    expect(m.size).toBe(1);
  });

  it('lowercases mixed-case token addresses into one bucket', () => {
    const mixed = '0xAbCdEf0000000000000000000000000000000001' as Address;
    const m = bucketFees([[[mixed], [1n]], [[mixed.toLowerCase() as Address], [2n]]]);
    expect(m.get(mixed.toLowerCase())).toBe(3n);
  });

  it('rejects misaligned arrays', () => {
    expect(() => bucketFees([[[USDG, WETH], [1n]]])).toThrow('misaligned');
  });
});

describe('collectOnce (fake chain, no network)', () => {
  it('writes one row with the Railway schema (same keys, same order) and per-token fee bucketing', async () => {
    const { lines, wrote, chains } = await collectOnce(deps(baseState()));
    expect({ wrote, chains }).toEqual({ wrote: 1, chains: 1 });
    expect(lines[0]?.endsWith('\n')).toBe(true);
    const row = JSON.parse(lines[0]!);

    expect(Object.keys(row)).toEqual([
      'ts', 'chainId', 'chain', 'vaultKey', 'vault', 'supply', 'tokenCount', 'tokens',
      'tvlUsd', 'navUsd', 'feesUsd', 'adapterCount', 'performanceFeeBps',
    ]);
    expect(Object.keys(row.tokens[0])).toEqual([
      'address', 'symbol', 'decimals', 'priceUsd', 'totalRaw', 'totalUsd', 'feeRaw', 'feeUsd',
    ]);

    const px = priceUsdFromSpot(SQRT_2400, true, 18);
    const [usdg, weth] = row.tokens;
    // Bigints serialise as decimal strings.
    expect(row.supply).toBe('200000000000000000000');
    expect(usdg.totalRaw).toBe('100000000');
    // USDG fees: 1.5 (AD1) + 0.5 (AD2, reversed order) — the zero-address 999 is dropped.
    expect(usdg.feeRaw).toBe('2000000');
    expect(usdg.feeUsd).toBeCloseTo(2, 9);
    // WETH fees: 0.001 + 0.002.
    expect(weth.feeRaw).toBe('3000000000000000');
    expect(weth.feeUsd).toBeCloseTo(0.003 * px, 9);
    expect(row.feesUsd).toBeCloseTo(2 + 0.003 * px, 9);
    expect(row.tvlUsd).toBeCloseTo(100 + 0.05 * px, 6);
    expect(row.navUsd).toBeCloseTo((100 + 0.05 * px) / 200, 9);
    expect(row.adapterCount).toBe(3); // AD3 (no fees view) still counts as an adapter
    // The performance-fee cut rides along so the reader can show a NET yield (chain/feeApy.ts).
    expect(row.performanceFeeBps).toBe(1000);
  });

  it('price miss → the snapshot is rejected (never a zero-valued leg)', async () => {
    const s = baseState();
    s.routeRevert = true;
    const { lines } = await collectOnce(deps(s));
    expect(lines).toHaveLength(0);
  });

  it('misaligned fees() arrays reject the snapshot', async () => {
    const s = baseState();
    s.fees[AD1] = [[USDG, WETH], [1n]];
    expect((await collectOnce(deps(s))).lines).toHaveLength(0);
  });

  it('skips an unreachable chain without throwing', async () => {
    const fail = async () => { throw new Error('fetch failed'); };
    const broken = { readContract: fail, multicall: fail } as unknown as PublicClient;
    const out = await collectOnce({ chains: [CHAIN], clientFor: () => broken });
    expect(out).toEqual({ lines: [], wrote: 0, chains: 1 });
  });

  it('NAV jump guard: a residual > 15% vs the last good row is rejected; a real price move is kept', async () => {
    const continuity = new Map();
    expect((await collectOnce(deps(baseState()), continuity)).wrote).toBe(1);

    const broken = baseState();
    broken.totals = [[USDG, WETH], [10_000_000n, 50_000_000_000_000_000n]]; // a failed total read
    expect((await collectOnce(deps(broken), continuity)).wrote).toBe(0);

    const moved = baseState();
    moved.wethSqrt = (SQRT_2400 * 11n) / 10n; // WETH +21%: re-prices, no residual
    expect((await collectOnce(deps(moved), continuity)).wrote).toBe(1);
  });
});

describe('collectOnce subrequest budget (Workers Free: 50 per invocation)', () => {
  // 15 vaults on one chain, like 4663 today. The per-vault reader spent 72 subrequests on the real
  // chain; the chain-wide multicall rounds must stay at a constant handful regardless of vault count.
  const twins = Array.from({ length: 14 }, (_, i) => `0x00000000000000000000000000000000000001${(i + 16).toString(16)}` as Address);
  const MANY: DeployedChain = {
    ...CHAIN,
    vaults: [VAULT, ...twins].map((vault, i) => ({ ...CHAIN.vaults[0]!, key: `v${i}`, vault })),
  };

  it('a full 15-vault cycle needs ≤ 10 subrequests and writes every row', async () => {
    const counter: Counter = { subrequests: 0 };
    const s = { ...baseState(), twins };
    const { lines } = await collectOnce({ chains: [MANY], clientFor: () => fakeClient(s, counter) });
    expect(lines).toHaveLength(15);
    expect(counter.subrequests).toBeLessThanOrEqual(10);
    expect(counter.subrequests).toBe(6); // tokens, meta, routes, pools, vault state, fees
  });

  it('a failing vault read rejects only that vault (per-leg allowFailure, not the whole round)', async () => {
    const s = { ...baseState(), twins, totalsRevert: [twins[3]!] };
    const { lines } = await collectOnce({ chains: [MANY], clientFor: () => fakeClient(s) });
    const keys = lines.map((l) => JSON.parse(l).vaultKey);
    expect(keys).toHaveLength(14);
    expect(keys).not.toContain('v4');
  });
});

describe('assembleRow (pure, from prefetched reads)', () => {
  const prices: ChainPrices = {
    anchor: USDG,
    anchorDecimals: 6,
    prices: new Map([[WETH, { priceUsd: 2400, tokenIsToken0: true, pool: POOL }]]),
    symbols: new Map([[USDG, 'USDG'], [WETH, 'WETH']]),
    decimals: new Map([[USDG, 6], [WETH, 18]]),
  };
  const reads = (): VaultReads => ({
    supply: { ok: true, value: 200n * 10n ** 18n },
    totals: { ok: true, value: [[USDG, WETH], [100_000_000n, 50_000_000_000_000_000n]] },
    adapters: { ok: true, value: [AD1, AD3] },
    performanceFeeBps: 1000,
  });
  const fees: AdapterFees = new Map([
    [AD1, [[USDG, WETH], [1_500_000n, 1_000_000_000_000_000n]] as const],
    [AD3, undefined],
  ]);
  const v = CHAIN.vaults[0]!;

  it('builds the row from the reads (ts passed through, a missing fees() contributes nothing)', () => {
    const row = assembleRow(CHAIN, prices, v, reads(), fees, '2026-10-28T00:00:00.000Z');
    expect(row.ts).toBe('2026-10-28T00:00:00.000Z');
    expect(row.tvlUsd).toBeCloseTo(100 + 0.05 * 2400, 9);
    expect(row.feesUsd).toBeCloseTo(1.5 + 0.001 * 2400, 9);
    expect(row.adapterCount).toBe(2);
    expect(row.performanceFeeBps).toBe(1000);
  });

  it('a failed state read or a missing spot throws (the caller logs and skips the vault)', () => {
    const r = reads();
    r.totals = { ok: false, error: new Error('execution reverted') };
    expect(() => assembleRow(CHAIN, prices, v, r, fees, '')).toThrow('execution reverted');
    const noWeth = { ...prices, prices: new Map() };
    expect(() => assembleRow(CHAIN, noWeth, v, reads(), fees, '')).toThrow(/spot price miss .* — snapshot rejected/);
  });

  it('a null performanceFeeBps read keeps the row with a null column', () => {
    const r = reads();
    r.performanceFeeBps = null;
    expect(assembleRow(CHAIN, prices, v, r, fees, '').performanceFeeBps).toBeNull();
  });
});

describe('runCycle (KV read-modify-write)', () => {
  function memBlob(initial: string | null) {
    const state = { value: initial, writes: 0 };
    return {
      state,
      io: {
        read: async () => state.value,
        write: async (t: string) => {
          state.value = t;
          state.writes++;
        },
      },
    };
  }

  it('first run creates the blob with one row', async () => {
    const { state, io } = memBlob(null);
    const r = await runCycle(io, deps(baseState()));
    expect(r).toMatchObject({ dropped: 0, wrote: 1, stored: true });
    expect(state.value!.split('\n').filter(Boolean)).toHaveLength(1);
    expect(state.value!.endsWith('\n')).toBe(true);
  });

  it('appends to the existing blob, and the stored rows seed the jump guard', async () => {
    const { state, io } = memBlob(null);
    await runCycle(io, deps(baseState()));
    await runCycle(io, deps(baseState()));
    expect(state.value!.split('\n').filter(Boolean)).toHaveLength(2);

    const broken = baseState();
    broken.totals = [[USDG, WETH], [10_000_000n, 50_000_000_000_000_000n]];
    const r = await runCycle(io, deps(broken));
    expect(r).toMatchObject({ wrote: 0, stored: false });
    expect(state.writes).toBe(2);
  });

  it('sweeps broken stored rows (full rewrite) and appends in the same single write', async () => {
    const bad = JSON.stringify({ chainId: 4663, vaultKey: 'main', navUsd: null, tokens: [] });
    const { state, io } = memBlob(`${bad}\n`);
    const r = await runCycle(io, deps(baseState()));
    expect(r).toMatchObject({ dropped: 1, wrote: 1, stored: true });
    expect(state.writes).toBe(1);
    const rows = state.value!.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(rows).toHaveLength(1);
    expect(rows[0].vaultKey).toBe('main');
  });

  it('does not glue rows when the stored blob lacks a trailing newline', async () => {
    const { state, io } = memBlob(null);
    await runCycle(io, deps(baseState()));
    state.value = state.value!.trimEnd();
    await runCycle(io, deps(baseState()));
    expect(state.value!.split('\n').filter(Boolean).every((l) => JSON.parse(l).vaultKey === 'main')).toBe(true);
  });
});
