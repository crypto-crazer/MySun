/**
 * NAV + fee snapshot collector (my-sun-analytics).
 *
 * A long-running, read-only service: every `COLLECT_INTERVAL_MIN` it snapshots every deployed
 * vault on every registry chain (basket totals + supply + per-adapter accrued fees + reference-pool
 * spots) and appends one JSONL row per vault to `DATA_DIR/collect-nav.jsonl`. Exposes the file over
 * HTTP (CORS *) for the frontend's NAV/fee charts.
 *
 * Read-only by construction: no signer, no wallet client, no transactions. Nothing here touches
 * `KeeperConfig`/`createClients` — the keeper's config (and its key handling) is intentionally out
 * of the loop. Registry validation is the keeper's `buildRegistry` — one source of truth.
 *
 * USD is OFF-CHAIN DISPLAY ONLY (monorepo invariant): the vault never values anything. The anchor is
 * USDG at its $1 peg; every other token is converted through the LIVE spot (`slot0().sqrtPriceX96`,
 * nothing else) of the reference pool the chain's zap periphery routes through — the same book the
 * frontend's `spot.ts` prices from. Math (Uniswap v3, all bigint):
 *   token is token0:  anchorRaw = amount · sqrtPriceX96² / 2¹⁹²
 *   token is token1:  anchorRaw = amount · 2¹⁹² / sqrtPriceX96²
 * Raw units carry the decimals (USDG 6 dp, WETH/PONS 18 dp); the only float is the final
 * anchorRaw / 10^anchorDecimals.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createPublicClient,
  defineChain,
  http,
  parseAbi,
  type Address,
  type PublicClient,
} from 'viem';

import { buildRegistry, type DeployedChain, type RegistryChain } from './registry.js';
import { vaultAbi } from './abi/generated.js';

/** JSON with bigints as decimal strings (the row's raw amounts). */
function asJson(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
}

/* ---------------------------------------------------------------- tiny logger ------------ */

type Level = 'info' | 'warn' | 'error';
function log(level: Level, msg: string, extra: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), level, msg, svc: 'mysun-collect', ...extra })}\n`);
}

/* ---------------------------------------------------------------- registry IO ------------- */

/** Quietly resolve the shared/ registry dir: ../shared from src or dist, or REGISTRY_DIR. */
function registryDir(): string {
  if (process.env.REGISTRY_DIR) return process.env.REGISTRY_DIR;
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '../../shared'); // backend/src|dist -> repo root/shared
}

function loadChains(): RegistryChain[] {
  const dir = registryDir();
  const registryPath = join(dir, 'deployments.json');
  const localPath = join(dir, 'deployment.local.json');
  if (!existsSync(registryPath)) throw new Error(`registry not found at ${registryPath}`);
  const registryText = readFileSync(registryPath, 'utf8');
  const localText = existsSync(localPath) ? readFileSync(localPath, 'utf8') : undefined;
  return buildRegistry({ registryText, localText });
}

/* ---------------------------------------------------------------- ABI fragments ---------- */

/** Minimal fragments the keeper's generated ABIs do not carry (the frontend declares these the same way). */
const erc20MetaAbi = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
]);
const zapInRoutesAbi = parseAbi([
  'function routes(address from, address to) view returns (address refPool, uint24 swapFee, uint32 twapWindow, uint16 maxSlippageBps, uint16 maxDeviationBps)',
]);
const v3PoolAbi = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
]);
const adapterFeesAbi = parseAbi([
  'function fees() view returns (address[] tokens, uint256[] amounts)',
  'function TOKEN0() view returns (address)',
  'function TOKEN1() view returns (address)',
]);

const Q192 = 2n ** 192n;
const ANCHOR_SYMBOL = 'USDG';
const ZERO = '0x0000000000000000000000000000000000000000';
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/* ---------------------------------------------------------------- pure math (testable) ---- */

export interface TokenMember {
  address: Address;
  symbol: string;
  decimals: number;
  /** Whole-token USDG units per whole token (USDG itself: 1). */
  priceUsd: number;
  totalRaw: bigint;
  totalUsd: number;
  feeRaw: bigint;
  feeUsd: number;
}

export interface SnapshotRow {
  ts: string;
  chainId: number;
  chain: string;
  vaultKey: string;
  vault: Address;
  supply: bigint;
  tokenCount: number;
  tokens: TokenMember[];
  tvlUsd: number;
  navUsd: number | null;
  feesUsd: number;
  adapterCount: number | null;
}

const SCALE_9 = 1_000_000_000n;

/**
 * USDG units per whole token from a pool spot. `sqrtPriceX96` is the pool's; `tokenIsToken0` says
 * whether the priced token is token0 or token1 of that pool. The anchor (USDG) itself has
 * `priceUsd = 1` by peg. All integer until the final display float.
 */
export function priceUsdFromSpot(sqrtPriceX96: bigint, tokenIsToken0: boolean, tokenDecimals: number): number {
  if (sqrtPriceX96 === 0n) return Number.NaN;
  const rawPerWhole = 10n ** BigInt(tokenDecimals);
  // Multiply first, then divide: the raw ratio alone would floor to 0 in bigint (Uniswap
  // v3-style: anchorRaw = amount · s²/2¹⁹² or amount · 2¹⁹²/s²). Whole-token anchor raw USDG units.
  const anchorRawPerWhole = tokenIsToken0
    ? (rawPerWhole * sqrtPriceX96 * sqrtPriceX96) / Q192
    : (rawPerWhole * Q192) / (sqrtPriceX96 * sqrtPriceX96);
  // anchorRaw / 10^anchorDecimals (USDG 6 dp) -> whole USDG; x1e9 keeps display precision.
  return Number((anchorRawPerWhole * SCALE_9) / 1_000_000n) / 1e9;
}

/* ---------------------------------------------------------------- chain snapshot ---------- */

type VaultEntry = NonNullable<RegistryChain['vaults']>[number];

interface ChainReaders {
  chain: RegistryChain;
  client: PublicClient;
  anchor: Address | null;
  anchorDecimals: number;
  prices: Map<string, { priceUsd: number; tokenIsToken0: boolean; pool: Address }>;
  symbols: Map<string, string>;
  decimals: Map<string, number>;
}

/** Optional dRPC API key (paid tier): unlocks higher burst limits and eth_getLogs on robinhood.drpc.org. */
function drpcHeaders(): { headers?: Record<string, string> } {
  const key = process.env.DRPC_API_KEY;
  return key ? { headers: { 'x-api-key': key } } : {};
}

async function makeReaders(chain: DeployedChain): Promise<ChainReaders> {
  const client = createPublicClient({
    chain: defineChain({
      id: chain.chainId,
      name: chain.name,
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [chain.rpcUrl] } },
      // viem's multicall action requires a configured multicall3; the canonical address is
      // deployed on both Robinhood Chain and the local anvil fork.
      contracts: {
        multicall3: { address: '0xca11bde05977b3631167028862be2a173976ca11', blockCreated: 0 },
      },
    }),
    transport: http(chain.rpcUrl, { retryCount: 3, timeout: 20_000, fetchOptions: drpcHeaders() }),
  });

  const symbols = new Map<string, string>();
  const decimals = new Map<string, number>();
  let anchor: Address | null = null;
  let anchorDecimals = 6;

  // Read tokens() per vault first, collecting every basket token (deduped) for symbol/decimals.
  const seen = new Set<string>();
  const metaCalls: { address: Address; abi: typeof erc20MetaAbi; functionName: 'symbol' | 'decimals' }[] = [];
  for (const v of chain.vaults) {
    const t = await client.readContract({ address: v.vault, abi: vaultAbi, functionName: 'tokens' });
    for (const tok of t as Address[]) {
      if (!seen.has(tok.toLowerCase())) {
        seen.add(tok.toLowerCase());
        metaCalls.push(
          { address: tok, abi: erc20MetaAbi, functionName: 'symbol' },
          { address: tok, abi: erc20MetaAbi, functionName: 'decimals' },
        );
      }
    }
  }
  if (metaCalls.length > 0) {
    const meta = await Promise.all(
      metaCalls.map((call) =>
        client.readContract(call).then(
          (r) => ({ ok: true as const, value: r }),
          () => ({ ok: false as const, value: undefined }),
        ),
      ),
    );
    for (let i = 0; i < metaCalls.length; i += 2) {
      const call = metaCalls[i];
      if (!call) continue; // length is always even; guard for the index math
      const addr = call.address;
      const sym = meta[i]?.ok === true ? (meta[i]?.value as string | undefined) : undefined;
      const dec = meta[i + 1]?.ok === true ? (meta[i + 1]?.value as bigint | undefined) : undefined;
      if (sym) symbols.set(addr.toLowerCase(), sym);
      if (dec !== undefined) decimals.set(addr.toLowerCase(), Number(dec));
      if (sym === ANCHOR_SYMBOL) {
        anchor = addr;
        anchorDecimals = dec !== undefined ? Number(dec) : 6;
      }
    }
  }

  // Reference pools: the chain's zap periphery routes (USDG, token) -> refPool -> slot0.
  const prices = new Map<string, { priceUsd: number; tokenIsToken0: boolean; pool: Address }>();
  const zapIn = chain.periphery?.zapIn;
  if (anchor && zapIn) {
    for (const tok of seen) {
      if (same(tok, anchor)) continue;
      try {
        const route = await client.readContract({
          address: zapIn,
          abi: zapInRoutesAbi,
          functionName: 'routes',
          args: [anchor, tok as Address],
        });
        const refPool = route[0] as Address;
        if (refPool === ZERO) continue;
        const [t0, t1, s0] = await Promise.all([
          client.readContract({ address: refPool, abi: v3PoolAbi, functionName: 'token0' }),
          client.readContract({ address: refPool, abi: v3PoolAbi, functionName: 'token1' }),
          client.readContract({ address: refPool, abi: v3PoolAbi, functionName: 'slot0' }),
        ]);
        const tokenIsToken0 = same(t0, tok);
        if (!tokenIsToken0 && !same(t1, tok)) continue; // ref pool is not the (USDG, token) pair
        const priceUsd = priceUsdFromSpot(s0[0], tokenIsToken0, decimals.get(tok.toLowerCase()) ?? 18);
        if (Number.isFinite(priceUsd)) prices.set(tok.toLowerCase(), { priceUsd, tokenIsToken0, pool: refPool });
      } catch (err) {
        log('warn', 'route read failed', { chainId: chain.chainId, token: tok, error: String(err) });
      }
    }
  }

  log('info', 'prices ready', {
    chainId: chain.chainId,
    anchor: anchor ?? null,
    n: prices.size,
    prices: [...prices.entries()].map(([k, v]) => [k.slice(0, 8), v.priceUsd]),
  });

  return { chain, client, anchor, anchorDecimals, prices, symbols, decimals };
}

async function snapshotVault(r: ChainReaders, v: VaultEntry): Promise<SnapshotRow | null> {
  const ts = new Date().toISOString();
  try {
    const [supply, totals, adapters] = await Promise.all([
      r.client.readContract({ address: v.vault, abi: vaultAbi, functionName: 'totalSupply' }),
      r.client.readContract({ address: v.vault, abi: vaultAbi, functionName: 'totalTokens' }),
      r.client.readContract({ address: v.vault, abi: vaultAbi, functionName: 'adapters' }),
    ]);
    const tokens = totals[0] as Address[];
    const amounts = totals[1] as bigint[];

    // Accrued fees: each adapter's fees() bucketed into the vault's tokens via TOKEN0/TOKEN1.
    const feeRaw = new Map<string, bigint>();
    let adapterCount: number | null = null;
    if (adapters && adapters.length > 0) {
      adapterCount = adapters.length;
      const feeResults = await Promise.all(
        adapters.map((a) =>
          Promise.all([
            r.client.readContract({ address: a, abi: adapterFeesAbi, functionName: 'fees' }),
          ]).then(
            (r2) => ({ ok: true as const, value: r2 }),
            () => ({ ok: false as const, value: undefined }),
          ),
        ),
      );
      for (let i = 0; i < adapters.length; i++) {
        const f = feeResults[i]?.ok === true ? feeResults[i]?.value : undefined;
        if (!f) continue; // adapter without the fees view contributes nothing
        // fees() = (address[] tokens, uint256[] amounts): the GROSS fee part per token,
        // index-aligned with position() — bucket each amount under ITS OWN returned token
        // (never the venue pair; the returned addresses are the accounting they belong to).
        const feeToks = f[0][0] as readonly Address[];
        const feeAmts = f[0][1] as readonly bigint[];
        if (feeToks.length !== feeAmts.length) throw new Error('adapter fees() misaligned arrays');
        for (let j = 0; j < feeToks.length; j++) {
          const tokAddr = String(feeToks[j] ?? '').toLowerCase();
          if (tokAddr && tokAddr !== '0x0000000000000000000000000000000000000000') {
            feeRaw.set(tokAddr, (feeRaw.get(tokAddr) ?? 0n) + (feeAmts[j] ?? 0n));
          }
        }
      }
    }

    const members: TokenMember[] = [];
    let tvlUsd = 0;
    let feesUsd = 0;
    for (let i = 0; i < tokens.length; i++) {
      const tokAddr = tokens[i] as Address | undefined;
      if (!tokAddr) continue;
      const tok = tokAddr.toLowerCase();
      const totalRaw = amounts[i] ?? 0n;
      const priceUsd =
        r.anchor && same(tok, r.anchor) ? 1 : (r.prices.get(tok)?.priceUsd ?? Number.NaN);
      if (!Number.isFinite(priceUsd)) {
        // A missing spot is a failed read, not a zero price: writing a 0-valued leg would sink the
        // vault's NAV for the whole cycle. Fail the snapshot instead (the row is then skipped).
        throw new Error(`spot price miss for ${tok} (${r.symbols.get(tok) ?? '?'}) — snapshot rejected`);
      }
      const displayPrice = priceUsd;
      const wholeTokens = Number(totalRaw) / 10 ** (r.decimals.get(tok) ?? 18);
      const totalUsd = wholeTokens * displayPrice; // display only; the vault never values on-chain
      const feeRawN = feeRaw.get(tok) ?? 0n;
      const feeWhole = Number(feeRawN) / 10 ** (r.decimals.get(tok) ?? 18);
      tvlUsd += totalUsd;
      feesUsd += feeWhole * displayPrice;
      members.push({
        address: tokAddr,
        symbol: r.symbols.get(tok) ?? '?',
        decimals: r.decimals.get(tok) ?? 18,
        priceUsd,
        totalRaw,
        totalUsd,
        feeRaw: feeRawN,
        feeUsd: feeWhole * displayPrice,
      });
    }
    const supplyNum = Number(supply) / 1e18; // receipt tokens are 18 dp everywhere
    return {
      ts,
      chainId: r.chain.chainId,
      chain: r.chain.name,
      vaultKey: v.key,
      vault: v.vault,
      supply,
      tokenCount: members.length,
      tokens: members,
      tvlUsd,
      navUsd: supply > 0n ? tvlUsd / supplyNum : null,
      feesUsd,
      adapterCount,
    };
  } catch (err) {
    log('error', 'vault snapshot failed', { chainId: r.chain.chainId, vault: v.key, error: String(err) });
    return null;
  }
}

/** Last GOOD row per vault (keyed `chainId:key`) — the continuity guard's reference. */
const lastGoodRow = new Map<string, NavRef>();
const NAV_JUMP_LIMIT = 0.15; // repriced residual beyond 15% = a failed read, not a move

interface NavRef {
  supply: number; // whole receipt tokens
  legs: Array<{ total: number; price: number }>; // raw totals (whole units) + their USD price
  nav: number;
}

/**
 * The NAV the previous good row would have AT THE CURRENT PRICES (same totals, same supply):
 * a price move re-prices the vault and causes no residual; a failed total / supply / price read
 * shows up as a large residual. `undefined` when the last row lacks any leg (no reference).
 */
function repricedNav(prev: NavRef, cur: Array<{ total: number; price: number }>): number | undefined {
  if (prev.legs.length === 0 || cur.length !== prev.legs.length) return undefined;
  let tvl = 0;
  for (let i = 0; i < prev.legs.length; i++) {
    const p = cur[i]?.price;
    if (typeof p !== 'number' || !Number.isFinite(p)) return undefined;
    tvl += (prev.legs[i]?.total ?? 0) * p;
  }
  return prev.supply > 0 ? tvl / prev.supply : undefined;
}

/**
 * Startup data hygiene: walk the appended JSONL, drop rows that carry a failed read (missing / zero /
 * non-finite token price, a '?' symbol, null NAV) or a NAV jump beyond `NAV_JUMP_LIMIT` from the
 * previous good row of the same vault, rewrite the file in place, and seed the continuity map.
 * Returns the number of dropped rows.
 */
export function sweepData(): number {
  lastGoodRow.clear();
  const dataDir = process.env.DATA_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '../data');
  const file = join(dataDir, 'collect-nav.jsonl');
  if (!existsSync(file)) return 0;
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return 0;
  }
  const out: string[] = [];
  let dropped = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row: { vaultKey?: string; chainId?: number; navUsd?: unknown; supply?: unknown; tokens?: Array<{ symbol?: unknown; priceUsd?: unknown; decimals?: unknown; totalRaw?: unknown }> };
    try {
      row = JSON.parse(line);
    } catch {
      dropped++;
      continue;
    }
    const nav = row.navUsd;
    const key = `${row.chainId}:${row.vaultKey}`;
    const toks = row.tokens ?? [];
    const broken =
      typeof nav !== 'number' || !Number.isFinite(nav) || nav <= 0 ||
      toks.length === 0 ||
      toks.some((t) => typeof t.priceUsd !== 'number' || !Number.isFinite(t.priceUsd) || t.priceUsd <= 0) ||
      toks.some((t) => t.symbol === '?');
    const prev = lastGoodRow.get(key);
    let residual: number | undefined;
    if (!broken && prev !== undefined) {
      const legs = toks.map((t) => ({
        total: Number(t.totalRaw ?? 0) / 10 ** Number(t.decimals ?? 18),
        price: Number(t.priceUsd),
      }));
      const exp = repricedNav(prev, legs);
      if (exp !== undefined && Number.isFinite(exp) && exp > 0) residual = Math.abs(nav - exp) / exp;
    }
    if (broken || (residual !== undefined && residual > NAV_JUMP_LIMIT)) {
      dropped++;
      continue;
    }
    out.push(line);
    lastGoodRow.set(key, {
      supply: Number(row.supply ?? 0) / 1e18,
      legs: toks.map((t) => ({ total: Number(t.totalRaw ?? 0) / 10 ** Number(t.decimals ?? 18), price: Number(t.priceUsd) })),
      nav: Number(nav),
    });
  }
  if (dropped > 0) {
    writeFileSync(file, `${out.join('\n')}\n`);
    log('warn', 'data sweep dropped rows', { dropped, file });
  }
  return dropped;
}

export async function collectOnce(): Promise<{ wrote: number; chains: number }> {
  const chains = loadChains().filter(
    (c): c is DeployedChain => c.status === 'deployed' && (c.vaults?.length ?? 0) > 0,
  );
  let wrote = 0;
  for (const chain of chains) {
    let readers: ChainReaders;
    try {
      readers = await makeReaders(chain);
    } catch (err) {
      log('warn', 'chain unreachable, skipping', { chainId: chain.chainId, rpcUrl: chain.rpcUrl, error: String(err) });
      continue;
    }
    for (const v of chain.vaults) {
      const row = await snapshotVault(readers, v);
      if (!row) continue;
      const key = `${row.chainId}:${row.vaultKey}`;
      const prev = lastGoodRow.get(key);
      const nav = Number(row.navUsd);
      if (prev !== undefined && Number.isFinite(nav) && row.tokens && row.tokens.length === prev.legs.length) {
        const legs = row.tokens.map((t) => ({
          total: Number(t.totalRaw ?? 0) / 10 ** Number(t.decimals ?? 18),
          price: Number(t.priceUsd),
        }));
        const exp = repricedNav(prev, legs);
        if (exp !== undefined && Number.isFinite(exp) && exp > 0 && Math.abs(nav - exp) / exp > NAV_JUMP_LIMIT) {
          log('warn', 'snapshot rejected — repriced residual beyond limit', { vaultKey: row.vaultKey, navUsd: row.navUsd, expectedNav: exp });
          continue;
        }
      }
      const dataDir = process.env.DATA_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '../data');
      mkdirSync(dataDir, { recursive: true });
      appendFileSync(join(dataDir, 'collect-nav.jsonl'), `${asJson(row)}\n`);
      lastGoodRow.set(key, {
        supply: Number(row.supply ?? 0) / 1e18,
        legs: row.tokens.map((t) => ({
          total: Number(t.totalRaw ?? 0) / 10 ** Number(t.decimals ?? 18),
          price: Number(t.priceUsd),
        })),
        nav,
      });
      wrote++;
      log('info', 'snapshot appended', { chainId: row.chainId, vaultKey: row.vaultKey, tvlUsd: row.tvlUsd, navUsd: row.navUsd });
    }
  }
  return { wrote, chains: chains.length };
}

/* ---------------------------------------------------------------- HTTP serve -------------- */

export function serve(): void {
  const port = Number(process.env.PORT ?? 8080);
  const dataDir = process.env.DATA_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '../data');
  const file = join(dataDir, 'collect-nav.jsonl');
  const CORS = { 'access-control-allow-origin': '*' };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json', ...CORS });
      const rows = existsSync(file)
        ? (() => {
            try {
              const s = statSync(file);
              return { bytes: s.size, modified: s.mtime.toISOString() };
            } catch {
              return null;
            }
          })()
        : null;
      res.end(JSON.stringify({ ok: true, service: 'mysun-collect', file: rows }));
      return;
    }
    if (url.pathname === '/analytics/collect-nav.jsonl' || url.pathname === '/analytics/nav-history.jsonl') {
      if (!existsSync(file)) {
        res.writeHead(404, { 'content-type': 'application/json', ...CORS });
        res.end(JSON.stringify({ error: 'no snapshots yet' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', ...CORS });
      res.end(readFileSync(file));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json', ...CORS });
    res.end(JSON.stringify({ error: 'not found', ok: true, service: 'mysun-collect' }));
  });

  server.listen(port, () => log('info', 'serving', { port, dataDir }));
}

/* ---------------------------------------------------------------- interval loop ----------- */

export async function runLoop(): Promise<void> {
  const intervalMin = Number(process.env.COLLECT_INTERVAL_MIN ?? 60);
  try {
    sweepData();
    const first = await collectOnce();
    log('info', 'initial collect done', { wrote: first.wrote, chains: first.chains });
  } catch (err) {
    log('error', 'initial collect failed, will retry', { error: String(err) });
  }
  setInterval(async () => {
    try {
      await collectOnce();
    } catch (err) {
      log('error', 'collect cycle failed', { error: String(err) });
    }
  }, intervalMin * 60_000);
  serve();
}