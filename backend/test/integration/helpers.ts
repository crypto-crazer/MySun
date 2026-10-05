/**
 * Integration-test support: talk to the local anvil demo stack — the chain registry's `local`
 * entry (`shared/deployments.json` overlaid by `shared/deployment.local.json`), and one of the vaults
 * it lists (default: the first, `demo`).
 *
 * These tests mutate chain state (they send real `deployTo` / `rebalance` transactions and seed
 * mock fees), which is safe ONLY because the target is a disposable local anvil. The suite never
 * picks a chain by "first deployed" — it takes the `local` entry or nothing — and
 * `assertLocalChain` refuses anything that is not a local, testnet entry on an RPC served by this
 * machine (localhost, or an address bound to one of its own network interfaces).
 */

import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createWalletClient, http, type WalletClient, type Account, type Chain, type Transport } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { createClients, defineKeeperChain, type Clients } from '../../src/chain.js';
import { parseConfig, type EnvRecord, type KeeperConfig } from '../../src/config.js';
import { createMemoryLogger, type Logger } from '../../src/logger.js';
import { buildRegistry, selectVault, type RegistryChain, type RegistryVault } from '../../src/registry.js';
import { StateStore } from '../../src/state.js';

const here = dirname(fileURLToPath(import.meta.url));

export const REGISTRY_PATH = resolve(here, '../../../shared/deployments.json');
export const DEPLOYMENT_PATH = resolve(here, '../../../shared/deployment.local.json');

/**
 * Anvil account #1 (the keeper on the demo stack). This is the publicly known Anvil default key:
 * inert, LOCAL ONLY, and it must never be funded on a real network.
 */
export const ANVIL_KEY_1 = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

/**
 * Anvil account #3 — the swap trader on the RHC fork stack (fork-demo-up.sh funds it with real
 * USDG / WETH). Publicly known Anvil default key: inert, LOCAL ONLY, never fund it on a real network.
 */
export const ANVIL_KEY_3 = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6';

/**
 * One vault of the registry's local entry, flattened. Registry v2 lists only the vault's own
 * addresses (vault / implementation / keeper / demoUser) — basket tokens and adapters are read from
 * the vault on chain (`tokens()` / `adapters()`), never from the registry.
 */
export interface Deployment extends RegistryVault {
  readonly chainId: number;
  readonly rpcUrl: string;
  /** The registry entry these values come from (name, `local`, `testnet`). */
  readonly entry: RegistryChain;
}

/**
 * The registry's `local` entry, flattened onto one of its vaults — `key`, or the first listed.
 * Throws when there is no local entry: on a multi-chain registry the suite must not fall back to
 * some other deployed chain.
 */
export function readDeployment(key?: string): Deployment {
  const chains = buildRegistry({
    registryText: readFileSync(REGISTRY_PATH, 'utf8'),
    localText: existsSync(DEPLOYMENT_PATH) ? readFileSync(DEPLOYMENT_PATH, 'utf8') : undefined,
  });
  const entry = chains.find((c) => c.local === true);
  if (entry?.vaults === undefined) {
    throw new Error(
      'the chain registry has no local entry (shared/deployment.local.json missing?) — ' +
        'integration tests only ever act on the local demo stack',
    );
  }
  return { ...selectVault(entry, { key }), chainId: entry.chainId, rpcUrl: entry.rpcUrl, entry };
}

/** `true` when the configured RPC answers `eth_chainId` with the expected id. */
export async function isStackReachable(): Promise<boolean> {
  let deployment: Deployment;
  try {
    deployment = readDeployment();
  } catch {
    return false;
  }
  try {
    const res = await fetch(deployment.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return false;
    const json = (await res.json()) as { result?: string };
    return Number.parseInt(json.result ?? '0', 16) === deployment.chainId;
  } catch {
    return false;
  }
}

/**
 * `true` when `rpcUrl`'s host is an address bound to one of THIS machine's network interfaces —
 * e.g. the demo stack's overlay pointing at the host's LAN address so other devices can reach the
 * same anvil. Such an RPC is served by this machine just as 127.0.0.1 is.
 */
export function isOwnInterfaceHost(rpcUrl: string): boolean {
  let host: string;
  try {
    host = new URL(rpcUrl).hostname;
  } catch {
    return false;
  }
  return Object.values(networkInterfaces())
    .flat()
    .some((i) => i !== undefined && i.address === host);
}

/**
 * Guard: these tests only ever run against the registry's local overlay entry, on a chain the
 * registry marks `testnet`, over an RPC served by this machine (localhost, or one of its own
 * interface addresses). All three must hold — a mainnet chain id overlaid onto localhost (e.g. an
 * anvil fork of mainnet) is refused just like a remote RPC.
 */
export function assertLocalChain(
  deployment: Pick<Deployment, 'rpcUrl' | 'chainId'> & {
    readonly entry: Pick<RegistryChain, 'local' | 'testnet'>;
  },
): void {
  const isLocalHost =
    /^https?:\/\/(127\.0\.0\.1|localhost|host\.docker\.internal)[:/]/.test(deployment.rpcUrl) ||
    isOwnInterfaceHost(deployment.rpcUrl);
  const why = !isLocalHost
    ? 'not a localhost RPC'
    : deployment.entry.local !== true
      ? 'not the registry local entry'
      : deployment.entry.testnet !== true
        ? 'the registry does not mark this chain as a testnet'
        : null;
  if (why !== null) {
    throw new Error(
      `integration tests mutate chain state and refuse to run against ${deployment.rpcUrl} (chainId ${deployment.chainId}: ${why})`,
    );
  }
}

export interface Harness {
  readonly cfg: KeeperConfig;
  readonly clients: Clients;
  readonly logger: Logger;
  readonly records: Record<string, unknown>[];
  readonly store: StateStore;
  readonly deployment: Deployment;
}

/**
 * Build a keeper wired to the local stack, with a throwaway state file. `vaultKey` picks the vault
 * (default: the first listed); env is the full-env form, so it also exercises VAULT_ADDRESS →
 * registry identity resolution.
 */
export function makeHarness(over: EnvRecord = {}, vaultKey?: string): Harness {
  const deployment = readDeployment(vaultKey);
  assertLocalChain(deployment);

  const stateDir = mkdtempSync(join(tmpdir(), 'mysun-keeper-it-'));
  const cfg = parseConfig(
    {
      RPC_URL: deployment.rpcUrl,
      CHAIN_ID: String(deployment.chainId),
      VAULT_ADDRESS: deployment.vault,
      KEEPER_PRIVATE_KEY: ANVIL_KEY_1,
      STATE_FILE: join(stateDir, 'keeper-state.json'),
      LOG_LEVEL: 'debug',
      ...over,
    },
    { chain: deployment.entry },
  );
  const { logger, records } = createMemoryLogger('debug');
  return {
    cfg,
    clients: createClients(cfg),
    logger,
    records: records as Record<string, unknown>[],
    store: new StateStore(cfg.stateFile),
    deployment,
  };
}

/** A wallet client for an arbitrary local anvil account (seeds mock fees / trades on the fork). */
export function localWallet(
  deployment: Deployment,
  privateKey: `0x${string}`,
): WalletClient<Transport, Chain, Account> {
  const chain = defineKeeperChain(deployment.chainId, deployment.rpcUrl, deployment.entry.name);
  return createWalletClient({
    chain,
    transport: http(deployment.rpcUrl),
    account: privateKeyToAccount(privateKey),
  });
}

/** Pretty-print a log record array as the JSON lines the service would have written. */
export function renderLog(records: readonly Record<string, unknown>[]): string {
  return records.map((r) => JSON.stringify(r)).join('\n');
}
