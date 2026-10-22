import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import {
  getSqrtRatioAtTick,
  getTickAtSqrtRatio,
  MAX_SQRT_RATIO,
  MAX_TICK,
  MIN_SQRT_RATIO,
  MIN_TICK,
  ratioX128AtTick,
} from '@/chain/ticks';
import { priceBands, tickPriceInAnchor, type AdapterPosition } from '@/chain/ranges';
import { rangePairsFor } from '@/components/vault/rangePairs';

const Q96 = 2n ** 96n;
const MAX_UINT256 = (1n << 256n) - 1n;

describe('TickMath port — the Solidity constants', () => {
  it('the Q128.128 ladder: tick 0 → 2^128, |tick| 1 → 0xfffcb933…4001 (negative side), its reciprocal for +1', () => {
    expect(ratioX128AtTick(0)).toBe(0x100000000000000000000000000000000n);
    // The ladder constant is 1/sqrt(1.0001): the NEGATIVE tick; a positive tick takes uint256.max / ratio.
    expect(ratioX128AtTick(-1)).toBe(0xfffcb933bd6fad37aa2d162d1a594001n);
    expect(ratioX128AtTick(1)).toBe(MAX_UINT256 / 0xfffcb933bd6fad37aa2d162d1a594001n);
  });

  it('getSqrtRatioAtTick matches the contract at 0, ±1 and the domain ends', () => {
    expect(getSqrtRatioAtTick(0)).toBe(Q96);
    expect(getSqrtRatioAtTick(1)).toBe(79232123823359799118286999568n);
    expect(getSqrtRatioAtTick(-1)).toBe(79224201403219477170569942574n);
    expect(getSqrtRatioAtTick(MIN_TICK)).toBe(MIN_SQRT_RATIO);
    expect(getSqrtRatioAtTick(MAX_TICK)).toBe(MAX_SQRT_RATIO);
    expect(() => getSqrtRatioAtTick(MAX_TICK + 1)).toThrow();
    expect(() => getSqrtRatioAtTick(MIN_TICK - 1)).toThrow();
    expect(() => getSqrtRatioAtTick(0.5)).toThrow();
  });

  it('agrees with sqrt(1.0001^tick)·2^96 in floating point across the domain', () => {
    for (const t of [-887000, -291120, -199300, -50000, -7, 7, 50000, 91020, 400000, 887000]) {
      const want = Math.sqrt(1.0001 ** t) * 2 ** 96;
      expect(Number(getSqrtRatioAtTick(t)) / want).toBeCloseTo(1, 9);
    }
  });

  it('getTickAtSqrtRatio: the domain ends, and out-of-domain inputs throw', () => {
    expect(getTickAtSqrtRatio(MIN_SQRT_RATIO)).toBe(MIN_TICK);
    expect(getTickAtSqrtRatio(MAX_SQRT_RATIO - 1n)).toBe(MAX_TICK - 1);
    expect(getTickAtSqrtRatio(Q96)).toBe(0);
    expect(() => getTickAtSqrtRatio(MIN_SQRT_RATIO - 1n)).toThrow();
    expect(() => getTickAtSqrtRatio(MAX_SQRT_RATIO)).toThrow();
  });

  it('round trip: tick → ratio → tick is the identity', () => {
    for (const t of [MIN_TICK, -887271, -291120, -289860, -199300, -198090, -1, 0, 1, 91020, 92280, 887271]) {
      expect(getTickAtSqrtRatio(getSqrtRatioAtTick(t))).toBe(t);
    }
  });

  it('property: getSqrtRatioAtTick(getTickAtSqrtRatio(x)) ≤ x < getSqrtRatioAtTick(that tick + 1)', () => {
    // Deterministic pseudo-random sqrt ratios spread over the whole domain (log-uniform).
    let seed = 0x9e3779b9;
    const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const span = MAX_SQRT_RATIO - MIN_SQRT_RATIO;
    const samples = [MIN_SQRT_RATIO, MIN_SQRT_RATIO + 1n, Q96 - 1n, Q96 + 1n, MAX_SQRT_RATIO - 1n];
    for (let i = 0; i < 300; i++) {
      const bits = BigInt(Math.floor(rand() * 159) + 1);
      const x = MIN_SQRT_RATIO + ((BigInt(Math.floor(rand() * 2 ** 52)) << bits) >> 52n) % span;
      samples.push(x);
    }
    // The slot0 ticks of the live RHC reference pools (sqrtPriceX96 fixtures from spot.test).
    samples.push(3898977735850902606713713n, 40521278812979596376244n);
    for (const x of samples) {
      const t = getTickAtSqrtRatio(x);
      expect(getSqrtRatioAtTick(t) <= x).toBe(true);
      if (t < MAX_TICK) expect(x < getSqrtRatioAtTick(t + 1)).toBe(true);
    }
  });
});

/* Robinhood Chain (4663) addresses and adapter `positionState` ticks, captured 2026-10-19 (fixtures, not live). */
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as Address; // 6 dp
const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73' as Address; // 18 dp
const PONS = '0x39dBED3a2bd333467115dE45665cC57F813C4571' as Address; // 18 dp
const TOKENS = [
  { address: USDG, symbol: 'USDG', decimals: 6 },
  { address: WETH, symbol: 'WETH', decimals: 18 },
  { address: PONS, symbol: 'PONS', decimals: 18 },
];
const usdg = TOKENS[0], weth = TOKENS[1], pons = TOKENS[2];
const pos = (token0: Address, token1: Address, tickLower: number, tickUpper: number, id = 1n): AdapterPosition => ({ token0, token1, id, tickLower, tickUpper });
/** USDG per whole token at a tick, by plain floats: 1.0001^tick raw token1/token0, decimal-shifted. */
const floatPrice = (tick: number, tokenIsToken0: boolean, tokenDec: number, anchorDec: number) =>
  tokenIsToken0 ? 1.0001 ** tick * 10 ** (tokenDec - anchorDec) : 10 ** (tokenDec - anchorDec) / 1.0001 ** tick;

describe('tickPriceInAnchor — a tick bound as a USDG price', () => {
  it('token0 priced (WETH/USDG): a higher tick is a higher price', () => {
    const lo = tickPriceInAnchor(-199300, weth, usdg, WETH, USDG)!;
    const hi = tickPriceInAnchor(-198090, weth, usdg, WETH, USDG)!;
    expect(lo / floatPrice(-199300, true, 18, 6)).toBeCloseTo(1, 6);
    expect(hi / floatPrice(-198090, true, 18, 6)).toBeCloseTo(1, 6);
    expect(lo).toBeGreaterThan(2_000);
    expect(hi).toBeLessThan(2_600);
    expect(lo).toBeLessThan(hi);
  });

  it('token1 priced (USDG/WETH ordering): the same pool inverted', () => {
    const p = tickPriceInAnchor(198090, weth, usdg, USDG, WETH)!;
    expect(p / floatPrice(198090, false, 18, 6)).toBeCloseTo(1, 6);
    expect(p / tickPriceInAnchor(-198090, weth, usdg, WETH, USDG)!).toBeCloseTo(1, 6);
  });

  it('a pool that is not (token, USDG) prices nothing — e.g. the WETH/PONS adapters', () => {
    expect(tickPriceInAnchor(91020, weth, usdg, WETH, PONS)).toBeUndefined();
    expect(tickPriceInAnchor(91020, pons, usdg, WETH, PONS)).toBeUndefined();
    expect(tickPriceInAnchor(MAX_TICK + 1, weth, usdg, WETH, USDG)).toBeUndefined();
  });
});

describe('priceBands — min lower / max upper per token, bucketed by the (token, USDG) pair', () => {
  it('a single position is its own band', () => {
    const bands = priceBands(TOKENS, 'USDG', [pos(PONS, USDG, -291120, -289860)]);
    const b = bands.get(PONS.toLowerCase())!;
    expect(b.lower / floatPrice(-291120, true, 18, 6)).toBeCloseTo(1, 6);
    expect(b.upper / floatPrice(-289860, true, 18, 6)).toBeCloseTo(1, 6);
    expect(bands.has(WETH.toLowerCase())).toBe(false);
  });

  it('several adapters on one token: the lowest lower and the highest upper', () => {
    // The 4663 `main` vault: one v3 + several v4 native-ETH positions with staggered lower ticks.
    const bands = priceBands(TOKENS, 'USDG', [
      pos(WETH, USDG, -203170, -196970),
      pos(WETH, USDG, -203210, -196970),
      pos(WETH, USDG, -199390, -196970),
      pos(WETH, USDG, -200240, -197080),
    ]);
    const b = bands.get(WETH.toLowerCase())!;
    expect(b.lower).toBeCloseTo(tickPriceInAnchor(-203210, weth, usdg, WETH, USDG)!, 9);
    expect(b.upper).toBeCloseTo(tickPriceInAnchor(-196970, weth, usdg, WETH, USDG)!, 9);
  });

  it('mixed basket: each token gets its own adapters; cross pairs and both token orders handled', () => {
    // The 4663 `tri` vault shape: WETH/USDG + PONS/USDG + WETH/PONS adapters, plus a USDG-first pool.
    const bands = priceBands(TOKENS, 'USDG', [
      pos(WETH, USDG, -199300, -198090),
      pos(PONS, USDG, -291120, -289860),
      pos(WETH, PONS, 91020, 92280), // no USDG side: contributes to neither band
      pos(USDG, WETH, 197000, 197500), // token1-priced: higher tick = lower price, still bucketed to WETH
    ]);
    const w = bands.get(WETH.toLowerCase())!;
    expect(w.lower).toBeCloseTo(tickPriceInAnchor(-199300, weth, usdg, WETH, USDG)!, 9);
    expect(w.upper).toBeCloseTo(tickPriceInAnchor(197000, weth, usdg, USDG, WETH)!, 9);
    expect(w.upper).toBeGreaterThan(tickPriceInAnchor(-198090, weth, usdg, WETH, USDG)!);
    const p = bands.get(PONS.toLowerCase())!;
    expect(p.lower).toBeCloseTo(tickPriceInAnchor(-291120, pons, usdg, PONS, USDG)!, 12);
    expect(p.upper).toBeCloseTo(tickPriceInAnchor(-289860, pons, usdg, PONS, USDG)!, 12);
    expect(bands.has(USDG.toLowerCase())).toBe(false);
  });

  it('no position → no band: id 0 adapters, empty input, no anchor in the basket', () => {
    expect(priceBands(TOKENS, 'USDG', [pos(WETH, USDG, 0, 0, 0n), pos(WETH, USDG, -199300, -198090, 0n)]).size).toBe(0);
    expect(priceBands(TOKENS, 'USDG', []).size).toBe(0);
    expect(priceBands([weth, pons], 'USDG', [pos(WETH, USDG, -199300, -198090)]).size).toBe(0);
    // An id-0 adapter next to a live one changes nothing.
    const live = priceBands(TOKENS, 'USDG', [pos(WETH, USDG, -199300, -198090)]);
    const mixed = priceBands(TOKENS, 'USDG', [pos(WETH, USDG, -199300, -198090), pos(WETH, USDG, -250000, -150000, 0n)]);
    expect(mixed.get(WETH.toLowerCase())).toEqual(live.get(WETH.toLowerCase()));
  });

  it('an undrawable bound (floors to 0 at the bottom of the domain) contributes nothing', () => {
    expect(priceBands(TOKENS, 'USDG', [pos(WETH, USDG, MIN_TICK, -198090)]).size).toBe(0);
  });
});

describe('rangePairsFor — live spot between the real band', () => {
  const prices = new Map([[USDG.toLowerCase(), 1], [WETH.toLowerCase(), 2_300], [PONS.toLowerCase(), 0.24]]);

  it('one pair per non-USDG token that has both a spot and a band, named for display (WETH as ETH)', () => {
    const bands = priceBands(TOKENS, 'USDG', [pos(WETH, USDG, -199300, -198090), pos(PONS, USDG, -291120, -289860)]);
    const pairs = rangePairsFor(TOKENS, prices, bands);
    expect(pairs.map((p) => p.base)).toEqual(['ETH', 'PONS']);
    expect(pairs[0]).toEqual({ base: 'ETH', quote: 'USDG', price: 2_300, ...bands.get(WETH.toLowerCase())! });
  });

  it('a token without a band is left out — never a fixed-width fallback', () => {
    const bands = priceBands(TOKENS, 'USDG', [pos(PONS, USDG, -291120, -289860)]);
    expect(rangePairsFor(TOKENS, prices, bands).map((p) => p.base)).toEqual(['PONS']);
    expect(rangePairsFor(TOKENS, prices, new Map())).toEqual([]);
  });

  it('a token with a band but no spot is left out too', () => {
    const bands = priceBands(TOKENS, 'USDG', [pos(WETH, USDG, -199300, -198090)]);
    expect(rangePairsFor(TOKENS, new Map([[USDG.toLowerCase(), 1]]), bands)).toEqual([]);
  });
});
