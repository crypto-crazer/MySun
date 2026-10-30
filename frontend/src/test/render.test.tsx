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
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { WalletContext, useWallet } from '@/wallet/context';
import { ChainProviders } from '@/chain/Providers';
import { DEPLOYMENTS } from '@/chain/chains';
import { BRAND } from '@/lib/brand';
import { Layout } from '@/components/layout/Layout';
import { Markets } from '@/pages/Markets';
import { useStore } from '@/store/useStore';
import { VaultDetail } from '@/pages/VaultDetail';
import { chainSymbols } from './chainSymbols';

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

const ACCOUNT = '0x0000000000000000000000000000000000000001';

/** The wallet layer reporting a connected account — what the app's own bridge mirrors into the store. */
function ConnectedWallet({ children }: { children: ReactNode }) {
  const wallet = useWallet();
  return <WalletContext.Provider value={{ ...wallet, status: 'connected', address: ACCOUNT }}>{children}</WalletContext.Provider>;
}

function renderAt(path: string, { connected = false }: { connected?: boolean } = {}) {
  const routes = (
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Markets />} />
          <Route path="/vault/:id" element={<VaultDetail />} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
  return render(<ChainProviders>{connected ? <ConnectedWallet>{routes}</ConnectedWallet> : routes}</ChainProviders>);
}

/** The demo chain's flagship vault — the page that reads the local node. */
const DEMO_VAULT = `/vault/${DEPLOYMENTS.find((d) => d.local)!.chainId}-${DEPLOYMENTS.find((d) => d.local)!.vaults[0].key}`;

afterEach(cleanup);

describe('app renders without a wallet', () => {
  it("markets page lists the selected chain's vaults, live — no prototype rows, no demo badge", async () => {
    const { container } = renderAt('/');
    expect(await screen.findByRole('heading', { name: 'Vaults' })).toBeDefined();
    // Rows come from the registry this build offers (chain × vault), never from src/demo — and the
    // table follows the header's chain: default (mainnet 4663) shows only that chain's vaults. Team
    // mode is locked by default (this build has no access-code hash), so the registry's staging vaults
    // are not listed — teamgate.test.tsx covers the unlocked table.
    const rows = [...container.querySelectorAll('li[data-vault]')].map((r) => r.getAttribute('data-vault')).sort();
    const mainnetVaults = (DEPLOYMENTS.find((d) => d.chainId === 4663)?.vaults ?? []).filter((v) => !v.staging);
    expect(rows).toEqual(mainnetVaults.map((v) => `4663-${v.key}`).sort());
    expect(screen.queryByText(/^Staging$/i)).toBeNull();
    // (the prototype's CASHCAT / ETH vault, and CASHCAT itself, are gone; the guard stays)
    expect(screen.queryByText(/CASHCAT/)).toBeNull();
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
    expect(screen.getByRole('heading', { level: 1, name: /Markets move/ })).toBeDefined();
    expect(useStore.getState()).toMatchObject({ connected: false, address: null });
    cleanup();
    // A real account (the wallet layer → Layout's bridge → the store), nothing deposited: neither
    // connect button stays — the header shows the account, the hero "Your deposits" at $0.00.
    renderAt('/', { connected: true });
    expect(useStore.getState()).toMatchObject({ connected: true, address: ACCOUNT });
    expect(screen.queryAllByRole('button', { name: 'Connect wallet' })).toEqual([]);
    expect(screen.getByRole('button', { name: /0x0000…0001/ })).toBeDefined();
    expect(screen.getByText('Your deposits')).toBeDefined();
    cleanup();
    // The account goes away → the bridge clears the mirror and both buttons come back.
    renderAt('/');
    expect(useStore.getState()).toMatchObject({ connected: false, address: null });
    expect(screen.getAllByRole('button', { name: 'Connect wallet' })).toHaveLength(2);
  });

  it('a connected store with no account from the wallet yet (mid-switch): the title stays, neither connect button does', () => {
    renderAt('/');
    // The bridge holds the last account while the wallet reports "connecting" (no address).
    act(() => useStore.setState({ connected: true, address: ACCOUNT }));
    try {
      expect(screen.getByRole('heading', { level: 1, name: /Markets move/ })).toBeDefined();
      expect(screen.queryAllByRole('button', { name: 'Connect wallet' })).toEqual([]);
    } finally {
      act(() => useStore.setState({ connected: false, address: null }));
    }
  });

  it('the wallet picker offers no read-only mode: browsing needs no wallet, depositing does', () => {
    renderAt('/');
    act(() => screen.getAllByRole('button', { name: 'Connect wallet' })[0].click());
    expect(screen.getByRole('dialog')).toBeDefined();
    expect(screen.queryByRole('button', { name: /Read-only/i })).toBeNull();
    expect(screen.queryByText(/prototype|demo data|Read-only/i)).toBeNull();
    // jsdom announces no EIP-6963 wallet, so the picker explains what a wallet is for.
    expect(screen.getByText(/No browser wallet detected/).textContent).toMatch(/to deposit — every vault can be browsed without one/);
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
    // Before any read lands no basket symbol is on the page — not even the zap token: they only come from the chain
    expect(chainSymbols()).toEqual([]);
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

describe('the header wordmark', () => {
  /**
   * Regression: the wordmark used to hide a demo reset — 5 clicks inside 2.5 s cleared the store and
   * pushed "Demo reset · Wallet disconnected". That read as a bug now the app is live, and it collided
   * with team mode's own 7-tap secret on the *footer* brand (./TeamMode.tsx): a visitor tapping either
   * brand mark hit the wrong one. The wordmark leads home and does nothing else.
   */
  it('carries no hidden reset — five quick taps leave a connected wallet alone', () => {
    renderAt('/', { connected: true });
    const logo = screen.getByRole('link', { name: BRAND.name });
    for (let i = 0; i < 5; i++) act(() => { fireEvent.click(logo); });
    const s = useStore.getState();
    expect(s.connected).toBe(true);
    expect(s.address).toBe(ACCOUNT);
    expect(s.toasts).toEqual([]);
    expect(screen.queryByText(/Demo reset/i)).toBeNull();
    expect(screen.queryAllByRole('button', { name: 'Connect wallet' })).toEqual([]);
  });
});
