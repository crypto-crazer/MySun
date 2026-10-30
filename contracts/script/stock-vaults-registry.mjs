#!/usr/bin/env node
// Registry + doc entries for the 12 stock vaults, GENERATED from DeployStockVaults' state files
// (broadcast/stock-vaults/<label>-<chainId>-<slug>.json — written by the deployment itself). Never hand-type them.
//
//   node script/stock-vaults-registry.mjs [--label mainnet] [--chain 4663] [--rpc <url>] [--write [--registry <path>]]
//
//   default   print the 12 `shared/deployments.json` vault entries + the docs/DEPLOYMENTS.md and
//             notes/MYSUN-ADDRESSES.md blocks (markdown) to stdout.
//   --rpc     before anything, check every vault on-chain: code present, symbol() == the recorded symbol,
//             EIP-1967 implementation slot == the recorded implementation. Any mismatch aborts.
//   --write   append the entries to chains.<chain>.vaults of the registry (default ../shared/deployments.json).
//             An entry whose key already exists must carry the SAME vault address (then it is refreshed in place);
//             a different address aborts. Then run `cd frontend && pnpm sync:shared`.
//
// Registry entries carry only the keys the FE/BE validators accept (key, label, receipt, vault, implementation,
// keeper, planExecutor); adapters and pool ids go to the docs blocks.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const contracts = resolve(here, '..');
const SLUGS = ['spy', 'gld', 'nvda', 'spcx', 'crcl', 'tsla', 'aapl', 'amzn', 'intc', 'mu', 'mstr', 'nvda-spy'];
const SYMBOLS = {
  '0x5fc5360d0400a0fd4f2af552add042d716f1d168': 'USDG',
  '0x117cc2133c37b721f49de2a7a74833232b3b4c0c': 'SPY',
  '0xc9a981fee1f9dec688bb123ccdecc63d0debfc4e': 'GLD',
  '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec': 'NVDA',
  '0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea': 'SPCX',
  '0xdf0992e440dd0be65bd8439b609d6d4366bf1cb5': 'CRCL',
  '0x322f0929c4625ed5bad873c95208d54e1c003b2d': 'TSLA',
  '0xaf3d76f1834a1d425780943c99ea8a608f8a93f9': 'AAPL',
  '0x12f190a9f9d7d37a250758b26824b97ce941bf54': 'AMZN',
  '0xc72b96e0e48ecd4dc75e1e45396e26300bc39681': 'INTC',
  '0xff080c8ce2e5feadaca0da81314ae59d232d4afd': 'MU',
  '0xec262a75e413fafd0df80480274532c79d42da09': 'MSTR',
};
const EIP1967_IMPL = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i === -1 ? dflt : process.argv[i + 1];
}
const label = arg('--label', 'mainnet');
const chain = arg('--chain', '4663');
const rpc = arg('--rpc', undefined);
const write = process.argv.includes('--write');
const registryPath = resolve(arg('--registry', resolve(contracts, '..', 'shared', 'deployments.json')));

const sym = (a) => SYMBOLS[a.toLowerCase()] ?? (() => { throw new Error(`unknown token ${a}`); })();
const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(a) && !/^0x0{40}$/.test(a);

const states = SLUGS.map((slug) => {
  const f = resolve(contracts, 'broadcast', 'stock-vaults', `${label}-${chain}-${slug}.json`);
  if (!existsSync(f)) throw new Error(`missing state file ${f} — run the deployment first`);
  const text = readFileSync(f, 'utf8');
  const s = JSON.parse(text);
  // forge writes uint256 as bare JSON numbers: re-read the amounts as strings (JSON.parse rounds above 2^53)
  s.genesis = (text.match(/"genesis"\s*:\s*\[([^\]]*)\]/)?.[1] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  if (String(s.chainId) !== chain) throw new Error(`${f}: chainId ${s.chainId} != ${chain}`);
  for (const k of ['vault', 'implementation', 'depositSplit', 'planExecutor', 'keeper', 'owner']) {
    if (!isAddr(s[k])) throw new Error(`${f}: ${k} is not a deployed address (${s[k]})`);
  }
  if (s.adapters.length !== 6 || !s.adapters.every(isAddr)) throw new Error(`${f}: expected 6 adapters`);
  if (!s.genesis?.length || s.genesis.some((g) => BigInt(g) === 0n)) throw new Error(`${f}: genesis not recorded`);
  return s;
});

async function call(method, params) {
  const r = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}
function decodeString(hex) {
  const b = Buffer.from(hex.slice(2), 'hex');
  const len = Number(BigInt('0x' + b.subarray(32, 64).toString('hex')));
  return b.subarray(64, 64 + len).toString('utf8');
}
if (rpc) {
  for (const s of states) {
    if ((await call('eth_getCode', [s.vault, 'latest'])) === '0x') throw new Error(`${s.slug}: no code at ${s.vault}`);
    const onchainSym = decodeString(await call('eth_call', [{ to: s.vault, data: '0x95d89b41' }, 'latest']));
    if (onchainSym !== s.symbol) throw new Error(`${s.slug}: symbol() ${onchainSym} != ${s.symbol}`);
    const impl = '0x' + (await call('eth_getStorageAt', [s.vault, EIP1967_IMPL, 'latest'])).slice(-40);
    if (impl.toLowerCase() !== s.implementation.toLowerCase()) throw new Error(`${s.slug}: impl slot ${impl}`);
  }
  console.error(`on-chain check OK: ${states.length} vaults (${rpc})`);
}

const entries = states.map((s) => ({
  key: s.slug,
  label: `${s.basket.map(sym).join(' / ')} basket (Robinhood Chain)`,
  receipt: { name: s.symbol, symbol: s.symbol },
  vault: s.vault,
  implementation: s.implementation,
  keeper: s.keeper,
  planExecutor: s.planExecutor,
}));

if (write) {
  const reg = JSON.parse(readFileSync(registryPath, 'utf8'));
  const c = reg.chains?.[chain];
  if (!c || !Array.isArray(c.vaults)) throw new Error(`${registryPath}: no chains.${chain}.vaults`);
  for (const e of entries) {
    const i = c.vaults.findIndex((v) => v.key === e.key);
    if (i === -1) c.vaults.push(e);
    else if (c.vaults[i].vault.toLowerCase() === e.vault.toLowerCase()) c.vaults[i] = e;
    else throw new Error(`key "${e.key}" already registered with another vault ${c.vaults[i].vault}`);
  }
  writeFileSync(registryPath, JSON.stringify(reg, null, 2) + '\n');
  console.error(`wrote ${entries.length} entries → ${registryPath}`);
} else {
  console.log('// shared/deployments.json → chains.' + chain + '.vaults (append)');
  console.log(JSON.stringify(entries, null, 2));
}

// docs/DEPLOYMENTS.md — tokens, one section per vault, venue rows
const out = [];
out.push('\n<!-- docs/DEPLOYMENTS.md: Tokens rows -->');
const stockTokens = [...new Set(states.flatMap((s) => s.basket))].filter((a) => sym(a) !== 'USDG');
for (const a of stockTokens) out.push(`| ${sym(a)} | \`${a}\` | 18 |`);
out.push('\n<!-- docs/DEPLOYMENTS.md: Vaults sections -->');
for (const s of states) {
  const pair = s.basket.map(sym);
  out.push(`### ${s.symbol} — basket \`[${pair.join(', ')}]\``, '');
  out.push(`- Vault (UUPS proxy): \`${s.vault}\``);
  out.push(`- Implementation（current EIP-1967 slot）：\`${s.implementation}\``);
  out.push(`- Basket order（鏈上 \`tokens()\`）：\`[${pair.join(', ')}]\``);
  out.push(`- DepositSplit helper（stateless）：\`${s.depositSplit}\``);
  out.push(`- PlanExecutor：\`${s.planExecutor}\``);
  out.push(`- Adapters（鏈上 \`adapters()\` 順序；6 × V4 hooked，Fables 市場池 \`${s.poolId}\`）：`);
  for (const a of s.adapters) out.push(`  - \`${a}\``);
  out.push('');
}
out.push('<!-- docs/DEPLOYMENTS.md: Venue rows -->');
for (const s of states) {
  out.push(`| Fables hook — ${s.basket.map(sym).join('/')} | \`${s.hooks}\` |`);
  out.push(`| V4 pool id — ${s.basket.map(sym).join('/')} | \`${s.poolId}\` |`);
}
// notes/MYSUN-ADDRESSES.md — one row per vault
out.push('\n<!-- notes/MYSUN-ADDRESSES.md -->');
out.push('| slug | symbol | vault | impl | DepositSplit | PlanExecutor | poolId | genesis (raw, basket order) |');
out.push('|---|---|---|---|---|---|---|---|');
for (const s of states) {
  out.push(`| ${s.slug} | ${s.symbol} | \`${s.vault}\` | \`${s.implementation}\` | \`${s.depositSplit}\` | \`${s.planExecutor}\` | \`${s.poolId}\` | ${s.genesis.join(' / ')} |`);
}
out.push('\nadapters（每 vault 6 顆，鏈上順序）：');
for (const s of states) out.push(`- ${s.slug}: ${s.adapters.map((a) => `\`${a}\``).join('、')}`);
// contracts/audit/check-public-docs.sh — every non-registry address / pool id the DEPLOYMENTS.md blocks introduce
out.push('\n# contracts/audit/check-public-docs.sh: KNOWN_VENUE additions');
for (const a of stockTokens) out.push(`    "${a.toLowerCase()}",  # ${sym(a)}`);
for (const h of [...new Set(states.map((s) => s.hooks.toLowerCase()))]) {
  const users = states.filter((s) => s.hooks.toLowerCase() === h).map((s) => s.slug).join(', ');
  out.push(`    "${h}",  # Fables hook (${users})`);
}
for (const s of states) {
  out.push(`    "${s.depositSplit.toLowerCase()}",  # DepositSplit (${s.slug})`);
  for (const a of s.adapters) out.push(`    "${a.toLowerCase()}",  # hooked ${s.basket.map(sym).join('/')} (${s.symbol})`);
}
out.push('# contracts/audit/check-public-docs.sh: KNOWN_POOL_IDS additions');
for (const s of states) out.push(`    "${s.poolId.toLowerCase()}",  # ${s.basket.map(sym).join('/')} v4 pool (Fables)`);
console.log(out.join('\n'));
