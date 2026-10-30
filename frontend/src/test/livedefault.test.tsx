// @vitest-environment jsdom
/**
 * Live data by default, original design, both chains (TASK-LIVE-DEFAULT-REVISE, docs/LIVE-DATA.md):
 *  - a local/dev build (vitest included) offers both registry chains (mainnet 4663 + the demo chain
 *    46630); 4663 is the default. A production build drops the demo chain — demochain-gate.test;
 *  - the vault page / Markets render chain reads (the live-vault view, mocked here at the
 *    hook boundary so the assertions do not depend on a node), and the Demo badge appears only on the
 *    illustrative blocks — never on a live number;
 *  - the vault page mounts the original deposit card (real flow), resolves `<chainId>-<key>` and the
 *    classic `<key>` ids, and Markets' `?deposit=` opens the same card as an overlay.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { Address } from 'viem';
import { CHAINS as REGISTRY_CHAINS, DEPLOYMENTS as REGISTRY_DEPLOYMENTS } from '@/config/generated';
import { CHAINS, DEFAULT_CHAIN_ID, DEPLOYMENTS, defaultChainIds } from '@/chain/chains';
import { basketName, basketOrder, basketOrderIndices, displaySymbol, feeLabel, holdingUsd, navPerShareUsd, parseVaultRouteId, resolveVaultRouteId, tokenUsdPrices, vaultRouteId } from '@/chain/liveVaults';
import type { SpotPrice } from '@/chain/spot';
import type { LiveVault, UserBasket, ZapRoute, ZapRoutes } from '@/chain/useVault';
import { illustrativeNavSeries } from '@/demo/series';
import type { PriceBand } from '@/chain/ranges';
import type { LiveVaultRow } from '@/chain/useLiveVaults';
import type { CatalogVault } from '@/chain/useVaultCatalog';

/* Test-environment shim: recharts' ResponsiveContainer needs a ResizeObserver, which jsdom lacks. */
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const A = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;

describe('both chains in a local/dev build', () => {
  it('the app offers the whole registry — mainnet 4663 and the demo chain 46630 — and defaults to 4663', () => {
    expect(CHAINS.map((c) => c.chainId)).toEqual([4663, 46630]);
    expect(DEPLOYMENTS.map((d) => d.chainId)).toEqual([4663, 46630]);
    expect(CHAINS).toBe(REGISTRY_CHAINS);
    expect(DEPLOYMENTS).toBe(REGISTRY_DEPLOYMENTS);
    expect(DEFAULT_CHAIN_ID).toBe(4663);
    expect(defaultChainIds(CHAINS)).toEqual({ chainId: 4663, deploymentChainId: 4663 });
  });

  it('one build gate: chains.ts reads only import.meta.env.DEV — no VITE_LOCAL_STACK switch exists', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/chain/chains.ts'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code.match(/import\.meta[\w.?]*/g)).toEqual(['import.meta.env']); // demoChainEnabled's default (reads .DEV)
    expect(code).not.toMatch(/VITE_/);
    expect(src).not.toMatch(/VITE_LOCAL_STACK|localStackEnabled/);
    expect(readFileSync(resolve(process.cwd(), 'src/vite-env.d.ts'), 'utf8')).not.toMatch(/VITE_LOCAL_STACK/);
  });

  it('no /live or /live-earn route, page or link survives', () => {
    const app = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');
    expect(app).not.toMatch(/['"]\/live/);
    expect(app).not.toMatch(/LiveVault|LiveEarn/);
    for (const f of ['src/components/layout/Header.tsx', 'src/components/layout/Layout.tsx', 'src/components/layout/WalletButton.tsx', 'src/pages/Markets.tsx', 'src/pages/VaultDetail.tsx']) {
      expect(readFileSync(resolve(process.cwd(), f), 'utf8'), f).not.toMatch(/['"`]\/live/);
    }
  });
});

describe('live-vault helpers', () => {
  it('route ids round-trip; old demo ids do not parse', () => {
    expect(vaultRouteId(4663, 'tri')).toBe('4663-tri');
    expect(parseVaultRouteId('4663-tri')).toEqual({ chainId: 4663, key: 'tri' });
    expect(parseVaultRouteId('eth-usdg')).toBeUndefined();
    expect(parseVaultRouteId(undefined)).toBeUndefined();
  });

  it('resolveVaultRouteId: <chainId>-<key>, and a classic <key> when exactly one chain lists it', () => {
    const reg = [
      { chainId: 4663, vaults: [{ key: 'main' }, { key: 'pons' }] },
      { chainId: 46630, vaults: [{ key: 'demo' }, { key: 'pons' }] },
    ];
    expect(resolveVaultRouteId('4663-pons', reg)).toEqual({ kind: 'found', ref: { chainId: 4663, key: 'pons' } });
    expect(resolveVaultRouteId('main', reg)).toEqual({ kind: 'found', ref: { chainId: 4663, key: 'main' } });
    expect(resolveVaultRouteId('demo', reg)).toEqual({ kind: 'found', ref: { chainId: 46630, key: 'demo' } });
    expect(resolveVaultRouteId('pons', reg)).toEqual({
      kind: 'ambiguous',
      matches: [{ chainId: 4663, key: 'pons' }, { chainId: 46630, key: 'pons' }],
    });
    expect(resolveVaultRouteId('4663-demo', reg)).toEqual({ kind: 'missing' });
    expect(resolveVaultRouteId('eth-usdg', reg)).toEqual({ kind: 'missing' });
    expect(resolveVaultRouteId(undefined, reg)).toEqual({ kind: 'missing' });
    // The real registry: a classic id that names one vault resolves to the same vault as the full id.
    expect(resolveVaultRouteId('main', REGISTRY_DEPLOYMENTS)).toEqual(resolveVaultRouteId('4663-main', REGISTRY_DEPLOYMENTS));
    expect(resolveVaultRouteId('demo', REGISTRY_DEPLOYMENTS)).toEqual(resolveVaultRouteId('46630-demo', REGISTRY_DEPLOYMENTS));
  });

  it('tokenUsdPrices: USDG at its peg, others at their live spot, unpriced tokens absent', () => {
    const prices = tokenUsdPrices(
      [
        { address: USDG, symbol: 'USDG', decimals: 6 },
        { address: WETH, symbol: 'WETH', decimals: 18 },
        { address: A(0xa3), symbol: 'PONS', decimals: 18 },
      ],
      SPOTS,
    );
    expect(prices.get(USDG.toLowerCase())).toBe(1);
    expect(prices.get(WETH.toLowerCase())).toBeCloseTo(2500, 6);
    expect(prices.has(A(0xa3).toLowerCase())).toBe(false);
  });

  it('spot NAV = TVL / supply; undefined without supply or price (never a made-up 1.00)', () => {
    expect(navPerShareUsd(2_000, 1_000n * 10n ** 18n, 18)).toBe(2);
    expect(navPerShareUsd(2_000, 0n, 18)).toBeUndefined();
    expect(navPerShareUsd(undefined, 10n ** 18n, 18)).toBeUndefined();
    expect(navPerShareUsd(2_000, undefined, 18)).toBeUndefined();
    expect(holdingUsd(25n, 100n, 2_000)).toBe(500);
    expect(holdingUsd(25n, 0n, 2_000)).toBeUndefined();
  });

  it('basket names put the anchor last; fee labels', () => {
    // WETH goes by ETH in names
    expect(basketName(['USDG', 'WETH'], 'x')).toBe('ETH / USDG');
    expect(basketName(['USDG', 'WETH', 'PONS'], 'x')).toBe('ETH / PONS / USDG');
    // until the symbols land, the registry label reads the same way — no jump when they arrive
    expect(basketName([], 'USDG / WETH basket (Robinhood Chain)')).toBe(basketName(['USDG', 'WETH'], 'x'));
    expect(basketName([], 'USDG / WETH / PONS basket (RHC fork - 3 real Uniswap v4 pools)')).toBe('ETH / PONS / USDG');
    // a label that is not a symbol list only loses its parenthetical (its symbols still go by their display names)
    expect(basketName([], 'Stock-pair basket (5 stocks + mUSDG)')).toBe('Stock-pair basket');
    expect(basketName([], 'WETH vault')).toBe('ETH vault');
    expect(displaySymbol('WETH')).toBe('ETH');
    expect(displaySymbol('PONS')).toBe('PONS');
    // icon rows take the same order as the name; on-chain symbols kept
    expect(basketOrder(['USDG', 'WETH', 'PONS'])).toEqual(['WETH', 'PONS', 'USDG']);
    expect(basketOrder(['WETH', 'PONS'])).toEqual(['WETH', 'PONS']);
    // by index: a symbol listed twice still yields every token once (no duplicate legs / keys)
    expect(basketOrderIndices([{ symbol: 'USDG' }, { symbol: 'WETH' }, { symbol: 'PONS' }])).toEqual([1, 2, 0]);
    expect(basketOrderIndices([{ symbol: 'XYZ' }, { symbol: 'USDG' }, { symbol: 'XYZ' }])).toEqual([0, 2, 1]);
    expect(basketOrder(['USDG', 'USDG', 'WETH'])).toEqual(['WETH', 'USDG', 'USDG']);
    // whole percents drop the decimals
    expect(feeLabel(1000)).toBe('10%');
    expect(feeLabel(1250)).toBe('12.50%');
    expect(feeLabel(undefined)).toBe('—');
  });

  it('the illustrative NAV line ends on the live spot NAV', () => {
    const s = illustrativeNavSeries('4663-main', 1.2345);
    expect(s).toHaveLength(30);
    expect(s[s.length - 1].tdlp).toBeCloseTo(1.2345, 10);
  });
});

/* ---------- pages over a mocked live-vault view ---------- */

const ENTRY = REGISTRY_DEPLOYMENTS.find((d) => d.chainId === 4663)!.vaults[0];
const USDG = A(0xa1);
const WETH = A(0xa2);
/** WETH = token0 of a WETH/USDG pool at 2,500 USDG: sqrt(2500e6 / 1e18) × 2^96. */
const WETH_SPOT: SpotPrice = { token: WETH, anchor: USDG, pool: A(0xb1), fee: 500, sqrtPriceX96: 3961408125713216879677197n, tokenIsToken0: true };
const SPOTS = new Map([[WETH.toLowerCase(), WETH_SPOT]]);

function fixtureRow(): LiveVaultRow {
  const v: CatalogVault = {
    chainId: 4663,
    chainName: 'Robinhood Chain',
    isLocal: false,
    entry: ENTRY,
    address: ENTRY.vault,
    decimals: 18,
    tokens: [
      { address: USDG, symbol: 'USDG', decimals: 6, total: 1_000_000_000n, balance: undefined },
      { address: WETH, symbol: 'WETH', decimals: 18, total: 4n * 10n ** 17n, balance: undefined },
    ],
    supply: 1_000n * 10n ** 18n,
    paused: false,
    receiptBalance: undefined,
    performanceFeeBps: 1000,
    maxTotalSupply: 0n,
    keeperConfirmed: true,
    ready: true,
    failed: false,
    isLoading: false,
  };
  return {
    id: vaultRouteId(4663, ENTRY.key),
    v,
    valuation: { usd: 2_000, legs: [{ usd: 1_000, share: 0.5 }, { usd: 1_000, share: 0.5 }], unpriced: [] },
    nav: 2,
    spotsLoading: false,
  };
}

/**
 * The vault's real range bands (useVaultRanges reads adapters → positionState / TOKEN0 / TOKEN1; the
 * band math has its own suite in ranges.test.ts). Mutable so a test can drop the band.
 */
let BANDS: ReadonlyMap<string, PriceBand> = new Map();
const WETH_BAND: PriceBand = { lower: 2_210, upper: 2_610 };
vi.mock('@/chain/useVaultRanges', () => ({ useVaultRanges: () => ({ bands: BANDS, isLoading: false }) }));

vi.mock('@/chain/useLiveVaults', async (orig) => {
  const actual = await orig<typeof import('@/chain/useLiveVaults')>();
  return {
    ...actual,
    useLiveVaults: () => ({ rows: [fixtureRow()], spotsFor: () => ({ spots: SPOTS, isLoading: false }) }),
  };
});

/** The card's own vault read (useLiveVaultAt) and the wallet basket, mocked the same way. */
function fixtureVault(): LiveVault {
  return {
    address: ENTRY.vault,
    chainId: 4663,
    deployment: REGISTRY_DEPLOYMENTS.find((d) => d.chainId === 4663),
    entry: ENTRY,
    hasDeployment: true,
    receipt: ENTRY.receipt,
    decimals: 18,
    tokens: [
      { address: USDG, symbol: 'USDG', decimals: 6 },
      { address: WETH, symbol: 'WETH', decimals: 18 },
    ],
    totals: [1_000_000_000n, 4n * 10n ** 17n],
    idle: [0n, 0n],
    inPosition: [1_000_000_000n, 4n * 10n ** 17n],
    totalSupply: 1_000n * 10n ** 18n,
    performanceFeeBps: 1000,
    paused: false,
    adapters: [],
    isLoading: false,
    error: null,
    refetch: () => {},
  };
}
const NO_USER: UserBasket = { shares: 0n, owed: [0n, 0n], balances: [0n, 0n], allowances: [0n, 0n], isLoading: false, refetch: () => {} };
/** The wallet basket the card sees; a test may give it balances. */
let USER: UserBasket = NO_USER;

/** The zap probe: no route confirmed for the fixture vault, so the zap keys stay unpickable. In flight by default; a test settles it (or serves a route). */
const PROBING: ZapRoutes = { zapIn: [], zapInStatus: 'probing', zapOutStatus: 'probing' };
const NOT_SERVED: ZapRoutes = { zapIn: [], zapInStatus: 'not-served', zapOutStatus: 'not-served' };
let ZAP_PROBE: ZapRoutes = PROBING;
const USDG_ROUTE: ZapRoute = { zap: A(0xd1), token: { address: USDG, symbol: 'USDG', decimals: 6 }, index: 0, maxLegSlippageBps: 50 };
const WETH_ROUTE: ZapRoute = { zap: A(0xd1), token: { address: WETH, symbol: 'WETH', decimals: 18 }, index: 1, maxLegSlippageBps: 30 };
/** USDG alone serves (the local stack today) / USDG and WETH both have a full route set. */
const SERVED_USDG: ZapRoutes = { zapIn: [USDG_ROUTE], zapOut: USDG_ROUTE, zapInStatus: 'served', zapOutStatus: 'served' };
const SERVED_BOTH: ZapRoutes = { ...SERVED_USDG, zapIn: [USDG_ROUTE, WETH_ROUTE] };
/** No preview leaves the test process (the in-kind preview is a chain read). */
const IDLE_PREVIEW = { shares: undefined, required: undefined, error: null, isLoading: false, refetch: () => {} };
/** The in-kind withdraw preview (a chain read too); a test may serve the owed amounts. */
let REDEEM_PREVIEW: { owed?: bigint[]; error: null; isLoading: boolean } = { owed: undefined, error: null, isLoading: false };
/** The zap-in quote (a chain read): what the last `usePreviewZap` call asked for, and a quote once there is an amount. */
let ZAP_QUOTED: { tokenIn?: Address; amountIn?: bigint } = {};
const zapPreview = (_v: unknown, _zap: unknown, tokenIn: Address | undefined, amountIn: bigint) => {
  ZAP_QUOTED = { tokenIn, amountIn };
  return { tokens: undefined, offers: undefined, shares: amountIn > 0n ? 10n ** 18n : undefined, refunds: undefined, error: null, isLoading: false, refetch: () => {} };
};
vi.mock('@/chain/useVault', async (orig) => {
  const actual = await orig<typeof import('@/chain/useVault')>();
  return {
    ...actual,
    useLiveVaultAt: () => fixtureVault(),
    useUserBasket: () => USER,
    useZapRoutes: () => ZAP_PROBE,
    usePreviewDeposit: () => IDLE_PREVIEW,
    usePreviewRedeem: () => REDEEM_PREVIEW,
    usePreviewZap: zapPreview,
    useZapAllowance: () => ({ allowance: 0n, refetch: () => {} }),
  };
});
/** The wallet's write: records what a test's approve / deposit would sign. */
const WRITES: { address: Address; functionName: string; args: readonly unknown[] }[] = [];


// Imported after vi.mock (hoisted) so the pages see the fixture.
const { ChainProviders } = await import('@/chain/Providers');
const { VaultDetail } = await import('@/pages/VaultDetail');
const { Markets } = await import('@/pages/Markets');
const { WalletContext, useWallet } = await import('@/wallet/context');

/** Overrides the provider's wallet with a connected account (the fixture holds no receipt tokens). */
function Connected({ children, chainId }: { children: ReactNode; chainId?: number }) {
  const wallet = useWallet();
  const write = (async (req: { address: Address; functionName: string; args: readonly unknown[] }) => {
    WRITES.push({ address: req.address, functionName: req.functionName, args: req.args });
    throw new Error('test wallet: not sent');
  }) as unknown as typeof wallet.write;
  return <WalletContext.Provider value={{ ...wallet, status: 'connected', address: A(0xc0), write, ...(chainId === undefined ? {} : { chainId }) }}>{children}</WalletContext.Provider>;
}

function renderAt(path: string | string[], { connected = false, chainId }: { connected?: boolean; chainId?: number } = {}) {
  const entries = Array.isArray(path) ? path : [path];
  const routes = (
    <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
      <Routes>
        <Route path="/vault/:id" element={<VaultDetail />} />
        <Route path="/" element={<Markets />} />
      </Routes>
    </MemoryRouter>
  );
  return render(<ChainProviders>{connected ? <Connected chainId={chainId}>{routes}</Connected> : routes}</ChainProviders>);
}

beforeEach(() => {
  BANDS = new Map([[WETH.toLowerCase(), WETH_BAND]]);
  ZAP_PROBE = PROBING;
  ZAP_QUOTED = {};
  WRITES.length = 0;
  USER = NO_USER;
  REDEEM_PREVIEW = { owed: undefined, error: null, isLoading: false };
});
afterEach(cleanup);

/** Every Demo-style badge on screen (DemoBadge renders its label; "Illustrative" is the honest one). */
const demoBadges = () => screen.queryAllByText(/^(Demo( data)?|Illustrative)$/i);

describe('vault page — live figures, the original deposit card, only the chart line badged', () => {
  it('stats and basket come from the live view; old demo ids are not found', () => {
    renderAt(`/vault/4663-${ENTRY.key}`);
    expect(screen.getByRole('heading', { level: 1, name: 'ETH / USDG' })).toBeDefined();
    expect(screen.getAllByText('$2,000.00').length).toBeGreaterThan(0);
    expect(screen.queryByText('Supply')).toBeNull();
    cleanup();
    renderAt('/vault/eth-usdg');
    expect(screen.getByText(/Vault not found/)).toBeDefined();
  });

  it("the basket's bar, legend and table read in the name's order, the anchor last", () => {
    renderAt(`/vault/4663-${ENTRY.key}`);
    const basket = screen.getByRole('heading', { name: 'Basket' }).closest('section') as HTMLElement;
    // on chain the basket is USDG, WETH; the page reads ETH / USDG
    expect(within(basket).getAllByRole('listitem').map((li) => li.textContent?.split(' ')[0])).toEqual(['ETH', 'USDG']);
    expect([...basket.querySelectorAll('tbody tr')].map((tr) => tr.firstElementChild?.textContent?.match(/^[A-Z]+/)?.[0])).toEqual(['ETH', 'USDG']);
  });

  it('the classic /vault/<key> id opens the same vault; a key on two chains asks which', () => {
    renderAt(`/vault/${ENTRY.key}`);
    expect(screen.getByRole('heading', { level: 1, name: 'ETH / USDG' })).toBeDefined();
    cleanup();
    renderAt('/vault/pons');
    const links = screen.getAllByRole('link').map((l) => l.getAttribute('href'));
    expect(links).toEqual(['/vault/4663-pons', '/vault/46630-pons']);
  });

  it('mounts the deposit / withdraw card, connect-first, on live figures — no simulation', () => {
    renderAt(`/vault/4663-${ENTRY.key}`);
    expect(screen.getByRole('tab', { name: 'Deposit' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Withdraw' })).toBeDefined();
    // USDG only is the default; in kind is one click away.
    expect(screen.getByRole('button', { name: 'USDG' }).getAttribute('aria-pressed')).toBe('true');
    act(() => screen.getByRole('button', { name: 'Both' }).click());
    // One amount box per basket token, read from the chain view; the CTA opens the wallet picker.
    expect(screen.getByLabelText('USDG amount')).toBeDefined();
    expect(screen.getByLabelText('WETH amount')).toBeDefined();
    expect(screen.getAllByRole('button', { name: 'Connect wallet' }).length).toBeGreaterThan(0);
    // The Details fold opens on the live price per receipt token, not a prototype price per share.
    act(() => screen.getByRole('button', { name: /Details/ }).click());
    expect(screen.getByText(`$2.00 per ${ENTRY.receipt.symbol}`)).toBeDefined();
  });

  it('until the zap route is confirmed, the card holds the USDG form with nothing to type into', () => {
    renderAt(`/vault/4663-${ENTRY.key}`);
    const usdg = screen.getByRole('button', { name: 'USDG' }) as HTMLButtonElement;
    expect(usdg.getAttribute('aria-pressed')).toBe('true');
    expect(usdg.disabled).toBe(true);
    expect((screen.getByLabelText('USDG amount') as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByLabelText('WETH amount')).toBeNull();
    expect(screen.getByRole('button', { name: /Checking the USDG route/ })).toBeDefined();
  });

  it('once the probe settles with no route (e.g. a basket without USDG), the card is in kind — never a forever "Checking"', () => {
    ZAP_PROBE = NOT_SERVED;
    renderAt(`/vault/4663-${ENTRY.key}`);
    expect((screen.getByRole('button', { name: 'USDG' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Both' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByLabelText('USDG amount')).toBeDefined();
    expect(screen.getByLabelText('WETH amount')).toBeDefined();
    expect(screen.queryByRole('button', { name: /Checking the USDG route/ })).toBeNull();
  });

  it('the price range draws the live spot between the on-chain band; only the illustrative chart line is badged', () => {
    renderAt(`/vault/4663-${ENTRY.key}`);
    const range = screen.getByRole('region', { name: 'Price range' });
    expect(within(range).getByRole('img', { name: /Price 2500\.0 USDG per ETH, between the lower bound 2210\.0 and the upper bound 2610\.0/ })).toBeDefined();
    expect(within(range).getByText('Live price · on-chain range')).toBeDefined();
    const readout = screen.getByTestId('nav-live');
    expect(within(readout).getByText('$2.00')).toBeDefined();
    // The fixture has no NAV history, so the chart line is illustrative and says so — the one badge on the page.
    expect(demoBadges()).toHaveLength(1);
  });

  it('a spot outside the band reads "Out of range"', () => {
    BANDS = new Map([[WETH.toLowerCase(), { lower: 2_600, upper: 2_900 }]]);
    renderAt(`/vault/4663-${ENTRY.key}`);
    const range = screen.getByRole('region', { name: 'Price range' });
    expect(within(range).getByText('Out of range')).toBeDefined();
  });

  it('no live position → no band → no price range drawing (never a fixed-width fallback)', () => {
    BANDS = new Map();
    renderAt(`/vault/4663-${ENTRY.key}`);
    expect(screen.queryByRole('region', { name: 'Price range' })).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'ETH / USDG' })).toBeDefined();
  });
});

describe('Markets — the deposit CTA and ?deposit= open the card over the page; the row opens the vault', () => {
  it('?deposit=<vault id> mounts the real card in an overlay, linked to the vault page', () => {
    renderAt(`/?deposit=4663-${ENTRY.key}`);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('tab', { name: 'Deposit' })).toBeDefined();
    expect(within(dialog).getByRole('link', { name: /View vault/ }).getAttribute('href')).toBe(`/vault/4663-${ENTRY.key}`);
    cleanup();
    renderAt(`/?deposit=${ENTRY.key}`);
    expect(screen.getByRole('dialog')).toBeDefined();
    cleanup();
    renderAt('/?deposit=eth-usdg');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it("a row's basket bar names each token's share in the name's order, the anchor last", () => {
    const { container } = renderAt('/');
    const row = container.querySelector(`li[data-vault="4663-${ENTRY.key}"]`) as HTMLElement;
    expect(within(row).getByText('$2,000.00')).toBeDefined();
    // on chain the basket is USDG, WETH; the row reads ETH / USDG
    expect(within(row).getAllByRole('listitem').map((li) => li.textContent?.split(' ')[0])).toEqual(['ETH', 'USDG']);
  });

  it('the sort button opens every order, the current one ticked; picking one closes the menu', async () => {
    renderAt('/');
    const button = screen.getByRole('button', { name: 'Sort: Total deposited, high to low' });
    await act(async () => button.click());
    const options = within(screen.getByRole('listbox', { name: 'Sort vaults' })).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual([
      'Total deposited, high to low✓',
      'Total deposited, low to high',
      'APR, high to low',
      'APR, low to high',
    ]);
    expect(options.map((o) => o.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false', 'false']);
    await act(async () => within(options[2]).getByRole('button').click());
    expect(screen.queryByRole('listbox', { name: 'Sort vaults' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Sort: APR, high to low' })).toBeDefined();
  });

  it('the Deposit button opens the deposit card over Markets, not the vault page', async () => {
    renderAt('/');
    await act(async () => screen.getByRole('button', { name: 'Deposit' }).click());
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('tab', { name: 'Deposit' })).toBeDefined();
    expect(screen.queryByRole('heading', { level: 1, name: 'ETH / USDG' })).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Vaults' })).toBeDefined();
  });

  it('a click on the row itself still opens the vault page', async () => {
    const { container } = renderAt('/');
    const row = container.querySelector(`li[data-vault="4663-${ENTRY.key}"]`) as HTMLElement;
    await act(async () => row.click());
    expect(screen.getByRole('heading', { level: 1, name: 'ETH / USDG' })).toBeDefined();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('hero: Connect wallet only without an address; connected with no holdings shows "Your deposits" at $0.00', () => {
    renderAt('/');
    expect(screen.getAllByRole('button', { name: 'Connect wallet' }).length).toBeGreaterThan(0);
    expect(screen.queryByText('Your deposits')).toBeNull();
    cleanup();
    render(
      <ChainProviders>
        <Connected>
          <MemoryRouter initialEntries={['/']}>
            <Routes>
              <Route path="/" element={<Markets />} />
            </Routes>
          </MemoryRouter>
        </Connected>
      </ChainProviders>,
    );
    expect(screen.queryAllByRole('button', { name: 'Connect wallet' })).toHaveLength(0);
    expect(screen.getByText('Your deposits')).toBeDefined();
    expect(screen.getByText('$0.00')).toBeDefined();
  });
});

describe('PR #9 completion — controls that must do their job end to end', () => {
  const isRed = (input: HTMLElement) => (input.closest('.well') as HTMLElement).className.includes('well-field-error');

  it('Max on the token held least fills the other at the mix without turning it red', async () => {
    ZAP_PROBE = NOT_SERVED;
    USER = { ...NO_USER, balances: [1_000_001n, 400_000_400_000_000n] };
    renderAt(`/vault/4663-${ENTRY.key}`, { connected: true });
    expect(screen.getByRole('button', { name: 'Both' }).getAttribute('aria-pressed')).toBe('true');
    const usdg = screen.getByLabelText('USDG amount') as HTMLInputElement;
    const weth = screen.getByLabelText('WETH amount') as HTMLInputElement;
    await act(async () => within(usdg.closest('.well') as HTMLElement).getByRole('button', { name: 'Max' }).click());
    expect(usdg.value).toBe('1.000001');
    expect(weth.value).toBe('0.0004000004');
    expect(isRed(usdg)).toBe(false);
    expect(isRed(weth)).toBe(false);
  });

  it('one rule for "short": a typed amount above the balance reds the field AND the button names it, before any preview', async () => {
    ZAP_PROBE = NOT_SERVED;
    USER = { ...NO_USER, balances: [10_000_000_000n, 10n ** 18n] };
    renderAt(`/vault/4663-${ENTRY.key}`, { connected: true, chainId: 4663 });
    const usdg = screen.getByLabelText('USDG amount') as HTMLInputElement;
    const weth = screen.getByLabelText('WETH amount') as HTMLInputElement;
    // 0.5 WETH fills 1,250 USDG at the mix: both covered
    await act(async () => fireEvent.change(weth, { target: { value: '0.5' } }));
    expect(isRed(weth)).toBe(false);
    expect(screen.queryByRole('button', { name: /^Insufficient/ })).toBeNull();
    // 2 WETH is more than the wallet's 1 WETH: the field is red and the button says so (no preview has landed)
    await act(async () => fireEvent.change(weth, { target: { value: '2' } }));
    expect(isRed(weth)).toBe(true);
    expect(isRed(usdg)).toBe(false);
    expect(screen.getByRole('button', { name: 'Insufficient WETH' })).toBeDefined();
  });

  it('Escape on the open pay-with menu closes the menu, not the deposit overlay; a second Escape closes the overlay', async () => {
    ZAP_PROBE = SERVED_BOTH;
    renderAt(`/?deposit=4663-${ENTRY.key}`);
    const dialog = screen.getByRole('dialog');
    await act(async () => within(dialog).getByRole('button', { name: 'Pay with USDG' }).click());
    expect(screen.getByRole('listbox', { name: 'Pay with' })).toBeDefined();
    await act(async () => fireEvent.keyDown(document.body, { key: 'Escape' }));
    expect(screen.queryByRole('listbox', { name: 'Pay with' })).toBeNull();
    expect(screen.getByRole('dialog')).toBeDefined();
    // outside press still closes it
    await act(async () => within(dialog).getByRole('button', { name: 'Pay with USDG' }).click());
    await act(async () => fireEvent.mouseDown(within(dialog).getByRole('tab', { name: 'Deposit' })));
    expect(screen.queryByRole('listbox', { name: 'Pay with' })).toBeNull();
    await act(async () => fireEvent.keyDown(document.body, { key: 'Escape' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('an open menu keeps Escape from every overlay underneath — window, document or element listeners', async () => {
    const heard: string[] = [];
    const onWindow = () => heard.push('window');
    const onDocument = () => heard.push('document');
    window.addEventListener('keydown', onWindow);
    document.addEventListener('keydown', onDocument);
    try {
      renderAt('/');
      await act(async () => screen.getByRole('button', { name: 'Sort: Total deposited, high to low' }).click());
      await act(async () => fireEvent.keyDown(document.body, { key: 'Escape' }));
      expect(screen.queryByRole('listbox', { name: 'Sort vaults' })).toBeNull();
      expect(heard).toEqual([]);
      // menu closed: Escape reaches the page again
      await act(async () => fireEvent.keyDown(document.body, { key: 'Escape' }));
      expect(heard).toEqual(['document', 'window']);
    } finally {
      window.removeEventListener('keydown', onWindow);
      document.removeEventListener('keydown', onDocument);
    }
  });

  it('withdraw never waits on the zap-out probe: in kind while it is in flight and once it settles with no route', async () => {
    for (const probe of [PROBING, NOT_SERVED]) {
      ZAP_PROBE = probe;
      renderAt(`/vault/4663-${ENTRY.key}`);
      await act(async () => screen.getByRole('tab', { name: 'Withdraw' }).click());
      expect(screen.getByRole('button', { name: 'Both' }).getAttribute('aria-pressed')).toBe('true');
      expect((screen.getByRole('button', { name: 'USDG' }) as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByLabelText(`${ENTRY.receipt.symbol} amount to withdraw`) as HTMLInputElement).disabled).toBe(false);
      expect(screen.queryByText(/Checking the USDG route/)).toBeNull();
      cleanup();
    }
  });

  it('a served zap-out makes the withdraw USDG key pickable', async () => {
    ZAP_PROBE = SERVED_USDG;
    renderAt(`/vault/4663-${ENTRY.key}`);
    await act(async () => screen.getByRole('tab', { name: 'Withdraw' }).click());
    await act(async () => screen.getByRole('button', { name: 'USDG' }).click());
    expect(screen.getByRole('button', { name: 'USDG' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText(/sold into USDG by the zap/)).toBeDefined();
  });

  it('a Markets row opens its vault from the keyboard; Enter on its Deposit button does not', async () => {
    const { container } = renderAt('/');
    const row = container.querySelector(`li[data-vault="4663-${ENTRY.key}"]`) as HTMLElement;
    expect(row.tabIndex).toBe(0);
    await act(async () => fireEvent.keyDown(within(row).getByRole('button', { name: 'Deposit' }), { key: 'Enter' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Vaults' })).toBeDefined();
    await act(async () => fireEvent.keyDown(row, { key: 'Enter' }));
    expect(screen.getByRole('heading', { level: 1, name: 'ETH / USDG' })).toBeDefined();
  });
});

describe('PR #9 polish — field order, overlay focus, one network block', () => {
  it('in-kind amount fields read in the basket order (USDG last) and still fill by chain index', async () => {
    ZAP_PROBE = NOT_SERVED;
    renderAt(`/vault/4663-${ENTRY.key}`);
    const fields = screen.getAllByRole('textbox').filter((e) => / amount$/.test(e.getAttribute('aria-label') ?? ''));
    expect(fields.map((e) => e.getAttribute('aria-label'))).toEqual(['WETH amount', 'USDG amount']);
    // the first field shown takes the focus, as the first field always did
    expect(document.activeElement).toBe(fields[0]);
    // typing into the first (WETH, chain index 1) sizes USDG at the vault's (T + 1) mix: 0.2 WETH → 500.000001 USDG
    // (exactly 500 would make USDG the binding leg — chain.test.ts › fillAtMix)
    await act(async () => fireEvent.change(fields[0], { target: { value: '0.2' } }));
    expect((screen.getByLabelText('USDG amount') as HTMLInputElement).value).toBe('500.000001');
    expect((screen.getByLabelText('WETH amount') as HTMLInputElement).value).toBe('0.2');
  });

  it("the withdraw Receive line lists the tokens in the basket order, each with its own amount", async () => {
    ZAP_PROBE = NOT_SERVED;
    USER = { ...NO_USER, shares: 10n ** 18n };
    REDEEM_PREVIEW = { owed: [2_000_000n, 3n * 10n ** 15n], error: null, isLoading: false }; // 2 USDG, 0.003 WETH
    renderAt(`/vault/4663-${ENTRY.key}`, { connected: true, chainId: 4663 });
    await act(async () => screen.getByRole('tab', { name: 'Withdraw' }).click());
    await act(async () => fireEvent.change(screen.getByLabelText(`${ENTRY.receipt.symbol} amount to withdraw`), { target: { value: '1' } }));
    expect(screen.getByText('0.003 WETH + 2 USDG')).toBeDefined();
  });

  it('the deposit overlay traps Tab, locks the page scroll, and returns focus to its opener on close', async () => {
    const { container } = renderAt('/');
    const opener = within(container.querySelector(`li[data-vault="4663-${ENTRY.key}"]`) as HTMLElement).getByRole('button', { name: 'Deposit' });
    opener.focus();
    await act(async () => opener.click());
    const dialog = screen.getByRole('dialog');
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.body.style.overflow).toBe('hidden');

    const items = [...dialog.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), summary')].filter((el) => !el.closest('details:not([open])') || el.tagName === 'SUMMARY');
    const first = items[0];
    const last = items[items.length - 1];
    expect(first.getAttribute('aria-label')).toBe('Close');
    last.focus();
    await act(async () => fireEvent.keyDown(last, { key: 'Tab' }));
    expect(document.activeElement).toBe(first);
    await act(async () => fireEvent.keyDown(first, { key: 'Tab', shiftKey: true }));
    expect(document.activeElement).toBe(last);
    // focus that escaped to the page is pulled back in
    opener.focus();
    await act(async () => fireEvent.keyDown(opener, { key: 'Tab' }));
    expect(document.activeElement).toBe(first);
    // a Tab between two inner stops is the browser's: untouched
    const mid = items[1];
    mid.focus();
    const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    await act(async () => void mid.dispatchEvent(ev));
    expect(ev.defaultPrevented).toBe(false);

    await act(async () => fireEvent.keyDown(document.body, { key: 'Escape' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.body.style.overflow).toBe('');
    expect(document.activeElement).toBe(opener);
  });

  it('the Close button also hands focus back to the opener and restores the scroll', async () => {
    const { container } = renderAt('/');
    const opener = within(container.querySelector(`li[data-vault="4663-${ENTRY.key}"]`) as HTMLElement).getByRole('button', { name: 'Deposit' });
    opener.focus();
    await act(async () => opener.click());
    // nothing in the pending card autofocuses: the overlay itself takes the focus
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
    expect(document.body.style.overflow).toBe('hidden');
    await act(async () => within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }).click());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.body.style.overflow).toBe('');
    expect(document.activeElement).toBe(opener);
  });

  it('wrong network: "Add the network by hand" shows once on the vault page and once in the Markets overlay', async () => {
    const MANUAL = 'Trouble switching? Add the network by hand';
    ZAP_PROBE = NOT_SERVED;
    renderAt(`/vault/4663-${ENTRY.key}`, { connected: true, chainId: 1 });
    // the page banner and the card's gate both offer the switch: the card's form (and footer) is up
    expect(screen.getAllByRole('button', { name: /^Switch to Robinhood Chain/ }).length).toBe(2);
    expect(screen.getAllByText(MANUAL)).toHaveLength(1);
    cleanup();
    renderAt(`/?deposit=4663-${ENTRY.key}`, { connected: true, chainId: 1 });
    expect(within(screen.getByRole('dialog')).getAllByText(MANUAL)).toHaveLength(1);
    expect(screen.getAllByText(MANUAL)).toHaveLength(1);
  });
});

describe('zap: pay with any basket coin', () => {
  const zapKey = () => screen.getAllByRole('button').find((b) => b.getAttribute('aria-pressed') !== null && b.title.endsWith('only, through the zap')) as HTMLButtonElement;

  it('one candidate: the pay-with token is a static label — no menu, no chevron', () => {
    ZAP_PROBE = SERVED_USDG;
    renderAt(`/vault/4663-${ENTRY.key}`);
    expect(screen.queryByRole('button', { name: 'Pay with USDG' })).toBeNull();
    const box = screen.getByLabelText('USDG amount').closest('.well') as HTMLElement;
    expect(within(box).getByText('USDG')).toBeDefined();
    expect(box.querySelector('svg path[d="M4 6l4 4 4-4"]')).toBeNull();
  });

  it('several candidates: the menu lists them, USDG (the default) first and picked', async () => {
    ZAP_PROBE = SERVED_BOTH;
    renderAt(`/vault/4663-${ENTRY.key}`);
    await act(async () => screen.getByRole('button', { name: 'Pay with USDG' }).click());
    const options = within(screen.getByRole('listbox', { name: 'Pay with' })).getAllByRole('option');
    expect(options.map((o) => o.textContent?.replace(/[✓\s]/g, ''))).toEqual(['USDG', 'WETH']);
    expect(options[0].getAttribute('aria-selected')).toBe('true');
  });

  it('arrow keys move through the menu (wrapping, Home / End); Enter picks', async () => {
    ZAP_PROBE = SERVED_BOTH;
    renderAt(`/vault/4663-${ENTRY.key}`);
    const trigger = screen.getByRole('button', { name: 'Pay with USDG' });
    trigger.focus();
    await act(async () => fireEvent.keyDown(trigger, { key: 'ArrowDown' }));
    const rows = () => within(screen.getByRole('listbox', { name: 'Pay with' })).getAllByRole('button');
    expect(document.activeElement).toBe(rows()[0]);
    await act(async () => fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowDown' }));
    expect(document.activeElement).toBe(rows()[1]);
    await act(async () => fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowDown' }));
    expect(document.activeElement).toBe(rows()[0]);
    await act(async () => fireEvent.keyDown(document.activeElement as Element, { key: 'End' }));
    expect(document.activeElement).toBe(rows()[1]);
    await act(async () => fireEvent.keyDown(document.activeElement as Element, { key: 'Home' }));
    expect(document.activeElement).toBe(rows()[0]);
    await act(async () => fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowUp' }));
    expect(document.activeElement).toBe(rows()[1]);
    // a native button: Enter / Space click it
    await act(async () => (document.activeElement as HTMLButtonElement).click());
    expect(screen.queryByRole('listbox', { name: 'Pay with' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Pay with WETH' }));
  });

  it('picking WETH makes it the deposit token: label, copy, quote, approve — all WETH', async () => {
    ZAP_PROBE = SERVED_BOTH;
    USER = { ...NO_USER, balances: [0n, 10n ** 18n] };
    renderAt(`/vault/4663-${ENTRY.key}`, { connected: true, chainId: 4663 });
    expect(screen.getByRole('button', { name: 'Enter a USDG amount' })).toBeDefined();
    await act(async () => screen.getByRole('button', { name: 'Pay with USDG' }).click());
    await act(async () => within(screen.getByRole('listbox', { name: 'Pay with' })).getByText('WETH').click());
    // the zap key names the pay-with token
    expect(zapKey().textContent).toBe('WETH');
    expect(zapKey().getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByLabelText('USDG amount')).toBeNull();
    const input = screen.getByLabelText('WETH amount') as HTMLInputElement;
    expect(screen.getByRole('button', { name: 'Enter a WETH amount' })).toBeDefined();
    // the wallet's WETH is the balance the box offers
    expect(within(input.closest('.well') as HTMLElement).getByText(/Balance 1/)).toBeDefined();
    await act(async () => fireEvent.change(input, { target: { value: '1' } }));
    expect(ZAP_QUOTED).toEqual({ tokenIn: WETH, amountIn: 10n ** 18n });
    const approve = screen.getByRole('button', { name: 'Approve WETH for the zap' });
    await act(async () => approve.click());
    // approve THAT token, to the zap, for exactly the offer
    expect(WRITES[0]).toEqual({ address: WETH, functionName: 'approve', args: [WETH_ROUTE.zap, 10n ** 18n] });
  });

  it('paying with WETH, the dust floor and the size warning follow its ≈ $ price (≈ $1 / ≈ $50,000), not whole tokens', async () => {
    ZAP_PROBE = SERVED_BOTH;
    renderAt(`/vault/4663-${ENTRY.key}`);
    await act(async () => screen.getByRole('button', { name: 'Pay with USDG' }).click());
    await act(async () => within(screen.getByRole('listbox', { name: 'Pay with' })).getByText('WETH').click());
    const input = screen.getByLabelText('WETH amount') as HTMLInputElement;
    // WETH at $2,500: $1 is 0.0004 WETH — 0.001 WETH is a valid zap (it was "Minimum 1 WETH" before)
    await act(async () => fireEvent.change(input, { target: { value: '0.001' } }));
    expect(screen.queryByText(/smaller zaps are dust/)).toBeNull();
    expect(ZAP_QUOTED).toEqual({ tokenIn: WETH, amountIn: 10n ** 15n });
    await act(async () => fireEvent.change(input, { target: { value: '0.0001' } }));
    expect(screen.getByText('Minimum 0.0004 WETH — smaller zaps are dust')).toBeDefined();
    // 21 WETH ≈ $52,500: past the warning line (20 WETH), far below 50,000 WETH
    await act(async () => fireEvent.change(input, { target: { value: '21' } }));
    expect(screen.getByText(/Large zap: above about \$50,000/)).toBeDefined();
    await act(async () => fireEvent.change(input, { target: { value: '19' } }));
    expect(screen.queryByText(/Large zap/)).toBeNull();
  });

  it('the pick survives the candidate list re-forming on a poll', async () => {
    ZAP_PROBE = SERVED_BOTH;
    const view = renderAt(`/vault/4663-${ENTRY.key}`);
    await act(async () => screen.getByRole('button', { name: 'Pay with USDG' }).click());
    await act(async () => within(screen.getByRole('listbox', { name: 'Pay with' })).getByText('WETH').click());
    await act(async () => fireEvent.change(screen.getByLabelText('WETH amount'), { target: { value: '2' } }));
    // a new poll: fresh objects, same routes
    ZAP_PROBE = { ...SERVED_BOTH, zapIn: SERVED_BOTH.zapIn.map((r) => ({ ...r })) };
    view.rerender(<ChainProviders><MemoryRouter initialEntries={[`/vault/4663-${ENTRY.key}`]}><Routes><Route path="/vault/:id" element={<VaultDetail />} /></Routes></MemoryRouter></ChainProviders>);
    expect(screen.getByRole('button', { name: 'Pay with WETH' })).toBeDefined();
  });

  it('withdraw stays USDG only, whatever pays in', async () => {
    ZAP_PROBE = SERVED_BOTH;
    renderAt(`/vault/4663-${ENTRY.key}`);
    await act(async () => screen.getByRole('tab', { name: 'Withdraw' }).click());
    expect(screen.getByRole('button', { name: 'USDG' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'WETH' })).toBeNull();
  });
});

describe('Markets: closing the deposit overlay is idempotent', () => {
  it('a double close (backdrop + Close, or click + Escape) steps back once and stays on Markets', async () => {
    for (const second of ['close', 'escape'] as const) {
      renderAt([`/vault/4663-${ENTRY.key}`, '/']);
      const row = document.querySelector(`li[data-vault="4663-${ENTRY.key}"]`) as HTMLElement;
      await act(async () => within(row).getByRole('button', { name: 'Deposit' }).click());
      const dialog = screen.getByRole('dialog');
      // both land before the step back re-renders the page
      act(() => {
        (dialog.querySelector('.fixed.inset-0') as HTMLElement).click();
        if (second === 'close') within(dialog).getByRole('button', { name: 'Close' }).click();
        else window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      });
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.getByRole('heading', { level: 1, name: 'Vaults' })).toBeDefined();
      // and the overlay opens and closes again afterwards
      await act(async () => within(document.querySelector(`li[data-vault="4663-${ENTRY.key}"]`) as HTMLElement).getByRole('button', { name: 'Deposit' }).click());
      expect(screen.getByRole('dialog')).toBeDefined();
      await act(async () => within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }).click());
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.getByRole('heading', { level: 1, name: 'Vaults' })).toBeDefined();
      cleanup();
    }
  });
});
