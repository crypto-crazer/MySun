// @vitest-environment jsdom
/**
 * `useZapRoutes` against a mocked RPC (readMany) — TASK-ZAP-ANYCOIN:
 *  - the zap-in candidates are every basket token with a route to EVERY other one, USDG (the default) first;
 *    a basket without USDG has no facet and probes nothing (owner decision);
 *  - a real status: `probing` until the vault's tokens and the probe land (never a flash of "not served"),
 *    then `served` / `not-served`;
 *  - a confirmed route survives a transient failure in one poll (per call, or the whole batch) — only a
 *    successful read that says unregistered / zero route drops it; the card's form (typed amount, focus)
 *    is not remounted by such a poll.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { Address } from 'viem';
import { DEPLOYMENTS as REGISTRY_DEPLOYMENTS } from '@/config/generated';
import type { ContractCall, ReadResult } from '@/chain/client';
import { POLL_MS } from '@/chain/useReads';
import { shortHex } from '@/chain/amounts';
import type { LiveVault, TokenMeta, UserBasket } from '@/chain/useVault';

const readMany = vi.hoisted(() => vi.fn<(chainId: number, calls: readonly ContractCall[]) => Promise<ReadResult[]>>());
vi.mock('@/chain/client', async (orig) => ({ ...(await orig<typeof import('@/chain/client')>()), readMany }));

const { useLiveVaultAt, useZapRoutes } = await import('@/chain/useVault');
const { DepositCard } = await import('@/components/deposit/DepositCard');
const { ChainProviders } = await import('@/chain/Providers');

const A = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;
const ZERO = A(0);
const DEPLOYMENT = REGISTRY_DEPLOYMENTS.find((d) => d.chainId === 4663)!;
const ENTRY = DEPLOYMENT.vaults[0];
const USDG: TokenMeta = { address: A(0xa1), symbol: 'USDG', decimals: 6 };
const WETH: TokenMeta = { address: A(0xa2), symbol: 'WETH', decimals: 18 };
const PONS: TokenMeta = { address: A(0xa3), symbol: 'PONS', decimals: 18 };

function vaultOf(tokens: TokenMeta[], extra: Partial<LiveVault> = {}): LiveVault {
  return {
    address: ENTRY.vault,
    chainId: 4663,
    deployment: DEPLOYMENT,
    entry: ENTRY,
    hasDeployment: true,
    receipt: ENTRY.receipt,
    decimals: 18,
    tokens,
    totals: tokens.map(() => 10n ** 18n),
    idle: tokens.map(() => 0n),
    inPosition: tokens.map(() => 10n ** 18n),
    totalSupply: 10n ** 21n,
    performanceFeeBps: 1000,
    paused: false,
    adapters: [],
    isLoading: false,
    error: null,
    refetch: () => {},
    ...extra,
  };
}

/** The chain the mock answers from. `fail` = function names that reject in the next polls; `down` = every call. */
let registered = true;
let routes = new Set<string>();
let fail = new Set<string>();
let down = false;
/** The vault's basket as the chain lists it (`tokens()`, the ERC-20 reads). */
let basket: TokenMeta[] = [];
const route = (from: TokenMeta, to: TokenMeta) => `${from.address}>${to.address}`;

beforeEach(() => {
  vi.useFakeTimers();
  registered = true;
  routes = new Set();
  fail = new Set();
  down = false;
  basket = [USDG, WETH];
  readMany.mockReset();
  readMany.mockImplementation(async (_chainId, calls) => {
    if (down) throw new Error('fetch failed');
    return calls.map((c): ReadResult => {
      if (fail.has(c.functionName)) return { status: 'failure', error: new Error(`${c.functionName} timed out`) };
      switch (c.functionName) {
        case 'isVaultRegistered':
          return { status: 'success', result: registered };
        case 'routes': {
          const [from, to] = c.args as [Address, Address];
          const set = routes.has(`${from}>${to}`);
          return { status: 'success', result: [set ? A(0xb1) : ZERO, set ? 500 : 0, set ? 1800 : 0, set ? 40 : 0, set ? 100 : 0] };
        }
        case 'tokens':
          return { status: 'success', result: basket.map((t) => t.address) };
        case 'totalTokens':
          return { status: 'success', result: [basket.map((t) => t.address), basket.map(() => 10n ** 18n)] };
        case 'symbol': {
          const t = basket.find((x) => x.address === c.address);
          return t ? { status: 'success', result: t.symbol } : { status: 'failure', error: new Error('unmocked symbol') };
        }
        case 'decimals': {
          const t = basket.find((x) => x.address === c.address);
          return t ? { status: 'success', result: t.decimals } : { status: 'failure', error: new Error('unmocked decimals') };
        }
        case 'balanceOf':
          return { status: 'success', result: 0n };
        case 'previewZap':
          return { status: 'success', result: [[], [], 10n ** 18n, []] };
        case 'allowance':
          return { status: 'success', result: 0n };
        default:
          return { status: 'failure', error: new Error(`unmocked ${c.functionName}`) };
      }
    });
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** Let the in-flight reads land (react-query notifies on a 0 ms timer, which the fake clock must run too). */
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(0); await vi.advanceTimersByTimeAsync(0); });
const poll = async (ms = POLL_MS) => {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms + 1_000); });
  await settle();
};
const symbols = (r: { zapIn: { token: TokenMeta }[] }) => r.zapIn.map((c) => c.token.symbol);
const calledFns = () => readMany.mock.calls.flatMap(([, calls]) => calls.map((c) => c.functionName));

describe('useZapRoutes — candidates', () => {
  it('every token with a full route set is a candidate, USDG first (the default)', async () => {
    // registry order WETH, USDG, PONS; WETH and USDG route to both others, PONS only to USDG
    for (const [a, b] of [[WETH, USDG], [WETH, PONS], [USDG, WETH], [USDG, PONS], [PONS, USDG]]) routes.add(route(a, b));
    const { result } = renderHook(() => useZapRoutes(vaultOf([WETH, USDG, PONS])), { wrapper: wrapper() });
    await settle();
    expect(result.current.zapInStatus).toBe('served');
    expect(symbols(result.current)).toEqual(['USDG', 'WETH']);
    expect(result.current.zapIn.map((c) => c.index)).toEqual([1, 0]);
    expect(result.current.zapIn[0].maxLegSlippageBps).toBe(40);
  });

  it('only USDG with a full set (the local stack today): one candidate', async () => {
    routes.add(route(USDG, WETH));
    const { result } = renderHook(() => useZapRoutes(vaultOf([USDG, WETH])), { wrapper: wrapper() });
    await settle();
    expect(symbols(result.current)).toEqual(['USDG']);
  });

  it('a non-USDG token alone can serve; USDG then is no candidate', async () => {
    routes.add(route(WETH, USDG));
    const { result } = renderHook(() => useZapRoutes(vaultOf([USDG, WETH])), { wrapper: wrapper() });
    await settle();
    expect(result.current.zapInStatus).toBe('served');
    expect(symbols(result.current)).toEqual(['WETH']);
  });

  it('the zap-out stays → USDG: served only when every other token routes into USDG', async () => {
    routes.add(route(USDG, WETH));
    const { result } = renderHook(() => useZapRoutes(vaultOf([USDG, WETH])), { wrapper: wrapper() });
    await settle();
    expect(result.current.zapOutStatus).toBe('not-served');
    routes.add(route(WETH, USDG));
    await poll();
    expect(result.current.zapOutStatus).toBe('served');
    expect(result.current.zapOut?.token.symbol).toBe('USDG');
  });

  it('unregistered, or no complete set: not served', async () => {
    routes.add(route(USDG, WETH));
    registered = false;
    const { result } = renderHook(() => useZapRoutes(vaultOf([USDG, WETH])), { wrapper: wrapper() });
    await settle();
    expect(result.current.zapInStatus).toBe('not-served');
    expect(result.current.zapIn).toEqual([]);
  });

  it('a basket without USDG (SPY / NVDA) has no zap facet and probes nothing', async () => {
    const spy = { ...WETH, symbol: 'SPY' };
    const nvda = { ...PONS, symbol: 'NVDA' };
    routes.add(route(spy, nvda));
    routes.add(route(nvda, spy));
    const { result } = renderHook(() => useZapRoutes(vaultOf([spy, nvda])), { wrapper: wrapper() });
    await settle();
    expect(result.current.zapInStatus).toBe('idle');
    expect(result.current.zapOutStatus).toBe('idle');
    expect(calledFns()).toEqual([]);
  });
});

describe('useZapRoutes — status', () => {
  it('probing while the vault and its token symbols are still loading — never a flash of "not served"', async () => {
    routes.add(route(USDG, WETH));
    let vault = vaultOf([], { isLoading: true });
    const { result, rerender } = renderHook(() => useZapRoutes(vault), { wrapper: wrapper() });
    expect(result.current.zapInStatus).toBe('probing');
    // the addresses landed, their symbols not yet: the vault lists no tokens yet — still not resolved
    vault = vaultOf([], { isLoading: true });
    rerender();
    expect(result.current.zapInStatus).toBe('probing');
    vault = vaultOf([USDG, WETH]);
    rerender();
    expect(result.current.zapInStatus).toBe('probing'); // the probe is in flight
    await settle();
    expect(result.current.zapInStatus).toBe('served');
  });

  it('a probe that never succeeded is not served (in kind, never a forever "Checking")', async () => {
    down = true;
    const { result } = renderHook(() => useZapRoutes(vaultOf([USDG, WETH])), { wrapper: wrapper() });
    await settle();
    expect(result.current.zapInStatus).toBe('not-served');
  });

  it('no periphery on the chain: idle', () => {
    const { result } = renderHook(() => useZapRoutes(vaultOf([USDG, WETH], { deployment: { ...DEPLOYMENT, periphery: undefined } })), { wrapper: wrapper() });
    expect(result.current.zapInStatus).toBe('idle');
  });
});

describe('useZapRoutes — a confirmed route survives a transient poll failure', () => {
  it('one rejected isVaultRegistered / routes(), or the whole batch, keeps it; a successful "no" drops it', async () => {
    routes.add(route(USDG, WETH));
    routes.add(route(WETH, USDG));
    const { result } = renderHook(() => useZapRoutes(vaultOf([USDG, WETH])), { wrapper: wrapper() });
    await settle();
    expect(symbols(result.current)).toEqual(['USDG', 'WETH']);
    for (const f of ['isVaultRegistered', 'routes']) {
      fail = new Set([f]);
      await poll();
      expect(result.current.zapInStatus).toBe('served');
      expect(symbols(result.current)).toEqual(['USDG', 'WETH']);
      expect(result.current.zapOut).toBeDefined();
    }
    fail = new Set();
    down = true;
    await poll();
    expect(symbols(result.current)).toEqual(['USDG', 'WETH']);
    down = false;
    // the chain says WETH lost its route: only that drops it
    routes.delete(route(WETH, USDG));
    await poll(4 * POLL_MS);
    expect(symbols(result.current)).toEqual(['USDG']);
    registered = false;
    await poll();
    expect(result.current.zapInStatus).toBe('not-served');
  });

  it('a token symbol failing in one poll does not lose USDG', async () => {
    routes.add(route(USDG, WETH));
    let vault = vaultOf([USDG, WETH]);
    const { result, rerender } = renderHook(() => useZapRoutes(vault), { wrapper: wrapper() });
    await settle();
    expect(symbols(result.current)).toEqual(['USDG']);
    // useLiveVaultAt falls back to the short address when a symbol read fails: the route is still USDG's
    vault = vaultOf([{ ...USDG, symbol: shortHex(USDG.address) }, WETH]);
    rerender();
    expect(result.current.zapInStatus).toBe('served');
    expect(result.current.zapIn.map((c) => c.token.address)).toEqual([USDG.address]);
    expect(result.current.zapOutStatus).not.toBe('idle');
  });
});

describe('useLiveVaultAt — never a placeholder symbol; seeded from the catalogue row', () => {
  /** Every token symbol the hook ever handed out, render by render. */
  const seen: string[][] = [];
  const read = (seed?: Parameters<typeof useLiveVaultAt>[2]) => {
    const v = useLiveVaultAt(4663, ENTRY, seed);
    seen.push(v.tokens.map((t) => t.symbol));
    return { v, routes: useZapRoutes(v) };
  };
  const seed = (tokens: TokenMeta[]) => ({
    address: ENTRY.vault,
    ready: true,
    tokens: tokens.map((t) => ({ ...t, total: 10n ** 18n, balance: undefined })),
    supply: 10n ** 21n,
    paused: false,
    decimals: 18,
    performanceFeeBps: 1000,
  });
  const erc20Meta = () => readMany.mock.calls.flatMap(([, calls]) => calls.filter((c) => basket.some((t) => t.address === c.address) && (c.functionName === 'symbol' || c.functionName === 'decimals')));
  beforeEach(() => { seen.length = 0; routes.add(route(USDG, WETH)); });

  it('unseeded: no tokens until their symbols and decimals are read — never the short address as a symbol', async () => {
    const { result } = renderHook(() => read(), { wrapper: wrapper() });
    expect(result.current.v.tokens).toEqual([]);
    expect(result.current.routes.zapInStatus).toBe('probing');
    await settle();
    await settle();
    expect(result.current.v.tokens).toEqual([USDG, WETH]);
    await settle();
    expect(result.current.routes.zapInStatus).toBe('served');
    expect(seen.flat().some((s) => s.startsWith('0x'))).toBe(false);
  });

  it('a failed symbol() read is the only way to the short address (a non-standard token)', async () => {
    fail = new Set(['symbol']);
    const { result } = renderHook(() => read(), { wrapper: wrapper() });
    await settle();
    await settle();
    expect(result.current.v.tokens.map((t) => t.symbol)).toEqual([shortHex(USDG.address), shortHex(WETH.address)]);
  });

  it('seeded: the basket is there in the first frame, its metadata is not read again, and the zap probe starts at once', async () => {
    const { result } = renderHook(() => read(seed([USDG, WETH])), { wrapper: wrapper() });
    expect(result.current.v.tokens).toEqual([USDG, WETH]);
    expect(result.current.v.isLoading).toBe(false);
    expect(result.current.v.totals).toEqual([10n ** 18n, 10n ** 18n]);
    // the probe is in the first round, next to the vault's own reads
    expect(calledFns()).toContain('isVaultRegistered');
    await settle();
    await poll();
    expect(result.current.routes.zapInStatus).toBe('served');
    expect(erc20Meta()).toEqual([]);
  });

  it('a seed for another basket is ignored once the vault says otherwise', async () => {
    const { result } = renderHook(() => read(seed([USDG, PONS])), { wrapper: wrapper() });
    expect(result.current.v.tokens).toEqual([USDG, PONS]);
    await settle();
    await settle();
    expect(result.current.v.tokens).toEqual([USDG, WETH]);
    expect(erc20Meta().length).toBeGreaterThan(0);
  });
});

describe('the all-mock local stack names the route token mUSDG', () => {
  const mUSDG: TokenMeta = { address: A(0xa4), symbol: 'mUSDG', decimals: 6 };
  const mWETH: TokenMeta = { address: A(0xa5), symbol: 'mWETH', decimals: 18 };

  it('the probe finds it: served with mUSDG as the default', async () => {
    routes.add(route(mUSDG, mWETH));
    routes.add(route(mWETH, mUSDG));
    const { result } = renderHook(() => useZapRoutes(vaultOf([mUSDG, mWETH])), { wrapper: wrapper() });
    await settle();
    expect(result.current.zapInStatus).toBe('served');
    expect(symbols(result.current)).toEqual(['mUSDG', 'mWETH']);
    expect(result.current.zapOut?.token.symbol).toBe('mUSDG');
  });

  it('the card reaches a usable form: the pending shape names mUSDG, then the zap form takes an amount', async () => {
    routes.add(route(mUSDG, mWETH));
    const NO_USER: UserBasket = { shares: 0n, owed: [0n, 0n], balances: [0n, 0n], allowances: [0n, 0n], isLoading: false, refetch: () => {} };
    render(
      <ChainProviders>
        <MemoryRouter>
          <DepositCard vault={vaultOf([mUSDG, mWETH])} user={NO_USER} showVaultLink={false} />
        </MemoryRouter>
      </ChainProviders>,
    );
    expect(screen.getByRole('button', { name: /Checking the mUSDG route/ })).toBeDefined();
    await settle();
    expect((screen.getByLabelText('mUSDG amount') as HTMLInputElement).disabled).toBe(false);
    expect(screen.queryByRole('button', { name: /Checking/ })).toBeNull();
  });
});

describe('the deposit card across one failed poll mid-flow', () => {
  const NO_USER: UserBasket = { shares: 0n, owed: [0n, 0n], balances: [0n, 0n], allowances: [0n, 0n], isLoading: false, refetch: () => {} };

  it('keeps the zap form mounted: the typed amount, its focus and the slippage survive', async () => {
    routes.add(route(USDG, WETH));
    render(
      <ChainProviders>
        <MemoryRouter>
          <DepositCard vault={vaultOf([USDG, WETH])} user={NO_USER} showVaultLink={false} />
        </MemoryRouter>
      </ChainProviders>,
    );
    // in flight: the zap form's pending shape
    expect((screen.getByLabelText('USDG amount') as HTMLInputElement).disabled).toBe(true);
    await settle();
    const input = screen.getByLabelText('USDG amount') as HTMLInputElement;
    expect(input.disabled).toBe(false);
    await act(async () => fireEvent.change(input, { target: { value: '25' } }));
    await act(async () => screen.getByRole('button', { name: /Details/ }).click());
    await act(async () => fireEvent.change(screen.getByLabelText('Zap slippage tolerance in percent'), { target: { value: '0.1' } }));
    input.focus();

    fail = new Set(['isVaultRegistered']);
    await poll();
    expect(screen.getByLabelText('USDG amount')).toBe(input); // the same node: never remounted
    expect(input.value).toBe('25');
    expect(document.activeElement).toBe(input);
    expect((screen.getByLabelText('Zap slippage tolerance in percent') as HTMLInputElement).value).toBe('0.1');
    expect(screen.queryByRole('button', { name: /Checking the USDG route/ })).toBeNull();

    // a successful read that says unregistered: in kind
    fail = new Set();
    registered = false;
    await poll();
    expect(screen.getByRole('button', { name: 'Both' }).getAttribute('aria-pressed')).toBe('true');
  });
});
