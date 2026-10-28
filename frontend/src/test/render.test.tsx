// @vitest-environment jsdom
/**
 * Render smoke test: the real app, the real providers (React Query + the viem wallet layer),
 * no mocks.
 *
 * It catches the class of breakage unit tests cannot — a bad hook order, a missing provider, an
 * import cycle — and it asserts the live/demo separation is actually on screen. Chain reads go out
 * over HTTP to the local node; when that node is not running the page must still render its
 * "cannot reach the vault" state rather than blow up, so this test passes either way.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ChainProviders } from '@/chain/Providers';
import { DEPLOYMENTS } from '@/chain/chains';
import { Layout } from '@/components/layout/Layout';
import { Markets } from '@/pages/Markets';
import { useStore } from '@/store/useStore';
import { VaultDetail } from '@/pages/VaultDetail';

/**
 * Test-environment shim, not an app concern: viem attaches a Node `AbortSignal` for its request
 * timeout, and jsdom's `Request`/`fetch` reject a signal from another realm ("Expected signal to be
 * an instance of AbortSignal"). Strip it so RPC calls reach the local node. In a real browser both
 * come from the same realm and this never happens.
 */
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

function renderAt(path: string) {
  return render(
    <ChainProviders>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<Markets />} />
            <Route path="/vault/:id" element={<VaultDetail />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </ChainProviders>,
  );
}

/** The demo chain's flagship vault — the page that reads the local node. */
const DEMO_VAULT = `/vault/${DEPLOYMENTS.find((d) => d.local)!.chainId}-${DEPLOYMENTS.find((d) => d.local)!.vaults[0].key}`;
/** A basket token symbol: the mock stack's m-prefixed tokens, or the RHC fork's REAL USDG / WETH. */
const BASKET_SYMBOL = /^(m[A-Z]+|USDG|WETH)$/;
/** Basket symbols in the basket table: only the chain puts them there (the deposit card names USDG, its zap token, on its own). */
const chainSymbols = () => screen.queryAllByText(BASKET_SYMBOL).filter((e) => e.closest('table'));

afterEach(cleanup);

describe('app renders without a wallet', () => {
  it("markets page lists the selected chain's vaults, live — no prototype rows, no demo badge", async () => {
    const { container } = renderAt('/');
    expect(await screen.findByRole('heading', { name: 'Vaults' })).toBeDefined();
    // Rows come from the registry this build offers (chain × vault), never from src/demo — and the
    // table follows the header's chain: default (mainnet 4663) shows only that chain's vaults.
    const rows = [...container.querySelectorAll('li[data-vault]')].map((r) => r.getAttribute('data-vault')).sort();
    const mainnetVaults = DEPLOYMENTS.find((d) => d.chainId === 4663)?.vaults ?? [];
    expect(rows).toEqual(mainnetVaults.map((v) => `4663-${v.key}`).sort());
    expect(screen.queryByText('NVDA / USDG')).toBeNull();
    // The design's fee-APR column is there, but with no collector feed configured every cell is "—"
    // (never an invented figure); still no volume column, and no Demo badge on the page.
    expect(screen.getAllByText(/^APR$/).length).toBeGreaterThan(0);
    for (const li of container.querySelectorAll('li[data-vault]')) expect(li.textContent).not.toMatch(/APR\d/);
    expect(screen.queryByText(/1D Vol/)).toBeNull();
    expect(screen.queryAllByText(/^Demo( data)?$/i)).toEqual([]);
    // NAV, the fee and the live badge are on the vault page, not in the table.
    expect(screen.queryByText(/Live on-chain/)).toBeNull();
    expect(screen.queryByText(/^(NAV|Fee)$/)).toBeNull();
    // One chain at a time: no demo rows under the mainnet default, no retired /live links.
    expect(rows.every((r) => r?.startsWith('4663-'))).toBe(true);
    expect(screen.queryByRole('tab', { name: 'Demo Chain' })).toBeNull();
    expect(container.querySelectorAll('a[href^="/live"]')).toHaveLength(0);
    expect(screen.queryByRole('link', { name: /Live vault/ })).toBeNull();
    expect(screen.getAllByRole('link', { name: 'Earn' }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('link', { name: 'Analytics' })).toBeNull();
  });

  it('the hero offers Connect wallet beside the header until a wallet is connected, deposits or not', () => {
    renderAt('/');
    expect(screen.getAllByRole('button', { name: 'Connect wallet' })).toHaveLength(2);
    cleanup();
    // Connected with nothing deposited: the title stays, neither connect button does
    useStore.setState({ connected: true, readOnlyMode: true });
    try {
      renderAt('/');
      expect(screen.getByRole('heading', { level: 1, name: /Markets move/ })).toBeDefined();
      expect(screen.queryAllByRole('button', { name: 'Connect wallet' })).toEqual([]);
    } finally {
      useStore.setState({ connected: false, readOnlyMode: false });
    }
  });

  it('the demo-chain vault page renders the original layout and shows no invented APR (APR —)', async () => {
    renderAt(DEMO_VAULT);
    expect(await screen.findByRole('tab', { name: 'Deposit' })).toBeDefined();
    expect(screen.getByRole('tab', { name: 'Withdraw' })).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Basket' })).toBeDefined();
    // The design's APR tile is there, but with no collector feed it reads "—" — never an invented figure.
    const tile = screen.getByText(/^APR$/).parentElement!;
    expect(tile.textContent).toBe('APR—');
    expect(screen.queryByText(/\d%$/, { selector: '.display' })).toBeNull();
  });

  it('the demo-chain vault page shows chain-read basket data, or says why it cannot', async () => {
    renderAt(DEMO_VAULT);
    await waitFor(
      () => {
        const reached = chainSymbols().length > 0;
        const failed = screen.queryAllByText(/not reachable|Cannot reach the vault/i).length > 0;
        expect(reached || failed).toBe(true);
      },
      { timeout: 15_000, interval: 100 },
    );
    if (screen.queryAllByText(/not reachable|Cannot reach the vault/i).length > 0) {
      console.warn('render.test: local chain unreachable — asserted the offline state instead');
    } else {
      // Real reads landed: the basket rows and, in kind, the card's per-token amount boxes are live.
      expect(chainSymbols().length).toBeGreaterThan(0);
      await waitFor(() => expect((screen.getByRole('button', { name: /^(Both|All)$/ }) as HTMLButtonElement).disabled).toBe(false), { timeout: 10_000 });
      act(() => screen.getByRole('button', { name: /^(Both|All)$/ }).click());
      await waitFor(() => expect(screen.getAllByLabelText(/^(m[A-Z]+|USDG|WETH) amount$/).length).toBeGreaterThan(1), { timeout: 10_000 });
    }
  });
});
