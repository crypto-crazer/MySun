// @vitest-environment jsdom
/**
 * Live data by default, original design, both chains (TASK-LIVE-DEFAULT-REVISE, docs/LIVE-DATA.md):
 *  - every build offers both registry chains (mainnet 4663 + the demo chain 46630); 4663 is the default;
 *  - Analytics / the vault page / Markets render chain reads (the live-vault view, mocked here at the
 *    hook boundary so the assertions do not depend on a node), and the Demo badge appears only on the
 *    illustrative blocks — never on a live number;
 *  - the vault page mounts the original deposit card (real flow), resolves `<chainId>-<key>` and the
 *    classic `<key>` ids, and Markets' `?deposit=` opens the same card as an overlay.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { Address } from 'viem';
import { CHAINS as REGISTRY_CHAINS, DEPLOYMENTS as REGISTRY_DEPLOYMENTS } from '@/config/generated';
import { CHAINS, DEFAULT_CHAIN_ID, DEPLOYMENTS, defaultChainIds } from '@/chain/chains';
import { basketName, feeLabel, holdingUsd, navPerShareUsd, parseVaultRouteId, resolveVaultRouteId, tokenUsdPrices, vaultRouteId } from '@/chain/liveVaults';
import type { SpotPrice } from '@/chain/spot';
import type { LiveVault, UserBasket } from '@/chain/useVault';
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

describe('both chains in every build', () => {
  it('the app offers the whole registry — mainnet 4663 and the demo chain 46630 — and defaults to 4663', () => {
    expect(CHAINS.map((c) => c.chainId)).toEqual([4663, 46630]);
    expect(DEPLOYMENTS.map((d) => d.chainId)).toEqual([4663, 46630]);
    expect(CHAINS).toBe(REGISTRY_CHAINS);
    expect(DEPLOYMENTS).toBe(REGISTRY_DEPLOYMENTS);
    expect(DEFAULT_CHAIN_ID).toBe(4663);
    expect(defaultChainIds(CHAINS)).toEqual({ chainId: 4663, deploymentChainId: 4663 });
  });

  it('no build gate: chains.ts reads no Vite env, and no VITE_LOCAL_STACK switch exists', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/chain/chains.ts'), 'utf8');
    expect(src).not.toMatch(/import\.meta/);
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
    expect(basketName([], 'USDG / WETH basket (Robinhood Chain)')).toBe('USDG / ETH basket');
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
      { address: USDG, symbol: 'USDG', name: 'USDG', decimals: 6 },
      { address: WETH, symbol: 'WETH', name: 'Wrapped Ether', decimals: 18 },
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

/** The zap probe: by default it has answered that the zap does not serve the fixture vault. */
const ZAP_NOT_SERVED = { zapInPending: false, zapOutPending: false };
let ZAP_ROUTES: { zapInPending: boolean; zapOutPending: boolean } = ZAP_NOT_SERVED;
vi.mock('@/chain/useVault', async (orig) => {
  const actual = await orig<typeof import('@/chain/useVault')>();
  return { ...actual, useLiveVaultAt: () => fixtureVault(), useUserBasket: () => NO_USER, useZapRoutes: () => ZAP_ROUTES };
});


// Imported after vi.mock (hoisted) so the pages see the fixture.
const { ChainProviders } = await import('@/chain/Providers');
const { Analytics } = await import('@/pages/Analytics');
const { VaultDetail } = await import('@/pages/VaultDetail');
const { Markets } = await import('@/pages/Markets');

function renderAt(path: string) {
  return render(
    <ChainProviders>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/analytics" element={<Analytics />} />
          <Route path="/vault/:id" element={<VaultDetail />} />
          <Route path="/" element={<Markets />} />
        </Routes>
      </MemoryRouter>
    </ChainProviders>,
  );
}

beforeEach(() => {
  BANDS = new Map([[WETH.toLowerCase(), WETH_BAND]]);
  ZAP_ROUTES = ZAP_NOT_SERVED;
});
afterEach(cleanup);

/** Every Demo-style badge on screen (DemoBadge renders its label; "Illustrative" is the honest one). */
const demoBadges = () => screen.queryAllByText(/^(Demo( data)?|Illustrative)$/i);

describe('Analytics — the original design (PR #7), illustrative series', () => {
  it('renders the design: heading, window switch, the four metrics as tiles and charts, the stat row', async () => {
    renderAt('/analytics');
    expect(screen.getByRole('heading', { level: 1, name: 'Protocol analytics' })).toBeDefined();
    expect(screen.getByRole('tab', { name: 'This week' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: '8 weeks' })).toBeDefined();
    for (const label of ['Volume', 'Fees', 'Revenue', 'Buybacks']) {
      expect(screen.getByRole('heading', { level: 3, name: label })).toBeDefined(); // the BarCard
      expect(screen.getAllByText(label)).toHaveLength(2); // + the tile
    }
    expect(screen.getAllByText(/from prior week$/)).toHaveLength(4);
    expect(screen.getByText(/Revenue is the protocol's 10% share of fees plus zap swap fees/)).toBeDefined();
    for (const label of ['Emissions this week', 'Buyback coverage', 'Market cap']) expect(screen.getByText(label)).toBeDefined();
    // The 8-weeks window switches the tiles' sub line.
    await act(async () => screen.getByRole('tab', { name: '8 weeks' }).click());
    expect(screen.getAllByText('Last 8 weeks')).toHaveLength(4);
    expect(screen.queryByText(/from prior week$/)).toBeNull();
  });

  it("the subtitle names the header's chain; nothing beyond the design (no vaults table, no live tiles)", () => {
    const { container } = renderAt('/analytics');
    const mainnet = DEPLOYMENTS.find((d) => d.chainId === 4663)!.name;
    expect(screen.getByText(new RegExp(`vaults on ${mainnet}\\.$`))).toBeDefined();
    expect(container.querySelector('table')).toBeNull();
    expect(container.querySelector('tr[data-vault]')).toBeNull();
    for (const gone of ['Vaults', 'Total TVL', 'Basket tokens', 'Paused', 'Reward emissions vs buybacks']) expect(screen.queryByText(gone)).toBeNull();
  });

  it('the page carries the one Demo badge by its title — no live badge on illustrative numbers', () => {
    renderAt('/analytics');
    const badges = demoBadges();
    expect(badges.map((b) => b.textContent)).toEqual(['Demo data']);
    expect(within(badges[0].closest('section') as HTMLElement).getByRole('heading', { name: 'Protocol analytics' })).toBeDefined();
    expect(screen.queryByText('Live on-chain')).toBeNull();
  });
});

describe('vault page — live figures, the original deposit card, illustrative bits badged', () => {
  it('stats and basket come from the live view; old demo ids are not found', () => {
    renderAt(`/vault/4663-${ENTRY.key}`);
    expect(screen.getByRole('heading', { level: 1, name: 'ETH / USDG' })).toBeDefined();
    expect(screen.getAllByText('$2,000.00').length).toBeGreaterThan(0);
    expect(screen.queryByText('Supply')).toBeNull();
    cleanup();
    renderAt('/vault/eth-usdg');
    expect(screen.getByText(/Vault not found/)).toBeDefined();
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
    // USDG only is the default, but the zap does not serve this vault in the fixture: Both shows,
    // and no USDG key is offered.
    expect(screen.getByRole('button', { name: 'Both' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByRole('button', { name: 'USDG' })).toBeNull();
    // One amount box per basket token, read from the chain view; the CTA opens the wallet picker.
    expect(screen.getByLabelText('USDG amount')).toBeDefined();
    expect(screen.getByLabelText('WETH amount')).toBeDefined();
    expect(screen.getAllByRole('button', { name: 'Connect wallet' }).length).toBeGreaterThan(0);
    // The details line is the live spot NAV, not a prototype price per share.
    expect(screen.getByText(`1 ${ENTRY.receipt.symbol} = $2.00 · spot`)).toBeDefined();
  });

  it('while the zap route is being confirmed, the card holds the USDG form with nothing to type into', () => {
    ZAP_ROUTES = { zapInPending: true, zapOutPending: true };
    renderAt(`/vault/4663-${ENTRY.key}`);
    const usdg = screen.getByRole('button', { name: 'USDG' }) as HTMLButtonElement;
    expect(usdg.getAttribute('aria-pressed')).toBe('true');
    expect(usdg.disabled).toBe(true);
    expect((screen.getByLabelText('USDG amount') as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByLabelText('WETH amount')).toBeNull();
    expect(screen.getByRole('button', { name: /Checking the USDG route/ })).toBeDefined();
  });

  it('the price range draws the live spot between the on-chain band; nothing is badged for now', () => {
    renderAt(`/vault/4663-${ENTRY.key}`);
    const range = screen.getByRole('region', { name: 'Price range' });
    expect(within(range).getByRole('img', { name: /Price 2500\.0 USDG per ETH, between the lower bound 2210\.0 and the upper bound 2610\.0/ })).toBeDefined();
    expect(within(range).getByText('Live price · on-chain range')).toBeDefined();
    expect(within(range).queryByText(/^(Demo( data)?|Illustrative)$/i)).toBeNull();
    const readout = screen.getByTestId('nav-live');
    expect(within(readout).getByText('$2.00')).toBeDefined();
    expect(within(readout).queryByText(/^(Demo( data)?|Illustrative)$/i)).toBeNull();
    // The NAV chart line is still illustrative, but carries no badge for now.
    expect(demoBadges()).toEqual([]);
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

  it('each row carries its range meter: the live spot inside the on-chain band, no demo badge', () => {
    const { container } = renderAt('/');
    const row = container.querySelector(`li[data-vault="4663-${ENTRY.key}"]`) as HTMLElement;
    expect(within(row).getByRole('img', { name: 'Price 2500.0 inside the range 2210.0 to 2610.0' })).toBeDefined();
    expect(screen.queryByText(/Illustrative ranges/i)).toBeNull();
    expect(demoBadges()).toEqual([]);
  });

  it('a row without a live position shows no meter', () => {
    BANDS = new Map();
    const { container } = renderAt('/');
    const row = container.querySelector(`li[data-vault="4663-${ENTRY.key}"]`) as HTMLElement;
    expect(within(row).queryByRole('img', { name: /inside|outside the range/ })).toBeNull();
    expect(within(row).getByText('$2,000.00')).toBeDefined();
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
});
