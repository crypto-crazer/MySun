// @vitest-environment jsdom
/**
 * The demo chain ships in local/dev builds only (TASK-RETIRE-DEMO-CHAIN-FE): one gate in chains.ts,
 * `demoChainEnabled` / `DEMO_CHAIN_ENABLED`, read from `import.meta.env.DEV`. vitest runs as DEV, so
 * the rest of the suite keeps the demo chain; here the gate is FLIPPED (`vi.stubEnv('DEV', false)` —
 * what `vite build` bakes in) and the app module graph is re-imported fresh, so every list, helper and
 * mounted surface is checked the way a production bundle evaluates it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEPLOYMENTS as REGISTRY_DEPLOYMENTS } from '@/config/generated';
import { CHAINS, DEMO_CHAIN_ENABLED, DEPLOYMENTS, SUPPORTED_CHAINS, demoChainEnabled } from '@/chain/chains';

const DEMO_CHAIN_ID = 46630;
const MAINNET_ID = 4663;
const ACCOUNT = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';

/** chains.ts (and anything else) as a production build evaluates it: DEV=false, fresh modules. */
async function prodImport<T>(path: string): Promise<T> {
  vi.stubEnv('DEV', false);
  vi.stubEnv('PROD', true);
  vi.resetModules();
  return (await import(/* @vite-ignore */ path)) as T;
}

afterEach(() => {
  vi.unstubAllEnvs();
  // setup.ts's pin is undone by unstubAllEnvs — restore it for whatever runs next in this worker.
  vi.stubEnv('VITE_WALLETCONNECT_PROJECT_ID', '');
  vi.resetModules();
});

describe('the gate', () => {
  it('reads DEV: true or no env at all (tsx — e2e:local) keeps the demo chain; false drops it', () => {
    expect(demoChainEnabled({ DEV: true })).toBe(true);
    expect(demoChainEnabled({ DEV: false })).toBe(false);
    expect(demoChainEnabled(undefined)).toBe(true);
    expect(demoChainEnabled({})).toBe(true);
  });

  it('DEV (vitest, vite dev): unchanged — mainnet and the demo chain, the registry as-is', () => {
    expect(DEMO_CHAIN_ENABLED).toBe(true);
    expect(CHAINS.map((c) => c.chainId)).toEqual([MAINNET_ID, DEMO_CHAIN_ID]);
    expect(DEPLOYMENTS).toBe(REGISTRY_DEPLOYMENTS);
    expect(SUPPORTED_CHAINS.map((c) => c.id)).toEqual([MAINNET_ID, DEMO_CHAIN_ID]);
  });
});

describe('production build (DEV=false): the demo chain is gone', () => {
  it('every list and helper in chains.ts excludes it; live stays the default', async () => {
    const m = await prodImport<typeof import('@/chain/chains')>('@/chain/chains');
    expect(m.DEMO_CHAIN_ENABLED).toBe(false);
    expect(m.CHAINS.map((c) => c.chainId)).toEqual([MAINNET_ID]);
    expect(m.DEPLOYMENTS.map((d) => d.chainId)).toEqual([MAINNET_ID]);
    expect(m.SUPPORTED_CHAINS.map((c) => c.id)).toEqual([MAINNET_ID]);
    expect(m.DEFAULT_CHAIN_ID).toBe(MAINNET_ID);
    expect(m.DEFAULT_DEPLOYMENT_CHAIN_ID).toBe(MAINNET_ID);
    expect(m.chainFor(DEMO_CHAIN_ID)).toBeUndefined();
    expect(m.chainEntry(DEMO_CHAIN_ID)).toBeUndefined();
    expect(m.hasDeployment(DEMO_CHAIN_ID)).toBe(false);
    expect(m.vaultsForChain(DEMO_CHAIN_ID)).toEqual([]);
    expect(m.isLocalChain(DEMO_CHAIN_ID)).toBe(false);
    // Even handed the raw registry entry, the local-only predicates stay off.
    const local = REGISTRY_DEPLOYMENTS.find((d) => d.local);
    expect(local?.chainId).toBe(DEMO_CHAIN_ID);
    expect(m.canMintMocks(local)).toBe(false);
    expect(m.isForkDeployment(local)).toBe(false);
  });

  it('/vault/46630-* resolves as an unknown vault (no ambiguity, no crash)', async () => {
    const { DEPLOYMENTS: prod } = await prodImport<typeof import('@/chain/chains')>('@/chain/chains');
    const { resolveVaultRouteId } = await import('@/chain/liveVaults');
    expect(resolveVaultRouteId(`${DEMO_CHAIN_ID}-demo`, prod)).toEqual({ kind: 'missing' });
    // A bare key only the demo chain lists does not resolve either; mainnet keys still do.
    expect(resolveVaultRouteId('demo', prod)).toEqual({ kind: 'missing' });
    expect(resolveVaultRouteId('pons', prod)).toEqual({ kind: 'found', ref: { chainId: MAINNET_ID, key: 'pons' } });
  });

  it('the faucet refuses: no node-only call can be aimed at any chain', async () => {
    const faucet = await prodImport<typeof import('@/chain/faucet')>('@/chain/faucet');
    await expect(faucet.fundEth(DEMO_CHAIN_ID, ACCOUNT)).rejects.toThrow(/not in the registry/);
    await expect(faucet.fundEth(MAINNET_ID, ACCOUNT)).rejects.toThrow(/local-only/);
  });

  it('header switcher offers mainnet only; a 46630 vault page is "Vault not found" with no dev tools', async () => {
    // Everything React-side is imported AFTER the reset, so it shares one fresh React instance.
    const chains = await prodImport<typeof import('@/chain/chains')>('@/chain/chains');
    expect(chains.DEMO_CHAIN_ENABLED).toBe(false);
    const React = await import('react');
    const { act, cleanup, render, screen, within } = await import('@testing-library/react');
    const { MemoryRouter, Route, Routes } = await import('react-router-dom');
    const { ChainProviders } = await import('@/chain/Providers');
    const { Layout } = await import('@/components/layout/Layout');
    const { Markets } = await import('@/pages/Markets');
    const { VaultDetail } = await import('@/pages/VaultDetail');
    const h = React.createElement;
    const renderAt = (path: string) =>
      render(
        h(
          ChainProviders,
          null,
          h(
            MemoryRouter,
            { initialEntries: [path] },
            h(
              Routes,
              null,
              h(Route, { element: h(Layout) }, h(Route, { path: '/', element: h(Markets) }), h(Route, { path: '/vault/:id', element: h(VaultDetail) })),
            ),
          ),
        ),
      );
    try {
      renderAt(`/vault/${DEMO_CHAIN_ID}-demo`);
      expect(await screen.findByText(/Vault not found/)).toBeTruthy();
      expect(screen.queryByText('Local dev tools')).toBeNull();
      expect(screen.queryByText(/Fund my wallet/)).toBeNull();

      const selector = await screen.findByRole('button', { name: 'Network: Robinhood Chain' });
      await act(async () => selector.click());
      const options = within(screen.getByRole('listbox', { name: 'Networks' })).getAllByRole('option');
      expect(options).toHaveLength(1);
      expect(options[0].textContent).toMatch(/Robinhood Chain/);
      expect(screen.queryByText(/Demo Chain/)).toBeNull();
    } finally {
      cleanup();
    }
  });
});
