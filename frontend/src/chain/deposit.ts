/**
 * Pure deposit/redeem math for the in-kind basket vault. No React, no viem calls — the rules that
 * must hold before a transaction is ever built:
 *
 *  - `deposit` takes MAX offers; the vault pulls only `ceil(shares * T_i / S)` per token.
 *  - `minShares` is MANDATORY and non-zero (the contract reverts `PoolmigoVault__ZeroMinShares`),
 *    and it is the ONLY protection a depositor has, because the deposit-pricing read can over-price.
 *  - Every basket token the vault holds must be offered with a non-zero amount, or the computable
 *    share count is 0 and the deposit reverts.
 */
import type { Address } from 'viem';
import { parseAmount, toExactString } from './amounts';

export const DEFAULT_SLIPPAGE_BPS = 50; // 0.50%
export const MAX_SLIPPAGE_BPS = 5_000; // 50% — anything beyond is a typo, not a preference

/**
 * minShares = floor(previewShares × (1 − tolerance)), never 0 while shares > 0.
 * Callers must not send 0: `deposit` reverts on it by design.
 */
export function minSharesFromPreview(shares: bigint, toleranceBps: number): bigint {
  if (shares <= 0n) return 0n;
  const bps = Math.min(Math.max(Math.round(toleranceBps), 0), 10_000);
  const min = (shares * BigInt(10_000 - bps)) / 10_000n;
  return min > 0n ? min : 1n;
}

/** Slippage input → bps. Rejects anything that is not a sane percentage. */
export function parseSlippageBps(input: string): { ok: true; bps: number } | { ok: false; error: string } {
  const s = input.trim();
  if (s === '') return { ok: false, error: 'Enter a tolerance' };
  const pct = Number(s);
  if (!Number.isFinite(pct) || pct < 0) return { ok: false, error: 'Numbers only' };
  const bps = Math.round(pct * 100);
  if (bps > MAX_SLIPPAGE_BPS) return { ok: false, error: `Max ${MAX_SLIPPAGE_BPS / 100}%` };
  return { ok: true, bps };
}

export interface BasketInput {
  token: Address;
  decimals: number;
  /** Raw text from the amount field. */
  input: string;
  /** Total the vault currently holds for this token (idle + positions). */
  total?: bigint;
}

export interface BasketOffer {
  /** Registry order, exactly as `tokens()` returned it. */
  tokens: Address[];
  /** Max offered per token, aligned to `tokens`. */
  amounts: bigint[];
  /** Per-token parse errors, keyed by token address. */
  errors: Record<string, string>;
  /** True when a token the vault holds was left empty/zero — `previewDeposit` would revert. */
  hasMissingAmount: boolean;
  /** True when every token parsed and none is missing: safe to call `previewDeposit`. */
  ready: boolean;
}

/**
 * Dispatch the per-token amount fields into the aligned `(tokens[], amounts[])` pair the vault
 * expects. Always offers the FULL registry in registry order — the contract requires every token
 * the vault holds to be offered, and offering a token the vault has zero of costs nothing.
 */
export function dispatchBasket(inputs: readonly BasketInput[]): BasketOffer {
  const tokens: Address[] = [];
  const amounts: bigint[] = [];
  const errors: Record<string, string> = {};
  let hasMissingAmount = false;

  for (const entry of inputs) {
    tokens.push(entry.token);
    const blank = entry.input.trim() === '';
    const parsed = blank ? null : parseAmount(entry.input, entry.decimals);
    if (parsed && !parsed.ok) {
      errors[entry.token] = parsed.error;
      amounts.push(0n);
    } else {
      amounts.push(parsed ? parsed.value : 0n);
    }
    const amount = amounts[amounts.length - 1];
    // A token the vault holds must be offered with a non-zero amount or shares would be 0.
    const held = entry.total === undefined || entry.total > 0n;
    if (held && amount === 0n) hasMissingAmount = true;
  }

  return {
    tokens,
    amounts,
    errors,
    hasMissingAmount,
    ready: Object.keys(errors).length === 0 && !hasMissingAmount,
  };
}

/** Which tokens still need an `approve` before `deposit` can pull `required[i]`. */
export function tokensNeedingApproval(
  tokens: readonly Address[],
  required: readonly bigint[],
  allowances: readonly bigint[],
): Address[] {
  const out: Address[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const need = required[i] ?? 0n;
    if (need > 0n && (allowances[i] ?? 0n) < need) out.push(tokens[i]);
  }
  return out;
}

/** Wallet balance short of what the vault would pull. */
export function insufficientBalance(
  tokens: readonly Address[],
  required: readonly bigint[],
  balances: readonly bigint[],
): Address | null {
  for (let i = 0; i < tokens.length; i++) {
    if ((required[i] ?? 0n) > (balances[i] ?? 0n)) return tokens[i];
  }
  return null;
}

/** Decimals an auto-filled basket amount keeps (fewer when the token has fewer). */
export const FILL_DECIMALS = 6;

/** The contract's per-token virtual asset (`VIRTUAL_ASSETS`, 1 raw unit): deposit pricing divides by T_i + 1. */
const VIRTUAL_ASSET = 1n;

/**
 * The basket fields after the user types `input` into field `from`: the others follow at the vault's
 * current mix, rounded UP to FILL_DECIMALS so the typed token stays the one that sets the deposit.
 * Clearing a field clears them all. A field the mix cannot size (totals not read yet, a token the vault
 * does not hold, a typo) keeps what was there.
 *
 * The mix is the contract's own: `_bindingShares` takes min_i floor(amount_i × (S + 1) / (T_i + 1)), so a
 * filled leg is never binding iff amount_i ≥ typed × (T_i + 1) / (T_from + 1). The plain ratio
 * typed × T_i / T_from falls short of that whenever T_i < T_from (raw units) and it lands on a whole step —
 * then the filled leg bound and less of the typed token was pulled than typed.
 *
 * With the wallet's `balances`, rounding never pushes a field past what the wallet holds: when that
 * mix fits the balance but the rounded figure does not, the field takes the balance (still ≥ the mix,
 * so the typed token still sets the deposit) — Max on the token held least never turns another red.
 */
export function fillAtMix(
  tokens: readonly { address: Address; decimals: number }[],
  totals: readonly bigint[],
  current: Record<string, string>,
  from: number,
  input: string,
  balances?: readonly bigint[],
): Record<string, string> {
  if (input.trim() === '') return {};
  const next = { ...current, [tokens[from].address]: input };
  const parsed = parseAmount(input, tokens[from].decimals);
  const total = totals[from] ?? 0n;
  if (!parsed.ok || total === 0n) return next;
  const base = total + VIRTUAL_ASSET;
  tokens.forEach((t, i) => {
    const held = totals[i] ?? 0n;
    if (i === from || held === 0n) return;
    const mix = parsed.value * (held + VIRTUAL_ASSET);
    const step = 10n ** BigInt(Math.max(t.decimals - FILL_DECIMALS, 0));
    const den = base * step;
    let amount = ((mix + den - 1n) / den) * step;
    const balance = balances?.[i];
    // mix ≤ balance < rounded: the rounding alone overshoots
    if (balance !== undefined && amount > balance && mix <= balance * base) amount = balance;
    next[t.address] = toExactString(amount, t.decimals);
  });
  return next;
}
