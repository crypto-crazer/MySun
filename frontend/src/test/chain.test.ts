import { describe, expect, it } from 'vitest';
import { keccak256, stringToHex, type Address } from 'viem';
import {
  KNOWN_DEX_IDS,
  bytes32Label,
  dexLabel,
  formatAmount,
  formatAmountSignificant,
  parseAmount,
  poolIdLabel,
  shortHex,
  toExactString,
} from '@/chain/amounts';
import {
  DEFAULT_SLIPPAGE_BPS,
  dispatchBasket,
  fillAtMix,
  insufficientBalance,
  minSharesFromPreview,
  parseSlippageBps,
  tokensNeedingApproval,
} from '@/chain/deposit';

const USDG = '0x5FbDB2315678afecb367f032d93F642f64180aa3' as Address; // 6 decimals
const WETH = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512' as Address; // 18 decimals

describe('parseAmount — mixed decimals', () => {
  it('parses 6-decimal input', () => {
    expect(parseAmount('1000', 6)).toEqual({ ok: true, value: 1_000_000_000n });
    expect(parseAmount('0.5', 6)).toEqual({ ok: true, value: 500_000n });
    expect(parseAmount('0.000001', 6)).toEqual({ ok: true, value: 1n });
    expect(parseAmount('.5', 6)).toEqual({ ok: true, value: 500_000n });
    expect(parseAmount('1,000.25', 6)).toEqual({ ok: true, value: 1_000_250_000n });
  });

  it('parses 18-decimal input without float error', () => {
    expect(parseAmount('1', 18)).toEqual({ ok: true, value: 10n ** 18n });
    expect(parseAmount('0.1', 18)).toEqual({ ok: true, value: 100_000_000_000_000_000n });
    // 0.1 + 0.2 in floats is 0.30000000000000004; as base units it is exact.
    expect(parseAmount('0.3', 18).ok && parseAmount('0.3', 18)).toEqual({ ok: true, value: 300_000_000_000_000_000n });
    expect(parseAmount('123456789.123456789123456789', 18)).toEqual({
      ok: true,
      value: 123_456_789_123_456_789_123_456_789n,
    });
  });

  it('rejects more precision than the token has', () => {
    expect(parseAmount('0.1234567', 6)).toEqual({ ok: false, error: 'Max 6 decimals' });
    expect(parseAmount('0.1234567', 18).ok).toBe(true);
  });

  it('rejects junk and blanks', () => {
    expect(parseAmount('', 6).ok).toBe(false);
    expect(parseAmount('   ', 6).ok).toBe(false);
    expect(parseAmount('.', 6).ok).toBe(false);
    expect(parseAmount('abc', 6)).toEqual({ ok: false, error: 'Numbers only' });
    expect(parseAmount('-1', 6)).toEqual({ ok: false, error: 'Numbers only' });
    expect(parseAmount('1e6', 6)).toEqual({ ok: false, error: 'Numbers only' });
  });

  it('accepts a literal zero', () => {
    expect(parseAmount('0', 18)).toEqual({ ok: true, value: 0n });
  });
});

describe('formatAmount — display', () => {
  it('groups and truncates rather than rounding up', () => {
    expect(formatAmount(1_234_567_891n, 6, 4)).toBe('1,234.5678'); // 1234.567891 → 1234.5678
    expect(formatAmount(999_999n, 6, 2)).toBe('0.99');
    expect(formatAmount(10n ** 18n, 18, 4)).toBe('1');
    expect(formatAmount(1_500_000_000_000_000_000n, 18, 4)).toBe('1.5');
  });

  it('never prints a non-zero amount as 0', () => {
    expect(formatAmount(1n, 18, 4)).toBe('<0.0001');
    expect(formatAmount(1n, 6, 2)).toBe('<0.01');
    expect(formatAmount(0n, 6, 4)).toBe('0');
  });

  it('handles negatives and zero-decimal tokens', () => {
    expect(formatAmount(-1_500_000n, 6, 4)).toBe('-1.5');
    expect(formatAmount(42n, 0, 4)).toBe('42');
  });

  it('round-trips through toExactString', () => {
    for (const [value, decimals] of [
      [1_234_567_891n, 6],
      [10n ** 18n, 18],
      [1n, 18],
      [0n, 6],
    ] as const) {
      const parsed = parseAmount(toExactString(value, decimals), decimals);
      expect(parsed.ok && parsed.value).toBe(value);
    }
  });
});

describe('formatAmountSignificant — receipt-token supply lives at 1e-7', () => {
  it('keeps 6 significant digits however small the amount is', () => {
    // Bootstrap set shares = amounts_[0] of a 6-decimal token, so supply ≈ 1e11 wei of an 18dp token.
    expect(formatAmountSignificant(100_000_000_000n, 18)).toBe('0.0000001');
    expect(formatAmountSignificant(123_456_789_012n, 18)).toBe('0.000000123456');
    expect(formatAmount(100_000_000_000n, 18, 4)).toBe('<0.0001'); // what the fixed format would show
  });

  it('falls back to 4 decimals once the amount is ≥ 1', () => {
    expect(formatAmountSignificant(1_500_000_000_000_000_000n, 18)).toBe('1.5');
    expect(formatAmountSignificant(0n, 18)).toBe('0');
  });
});

describe('bytes32 + hex labels', () => {
  it('decodes packed ascii adapter labels', () => {
    // bytes32("uniswap-v3")
    const dex = '0x756e69737761702d763300000000000000000000000000000000000000000000';
    expect(bytes32Label(dex)).toBe('uniswap-v3');
  });
  it('falls back to short hex for non-ascii or malformed input', () => {
    expect(bytes32Label('0xff'.padEnd(66, '0'))).toMatch(/^0xff/);
    expect(bytes32Label(undefined)).toBe('—');
  });
  it('shortens addresses', () => {
    expect(shortHex(USDG)).toBe('0x5FbD…0aa3');
  });
  it('names the real Uniswap adapters by their DEX_ID hash; mock labels still decode', () => {
    expect(KNOWN_DEX_IDS).toEqual({
      [keccak256(stringToHex('UNISWAP_V3'))]: 'uniswap-v3',
      [keccak256(stringToHex('UNISWAP_V4'))]: 'uniswap-v4',
    });
    expect(dexLabel(keccak256(stringToHex('UNISWAP_V3')))).toBe('uniswap-v3');
    expect(dexLabel(keccak256(stringToHex('UNISWAP_V4')).toUpperCase().replace('0X', '0x'))).toBe('uniswap-v4');
    expect(dexLabel('0x756e69737761702d763300000000000000000000000000000000000000000000')).toBe('uniswap-v3');
    expect(dexLabel(keccak256(stringToHex('CURVE')))).toMatch(/^0x[0-9a-f]{4}…/);
  });
  it('shows a v3 poolId (the pool address, left-padded) as a short address', () => {
    const pool = '0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca';
    expect(poolIdLabel(`0x${pool.slice(2).padStart(64, '0')}`)).toBe('0x52e6…71Ca');
    expect(poolIdLabel('0x6d555344472f6d5745544820302e303525000000000000000000000000000000')).toBe('mUSDG/mWETH 0.05%');
    expect(poolIdLabel('0x'.padEnd(66, '0'))).toBe('0x0000…0000');
  });
});

describe('minShares — the depositor’s only protection', () => {
  it('applies the tolerance as a floor', () => {
    expect(minSharesFromPreview(1_000_000n, DEFAULT_SLIPPAGE_BPS)).toBe(995_000n); // 0.50%
    expect(minSharesFromPreview(1_000_000n, 0)).toBe(1_000_000n);
    expect(minSharesFromPreview(1_000_000n, 100)).toBe(990_000n);
    expect(minSharesFromPreview(3n, 5_000)).toBe(1n); // floor(1.5)
  });

  it('is never zero while shares are positive — the contract reverts on minShares == 0', () => {
    expect(minSharesFromPreview(1n, DEFAULT_SLIPPAGE_BPS)).toBe(1n);
    expect(minSharesFromPreview(1n, 10_000)).toBe(1n);
  });

  it('is zero only when there is nothing to mint', () => {
    expect(minSharesFromPreview(0n, DEFAULT_SLIPPAGE_BPS)).toBe(0n);
  });

  it('clamps a nonsense tolerance instead of inverting the maths', () => {
    expect(minSharesFromPreview(1_000_000n, -50)).toBe(1_000_000n);
    expect(minSharesFromPreview(1_000_000n, 99_999)).toBe(1n);
  });
});

describe('parseSlippageBps', () => {
  it('converts percent to bps', () => {
    expect(parseSlippageBps('0.5')).toEqual({ ok: true, bps: 50 });
    expect(parseSlippageBps('1')).toEqual({ ok: true, bps: 100 });
    expect(parseSlippageBps('0')).toEqual({ ok: true, bps: 0 });
  });
  it('rejects junk and absurd values', () => {
    expect(parseSlippageBps('').ok).toBe(false);
    expect(parseSlippageBps('abc').ok).toBe(false);
    expect(parseSlippageBps('-1').ok).toBe(false);
    expect(parseSlippageBps('80')).toEqual({ ok: false, error: 'Max 50%' });
  });
});

describe('dispatchBasket — per-token fields → aligned (tokens[], amounts[])', () => {
  const base = [
    { token: USDG, decimals: 6, total: 100_000_000_000n },
    { token: WETH, decimals: 18, total: 10n * 10n ** 18n },
  ];

  it('keeps registry order and offers the whole basket', () => {
    const offer = dispatchBasket([
      { ...base[0], input: '1000' },
      { ...base[1], input: '0.1' },
    ]);
    expect(offer.tokens).toEqual([USDG, WETH]);
    expect(offer.amounts).toEqual([1_000_000_000n, 100_000_000_000_000_000n]);
    expect(offer.ready).toBe(true);
    expect(offer.hasMissingAmount).toBe(false);
  });

  it('flags a held token left empty — previewDeposit would revert with ZeroShares', () => {
    const offer = dispatchBasket([
      { ...base[0], input: '1000' },
      { ...base[1], input: '' },
    ]);
    expect(offer.hasMissingAmount).toBe(true);
    expect(offer.ready).toBe(false);
    expect(offer.amounts[1]).toBe(0n);
  });

  it('treats an explicit zero the same as an empty field', () => {
    const offer = dispatchBasket([
      { ...base[0], input: '1000' },
      { ...base[1], input: '0' },
    ]);
    expect(offer.hasMissingAmount).toBe(true);
  });

  it('does not demand an amount for a token the vault does not hold', () => {
    const offer = dispatchBasket([
      { ...base[0], input: '1000' },
      { token: WETH, decimals: 18, total: 0n, input: '' },
    ]);
    expect(offer.hasMissingAmount).toBe(false);
    expect(offer.ready).toBe(true);
  });

  it('surfaces per-token parse errors without dropping the token', () => {
    const offer = dispatchBasket([
      { ...base[0], input: '0.1234567' },
      { ...base[1], input: '1' },
    ]);
    expect(offer.errors[USDG]).toBe('Max 6 decimals');
    expect(offer.tokens).toHaveLength(2);
    expect(offer.ready).toBe(false);
  });
});

describe('approval + balance checks', () => {
  const tokens = [USDG, WETH];
  const required = [1_000_000_000n, 100_000_000_000_000_000n];

  it('asks for approval only where the allowance is short', () => {
    expect(tokensNeedingApproval(tokens, required, [0n, required[1]])).toEqual([USDG]);
    expect(tokensNeedingApproval(tokens, required, required)).toEqual([]);
    expect(tokensNeedingApproval(tokens, required, [required[0] - 1n, 0n])).toEqual([USDG, WETH]);
  });

  it('ignores tokens the vault will not pull', () => {
    expect(tokensNeedingApproval(tokens, [0n, required[1]], [0n, required[1]])).toEqual([]);
  });

  it('reports the first token the wallet cannot cover', () => {
    expect(insufficientBalance(tokens, required, [required[0], required[1]])).toBeNull();
    expect(insufficientBalance(tokens, required, [required[0] - 1n, required[1]])).toBe(USDG);
    expect(insufficientBalance(tokens, required, [required[0], 0n])).toBe(WETH);
  });
});

describe('fillAtMix — the other fields follow the mix, and the typed token stays the binding one', () => {
  const tokens = [{ address: USDG, decimals: 6 }, { address: WETH, decimals: 18 }];
  const totals = [1_000_000_000n, 4n * 10n ** 17n]; // 1,000 USDG : 0.4 WETH
  const S = 1_000n * 10n ** 18n;
  /** The vault's `_bindingShares` candidate for one leg: floor(amount × (S + 1) / (T + 1)). */
  const candidate = (amount: bigint, total: bigint, supply = S) => (amount * (supply + 1n)) / (total + 1n);

  it('rounds up to 6 dp, never past a balance the mix fits; clearing clears every field', () => {
    // 1.000001 USDG → 0.0004000003999996… WETH, rounded up to 6 dp: 0.000401
    expect(fillAtMix(tokens, totals, {}, 0, '1.000001')[WETH]).toBe('0.000401');
    // the wallet holds exactly the mix: the fill takes the balance, not 1 unit over it
    expect(fillAtMix(tokens, totals, {}, 0, '1.000001', [1_000_001n, 400_000_400_000_000n])[WETH]).toBe('0.0004000004');
    // more than the mix but less than the rounded figure: still the balance (≥ the mix, so USDG still sets the deposit)
    expect(fillAtMix(tokens, totals, {}, 0, '1.000001', [1_000_001n, 400_000_900_000_000n])[WETH]).toBe('0.0004000009');
    // genuinely short of the mix: the rounded figure stays, and the field is rightly over
    expect(fillAtMix(tokens, totals, {}, 0, '1.000001', [1_000_001n, 400_000_000_000_000n])[WETH]).toBe('0.000401');
    expect(fillAtMix(tokens, totals, { [USDG]: '5' }, 1, '')).toEqual({});
  });

  it('keeps what it cannot size: totals not read, a token the vault does not hold, a typo', () => {
    expect(fillAtMix(tokens, [0n, 0n], { [WETH]: '1' }, 0, '10')).toEqual({ [USDG]: '10', [WETH]: '1' });
    expect(fillAtMix(tokens, [totals[0], 0n], { [WETH]: '1' }, 0, '10')).toEqual({ [USDG]: '10', [WETH]: '1' });
    expect(fillAtMix(tokens, totals, { [WETH]: '1' }, 0, '1.2.3')).toEqual({ [USDG]: '1.2.3', [WETH]: '1' });
  });

  it('the plain ratio let the filled leg bind (T_i < T_from); the contract ratio (T + 1) never does', () => {
    // 0.2 WETH: the plain ratio is exactly 500 USDG, whose candidate is below WETH's — USDG would set the deposit
    // and the vault would pull 0.1999999998 WETH of the 0.2 typed.
    const typed = 2n * 10n ** 17n;
    const plain = 500_000_000n;
    expect(candidate(plain, totals[0])).toBeLessThan(candidate(typed, totals[1]));
    const filled = fillAtMix(tokens, totals, {}, 1, '0.2')[USDG];
    expect(filled).toBe('500.000001');
    expect(candidate(500_000_001n, totals[0])).toBeGreaterThanOrEqual(candidate(typed, totals[1]));
  });

  it('across mixes, sizes and both directions the typed leg is binding (ties allowed)', () => {
    const grid = [1n, 7n, 999n, 10n ** 6n, 10n ** 9n + 7n, 4n * 10n ** 17n, 3n * 10n ** 21n];
    const inputs = ['1', '0.2', '0.000001', '123.456789', '1000000'];
    for (const tu of grid) for (const tw of grid) for (const supply of [1n, 10n ** 18n, S]) {
      for (const [from, to] of [[0, 1], [1, 0]] as const) {
        for (const input of inputs) {
          const typed = parseAmount(input, tokens[from].decimals);
          if (!typed.ok || typed.value === 0n) continue;
          const t = [tu, tw];
          const raw = fillAtMix(tokens, t, {}, from, input)[tokens[to].address];
          const amount = parseAmount(raw, tokens[to].decimals);
          expect(amount.ok).toBe(true);
          if (!amount.ok) continue;
          expect(candidate(amount.value, t[to], supply)).toBeGreaterThanOrEqual(candidate(typed.value, t[from], supply));
        }
      }
    }
  });
});
