/**
 * NAV + fee snapshot collector — the Cloudflare Worker port of backend/src/collect-nav.ts.
 *
 * The collection logic (reads, fee bucketing, pricing, row schema, sweep, continuity guard) is
 * ported as-is from the Railway collector; only the edges changed:
 *   - persistence: a single JSONL blob behind caller-supplied `read`/`write` fns (Workers KV in
 *     production) instead of `DATA_DIR/collect-nav.jsonl`;
 *   - no env reads, no fs, no HTTP server: the registry, the dRPC key and the KV fns are passed in;
 *   - the continuity map is per cycle, seeded by the sweep of the stored blob (a Worker has no
 *     long-lived process — each cron run is the Railway service's "startup sweep + one collect").
 *
 * Read-only by construction: no signer, no wallet client, no transactions.
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

import {
  createPublicClient,
  defineChain,
  http,
  parseAbi,
  type Abi,
  type ContractFunctionParameters,
  type Address,
  type PublicClient,
} from 'viem';

import { vaultAbi } from '../../src/abi/generated.js';
import type { DeployedChain, RegistryChain } from './registry.js';

/** JSON with bigints as decimal strings (the row's raw amounts). */
export function asJson(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
}

/* ---------------------------------------------------------------- tiny logger ------------ */

type Level = 'info' | 'warn' | 'error';
function log(level: Level, msg: string, extra: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, svc: 'mysun-collect', ...extra });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
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
export const adapterFeesAbi = parseAbi([
  'function fees() view returns (address[] tokens, uint256[] amounts)',
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
  /** PENDING fees (adapter `fees()`), in base units — a level, not a running total: a harvest resets it. */
  feeRaw: bigint;
  feeUsd: number;
}

/** One JSONL row. Field ORDER is the wire contract (the frontend parses it) — do not reorder. */
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
  /** Pending (unharvested) fees in USD — the SUM of the legs' feeUsd, not cumulative. */
  feesUsd: number;
  adapterCount: number | null;
  /** The vault's performance-fee cut in bps; null when the read failed. Appended — order is the contract. */
  performanceFeeBps: number | null;
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

/**
 * Accrued fees per token from each adapter's `fees()` = (address[] tokens, uint256[] amounts): the
 * GROSS fee part per token, index-aligned with position() — bucket each amount under ITS OWN
 * returned token (never the venue pair; the returned addresses are the accounting they belong to).
 * `undefined` = the adapter has no fees view (contributes nothing). Keys are lowercased addresses.
 */
export function bucketFees(
  results: ReadonlyArray<readonly [readonly Address[], readonly bigint[]] | undefined>,
): Map<string, bigint> {
  const feeRaw = new Map<string, bigint>();
  for (const f of results) {
    if (!f) continue; // adapter without the fees view contributes nothing
    const feeToks = f[0];
    const feeAmts = f[1];
    if (feeToks.length !== feeAmts.length) throw new Error('adapter fees() misaligned arrays');
    for (let j = 0; j < feeToks.length; j++) {
      const tokAddr = String(feeToks[j] ?? '').toLowerCase();
      if (tokAddr && tokAddr !== ZERO) {
        feeRaw.set(tokAddr, (feeRaw.get(tokAddr) ?? 0n) + (feeAmts[j] ?? 0n));
      }
    }
  }
  return feeRaw;
}

/* ---------------------------------------------------------------- chain snapshot ---------- */

type VaultEntry = NonNullable<RegistryChain['vaults']>[number];

/** The chain's token metadata + spot prices (rounds 1–4). Keys are lowercased addresses. */
export interface ChainPrices {
  anchor: Address | null;
  anchorDecimals: number;
  prices: Map<string, { priceUsd: number; tokenIsToken0: boolean; pool: Address }>;
  symbols: Map<string, string>;
  decimals: Map<string, number>;
}

/** One read's outcome — a multicall leg with `allowFailure`. */
export type Read<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** One vault's state reads (round 5). */
export interface VaultReads {
  supply: Read<bigint>;
  totals: Read<readonly [readonly Address[], readonly bigint[]]>;
  adapters: Read<readonly Address[]>;
  /** null when the read failed (the column is then null, the row still written). */
  performanceFeeBps: number | null;
}

/** Each adapter's `fees()` (round 6), keyed by lowercased adapter address; `undefined` = failed/no view. */
export type AdapterFees = Map<string, readonly [readonly Address[], readonly bigint[]] | undefined>;

/** Optional dRPC API key (paid tier): unlocks higher burst limits. Unset ⇒ the public endpoint. */
function drpcHeaders(key: string | undefined): { headers?: Record<string, string> } {
  return key ? { headers: { 'x-api-key': key } } : {};
}

/**
 * Calldata bytes per multicall3 `aggregate3` before viem's batch scheduler splits it into another
 * `eth_call` (viem's default: 1024). The largest round — `routes(anchor, token)`, 68 B per token —
 * is 884 B on 4663 today; 8 KiB keeps every round one HTTP request as the registry grows.
 */
const MULTICALL_BATCH_BYTES = 8_192;

/**
 * The production client: the registry's public RPC URL, plus the dRPC key header when given.
 * Worker-only difference from the Railway client: multicall3 batching. The Workers Free plan caps
 * subrequests per invocation at 50; `collectOnce` reads each chain in six chain-wide
 * `client.multicall` rounds (see `readChainPrices` / `readVaults`), each folded into one `eth_call`
 * (≈ 6 HTTP subrequests per chain, was 72 with per-vault reads). Failure handling is per leg
 * (allowFailure), so a reverting `fees()` still fails only its own adapter.
 */
export function defaultClient(chain: DeployedChain, drpcApiKey: string | undefined): PublicClient {
  return createPublicClient({
    batch: { multicall: { batchSize: MULTICALL_BATCH_BYTES } },
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
    transport: http(chain.rpcUrl, { retryCount: 3, timeout: 20_000, fetchOptions: drpcHeaders(drpcApiKey) }),
  });
}

interface Call {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
}

/**
 * One chain-wide round: every call in ONE `client.multicall` (allowFailure). Never throws — a
 * failed leg, or the whole multicall failing, comes back as `{ ok: false }` per call, exactly as the
 * per-call reads it replaces would each have rejected.
 */
async function readAll(client: PublicClient, calls: readonly Call[]): Promise<Read<unknown>[]> {
  if (calls.length === 0) return [];
  try {
    const res = await client.multicall({ contracts: calls as readonly ContractFunctionParameters[], allowFailure: true });
    return calls.map((_c, i): Read<unknown> => {
      const r = res[i] as { status: 'success'; result: unknown } | { status: 'failure'; error: unknown } | undefined;
      if (r === undefined) return { ok: false, error: new Error('multicall returned fewer results than calls') };
      return r.status === 'success' ? { ok: true, value: r.result } : { ok: false, error: r.error };
    });
  } catch (error) {
    return calls.map(() => ({ ok: false, error }));
  }
}

/**
 * Rounds 1–4: basket tokens of every vault, their symbol/decimals, the zap routes (USDG, token) and
 * the reference pools' token0/token1/slot0 — one multicall each. Throws (⇒ the chain is skipped as
 * unreachable) only when a vault's `tokens()` read fails, like the sequential reader it replaces.
 */
async function readChainPrices(chain: DeployedChain, client: PublicClient): Promise<ChainPrices> {
  const symbols = new Map<string, string>();
  const decimals = new Map<string, number>();
  let anchor: Address | null = null;
  let anchorDecimals = 6;

  // Round 1: tokens() per vault, collecting every basket token (deduped) for symbol/decimals.
  const tokenReads = await readAll(
    client,
    chain.vaults.map((v) => ({ address: v.vault, abi: vaultAbi, functionName: 'tokens' })),
  );
  const seen = new Set<string>();
  const metaCalls: Call[] = [];
  for (const t of tokenReads) {
    if (!t.ok) throw t.error;
    for (const tok of t.value as Address[]) {
      if (!seen.has(tok.toLowerCase())) {
        seen.add(tok.toLowerCase());
        metaCalls.push(
          { address: tok, abi: erc20MetaAbi, functionName: 'symbol' },
          { address: tok, abi: erc20MetaAbi, functionName: 'decimals' },
        );
      }
    }
  }

  // Round 2: symbol + decimals for every distinct token.
  const meta = await readAll(client, metaCalls);
  for (let i = 0; i < metaCalls.length; i += 2) {
    const call = metaCalls[i];
    if (!call) continue; // length is always even; guard for the index math
    const addr = call.address;
    const symR = meta[i];
    const decR = meta[i + 1];
    const sym = symR?.ok === true ? (symR.value as string | undefined) : undefined;
    const dec = decR?.ok === true ? (decR.value as number | bigint | undefined) : undefined;
    if (sym) symbols.set(addr.toLowerCase(), sym);
    if (dec !== undefined) decimals.set(addr.toLowerCase(), Number(dec));
    if (sym === ANCHOR_SYMBOL) {
      anchor = addr;
      anchorDecimals = dec !== undefined ? Number(dec) : 6;
    }
  }

  // Reference pools: the chain's zap periphery routes (USDG, token) -> refPool -> slot0.
  const prices = new Map<string, { priceUsd: number; tokenIsToken0: boolean; pool: Address }>();
  const zapIn = chain.periphery?.zapIn;
  const anchorAddr: Address | null = anchor;
  if (anchorAddr && zapIn) {
    // Round 3: routes(anchor, token) for every non-anchor token.
    const priced = [...seen].filter((tok) => !same(tok, anchorAddr));
    const routeReads = await readAll(
      client,
      priced.map((tok) => ({ address: zapIn, abi: zapInRoutesAbi, functionName: 'routes', args: [anchorAddr, tok as Address] })),
    );
    const refPoolOf = new Map<string, Address>();
    for (let i = 0; i < priced.length; i++) {
      const tok = priced[i] as string;
      const r = routeReads[i];
      if (!r?.ok) {
        log('warn', 'route read failed', { chainId: chain.chainId, token: tok, error: String(r?.error) });
        continue;
      }
      const refPool = (r.value as readonly unknown[])[0] as Address;
      if (refPool === ZERO) continue;
      refPoolOf.set(tok, refPool);
    }

    // Round 4: token0 / token1 / slot0 for every distinct reference pool.
    const pools = [...new Set([...refPoolOf.values()].map((p) => p.toLowerCase()))] as Address[];
    const poolReads = await readAll(
      client,
      pools.flatMap((p) => [
        { address: p, abi: v3PoolAbi, functionName: 'token0' },
        { address: p, abi: v3PoolAbi, functionName: 'token1' },
        { address: p, abi: v3PoolAbi, functionName: 'slot0' },
      ]),
    );
    const poolState = new Map<string, [Read<unknown>, Read<unknown>, Read<unknown>]>();
    pools.forEach((p, i) => {
      poolState.set(p, [poolReads[3 * i] as Read<unknown>, poolReads[3 * i + 1] as Read<unknown>, poolReads[3 * i + 2] as Read<unknown>]);
    });

    for (const [tok, refPool] of refPoolOf) {
      const [t0, t1, s0] = poolState.get(refPool.toLowerCase()) ?? [];
      const failed = [t0, t1, s0].find((x) => !x?.ok);
      if (failed !== undefined || !t0?.ok || !t1?.ok || !s0?.ok) {
        const error = failed && !failed.ok ? failed.error : new Error(`no reads for pool ${refPool}`);
        log('warn', 'route read failed', { chainId: chain.chainId, token: tok, error: String(error) });
        continue;
      }
      const tokenIsToken0 = same(t0.value as Address, tok);
      if (!tokenIsToken0 && !same(t1.value as Address, tok)) continue; // ref pool is not the (USDG, token) pair
      const sqrtPriceX96 = (s0.value as readonly unknown[])[0] as bigint;
      const priceUsd = priceUsdFromSpot(sqrtPriceX96, tokenIsToken0, decimals.get(tok.toLowerCase()) ?? 18);
      if (Number.isFinite(priceUsd)) prices.set(tok.toLowerCase(), { priceUsd, tokenIsToken0, pool: refPool });
    }
  }

  log('info', 'prices ready', {
    chainId: chain.chainId,
    anchor: anchor ?? null,
    n: prices.size,
    prices: [...prices.entries()].map(([k, v]) => [k.slice(0, 8), v.priceUsd]),
  });

  return { anchor, anchorDecimals, prices, symbols, decimals };
}

/**
 * Rounds 5–6: every vault's totalSupply / totalTokens / adapters / performanceFeeBps in one
 * multicall, then every adapter's fees() (deduped) in one more. Never throws — failures are per read.
 */
async function readVaults(
  chain: DeployedChain,
  client: PublicClient,
): Promise<{ vaults: VaultReads[]; fees: AdapterFees }> {
  const state = await readAll(
    client,
    chain.vaults.flatMap((v) => [
      { address: v.vault, abi: vaultAbi, functionName: 'totalSupply' },
      { address: v.vault, abi: vaultAbi, functionName: 'totalTokens' },
      { address: v.vault, abi: vaultAbi, functionName: 'adapters' },
      { address: v.vault, abi: vaultAbi, functionName: 'performanceFeeBps' },
    ]),
  );
  const vaults = chain.vaults.map((_v, i): VaultReads => {
    const feeBps = state[4 * i + 3];
    return {
      supply: state[4 * i] as Read<bigint>,
      totals: state[4 * i + 1] as Read<readonly [readonly Address[], readonly bigint[]]>,
      adapters: state[4 * i + 2] as Read<readonly Address[]>,
      performanceFeeBps: feeBps?.ok ? Number(feeBps.value as number | bigint) : null,
    };
  });

  const adapters = [
    ...new Set(vaults.flatMap((v) => (v.adapters.ok ? v.adapters.value.map((a) => a.toLowerCase()) : []))),
  ] as Address[];
  const feeReads = await readAll(
    client,
    adapters.map((a) => ({ address: a, abi: adapterFeesAbi, functionName: 'fees' })),
  );
  const fees: AdapterFees = new Map();
  adapters.forEach((a, i) => {
    const f = feeReads[i];
    fees.set(a, f?.ok ? (f.value as readonly [readonly Address[], readonly bigint[]]) : undefined);
  });
  return { vaults, fees };
}

/**
 * One vault's row from already-read values — pure (no client), the unit tests drive it directly.
 * Throws (⇒ the snapshot is rejected) on a failed supply / totals / adapters read, a missing spot
 * price, or misaligned fees() arrays.
 */
export function assembleRow(
  chain: DeployedChain,
  p: ChainPrices,
  v: VaultEntry,
  reads: VaultReads,
  fees: AdapterFees,
  ts: string,
): SnapshotRow {
  if (!reads.supply.ok) throw reads.supply.error;
  if (!reads.totals.ok) throw reads.totals.error;
  if (!reads.adapters.ok) throw reads.adapters.error;
  const supply = reads.supply.value;
  const tokens = reads.totals.value[0];
  const amounts = reads.totals.value[1];
  const adapters = reads.adapters.value;

  // Pending fees: each adapter's fees() bucketed per returned token (see bucketFees). This is the
  // UNHARVESTED balance — a harvest resets it — which is why the reader (chain/feeApy.ts) integrates
  // the upward steps instead of differencing the level.
  let feeRaw = new Map<string, bigint>();
  let adapterCount: number | null = null;
  if (adapters && adapters.length > 0) {
    adapterCount = adapters.length;
    feeRaw = bucketFees(adapters.map((a) => fees.get(a.toLowerCase())));
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
      p.anchor && same(tok, p.anchor) ? 1 : (p.prices.get(tok)?.priceUsd ?? Number.NaN);
    if (!Number.isFinite(priceUsd)) {
      // A missing spot is a failed read, not a zero price: writing a 0-valued leg would sink the
      // vault's NAV for the whole cycle. Fail the snapshot instead (the row is then skipped).
      throw new Error(`spot price miss for ${tok} (${p.symbols.get(tok) ?? '?'}) — snapshot rejected`);
    }
    const displayPrice = priceUsd;
    const wholeTokens = Number(totalRaw) / 10 ** (p.decimals.get(tok) ?? 18);
    const totalUsd = wholeTokens * displayPrice; // display only; the vault never values on-chain
    const feeRawN = feeRaw.get(tok) ?? 0n;
    const feeWhole = Number(feeRawN) / 10 ** (p.decimals.get(tok) ?? 18);
    tvlUsd += totalUsd;
    feesUsd += feeWhole * displayPrice;
    members.push({
      address: tokAddr,
      symbol: p.symbols.get(tok) ?? '?',
      decimals: p.decimals.get(tok) ?? 18,
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
    chainId: chain.chainId,
    chain: chain.name,
    vaultKey: v.key,
    vault: v.vault,
    supply,
    tokenCount: members.length,
    tokens: members,
    tvlUsd,
    navUsd: supply > 0n ? tvlUsd / supplyNum : null,
    feesUsd,
    adapterCount,
    performanceFeeBps: reads.performanceFeeBps,
  };
}

/* ---------------------------------------------------------------- continuity + sweep ------ */

/** Last GOOD row per vault (keyed `chainId:key`) — the continuity guard's reference. */
export type ContinuityMap = Map<string, NavRef>;
export const NAV_JUMP_LIMIT = 0.15; // repriced residual beyond 15% = a failed read, not a move

export interface NavRef {
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
 * Data hygiene over the stored JSONL: drop rows that carry a failed read (missing / zero /
 * non-finite token price, a '?' symbol, null NAV) or a NAV jump beyond `NAV_JUMP_LIMIT` from the
 * previous good row of the same vault, and seed the continuity map. Returns the text to store —
 * the input untouched when nothing was dropped, else the kept lines rewritten — and the drop count.
 */
export function sweepData(text: string, lastGoodRow: ContinuityMap = new Map()): { text: string; dropped: number } {
  lastGoodRow.clear();
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
    log('warn', 'data sweep dropped rows', { dropped });
    return { text: `${out.join('\n')}\n`, dropped };
  }
  return { text, dropped };
}

/* ---------------------------------------------------------------- collect ----------------- */

export interface CollectDeps {
  /** The validated registry (see registry.ts `loadChains`). */
  chains: readonly RegistryChain[];
  /** dRPC key header; unset ⇒ the registry's public RPC, exactly like the Railway collector. */
  drpcApiKey?: string | undefined;
  /** Client factory — the test seam; defaults to `defaultClient`. */
  clientFor?: (chain: DeployedChain, drpcApiKey: string | undefined) => PublicClient;
}

/**
 * One snapshot pass over every deployed chain/vault. Returns the JSONL lines (each ending `\n`) of
 * the rows that passed the continuity guard; `lastGoodRow` is read and advanced in place.
 * Unreachable chains and failed vault snapshots are skipped (logged), never thrown.
 */
export async function collectOnce(
  deps: CollectDeps,
  lastGoodRow: ContinuityMap = new Map(),
): Promise<{ lines: string[]; wrote: number; chains: number }> {
  const clientFor = deps.clientFor ?? defaultClient;
  const chains = deps.chains.filter(
    (c): c is DeployedChain => c.status === 'deployed' && (c.vaults?.length ?? 0) > 0,
  );
  const lines: string[] = [];
  for (const chain of chains) {
    let prices: ChainPrices;
    let client: PublicClient;
    try {
      client = clientFor(chain, deps.drpcApiKey);
      prices = await readChainPrices(chain, client);
    } catch (err) {
      log('warn', 'chain unreachable, skipping', { chainId: chain.chainId, rpcUrl: chain.rpcUrl, error: String(err) });
      continue;
    }
    const ts = new Date().toISOString(); // one read pass ⇒ one timestamp for the chain's rows
    const { vaults, fees } = await readVaults(chain, client);
    for (const [i, v] of chain.vaults.entries()) {
      let row: SnapshotRow;
      try {
        row = assembleRow(chain, prices, v, vaults[i] as VaultReads, fees, ts);
      } catch (err) {
        log('error', 'vault snapshot failed', { chainId: chain.chainId, vault: v.key, error: String(err) });
        continue;
      }
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
      lines.push(`${asJson(row)}\n`);
      lastGoodRow.set(key, {
        supply: Number(row.supply ?? 0) / 1e18,
        legs: row.tokens.map((t) => ({
          total: Number(t.totalRaw ?? 0) / 10 ** Number(t.decimals ?? 18),
          price: Number(t.priceUsd),
        })),
        nav,
      });
      log('info', 'snapshot appended', { chainId: row.chainId, vaultKey: row.vaultKey, tvlUsd: row.tvlUsd, navUsd: row.navUsd });
    }
  }
  return { lines, wrote: lines.length, chains: chains.length };
}

/* ---------------------------------------------------------------- one cron cycle ---------- */

export interface BlobIo {
  /** The stored JSONL, or null when nothing has been written yet. */
  read(): Promise<string | null>;
  /** Replace the stored JSONL (the single writer is the cron — no CAS). */
  write(text: string): Promise<void>;
}

/**
 * Sweep the stored blob (seeding the continuity guard), collect once, and store the result with a
 * single write: the swept text plus the appended rows. No write when nothing changed.
 */
export async function runCycle(
  io: BlobIo,
  deps: CollectDeps,
): Promise<{ dropped: number; wrote: number; chains: number; stored: boolean }> {
  const lastGoodRow: ContinuityMap = new Map();
  const before = (await io.read()) ?? '';
  const swept = sweepData(before, lastGoodRow);
  const { lines, wrote, chains } = await collectOnce(deps, lastGoodRow);
  if (swept.dropped === 0 && wrote === 0) return { dropped: 0, wrote, chains, stored: false };
  // Appending to a blob that lost its trailing newline must not glue two rows onto one line.
  const base = swept.text !== '' && !swept.text.endsWith('\n') ? `${swept.text}\n` : swept.text;
  await io.write(base + lines.join(''));
  return { dropped: swept.dropped, wrote, chains, stored: true };
}
