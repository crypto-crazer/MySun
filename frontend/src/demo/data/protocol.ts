import { CONSTANTS } from '@/demo/constants';

/** Protocol / flywheel figures — MOCK-DATA-SPEC §4. */
export const PROTOCOL = {
  weeklyEmissionsTide: CONSTANTS.WEEKLY_EMISSIONS_TIDE,
  weeklyEmissionsUsd: CONSTANTS.WEEKLY_EMISSIONS_TIDE * CONSTANTS.TIDE_PRICE, // $42,000
  lastWeekRevenueUsd: 17_300,
  buybackThisWeekUsd: 8_600,
  circulatingTide: 74_000_000,
  allocation: [
    { label: 'Community mining', pct: 0.5 },
    { label: 'Team', pct: 0.15 },
    { label: 'Treasury', pct: 0.15 },
    { label: 'POL & liquidity', pct: 0.1 },
    { label: 'Marketing', pct: 0.05 },
    { label: 'Advisors', pct: 0.05 },
  ],
} as const;
