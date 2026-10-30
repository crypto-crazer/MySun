// @vitest-environment jsdom
/**
 * The vault page per registry vault, mounted for real (real providers, no wallet) on the demo chain's
 * multi-vault registry — what the retired /live vault picker used to cover. Route resolution and the
 * remembered selection are config-driven, so those assertions hold with or without a node; the
 * chain-read content (basket symbols, the card's per-token boxes) is conditional on the local node
 * answering, exactly as in render.test / network.test.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ChainProviders } from '@/chain/Providers';
import { DEPLOYMENTS, deploymentForChain, isForkDeployment, vaultsForChain } from '@/chain/chains';
import { Layout } from '@/components/layout/Layout';
import { VaultDetail } from '@/pages/VaultDetail';

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

/** The demo chain (the app defaults to mainnet; these tests drive the multi-vault local registry). */
const CHAIN = DEPLOYMENTS.find((d) => d.local)!.chainId;
const VAULTS = vaultsForChain(CHAIN);
/** The vault keys the local registry lists, in order — read from the file, never restated here. */
const LOCAL_KEYS = (
  JSON.parse(readFileSync(resolve(process.cwd(), '../shared/deployment.local.json'), 'utf8')) as {
    vaults: { key: string }[];
  }
).vaults.map((v) => v.key);
/** The RHC fork stack: "demo" (REAL USDG / WETH) + "pons" (REAL USDG / PONS) + "tri"; the all-mock stack: "demo" + "stocks". */
const FORK = isForkDeployment(deploymentForChain(CHAIN));
const DEMO = VAULTS[0];
const OTHER = VAULTS.find((v) => v.key === (FORK ? 'pons' : 'stocks')) as (typeof VAULTS)[number];
// The basket table names WETH as ETH (displaySymbol) and reads in the name's order, the anchor (USDG) last.
const BASKET_SYMBOL = /^(m[A-Z]+|USDG|ETH|WETH|PONS)$/;
const OTHER_MARKER = FORK ? 'PONS' : 'mNVDA';
const OFFLINE = /not reachable|Cannot reach the vault/i;

function renderAt(path: string) {
  return render(
    <ChainProviders>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/vault/:id" element={<VaultDetail />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </ChainProviders>,
  );
}

/** Basket-table token symbols on screen (the first column of the Basket table only). */
const basketSymbols = () => {
  const table = screen.getByRole('heading', { name: 'Basket' }).closest('section')!.querySelector('table') as HTMLElement;
  return within(table)
    .queryAllByText(BASKET_SYMBOL)
    .map((el) => el.textContent);
};

/** Wait for the basket rows (chain reads) or the offline state; true = the node answered. */
async function settled(): Promise<boolean> {
  await waitFor(
    () => {
      const reached = basketSymbols().length > 0;
      const failed = screen.queryAllByText(OFFLINE).length > 0;
      expect(reached || failed).toBe(true);
    },
    { timeout: 15_000, interval: 100 },
  );
  return screen.queryAllByText(OFFLINE).length === 0;
}

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

describe('vault page — one page per registry vault on the demo chain', () => {
  it('the demo chain really has several vaults (precondition)', () => {
    expect(VAULTS.map((v) => v.key)).toEqual(LOCAL_KEYS);
    expect(VAULTS.length).toBeGreaterThan(1);
    expect(DEMO.key).toBe('demo');
    expect(OTHER).toBeDefined();
  });

  it('every vault id resolves to its own page, before any chain read lands', () => {
    for (const v of VAULTS) {
      renderAt(`/vault/${CHAIN}-${v.key}`);
      // Synchronous: the heading falls back to the registry label until the symbols land.
      expect(screen.getByRole('heading', { level: 1 })).toBeDefined();
      expect(screen.queryByText(/Vault not found/)).toBeNull();
      expect(screen.getAllByText(new RegExp(v.receipt.symbol)).length).toBeGreaterThan(0);
      cleanup();
    }
  });

  it('opening a vault stores no vault choice (the page reads its URL; the per-chain selection is gone)', () => {
    renderAt(`/vault/${CHAIN}-${OTHER.key}`);
    expect(window.localStorage.getItem('mysun.vault.selected')).toBeNull();
  });

  it('two vaults never mix baskets', async () => {
    renderAt(`/vault/${CHAIN}-${DEMO.key}`);
    const reachable = await settled();
    if (!reachable) {
      console.warn('vaultpage.test: local chain unreachable — skipped the chain-read assertions');
      return;
    }
    const demoBasket = basketSymbols();
    expect(demoBasket).toEqual(FORK ? ['ETH', 'USDG'] : ['mUSDG', 'mWETH']);
    cleanup();

    renderAt(`/vault/${CHAIN}-${OTHER.key}`);
    await waitFor(() => expect(basketSymbols()).toContain(OTHER_MARKER), { timeout: 15_000 });
    expect(basketSymbols()).not.toContain('ETH');
    expect(basketSymbols()).not.toContain('WETH');
    expect(basketSymbols()).not.toContain('mWETH');
    // The card offers exactly this vault's tokens — in kind (the deposit default is the USDG zap).
    const inKind = () => screen.getByRole('button', { name: /^(Both|All)$/ }) as HTMLButtonElement;
    await waitFor(() => expect(inKind().disabled).toBe(false), { timeout: 15_000 });
    act(() => inKind().click());
    await waitFor(() => expect(screen.getByLabelText(`${OTHER_MARKER} amount`)).toBeDefined(), { timeout: 15_000 });
    expect(screen.queryByLabelText(/^m?WETH amount$/)).toBeNull();
  });
});
