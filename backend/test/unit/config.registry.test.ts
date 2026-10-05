/**
 * Config ↔ chain registry (v2): `pickRegistryEntry` / `pickVault` (pure), `parseConfig` with a
 * registry entry, and `loadConfig` against real files in a temp dir — including env `VAULT` and its
 * interaction with `VAULT_ADDRESS`, the container case (env only, no registry on disk) and the
 * repo's own shared/deployments.json.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ConfigError,
  defaultRegistryPath,
  describeConfig,
  loadConfig,
  parseConfig,
  pickRegistryEntry,
  pickVault,
  registryPaths,
  type EnvRecord,
} from '../../src/config.js';
import { jsonReplacer } from '../../src/logger.js';
import { buildRegistry, RegistryError } from '../../src/registry.js';
import { DEPLOYMENT_PATH, REGISTRY_PATH, readDeployment } from '../integration/helpers.js';

// Anvil account #1 — publicly known test key, inert, LOCAL ONLY.
const ANVIL_KEY_1 = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const ANVIL_ADDR_1 = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

const A = (n: number): string => `0x${n.toString(16).padStart(40, '0')}`;
/** A v2 vault entry whose addresses start at `base`. */
const vault = (key: string, symbol: string, base: number) => ({
  key,
  label: `${key} basket`,
  receipt: { name: symbol, symbol },
  vault: A(base),
  implementation: A(base + 1),
  keeper: A(base + 2),
});

const REGISTRY = {
  version: 2,
  chains: {
    '4663': {
      name: 'Robinhood Chain',
      rpcUrl: 'https://rpc.mainnet.chain.robinhood.com',
      testnet: false,
      status: 'planned',
    },
    '777': {
      name: 'Some Testnet',
      rpcUrl: 'https://rpc.some-testnet.example',
      testnet: true,
      status: 'deployed',
      vaults: [vault('main', 'sunEthLP', 0x700)],
    },
    '46630': {
      name: 'Localhost',
      rpcUrl: 'http://127.0.0.1:8547',
      testnet: true,
      status: 'deployed',
    },
  },
};
const DEMO = vault('demo', 'sunEthLP', 0x4600);
const STOCKS = vault('stocks', 'sun5StocksLP', 0x4700);
const OVERLAY = { version: 2, chainId: 46630, rpcUrl: 'http://127.0.0.1:8547', vaults: [DEMO, STOCKS] };
const LOCAL_VAULT = DEMO.vault;
const STOCKS_VAULT = STOCKS.vault;

const chains = () =>
  buildRegistry({ registryText: JSON.stringify(REGISTRY), localText: JSON.stringify(OVERLAY) });

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A temp `shared/` dir holding the given registry and (optionally) the local overlay. */
function sharedDir(registry: unknown, overlay?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'mysun-keeper-registry-'));
  dirs.push(dir);
  if (registry !== undefined) writeFileSync(join(dir, 'deployments.json'), JSON.stringify(registry));
  if (overlay !== undefined) writeFileSync(join(dir, 'deployment.local.json'), JSON.stringify(overlay));
  return dir;
}

const identity: EnvRecord = { KEEPER_ADDRESS: ANVIL_ADDR_1 };

describe('pickRegistryEntry (pure)', () => {
  it('env CHAIN_ID wins', () => {
    expect(pickRegistryEntry({ CHAIN_ID: '777' }, chains())?.name).toBe('Some Testnet');
  });

  it('prefers the local entry, then the first deployed chain', () => {
    expect(pickRegistryEntry({}, chains())?.chainId).toBe(46630);
    const noLocal = buildRegistry({
      registryText: JSON.stringify({
        ...REGISTRY,
        chains: { '4663': REGISTRY.chains['4663'], '777': REGISTRY.chains['777'] },
      }),
    });
    expect(pickRegistryEntry({}, noLocal)?.chainId).toBe(777);
  });

  it('refuses a planned CHAIN_ID when the registry must supply the rest', () => {
    expect(() => pickRegistryEntry({ CHAIN_ID: '4663' }, chains())).toThrow(RegistryError);
    expect(() => pickRegistryEntry({ CHAIN_ID: '4663', RPC_URL: 'https://x' }, chains())).toThrow(
      /chain 4663 is planned — no deployment to act on/,
    );
  });

  it('env supplying CHAIN_ID + RPC_URL + VAULT_ADDRESS makes the registry name-only', () => {
    const full = { CHAIN_ID: '4663', RPC_URL: 'https://x', VAULT_ADDRESS: A(1) };
    expect(pickRegistryEntry(full, chains())?.name).toBe('Robinhood Chain'); // planned is fine here
    expect(pickRegistryEntry({ ...full, CHAIN_ID: '31337' }, chains())).toBeUndefined();
  });
});

describe('parseConfig with a registry entry', () => {
  const local = chains().find((c) => c.local === true)!;

  it('takes chainId, rpcUrl and vault from the entry when env leaves them unset', () => {
    const cfg = parseConfig(identity, { chain: local });
    expect(cfg.chainId).toBe(46630);
    expect(cfg.rpcUrl).toBe('http://127.0.0.1:8547');
    expect(cfg.vaultAddress).toBe(LOCAL_VAULT);
    expect(cfg.chain).toEqual({
      name: 'Localhost',
      status: 'deployed',
      local: true,
      testnet: true,
    });
  });

  it('env RPC_URL / VAULT_ADDRESS beat the entry, value by value', () => {
    const cfg = parseConfig(
      { ...identity, RPC_URL: 'http://host.docker.internal:8547', VAULT_ADDRESS: A(0xbeef) },
      { chain: local },
    );
    expect(cfg.rpcUrl).toBe('http://host.docker.internal:8547');
    expect(cfg.vaultAddress).toBe(A(0xbeef));
    expect(cfg.chain.name).toBe(local.name);
  });

  it('ignores a flat deployment file once a registry entry is given', () => {
    const cfg = parseConfig(identity, {
      chain: local,
      deployment: { vault: A(0xdead), chainId: 1, rpcUrl: 'http://elsewhere' },
    });
    expect(cfg.vaultAddress).toBe(LOCAL_VAULT);
    expect(cfg.chainId).toBe(46630);
  });

  it('rejects a CHAIN_ID that contradicts the entry it was handed', () => {
    expect(() => parseConfig({ ...identity, CHAIN_ID: '777' }, { chain: local })).toThrow(
      /CHAIN_ID 777 does not match the registry entry passed in \(chain 46630\)/,
    );
  });

  it('describeConfig names the chain and still omits the key', () => {
    const cfg = parseConfig({ KEEPER_PRIVATE_KEY: ANVIL_KEY_1 }, { chain: local });
    const described = describeConfig(cfg);
    expect(described).toMatchObject({
      chainId: 46630,
      chain: 'Localhost',
      chainStatus: 'deployed',
      chainLocal: true,
      chainTestnet: true,
      signer: 'configured',
    });
    expect(JSON.stringify(described, jsonReplacer)).not.toContain(ANVIL_KEY_1.slice(2, 20));
  });
});

describe('loadConfig — files on disk', () => {
  it('defaults to ../shared/deployments.json with the sibling deployment.local.json', () => {
    expect(defaultRegistryPath()).toBe(REGISTRY_PATH);
    expect(registryPaths({})).toMatchObject({
      registry: REGISTRY_PATH,
      overlay: DEPLOYMENT_PATH,
      registryExplicit: false,
      overlayExplicit: false,
    });
  });

  it("selects the repo registry's local entry with no chain env at all", () => {
    const cfg = loadConfig(identity);
    const local = readDeployment();
    expect(cfg.chainId).toBe(local.chainId);
    expect(cfg.rpcUrl).toBe(local.rpcUrl);
    expect(cfg.vaultAddress).toBe(local.vault);
    expect(cfg.chain).toMatchObject({ name: local.entry.name, local: true, status: 'deployed' });
  });

  it('DEPLOYMENTS_FILE: local entry preferred, overlay read from the sibling file', () => {
    const dir = sharedDir(REGISTRY, OVERLAY);
    const cfg = loadConfig({ ...identity, DEPLOYMENTS_FILE: join(dir, 'deployments.json') });
    expect(cfg.chainId).toBe(46630);
    expect(cfg.vaultAddress).toBe(LOCAL_VAULT);
  });

  it('CHAIN_ID from env selects another deployed chain', () => {
    const dir = sharedDir(REGISTRY, OVERLAY);
    const cfg = loadConfig({
      ...identity,
      DEPLOYMENTS_FILE: join(dir, 'deployments.json'),
      CHAIN_ID: '777',
    });
    expect(cfg.chainId).toBe(777);
    expect(cfg.rpcUrl).toBe('https://rpc.some-testnet.example');
    expect(cfg.vaultAddress).toBe(A(0x700));
    expect(cfg.chain).toEqual({ name: 'Some Testnet', status: 'deployed', local: false, testnet: true });
  });

  it('without an overlay the first deployed chain is selected', () => {
    const dir = sharedDir({ ...REGISTRY, chains: { '4663': REGISTRY.chains['4663'], '777': REGISTRY.chains['777'] } });
    const cfg = loadConfig({ ...identity, DEPLOYMENTS_FILE: join(dir, 'deployments.json') });
    expect(cfg.chainId).toBe(777);
  });

  it('DEPLOYMENT_FILE replaces the sibling overlay', () => {
    const dir = sharedDir(REGISTRY, OVERLAY);
    const other = join(dir, 'other-stack.json');
    writeFileSync(other, JSON.stringify({ ...OVERLAY, vaults: [{ ...DEMO, vault: A(0xabc) }] }));
    const cfg = loadConfig({
      ...identity,
      DEPLOYMENTS_FILE: join(dir, 'deployments.json'),
      DEPLOYMENT_FILE: other,
    });
    expect(cfg.vaultAddress).toBe(A(0xabc));
  });

  it('a planned CHAIN_ID is a ConfigError (exit 2) with the planned-chain message', () => {
    const dir = sharedDir(REGISTRY, OVERLAY);
    const run = () =>
      loadConfig({ ...identity, DEPLOYMENTS_FILE: join(dir, 'deployments.json'), CHAIN_ID: '4663' });
    expect(run).toThrow(ConfigError);
    expect(run).toThrow(/^chain 4663 is planned — no deployment to act on/);
  });

  it('an invalid registry is a ConfigError naming the file and path', () => {
    const dir = sharedDir({ ...REGISTRY, version: 1 });
    expect(() => loadConfig({ ...identity, DEPLOYMENTS_FILE: join(dir, 'deployments.json') })).toThrow(
      new ConfigError('deployments.json: version must be 2 (got 1) — v2 lists vaults per chain'),
    );
  });

  it('an overlay for a chain the registry lacks is a ConfigError', () => {
    const dir = sharedDir(REGISTRY, { ...OVERLAY, chainId: 31337 });
    expect(() => loadConfig({ ...identity, DEPLOYMENTS_FILE: join(dir, 'deployments.json') })).toThrow(
      /deployment\.local\.json: chainId 31337 has no entry in deployments\.json/,
    );
  });

  it('an explicit DEPLOYMENTS_FILE that does not exist is an error when the run needs it', () => {
    expect(() => loadConfig({ ...identity, DEPLOYMENTS_FILE: '/nope/deployments.json' })).toThrow(
      /DEPLOYMENTS_FILE \/nope\/deployments\.json could not be read/,
    );
  });

  it('no registry on disk but a flat DEPLOYMENT_FILE: the pre-registry behaviour still works', () => {
    // The pre-registry flat shape (vault/chainId/rpcUrl at the root), no deployments.json.
    const dir = sharedDir(undefined, { chainId: 46630, rpcUrl: 'http://127.0.0.1:8547', vault: LOCAL_VAULT });
    const cfg = loadConfig(
      { ...identity, DEPLOYMENT_FILE: join(dir, 'deployment.local.json') },
      join(dir, 'deployments.json'),
    );
    expect(cfg.chainId).toBe(46630);
    expect(cfg.vaultAddress).toBe(LOCAL_VAULT);
    expect(cfg.chain).toEqual({ name: 'Chain 46630', status: null, local: false, testnet: null });
  });
});

describe('loadConfig — container case (env only, no shared/ on disk)', () => {
  const env: EnvRecord = {
    ...identity,
    CHAIN_ID: '46630',
    RPC_URL: 'http://host.docker.internal:8547',
    VAULT_ADDRESS: A(0xc0ffee),
  };
  /** Default registry path inside an empty dir — what the image sees (no ../shared). */
  const noShared = (): string => join(sharedDir(undefined), 'deployments.json');

  it('loads exactly as parseConfig alone when env supplies chain, RPC and vault', () => {
    const cfg = loadConfig(env, noShared());
    expect(cfg).toEqual(parseConfig(env));
    expect(cfg.chainId).toBe(46630);
    expect(cfg.rpcUrl).toBe('http://host.docker.internal:8547');
    expect(cfg.vaultAddress).toBe(A(0xc0ffee));
    expect(cfg.chain).toEqual({ name: 'Chain 46630', status: null, local: false, testnet: null });
    expect(describeConfig(cfg).chainStatus).toBe('not-in-registry');
  });

  it('tolerates DEPLOYMENTS_FILE / DEPLOYMENT_FILE pointing at missing files when env is complete', () => {
    const cfg = loadConfig(
      { ...env, DEPLOYMENTS_FILE: '/nope/deployments.json', DEPLOYMENT_FILE: '/nope/local.json' },
      noShared(),
    );
    expect(cfg.vaultAddress).toBe(A(0xc0ffee));
  });

  it('fails the old way when env is incomplete and nothing is on disk', () => {
    const run = () => loadConfig({ ...identity, CHAIN_ID: '46630', RPC_URL: 'http://x' }, noShared());
    expect(run).toThrow(ConfigError);
    expect(run).toThrow(/VAULT_ADDRESS is required/);
  });

  it('with the repo registry present, env still wins and the registry only names the chain', () => {
    const cfg = loadConfig(env); // the repo's real shared/deployments.json
    expect(cfg.vaultAddress).toBe(A(0xc0ffee));
    expect(cfg.rpcUrl).toBe('http://host.docker.internal:8547');
    expect(cfg.chain.name).toBe(readDeployment().entry.name);
  });

  it('full env on a chain the registry lists as planned: env is authoritative', () => {
    const cfg = loadConfig({ ...env, CHAIN_ID: '4663', RPC_URL: 'https://rpc.example' });
    expect(cfg.chainId).toBe(4663);
    expect(cfg.chain).toEqual({ name: 'Robinhood Chain', status: 'planned', local: false, testnet: false });
    expect(describeConfig(cfg).chainStatus).toBe('planned'); // visible in the startup line
  });
});

describe('pickVault (pure) — env VAULT, the default, and VAULT_ADDRESS', () => {
  const local = () => chains().find((c) => c.local === true)!;
  const full = { CHAIN_ID: '46630', RPC_URL: 'http://x' };

  it('registry-driven, no VAULT → the chain’s first vault', () => {
    expect(pickVault({}, local())?.key).toBe('demo');
  });

  it('registry-driven, VAULT names the vault', () => {
    expect(pickVault({ VAULT: 'stocks' }, local())).toMatchObject({ key: 'stocks', vault: STOCKS_VAULT });
    expect(pickVault({ VAULT: '  stocks ' }, local())?.key).toBe('stocks'); // env is trimmed
  });

  it('an unknown VAULT is a ConfigError listing the available keys', () => {
    const run = () => pickVault({ VAULT: 'bonds' }, local());
    expect(run).toThrow(ConfigError);
    expect(run).toThrow(/^vault "bonds" is not on chain 46630 .* — available: demo, stocks$/);
  });

  it('VAULT_ADDRESS overrides the address but keeps the selected identity', () => {
    const cfg = parseConfig({ ...identity, VAULT: 'stocks', VAULT_ADDRESS: A(0xbeef) }, { chain: local() });
    expect(cfg.vaultAddress).toBe(A(0xbeef));
    expect(cfg).toMatchObject({ vaultKey: 'stocks', receiptSymbol: 'sun5StocksLP' });
  });

  it('VAULT_ADDRESS may not be ANOTHER listed vault than the one selected', () => {
    // VAULT unset → demo selected, but the address is the stocks vault's.
    expect(() => pickVault({ VAULT_ADDRESS: STOCKS_VAULT }, local())).toThrow(
      new ConfigError(
        `VAULT_ADDRESS ${STOCKS_VAULT} is the registry's "stocks" vault on chain 46630, but the selected vault is ` +
          `"demo" (VAULT unset → the chain's first vault) — set VAULT=stocks, or unset VAULT_ADDRESS`,
      ),
    );
    expect(() => pickVault({ VAULT: 'demo', VAULT_ADDRESS: STOCKS_VAULT.toUpperCase().replace('0X', '0x') }, local())).toThrow(
      /is the registry's "stocks" vault on chain 46630, but the selected vault is "demo" \(VAULT=demo\)/,
    );
    // Agreeing values are fine (case-insensitively).
    expect(pickVault({ VAULT: 'stocks', VAULT_ADDRESS: STOCKS_VAULT.toLowerCase() }, local())?.key).toBe('stocks');
  });

  it('full env, no VAULT: the registry names the vault it lists at VAULT_ADDRESS — or none', () => {
    expect(pickVault({ ...full, VAULT_ADDRESS: STOCKS_VAULT }, local())?.key).toBe('stocks');
    expect(pickVault({ ...full, VAULT_ADDRESS: LOCAL_VAULT }, local())?.key).toBe('demo');
    expect(pickVault({ ...full, VAULT_ADDRESS: A(0xc0ffee) }, local())).toBeNull(); // never a guess
  });

  it('full env WITH VAULT: resolved and cross-checked like the registry-driven path', () => {
    expect(pickVault({ ...full, VAULT: 'stocks', VAULT_ADDRESS: A(0xc0ffee) }, local())?.key).toBe('stocks');
    expect(() => pickVault({ ...full, VAULT: 'demo', VAULT_ADDRESS: STOCKS_VAULT }, local())).toThrow(
      /selected vault is "demo" \(VAULT=demo\) — set VAULT=stocks/,
    );
    expect(() => pickVault({ ...full, VAULT: 'nope', VAULT_ADDRESS: A(1) }, local())).toThrow(
      /available: demo, stocks/,
    );
  });

  it('VAULT with nothing to resolve it against is a ConfigError, not an unchecked label', () => {
    expect(() => pickVault({ VAULT: 'demo' }, undefined)).toThrow(
      /^VAULT=demo is set, but no chain registry entry is loaded for this chain — the key cannot be resolved/,
    );
    const planned = chains().find((c) => c.chainId === 4663)!;
    expect(() => pickVault({ VAULT: 'demo' }, planned)).toThrow(
      /VAULT=demo is set, but chain 4663 \("Robinhood Chain"\) lists no vaults in the registry \(status "planned"\)/,
    );
    expect(pickVault({}, undefined)).toBeNull();
    expect(pickVault({}, planned)).toBeNull();
  });
});

describe('parseConfig / loadConfig — vault identity fields', () => {
  const local = () => chains().find((c) => c.local === true)!;
  const reg = (dir: string) => join(dir, 'deployments.json');

  it('carries key, label and receipt of the selected vault', () => {
    expect(parseConfig(identity, { chain: local() })).toMatchObject({
      vaultAddress: LOCAL_VAULT,
      vaultKey: 'demo',
      vaultLabel: 'demo basket',
      receiptName: 'sunEthLP',
      receiptSymbol: 'sunEthLP',
    });
    expect(parseConfig({ ...identity, VAULT: 'stocks' }, { chain: local() })).toMatchObject({
      vaultAddress: STOCKS_VAULT,
      vaultKey: 'stocks',
      vaultLabel: 'stocks basket',
      receiptName: 'sun5StocksLP',
      receiptSymbol: 'sun5StocksLP',
    });
  });

  it('describeConfig shows the vault identity (the `starting` line)', () => {
    const described = describeConfig(parseConfig({ ...identity, VAULT: 'stocks' }, { chain: local() }));
    expect(described).toMatchObject({
      vault: STOCKS_VAULT,
      vaultKey: 'stocks',
      vaultLabel: 'stocks basket',
      receiptName: 'sun5StocksLP',
      receiptSymbol: 'sun5StocksLP',
    });
  });

  it('loadConfig: VAULT=stocks selects the second vault of the selected chain', () => {
    const dir = sharedDir(REGISTRY, OVERLAY);
    const cfg = loadConfig({ ...identity, DEPLOYMENTS_FILE: reg(dir), VAULT: 'stocks' });
    expect(cfg).toMatchObject({ chainId: 46630, vaultAddress: STOCKS_VAULT, vaultKey: 'stocks' });
  });

  it('loadConfig: VAULT applies to the chain CHAIN_ID selected, not the local one', () => {
    const dir = sharedDir(REGISTRY, OVERLAY);
    const env = { ...identity, DEPLOYMENTS_FILE: reg(dir), CHAIN_ID: '777' };
    expect(loadConfig({ ...env, VAULT: 'main' })).toMatchObject({ vaultAddress: A(0x700), vaultKey: 'main' });
    expect(() => loadConfig({ ...env, VAULT: 'stocks' })).toThrow(
      new ConfigError('vault "stocks" is not on chain 777 ("Some Testnet") — available: main'),
    );
  });

  it('loadConfig: an unknown VAULT is a ConfigError (exit 2) listing the keys', () => {
    const dir = sharedDir(REGISTRY, OVERLAY);
    const run = () => loadConfig({ ...identity, DEPLOYMENTS_FILE: reg(dir), VAULT: 'bonds' });
    expect(run).toThrow(ConfigError);
    expect(run).toThrow(/available: demo, stocks/);
  });

  it('loadConfig: VAULT_ADDRESS overrides the address of the VAULT-selected vault', () => {
    const dir = sharedDir(REGISTRY, OVERLAY);
    const cfg = loadConfig({ ...identity, DEPLOYMENTS_FILE: reg(dir), VAULT: 'stocks', VAULT_ADDRESS: A(0xabcd) });
    expect(cfg).toMatchObject({ vaultAddress: A(0xabcd), vaultKey: 'stocks', chainId: 46630 });
  });

  it('STATE_FILE default: unchanged without VAULT; per vault with it; explicit always wins', () => {
    const dir = sharedDir(REGISTRY, OVERLAY);
    const env = { ...identity, DEPLOYMENTS_FILE: reg(dir) };
    expect(loadConfig(env).stateFile).toBe('.keeper-state.json');
    expect(loadConfig({ ...env, VAULT: 'stocks' }).stateFile).toBe('.keeper-state.stocks.json');
    expect(loadConfig({ ...env, VAULT: 'demo' }).stateFile).toBe('.keeper-state.demo.json');
    expect(loadConfig({ ...env, VAULT: 'stocks', STATE_FILE: '/v/s.json' }).stateFile).toBe('/v/s.json');
  });

  it("the repo registry: default is the local stack's first vault; VAULT=stocks the second", () => {
    const demo = readDeployment();
    const stocks = readDeployment('stocks');
    expect(demo.key).toBe('demo');
    expect(loadConfig(identity)).toMatchObject({ vaultAddress: demo.vault, vaultKey: 'demo', receiptSymbol: demo.receipt.symbol });
    expect(loadConfig({ ...identity, VAULT: 'stocks' })).toMatchObject({
      vaultAddress: stocks.vault,
      vaultKey: 'stocks',
      receiptSymbol: stocks.receipt.symbol,
    });
  });

  it('a v2 overlay with no registry beside it is a ConfigError when the run needs it', () => {
    const dir = sharedDir(undefined, OVERLAY);
    const overlayPath = join(dir, 'deployment.local.json');
    expect(() => loadConfig({ ...identity, DEPLOYMENT_FILE: overlayPath }, reg(dir))).toThrow(
      /DEPLOYMENT_FILE .*deployment\.local\.json is a v2 multi-vault overlay — it only works on top of the chain registry/,
    );
    // ...and ignored, as before, when env supplies the whole chain.
    const cfg = loadConfig(
      { ...identity, DEPLOYMENT_FILE: overlayPath, CHAIN_ID: '46630', RPC_URL: 'http://x', VAULT_ADDRESS: A(5) },
      reg(dir),
    );
    expect(cfg.vaultAddress).toBe(A(5));
  });
});

describe('loadConfig — container case: vault identity', () => {
  const env: EnvRecord = {
    ...identity,
    CHAIN_ID: '46630',
    RPC_URL: 'http://host.docker.internal:8547',
    VAULT_ADDRESS: A(0xc0ffee),
  };
  const noShared = (): string => join(sharedDir(undefined), 'deployments.json');

  it('no registry on disk: all four identity fields are null, and the startup line says so', () => {
    const cfg = loadConfig(env, noShared());
    expect(cfg).toMatchObject({ vaultKey: null, vaultLabel: null, receiptName: null, receiptSymbol: null });
    expect(cfg.stateFile).toBe('.keeper-state.json');
    expect(describeConfig(cfg)).toMatchObject({ vaultKey: null, receiptSymbol: null });
  });

  it('no registry on disk + VAULT: refused — the key cannot be checked', () => {
    const run = () => loadConfig({ ...env, VAULT: 'stocks' }, noShared());
    expect(run).toThrow(ConfigError);
    expect(run).toThrow(/VAULT=stocks is set, but no chain registry entry is loaded/);
  });

  it('repo registry present + full env: the vault is named only when VAULT_ADDRESS is a listed one', () => {
    expect(loadConfig(env).vaultKey).toBeNull(); // 0x…c0ffee is not in the registry
    const stocks = readDeployment('stocks');
    const cfg = loadConfig({ ...env, VAULT_ADDRESS: stocks.vault });
    expect(cfg).toMatchObject({ vaultAddress: stocks.vault, vaultKey: 'stocks', receiptSymbol: stocks.receipt.symbol });
  });
});
