import { describe, expect, it } from 'vitest';
import { BaseError, ContractFunctionRevertedError, encodeErrorResult, type Hex } from 'viem';
import { minSharesFromPreview } from '@/chain/deposit';
import {
  ZAP_DEFAULT_SLIPPAGE_BPS,
  ZAP_MAX_SLIPPAGE_BPS,
  describeZapError,
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
    expect(describeZapError(revert(zapInCallAbi, 'ZapIn__AmountTooSmall', ['0x0000000000000000000000000000000000000001']))).toContain('Zap at least 1 USDG');
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
