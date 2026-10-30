/**
 * Chain definitions, built from the registry (shared/deployments.json → src/config/generated.ts).
 * Nothing here names a chain: adding one is a registry entry + `pnpm sync:shared`.
 *
 * Two lists, two meanings:
 *  - `CHAINS` / `SUPPORTED_CHAINS` — every chain the app knows and will offer to switch to;
 *  - `DEPLOYMENTS` — the subset MySun is actually deployed on, each with its `vaults` list
 *    (`vaultsForChain` / `defaultVault` / `findVault`; each vault page reads the vault in its URL).
 *
 * The demo chain (the `local` overlay from shared/deployment.local.json, reached through
 * `resolveLocalRpcUrl`) ships in local/dev builds only — `vite dev`, vitest, `e2e:local` — where the
 * switcher offers it next to mainnet. A production build (`vite build`: the public demo is live-only)
 * drops it from every list here, so no surface can select, route to or fund it: one gate,
 * `demoChainEnabled` / `DEMO_CHAIN_ENABLED`. Live is the default either way: `defaultChainIds`
 * prefers the first non-local deployment.
 *
 * Imports are relative (not `@/`) on purpose: `scripts/e2e-local.ts` runs this module under tsx,
 * which does not see the Vite alias.
 */
import { defineChain, type Chain } from 'viem';
import {
  CHAINS as REGISTRY_CHAINS,
  DEPLOYMENTS as REGISTRY_DEPLOYMENTS,
  type ChainDeployment,
  type ChainEntry,
  type ChainMeta,
  type VaultEntry,
} from '../config/generated';

export type { ChainDeployment, ChainEntry, ChainMeta, VaultEntry };

/**
 * THE build gate for the demo chain: true for a local/dev build, false for a production one. Read
 * from `import.meta.env.DEV` (`vite dev` and vitest → true; `vite build` → false). No env at all —
 * `scripts/e2e-local.ts` imports this module under tsx, where `import.meta.env` is undefined — is
 * local, never a crash. The parameter exists for the regression tests.
 */
export function demoChainEnabled(env: { readonly DEV?: boolean } | undefined = import.meta.env): boolean {
  return env?.DEV !== false;
}

/** The gate, evaluated once for this build. Every demo-chain surface keys off it (directly or via the lists below). */
export const DEMO_CHAIN_ENABLED: boolean = demoChainEnabled();

/** Every chain this build offers, ascending chain id — mainnet, plus the demo chain in a local/dev build. */
export const CHAINS: readonly ChainEntry[] = DEMO_CHAIN_ENABLED ? REGISTRY_CHAINS : REGISTRY_CHAINS.filter((c) => !c.local);

/** The deployed chains this build offers, with their vaults (the demo chain: local/dev builds only). */
export const DEPLOYMENTS: readonly ChainDeployment[] = DEMO_CHAIN_ENABLED
  ? REGISTRY_DEPLOYMENTS
  : REGISTRY_DEPLOYMENTS.filter((d) => !d.local);

/** A deployed chain's vaults (registry order); empty for planned / unknown chains. */
export function vaultsForChain(chainId: number | undefined): readonly VaultEntry[] {
  return DEPLOYMENTS.find((d) => d.chainId === chainId)?.vaults ?? [];
}

/** The vault the app shows on a chain when nothing else is selected: its first one. */
export function defaultVault(chainId: number | undefined): VaultEntry | undefined {
  return vaultsForChain(chainId)[0];
}

/** A vault by key on a chain; undefined for an unknown key or chain. */
export function findVault(chainId: number | undefined, key: string | null | undefined): VaultEntry | undefined {
  return key ? vaultsForChain(chainId).find((v) => v.key === key) : undefined;
}

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
 *  - page served from any other host: reads go to the page's own
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

/** Every chain this build offers (`CHAINS`) as a viem chain, ascending chain id. */
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
 * stack overlaid from shared/deployment.local.json, and only in a build that ships it
 * (`DEMO_CHAIN_ENABLED`). Minting is gated further — see canMintMocks.
 */
export function isLocalChain(chainId: number | undefined): boolean {
  return DEMO_CHAIN_ENABLED && deploymentForChain(chainId)?.local === true;
}

/** The local stack runs on an Anvil fork of a real chain (deployment.local.json `fork: true`). */
export function isForkDeployment(d: ChainDeployment | undefined): boolean {
  return DEMO_CHAIN_ENABLED && d?.local === true && d.fork === true;
}

/**
 * The public `MockToken.mint` is usable: the local stack, unless its overlay says `mintable: false`
 * (the RHC fork — the flagship basket is REAL tokens, funded into the dev wallets at deploy time).
 */
export function canMintMocks(d: ChainDeployment | undefined): boolean {
  return DEMO_CHAIN_ENABLED && d?.local === true && d.mintable !== false;
}

export function chainLabel(chainId: number | undefined): string {
  const entry = chainEntry(chainId);
  if (entry) return entry.name;
  return chainId === undefined ? 'Unknown network' : `Chain ${chainId}`;
}

/** "Base (testnet)" → "Base": drops a trailing parenthetical for tight spots. */
export function chainShortLabel(chainId: number | undefined): string {
  return chainLabel(chainId).replace(/\s*\([^)]*\)\s*$/, '');
}

/**
 * Default-chain preference, as a pure function of the registry so it is testable with any shape.
 * Live is the default — the local stack is never preferred over a real deployment:
 *  - deployment chain: the first deployed non-local chain, else the local entry, else none;
 *  - app chain: the deployment chain, else the first registry chain (read-only "no deployment").
 */
export function defaultChainIds(chains: readonly ChainEntry[]): { chainId: number; deploymentChainId: number | undefined } {
  const deployed = chains.filter((c) => c.status === 'deployed');
  const deploymentChainId = (deployed.find((c) => !c.local) ?? deployed[0])?.chainId;
  const chainId = deploymentChainId ?? chains[0]?.chainId;
  if (chainId === undefined) throw new Error('chain registry is empty — run pnpm sync:shared');
  return { chainId, deploymentChainId };
}

const defaults = defaultChainIds(CHAINS);

/** The chain the app shows before any wallet or selection says otherwise. */
export const DEFAULT_CHAIN_ID: number = defaults.chainId;

/** The default chain that HAS a deployment (undefined only if the registry has none at all). */
export const DEFAULT_DEPLOYMENT_CHAIN_ID: number | undefined = defaults.deploymentChainId;
