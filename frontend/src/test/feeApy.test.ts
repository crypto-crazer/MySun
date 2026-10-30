/**
 * The fee APR: the window's ACCRUED gross fees (per leg, only the upward steps of the pending series —
 * a harvest must not erase the fees it swept out) × (1 − performanceFeeBps/10⁴) ÷ the window's mean
 * TVL, × 365 ÷ days. The frontend's window is 24 hours, from 1 day of history up. Covers the
 * window-boundary pick, the harvest case (the bug this fixed), short series → undefined, zero accrual,
 * negative steps, per-vault/per-chain cuts, the window line, and the net cut's source.
 */
import { describe, expect, it } from 'vitest';
import type { NavHistoryRow, NavHistoryTokenRow } from '@/chain/navHistory';
import {
  DEFAULT_PERFORMANCE_FEE_BPS,
  FEE_APR_WINDOW_DAYS,
  feeAprWindowDays,
  feeApy,
  feeApyPct,
  feeSeriesFor,
  feesEarnedUsd,
  fmtFeeApr,
  fmtFeeAprWindow,
  grossFeesUsd,
  performanceFeeBpsOf,
} from '@/chain/feeApy';

const T0 = Date.parse('2026-10-01T00:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NET = 1 - DEFAULT_PERFORMANCE_FEE_BPS / 10_000; // 0.9 — the fallback cut

const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';

/** One leg with `whole` pending tokens at $1 (base units scaled by 10⁶). */
function leg(whole: number): NavHistoryTokenRow {
  return { address: USDG, decimals: 6, priceUsd: 1, feeRaw: String(Math.round(whole * 1e6)) };
}

function row(t: number, feesUsd: number | undefined, tvlUsd: number | undefined = 1000, over: Partial<NavHistoryRow> = {}): NavHistoryRow {
  return { t, ts: new Date(t).toISOString(), chainId: 4663, vaultKey: 'main', navUsd: 1, tvlUsd, feesUsd, ...over };
}

/** A row whose pending fee is `whole` USDG (feesUsd follows the leg). */
function feg(t: number, whole: number, tvlUsd = 1000, over: Partial<NavHistoryRow> = {}): NavHistoryRow {
  return row(t, whole, tvlUsd, { tokens: [leg(whole)], ...over });
}

/** Hourly snapshots for `days` days, fees accruing `perDay` USD/day at a flat TVL (no legs: the USD fallback). */
function hourly(days: number, perDay: number, tvl = 1000, over: Partial<NavHistoryRow> = {}): NavHistoryRow[] {
  return Array.from({ length: days * 24 + 1 }, (_, i) => row(T0 + i * HOUR, (perDay * i) / 24, tvl, over));
}

describe('feeApy', () => {
  it('picks the last row at or before lastTs − window as the boundary', () => {
    // Rows at day 0, 0.5, 1, 7.5 (last). Window 7d → cutoff 0.5d → boundary is the 0.5d row (fees 10),
    // not day 0 (fees 0) nor day 1 (fees 50). Inside: 0.5d, 1d, 7.5d → TVL mean (1000+2000+3000)/3.
    const rows = [row(T0, 0, 500), row(T0 + 0.5 * DAY, 10, 1000), row(T0 + DAY, 50, 2000), row(T0 + 7.5 * DAY, 80, 3000)];
    expect(feeApy(rows, 'main', 7)).toBeCloseTo(((70 * NET) / 2000) * (365 / 7), 12);
    // Any input order: sorted inside.
    expect(feeApy([...rows].reverse(), 'main', 7)).toBeCloseTo(((70 * NET) / 2000) * (365 / 7), 12);
  });

  it('a row exactly at the cutoff is the boundary (ts <= cutoff)', () => {
    const rows = [row(T0, 0), row(T0 + DAY, 7), row(T0 + 8 * DAY, 14)];
    expect(feeApy(rows, 'main', 7)).toBeCloseTo(((7 * NET) / 1000) * (365 / 7), 12);
  });

  it('a harvest inside the window does not erase the fees it swept out (the whole point)', () => {
    // The live bug: pending $0 → earn $5 → keeper harvests (pending back to $0.5) → earn $1.5 more.
    // "last − first" reads $0.5 − $0 = $0.5; the honest figure is claimed $4.5 + $1.5 accrual = $6.5,
    // which the upward-step integration reproduces: 5 + 1.5.
    const rows = [feg(T0, 0), feg(T0 + DAY, 5), feg(T0 + 2 * DAY, 0.5), feg(T0 + 7 * DAY, 2)];
    expect(grossFeesUsd(rows, 'main', 7)).toBeCloseTo(6.5, 9);
    expect(feeApy(rows, 'main', 7)).toBeCloseTo(((6.5 * NET) / 1000) * (365 / 7), 12);
  });

  it('a leg missing from the previous snapshot is skipped (unknown baseline)', () => {
    const other = { ...leg(3), address: '0x0bd7d308f8e1639fab988df18a8011f41eacad73' };
    const withOther = { tokens: [leg(1), other] };
    const rows = [feg(T0, 1), row(T0 + DAY, 4, 1000, withOther), row(T0 + 7 * DAY, 4, 1000, withOther)];
    // Only USDG 1 → 1 has a baseline; the WETH leg appears without one and contributes nothing.
    expect(grossFeesUsd(rows, 'main', 7)).toBeCloseTo(0, 9);
  });

  it('a vault younger than the window is annualised over all its history, from one day up', () => {
    // 6 days at $1/day on $1000 → 36.5% gross → 32.85% net, the same as the full week (the rate is flat).
    expect(feeApyPct(hourly(6, 1), 'main', 7)).toBe(32.85);
    expect(feeAprWindowDays(hourly(6, 1), 'main', 7)).toBe(6);
    // Exactly one day is enough — and so is the 24-row series the cron really produces, a few seconds
    // short of it (one missed row still leaves 23 hours; both show). 21 hours is not.
    expect(feeApyPct(hourly(1, 1), 'main', 7)).toBe(32.85);
    expect(feeAprWindowDays(hourly(1, 1), 'main', 7)).toBe(1);
    expect(feeApyPct(hourly(23 / 24, 1), 'main', 7)).toBe(32.85);
    expect(feeAprWindowDays(hourly(23 / 24, 1), 'main', 7)).toBeCloseTo(23 / 24, 12);
    expect(feeApy(hourly(21 / 24, 1), 'main', 7)).toBeUndefined();
    expect(feeAprWindowDays(hourly(21 / 24, 1), 'main', 7)).toBeUndefined();
    // Older than the window → the window, not the whole series.
    expect(feeAprWindowDays(hourly(30, 1), 'main', 7)).toBe(7);
    // Nothing at all, or a single row (zero span).
    expect(feeApy([], 'main', 7)).toBeUndefined();
    expect(feeApy([row(T0, 1)], 'main', 7)).toBeUndefined();
    expect(fmtFeeApr(undefined)).toBe('—');
  });

  it('the window line says what it really covers', () => {
    // The frontend's window is 24 hours, so a covered series reports that.
    expect(fmtFeeAprWindow(1)).toBe('24h average, annualised');
    expect(fmtFeeAprWindow(1, 1)).toBe('24h average, annualised');
    // A longer window, were one ever asked for, names itself — and a partial one its real span.
    expect(fmtFeeAprWindow(7, 7)).toBe('7-day average, annualised');
    expect(fmtFeeAprWindow(6.4, 7)).toBe('6-day average, annualised');
    expect(fmtFeeAprWindow(1.3, 7)).toBe('31h average, annualised');
    expect(fmtFeeAprWindow(0.9, 7)).toBe('22h average, annualised');
    expect(fmtFeeAprWindow(30, 30)).toBe('30-day average, annualised');
    expect(fmtFeeAprWindow(undefined)).toBeUndefined();
  });

  it('the frontend window is 24 hours: the newest day, annualised', () => {
    const three = hourly(3, 1);
    expect(FEE_APR_WINDOW_DAYS).toBe(1);
    expect(feeAprWindowDays(three, 'main', FEE_APR_WINDOW_DAYS)).toBe(1);
    // $1/day on $1000 → 36.5% gross → 32.85% net, whether it is measured over 1 day or 3.
    expect(feeApyPct(three, 'main', FEE_APR_WINDOW_DAYS)).toBe(32.85);
    // A day of rows shows even though the cron's jitter leaves it seconds short; 21 hours is not enough.
    expect(feeApyPct(hourly(23 / 24, 1), 'main', FEE_APR_WINDOW_DAYS)).toBe(32.85);
    expect(feeApy(hourly(21 / 24, 1), 'main', FEE_APR_WINDOW_DAYS)).toBeUndefined();
  });

  it('zero accrual → 0, rendered 0.00%', () => {
    const rows = hourly(8, 0);
    expect(feeApy(rows, 'main', 7)).toBe(0);
    expect(feeApyPct(rows, 'main', 7)).toBe(0);
    expect(fmtFeeApr(feeApyPct(rows, 'main', 7))).toBe('0.00%');
  });

  it('a negative step is never counted as a loss', () => {
    const rows = [row(T0, 5), row(T0 + 7 * DAY, 3)];
    expect(feeApy(rows, 'main', 7)).toBe(0);
  });

  it('two windows over a steady accrual agree; different rates differ', () => {
    // $1/day gross on $1000 TVL → 36.5% gross, 32.85% net, whatever the window.
    const steady = hourly(30, 1);
    expect(feeApyPct(steady, 'main', 7)).toBe(32.85);
    expect(feeApyPct(steady, 'main', 30)).toBe(32.85);
    // Fees only in the last 7 days ($2/day): the 7D window reads 65.7%, the 14D window half that.
    const late = Array.from({ length: 14 * 24 + 1 }, (_, i) => row(T0 + i * HOUR, i <= 7 * 24 ? 0 : (2 * (i - 7 * 24)) / 24));
    expect(feeApyPct(late, 'main', 7)).toBe(65.7);
    expect(feeApyPct(late, 'main', 14)).toBe(32.85);
    expect(fmtFeeApr(feeApyPct(late, 'main', 7))).toBe('65.70%');
  });

  it('rounds the percent to 2 decimals', () => {
    // Gross Δ 1 on $3000 over 7d → 1.7380952…% gross → 1.564…% net → 1.56.
    const rows = [row(T0, 0, 3000), row(T0 + 7 * DAY, 1, 3000)];
    expect(feeApyPct(rows, 'main', 7)).toBe(1.56);
  });

  it('uses the row\'s own performanceFeeBps when it carries one', () => {
    const rows = [row(T0, 0, 1000, { performanceFeeBps: 500 }), row(T0 + 7 * DAY, 10, 1000, { performanceFeeBps: 500 })];
    expect(feeApy(rows, 'main', 7)).toBeCloseTo(((10 * 0.95) / 1000) * (365 / 7), 12);
    expect(performanceFeeBpsOf(rows, 'main', 4663)).toBe(500);
    // No row carries one → the deployed default.
    expect(performanceFeeBpsOf(hourly(2, 1), 'main')).toBe(DEFAULT_PERFORMANCE_FEE_BPS);
    // The newest carrying row wins.
    const changing = [row(T0, 0, 1000, { performanceFeeBps: 2000 }), row(T0 + DAY, 1, 1000, { performanceFeeBps: 1000 })];
    expect(performanceFeeBpsOf(changing, 'main', 4663)).toBe(1000);
  });

  it('cuts per vault (and per chain when given); rows without fees or TVL are skipped', () => {
    const rows = [...hourly(8, 1), ...hourly(8, 5, 1000, { vaultKey: 'pons' }), ...hourly(8, 9, 1000, { vaultKey: 'pons', chainId: 46630 })];
    expect(feeApyPct(rows, 'main', 7)).toBe(32.85);
    expect(feeApyPct(rows, 'pons', 7, 4663)).toBe(164.25);
    expect(feeApyPct(rows, 'pons', 7, 46630)).toBe(295.65);
    expect(feeSeriesFor([row(T0, undefined), row(T0 + HOUR, 1, 1000, { tvlUsd: undefined }), row(T0 + 2 * HOUR, 2)], 'main')).toHaveLength(1);
  });

  it('feesEarnedUsd is the opening pending balance plus every accrual since', () => {
    const rows = [feg(T0, 0.25), feg(T0 + DAY, 5), feg(T0 + 2 * DAY, 0.5), feg(T0 + 7 * DAY, 2)];
    // Opening 0.25 + steps 4.75 (0.25→5) and 1.5 (0.5→2) = 6.5; the 5→0.5 harvest adds nothing.
    expect(feesEarnedUsd(rows, 'main', 4663)).toBeCloseTo(6.5, 9);
    expect(feesEarnedUsd([], 'main')).toBeUndefined();
  });
});
