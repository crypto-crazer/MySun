// @vitest-environment jsdom
/**
 * Chain switching, mounted for real: the header network selector (both registry chains, in every
 * build), and a wallet parked on a chain without a deployment being walked through switch → add
 * chain → switch from the vault page's wrong-network banner.
 *
 * Same rule as the picker test: no mocking of the app's wallet layer. The only fake is the wallet —
 * an EIP-6963-announced EIP-1193 object parked on chain 1 — no deployment — that has never heard
 * of the local Anvil chain, which is exactly the state a fresh MetaMask is in. Chain reads go to
 * the local node when it is up; every
 * assertion that needs the vault's data is conditional on that, as in render.test.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { numberToHex } from 'viem';
import { ChainProviders } from '@/chain/Providers';
import { chainFor } from '@/chain/chains';
import { addEthereumChainParams } from '@/chain/switchChain';
import { Layout } from '@/components/layout/Layout';
import { Markets } from '@/pages/Markets';
import { VaultDetail } from '@/pages/VaultDetail';

/* Test-environment shims (see render.test / picker.test for why): cross-realm AbortSignal, and a
   node global `localStorage` that shadows jsdom's. Neither exists in a real browser. */
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

const LOCAL = 'Demo Chain';
/** A basket token symbol: the mock stack's m-prefixed tokens, or the RHC fork's REAL USDG / WETH. */
const BASKET_SYMBOL = /^(m[A-Z]+|USDG|WETH)$/;
/** Basket symbols in the basket table: only the chain puts them there (the deposit card names USDG, its zap token, on its own). */
const chainSymbols = () => screen.queryAllByText(BASKET_SYMBOL).filter((e) => e.closest('table'));
const ACCOUNT = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';

/** A wallet parked on chain 1 (no registry entry → no deployment) that has never heard of the local chain. */
const wallet = (() => {
  const known = new Set([1]);
  let current = 1;
  const calls: { method: string; params?: unknown }[] = [];
  const provider = {
    calls,
    request: async ({ method, params }: { method: string; params?: unknown }) => {
      calls.push({ method, params });
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [ACCOUNT];
      if (method === 'eth_chainId') return numberToHex(current);
      if (method === 'wallet_switchEthereumChain') {
        const id = Number(BigInt((params as [{ chainId: string }])[0].chainId));
        if (!known.has(id)) throw Object.assign(new Error(`Unrecognized chain ID "${numberToHex(id)}".`), { code: 4902 });
        current = id;
        return null;
      }
      if (method === 'wallet_addEthereumChain') {
        known.add(Number(BigInt((params as [{ chainId: string }])[0].chainId)));
        return null;
      }
      return null;
    },
    on: () => {},
    removeListener: () => {},
  };
  const announce = () =>
    window.dispatchEvent(
      new CustomEvent('eip6963:announceProvider', {
        detail: Object.freeze({
          info: { uuid: 'uuid-fake', name: 'Fake Wallet', rdns: 'test.fake', icon: 'data:image/svg+xml;base64,AA==' },
          provider,
        }),
      }),
    );
  window.addEventListener('eip6963:requestProvider', announce);
  return { provider, announce };
})();

/** The demo chain's flagship vault page (it selects its chain in the header when it opens). */
const DEMO_VAULT = '/vault/46630-demo';

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

const OFFLINE = /not reachable|Cannot reach the vault/i;

/** Wait until the vault page has either real vault data or its offline state; true = reachable. */
async function settled(): Promise<boolean> {
  await waitFor(
    () => {
      const reached = chainSymbols().length > 0;
      const failed = screen.queryAllByText(OFFLINE).length > 0;
      expect(reached || failed).toBe(true);
    },
    { timeout: 15_000, interval: 100 },
  );
  return screen.queryAllByText(OFFLINE).length === 0;
}

afterEach(cleanup);

describe('network selector — no wallet', () => {
  it('lists both registry chains, marks the deployment state, and switches the selection', async () => {
    renderAt('/');
    // Live is the default: the app opens on the mainnet deployment, not the demo chain.
    const selector = await screen.findByRole('button', { name: 'Network: Robinhood Chain' });
    await act(async () => selector.click());

    // Every build offers the demo chain in the switcher, next to mainnet.
    const list = screen.getByRole('listbox', { name: 'Networks' });
    expect(within(list).getAllByRole('option')).toHaveLength(2);
    expect(within(list).getByText('chain id 4663')).toBeDefined(); // deployed — no "no deployment" marker
    expect(within(list).getByText('chain id 46630')).toBeDefined();

    // Pick the demo chain: no wallet, so this only changes the selection.
    await act(async () => within(list).getByText(LOCAL).click());
    expect(screen.getByRole('button', { name: `Network: ${LOCAL}` })).toBeDefined();
    expect(screen.queryByText(/No MySun deployment/)).toBeNull();

    // …and the header selector switches back to mainnet.
    await act(async () => screen.getByRole('button', { name: `Network: ${LOCAL}` }).click());
    await act(async () =>
      within(screen.getByRole('listbox', { name: 'Networks' }))
        .getByText('Robinhood Chain')
        .click(),
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Network: Robinhood Chain' })).toBeDefined());
  });

  it('a demo-chain vault page selects its chain in the header', async () => {
    renderAt(DEMO_VAULT);
    expect(await screen.findByRole('button', { name: `Network: ${LOCAL}` })).toBeDefined();
    await settled();
  });
});

describe('wrong network — wallet on a chain with no deployment', () => {
  it('the vault page shows the banner, then adds + switches to its chain', async () => {
    // The demo chain on purpose: the add-chain fallback is what anvil needs.
    renderAt(DEMO_VAULT);
    await act(async () => wallet.announce());
    await act(async () => screen.getAllByRole('button', { name: 'Connect wallet' })[0].click()); // header first
    await act(async () => screen.getByText('Fake Wallet').click());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // Wallet on chain 1 (no deployment) → target stays the local deployment, flagged wrong.
    expect(await screen.findByText(new RegExp(`Your wallet is on Chain 1\\. Figures below come from ${LOCAL.replace(/[()]/g, '\\$&')}`))).toBeDefined();
    const reachable = await settled();
    expect(screen.queryByText('Local dev tools')).toBeNull();

    // The wallet menu carries the manual-add parameters for the target network, right under the
    // switch button: a WalletConnect wallet that cannot be moved needs them in front of the user.
    const walletButton = screen.getByRole('button', { name: /0x3C44/ });
    await act(async () => walletButton.click());
    expect(
      within(walletButton.parentElement as HTMLElement).getByText('Trouble switching? Add the network by hand'),
    ).toBeDefined();
    await act(async () => walletButton.click());

    wallet.provider.calls.splice(0);
    await act(async () => screen.getAllByRole('button', { name: `Switch to ${LOCAL}` })[0].click());

    await waitFor(() => expect(screen.queryByText(/Your wallet is on/)).toBeNull());
    const walletCalls = wallet.provider.calls.filter((c) => c.method.startsWith('wallet_'));
    expect(walletCalls.map((c) => c.method)).toEqual(['wallet_switchEthereumChain', 'wallet_addEthereumChain', 'wallet_switchEthereumChain']);
    expect(walletCalls[1].params).toEqual([addEthereumChainParams(chainFor(46630)!)]);

    // On the local chain now: the local-only conveniences come back (when the node is up).
    if (reachable) expect(await screen.findByText('Local dev tools')).toBeDefined();
    else console.warn('network.test: local chain unreachable — skipped the LocalDevPanel assertion');
  });
});
