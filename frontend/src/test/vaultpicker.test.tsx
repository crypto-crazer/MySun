// @vitest-environment jsdom
/**
 * The vault picker on /live, mounted for real (real providers, no wallet). The picker itself is
 * config-driven, so every assertion about it holds with or without a node; the assertions about the
 * page's chain-read content (basket symbols, the on-chain receipt symbol) are conditional on the
 * local node answering, exactly as in render.test / network.test.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ChainProviders } from '@/chain/Providers';
import { DEFAULT_CHAIN_ID, chainShortLabel, deploymentForChain, isForkDeployment, vaultsForChain } from '@/chain/chains';
import { VAULT_SELECTION_KEY } from '@/chain/vaultSelection';
import { Layout } from '@/components/layout/Layout';
import { LiveVault } from '@/pages/LiveVault';

/* Test-environment shims (see render.test / network.test for why). */
const JsdomRequest = globalThis.Request;
const jsdomFetch = globalThis.fetch;
const stripSignal = (init?: RequestInit) => (init ? { ...init, signal: undefined } : init);
class RequestWithoutSignal extends JsdomRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(input, stripSignal(init));
  }
}
globalThis.Request = RequestWithoutSignal as typeof Request;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => jsdomFetch(input, stripSignal(init))) as typeof fetch;
if (!window.localStorage) {
  const store = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size;
      },
    } satisfies Storage,
  });
}

const CHAIN = DEFAULT_CHAIN_ID;
const VAULTS = vaultsForChain(CHAIN);
const [DEMO, STOCKS] = VAULTS;
const radioName = (v: (typeof VAULTS)[number]) => `${v.label} (${v.receipt.symbol})`;
/** The RHC fork stack: the default (demo) basket is the REAL USDG / WETH; stocks stays mock. */
const FORK = isForkDeployment(deploymentForChain(CHAIN));
/** A basket token symbol: the mock stack's m-prefixed tokens, or the RHC fork's REAL USDG / WETH. */
const BASKET_SYMBOL = /^(m[A-Z]+|USDG|WETH)$/;

function renderLive() {
  return render(
    <ChainProviders>
      <MemoryRouter initialEntries={['/live']}>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/live" element={<LiveVault />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </ChainProviders>,
  );
}

const group = () => screen.getByRole('radiogroup', { name: `Vaults on ${chainShortLabel(CHAIN)}` });
const radio = (v: (typeof VAULTS)[number]) => within(group()).getByRole('radio', { name: radioName(v) });

/** Wait for the basket table (chain reads) or the offline state; true = the node answered. */
async function settled(): Promise<boolean> {
  await waitFor(
    () => {
      const reached = screen.queryByRole('columnheader', { name: 'In position' }) !== null && screen.queryAllByText(BASKET_SYMBOL).length > 0;
      const failed = screen.queryByText(/Cannot reach the vault/i) !== null;
      expect(reached || failed).toBe(true);
    },
    { timeout: 15_000, interval: 100 },
  );
  return screen.queryByText(/Cannot reach the vault/i) === null;
}

/** Basket-table token symbols currently on screen (exact cells only). */
const basketSymbols = () => {
  const card = screen.getByRole('heading', { name: 'Basket' }).closest('section') as HTMLElement;
  return within(card)
    .queryAllByText(BASKET_SYMBOL)
    .map((el) => el.textContent);
};

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

describe('vault picker — config-driven, per chain, persisted', () => {
  it('the local stack really has two vaults (precondition)', () => {
    expect(VAULTS.map((v) => v.key)).toEqual(['demo', 'stocks']);
  });

  it('renders every vault from config before any chain read, the first one selected', () => {
    renderLive();
    // Synchronous: no await, so nothing from the node can have landed yet.
    const radios = within(group()).getAllByRole('radio');
    expect(radios).toHaveLength(2);
    expect(radio(DEMO).getAttribute('aria-checked')).toBe('true');
    expect(radio(STOCKS).getAttribute('aria-checked')).toBe('false');
    // Receipt symbols and labels come from the registry entry.
    expect(within(radio(STOCKS)).getByText(STOCKS.receipt.symbol)).toBeDefined();
    expect(within(radio(DEMO)).getByText(DEMO.receipt.symbol)).toBeDefined();
    expect(STOCKS.receipt.symbol).not.toBe(DEMO.receipt.symbol);
    expect(screen.getByRole('heading', { level: 1, name: DEMO.label })).toBeDefined();
  });

  it('switching retargets the whole page, remembers the choice, and never mixes baskets', async () => {
    renderLive();
    const reachable = await settled();
    const demoBasket = reachable ? basketSymbols() : [];

    await act(async () => radio(STOCKS).click());
    expect(radio(STOCKS).getAttribute('aria-checked')).toBe('true');
    expect(radio(DEMO).getAttribute('aria-checked')).toBe('false');
    expect(screen.getByRole('heading', { level: 1, name: STOCKS.label })).toBeDefined();
    expect(JSON.parse(window.localStorage.getItem(VAULT_SELECTION_KEY) ?? '{}')).toEqual({ [CHAIN]: 'stocks' });

    if (!reachable) {
      console.warn('vaultpicker.test: local chain unreachable — skipped the chain-read assertions');
      return;
    }
    // The stocks basket (6 tokens) replaces the demo basket (2 tokens) — nothing of the old one stays.
    await waitFor(() => expect(basketSymbols()).toContain('mNVDA'), { timeout: 15_000 });
    const stocksBasket = basketSymbols();
    expect(stocksBasket).toHaveLength(6);
    expect(stocksBasket).not.toContain('mWETH');
    expect(stocksBasket).not.toContain('WETH');
    expect(demoBasket).toEqual(FORK ? ['USDG', 'WETH'] : ['mUSDG', 'mWETH']);
    // The receipt symbol shown on the page is the stocks vault's own (chain read agrees with config).
    await waitFor(() => expect(screen.getByText(`${STOCKS.receipt.symbol} supply`)).toBeDefined(), { timeout: 15_000 });
    expect(screen.queryByText(`${DEMO.receipt.symbol} supply`)).toBeNull();
  });

  it('a remembered choice is restored on the next visit', () => {
    window.localStorage.setItem(VAULT_SELECTION_KEY, JSON.stringify({ [CHAIN]: 'stocks' }));
    renderLive();
    expect(radio(STOCKS).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('heading', { level: 1, name: STOCKS.label })).toBeDefined();
  });

  it('a stale or garbage stored choice falls back to the first vault, without crashing', () => {
    for (const stored of [JSON.stringify({ [CHAIN]: 'vanished' }), 'not json', JSON.stringify(['stocks'])]) {
      window.localStorage.setItem(VAULT_SELECTION_KEY, stored);
      renderLive();
      expect(radio(DEMO).getAttribute('aria-checked')).toBe('true');
      cleanup();
    }
  });
});
