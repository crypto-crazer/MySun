/**
 * The chain registry (src/registry.ts), schema v2: parse + validate `deployments.json` (per-chain
 * `vaults` lists), merge the `deployment.local.json` overlay, and select the chain — and the vault
 * on it — the keeper acts on. All in-memory — the module is pure; the real shared/ files are
 * exercised in config.registry.test.ts.
 */
import { describe, expect, it } from 'vitest';

import {
  RegistryError,
  VAULT_KEYS,
  buildRegistry,
  findDuplicateKey,
  selectChain,
  selectVault,
  type RegistryChain,
} from '../../src/registry.js';

const A = (n: number): string => `0x${n.toString(16).padStart(40, '0')}`;

/** A valid v2 vault entry; `base` spreads its addresses so two vaults never share one. */
const vault = (key: string, base: number, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  key,
  label: `${key} basket`,
  receipt: { name: `migo-${key}`, symbol: `m${key.toUpperCase()}` },
  vault: A(base),
  implementation: A(base + 1),
  keeper: A(base + 2),
  demoUser: A(base + 3),
  ...over,
});
const VAULTS = [vault('demo', 0x10)];
const LOCAL_VAULTS = [vault('demo', 0x100), vault('stocks', 0x200)];

const MAINNET = {
  name: 'Robinhood Chain',
  rpcUrl: 'https://rpc.mainnet.chain.robinhood.com',
  testnet: false,
  status: 'planned',
};
const LOCAL = {
  name: 'Localhost',
  rpcUrl: 'http://127.0.0.1:8547',
  testnet: true,
  status: 'deployed',
};

const registry = (chains: Record<string, unknown>, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ version: 2, chains, ...extra });
const overlay = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ version: 2, chainId: 46630, rpcUrl: 'http://127.0.0.1:9999', vaults: LOCAL_VAULTS, ...over });

/** The repo's current shape: mainnet planned, local deployed via the overlay (two vaults). */
const repoLike = (): RegistryChain[] =>
  buildRegistry({ registryText: registry({ 4663: MAINNET, 46630: LOCAL }), localText: overlay() });

/** Build a registry whose only chain is deployed with the given vault list. */
const withVaults = (vaults: unknown): (() => RegistryChain[]) => () =>
  buildRegistry({ registryText: registry({ 46630: { ...LOCAL, vaults } }) });

describe('buildRegistry — parse + validate', () => {
  it('accepts a valid registry and sorts by chain id', () => {
    const chains = buildRegistry({
      registryText: registry({
        46630: { ...LOCAL, vaults: VAULTS },
        4663: { ...MAINNET, explorerUrl: 'https://explorer.example' },
      }),
    });
    expect(chains.map((c) => c.chainId)).toEqual([4663, 46630]);
    expect(chains[0]).toEqual({
      chainId: 4663,
      name: 'Robinhood Chain',
      rpcUrl: MAINNET.rpcUrl,
      testnet: false,
      status: 'planned',
      explorerUrl: 'https://explorer.example',
    });
    expect(chains[1]?.vaults?.[0]?.vault).toBe(A(0x10));
    expect(chains[1]?.local).toBeUndefined();
  });

  it.each([
    ['invalid JSON', '{ "version": 2, ', /deployments\.json: invalid JSON/],
    ['a non-object root', '[]', /deployments\.json: \(root\) must be an object/],
    [
      'version != 2 (a stale v1 registry)',
      registry({ 4663: MAINNET }, { version: 1 }),
      /deployments\.json: version must be 2 \(got 1\) — v2 lists vaults per chain/,
    ],
    ['missing version', JSON.stringify({ chains: { 4663: MAINNET } }), /deployments\.json: version must be 2 \(got undefined\)/],
    ['missing chains', JSON.stringify({ version: 2 }), /deployments\.json: chains must be an object keyed by chain id/],
    ['an empty chains map', registry({}), /deployments\.json: chains must list at least one chain/],
    ['a duplicated key', '{"version":2,"chains":{"4663":{},"4663":{}}}', /deployments\.json: chains\.4663 is defined twice/],
  ])('rejects %s', (_label, text, message) => {
    expect(() => buildRegistry({ registryText: text })).toThrow(message);
  });

  it.each(['04663', '0x1237', 'abc', '-1', '0', '1.5'])('rejects non-canonical chain id key "%s"', (key) => {
    expect(() => buildRegistry({ registryText: registry({ [key]: MAINNET }) })).toThrow(
      new RegExp(`deployments\\.json: chains\\.${key.replace('.', '\\.')} is not a numeric chain id`),
    );
  });

  it.each([
    ['empty name', { name: '  ' }, /chains\.4663\.name must be a non-empty string/],
    ['missing name', { name: undefined }, /chains\.4663\.name must be a non-empty string/],
    ['non-http rpcUrl', { rpcUrl: 'ws://node:8546' }, /chains\.4663\.rpcUrl must be an http\(s\) URL/],
    ['non-http explorerUrl', { explorerUrl: 'explorer.example' }, /chains\.4663\.explorerUrl must be an http\(s\) URL/],
    ['non-boolean testnet', { testnet: 'no' }, /chains\.4663\.testnet must be true or false/],
    ['unknown status', { status: 'live' }, /chains\.4663\.status must be one of planned \| deployed \(got "live"\)/],
    ['an unknown key', { vault: A(1) }, /chains\.4663\.vault is not a known key/],
    ['the v1 addresses key', { addresses: {} }, /chains\.4663\.addresses is not a known key \(allowed: .*vaults, periphery\)/],
  ])('rejects a chain entry with %s', (_label, over, message) => {
    const entry = { ...MAINNET, ...over };
    expect(() => buildRegistry({ registryText: registry({ 4663: entry }) })).toThrow(message);
  });

  it('forbids vaults on a planned chain', () => {
    expect(() =>
      buildRegistry({ registryText: registry({ 4663: { ...MAINNET, vaults: VAULTS } }) }),
    ).toThrow(/chains\.4663\.vaults given for a chain with status "planned"/);
  });

  it('requires vaults on a deployed chain (when no overlay supplies them)', () => {
    expect(() => buildRegistry({ registryText: registry({ 46630: LOCAL }) })).toThrow(
      /deployments\.json: chains\.46630\.vaults is missing for a "deployed" chain/,
    );
  });

  it('throws RegistryError, labelled with the file name it was given', () => {
    try {
      buildRegistry({ registryText: registry({}), registryLabel: 'custom-registry.json' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RegistryError);
      expect((err as Error).message).toBe('custom-registry.json: chains must list at least one chain');
    }
  });
});

describe('buildRegistry — v2 vault entries: every failure class fails loudly, with the path', () => {
  it('keeps every vault in registry order, trimmed, with its receipt; demoUser is optional', () => {
    const { demoUser: _dropped, ...noDemoUser } = vault('stocks', 0x20);
    const chains = withVaults([
      vault('demo', 0x10, { label: '  Demo basket ', receipt: { name: ' sunEthLP ', symbol: 'sunEthLP' } }),
      noDemoUser,
    ])();
    expect(chains[0]?.vaults).toEqual([
      {
        key: 'demo',
        label: 'Demo basket',
        receipt: { name: 'sunEthLP', symbol: 'sunEthLP' },
        vault: A(0x10),
        implementation: A(0x11),
        keeper: A(0x12),
        demoUser: A(0x13),
      },
      {
        key: 'stocks',
        label: 'stocks basket',
        receipt: { name: 'migo-stocks', symbol: 'mSTOCKS' },
        vault: A(0x20),
        implementation: A(0x21),
        keeper: A(0x22),
      },
    ]);
    expect('demoUser' in chains[0]!.vaults![1]!).toBe(false);
  });

  it.each([
    ['not an array', { demo: vault('demo', 0x10) }, /chains\.46630\.vaults must be an array of vault entries/],
    ['empty', [], /chains\.46630\.vaults must list at least one vault/],
    ['an entry that is not an object', ['demo'], /chains\.46630\.vaults\[0\] must be an object/],
  ])('vaults list: rejects %s', (_label, vaults, message) => {
    expect(withVaults(vaults)).toThrow(message);
  });

  it.each([
    ['missing', undefined],
    ['uppercase', 'Demo'],
    ['leading digit', '1demo'],
    ['whitespace', 'my vault'],
    ['underscore', 'my_vault'],
    ['non-string', 7],
  ])('key: rejects a %s key', (_label, key) => {
    expect(withVaults([vault('demo', 0x10, { key })])).toThrow(
      /chains\.46630\.vaults\[0\]\.key must be a lowercase slug matching/,
    );
  });

  it('key: unique per chain (but the same key on two chains is fine)', () => {
    expect(withVaults([vault('demo', 0x10), vault('demo', 0x20)])).toThrow(
      /chains\.46630\.vaults\[1\]\.key "demo" is already used by chains\.46630\.vaults\[0\] — keys are unique per chain/,
    );
    const chains = buildRegistry({
      registryText: registry({
        777: { ...LOCAL, vaults: [vault('demo', 0x10)] },
        46630: { ...LOCAL, vaults: [vault('demo', 0x20)] },
      }),
    });
    expect(chains.map((c) => c.vaults?.[0]?.key)).toEqual(['demo', 'demo']);
  });

  it('vault address: not listed twice on one chain (case-insensitive)', () => {
    const upper = `0x${A(0x10).slice(2).toUpperCase()}`;
    expect(withVaults([vault('demo', 0x10), vault('stocks', 0x20, { vault: upper })])).toThrow(
      /chains\.46630\.vaults\[1\]\.vault 0x0+10 is already listed as chains\.46630\.vaults\[0\] \("demo"\)/,
    );
  });

  it.each([
    ['empty', '   '],
    ['missing', undefined],
    ['non-string', 3],
  ])('label: rejects an %s label', (_label, label) => {
    expect(withVaults([vault('demo', 0x10, { label })])).toThrow(
      /chains\.46630\.vaults\[0\]\.label must be a non-empty string/,
    );
  });

  it.each([
    ['missing', undefined, /vaults\[0\]\.receipt is missing/],
    ['a string', 'sunEthLP', /vaults\[0\]\.receipt must be an object \{ name, symbol \}/],
    ['an empty name', { name: ' ', symbol: 'sunEthLP' }, /vaults\[0\]\.receipt\.name must be a non-empty string/],
    ['a missing symbol', { name: 'sunEthLP' }, /vaults\[0\]\.receipt\.symbol must be a non-empty string/],
    ['an extra key', { name: 'sunEthLP', symbol: 'sunEthLP', decimals: 18 }, /vaults\[0\]\.receipt\.decimals is not a known key/],
  ])('receipt: rejects %s', (_label, receipt, message) => {
    expect(withVaults([vault('demo', 0x10, { receipt })])).toThrow(message);
  });

  it.each(['vault', 'implementation', 'keeper'])('%s: a required address', (k) => {
    expect(withVaults([vault('demo', 0x10, { [k]: undefined })])).toThrow(
      new RegExp(`chains\\.46630\\.vaults\\[0\\]\\.${k} is missing`),
    );
    expect(withVaults([vault('demo', 0x10, { [k]: '0x1234' })])).toThrow(
      new RegExp(`chains\\.46630\\.vaults\\[0\\]\\.${k} is not an address \\(got "0x1234"\\)`),
    );
  });

  it('demoUser: an address when given', () => {
    expect(withVaults([vault('demo', 0x10, { demoUser: 'alice' })])).toThrow(
      /chains\.46630\.vaults\[0\]\.demoUser is not an address/,
    );
  });

  it.each(['usdg', 'weth', 'adapterV3', 'adapterV4', 'owner', 'treasury'])(
    'rejects unknown vault keys — including the v1 address key "%s"',
    (k) => {
      expect(withVaults([vault('demo', 0x10, { [k]: A(99) })])).toThrow(
        new RegExp(`chains\\.46630\\.vaults\\[0\\]\\.${k} is not a known key \\(allowed: ${VAULT_KEYS.join(', ')}\\)`),
      );
    },
  );

  it('a key written twice inside a vault entry is caught before JSON.parse can hide it', () => {
    const text = `{"version":2,"chains":{"46630":{"name":"L","rpcUrl":"http://x","testnet":true,"status":"deployed","vaults":[${JSON.stringify(
      vault('demo', 0x10),
    )},{"key":"stocks","key":"demo"}]}}}`;
    expect(() => buildRegistry({ registryText: text })).toThrow(
      /deployments\.json: chains\.46630\.vaults\[1\]\.key is defined twice/,
    );
  });
});

describe('buildRegistry — local overlay merge (v2)', () => {
  it('turns the matching entry into deployed + local, with the overlay rpcUrl and vaults', () => {
    const chains = buildRegistry({
      registryText: registry({ 4663: MAINNET, 46630: { ...LOCAL, status: 'planned' } }),
      localText: overlay(),
    });
    const local = chains.find((c) => c.chainId === 46630)!;
    expect(local).toMatchObject({
      name: LOCAL.name, // the registry is the only place a chain gets its name
      testnet: true,
      status: 'deployed',
      local: true,
      rpcUrl: 'http://127.0.0.1:9999',
    });
    expect(local.vaults?.map((v) => [v.key, v.vault])).toEqual([
      ['demo', A(0x100)],
      ['stocks', A(0x200)],
    ]);
    // Other entries are untouched.
    expect(chains.find((c) => c.chainId === 4663)).toMatchObject({ status: 'planned' });
    expect(chains.find((c) => c.chainId === 4663)?.local).toBeUndefined();
  });

  it('REPLACES the vault list the registry already had for that chain', () => {
    const chains = buildRegistry({
      registryText: registry({ 46630: { ...LOCAL, vaults: VAULTS } }),
      localText: overlay(),
    });
    expect(chains[0]?.vaults?.map((v) => v.vault)).toEqual([A(0x100), A(0x200)]);
  });

  it('rejects a local chain id that is not in the registry', () => {
    expect(() =>
      buildRegistry({
        registryText: registry({ 4663: MAINNET }),
        localText: overlay({ chainId: 31337 }),
      }),
    ).toThrow(
      'deployment.local.json: chainId 31337 has no entry in deployments.json — add it under chains.31337 first',
    );
  });

  it.each([
    ['invalid JSON', '{', /deployment\.local\.json: invalid JSON/],
    ['a stale v1 file (no version)', JSON.stringify({ chainId: 46630, rpcUrl: 'http://x', vault: A(1) }), /deployment\.local\.json: version must be 2 \(got undefined\) — v2 lists vaults per chain/],
    ['a string chainId', overlay({ chainId: '46630' }), /deployment\.local\.json: chainId must be a number/],
    ['a bad rpcUrl', overlay({ rpcUrl: 'localhost:8547' }), /deployment\.local\.json: rpcUrl must be an http\(s\) URL/],
    ['no vaults list', overlay({ vaults: undefined }), /deployment\.local\.json: vaults is missing/],
    ['an empty vaults list', overlay({ vaults: [] }), /deployment\.local\.json: vaults must list at least one vault/],
    ['a missing vault address', overlay({ vaults: [vault('demo', 1, { vault: undefined })] }), /deployment\.local\.json: vaults\[0\]\.vault is missing/],
    ['a malformed address', overlay({ vaults: [vault('demo', 1), vault('stocks', 9, { keeper: '0xnope' })] }), /deployment\.local\.json: vaults\[1\]\.keeper is not an address/],
    ['a duplicate key', overlay({ vaults: [vault('demo', 1), vault('demo', 9)] }), /deployment\.local\.json: vaults\[1\]\.key "demo" is already used by vaults\[0\]/],
    ['an unknown root key (e.g. a v1 flat address)', overlay({ vault: A(1) }), /deployment\.local\.json: vault is not a known key \(allowed: version, chainId, rpcUrl, vaults, fork, mintable, periphery\)/],
    ['a non-boolean fork flag', overlay({ fork: 'yes' }), /deployment\.local\.json: fork must be true or false when present \(got "yes"\)/],
    ['a non-boolean mintable flag', overlay({ mintable: 0 }), /deployment\.local\.json: mintable must be true or false when present \(got 0\)/],
    ['a null mintable flag', overlay({ mintable: null }), /deployment\.local\.json: mintable must be true or false when present \(got null\)/],
    ['a periphery that is not an object', overlay({ periphery: 'zap' }), /deployment\.local\.json: periphery must be an object \{ zapIn\?, zapOut\?, planExecutor\? \}/],
    ['a periphery with no address', overlay({ periphery: {} }), /deployment\.local\.json: periphery must carry at least one of zapIn, zapOut, planExecutor/],
    ['a zero planExecutor', overlay({ periphery: { planExecutor: `0x${'0'.repeat(40)}` } }), /deployment\.local\.json: periphery\.planExecutor must not be the zero address/],
  ])('rejects an overlay with %s', (_label, localText, message) => {
    expect(() =>
      buildRegistry({ registryText: registry({ 46630: LOCAL }), localText }),
    ).toThrow(message);
  });

  it('accepts the alphabetised key order forge writes (the real file)', () => {
    const sortKeys = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(sortKeys)
        : typeof v === 'object' && v !== null
          ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sortKeys(x)]))
          : v;
    const text = JSON.stringify(sortKeys(JSON.parse(overlay())), null, 2);
    const chains = buildRegistry({ registryText: registry({ 46630: LOCAL }), localText: text });
    expect(chains[0]?.vaults?.map((v) => v.key)).toEqual(['demo', 'stocks']);
  });

  describe('optional fork / mintable root flags (still v2; absent = mock stack)', () => {
    const local = (over: Record<string, unknown> = {}): RegistryChain =>
      buildRegistry({ registryText: registry({ 46630: LOCAL }), localText: overlay(over) })[0]!;

    it('absent: neither flag is carried', () => {
      const c = local();
      expect('fork' in c).toBe(false);
      expect('mintable' in c).toBe(false);
    });

    it('the fork file (fork: true, mintable: false) is accepted and both flags are carried', () => {
      expect(local({ fork: true, mintable: false })).toMatchObject({
        local: true,
        status: 'deployed',
        fork: true,
        mintable: false,
      });
    });

    it('explicit defaults (fork: false, mintable: true) are accepted and normalised away', () => {
      const c = local({ fork: false, mintable: true });
      expect('fork' in c).toBe(false);
      expect('mintable' in c).toBe(false);
    });

    it('the flags belong to the local overlay only — a registry chain entry rejects them', () => {
      expect(() => buildRegistry({ registryText: registry({ 46630: { ...LOCAL, fork: true } }) })).toThrow(
        /deployments\.json: chains\.46630\.fork is not a known key/,
      );
    });

    it('selectChain / selectVault are unaffected by the flags', () => {
      const chains = buildRegistry({
        registryText: registry({ 4663: MAINNET, 46630: LOCAL }),
        localText: overlay({ fork: true, mintable: false }),
      });
      const chain = selectChain(chains);
      expect(chain).toMatchObject({ chainId: 46630, fork: true, mintable: false });
      expect(selectVault(chain).key).toBe('demo');
    });
  });

  describe('periphery (zaps + PlanExecutor) — registry entries and the local overlay, still v2', () => {
    const chainPeriphery = (periphery: unknown): (() => RegistryChain[]) => () =>
      buildRegistry({ registryText: registry({ 46630: { ...LOCAL, vaults: VAULTS, periphery } }) });

    it('a deployed chain entry carries zapIn / zapOut verbatim', () => {
      const [both] = chainPeriphery({ zapIn: A(4), zapOut: A(5) })();
      expect(both?.periphery).toEqual({ zapIn: A(4), zapOut: A(5) });
      const [one] = chainPeriphery({ zapOut: A(5) })();
      expect(one?.periphery).toEqual({ zapOut: A(5) });
      expect('zapIn' in (one?.periphery ?? {})).toBe(false);
    });

    it('a planExecutor alone satisfies "at least one", and rides along with the zaps', () => {
      const [alone] = chainPeriphery({ planExecutor: A(6) })();
      expect(alone?.periphery).toEqual({ planExecutor: A(6) });
      const [all] = chainPeriphery({ zapIn: A(4), zapOut: A(5), planExecutor: A(6) })();
      expect(all?.periphery).toEqual({ zapIn: A(4), zapOut: A(5), planExecutor: A(6) });
    });

    it('is rejected on a planned chain', () => {
      expect(() =>
        buildRegistry({ registryText: registry({ 4663: { ...MAINNET, periphery: { zapIn: A(4) } } }) }),
      ).toThrow(
        'deployments.json: chains.4663.periphery given for a chain with status "planned" — set status to "deployed"',
      );
    });

    it('rejects a malformed periphery', () => {
      expect(chainPeriphery('0x1')).toThrow(
        'deployments.json: chains.46630.periphery must be an object { zapIn?, zapOut?, planExecutor? }',
      );
      expect(chainPeriphery({ zap: A(4) })).toThrow(
        'deployments.json: chains.46630.periphery.zap is not a known key (allowed: zapIn, zapOut, planExecutor)',
      );
      expect(chainPeriphery({ zapIn: 'nope' })).toThrow(
        'deployments.json: chains.46630.periphery.zapIn is not an address',
      );
      expect(chainPeriphery({ zapIn: `0x${'0'.repeat(40)}` })).toThrow(
        'deployments.json: chains.46630.periphery.zapIn must not be the zero address',
      );
      expect(chainPeriphery({ planExecutor: 'nope' })).toThrow(
        'deployments.json: chains.46630.periphery.planExecutor is not an address',
      );
      expect(chainPeriphery({ zapIn: A(4), planExecutor: `0x${'0'.repeat(40)}` })).toThrow(
        'deployments.json: chains.46630.periphery.planExecutor must not be the zero address',
      );
      expect(chainPeriphery({})).toThrow(
        'deployments.json: chains.46630.periphery must carry at least one of zapIn, zapOut, planExecutor',
      );
    });

    it('a local periphery replaces the entry object', () => {
      const chains = buildRegistry({
        registryText: registry({ 46630: { ...LOCAL, periphery: { zapIn: A(4), zapOut: A(5) } } }),
        localText: overlay({ periphery: { zapIn: A(6) } }),
      });
      expect(chains[0]?.periphery).toEqual({ zapIn: A(6) });
    });

    it('the overlay periphery is validated like the entry one', () => {
      expect(() =>
        buildRegistry({ registryText: registry({ 46630: LOCAL }), localText: overlay({ periphery: {} }) }),
      ).toThrow('deployment.local.json: periphery must carry at least one of zapIn, zapOut, planExecutor');
    });
  });

  it('uses the overlay label it was given in errors', () => {
    expect(() =>
      buildRegistry({
        registryText: registry({ 46630: LOCAL }),
        localText: '{',
        localLabel: 'my-stack.json',
      }),
    ).toThrow(/^my-stack\.json: invalid JSON/);
  });
});

describe('selectChain', () => {
  const oneAndLocal = (): RegistryChain[] =>
    buildRegistry({
      registryText: registry({
        1: { ...MAINNET, name: 'One', status: 'deployed', vaults: VAULTS },
        46630: LOCAL,
      }),
      localText: overlay(),
    });

  it('env chainId wins over the local preference', () => {
    expect(selectChain(oneAndLocal(), { chainId: 1 }).name).toBe('One');
  });

  it('prefers the local entry when no chainId is requested', () => {
    const picked = selectChain(oneAndLocal());
    expect(picked.chainId).toBe(46630);
    expect(picked.local).toBe(true);
    expect(picked.vaults[0]?.vault).toBe(A(0x100));
  });

  it('falls back to the first deployed chain (ascending id) without a local entry', () => {
    const chains = buildRegistry({
      registryText: registry({
        4663: MAINNET,
        20: { ...LOCAL, name: 'Twenty', vaults: VAULTS },
        10: { ...LOCAL, name: 'Ten', vaults: VAULTS },
      }),
    });
    expect(selectChain(chains).name).toBe('Ten');
  });

  it('preferLocal: false takes the first deployed chain even when a local entry exists', () => {
    const chains = buildRegistry({
      registryText: registry({ 10: { ...LOCAL, name: 'Ten', vaults: VAULTS }, 46630: LOCAL }),
      localText: overlay(),
    });
    expect(selectChain(chains, { preferLocal: false }).name).toBe('Ten');
    expect(selectChain(chains).chainId).toBe(46630);
  });

  it('refuses a requested chain that is only planned', () => {
    expect(() => selectChain(repoLike(), { chainId: 4663 })).toThrow(
      /^chain 4663 is planned — no deployment to act on \(deployments\.json lists "Robinhood Chain" with status "planned"; deployed: 46630\)$/,
    );
  });

  it('refuses a requested chain the registry does not list', () => {
    expect(() => selectChain(repoLike(), { chainId: 31337 })).toThrow(
      /chain 31337 is not in deployments\.json \(listed: 4663, 46630\)/,
    );
  });

  it('refuses when nothing is deployed at all', () => {
    const chains = buildRegistry({ registryText: registry({ 4663: MAINNET }) });
    expect(() => selectChain(chains)).toThrow(RegistryError);
    expect(() => selectChain(chains)).toThrow(/no deployed chain to act on/);
  });
});

describe('selectVault', () => {
  const local = (): RegistryChain => repoLike().find((c) => c.local === true)!;

  it('no key → the chain’s FIRST vault, in registry order', () => {
    expect(selectVault(local()).key).toBe('demo');
    expect(selectVault(local(), { key: undefined }).vault).toBe(A(0x100));
    // Order is the registry's, not alphabetical.
    const reversed = buildRegistry({
      registryText: registry({ 46630: LOCAL }),
      localText: overlay({ vaults: [...LOCAL_VAULTS].reverse() }),
    })[0]!;
    expect(selectVault(reversed).key).toBe('stocks');
  });

  it('an explicit key (env VAULT) wins over the default', () => {
    const picked = selectVault(local(), { key: 'stocks' });
    expect(picked).toMatchObject({
      key: 'stocks',
      vault: A(0x200),
      receipt: { name: 'migo-stocks', symbol: 'mSTOCKS' },
    });
  });

  it('an unknown key is an error that lists the available keys — never a silent fallback', () => {
    const run = () => selectVault(local(), { key: 'bonds' });
    expect(run).toThrow(RegistryError);
    expect(run).toThrow(
      /^vault "bonds" is not on chain 46630 \("Localhost"\) — available: demo, stocks$/,
    );
  });

  it('keys are exact — no case folding', () => {
    expect(() => selectVault(local(), { key: 'Stocks' })).toThrow(/available: demo, stocks/);
  });

  it('a chain with no vaults (planned) has nothing to select', () => {
    const planned = repoLike().find((c) => c.chainId === 4663)!;
    expect(() => selectVault(planned)).toThrow(
      /^chain 4663 \("Robinhood Chain"\) lists no vaults in deployments\.json \(status "planned"\)/,
    );
  });
});

describe('findDuplicateKey', () => {
  it('finds nested duplicates and ignores repeats across sibling objects', () => {
    expect(findDuplicateKey('{"a":{"x":1,"x":2}}')).toBe('a.x');
    expect(findDuplicateKey('{"a":{"x":1},"b":{"x":2}}')).toBeNull();
    expect(findDuplicateKey('{"a":[{"x":1},{"x":2}]}')).toBeNull();
    expect(findDuplicateKey('{"a":"has \\"quoted\\" text","a":1}')).toBe('a');
  });

  it('addresses array elements by index; commas inside strings do not shift it', () => {
    expect(findDuplicateKey('{"v":[{"k":1},{"k":2,"k":3}]}')).toBe('v[1].k');
    expect(findDuplicateKey('{"v":[{"s":"a,b,c"},{"s":1},{"s":2,"s":3}]}')).toBe('v[2].s');
    expect(findDuplicateKey('{"v":[[1,2],{"k":1,"k":2}]}')).toBe('v[1].k');
  });
});
