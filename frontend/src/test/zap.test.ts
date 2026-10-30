import { describe, expect, it } from 'vitest';
import { BaseError, ContractFunctionRevertedError, encodeErrorResult, type Hex } from 'viem';
import { minSharesFromPreview } from '@/chain/deposit';
import {
  ZAP_DEFAULT_SLIPPAGE_BPS,
  ZAP_LEG_SLIPPAGE_BPS,
  ZAP_MAX_SLIPPAGE_BPS,
  describeZapError,
  isZapRouteSymbol,
  parseZapDepositAmount,
  parseZapRedeemShares,
  parseZapSlippage,
  zapInCallAbi,
  zapMinDeposit,
  zapMinimum,
  zapOutCallAbi,
  zapSizeWarning,
} from '@/chain/zap';

const USDG = 6;
const SHARES = 18;

describe('zap slippage — default 25 bps, clamped to the 50 bps route cap', () => {
  it('defaults', () => {
    expect(ZAP_DEFAULT_SLIPPAGE_BPS).toBe(25);
    expect(ZAP_MAX_SLIPPAGE_BPS).toBe(50);
    expect(parseZapSlippage(String(ZAP_DEFAULT_SLIPPAGE_BPS / 100))).toEqual({ ok: true, bps: 25, clamped: false });
  });

  it('accepts 0..0.50% as-is', () => {
    expect(parseZapSlippage('0')).toEqual({ ok: true, bps: 0, clamped: false });
    expect(parseZapSlippage('0.1')).toEqual({ ok: true, bps: 10, clamped: false });
    expect(parseZapSlippage(' 0.5 ')).toEqual({ ok: true, bps: 50, clamped: false });
    expect(parseZapSlippage('0.504')).toEqual({ ok: true, bps: 50, clamped: false }); // rounds to 50
  });

  it('clamps anything above the cap to 50 bps (flagged), never sends a reverting value', () => {
    expect(parseZapSlippage('0.51')).toEqual({ ok: true, bps: 50, clamped: true });
    expect(parseZapSlippage('3')).toEqual({ ok: true, bps: 50, clamped: true });
    expect(parseZapSlippage('100')).toEqual({ ok: true, bps: 50, clamped: true });
  });

  it('rejects blank, negative and non-numeric input', () => {
    expect(parseZapSlippage('')).toEqual({ ok: false, error: 'Enter a tolerance' });
    expect(parseZapSlippage('-0.1')).toEqual({ ok: false, error: 'Numbers only' });
    expect(parseZapSlippage('abc')).toEqual({ ok: false, error: 'Numbers only' });
    expect(parseZapSlippage('Infinity')).toEqual({ ok: false, error: 'Numbers only' });
  });
});

describe('ZAP_LEG_SLIPPAGE_BPS — the per-leg bound is always 0 (each route’s own cap; owner policy 2026-10-27)', () => {
  it('is 0: the contract reads 0 as "the route’s own maxSlippageBps"', () => {
    expect(ZAP_LEG_SLIPPAGE_BPS).toBe(0);
  });
  // Live RHC 4663 stock routes (fork fill matrix, contracts/test/fork/ZapStockFill.fork.t.sol): fee-500 / cap 100,
  // fee-3000 / cap 150, fee-10000 / cap 300 — and the tri vault's fee-10000 PONS next to a 50 bps WETH cap.
  // Whatever the fee tier, cap or tolerance, the leg bound sent is 0 (never `SlippageTooLoose`, never a bound
  // below a route's fee), while τ alone sets the minimum.
  it.each([
    ['fee-500', 5, 100],
    ['fee-3000', 30, 150],
    ['fee-10000', 100, 300],
    ['tri (fee-10000 PONS, 50 bps WETH cap)', 100, 50],
  ])('%s route (%i bps fee, cap %i): leg 0, τ only bounds the minimum', (_label, _feeBps, capBps) => {
    expect(ZAP_LEG_SLIPPAGE_BPS).toBeLessThanOrEqual(capBps);
    for (const tau of [0, ZAP_DEFAULT_SLIPPAGE_BPS, ZAP_MAX_SLIPPAGE_BPS]) {
      expect(zapMinimum(1_000_000n, tau)).toBe(minSharesFromPreview(1_000_000n, tau));
    }
  });
});

describe('zap deposit amount — USDG (6 dp), 1 USDG floor', () => {
  it('blank is "nothing entered", not an error', () => {
    expect(parseZapDepositAmount('', USDG)).toBeNull();
    expect(parseZapDepositAmount('   ', USDG)).toBeNull();
  });

  it('parses 6-decimal USDG', () => {
    expect(parseZapDepositAmount('1000', USDG)).toEqual({ ok: true, value: 1_000_000_000n });
    expect(parseZapDepositAmount('1,234.5', USDG)).toEqual({ ok: true, value: 1_234_500_000n });
  });

  it('the floor is exactly 1 USDG: 1 passes, 0.999999 is dust', () => {
    expect(zapMinDeposit(USDG)).toBe(1_000_000n);
    expect(parseZapDepositAmount('1', USDG)).toEqual({ ok: true, value: 1_000_000n });
    expect(parseZapDepositAmount('0.999999', USDG)).toEqual({ ok: false, error: 'Minimum 1 USDG — smaller zaps are dust' });
    expect(parseZapDepositAmount('0', USDG)).toEqual({ ok: false, error: 'Minimum 1 USDG — smaller zaps are dust' });
  });

  it('keeps parseAmount strictness (too many decimals, junk)', () => {
    expect(parseZapDepositAmount('1.0000001', USDG)).toEqual({ ok: false, error: 'Max 6 decimals' });
    expect(parseZapDepositAmount('1e6', USDG)).toEqual({ ok: false, error: 'Numbers only' });
  });

  it('names the route token it was given', () => {
    expect(parseZapDepositAmount('0.5', USDG, 'mUSDG')).toEqual({ ok: false, error: 'Minimum 1 mUSDG — smaller zaps are dust' });
  });
});

describe('zap deposit floor — ≈ $1 at the display price, whole tokens without one', () => {
  it('USDG at its $1 peg: still exactly 1 USDG', () => {
    expect(zapMinDeposit(USDG, 1)).toBe(1_000_000n);
    expect(parseZapDepositAmount('1', USDG, 'USDG', 1)).toEqual({ ok: true, value: 1_000_000n });
    expect(parseZapDepositAmount('0.999999', USDG, 'USDG', 1)).toEqual({ ok: false, error: 'Minimum 1 USDG — smaller zaps are dust' });
  });

  it('WETH at $2,500: $1 is 0.0004 WETH (not 1 WETH)', () => {
    expect(zapMinDeposit(18, 2_500)).toBe(4n * 10n ** 14n);
    expect(parseZapDepositAmount('0.0004', 18, 'WETH', 2_500)).toEqual({ ok: true, value: 4n * 10n ** 14n });
    expect(parseZapDepositAmount('0.00039', 18, 'WETH', 2_500)).toEqual({ ok: false, error: 'Minimum 0.0004 WETH — smaller zaps are dust' });
    expect(parseZapDepositAmount('0.5', 18, 'WETH', 2_500)?.ok).toBe(true);
  });

  it('rounds UP to two significant digits, so the minimum shown is itself accepted', () => {
    // $1 / $3,123.45 = 0.000320158… WETH → 0.00033
    expect(zapMinDeposit(18, 3_123.45)).toBe(33n * 10n ** 13n);
    const r = parseZapDepositAmount('0.0001', 18, 'WETH', 3_123.45);
    expect(r).toEqual({ ok: false, error: 'Minimum 0.00033 WETH — smaller zaps are dust' });
    expect(parseZapDepositAmount('0.00033', 18, 'WETH', 3_123.45)?.ok).toBe(true);
    // a cheap token: $1 at $0.003 = 333.33… → 340
    expect(zapMinDeposit(18, 0.003)).toBe(340n * 10n ** 18n);
    // finer than the token's decimals: at least one base unit
    expect(zapMinDeposit(0, 1e6)).toBe(1n);
  });

  it('no usable price → the whole-token floor (1 token)', () => {
    for (const p of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(zapMinDeposit(18, p)).toBe(10n ** 18n);
    expect(parseZapDepositAmount('0.5', 18, 'WETH')).toEqual({ ok: false, error: 'Minimum 1 WETH — smaller zaps are dust' });
  });
});

describe('zap redeem shares — receipt token (18 dp), bounded by the holding', () => {
  const held = 5n * 10n ** 18n;
  it('parses 18-decimal shares', () => {
    expect(parseZapRedeemShares('', SHARES, held)).toBeNull();
    expect(parseZapRedeemShares('0.000000000000000001', SHARES, held)).toEqual({ ok: true, value: 1n });
    expect(parseZapRedeemShares('5', SHARES, held)).toEqual({ ok: true, value: held });
  });
  it('rejects zero, more than held, and junk', () => {
    expect(parseZapRedeemShares('0', SHARES, held)).toEqual({ ok: false, error: 'Enter an amount' });
    expect(parseZapRedeemShares('5.000000000000000001', SHARES, held)).toEqual({ ok: false, error: 'More than you hold' });
    expect(parseZapRedeemShares('x', SHARES, held)).toEqual({ ok: false, error: 'Numbers only' });
  });
});

describe('zapSizeWarning — strictly above 50,000 USDG', () => {
  const k50 = 50_000n * 10n ** 6n;
  it('no warning at or below 50,000', () => {
    expect(zapSizeWarning(0n, USDG)).toBeNull();
    expect(zapSizeWarning(26_600n * 10n ** 6n, USDG)).toBeNull();
    expect(zapSizeWarning(k50, USDG)).toBeNull();
  });
  it('warns one base unit above, citing the sandwich break-even', () => {
    const w = zapSizeWarning(k50 + 1n, USDG);
    expect(w).toContain('50,000 USDG');
    expect(w).toContain('26.6k');
    expect(zapSizeWarning(1_000_000n * 10n ** 6n, USDG)).not.toBeNull();
  });
});

describe('zapSizeWarning — priced: strictly above ≈ $50,000', () => {
  it('USDG at $1: the same threshold, worded in dollars', () => {
    const k50 = 50_000n * 10n ** 6n;
    expect(zapSizeWarning(k50, USDG, 'USDG', 1)).toBeNull();
    const w = zapSizeWarning(k50 + 1n, USDG, 'USDG', 1);
    expect(w).toContain('$50,000');
    expect(w).toContain('$26.6k');
  });
  it('WETH at $2,500: 20 WETH is the line, not 50,000 WETH', () => {
    expect(zapSizeWarning(20n * 10n ** 18n, 18, 'WETH', 2_500)).toBeNull();
    expect(zapSizeWarning(20n * 10n ** 18n + 1n, 18, 'WETH', 2_500)).toContain('$50,000');
  });
  it('no price → whole tokens, as before', () => {
    expect(zapSizeWarning(20n * 10n ** 18n + 1n, 18, 'WETH')).toBeNull();
    expect(zapSizeWarning(50_000n * 10n ** 18n + 1n, 18, 'WETH')).toContain('50,000 WETH');
  });
});

describe('isZapRouteSymbol — USDG, or the all-mock stack\'s mUSDG', () => {
  it('matches the anchor under both names, nothing else', () => {
    expect(isZapRouteSymbol('USDG')).toBe(true);
    expect(isZapRouteSymbol('mUSDG')).toBe(true);
    for (const s of ['WETH', 'mWETH', 'USDGX', 'usdg', '0xabcd…1234']) expect(isZapRouteSymbol(s)).toBe(false);
  });
});

describe('zapMinimum — the in-kind minShares math, one implementation', () => {
  it('equals minSharesFromPreview for shares and USDG amounts alike', () => {
    for (const [expected, bps] of [
      [934_231_020_321_226_338_708n, 25],
      [1_049_367_634n, 25],
      [10_000n, 50],
      [1n, 25],
      [0n, 25],
    ] as const) {
      expect(zapMinimum(expected, bps)).toBe(minSharesFromPreview(expected, bps));
    }
  });
  it('floor(expected × (1 − τ)), never 0 while expected > 0, 0 for 0', () => {
    expect(zapMinimum(10_000n, 25)).toBe(9_975n);
    expect(zapMinimum(1_049_367_634n, 25)).toBe(1_046_744_214n); // 1049.367634 USDG × 0.9975, floored
    expect(zapMinimum(10_000n, 0)).toBe(10_000n);
    expect(zapMinimum(1n, 50)).toBe(1n);
    expect(zapMinimum(0n, 25)).toBe(0n);
  });
});

describe('zap error mapping — typed guard reverts become one sentence', () => {
  const revert = (abi: typeof zapInCallAbi | typeof zapOutCallAbi, errorName: string, args: readonly unknown[]) => {
    const data = encodeErrorResult({ abi, errorName, args } as never) as Hex;
    return new BaseError('reverted', { cause: new ContractFunctionRevertedError({ abi, data, functionName: 'zapDeposit' } as never) });
  };

  it('zap-in guard errors', () => {
    expect(describeZapError(revert(zapInCallAbi, 'ZapIn__SlippageTooLoose', [100, 50]))).toBe('Slippage 1% is looser than the route’s cap of 0.5%.');
    expect(describeZapError(revert(zapInCallAbi, 'ZapIn__AmountTooSmall', ['0x0000000000000000000000000000000000000001']))).toContain('Zap a larger amount of USDG');
    expect(describeZapError(revert(zapInCallAbi, 'ZapIn__AmountTooSmall', ['0x0000000000000000000000000000000000000001']), { routeSymbol: 'WETH' })).toContain('Zap a larger amount of WETH');
    expect(describeZapError(revert(zapInCallAbi, 'ZapIn__SpotDeviatesFromTwap', ['0x0000000000000000000000000000000000000001', 10, 0, 50]))).toContain('off its TWAP');
  });

  it('zap-out minimum breach names both amounts in the route token', () => {
    const msg = describeZapError(revert(zapOutCallAbi, 'ZapOut__MinAmountOut', [1_000_000_000n, 990_000_000n]), { routeSymbol: 'USDG', routeDecimals: 6 });
    expect(msg).toContain('990 USDG');
    expect(msg).toContain('1,000 USDG');
  });

  it('a vault error bubbled through the zap decodes via the appended vault errors', () => {
    const msg = describeZapError(revert(zapInCallAbi, 'PoolmigoVault__InsufficientSharesOut', [2n * 10n ** 18n, 10n ** 18n]), { shareSymbol: 'sunEthLP' });
    expect(msg).toContain('below your minimum of 2 sunEthLP');
  });
});
