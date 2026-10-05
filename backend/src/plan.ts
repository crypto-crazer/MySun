/**
 * Keeper-side plan builders for the strategy layer's `PlanExecutor` (P3 periphery,
 * `contracts/src/periphery/PlanExecutor.sol`): a PLAN is an ordered list of typed vault keeper calls
 * the executor runs in ONE transaction, all-or-nothing, after its upfront staleness checks (deadline,
 * per-keeper nonce, `expectedTotalSupply`, one adapter pin per adapter a component names).
 *
 * Each builder returns a `PlanExecutor.Component` — `{ adapter, kind, payload }` — whose `payload` is
 * `abi.encode` of the vault parameter struct its kind decodes. The struct definitions are NOT restated
 * here: they are taken from the generated ABIs (the vault's `addLiquidity` / `removeLiquidity` /
 * `swapExactIn` inputs and `executePlan`'s `Plan` tuple), so a contract change shows up as a type
 * error after `pnpm run sync-abis` instead of a silently mis-encoded payload.
 *
 * Pure — no client, no I/O. Nothing here sends a transaction; the caller submits
 * `executePlan(plan)` with its own wallet client (the keeper must be on the executor's own keeper
 * set — `PlanExecutor.isKeeper`, owner-managed; the executor itself is the vault's keeper).
 */

import { encodeAbiParameters, keccak256, zeroAddress, type AbiParameterToPrimitiveType } from 'viem';

import { planExecutorAbi, vaultAbi } from './abi/generated.js';
import type { Address, Hex } from './types.js';

/** Component kinds — `PlanExecutor.KIND_*` (the e2e checks them against the deployed contract). */
export const PLAN_KIND = {
  /** `vault.rebalance()` — payload empty, adapter ignored (and unpinned). */
  Harvest: 0,
  /** `vault.swapExactIn(adapter, SwapParams)`. */
  Swap: 1,
  /** `vault.addLiquidity(adapter, AddLiquidityParams)`. */
  AddLiquidity: 2,
  /** `vault.removeLiquidity(adapter, RemoveLiquidityParams)`. */
  RemoveLiquidity: 3,
  /** `vault.pullFrom(adapter, 10_000)` — burns the position (the re-range path); payload empty. */
  ClosePosition: 4,
} as const;
export type PlanKind = (typeof PLAN_KIND)[keyof typeof PLAN_KIND];

/** Exact payload byte length per kind — the executor rejects anything else (`PlanExecutor__InvalidPayload`). */
export const PAYLOAD_SIZE: Readonly<Record<PlanKind, number>> = {
  [PLAN_KIND.Harvest]: 0,
  [PLAN_KIND.Swap]: 4 * 32,
  [PLAN_KIND.AddLiquidity]: 7 * 32,
  [PLAN_KIND.RemoveLiquidity]: 3 * 32,
  [PLAN_KIND.ClosePosition]: 0,
};

/** The generated ABI's function `name` (narrowly typed), or a loud failure if sync-abis dropped it. */
function fn<const A extends readonly { type: string; name?: string }[], N extends string>(
  abi: A,
  name: N,
): Extract<A[number], { type: 'function'; name: N }> {
  const item = abi.find((m) => m.type === 'function' && m.name === name);
  if (item === undefined) throw new Error(`generated ABI has no function ${name} — re-run sync-abis`);
  return item as Extract<A[number], { type: 'function'; name: N }>;
}

/** `ILiquidityAdapter.AddLiquidityParams` — the vault's `addLiquidity(adapter, p)` second input. */
export const ADD_LIQUIDITY_PARAMS = fn(vaultAbi, 'addLiquidity').inputs[1];
/** `ILiquidityAdapter.RemoveLiquidityParams` — the vault's `removeLiquidity(adapter, p)` second input. */
export const REMOVE_LIQUIDITY_PARAMS = fn(vaultAbi, 'removeLiquidity').inputs[1];
/** `ISwapAdapter.SwapParams` — the vault's `swapExactIn(adapter, p)` second input. */
export const SWAP_PARAMS = fn(vaultAbi, 'swapExactIn').inputs[1];
/** `PlanExecutor.Plan` — `executePlan(plan)`'s only input. */
export const PLAN_PARAM = fn(planExecutorAbi, 'executePlan').inputs[0];

export type AddLiquidityParams = AbiParameterToPrimitiveType<typeof ADD_LIQUIDITY_PARAMS>;
export type RemoveLiquidityParams = AbiParameterToPrimitiveType<typeof REMOVE_LIQUIDITY_PARAMS>;
export type SwapParams = AbiParameterToPrimitiveType<typeof SWAP_PARAMS>;
export type Plan = AbiParameterToPrimitiveType<typeof PLAN_PARAM>;
export type PlanPin = Plan['pins'][number];
export type PlanComponent = Plan['components'][number] & { readonly kind: PlanKind };

function component(kind: PlanKind, adapter: Address, payload: Hex): PlanComponent {
  return { adapter, kind, payload };
}

/** AddLiquidity: exact raw add at absolute bounds on a registered `ILiquidityAdapter`, via the vault. */
export function addLiquidity(adapter: Address, p: AddLiquidityParams): PlanComponent {
  return component(PLAN_KIND.AddLiquidity, adapter, encodeAbiParameters([ADD_LIQUIDITY_PARAMS], [p]));
}

/** RemoveLiquidity: exact raw remove (`liquidity: 0n` = idle-refund mode only), everything to the vault. */
export function removeLiquidity(adapter: Address, p: RemoveLiquidityParams): PlanComponent {
  return component(PLAN_KIND.RemoveLiquidity, adapter, encodeAbiParameters([REMOVE_LIQUIDITY_PARAMS], [p]));
}

/** Swap: exact-input swap of vault idle through the adapter's venue, output to the vault. */
export function swapExactIn(adapter: Address, p: SwapParams): PlanComponent {
  return component(PLAN_KIND.Swap, adapter, encodeAbiParameters([SWAP_PARAMS], [p]));
}

/** Harvest: `vault.rebalance()` — adapter-less (zero address, needs no pin), empty payload. */
export function rebalance(): PlanComponent {
  return component(PLAN_KIND.Harvest, zeroAddress, '0x');
}

/** ClosePosition: `vault.pullFrom(adapter, 10_000)` — burns the adapter's position; empty payload. */
export function closePosition(adapter: Address): PlanComponent {
  return component(PLAN_KIND.ClosePosition, adapter, '0x');
}

/**
 * A pin from an adapter's live `positionState()` tuple — `(tokenId, tickLower, tickUpper, liquidity,
 * configVersion)`, as viem returns it. The executor requires exact equality at plan start.
 */
export function pinFromPositionState(
  adapter: Address,
  state: readonly [bigint, number, number, bigint, number],
): PlanPin {
  const [tokenId, tickLower, tickUpper, liquidity, configVersion] = state;
  return { adapter, tokenId, tickLower, tickUpper, liquidity, configVersion };
}

/**
 * The executor's upfront component checks, run client-side so a malformed plan fails before it is
 * signed: known kind, exact payload size, and every adapter-naming component covered by a pin.
 * Messages name the component index like the contract's errors do.
 */
export function assertPlanWellFormed(plan: Pick<Plan, 'pins' | 'components'>): void {
  const pinned = new Set(plan.pins.map((p) => p.adapter.toLowerCase()));
  plan.components.forEach((c, i) => {
    const size = PAYLOAD_SIZE[c.kind as PlanKind];
    if (size === undefined) throw new Error(`plan component ${i}: unsupported kind ${c.kind}`);
    const length = (c.payload.length - 2) / 2;
    if (length !== size) throw new Error(`plan component ${i}: payload is ${length} bytes, kind ${c.kind} needs ${size}`);
    if (c.kind !== PLAN_KIND.Harvest && !pinned.has(c.adapter.toLowerCase())) {
      throw new Error(`plan component ${i}: adapter ${c.adapter} is not pinned`);
    }
  });
}

/**
 * `planId` as `PlanExecutor` emits it in `PlanExecuted(planId, keeper, nonce)`:
 * `keccak256(abi.encode(plan))` — the ABI encoding of the single `Plan` tuple.
 */
export function planId(plan: Plan): Hex {
  return keccak256(encodeAbiParameters([PLAN_PARAM], [plan]));
}
