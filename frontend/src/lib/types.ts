import type { ChainId } from '@/demo/data/chains';

export type Tier = 'Core' | 'Turbo' | 'Degen';

export interface Vault {
  id: string;
  token0: string;
  token1: string;
  receiptSymbol: string;
  chain: ChainId;
  /** The Uniswap pool the vault provides liquidity in. */
  poolVersion: 'v3' | 'v4';
  /** That pool's fee tier, in Uniswap's units (hundredths of a basis point: 500 = 0.05%). */
  poolFee: number;
  tier: Tier;
  tvl: number;
  /** The pool's trading volume over the last 24 hours, in USD (the whole pool, not the vault's share). */
  volume24h: number;
  feeApr7d: number;
  emissionWeight: number;
  rangeWidthPct: number;
  pricePerShare: number;
  currentPrice: number; // token0 priced in token1
  rangeCenter: number;
  timeInRange7d: number;
  lastRebalanceDaysAgo: number;
  rebalances30d: number;
  /** Receipt-token end value minus HODL benchmark end value (negative = benchmark ahead). */
  benchmarkLead: number;
}

export interface Position {
  staked: number; // receipt-token units
  unstaked: number; // receipt-token units
  costBasis: number; // USD paid in
  depositedAt: number;
}

export type TxKind = 'deposit' | 'withdraw' | 'stake';

export interface TxRecord {
  id: string;
  kind: TxKind;
  at: number;
  label: string;
}

export interface UserState {
  balances: Record<string, number>;
  positions: Record<string, Position>;
  pendingTide: number;
  pendingUpdatedAt: number;
  /** Deposits/withdrawals since load shift vault TVL by this much (USD). */
  tvlDelta: Record<string, number>;
  degenAcknowledged: boolean;
  history: TxRecord[];
}

export type RangeStatus = 'in' | 'out' | 'defensive';
