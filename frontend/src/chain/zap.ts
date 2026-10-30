/**
 * Single-asset zap rules (periphery `MySunZapIn` / `MySunZapOut`). No React, no network — the
 * checks that must hold before a zap transaction is built:
 *
 *  - `zapDeposit` takes ONE basket token (USDG by default; any basket token with a route to every other
 *    one) and swaps the shortfall into the other basket tokens through the UniversalRouter, each leg bounded by its route's TWAP guard; the
 *    vault deposit behind it is the normal in-kind one. `zapRedeem` redeems in kind and sells every
 *    other basket token into the route token.
 *  - `slippageBps` (the per-leg bound) is always sent as 0 = "each route's own owner-set cap"
 *    (`ZAP_LEG_SLIPPAGE_BPS`); the contract would only let a non-zero value tighten a route.
 *  - `minShares` / `minAmountOut` are the user's bound — the only thing the tolerance sets — and are set
 *    here, off-chain, from the zap's own preview — with the SAME math as the in-kind deposit
 *    (`minSharesFromPreview`, one implementation).
 *
 * Imports are relative (not `@/`) on purpose: `scripts/e2e-local.ts` runs this module under tsx.
 */
import { BaseError, ContractFunctionRevertedError } from 'viem';
import { vaultAbi, zapInAbi, zapOutAbi } from '../config/generated';
import { formatAmount, parseAmount } from './amounts';
import { minSharesFromPreview } from './deposit';
import { describeChainError, type ErrorContext } from './errors';

/** The zap facets' anchor (matched on the vault's basket by symbol): the zap-in default and the only zap-out token. */
export const ZAP_ROUTE_SYMBOL = 'USDG';
/** The anchor under its on-chain symbol: USDG, or the all-mock local stack's `mUSDG` (contracts/script/DemoLocal.s.sol). */
export function isZapRouteSymbol(symbol: string): boolean {
  return symbol === ZAP_ROUTE_SYMBOL || symbol === `m${ZAP_ROUTE_SYMBOL}`;
}
/** Default tolerance — the contract's own recommendation for `minShares` / `minAmountOut` (τ = 25 bps). */
export const ZAP_DEFAULT_SLIPPAGE_BPS = 25;
/** Ceiling on the user's tolerance (bounds `minShares` / `minAmountOut` only; never sent as a leg bound). */
export const ZAP_MAX_SLIPPAGE_BPS = 50;
/**
 * The dust floor, in USD of the pay-with token at the card's display price (owner policy 2026-10-28): below
 * about $1 a zap is dust. The zap contract has no fixed minimum of its own — it reverts `ZapIn__AmountTooSmall`
 * when a leg's output floors to zero, which `previewZap` reports before anything is signed; $1 keeps every
 * leg far above that for 6- and 18-decimal tokens.
 */
export const ZAP_MIN_DEPOSIT_USD = 1;
/** Above about this much USD, warn: the published sandwich break-even is ~$26.6k (research/zap-sandwich). */
export const ZAP_SIZE_WARNING_USD = 50_000;
/** Without a price: the floor in whole pay-with tokens (sized for USDG). */
export const ZAP_MIN_DEPOSIT_UNITS = 1n;
/** Without a price: the size warning in whole pay-with tokens (sized for USDG). */
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
 * Zap-deposit amount field → base units of the pay-with token. `null` while blank. Rejects what
 * `parseAmount` rejects, zero, and anything under the dust floor (`zapMinDeposit`: ≈ $1 at `usdPerToken`,
 * else 1 whole token).
 */
export function parseZapDepositAmount(input: string, decimals: number, symbol = ZAP_ROUTE_SYMBOL, usdPerToken?: number): ZapAmount | null {
  if (input.trim() === '') return null;
  const parsed = parseAmount(input, decimals);
  if (!parsed.ok) return parsed;
  const min = zapMinDeposit(decimals, usdPerToken);
  if (parsed.value < min) {
    return { ok: false, error: `Minimum ${formatAmount(min, decimals, decimals)} ${symbol} — smaller zaps are dust` };
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

/** A usable display price: finite and positive. */
const priced = (usdPerToken: number | undefined): usdPerToken is number => usdPerToken !== undefined && Number.isFinite(usdPerToken) && usdPerToken > 0;

/**
 * `usd` worth of a token at `usdPerToken`, in base units, rounded UP to two significant digits — a figure the
 * field can show exactly (float noise below the second digit is ignored, so $1 at $2,500 is 0.0004, not 0.00041).
 */
function unitsForUsd(usd: number, usdPerToken: number, decimals: number): bigint {
  const tokens = usd / usdPerToken;
  const exp = Math.floor(Math.log10(tokens)) - 1;
  const mantissa = BigInt(Math.ceil(tokens / 10 ** exp - 1e-9));
  const shift = decimals + exp;
  if (shift >= 0) return mantissa * 10n ** BigInt(shift);
  // Finer than the token's decimals: at least one base unit
  const div = 10n ** BigInt(-shift);
  return (mantissa + div - 1n) / div;
}

/** The dust floor in base units: ≈ $1 of the token at `usdPerToken` (two significant digits, rounded up); 1 whole token without a price. */
export function zapMinDeposit(decimals: number, usdPerToken?: number): bigint {
  return priced(usdPerToken) ? unitsForUsd(ZAP_MIN_DEPOSIT_USD, usdPerToken, decimals) : ZAP_MIN_DEPOSIT_UNITS * 10n ** BigInt(decimals);
}

export type ZapSlippage = { ok: true; bps: number; clamped: boolean } | { ok: false; error: string };

/**
 * Slippage field (percent, like the in-kind form) → bps, clamped to [0, ZAP_MAX_SLIPPAGE_BPS]: a
 * value above the ceiling is lowered to it (flagged `clamped`).
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

/**
 * The `slippageBps` every zap sends: always 0, i.e. each swap leg is bounded by its own route's owner-set
 * `maxSlippageBps` (owner policy 2026-10-27). The contract applies ONE value to every leg at TWAP quote ×
 * (1 − slippageBps) with no pool-fee allowance, so any user-derived bound either fails to clear a route's fee tier
 * or reverts on ordinary spot-vs-TWAP drift; the route caps are sized per market. The user's tolerance only sets
 * `minShares` / `minAmountOut` (the end-to-end bound).
 */
export const ZAP_LEG_SLIPPAGE_BPS = 0;

/** `minShares` (zap in) / `minAmountOut` (zap out) from the zap's preview — the in-kind rule, reused. */
export function zapMinimum(expected: bigint, toleranceBps: number): bigint {
  return minSharesFromPreview(expected, toleranceBps);
}

/**
 * A warning strictly above ≈ $50,000 of the pay-with token at `usdPerToken`, else null; without a price,
 * above 50,000 whole tokens.
 */
export function zapSizeWarning(amount: bigint, decimals: number, symbol = ZAP_ROUTE_SYMBOL, usdPerToken?: number): string | null {
  if (priced(usdPerToken)) {
    if (amount <= unitsForUsd(ZAP_SIZE_WARNING_USD, usdPerToken, decimals)) return null;
    return `Large zap: above about $${ZAP_SIZE_WARNING_USD.toLocaleString('en-US')} the swap leg is worth sandwiching (published break-even ≈ $26.6k). Split it, or deposit in kind.`;
  }
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
          return 'The swap leg would fill below its TWAP-bounded minimum — the pool moved. Nothing was spent; retry, or use the in-kind form.';
        case 'SpotDeviatesFromTwap':
          return 'The route pool’s spot price is off its TWAP by more than the route allows — swapping now would be adverse. Wait for the pool to settle, or use the in-kind form.';
        case 'TwapUnavailable':
          return 'The route pool’s oracle cannot serve the TWAP window — the zap is unavailable right now. The in-kind form still works.';
        case 'SlippageTooLoose':
          return `Slippage ${pct(r.args[0])} is looser than the route’s cap of ${pct(r.args[1])}.`;
        case 'AmountTooSmall':
          return `Too small: a swap leg rounds to dust. Zap a larger amount of ${sym}.`;
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
