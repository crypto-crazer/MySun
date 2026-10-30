/**
 * Multi-vault: registry v2 (a `vaults` list per deployed chain) — every validation failure class, the
 * local overlay, the generated helpers, and the generator's
 * idempotency. All node, no wallet, no chain.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEPLOYMENTS, defaultVault, findVault, vaultsForChain } from '@/config/generated';
import { resolveTargetChain } from '@/chain/targetChain';
import { buildRegistry, findDuplicateKey } from '../../scripts/registry';
import { loadShared, renderGenerated } from '../../scripts/generate';

const sharedPath = (name = '') => fileURLToPath(new URL(`../../../shared/${name}`, import.meta.url));
const shared = (name: string) => readFileSync(sharedPath(name), 'utf8');
const LOCAL = JSON.parse(shared('deployment.local.json')) as {
  chainId: number;
  vaults: { key: string; vault: string; receipt: { name: string; symbol: string } }[];
};
/** The mainnet (4663) registry vaults — deployment.local.json has no say here. */
const MAIN_KEYS = (
  JSON.parse(shared('deployments.json')) as {
    chains: Record<string, { vaults: { key: string; vault: string; receipt: { name: string; symbol: string } }[] }>;
  }
).chains['4663'].vaults.map((v) => v.key);
const MAIN = (
  JSON.parse(shared('deployments.json')) as {
    chains: Record<string, { vaults: { key: string; vault: string; receipt: { name: string; symbol: string } }[] }>;
  }
).chains['4663'].vaults[0];

const A = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const vault = (n: number, extra: Record<string, unknown> = {}) => ({
  key: `v${n}`,
  label: `Vault ${n}`,
  receipt: { name: `Receipt ${n}`, symbol: `R${n}` },
  vault: A(100 + n),
  implementation: A(200),
  keeper: A(300),
  ...extra,
});
const chain = (vaults: unknown, extra: Record<string, unknown> = {}) => ({
  name: 'Test Chain',
  rpcUrl: 'https://rpc.test',
  testnet: false,
  status: 'deployed',
  vaults,
  ...extra,
});
const registryText = (chains: Record<string, unknown>) => JSON.stringify({ version: 2, chains });
/** Build a one-chain registry (chain 10) with these vaults; returns a thunk for toThrow. */
const withVaults = (vaults: unknown) => () => buildRegistry({ registryText: registryText({ '10': chain(vaults) }) });

describe('registry v2 — parse', () => {
  it('keeps every vault, in registry order, with its receipt; demoUser is optional', () => {
    const [c] = buildRegistry({ registryText: registryText({ '10': chain([vault(1, { demoUser: A(9) }), vault(2)]) }) });
    expect(c.vaults?.map((v) => v.key)).toEqual(['v1', 'v2']);
    expect(c.vaults?.[0]).toEqual({ ...vault(1), demoUser: A(9) });
    expect(c.vaults?.[1]).toEqual(vault(2));
    expect('demoUser' in c.vaults![1]).toBe(false);
  });

  it('trims label and receipt strings; keys and addresses are taken verbatim', () => {
    const [c] = buildRegistry({
      registryText: registryText({ '10': chain([vault(1, { label: '  Spaced  ', receipt: { name: ' N ', symbol: ' S ' } })]) }),
    });
    expect(c.vaults?.[0]).toMatchObject({ label: 'Spaced', receipt: { name: 'N', symbol: 'S' }, vault: A(101) });
  });

  it('the real shared/ files parse, and the local stack lists more than one vault', () => {
    const chains = buildRegistry({ registryText: shared('deployments.json'), localText: shared('deployment.local.json') });
    const local = chains.find((c) => c.local);
    expect(local?.vaults?.map((v) => v.key)).toEqual(LOCAL.vaults.map((v) => v.key));
    expect(LOCAL.vaults.length).toBeGreaterThan(1);
  });
});

describe('registry v2 — every vault failure class fails loudly, with the path', () => {
  it('version must be 2', () => {
    expect(() => buildRegistry({ registryText: JSON.stringify({ version: 1, chains: { '10': chain([vault(1)]) } }) })).toThrow(
      'deployments.json: version must be 2 (got 1)',
    );
    expect(() => buildRegistry({ registryText: JSON.stringify({ chains: {} }) })).toThrow('deployments.json: version must be 2 (got undefined)');
  });

  it('vaults: required on a deployed chain, an array, non-empty, forbidden on a planned chain', () => {
    expect(() => buildRegistry({ registryText: registryText({ '10': chain(undefined) }) })).toThrow(
      'deployments.json: chains.10.vaults is missing for a "deployed" chain',
    );
    expect(withVaults({ main: vault(1) })).toThrow('deployments.json: chains.10.vaults must be an array of vault entries');
    expect(withVaults([])).toThrow('deployments.json: chains.10.vaults must list at least one vault');
    expect(() => buildRegistry({ registryText: registryText({ '10': chain([vault(1)], { status: 'planned' }) }) })).toThrow(
      'deployments.json: chains.10.vaults given for a chain with status "planned"',
    );
  });

  it('an entry must be an object', () => {
    expect(withVaults([vault(1), 'v2'])).toThrow('deployments.json: chains.10.vaults[1] must be an object');
    expect(withVaults([null])).toThrow('deployments.json: chains.10.vaults[0] must be an object');
  });

  it('key: a lowercase slug', () => {
    for (const bad of ['Main', '1st', 'main_basket', 'main basket', '', '-x', 7]) {
      expect(withVaults([vault(1, { key: bad })])).toThrow('deployments.json: chains.10.vaults[0].key must be a lowercase slug');
    }
    const { key: _k, ...noKey } = vault(1);
    expect(withVaults([noKey])).toThrow('chains.10.vaults[0].key must be a lowercase slug matching');
    // …and these are fine.
    expect(withVaults([vault(1, { key: 'a' }), vault(2, { key: 'stock-pair-2' })])).not.toThrow();
  });

  it('key: unique per chain (but the same key on two chains is fine)', () => {
    expect(withVaults([vault(1, { key: 'main' }), vault(2, { key: 'main' })])).toThrow(
      'deployments.json: chains.10.vaults[1].key "main" is already used by chains.10.vaults[0] — keys are unique per chain',
    );
    expect(() =>
      buildRegistry({ registryText: registryText({ '10': chain([vault(1, { key: 'main' })]), '20': chain([vault(2, { key: 'main' })]) }) }),
    ).not.toThrow();
  });

  it('vault address: not listed twice on one chain (case-insensitive)', () => {
    const lower = A(0xabcdef);
    const upper = `0x${lower.slice(2).toUpperCase()}`;
    expect(withVaults([vault(1, { vault: lower }), vault(2, { vault: upper })])).toThrow(
      `deployments.json: chains.10.vaults[1].vault ${upper} is already listed as chains.10.vaults[0] ("v1")`,
    );
  });

  it('label: a non-empty string', () => {
    expect(withVaults([vault(1, { label: '   ' })])).toThrow('deployments.json: chains.10.vaults[0].label must be a non-empty string');
    expect(withVaults([vault(1, { label: 42 })])).toThrow('chains.10.vaults[0].label must be a non-empty string (got 42)');
  });

  it('receipt: an object with non-empty name + symbol and nothing else', () => {
    const { receipt: _r, ...noReceipt } = vault(1);
    expect(withVaults([noReceipt])).toThrow('deployments.json: chains.10.vaults[0].receipt is missing');
    expect(withVaults([vault(1, { receipt: 'sunEthLP' })])).toThrow('chains.10.vaults[0].receipt must be an object { name, symbol }');
    expect(withVaults([vault(1, { receipt: { symbol: 'X' } })])).toThrow('chains.10.vaults[0].receipt.name must be a non-empty string');
    expect(withVaults([vault(1, { receipt: { name: 'X', symbol: '' } })])).toThrow('chains.10.vaults[0].receipt.symbol must be a non-empty string');
    expect(withVaults([vault(1, { receipt: { name: 'X', symbol: 'X', decimals: 18 } })])).toThrow(
      'chains.10.vaults[0].receipt.decimals is not a known key (allowed: name, symbol)',
    );
  });

  it('vault / implementation / keeper: required addresses; demoUser: an address when given', () => {
    for (const k of ['vault', 'implementation', 'keeper'] as const) {
      const { [k]: _drop, ...missing } = vault(1);
      expect(withVaults([missing])).toThrow(`deployments.json: chains.10.vaults[0].${k} is missing`);
      expect(withVaults([vault(1, { [k]: '0x1234' })])).toThrow(`deployments.json: chains.10.vaults[0].${k} is not an address (got "0x1234")`);
    }
    expect(withVaults([vault(1, { demoUser: 'alice' })])).toThrow('deployments.json: chains.10.vaults[0].demoUser is not an address');
    expect(withVaults([vault(1, { demoUser: null })])).toThrow('chains.10.vaults[0].demoUser is not an address (got null)');
  });

  it('staging: carried only as true — absent = public; false or a non-boolean is an error', () => {
    const [c] = buildRegistry({ registryText: registryText({ '10': chain([vault(1, { staging: true }), vault(2)]) }) });
    expect(c.vaults?.[0]).toEqual({ ...vault(1), staging: true });
    expect('staging' in c.vaults![1]).toBe(false);
    for (const bad of [false, 'true', 1, null]) {
      expect(withVaults([vault(1, { staging: bad })])).toThrow(
        `deployments.json: chains.10.vaults[0].staging must be true when present — omit it for a public vault (got ${JSON.stringify(bad)})`,
      );
    }
  });

  it('unknown keys are rejected — including the v1 address keys', () => {
    expect(withVaults([vault(1, { usdg: A(3) })])).toThrow(
      'deployments.json: chains.10.vaults[0].usdg is not a known key (allowed: key, label, receipt, vault, implementation, keeper, planExecutor, demoUser, staging)',
    );
    expect(() => buildRegistry({ registryText: registryText({ '10': { ...chain([vault(1)]), addresses: {} } }) })).toThrow(
      'deployments.json: chains.10.addresses is not a known key',
    );
  });

  it('a key written twice inside a vault entry is caught before JSON.parse can hide it', () => {
    const text = `{ "version": 2, "chains": { "10": { "name": "T", "rpcUrl": "https://t", "testnet": false, "status": "deployed",
      "vaults": [ ${JSON.stringify(vault(1))}, { "key": "a", "key": "b" } ] } } }`;
    expect(() => buildRegistry({ registryText: text })).toThrow('deployments.json: chains.10.vaults[1].key is defined twice');
  });
});

describe('findDuplicateKey — array elements are addressed by index', () => {
  it('reports [i] paths, and commas inside strings do not shift the index', () => {
    expect(findDuplicateKey('{"a":[{"x":1},{"x":2,"x":3}]}')).toBe('a[1].x');
    expect(findDuplicateKey('{"a":["p,q",{"k":1,"k":2}]}')).toBe('a[1].k');
    expect(findDuplicateKey('{"a":[[1,2],[{"z":1,"z":1}]]}')).toBe('a[1][0].z');
    expect(findDuplicateKey('{"a":[{"x":1},{"x":2}],"b":{"x":1}}')).toBeNull();
  });
});

describe('local overlay (deployment.local.json) — v2', () => {
  const registry = (vaults?: unknown[]) => registryText({ '10': chain(vaults, vaults ? {} : { status: 'planned' }) });
  const local = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({ version: 2, chainId: 10, rpcUrl: 'http://127.0.0.1:9999', vaults: [vault(7), vault(8)], ...extra });

  it('replaces the chain vault list, promotes the chain, takes the local rpc', () => {
    const [c] = buildRegistry({ registryText: registry([vault(1)]), localText: local() });
    expect(c).toMatchObject({ status: 'deployed', local: true, rpcUrl: 'http://127.0.0.1:9999' });
    expect(c.vaults).toEqual([vault(7), vault(8)]);
    const [p] = buildRegistry({ registryText: registry(), localText: local() });
    expect(p).toMatchObject({ status: 'deployed', local: true });
    expect(p.vaults?.map((v) => v.key)).toEqual(['v7', 'v8']);
  });

  it('accepts the alphabetised key order forge writes (the real file)', () => {
    const sorted = JSON.stringify({
      chainId: 10,
      rpcUrl: 'http://127.0.0.1:9999',
      vaults: [{ demoUser: A(9), implementation: A(200), keeper: A(300), key: 'v1', label: 'Vault 1', receipt: { name: 'Receipt 1', symbol: 'R1' }, vault: A(101) }],
      version: 2,
    });
    const [c] = buildRegistry({ registryText: registry(), localText: sorted });
    expect(c.vaults).toEqual([{ ...vault(1), demoUser: A(9) }]);
  });

  it('needs version 2 and a vaults list; a stale v1 file is named as such', () => {
    const { version: _v, ...noVersion } = JSON.parse(local());
    expect(() => buildRegistry({ registryText: registry(), localText: JSON.stringify(noVersion) })).toThrow(
      'deployment.local.json: version must be 2 (got undefined)',
    );
    const v1 = JSON.stringify({ chainId: 10, rpcUrl: 'http://127.0.0.1:9999', vault: A(1), usdg: A(3) });
    expect(() => buildRegistry({ registryText: registry(), localText: v1 })).toThrow('deployment.local.json: version must be 2');
    expect(() => buildRegistry({ registryText: registry(), localText: local({ vaults: undefined }) })).toThrow(
      'deployment.local.json: vaults is missing',
    );
  });

  it('rejects unknown root keys, and validates its vaults with local paths', () => {
    expect(() => buildRegistry({ registryText: registry(), localText: local({ owner: A(1) }) })).toThrow(
      'deployment.local.json: owner is not a known key (allowed: version, chainId, rpcUrl, vaults, fork, mintable, periphery)',
    );
    expect(() => buildRegistry({ registryText: registry(), localText: local({ vaults: [vault(1), vault(2, { key: 'v1' })] }) })).toThrow(
      'deployment.local.json: vaults[1].key "v1" is already used by vaults[0]',
    );
    expect(() => buildRegistry({ registryText: registry(), localText: local({ vaults: [vault(1, { receipt: { name: 'x' } })] }) })).toThrow(
      'deployment.local.json: vaults[0].receipt.symbol must be a non-empty string',
    );
    expect(() => buildRegistry({ registryText: registry(), localText: local({ vaults: [] }) })).toThrow(
      'deployment.local.json: vaults must list at least one vault',
    );
    expect(() => buildRegistry({ registryText: registry(), localText: '{"version":2,"version":2}' })).toThrow(
      'deployment.local.json: version is defined twice',
    );
  });
});

describe('local overlay — optional fork / mintable root flags (still v2)', () => {
  const registry = () => registryText({ '10': chain(undefined, { status: 'planned' }) });
  const local = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({ version: 2, chainId: 10, rpcUrl: 'http://127.0.0.1:9999', vaults: [vault(7)], ...extra });
  const overlay = (extra: Record<string, unknown> = {}) => buildRegistry({ registryText: registry(), localText: local(extra) })[0];

  it('absent = a mock stack: neither flag is carried', () => {
    const c = overlay();
    expect('fork' in c).toBe(false);
    expect('mintable' in c).toBe(false);
  });

  it('the fork file (fork: true, mintable: false) is accepted and both flags are carried', () => {
    expect(overlay({ fork: true, mintable: false })).toMatchObject({ local: true, fork: true, mintable: false, status: 'deployed' });
    // …in the alphabetised order forge writes (DemoLocalFork.s.sol).
    const sorted = `{"chainId":10,"fork":true,"mintable":false,"rpcUrl":"http://127.0.0.1:9999","vaults":${JSON.stringify([vault(7)])},"version":2}`;
    expect(buildRegistry({ registryText: registry(), localText: sorted })[0]).toMatchObject({ fork: true, mintable: false });
  });

  it('explicit defaults (fork: false, mintable: true) are accepted and normalised away', () => {
    const c = overlay({ fork: false, mintable: true });
    expect('fork' in c).toBe(false);
    expect('mintable' in c).toBe(false);
  });

  it('non-boolean flags fail loudly, with the key', () => {
    expect(() => overlay({ fork: 'yes' })).toThrow('deployment.local.json: fork must be true or false when present (got "yes")');
    expect(() => overlay({ mintable: 0 })).toThrow('deployment.local.json: mintable must be true or false when present (got 0)');
    expect(() => overlay({ mintable: null })).toThrow('deployment.local.json: mintable must be true or false when present (got null)');
  });

  it('the flags belong to the local overlay only — a registry chain entry rejects them', () => {
    expect(() => buildRegistry({ registryText: registryText({ '10': chain([vault(1)], { fork: true }) }) })).toThrow(
      'deployments.json: chains.10.fork is not a known key',
    );
  });

  it('the generator emits the flags on the local chain entry only when set', () => {
    const inputs = loadShared(sharedPath());
    const chains = [overlay({ fork: true, mintable: false })];
    const text = renderGenerated({ chains, abis: inputs.abis });
    expect(text).toContain('"fork": true');
    expect(text).toContain('"mintable": false');
    const plain = renderGenerated({ chains: [overlay()], abis: inputs.abis });
    expect(plain).not.toContain('"fork"');
    expect(plain).not.toContain('"mintable"');
  });
});

describe('generated helpers — vaultsForChain / defaultVault / findVault', () => {
  const localId = LOCAL.chainId;

  it('vaultsForChain: the local file’s vaults in order; the mainnet list; [] for unknown chains', () => {
    expect(vaultsForChain(localId).map((v) => v.key)).toEqual(LOCAL.vaults.map((v) => v.key));
    expect(vaultsForChain(localId).map((v) => v.receipt)).toEqual(LOCAL.vaults.map((v) => v.receipt));
    expect(vaultsForChain(4663).map((v) => v.key)).toEqual(MAIN_KEYS); // the mainnet deployment
    expect(vaultsForChain(1)).toEqual([]);
    expect(vaultsForChain(undefined)).toEqual([]);
  });

  it('defaultVault: the first vault listed', () => {
    expect(defaultVault(localId)?.vault).toBe(LOCAL.vaults[0].vault);
    expect(defaultVault(4663)?.vault).toBe(MAIN.vault);
  });

  it('findVault: exact key on that chain only — no fallback', () => {
    // The second local vault: "pons" on the RHC fork stack, "stocks" on the all-mock one.
    const other = LOCAL.vaults[1].key;
    expect(findVault(localId, other)?.receipt.symbol).toBe(LOCAL.vaults.find((v) => v.key === other)?.receipt.symbol);
    expect(findVault(localId, 'demo')?.receipt.symbol).toBe(LOCAL.vaults.find((v) => v.key === 'demo')?.receipt.symbol);
    expect(findVault(localId, other)?.receipt.symbol).not.toBe(findVault(localId, 'demo')?.receipt.symbol);
    expect(findVault(localId, 'nope')).toBeUndefined();
    expect(findVault(localId, other.toUpperCase())).toBeUndefined();
    expect(findVault(localId, '')).toBeUndefined();
    expect(findVault(localId, null)).toBeUndefined();
    expect(findVault(localId, undefined)).toBeUndefined();
    expect(findVault(4663, 'demo')).toBeUndefined();
    expect(findVault(4663, 'main')?.vault).toBe(MAIN.vault);
  });

  it('every deployed chain has at least one vault, with unique keys', () => {
    for (const d of DEPLOYMENTS) {
      expect(d.vaults.length).toBeGreaterThan(0);
      expect(new Set(d.vaults.map((v) => v.key)).size).toBe(d.vaults.length);
    }
  });
});

// The per-chain vault selection (`mysun.vault.selected`, resolveVault / selectVault / parseVaultSelection)
// is gone: nothing read it — each vault page reads the vault in its URL. What remains is the chain
// selection (Markets follows it), covered by multichain.test.ts → resolveTargetChain.
describe('no per-chain vault selection', () => {
  it('the target chain carries no vault — nothing to remember, nothing that can point at a hidden one', () => {
    for (const selectedChainId of [LOCAL.chainId, 4663]) {
      const t = resolveTargetChain({ walletChainId: undefined, selectedChainId });
      expect('vault' in t).toBe(false);
      expect(t.deployment?.vaults[0]?.vault).toBe(defaultVault(selectedChainId)?.vault);
    }
  });
});

describe('sync:shared — idempotent, and generated.ts is what it renders today', () => {
  it('renders the committed src/config/generated.ts byte for byte, twice', () => {
    const inputs = loadShared(sharedPath());
    const once = renderGenerated(inputs);
    const twice = renderGenerated(loadShared(sharedPath()));
    expect(twice).toBe(once);
    const committed = readFileSync(fileURLToPath(new URL('../config/generated.ts', import.meta.url)), 'utf8');
    expect(once).toBe(committed);
  });

  it('staging: generated.ts carries `staging: true` exactly where the registry does — never on the local stack', () => {
    const registry = JSON.parse(shared('deployments.json')) as {
      chains: Record<string, { vaults?: { key: string; staging?: boolean }[] }>;
    };
    for (const d of DEPLOYMENTS) {
      const flagged = d.vaults.filter((v) => 'staging' in v);
      expect(flagged.every((v) => v.staging === true)).toBe(true);
      const expected = d.local ? [] : (registry.chains[String(d.chainId)]?.vaults ?? []).filter((v) => v.staging === true).map((v) => v.key);
      expect(flagged.map((v) => v.key), `chain ${d.chainId}`).toEqual(expected);
    }
    expect(DEPLOYMENTS.find((d) => d.chainId === 4663)!.vaults.some((v) => v.staging)).toBe(true);
  });

  it('input key order does not change the output (forge alphabetises the local file)', () => {
    const inputs = loadShared(sharedPath());
    const shuffled = {
      ...inputs,
      chains: inputs.chains.map((c) => ({
        ...c,
        vaults: c.vaults?.map((v) => {
          const { vault: addr, keeper, implementation, receipt, label, key, planExecutor, demoUser, staging } = v;
          return { ...(staging ? { staging } : {}), vault: addr, keeper, implementation, receipt: { symbol: receipt.symbol, name: receipt.name }, label, key, ...(planExecutor ? { planExecutor } : {}), ...(demoUser ? { demoUser } : {}) };
        }),
      })),
    };
    expect(renderGenerated(shuffled)).toBe(renderGenerated(inputs));
  });

  it('--prod (omitLocal): the production-bundle variant carries no demo-chain data at all', () => {
    const inputs = loadShared(sharedPath());
    const local = inputs.chains.find((c) => c.local);
    expect(local).toBeDefined();
    const prod = renderGenerated(inputs, { omitLocal: true });
    expect(prod).not.toContain(String(LOCAL.chainId));
    expect(prod).not.toContain(local!.name);
    expect(prod).not.toContain(local!.rpcUrl);
    for (const v of LOCAL.vaults) expect(prod.toLowerCase()).not.toContain(v.vault.toLowerCase());
    expect(prod).toContain('PRODUCTION VARIANT');
    // mainnet is untouched, and the default render is unaffected by the option's existence
    for (const key of MAIN_KEYS) expect(prod).toContain(`"key": "${key}"`);
    expect(renderGenerated(inputs, { omitLocal: false })).toBe(renderGenerated(inputs));
  });
});

describe('periphery (zaps + PlanExecutor) — registry entries and the local overlay, still v2', () => {
  const registry = () => registryText({ '10': chain([vault(1)]) });
  const local = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({ version: 2, chainId: 10, rpcUrl: 'http://127.0.0.1:9999', vaults: [vault(7)], ...extra });
  const overlay = (extra: Record<string, unknown> = {}) => buildRegistry({ registryText: registry(), localText: local(extra) })[0];

  it('a deployed chain may list one or both zap contracts; they are taken verbatim', () => {
    const [both] = buildRegistry({ registryText: registryText({ '10': chain([vault(1)], { periphery: { zapIn: A(4), zapOut: A(5) } }) }) });
    expect(both.periphery).toEqual({ zapIn: A(4), zapOut: A(5) });
    const [one] = buildRegistry({ registryText: registryText({ '10': chain([vault(1)], { periphery: { zapOut: A(5) } }) }) });
    expect(one.periphery).toEqual({ zapOut: A(5) });
    expect('zapIn' in (one.periphery ?? {})).toBe(false);
  });

  it('a planExecutor alone satisfies "at least one", and rides along with the zaps', () => {
    const withPeriphery = (p: unknown) => buildRegistry({ registryText: registryText({ '10': chain([vault(1)], { periphery: p }) }) })[0];
    expect(withPeriphery({ planExecutor: A(6) }).periphery).toEqual({ planExecutor: A(6) });
    expect(withPeriphery({ zapIn: A(4), zapOut: A(5), planExecutor: A(6) }).periphery).toEqual({ zapIn: A(4), zapOut: A(5), planExecutor: A(6) });
  });

  it('periphery is for deployed chains only — a planned entry rejects it', () => {
    expect(() =>
      buildRegistry({ registryText: registryText({ '10': chain(undefined, { status: 'planned', periphery: { zapIn: A(4) } }) }) }),
    ).toThrow('deployments.json: chains.10.periphery given for a chain with status "planned"');
  });

  it('fails loudly: bad shape, unknown key, bad address, zero address, or nothing at all', () => {
    const withPeriphery = (p: unknown) => () => buildRegistry({ registryText: registryText({ '10': chain([vault(1)], { periphery: p }) }) });
    expect(withPeriphery('0x1')).toThrow('deployments.json: chains.10.periphery must be an object { zapIn?, zapOut?, planExecutor? }');
    expect(withPeriphery({ zap: A(4) })).toThrow('deployments.json: chains.10.periphery.zap is not a known key (allowed: zapIn, zapOut, planExecutor)');
    expect(withPeriphery({ zapIn: 'nope' })).toThrow('deployments.json: chains.10.periphery.zapIn is not an address');
    expect(withPeriphery({ zapIn: `0x${'0'.repeat(40)}` })).toThrow('deployments.json: chains.10.periphery.zapIn must not be the zero address');
    expect(withPeriphery({ planExecutor: 'nope' })).toThrow('deployments.json: chains.10.periphery.planExecutor is not an address');
    expect(withPeriphery({ zapIn: A(4), planExecutor: `0x${'0'.repeat(40)}` })).toThrow('deployments.json: chains.10.periphery.planExecutor must not be the zero address');
    expect(withPeriphery({})).toThrow('deployments.json: chains.10.periphery must carry at least one of zapIn, zapOut, planExecutor');
  });

  it('the local overlay replaces the entry object, and keeps the registry one when it has none', () => {
    const withBase = () => registryText({ '10': chain([vault(1)], { periphery: { zapIn: A(4), zapOut: A(5) } }) });
    expect(buildRegistry({ registryText: withBase(), localText: local({ periphery: { zapIn: A(6) } }) })[0].periphery).toEqual({ zapIn: A(6) });
    expect(buildRegistry({ registryText: withBase(), localText: local() })[0].periphery).toEqual({ zapIn: A(4), zapOut: A(5) });
    expect(overlay({ periphery: { zapOut: A(7) } })).toMatchObject({ local: true, periphery: { zapOut: A(7) } });
  });

  it('the generator emits periphery only when the chain has it', () => {
    const inputs = loadShared(sharedPath());
    const withZap = renderGenerated({ chains: [overlay({ periphery: { zapIn: A(4), zapOut: A(5) } })], abis: inputs.abis });
    expect(withZap).toContain('"periphery": {');
    expect(withZap).toContain(`"zapIn": "${A(4)}"`);
    const withExecutor = renderGenerated({ chains: [overlay({ periphery: { planExecutor: A(6) } })], abis: inputs.abis });
    expect(withExecutor).toContain(`"planExecutor": "${A(6)}"`);
    expect(withExecutor).toContain('planExecutor?: `0x${string}`;');
    const plain = renderGenerated({ chains: [overlay()], abis: inputs.abis });
    expect(plain).not.toContain('"periphery"');
  });
});
