// @vitest-environment jsdom
/**
 * The local stack's optional `fork` / `mintable` flags (deployment.local.json, still schema v2) and
 * the LocalDevPanel gating they drive: the mint rows need the public `MockToken.mint`, so they are
 * shown on the all-mock stack and hidden on the RHC fork (`mintable: false`), where the flagship
 * basket is real tokens; the fork instead offers the connect-first fund CTA (src/chain/faucet.ts)
 * — "Connect wallet" until a wallet is connected, then "Fund my wallet". No node
 * needed — the panel is mounted with a synthetic vault.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ChainProviders } from '@/chain/Providers';
import { useStore } from '@/store/useStore';
import { canMintMocks, isForkDeployment, type ChainDeployment } from '@/chain/chains';
import type { LiveVault, UserBasket } from '@/chain/useVault';
import { LocalDevPanel } from '@/components/live/LocalDevPanel';

/* Test-environment shim (see picker.test): node's global `localStorage` shadows jsdom's. */
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

const A = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as `0x${string}`;
const ENTRY = { key: 'demo', label: 'Demo', receipt: { name: 'sunEthLP', symbol: 'sunEthLP' }, vault: A(1), implementation: A(2), keeper: A(3) };

function deployment(extra: Partial<ChainDeployment> = {}): ChainDeployment {
  return {
    chainId: 46630,
    name: 'Localhost',
    rpcUrl: 'http://127.0.0.1:8547',
    testnet: true,
    status: 'deployed',
    local: true,
    vaults: [ENTRY],
    ...extra,
  };
}

function renderPanel(d: ChainDeployment, symbols: string[]) {
  const vault = {
    address: ENTRY.vault,
    chainId: d.chainId,
    deployment: d,
    entry: ENTRY,
    hasDeployment: true,
    receipt: ENTRY.receipt,
    decimals: 18,
    tokens: symbols.map((symbol, i) => ({ address: A(10 + i), symbol, name: symbol, decimals: 18 })),
  } as unknown as LiveVault;
  const user = { refetch: () => {} } as unknown as UserBasket;
  return render(
    <ChainProviders>
      <LocalDevPanel vault={vault} user={user} />
    </ChainProviders>,
  );
}

afterEach(cleanup);

describe('fork / mintable flags — absent means "mock stack"', () => {
  it('canMintMocks: the local stack unless it says mintable: false; never a non-local chain', () => {
    expect(canMintMocks(deployment())).toBe(true);
    expect(canMintMocks(deployment({ fork: true }))).toBe(true);
    expect(canMintMocks(deployment({ fork: true, mintable: false }))).toBe(false);
    expect(canMintMocks(deployment({ local: undefined }))).toBe(false);
    expect(canMintMocks(undefined)).toBe(false);
  });

  it('isForkDeployment: only a local entry flagged fork: true', () => {
    expect(isForkDeployment(deployment())).toBe(false);
    expect(isForkDeployment(deployment({ fork: true, mintable: false }))).toBe(true);
    expect(isForkDeployment(deployment({ local: undefined, fork: true }))).toBe(false);
  });
});

describe('LocalDevPanel — mint rows gated on mintable, the fork funds instead', () => {
  it('mock stack (no flags): one mint row per basket token, the info card, no fork line', () => {
    renderPanel(deployment(), ['mUSDG', 'mWETH']);
    expect(screen.getByText('Local dev tools')).toBeDefined();
    expect(screen.getByText('Local chain only · MockToken.mint is public here')).toBeDefined();
    expect(screen.getByRole('textbox', { name: 'Amount of mUSDG to mint' })).toBeDefined();
    expect(screen.getByRole('textbox', { name: 'Amount of mWETH to mint' })).toBeDefined();
    expect(screen.getAllByRole('button', { name: 'Mint' })).toHaveLength(2);
    expect(screen.queryByText(/No minting on this stack/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Fund my wallet' })).toBeNull();
    expect(screen.queryByText(/Anvil fork of Robinhood Chain/)).toBeNull();
  });

  it('RHC fork (fork: true, mintable: false): mint rows gone, connect-first fund CTA offered, info card stays', () => {
    renderPanel(deployment({ fork: true, mintable: false }), ['USDG', 'WETH']);
    expect(screen.getByText('Local dev tools')).toBeDefined();
    expect(screen.getByText('Local fork · real tokens, no minting')).toBeDefined();
    expect(screen.queryAllByRole('button', { name: 'Mint' })).toHaveLength(0);
    expect(screen.queryAllByRole('textbox')).toHaveLength(0);
    // No wallet is connected in this test: the fork CTA must be the ENABLED connect-first button
    // (the deposit card's pattern), not a disabled "Fund my wallet".
    const fund = screen.getByRole('button', { name: 'Connect wallet' }) as HTMLButtonElement;
    expect(fund.disabled).toBe(false);
    expect(screen.queryByRole('button', { name: 'Fund my wallet' })).toBeNull();
    expect(screen.getByText(/No minting on this stack/).textContent).toMatch(/anvil-impersonated call from the pool/);
    expect(screen.getByText(/No minting on this stack/).textContent).toMatch(/no wallet prompts/);
    expect(screen.getByText(/No minting on this stack/).textContent).toMatch(/tops\s+your wallet up to 1 ETH for gas/);
    expect(screen.getByText(/No minting on this stack/).textContent).toMatch(/10 USDG \+ 10 WETH/);
    // The rest of the info card is unchanged: network, stack, RPC, vault, keeper.
    expect(screen.getByText('Anvil fork of Robinhood Chain · real Uniswap pools')).toBeDefined();
    expect(screen.getByText('http://127.0.0.1:8547')).toBeDefined();
    expect(screen.getByText('RPC')).toBeDefined();
    expect(screen.getByText('Keeper')).toBeDefined();
  });

  it('demo wallet: the fork CTA still offers the real connect path, and says why funding needs one', () => {
    // The reported state: the demo wallet survives reloads and the header chip shows its address,
    // so the page "looks connected" — the button must still be the live connect path, not a dead one.
    useStore.setState({ connected: true, demoWallet: true });
    renderPanel(deployment({ fork: true, mintable: false }), ['USDG', 'WETH']);
    const fund = screen.getByRole('button', { name: 'Connect wallet' }) as HTMLButtonElement;
    expect(fund.disabled).toBe(false);
    expect(screen.getByText(/demo wallet is read-only/)).toBeDefined();
    useStore.setState({ connected: false, demoWallet: false });
  });
});
