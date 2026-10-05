/**
 * Multi-vault: registry v2 (a `vaults` list per deployed chain) — every validation failure class, the
 * local overlay, the generated helpers, the per-chain selection rule, and the generator's
 * idempotency. All node, no wallet, no chain.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEPLOYMENTS, defaultVault, findVault, vaultsForChain } from '@/config/generated';
import { resolveTargetChain } from '@/chain/targetChain';
import { VAULT_SELECTION_KEY, parseVaultSelection, resolveVault, selectVault } from '@/chain/vaultSelection';
import { buildRegistry, findDuplicateKey } from '../../scripts/registry';
import { loadShared, renderGenerated } from '../../scripts/generate';

const sharedPath = (name = '') => fileURLToPath(new URL(`../../../shared/${name}`, import.meta.url));
const shared = (name: string) => readFileSync(sharedPath(name), 'utf8');
const LOCAL = JSON.parse(shared('deployment.local.json')) as {
  chainId: number;
  vaults: { key: string; vault: string; receipt: { name: string; symbol: string } }[];
};
/** The mainnet (4663) registry vault — deployment.local.json has no say here. */
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

  it('unknown keys are rejected — including the v1 address keys', () => {
    expect(withVaults([vault(1, { usdg: A(3) })])).toThrow(
      'deployments.json: chains.10.vaults[0].usdg is not a known key (allowed: key, label, receipt, vault, implementation, keeper, demoUser)',
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
    expect(vaultsForChain(4663).map((v) => v.key)).toEqual([MAIN.key]); // the mainnet deployment
    expect(vaultsForChain(1)).toEqual([]);
    expect(vaultsForChain(undefined)).toEqual([]);
  });

  it('defaultVault: the first vault listed', () => {
    expect(defaultVault(localId)?.vault).toBe(LOCAL.vaults[0].vault);
    expect(defaultVault(4663)?.vault).toBe(MAIN.vault);
  });

  it('findVault: exact key on that chain only — no fallback', () => {
    expect(findVault(localId, 'stocks')?.receipt.symbol).toBe(LOCAL.vaults.find((v) => v.key === 'stocks')?.receipt.symbol);
    expect(findVault(localId, 'demo')?.receipt.symbol).toBe(LOCAL.vaults.find((v) => v.key === 'demo')?.receipt.symbol);
    expect(findVault(localId, 'stocks')?.receipt.symbol).not.toBe(findVault(localId, 'demo')?.receipt.symbol);
    expect(findVault(localId, 'nope')).toBeUndefined();
    expect(findVault(localId, 'STOCKS')).toBeUndefined();
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

describe('vault selection — per chain, default = first, anything invalid falls back', () => {
  const localId = LOCAL.chainId;
  const [first, second] = LOCAL.vaults;

  it('resolveVault: nothing selected → the first vault', () => {
    expect(resolveVault(localId, {})?.key).toBe(first.key);
    expect(resolveVault(localId, undefined)?.key).toBe(first.key);
  });

  it('resolveVault: a valid selection wins', () => {
    expect(resolveVault(localId, { [localId]: second.key })?.vault).toBe(second.vault);
  });

  it('resolveVault: a stale or garbage key falls back to the default, never throws', () => {
    expect(resolveVault(localId, { [localId]: 'vanished' })?.key).toBe(first.key);
    expect(resolveVault(localId, { [localId]: '' })?.key).toBe(first.key);
  });

  it('resolveVault: choices are per chain — another chain’s choice does not leak', () => {
    expect(resolveVault(localId, { '4663': second.key })?.key).toBe(first.key);
  });

  it('resolveVault: no deployment → no vault; a stale key falls back to the default', () => {
    expect(resolveVault(4663, { '4663': 'demo' })?.vault).toBe(MAIN.vault); // 'demo' names nothing on 4663
    expect(resolveVault(1, {})).toBeUndefined();
    expect(resolveVault(undefined, {})).toBeUndefined();
  });

  it('selectVault: records a valid key, ignores an invalid one, keeps identity when unchanged', () => {
    const empty = {};
    const picked = selectVault(empty, localId, second.key);
    expect(picked).toEqual({ [localId]: second.key });
    expect(empty).toEqual({}); // not mutated
    expect(selectVault(picked, localId, second.key)).toBe(picked);
    expect(selectVault(picked, localId, 'vanished')).toBe(picked);
    expect(selectVault(picked, 4663, 'demo')).toBe(picked); // 'demo' names nothing on 4663 — ignored
    expect(selectVault(picked, 4663, 'main')).toEqual({ ...picked, '4663': 'main' });
    expect(selectVault({ '4663': 'x' }, localId, first.key)).toEqual({ '4663': 'x', [localId]: first.key });
  });

  it('parseVaultSelection: tolerant of anything storage may hold', () => {
    expect(parseVaultSelection(null)).toEqual({});
    expect(parseVaultSelection(undefined)).toEqual({});
    expect(parseVaultSelection('')).toEqual({});
    expect(parseVaultSelection('not json')).toEqual({});
    expect(parseVaultSelection('[]')).toEqual({});
    expect(parseVaultSelection('"stocks"')).toEqual({});
    expect(parseVaultSelection('null')).toEqual({});
    expect(parseVaultSelection(JSON.stringify({ [localId]: 'stocks' }))).toEqual({ [localId]: 'stocks' });
    expect(
      parseVaultSelection(JSON.stringify({ [localId]: 5, abc: 'demo', '0x1': 'demo', '046630': 'demo', '1': 'Bad_Key', '10': 'ok-key' })),
    ).toEqual({ '10': 'ok-key' });
  });

  it('round trip through storage text', () => {
    const picked = selectVault({}, localId, second.key);
    expect(resolveVault(localId, parseVaultSelection(JSON.stringify(picked)))?.key).toBe(second.key);
    expect(VAULT_SELECTION_KEY).toBe('mysun.vault.selected');
  });

  it('resolveTargetChain carries the resolved vault for the resolved chain', () => {
    const t = (walletChainId: number | undefined, selectedChainId: number, selectedVaults = {}) =>
      resolveTargetChain({ walletChainId, selectedChainId, selectedVaults }).vault?.key;
    expect(t(undefined, localId)).toBe(first.key);
    expect(t(undefined, localId, { [localId]: second.key })).toBe(second.key);
    // Wallet on the local deployment wins over the selected chain; the vault choice still applies.
    expect(t(localId, 4663, { [localId]: second.key })).toBe(second.key);
    // No wallet: the selection stands — 4663 is its own deployment, on its own default vault.
    expect(t(undefined, 4663, { [localId]: second.key })).toBe(MAIN.key);
    // Omitting the selection entirely = defaults.
    expect(resolveTargetChain({ walletChainId: undefined, selectedChainId: localId }).vault?.key).toBe(first.key);
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

  it('input key order does not change the output (forge alphabetises the local file)', () => {
    const inputs = loadShared(sharedPath());
    const shuffled = {
      ...inputs,
      chains: inputs.chains.map((c) => ({
        ...c,
        vaults: c.vaults?.map((v) => {
          const { vault: addr, keeper, implementation, receipt, label, key, demoUser } = v;
          return { vault: addr, keeper, implementation, receipt: { symbol: receipt.symbol, name: receipt.name }, label, key, ...(demoUser ? { demoUser } : {}) };
        }),
      })),
    };
    expect(renderGenerated(shuffled)).toBe(renderGenerated(inputs));
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
