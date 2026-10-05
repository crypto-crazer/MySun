/**
 * The generator behind `pnpm sync:shared`, split in two so the unit tests run exactly what the CLI
 * runs: `loadShared` does the file I/O (registry + local overlay + ABIs, validated by ./registry.ts),
 * `renderGenerated` is a pure function of that input → the text of `src/config/generated.ts`.
 * Pure + fixed key order + no timestamps = idempotent: the same inputs always render the same bytes.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildRegistry, type RegistryChain, type RegistryVault } from './registry';

export interface SharedInputs {
  chains: RegistryChain[];
  /** Whether shared/deployment.local.json was present (the CLI says so when it is not). */
  hasLocal: boolean;
  abis: {
    vault: unknown[];
    mockToken: unknown[];
    mockAdapter: unknown[];
    positionAdapter: unknown[];
    zapIn: unknown[];
    zapOut: unknown[];
  };
}

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`cannot read ${path}: ${(err as Error).message}`);
  }
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readText(path));
  } catch (err) {
    throw new Error(`cannot parse ${path}: ${(err as Error).message}`);
  }
}

/** ABI files are plain arrays; keep only the entries a frontend can use. */
function readAbi(sharedDir: string, name: string): unknown[] {
  const abi = readJson(resolve(sharedDir, 'abis', `${name}.json`));
  if (!Array.isArray(abi)) throw new Error(`abis/${name}.json: expected a top-level array`);
  return abi;
}

/** Read + validate everything under `sharedDir` (the monorepo's shared/). Throws with the offending path. */
export function loadShared(sharedDir: string): SharedInputs {
  const localPath = resolve(sharedDir, 'deployment.local.json');
  const hasLocal = existsSync(localPath);
  return {
    chains: buildRegistry({
      registryText: readText(resolve(sharedDir, 'deployments.json')),
      localText: hasLocal ? readText(localPath) : undefined,
    }),
    hasLocal,
    abis: {
      vault: readAbi(sharedDir, 'MySunVaultUpgradeable'),
      mockToken: readAbi(sharedDir, 'MockToken'),
      mockAdapter: readAbi(sharedDir, 'MockPositionAdapter'),
      positionAdapter: readAbi(sharedDir, 'IPositionAdapter'),
      zapIn: readAbi(sharedDir, 'MySunZapIn'),
      zapOut: readAbi(sharedDir, 'MySunZapOut'),
    },
  };
}

const lit = (v: unknown) => JSON.stringify(v, null, 2);

/** Chain metadata only — what every registry chain has, deployed or not. */
function meta(c: RegistryChain) {
  return {
    chainId: c.chainId,
    name: c.name,
    rpcUrl: c.rpcUrl,
    testnet: c.testnet,
    ...(c.explorerUrl ? { explorerUrl: c.explorerUrl } : {}),
    status: c.status,
    ...(c.local ? { local: true } : {}),
    ...(c.fork ? { fork: true } : {}),
    ...(c.mintable === false ? { mintable: false } : {}),
    ...(c.periphery ? { periphery: c.periphery } : {}),
  };
}

/** One vault entry, in a fixed key order (the local file arrives alphabetised by forge). */
function vaultEntry(v: RegistryVault) {
  return {
    key: v.key,
    label: v.label,
    receipt: { name: v.receipt.name, symbol: v.receipt.symbol },
    vault: v.vault,
    implementation: v.implementation,
    keeper: v.keeper,
    ...(v.demoUser ? { demoUser: v.demoUser } : {}),
  };
}

/** The full text of src/config/generated.ts for these inputs. */
export function renderGenerated({ chains, abis }: Pick<SharedInputs, 'chains' | 'abis'>): string {
  const deployments = chains
    .filter((c) => c.status === 'deployed')
    .map((c) => ({ ...meta(c), vaults: (c.vaults ?? []).map(vaultEntry) }));
  const vaultCount = deployments.reduce((n, d) => n + d.vaults.length, 0);
  const {
    vault: vaultAbi,
    mockToken: mockTokenAbi,
    mockAdapter: mockAdapterAbi,
    positionAdapter: positionAdapterAbi,
    zapIn: zapInAbi,
    zapOut: zapOutAbi,
  } = abis;

  return `/**
 * AUTO-GENERATED — DO NOT EDIT.
 * Source: ../../shared/deployments.json + ../../shared/deployment.local.json + ../../shared/abis/*.json
 * Regenerate with: pnpm sync:shared
 * Generated from ${chains.length} registry chains, ${vaultCount} vaults and ${vaultAbi.length} vault ABI entries.
 */

/** Periphery contract addresses for a chain (zaps + the strategy layer's PlanExecutor) — from the registry or the local overlay. */
export interface PeripheryEntry {
  zapIn?: \`0x\${string}\`;
  zapOut?: \`0x\${string}\`;
  planExecutor?: \`0x\${string}\`;
}

/** What every chain in shared/deployments.json carries, deployed or not. */
export interface ChainMeta {
  chainId: number;
  name: string;
  rpcUrl: string;
  testnet: boolean;
  /** Block explorer base URL, when the registry lists one. */
  explorerUrl?: string;
  /** Periphery contracts — present when the chain has them registered (registry or local overlay). */
  periphery?: PeripheryEntry;
}

/** 'planned' = a known chain with no MySun deployment yet; 'deployed' = has at least one vault. */
export type ChainStatus = 'planned' | 'deployed';

/**
 * A registry chain as the app sees it. \`local\` marks the demo stack from deployment.local.json; that
 * file may add \`fork\` (the stack is an Anvil fork of a real chain) and \`mintable: false\` (no public
 * \`MockToken.mint\` for the flagship basket — wallets were funded at deploy time). Absent = not a
 * fork / mintable.
 */
export interface ChainEntry extends ChainMeta {
  status: ChainStatus;
  local?: true;
  fork?: true;
  mintable?: false;
}

/** One MySun vault on a chain. \`key\` is unique per chain; \`receipt\` is its LP token as initialised. */
export interface VaultEntry {
  key: string;
  label: string;
  receipt: { name: string; symbol: string };
  vault: \`0x\${string}\`;
  implementation: \`0x\${string}\`;
  keeper: \`0x\${string}\`;
  demoUser?: \`0x\${string}\`;
}

/** A chain MySun is deployed on, with its vaults (never empty; the first one is the default). */
export interface ChainDeployment extends ChainMeta {
  status: 'deployed';
  local?: true;
  fork?: true;
  mintable?: false;
  vaults: readonly VaultEntry[];
}

/** Every registry chain, ascending chain id. */
export const CHAINS: readonly ChainEntry[] = ${lit(chains.map(meta))};

/** Deployed chains only, with their vaults. The local entry comes from shared/deployment.local.json. */
export const DEPLOYMENTS: readonly ChainDeployment[] = ${lit(deployments)};

/** Every vault on a chain, registry order; empty for planned or unknown chains. */
export function vaultsForChain(chainId: number | undefined): readonly VaultEntry[] {
  return DEPLOYMENTS.find((d) => d.chainId === chainId)?.vaults ?? [];
}

/** The chain's default vault — the first one listed; undefined when the chain has none. */
export function defaultVault(chainId: number | undefined): VaultEntry | undefined {
  return vaultsForChain(chainId)[0];
}

/** The vault with this key on this chain, or undefined (never a fallback — see defaultVault). */
export function findVault(chainId: number | undefined, key: string | null | undefined): VaultEntry | undefined {
  return key ? vaultsForChain(chainId).find((v) => v.key === key) : undefined;
}

/** MySunVaultUpgradeable — vault core + ERC-20 receipt-token surface + custom errors. */
export const vaultAbi = ${lit(vaultAbi)} as const;

/** MockToken — a plain ERC-20 plus a public \`mint\` (local demo stack only). */
export const mockTokenAbi = ${lit(mockTokenAbi)} as const;

/** IPositionAdapter — the venue-agnostic adapter surface every adapter implements. */
export const positionAdapterAbi = ${lit(positionAdapterAbi)} as const;

/** MockPositionAdapter — adds \`deployed(i)\` / \`harvestable(i)\` on top of IPositionAdapter. */
export const mockAdapterAbi = ${lit(mockAdapterAbi)} as const;

/** MySunZapIn — single-asset zap-in periphery (owner-registered vaults + typed routes). */
export const zapInAbi = ${lit(zapInAbi)} as const;

/** MySunZapOut — exit-zap periphery (receipt token → one output token, owner-registered routes). */
export const zapOutAbi = ${lit(zapOutAbi)} as const;
`;
}
