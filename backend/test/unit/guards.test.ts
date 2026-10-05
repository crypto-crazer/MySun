/**
 * Guards around the integration suite itself: it must skip cleanly when the local stack is down,
 * and must refuse outright to send its transactions anywhere that is not the registry's local,
 * testnet entry on a localhost RPC.
 */
import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildRegistry } from '../../src/registry.js';
import {
  DEPLOYMENT_PATH,
  REGISTRY_PATH,
  assertLocalChain,
  isOwnInterfaceHost,
  isStackReachable,
  readDeployment,
} from '../integration/helpers.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isStackReachable', () => {
  it('is false when the RPC refuses the connection (=> the suite skips)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:8547'))),
    );
    await expect(isStackReachable()).resolves.toBe(false);
  });

  it('is false when the RPC answers with a different chain id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({ ok: true, json: () => Promise.resolve({ result: '0x1' }) } as Response),
      ),
    );
    await expect(isStackReachable()).resolves.toBe(false);
  });

  it('is true for the expected local chain id', async () => {
    const { chainId } = readDeployment();
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ result: `0x${chainId.toString(16)}` }),
        } as Response),
      ),
    );
    await expect(isStackReachable()).resolves.toBe(true);
  });
});

describe('assertLocalChain', () => {
  const local = {
    rpcUrl: 'http://127.0.0.1:8547',
    chainId: 46630,
    entry: { local: true as const, testnet: true },
  };

  it('accepts the local anvil stack', () => {
    expect(() => assertLocalChain(local)).not.toThrow();
  });

  it('accepts the real registry local entry (shared/deployments.json + deployment.local.json)', () => {
    expect(() => assertLocalChain(readDeployment())).not.toThrow();
  });

  it('refuses a remote RPC even on the right chain id', () => {
    expect(() => assertLocalChain({ ...local, rpcUrl: 'https://rpc.robinhood.example' })).toThrow(
      /refuse to run/,
    );
  });

  it('refuses the wrong chain id even on localhost', () => {
    // The real registry's mainnet entry, with a local overlay that targets 4663 on localhost (e.g.
    // an anvil fork of mainnet): the merged entry is `local` but not `testnet` — refused.
    const registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')) as {
      chains: Record<string, unknown>;
    };
    const overlay = { ...JSON.parse(readFileSync(DEPLOYMENT_PATH, 'utf8')), chainId: 4663 };
    const entry = buildRegistry({
      registryText: JSON.stringify({ ...registry, chains: { 4663: registry.chains['4663'] } }),
      localText: JSON.stringify(overlay),
    }).find((c) => c.local === true)!;
    expect(entry.chainId).toBe(4663);
    expect(() =>
      assertLocalChain({ rpcUrl: entry.rpcUrl, chainId: entry.chainId, entry }),
    ).toThrow(/refuse to run.*not mark this chain as a testnet/);
  });

  it("accepts an RPC on one of this machine's own interface addresses (e.g. its LAN IP)", () => {
    const own = Object.values(networkInterfaces())
      .flat()
      .find((i) => i !== undefined && i.family === 'IPv4' && !i.internal);
    if (own === undefined) return; // no non-loopback IPv4 interface on this host — nothing to check
    const rpcUrl = `http://${own.address}:8547`;
    expect(isOwnInterfaceHost(rpcUrl)).toBe(true);
    expect(() => assertLocalChain({ ...local, rpcUrl })).not.toThrow();
  });

  it('refuses an address that is not bound here, and look-alike host names', () => {
    // 192.0.2.0/24 is TEST-NET-1 (RFC 5737): never assigned to a real interface.
    expect(isOwnInterfaceHost('http://192.0.2.1:8547')).toBe(false);
    expect(isOwnInterfaceHost('not a url')).toBe(false);
    expect(() => assertLocalChain({ ...local, rpcUrl: 'http://192.0.2.1:8547' })).toThrow(
      /refuse to run.*not a localhost RPC/,
    );
    expect(() => assertLocalChain({ ...local, rpcUrl: 'http://localhost.evil.example:8547' })).toThrow(
      /refuse to run/,
    );
  });

  it('readDeployment picks a vault of the local entry by key (default: the first)', () => {
    expect(readDeployment().key).toBe('demo');
    expect(readDeployment('stocks').key).toBe('stocks');
    expect(readDeployment('stocks').receipt.symbol).not.toBe(readDeployment().receipt.symbol);
    expect(() => readDeployment('bonds')).toThrow(/available: demo, stocks/);
  });

  it('refuses a deployed testnet entry that is not the local overlay, even on localhost', () => {
    expect(() => assertLocalChain({ ...local, entry: { testnet: true } })).toThrow(
      /refuse to run.*not the registry local entry/,
    );
  });
});
