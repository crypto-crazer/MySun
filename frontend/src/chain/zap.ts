/**
 * Single-asset zap rules (periphery `MySunZapIn` / `MySunZapOut`). No React, no network — the
 * checks that must hold before a zap transaction is built:
 *
 *  - `zapDeposit` takes ONE basket token (the route token, USDG) and swaps the shortfall into the
 *    other basket tokens through the UniversalRouter, bounded per route by its own TWAP guard at
 *    `slippageBps`; the vault deposit behind it is the normal in-kind one. `zapRedeem` redeems in kind
 *    and sells every other basket token into the route token.
 *  - `slippageBps` can only TIGHTEN a route: the contract rejects anything above the route's
 *    `maxSlippageBps` (50 bps on the demo routes), and reads `0` as "the route's own cap".
 *  - `minShares` / `minAmountOut` are the user's bound and are set here, off-chain, from the zap's own
 *    preview — with the SAME math as the in-kind deposit (`minSharesFromPreview`, one implementation).
 *
 * Imports are relative (not `@/`) on purpose: `scripts/e2e-local.ts` runs this module under tsx.
 */
import { BaseError, ContractFunctionRevertedError } from 'viem';
import { vaultAbi, zapInAbi, zapOutAbi } from '../config/generated';
import { formatAmount, parseAmount } from './amounts';
import { minSharesFromPreview } from './deposit';
import { describeChainError, type ErrorContext } from './errors';

/** The token a zap facet takes in / pays out (matched on the vault's basket by symbol). */
export const ZAP_ROUTE_SYMBOL = 'USDG';
/** Default tolerance — the contract's own recommendation for `minShares` / `minAmountOut` (τ = 25 bps). */
export const ZAP_DEFAULT_SLIPPAGE_BPS = 25;
/** The demo routes' `maxSlippageBps`: a looser value would revert `…__SlippageTooLoose`. */
export const ZAP_MAX_SLIPPAGE_BPS = 50;
/** Below one whole route token a zap is dust (a swap leg floors to zero). */
export const ZAP_MIN_DEPOSIT_UNITS = 1n;
/** Above this size, warn: the published sandwich break-even is ~26.6k USDG (research/zap-sandwich). */
export const ZAP_SIZE_WARNING_UNITS = 50_000n;

/**
 * The zap ABIs with the vault's custom errors appended: the zap calls `vault.deposit` / `vault.redeem`
 * and bubbles their reverts, so a `PoolmigoVault__InsufficientSharesOut` behind a zap decodes by name.
 */
const vaultErrors = vaultAbi.filter((x): x is Extract<(typeof vaultAbi)[number], { type: 'error' }> => x.type === 'error');
export const zapInCallAbi = [...zapInAbi, ...vaultErrors] as const;
export const zapOutCallAbi = [...zapOutAbi, ...vaultErrors] as const;

export type ZapAmount = { ok: true; value: bigint } | { ok: false; error: string };

/**
 * Zap-deposit amount field → base units of the route token (USDG: 6 decimals). `null` while blank.
 * Rejects what `parseAmount` rejects, zero, and anything under 1 whole token (dust).
 */
export function parseZapDepositAmount(input: string, decimals: number, symbol = ZAP_ROUTE_SYMBOL): ZapAmount | null {
  if (input.trim() === '') return null;
  const parsed = parseAmount(input, decimals);
  if (!parsed.ok) return parsed;
  if (parsed.value < zapMinDeposit(decimals)) {
    return { ok: false, error: `Minimum ${ZAP_MIN_DEPOSIT_UNITS} ${symbol} — smaller zaps are dust` };
  }
  return parsed;
}

/** Zap-redeem shares field → base units of the receipt token (18 decimals). `null` while blank. */
export function parseZapRedeemShares(input: string, decimals: number, held: bigint): ZapAmount | null {
  if (input.trim() === '') return null;
  const parsed = parseAmount(input, decimals);
  if (!parsed.ok) return parsed;
  if (parsed.value === 0n) return { ok: false, error: 'Enter an amount' };
  if (parsed.value > held) return { ok: false, error: 'More than you hold' };
  return parsed;
}

/** The dust floor in base units: 1 whole route token. */
export function zapMinDeposit(decimals: number): bigint {
  return ZAP_MIN_DEPOSIT_UNITS * 10n ** BigInt(decimals);
}

export type ZapSlippage = { ok: true; bps: number; clamped: boolean } | { ok: false; error: string };

/**
 * Slippage field (percent, like the in-kind form) → bps, clamped to [0, ZAP_MAX_SLIPPAGE_BPS]: a
 * value above the route cap is lowered to it (flagged `clamped`) rather than sent to revert.
 */
export function parseZapSlippage(input: string): ZapSlippage {
  const s = input.trim();
  if (s === '') return { ok: false, error: 'Enter a tolerance' };
  const pct = Number(s);
  if (!Number.isFinite(pct) || pct < 0) return { ok: false, error: 'Numbers only' };
  const bps = Math.round(pct * 100);
  if (bps > ZAP_MAX_SLIPPAGE_BPS) return { ok: true, bps: ZAP_MAX_SLIPPAGE_BPS, clamped: true };
  return { ok: true, bps, clamped: false };
}

/** `minShares` (zap in) / `minAmountOut` (zap out) from the zap's preview — the in-kind rule, reused. */
export function zapMinimum(expected: bigint, toleranceBps: number): bigint {
  return minSharesFromPreview(expected, toleranceBps);
}

/** A warning above 50,000 whole route tokens (strictly above), else null. */
export function zapSizeWarning(amount: bigint, decimals: number, symbol = ZAP_ROUTE_SYMBOL): string | null {
  if (amount <= ZAP_SIZE_WARNING_UNITS * 10n ** BigInt(decimals)) return null;
  return `Large zap: above ${formatAmount(ZAP_SIZE_WARNING_UNITS * 10n ** BigInt(decimals), decimals, 0)} ${symbol} the swap leg is worth sandwiching (published break-even ≈ 26.6k ${symbol}). Split it, or deposit in kind.`;
}

/** Context for zap errors: the in-kind one plus the route token, for `…__MinAmountOut` amounts. */
export interface ZapErrorContext extends ErrorContext {
  routeSymbol?: string;
  routeDecimals?: number;
}

function revertOf(err: unknown): { name: string; args: readonly unknown[] } | null {
  if (!(err instanceof BaseError)) return null;
  const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
  if (!(reverted instanceof ContractFunctionRevertedError) || !reverted.data?.errorName) return null;
  return { name: reverted.data.errorName, args: (reverted.data.args ?? []) as readonly unknown[] };
}

const pct = (bps: unknown) => `${Number(bps) / 100}%`;

/**
 * One sentence for a zap failure: the zap's typed guard reverts a user can hit, else the shared
 * mapping in errors.ts (vault errors bubbled through the zap, wallet rejection, viem's short message).
 */
export function describeZapError(err: unknown, ctx: ZapErrorContext = {}): string {
  const r = revertOf(err);
  const sym = ctx.routeSymbol ?? ZAP_ROUTE_SYMBOL;
  if (r) {
    const kind = r.name.replace(/^Zap(In|Out)__/, '');
    if (kind !== r.name) {
      switch (kind) {
        case 'SlippageExceeded':
          return 'The swap leg would fill below its TWAP-bounded minimum — the pool moved. Nothing was spent; retry, or raise the slippage (max 0.50%).';
        case 'SpotDeviatesFromTwap':
          return 'The route pool’s spot price is off its TWAP by more than the route allows — swapping now would be adverse. Wait for the pool to settle, or use the in-kind form.';
        case 'TwapUnavailable':
          return 'The route pool’s oracle cannot serve the TWAP window — the zap is unavailable right now. The in-kind form still works.';
        case 'SlippageTooLoose':
          return `Slippage ${pct(r.args[0])} is looser than the route’s cap of ${pct(r.args[1])}.`;
        case 'AmountTooSmall':
          return `Too small: a swap leg rounds to dust. Zap at least ${ZAP_MIN_DEPOSIT_UNITS} ${sym}.`;
        case 'VaultNotRegistered':
          return 'This vault is not registered with the zap — use the in-kind form.';
        case 'TokenNotInBasket':
          return `${sym} is not a basket token of this vault.`;
        case 'VaultEmpty':
          return 'The vault has no supply yet — its first deposit must be in kind.';
        case 'ZeroAmount':
        case 'ZeroShares':
          return 'Enter a non-zero amount.';
        case 'ZeroMinShares':
        case 'ZeroMinAmountOut':
          return 'The minimum must be non-zero — the zap rejects an unbounded call by design.';
        case 'MinAmountOut': {
          const d = ctx.routeDecimals ?? 6;
          return `Basket moved: this exit now delivers ${formatAmount(BigInt(String(r.args[1])), d, 6)} ${sym}, below your minimum of ${formatAmount(BigInt(String(r.args[0])), d, 6)} ${sym}. Nothing was redeemed — retry or raise the slippage.`;
        }
        case 'SharesExceedSupply':
          return 'More shares than the vault has in supply.';
        default:
          break;
      }
    }
  }
  return describeChainError(err, ctx);
}
