#!/usr/bin/env node
/**
 * fork-demo-freeze.mjs — turn the live RHC-fork anvil into a STANDALONE anvil state file.
 *
 * Why: the public RHC RPC is not an archive node — it serves state for recent blocks only (observed: ~10–30 minutes).
 * Once the fork block ages out, anvil can no longer fetch anything it has not already cached, and even
 * mining a block fails (every block writes a fresh EIP-2935 block-hash slot, whose original value must be
 * fetched upstream: "historical state … is not available"). A long-running LAN demo therefore cannot stay
 * a live fork. Instead, right after the stack is deployed on the fork, its state is frozen:
 *
 *   state = (every account + storage slot anvil FETCHED from RHC — foundry's fork cache, flushed on exit)
 *         ⊕ (everything changed LOCALLY — `anvil_dumpState`: the deployed stack, balances, blocks, txs)
 *
 * and anvil is restarted from it with `--state` (no --fork-url). Slots never fetched read as zero — fine
 * for the demo (a never-touched slot of a contract the stack never read), but NOT a full chain copy.
 *
 * The fork cache only holds what the fork actually READ, so everything the demo reads later must be read
 * while the fork is still live — `warm` does that (batched: the RPC's state window can be ~10 minutes), and
 * the same reads re-run on the frozen node must answer identically (fork-demo-up.sh diffs them).
 *
 * Subcommands (fork-demo-up.sh runs them in order):
 *   warm  <rpc> <out.txt> [centerTick]      the upstream reads the demo depends on, one line per call
 *   dump  <rpc> <out.json>                  write the running anvil's local state (anvil_dumpState)
 *   merge <dump.json> <forkBlock> <out.json> merge it with the flushed fork cache of <forkBlock>
 *
 * The 10 anvil dev accounts are EIP-7702-delegated on RHC mainnet (their keys are public); the merge
 * strips that delegation so they are plain EOAs locally, as on any anvil.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, zstdDecompressSync } from 'node:zlib';

const DEV_ACCOUNTS = new Set(
  [
    '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
    '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
    '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65',
    '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc',
    '0x976EA74026E726554dB657fA54763abd0C3a0aa9',
    '0x14dC79964da2C08b23698B3D3cc7Ca32193d9955',
    '0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f',
    '0xa0Ee7A142d267C1f36714E4a8F75612F20a79720',
  ].map((a) => a.toLowerCase()),
);

// Verified RHC addresses (notes/RHC_ADDRESSES.md).
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
const POOL = '0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca'; // v3 USDG/WETH fee 100, tickSpacing 1
/** Tick-bitmap words read around the center (spacing 1: word = tick >> 8): ±2 ≈ ±512 ticks ≈ ±5%. */
const BITMAP_WORDS = 2;
// Selectors (`cast sig`).
const SEL = {
  name: '0x06fdde03',
  symbol: '0x95d89b41',
  decimals: '0x313ce567',
  totalSupply: '0x18160ddd',
  balanceOf: '0x70a08231',
  slot0: '0x3850c7bd',
  liquidity: '0x1a686502',
  fee: '0xddca3f43',
  tickSpacing: '0xd0c93a7c',
  feeGrowthGlobal0X128: '0xf3058399',
  feeGrowthGlobal1X128: '0x46141319',
  protocolFees: '0x1ad8b03b',
  token0: '0x0dfe1681',
  token1: '0xd21220a7',
  observations: '0x252c09d7',
  tickBitmap: '0x5339c296',
  ticks: '0xf30dba93',
};

const die = (msg) => {
  console.error(`fork-demo-freeze: ${msg}`);
  process.exit(1);
};

/** ABI word for a (possibly negative) integer: 32-byte two's complement, no 0x. */
const word = (n) => (BigInt.asUintN(256, BigInt(n))).toString(16).padStart(64, '0');
const addrWord = (a) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
/** The i-th 32-byte word of a hex return value, as a signed / unsigned BigInt. */
const retWord = (hex, i, bits = 256, signed = false) => {
  const v = BigInt(`0x${hex.slice(2 + 64 * i, 2 + 64 * (i + 1)) || '0'}`);
  return signed ? BigInt.asIntN(bits, v) : BigInt.asUintN(bits, v);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** eth_call a list of [label, to, data] in JSON-RPC batches; any final error aborts (a gap would be read as
 *  zero). The public RHC RPC rate-limits (HTTP 429) — batches are small and paced, and any batch containing
 *  a failed call is retried with a growing pause before giving up. */
async function callAll(rpc, calls) {
  const out = [];
  const BATCH = 25;
  for (let i = 0; i < calls.length; i += BATCH) {
    const chunk = calls.slice(i, i + BATCH);
    let results = null;
    for (let attempt = 0; attempt <= 6 && results === null; attempt++) {
      let body;
      try {
        const res = await fetch(rpc, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(
            chunk.map(([, to, data], j) => ({ jsonrpc: '2.0', id: i + j, method: 'eth_call', params: [{ to, data }, 'latest'] })),
          ),
        });
        body = await res.json();
      } catch (e) {
        body = { error: { message: String(e) } };
      }
      const byId = new Map((Array.isArray(body) ? body : [body]).map((r) => [r && r.id, r]));
      const missing = chunk.filter((_c, j) => !byId.get(i + j) || byId.get(i + j).error);
      results = missing.length === 0 ? chunk.map((_c, j) => byId.get(i + j).result) : null;
      if (results === null) {
        if (attempt === 6) {
          const bad = byId.get(i + chunk.indexOf(missing[0]));
          die(`warm: ${missing[0][0]} failed: ${JSON.stringify(bad?.error ?? body)}`);
        }
        await sleep(700 * (attempt + 1)); // 0.7 s … 4.9 s — let the rate limit settle, then retry the batch
      }
    }
    chunk.forEach(([label], j) => out.push([label, results[j]]));
    if (i + BATCH < calls.length) await sleep(60); // pace: stay under the public RPC's rate limit
  }
  return out;
}

async function warm(rpc, outPath, center) {
  const holders = [POOL, ...DEV_ACCOUNTS];
  const calls = [];
  for (const [sym, t] of [['USDG', USDG], ['WETH', WETH]]) {
    for (const f of ['name', 'symbol', 'decimals', 'totalSupply']) calls.push([`${sym}.${f}()`, t, SEL[f]]);
    for (const h of holders) calls.push([`${sym}.balanceOf(${h})`, t, SEL.balanceOf + addrWord(h)]);
  }
  for (const f of ['slot0', 'liquidity', 'fee', 'tickSpacing', 'feeGrowthGlobal0X128', 'feeGrowthGlobal1X128', 'protocolFees', 'token0', 'token1']) {
    calls.push([`pool.${f}()`, POOL, SEL[f]]);
  }
  const base = await callAll(rpc, calls);
  const slot0 = base.find(([l]) => l === 'pool.slot0()')[1];
  const tick = Number(retWord(slot0, 1, 24, true));
  const index = retWord(slot0, 2, 16);
  const card = retWord(slot0, 3, 16);
  const mid = center === undefined ? tick : Number(center);

  // observe(lookback) binary-searches the ring from the newest entry backwards; the adapters' 1800 s guard
  // and the zap's 600 s guard only need entries inside a ~1 h window. Warm the NEWEST entries back to
  // newest − 3600 s (plus the one crossing the boundary): an unwarmed mid point reads ZERO on the frozen
  // node, which the search treats as "ancient" — it keeps moving its left bound right, so the converging
  // pair (the entry ≤ target and the next newer one) is found inside the warmed newest window. A 1 h
  // window + the boundary entry covers both guards for the demo's life (once frozen time passes
  // newest + 1800 s, observe() takes the fast path and reads the newest entry only).
  const WINDOW_S = 3600n;
  const cardN = Number(card);
  const idx = Number(index);
  const newestTs = retWord((await callAll(rpc, [[`pool.observations(${idx})`, POOL, SEL.observations + word(idx)]]))[0][1], 0, 64);
  const obs = [];
  walk: for (let k = 0; k < cardN; k += 25) {
    const chunk = [];
    for (let j = k; j < Math.min(k + 25, cardN); j++) chunk.push((idx - j + cardN) % cardN);
    const res = await callAll(rpc, chunk.map((i) => [`pool.observations(${i})`, POOL, SEL.observations + word(i)]));
    for (const [label, hex] of res) {
      obs.push(Number(/pool\.observations\((\d+)\)/.exec(label)[1]));
      if (newestTs - retWord(hex, 0, 64) >= WINDOW_S) break walk;
    }
  }
  const words = [];
  for (let w = (mid >> 8) - BITMAP_WORDS; w <= (mid >> 8) + BITMAP_WORDS; w++) words.push(w);
  const second = await callAll(rpc, [
    ...obs.map((i) => [`pool.observations(${i})`, POOL, SEL.observations + word(i)]),
    ...words.map((w) => [`pool.tickBitmap(${w})`, POOL, SEL.tickBitmap + word(w)]),
  ]);
  const ticks = [];
  for (const [label, hex] of second) {
    const m = /^pool\.tickBitmap\((-?\d+)\)$/.exec(label);
    if (!m) continue;
    const bm = BigInt(hex);
    for (let b = 0; b < 256; b++) if ((bm >> BigInt(b)) & 1n) ticks.push(Number(m[1]) * 256 + b);
  }
  const third = await callAll(rpc, ticks.map((t) => [`pool.ticks(${t})`, POOL, SEL.ticks + word(t)]));

  const lines = [...base, ...second, ...third].map(([l, r]) => `${l} ${r}`);
  writeFileSync(outPath, `${lines.join('\n')}\n`);
  const dec = (sym) => Number(BigInt(base.find(([l]) => l === `${sym}.decimals()`)[1]));
  console.log(
    `warm: ${lines.length} reads (${ticks.length} initialized ticks in bitmap words ${words[0]}..${words.at(-1)}, ` +
      `center tick ${mid}) · decimals USDG ${dec('USDG')} / WETH ${dec('WETH')} → ${outPath}`,
  );
  console.log(`CENTER_TICK=${mid}`);
}

async function dump(rpc, out) {
  const res = await fetch(rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'anvil_dumpState', params: [] }),
  });
  const body = await res.json();
  if (body.error || typeof body.result !== 'string') die(`anvil_dumpState failed: ${JSON.stringify(body.error ?? body)}`);
  const json = gunzipSync(Buffer.from(body.result.replace(/^0x/, ''), 'hex')).toString('utf8');
  writeFileSync(out, json);
  const state = JSON.parse(json);
  console.log(`dump: ${Object.keys(state.accounts).length} local accounts, best block ${state.best_block_number} → ${out}`);
}

/** foundry's on-disk fork cache for this block: ~/.foundry/cache/rpc/<chain>/<block>/storage-*.json (zstd). */
function findCache(forkBlock) {
  const root = join(homedir(), '.foundry', 'cache', 'rpc');
  const hits = [];
  for (const chain of existsSync(root) ? readdirSync(root) : []) {
    const dir = join(root, chain, String(forkBlock));
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) if (f.startsWith('storage')) hits.push(join(dir, f));
  }
  if (hits.length !== 1) die(`expected one fork cache for block ${forkBlock} under ${root}, found ${hits.length} (${hits.join(', ')})`);
  return hits[0];
}

function readCache(path) {
  const raw = readFileSync(path);
  const text = raw[0] === 0x28 && raw[1] === 0xb5 ? zstdDecompressSync(raw).toString('utf8') : raw.toString('utf8');
  return JSON.parse(text);
}

/** revm's cached bytecode → plain hex (analysed legacy code is zero-padded: cut to original_len). */
function codeHex(code) {
  if (code == null) return '0x';
  if (typeof code === 'string') return code;
  if (code.LegacyAnalyzed) return code.LegacyAnalyzed.bytecode.slice(0, 2 + 2 * code.LegacyAnalyzed.original_len);
  if (code.LegacyRaw) return code.LegacyRaw;
  if (code.Eip7702) return `0xef0100${code.Eip7702.delegated_address.replace(/^0x/, '').toLowerCase()}`;
  die(`unknown bytecode encoding ${Object.keys(code)[0]}`);
}

const toHexQty = (v) => (typeof v === 'number' ? `0x${v.toString(16)}` : v);

function merge(dumpPath, forkBlock, out) {
  const local = JSON.parse(readFileSync(dumpPath, 'utf8'));
  const cachePath = findCache(forkBlock);
  const cache = readCache(cachePath);

  const accounts = {};
  let fetched = 0;
  let slots = 0;
  let stripped = 0;
  for (const [addr, info] of Object.entries(cache.accounts)) {
    const a = addr.toLowerCase();
    let code = codeHex(info.code);
    if (DEV_ACCOUNTS.has(a) && code.startsWith('0xef0100')) {
      code = '0x';
      stripped++;
    }
    const storage = { ...(cache.storage[addr] ?? cache.storage[a] ?? {}) };
    slots += Object.keys(storage).length;
    accounts[a] = { nonce: Number(info.nonce), balance: toHexQty(info.balance), code, storage };
    fetched++;
  }
  // Fetched storage of accounts whose info was not cached separately (should not happen; kept for safety).
  for (const [addr, storage] of Object.entries(cache.storage)) {
    const a = addr.toLowerCase();
    if (!accounts[a]) accounts[a] = { nonce: 0, balance: '0x0', code: '0x', storage: { ...storage } };
  }

  // Local changes win: nonce / balance / code, and every locally written slot.
  let overlaid = 0;
  for (const [addr, info] of Object.entries(local.accounts)) {
    const a = addr.toLowerCase();
    const base = accounts[a];
    let code = info.code && info.code !== '0x' ? info.code : (base?.code ?? '0x');
    if (DEV_ACCOUNTS.has(a) && code.startsWith('0xef0100')) code = '0x';
    accounts[a] = {
      nonce: Number(info.nonce),
      balance: info.balance,
      code,
      storage: { ...(base?.storage ?? {}), ...(info.storage ?? {}) },
    };
    overlaid++;
  }

  const state = { ...local, accounts };
  writeFileSync(out, JSON.stringify(state));
  console.log(
    `merge: ${fetched} fetched accounts (${slots} slots) from ${cachePath}\n` +
      `       + ${overlaid} local accounts from ${dumpPath}; stripped ${stripped} dev-account 7702 delegations\n` +
      `       = ${Object.keys(accounts).length} accounts, best block ${local.best_block_number} → ${out}`,
  );
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'warm' && (args.length === 2 || args.length === 3)) await warm(args[0], args[1], args[2]);
else if (cmd === 'dump' && args.length === 2) await dump(args[0], args[1]);
else if (cmd === 'merge' && args.length === 3) merge(args[0], args[1], args[2]);
else die('usage: fork-demo-freeze.mjs warm <rpc> <out.txt> [centerTick] | dump <rpc> <out.json> | merge <dump.json> <forkBlock> <out.json>');
