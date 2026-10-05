import type { UserState } from '@/lib/types';
import { VAULT_BY_ID } from './vaults';

const DAY = 86_400_000;

/**
 * Demo wallet state loaded on first connect — MOCK-DATA-SPEC §5.
 * Cost basis is set so total Net PnL = +$412 (+3.4%).
 */
export function demoUserState(now = Date.now()): UserState {
  const nvda = VAULT_BY_ID['nvda-usdg'];
  const eth = VAULT_BY_ID['eth-usdg'];
  const nvdaValue = 9_800 * nvda.pricePerShare; // ≈ 9,831
  const ethValue = 2_540 * eth.pricePerShare; // ≈ 2,567
  const total = nvdaValue + ethValue; // ≈ 12,398
  const pnl = 412;
  const costTotal = total - pnl;
  return {
    balances: { USDG: 25_000, NVDA: 15, PMG: 3_400 },
    positions: {
      'nvda-usdg': { staked: 9_800, unstaked: 0, costBasis: (costTotal * nvdaValue) / total, depositedAt: now - 41 * DAY },
      'eth-usdg': { staked: 2_540, unstaked: 0, costBasis: (costTotal * ethValue) / total, depositedAt: now - 19 * DAY },
    },
    pendingTide: 1_224,
    pendingUpdatedAt: now,
    locks: [
      {
        id: 'lock-demo-1',
        amount: 36_500,
        lockedAt: now - 22 * DAY,
        unlockAt: now + 68 * DAY,
        redistributionEarned: 38.2,
      },
      {
        id: 'lock-demo-0',
        amount: 2_150,
        lockedAt: now - 95 * DAY,
        unlockAt: now - 5 * DAY, // matured — shows the Unlock state
        redistributionEarned: 12.6,
      },
    ],
    tvlDelta: {},
    degenAcknowledged: false,
    history: [],
  };
}

export function emptyUserState(now = Date.now()): UserState {
  return {
    balances: { USDG: 0, NVDA: 0, PMG: 0 },
    positions: {},
    pendingTide: 0,
    pendingUpdatedAt: now,
    locks: [],
    tvlDelta: {},
    degenAcknowledged: false,
    history: [],
  };
}
