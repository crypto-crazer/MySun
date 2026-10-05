/**
 * Chain definitions, built from the registry (shared/deployments.json → src/config/generated.ts).
 * Nothing here names a chain: adding one is a registry entry + `pnpm sync:shared`.
 *
 * Two lists, two meanings:
 *  - `CHAINS` / `SUPPORTED_CHAINS` — every chain the app knows and will offer to switch to;
 *  - `DEPLOYMENTS` — the subset MySun is actually deployed on, each with its `vaults` list
 *    (`vaultsForChain` / `defaultVault` / `findVault`; which one the app shows: ./vaultSelection.ts).
 *
 * Imports are relative (not `@/`) on purpose: `scripts/e2e-local.ts` runs this module under tsx,
 * which does not see the Vite alias.
 */
import { defineChain, type Chain } from 'viem';
import {
  CHAINS,
  DEPLOYMENTS,
  defaultVault,
  findVault,
  vaultsForChain,
  type ChainDeployment,
  type ChainEntry,
  type ChainMeta,
  type VaultEntry,
} from '../config/generated';

export type { ChainDeployment, ChainEntry, ChainMeta, VaultEntry };
export { defaultVault, findVault, vaultsForChain };

const nativeCurrency = { name: 'Ether', symbol: 'ETH', decimals: 18 } as const;

/** Loopback / RFC 1918 hostnames: what a *local* stack's RPC may be stored under. */
const LOCAL_RPC_HOSTS = /^(localhost|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})$/i;

/**
 * The RPC URL a page should actually read, for a `local` chain. The demo stack (:8547) runs on the
 * machine that serves the app, addressed differently per device — `127.0.0.1` on the laptop, the
 * Mac's LAN IP on a phone — and the LAN address changes whenever the Mac changes networks (DHCP).
 * So:
 *  - page served from a loopback/private host: the stored host is swapped for the page's own
 *    hostname (`localhost` is pinned to `127.0.0.1` to stay on IPv4);
 *  - page served from a public host (the demo's ngrok tunnel): reads go to the page's own
 *    same-origin `/rpc`, which the dev server proxies to the stack's node (vite.config.ts) — the
 *    stored `127.0.0.1` would point at the visitor's machine.
 * Hosted chains, node-side callers (e2e, sync — no `window`), and pages without an origin fall
 * back to the registry's canonical value.
 */
export function resolveLocalRpcUrl(
  rpcUrl: string,
  isLocal: boolean,
  hostname: string | undefined = typeof window === 'undefined' ? undefined : window.location.hostname,
  origin: string | undefined = typeof window === 'undefined' ? undefined : window.location.origin,
): string {
  if (!isLocal || !hostname) return rpcUrl;
  if (!LOCAL_RPC_HOSTS.test(hostname)) {
    if (!origin) return rpcUrl;
    try {
      return new URL('/rpc', origin).toString();
    } catch {
      return rpcUrl;
    }
  }
  try {
    const url = new URL(rpcUrl);
    if (!LOCAL_RPC_HOSTS.test(url.hostname)) return rpcUrl;
    url.hostname = hostname === 'localhost' ? '127.0.0.1' : hostname;
    return url.toString().replace(/\/+$/, '');
  } catch {
    return rpcUrl; // not a URL — the registry validator already rejects those
  }
}

/** Registry metadata → a viem chain (ETH-native: every target is an EVM L1/L2 paying gas in ETH). */
export function toViemChain(meta: ChainMeta & { local?: true }): Chain {
  return defineChain({
    id: meta.chainId,
    name: meta.name,
    nativeCurrency,
    rpcUrls: { default: { http: [resolveLocalRpcUrl(meta.rpcUrl, meta.local === true)] } },
    ...(meta.explorerUrl ? { blockExplorers: { default: { name: 'Explorer', url: meta.explorerUrl } } } : {}),
    testnet: meta.testnet,
  });
}

/** Every registry chain as a viem chain, ascending chain id. */
export const SUPPORTED_CHAINS: readonly Chain[] = CHAINS.map(toViemChain);

/** The viem chain for an id, or undefined when the wallet is on something the registry lacks. */
export function chainFor(chainId: number | undefined): Chain | undefined {
  return SUPPORTED_CHAINS.find((c) => c.id === chainId);
}

/** The registry entry (status, local flag) for an id. */
export function chainEntry(chainId: number | undefined): ChainEntry | undefined {
  return CHAINS.find((c) => c.chainId === chainId);
}

/** The deployment (chain metadata + vaults) for a chain; undefined for planned or unknown chains. */
export function deploymentForChain(chainId: number | undefined): ChainDeployment | undefined {
  return DEPLOYMENTS.find((d) => d.chainId === chainId);
}

export function hasDeployment(chainId: number | undefined): boolean {
  return deploymentForChain(chainId) !== undefined;
}

/**
 * Local-only conveniences (the dev panel, the RPC strip) are gated on this: true only for the demo
 * stack overlaid from shared/deployment.local.json. Minting is gated further — see canMintMocks.
 */
export function isLocalChain(chainId: number | undefined): boolean {
  return deploymentForChain(chainId)?.local === true;
}

/** The local stack runs on an Anvil fork of a real chain (deployment.local.json `fork: true`). */
export function isForkDeployment(d: ChainDeployment | undefined): boolean {
  return d?.local === true && d.fork === true;
}

/**
 * The public `MockToken.mint` is usable: the local stack, unless its overlay says `mintable: false`
 * (the RHC fork — the flagship basket is REAL tokens, funded into the dev wallets at deploy time).
 */
export function canMintMocks(d: ChainDeployment | undefined): boolean {
  return d?.local === true && d.mintable !== false;
}

export function chainLabel(chainId: number | undefined): string {
  const entry = chainEntry(chainId);
  if (entry) return entry.name;
  return chainId === undefined ? 'Unknown network' : `Chain ${chainId}`;
}

/** "Base (testnet)" → "Base": drops a trailing parenthetical, for tight spots that tag `local` separately. */
export function chainShortLabel(chainId: number | undefined): string {
  return chainLabel(chainId).replace(/\s*\([^)]*\)\s*$/, '');
}

/**
 * Default-chain preference, as a pure function of the registry so it is testable with any shape:
 *  - deployment chain: the `local` entry, else the first deployed chain, else none;
 *  - app chain: the deployment chain, else the first registry chain (read-only "no deployment").
 */
export function defaultChainIds(chains: readonly ChainEntry[]): { chainId: number; deploymentChainId: number | undefined } {
  const deployed = chains.filter((c) => c.status === 'deployed');
  const deploymentChainId = (deployed.find((c) => c.local) ?? deployed[0])?.chainId;
  const chainId = deploymentChainId ?? chains[0]?.chainId;
  if (chainId === undefined) throw new Error('chain registry is empty — run pnpm sync:shared');
  return { chainId, deploymentChainId };
}

const defaults = defaultChainIds(CHAINS);

/** The chain the app shows before any wallet or selection says otherwise. */
export const DEFAULT_CHAIN_ID: number = defaults.chainId;

/** The default chain that HAS a deployment (undefined only if the registry has none at all). */
export const DEFAULT_DEPLOYMENT_CHAIN_ID: number | undefined = defaults.deploymentChainId;
