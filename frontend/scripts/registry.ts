/**
 * The multi-chain registry, as data: `shared/deployments.json` merged with the local demo stack's
 * `shared/deployment.local.json`. Pure — no file I/O — so `sync-shared.ts` and the unit tests run
 * the exact same validation.
 *
 * Schema v2: a deployed chain carries a `vaults` list — one entry per MySun vault on that chain,
 * each with its own receipt token name/symbol. The local overlay replaces the chain's list. The
 * overlay may also carry two optional booleans (still v2): `fork` (the stack runs on an Anvil fork of
 * a real chain) and `mintable` (the stack's basket tokens can be minted via the public
 * `MockToken.mint`; `false` on the fork, whose flagship basket is REAL tokens funded at deploy time).
 * Absent = `fork: false`, `mintable: true` — the all-mock DemoLocal.s.sol writes neither; the fork
 * script writes `fork: true, mintable: false`. Only the non-default values are carried forward.
 *
 * v2 additive: `periphery` — the chain's periphery contracts `{ zapIn?, zapOut?, planExecutor? }` (the
 * zaps and the strategy layer's `PlanExecutor`; at least one when the object is present, none the zero
 * address). Allowed on a deployed registry entry and on the local overlay; the overlay replaces the
 * entry's object when it carries one.
 *
 * Every rule throws with the offending path (`deployments.json: chains.4663.vaults[1].vault …`),
 * because a registry mistake that reaches the app turns into a vault read against the wrong address.
 */

export const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
export const VAULT_KEY_RE = /^[a-z][a-z0-9-]*$/;
/** Every key a vault entry may carry; `demoUser` is the only optional one. */
export const VAULT_KEYS = ['key', 'label', 'receipt', 'vault', 'implementation', 'keeper', 'demoUser'] as const;
const VAULT_ADDRESS_KEYS = ['vault', 'implementation', 'keeper'] as const;
const RECEIPT_KEYS = ['name', 'symbol'] as const;

const CHAIN_KEYS = ['name', 'rpcUrl', 'testnet', 'status', 'explorerUrl', 'vaults', 'periphery'] as const;
const LOCAL_KEYS = ['version', 'chainId', 'rpcUrl', 'vaults', 'fork', 'mintable', 'periphery'] as const;
const PERIPHERY_KEYS = ['zapIn', 'zapOut', 'planExecutor'] as const;
const STATUSES = ['planned', 'deployed'] as const;
export const REGISTRY_VERSION = 2;

export interface RegistryVault {
  /** Slug, unique per chain — what the app persists as "the selected vault". */
  key: string;
  label: string;
  /** The vault's receipt token, as set in `initialize` — the picker renders it without a wallet. */
  receipt: { name: string; symbol: string };
  vault: string;
  implementation: string;
  keeper: string;
  demoUser?: string;
}

/** Optional periphery contracts for a chain; at least one is present when the object is. */
export interface RegistryPeriphery {
  zapIn?: string;
  zapOut?: string;
  /** The strategy layer's `PlanExecutor` (keeper-composed plans, one transaction). */
  planExecutor?: string;
}

export interface RegistryChain {
  chainId: number;
  name: string;
  rpcUrl: string;
  testnet: boolean;
  explorerUrl?: string;
  status: 'planned' | 'deployed';
  local?: true;
  /** Local overlay only: the stack runs on a fork of a real chain (real tokens and venues). */
  fork?: true;
  /** Local overlay only: `MockToken.mint` is NOT available — wallets were funded at deploy time. */
  mintable?: false;
  vaults?: RegistryVault[];
  /** Periphery contracts; present only for deployed chains (or via the local overlay). */
  periphery?: RegistryPeriphery;
}

const REGISTRY = 'deployments.json';
const LOCAL = 'deployment.local.json';

function fail(file: string, path: string, message: string): never {
  throw new Error(`${file}: ${path} ${message}`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function httpUrl(file: string, path: string, v: unknown): string {
  if (typeof v !== 'string' || !/^https?:\/\/[^\s]+$/.test(v)) fail(file, path, `must be an http(s) URL (got ${JSON.stringify(v)})`);
  return v;
}

function nonEmpty(file: string, path: string, v: unknown): string {
  if (typeof v !== 'string' || v.trim() === '') fail(file, path, `must be a non-empty string (got ${JSON.stringify(v)})`);
  return v.trim();
}

/** An optional boolean flag: absent → undefined, otherwise it must be a JSON boolean. */
function optionalBool(file: string, path: string, v: unknown): boolean | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') fail(file, path, `must be true or false when present (got ${JSON.stringify(v)})`);
  return v;
}

function address(file: string, path: string, v: unknown): string {
  if (v === undefined) fail(file, path, 'is missing');
  if (typeof v !== 'string' || !ADDRESS_RE.test(v)) fail(file, path, `is not an address (got ${JSON.stringify(v)})`);
  return v;
}

function rejectUnknown(file: string, path: string, raw: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(raw).filter((k) => !allowed.includes(k));
  if (unknown.length) fail(file, path ? `${path}.${unknown[0]}` : unknown[0], `is not a known key (allowed: ${allowed.join(', ')})`);
}

/** Canonical positive decimal only: "4663" yes; "04663", "0x1237", "abc", "-1" no. */
function parseChainId(file: string, path: string, v: unknown): number {
  const s = typeof v === 'number' ? String(v) : v;
  if (typeof s !== 'string' || !/^[1-9]\d*$/.test(s) || !Number.isSafeInteger(Number(s))) {
    fail(file, path, `is not a numeric chain id (got ${JSON.stringify(v)})`);
  }
  return Number(s);
}

function readVault(file: string, path: string, raw: unknown): RegistryVault {
  if (!isRecord(raw)) fail(file, path, 'must be an object');
  rejectUnknown(file, path, raw, VAULT_KEYS);

  if (typeof raw.key !== 'string' || !VAULT_KEY_RE.test(raw.key)) {
    fail(file, `${path}.key`, `must be a lowercase slug matching ${VAULT_KEY_RE} (got ${JSON.stringify(raw.key)})`);
  }
  const label = nonEmpty(file, `${path}.label`, raw.label);

  if (raw.receipt === undefined) fail(file, `${path}.receipt`, 'is missing');
  if (!isRecord(raw.receipt)) fail(file, `${path}.receipt`, 'must be an object { name, symbol }');
  rejectUnknown(file, `${path}.receipt`, raw.receipt, RECEIPT_KEYS);
  const receipt = {
    name: nonEmpty(file, `${path}.receipt.name`, raw.receipt.name),
    symbol: nonEmpty(file, `${path}.receipt.symbol`, raw.receipt.symbol),
  };

  const out: RegistryVault = { key: raw.key, label, receipt, vault: '', implementation: '', keeper: '' };
  for (const k of VAULT_ADDRESS_KEYS) out[k] = address(file, `${path}.${k}`, raw[k]);
  if (raw.demoUser !== undefined) out.demoUser = address(file, `${path}.demoUser`, raw.demoUser);
  return out;
}

/** A chain's `vaults`: a non-empty list, keys unique, no vault address listed twice. */
function readVaults(file: string, path: string, raw: unknown): RegistryVault[] {
  if (!Array.isArray(raw)) fail(file, path, 'must be an array of vault entries');
  if (raw.length === 0) fail(file, path, 'must list at least one vault');
  const vaults = raw.map((v, i) => readVault(file, `${path}[${i}]`, v));
  vaults.forEach((v, i) => {
    const first = vaults.findIndex((o) => o.key === v.key);
    if (first !== i) fail(file, `${path}[${i}].key`, `"${v.key}" is already used by ${path}[${first}] — keys are unique per chain`);
    const same = vaults.findIndex((o) => o.vault.toLowerCase() === v.vault.toLowerCase());
    if (same !== i) fail(file, `${path}[${i}].vault`, `${v.vault} is already listed as ${path}[${same}] ("${vaults[same].key}")`);
  });
  return vaults;
}

/** A chain's optional `periphery`: `{ zapIn?, zapOut?, planExecutor? }` — at least one, addresses non-zero. */
function readPeriphery(file: string, path: string, raw: unknown): RegistryPeriphery {
  if (!isRecord(raw)) fail(file, path, 'must be an object { zapIn?, zapOut?, planExecutor? }');
  rejectUnknown(file, path, raw, PERIPHERY_KEYS);
  const out: RegistryPeriphery = {};
  for (const k of PERIPHERY_KEYS) {
    if (raw[k] === undefined) continue;
    const v = address(file, `${path}.${k}`, raw[k]);
    if (/^0x0{40}$/.test(v)) fail(file, `${path}.${k}`, 'must not be the zero address');
    out[k] = v;
  }
  if (Object.keys(out).length === 0) fail(file, path, 'must carry at least one of zapIn, zapOut, planExecutor');
  return out;
}

/**
 * `JSON.parse` keeps the LAST of two identical keys without a word — which is exactly how a
 * copy-pasted chain or vault entry would silently replace another. Scan the raw text for repeats
 * instead. Returns the first duplicate as `path.key` (array elements as `[i]`), or null.
 */
export function findDuplicateKey(text: string): string | null {
  // One frame per open container: object frames collect their keys, array frames count elements.
  const stack: { keys: Set<string> | null; path: string; index: number }[] = [];
  let lastKey = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      let s = '';
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\') j++;
        s += text[j];
        j++;
      }
      i = j;
      let k = j + 1;
      while (k < text.length && /\s/.test(text[k])) k++;
      const top = stack[stack.length - 1];
      if (text[k] === ':' && top?.keys) {
        if (top.keys.has(s)) return top.path ? `${top.path}.${s}` : s;
        top.keys.add(s);
        lastKey = s;
      }
    } else if (c === '{' || c === '[') {
      const parent = stack[stack.length - 1];
      const path = !parent
        ? ''
        : parent.keys
          ? parent.path
            ? `${parent.path}.${lastKey}`
            : lastKey
          : `${parent.path}[${parent.index}]`;
      stack.push({ keys: c === '{' ? new Set() : null, path, index: 0 });
    } else if (c === '}' || c === ']') {
      stack.pop();
    } else if (c === ',') {
      const top = stack[stack.length - 1];
      if (top && !top.keys) top.index++;
    }
  }
  return null;
}

function parseJson(file: string, text: string): unknown {
  const dup = findDuplicateKey(text);
  if (dup) fail(file, dup, 'is defined twice');
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${file}: invalid JSON (${(err as Error).message})`);
  }
}

function requireVersion(file: string, raw: Record<string, unknown>): void {
  if (raw.version !== REGISTRY_VERSION) {
    fail(file, 'version', `must be ${REGISTRY_VERSION} (got ${JSON.stringify(raw.version)}) — v2 lists vaults per chain`);
  }
}

export interface BuildInput {
  /** Raw text of shared/deployments.json. */
  registryText: string;
  /** Raw text of shared/deployment.local.json, or undefined when the file is absent. */
  localText?: string;
}

/**
 * Registry + local overlay → the validated chain list, in ascending chain-id order.
 *
 * The local file is an OVERLAY on the registry entry with the same chain id: that entry becomes
 * `status: 'deployed'`, `local: true`, takes the local `rpcUrl`, and the local `vaults` REPLACE the
 * entry's list; `fork: true` / `mintable: false` are carried when the file says so, and a local
 * `periphery` replaces the entry's object. Its chain id must already be in the registry — the
 * registry is the only place a chain gets a name.
 */
export function buildRegistry({ registryText, localText }: BuildInput): RegistryChain[] {
  const raw = parseJson(REGISTRY, registryText);
  if (!isRecord(raw)) fail(REGISTRY, '(root)', 'must be an object');
  requireVersion(REGISTRY, raw);
  if (!isRecord(raw.chains)) fail(REGISTRY, 'chains', 'must be an object keyed by chain id');

  const byId = new Map<number, RegistryChain>();
  for (const [key, entry] of Object.entries(raw.chains)) {
    const path = `chains.${key}`;
    const chainId = parseChainId(REGISTRY, path, key);
    if (byId.has(chainId)) fail(REGISTRY, path, `duplicates chain id ${chainId}`);
    if (!isRecord(entry)) fail(REGISTRY, path, 'must be an object');
    rejectUnknown(REGISTRY, path, entry, CHAIN_KEYS);

    if (typeof entry.name !== 'string' || entry.name.trim() === '') fail(REGISTRY, `${path}.name`, 'must be a non-empty string');
    if (typeof entry.testnet !== 'boolean') fail(REGISTRY, `${path}.testnet`, 'must be true or false');
    if (!(STATUSES as readonly unknown[]).includes(entry.status)) {
      fail(REGISTRY, `${path}.status`, `must be one of ${STATUSES.join(' | ')} (got ${JSON.stringify(entry.status)})`);
    }
    const chain: RegistryChain = {
      chainId,
      name: entry.name.trim(),
      rpcUrl: httpUrl(REGISTRY, `${path}.rpcUrl`, entry.rpcUrl),
      testnet: entry.testnet,
      status: entry.status as RegistryChain['status'],
    };
    if (entry.explorerUrl !== undefined) chain.explorerUrl = httpUrl(REGISTRY, `${path}.explorerUrl`, entry.explorerUrl);
    if (entry.vaults !== undefined) {
      if (chain.status !== 'deployed') fail(REGISTRY, `${path}.vaults`, `given for a chain with status "${chain.status}" — set status to "deployed"`);
      chain.vaults = readVaults(REGISTRY, `${path}.vaults`, entry.vaults);
    }
    if (entry.periphery !== undefined) {
      if (chain.status !== 'deployed') fail(REGISTRY, `${path}.periphery`, `given for a chain with status "${chain.status}" — set status to "deployed"`);
      chain.periphery = readPeriphery(REGISTRY, `${path}.periphery`, entry.periphery);
    }
    byId.set(chainId, chain);
  }
  if (byId.size === 0) fail(REGISTRY, 'chains', 'must list at least one chain');

  if (localText !== undefined) {
    const local = parseJson(LOCAL, localText);
    if (!isRecord(local)) fail(LOCAL, '(root)', 'must be an object');
    requireVersion(LOCAL, local);
    rejectUnknown(LOCAL, '', local, LOCAL_KEYS);
    if (typeof local.chainId !== 'number') fail(LOCAL, 'chainId', `must be a number (got ${JSON.stringify(local.chainId)})`);
    const chainId = parseChainId(LOCAL, 'chainId', local.chainId);
    const base = byId.get(chainId);
    if (!base) fail(LOCAL, 'chainId', `${chainId} has no entry in ${REGISTRY} — add it under chains.${chainId} first`);
    if (local.vaults === undefined) fail(LOCAL, 'vaults', 'is missing');
    const fork = optionalBool(LOCAL, 'fork', local.fork);
    const mintable = optionalBool(LOCAL, 'mintable', local.mintable);
    byId.set(chainId, {
      ...base,
      status: 'deployed',
      local: true,
      ...(fork === true ? { fork: true as const } : {}),
      ...(mintable === false ? { mintable: false as const } : {}),
      rpcUrl: httpUrl(LOCAL, 'rpcUrl', local.rpcUrl),
      vaults: readVaults(LOCAL, 'vaults', local.vaults),
      ...(local.periphery !== undefined ? { periphery: readPeriphery(LOCAL, 'periphery', local.periphery) } : {}),
    });
  }

  for (const chain of byId.values()) {
    if (chain.status === 'deployed' && !chain.vaults) {
      fail(
        REGISTRY,
        `chains.${chain.chainId}.vaults`,
        `is missing for a "deployed" chain (add a vaults list, or provide ${LOCAL} with chainId ${chain.chainId})`,
      );
    }
  }

  return [...byId.values()].sort((a, b) => a.chainId - b.chainId);
}
