import type { Tier } from '@/lib/types';
import type { Vault } from '@/lib/types';

/** The dollar token every vault takes and pays out in. */
export const STABLE = 'USDG';

/** Spot prices in USD, as traded on Robinhood Chain on 2026-10-01. */
export const TOKEN_PRICES: Record<string, number> = {
  USDG: 1.0,
  ETH: 2710,
  NVDA: 231.15,
  SPCX: 151.55,
  SPY: 768,
  PONS: 0.535,
  CASHCAT: 0.169,
  PMG: 0.042,
};

export const TOKEN_COLORS: Record<string, string> = {
  USDG: '#C4E06B',
  ETH: '#627EEA',
  NVDA: '#76B900',
  SPCX: '#9AA4B2',
  SPY: '#273F33',
  PONS: '#A2ADA2',
  CASHCAT: '#C9A227',
  PMG: '#8B9CF7',
};

export const TIER_CAPACITY: Record<Tier, number> = {
  Core: 10_000_000,
  Turbo: 3_000_000,
  Degen: 1_000_000,
};

/** Pool price = token0 priced in token1. */
function pairPrice(token0: string, token1: string): number {
  return TOKEN_PRICES[token0] / TOKEN_PRICES[token1];
}

/**
 * The first-phase pairs, all on Robinhood Chain. Prices are real; TVL, APR and range figures are
 * demo figures until the vaults are live.
 */
export const VAULTS: Vault[] = [
  {
    id: 'eth-usdg',
    token0: 'ETH',
    token1: 'USDG',
    receiptSymbol: 'sunEthLP',
    chain: 'robinhood',
    tier: 'Turbo', // trades around the clock, so it never takes the market-closed stance
    tvl: 2_400_000,
    feeApr7d: 0.186,
    emissionWeight: 0.2,
    rangeWidthPct: 0.1,
    pricePerShare: 1.0105,
    currentPrice: pairPrice('ETH', 'USDG'), // 2,710
    rangeCenter: 2690,
    timeInRange7d: 0.88,
    lastRebalanceDaysAgo: 0.4,
    rebalances30d: 11,
    benchmarkLead: 0.0038,
  },
  {
    id: 'nvda-usdg',
    token0: 'NVDA',
    token1: 'USDG',
    receiptSymbol: 'sunNvdaLP',
    chain: 'robinhood',
    tier: 'Core',
    tvl: 4_200_000,
    feeApr7d: 0.142,
    emissionWeight: 0.3,
    rangeWidthPct: 0.18,
    pricePerShare: 1.0032,
    currentPrice: pairPrice('NVDA', 'USDG'), // 231.15 — slightly above centre, in range
    rangeCenter: 228,
    timeInRange7d: 0.94,
    lastRebalanceDaysAgo: 2,
    rebalances30d: 4,
    benchmarkLead: 0.0032,
  },
  {
    id: 'pons-eth',
    token0: 'PONS',
    token1: 'ETH',
    receiptSymbol: 'sunPonsEthLP',
    chain: 'robinhood',
    tier: 'Degen',
    tvl: 540_000,
    feeApr7d: 0.31,
    emissionWeight: 0.07,
    rangeWidthPct: 0.08,
    pricePerShare: 1.0064,
    currentPrice: pairPrice('PONS', 'ETH'), // ≈ 0.000197
    rangeCenter: 0.000196,
    timeInRange7d: 0.86,
    lastRebalanceDaysAgo: 1.2,
    rebalances30d: 9,
    benchmarkLead: 0.0019,
  },
  {
    id: 'spcx-usdg',
    token0: 'SPCX',
    token1: 'USDG',
    receiptSymbol: 'sunSpcxLP',
    chain: 'robinhood',
    tier: 'Core',
    tvl: 1_800_000,
    feeApr7d: 0.195,
    emissionWeight: 0.15,
    rangeWidthPct: 0.2,
    pricePerShare: 1.0018,
    currentPrice: pairPrice('SPCX', 'USDG'),
    rangeCenter: 149,
    timeInRange7d: 0.91,
    lastRebalanceDaysAgo: 1,
    rebalances30d: 6,
    benchmarkLead: 0.0021,
  },
  {
    id: 'pons-usdg',
    token0: 'PONS',
    token1: 'USDG',
    receiptSymbol: 'sunPonsLP',
    chain: 'robinhood',
    tier: 'Degen',
    tvl: 760_000,
    feeApr7d: 0.264,
    emissionWeight: 0.1,
    rangeWidthPct: 0.08,
    pricePerShare: 0.9987,
    currentPrice: pairPrice('PONS', 'USDG'),
    rangeCenter: 0.53,
    timeInRange7d: 0.83,
    lastRebalanceDaysAgo: 0.4,
    rebalances30d: 11,
    benchmarkLead: -0.0041, // benchmark ahead — honest underperformance
  },
  {
    id: 'cashcat-eth',
    token0: 'CASHCAT',
    token1: 'ETH',
    receiptSymbol: 'sunCashcatEthLP',
    chain: 'robinhood',
    tier: 'Degen',
    tvl: 410_000,
    feeApr7d: 0.886,
    emissionWeight: 0.05,
    rangeWidthPct: 0.05,
    pricePerShare: 0.9612,
    currentPrice: pairPrice('CASHCAT', 'ETH'), // ≈ 0.0000624 — below range → out of range
    rangeCenter: 0.0000712,
    timeInRange7d: 0.61,
    lastRebalanceDaysAgo: 0.1,
    rebalances30d: 27,
    benchmarkLead: -0.0188,
  },
  {
    id: 'spy-eth',
    token0: 'SPY',
    token1: 'ETH',
    receiptSymbol: 'sunSpyEthLP',
    chain: 'robinhood',
    tier: 'Core',
    tvl: 1_300_000,
    feeApr7d: 0.128,
    emissionWeight: 0.13,
    rangeWidthPct: 0.18,
    pricePerShare: 1.0041,
    currentPrice: pairPrice('SPY', 'ETH'), // ≈ 0.2834
    rangeCenter: 0.281,
    timeInRange7d: 0.97,
    lastRebalanceDaysAgo: 5,
    rebalances30d: 3,
    benchmarkLead: 0.0026,
  },
];

export const VAULT_BY_ID: Record<string, Vault> = Object.fromEntries(VAULTS.map((v) => [v.id, v]));

export function vaultName(v: Vault): string {
  return `${v.token0} / ${v.token1}`;
}
