/**
 * Strategy layer P3 against the LIVE local anvil demo stack: a keeper-composed plan submitted to the
 * registry's `periphery.planExecutor` (shared/deployment.local.json) by anvil #1 — the executor's
 * keeper, the same key the keeper suite uses.
 *
 * One `AddLiquidity` component on the demo vault's v3 adapter (its first registered adapter), at the
 * live position's OWN bounds (an increase — on the frozen RHC fork only storage the deploy phase
 * read is cached, and that range is warmed) and 1/100 of its liquidity, capped at the vault's idle.
 * Asserts the `PlanExecuted(planId, keeper, nonce)` event — `planId` recomputed in TS by `planId()`
 * and equal to the contract's `keccak256(abi.encode(plan))` — the per-keeper nonce, and the
 * vault / position deltas. Then, read-only: replaying the plan is refused (nonce consumed) and a
 * stale pin is refused.
 *
 * Skips when the stack is unreachable or the registry lists no planExecutor; refuses anything that is
 * not the local chain (`assertLocalChain`, via `makeHarness`). Sends one real transaction.
 */

import { describe, expect, it } from 'vitest';

import { BaseError, ContractFunctionRevertedError, erc20Abi, parseEventLogs } from 'viem';

import { liquidityAdapterAbi, planExecutorAbi, vaultAbi } from '../../src/abi/generated.js';
import {
  PLAN_KIND,
  addLiquidity,
  assertPlanWellFormed,
  pinFromPositionState,
  planId,
  type AddLiquidityParams,
  type Plan,
} from '../../src/plan.js';
import type { Address } from '../../src/types.js';
import { isStackReachable, makeHarness, readDeployment } from './helpers.js';

const reachable = await isStackReachable();
const planExecutor = reachable ? readDeployment().entry.periphery?.planExecutor : undefined;
if (reachable && planExecutor === undefined) {
  // eslint-disable-next-line no-console -- visible skip reason is the point
  console.warn('[integration] the local stack lists no periphery.planExecutor — skipping the plan e2e');
}

/** The revert's custom error name and args, or a failure if the call did not revert with one. */
async function revertOf(p: Promise<unknown>): Promise<{ name: string; args: readonly unknown[] }> {
  const err = await p.then(
    () => {
      throw new Error('expected a revert');
    },
    (e: unknown) => e,
  );
  const revert = err instanceof BaseError ? err.walk((e) => e instanceof ContractFunctionRevertedError) : null;
  if (!(revert instanceof ContractFunctionRevertedError) || revert.data === undefined) throw err;
  return { name: revert.data.errorName, args: revert.data.args ?? [] };
}

describe.skipIf(!reachable || planExecutor === undefined)('PlanExecutor against the live local stack', () => {
  it('anvil #1 runs a one-component AddLiquidity plan: PlanExecuted(planId, keeper, nonce), nonce +1, position grows', async () => {
    const h = makeHarness();
    const { publicClient: pc, walletClient } = h.clients;
    if (walletClient === null) throw new Error('the harness keeper has no signer');
    const keeper = walletClient.account.address;
    const vault = h.cfg.vaultAddress;
    const executor = planExecutor as Address;

    // Wiring the plan depends on: this executor serves this vault, is its keeper, and anvil #1 is ours.
    const [executorVault, vaultKeeper, isPlanKeeper] = await Promise.all([
      pc.readContract({ address: executor, abi: planExecutorAbi, functionName: 'VAULT' }),
      pc.readContract({ address: vault, abi: vaultAbi, functionName: 'isKeeper', args: [executor] }),
      pc.readContract({ address: executor, abi: planExecutorAbi, functionName: 'isKeeper', args: [keeper] }),
    ]);
    expect(executorVault.toLowerCase()).toBe(vault.toLowerCase());
    expect(vaultKeeper).toBe(true);
    expect(isPlanKeeper).toBe(true);

    // The TS kind constants are the deployed contract's.
    const kinds = await Promise.all(
      (['KIND_HARVEST', 'KIND_SWAP', 'KIND_ADD_LIQUIDITY', 'KIND_REMOVE_LIQUIDITY', 'KIND_CLOSE_POSITION'] as const).map(
        (functionName) => pc.readContract({ address: executor, abi: planExecutorAbi, functionName }),
      ),
    );
    expect(kinds).toEqual([
      PLAN_KIND.Harvest,
      PLAN_KIND.Swap,
      PLAN_KIND.AddLiquidity,
      PLAN_KIND.RemoveLiquidity,
      PLAN_KIND.ClosePosition,
    ]);

    // The demo vault's v3 adapter (registration order: v3 first) and its live pin.
    const adapters = await pc.readContract({ address: vault, abi: vaultAbi, functionName: 'adapters' });
    const v3 = adapters[0] as Address;
    const [token0, token1] = await Promise.all([
      pc.readContract({ address: v3, abi: liquidityAdapterAbi, functionName: 'TOKEN0' }),
      pc.readContract({ address: v3, abi: liquidityAdapterAbi, functionName: 'TOKEN1' }),
    ]);
    const read = async () => {
      const [state, idle, supply, nonce] = await Promise.all([
        pc.readContract({ address: v3, abi: liquidityAdapterAbi, functionName: 'positionState' }),
        Promise.all(
          [token0, token1].map((t) => pc.readContract({ address: t, abi: erc20Abi, functionName: 'balanceOf', args: [vault] })),
        ),
        pc.readContract({ address: vault, abi: vaultAbi, functionName: 'totalSupply' }),
        pc.readContract({ address: executor, abi: planExecutorAbi, functionName: 'nonces', args: [keeper] }),
      ]);
      return { state, idle0: idle[0]!, idle1: idle[1]!, supply, nonce };
    };
    const before = await read();
    const [tokenId, tickLower, tickUpper, liquidity] = before.state;
    expect(tokenId).toBeGreaterThan(0n); // the demo position is live
    expect(liquidity).toBeGreaterThan(0n);

    // 1/100 of the live liquidity at the live bounds, capped at the vault's idle. The preview runs the
    // adapter's own sizing (as the vault would call it): no ratio swap → `minSwapOut` 0 is allowed;
    // should one be needed after other suites moved the pool, use the adapter's TWAP floor.
    const target = liquidity / 100n;
    const sizing: AddLiquidityParams = {
      tickLower,
      tickUpper,
      liquidity: target,
      minLiquidity: 0n,
      maxAmount0: before.idle0,
      maxAmount1: before.idle1,
      minSwapOut: 0n,
    };
    const [pull0, pull1, , swapIn, twapMinOut] = await pc.readContract({
      address: v3,
      abi: liquidityAdapterAbi,
      functionName: 'previewAddLiquidity',
      args: [sizing],
      account: vault,
    });
    expect(pull0 + pull1).toBeGreaterThan(0n);
    const params: AddLiquidityParams = {
      ...sizing,
      minLiquidity: (target * 99n) / 100n,
      minSwapOut: swapIn === 0n ? 0n : twapMinOut,
    };

    const latest = await pc.getBlock();
    const now = BigInt(Math.floor(Date.now() / 1000));
    const plan: Plan = {
      nonce: before.nonce,
      deadline: (latest.timestamp > now ? latest.timestamp : now) + 3600n,
      expectedTotalSupply: before.supply,
      pins: [pinFromPositionState(v3, before.state)],
      components: [addLiquidity(v3, params)],
    };
    assertPlanWellFormed(plan);

    const { request } = await pc.simulateContract({
      address: executor,
      abi: planExecutorAbi,
      functionName: 'executePlan',
      args: [plan],
      account: walletClient.account,
    });
    const hash = await walletClient.writeContract(request);
    const receipt = await pc.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe('success');

    // PlanExecuted(planId, keeper, nonce) — planId recomputed in TS equals the contract's.
    const [executed, ...more] = parseEventLogs({ abi: planExecutorAbi, eventName: 'PlanExecuted', logs: receipt.logs });
    expect(more).toHaveLength(0);
    expect(executed!.address.toLowerCase()).toBe(executor.toLowerCase());
    expect(executed!.args.planId).toBe(planId(plan));
    expect(executed!.args.keeper.toLowerCase()).toBe(keeper.toLowerCase());
    expect(executed!.args.nonce).toBe(before.nonce);

    // The vault ran the component with the EXECUTOR as its keeper.
    const [added] = parseEventLogs({ abi: vaultAbi, eventName: 'LiquidityAdded', logs: receipt.logs }).filter(
      (l) => l.address.toLowerCase() === vault.toLowerCase(),
    );
    expect(added).toBeDefined();
    expect(added!.args.keeper.toLowerCase()).toBe(executor.toLowerCase());
    expect(added!.args.adapter.toLowerCase()).toBe(v3.toLowerCase());
    expect(added!.args.tokenId).toBe(tokenId);
    expect(added!.args.liquidityAdded).toBeGreaterThanOrEqual(params.minLiquidity);

    // Nonce consumed; same position, same bounds, liquidity up by exactly what was added; supply
    // untouched; vault idle down by exactly what the position took (the leftover was refunded).
    const after = await read();
    expect(after.nonce).toBe(before.nonce + 1n);
    expect(after.state).toEqual([tokenId, tickLower, tickUpper, liquidity + added!.args.liquidityAdded, before.state[4]]);
    expect(after.supply).toBe(before.supply);
    expect(before.idle0 - after.idle0).toBe(added!.args.spent0);
    expect(before.idle1 - after.idle1).toBe(added!.args.spent1);
    expect(added!.args.spent0 + added!.args.spent1).toBeGreaterThan(0n);

    // Read-only: a replay is refused (nonce consumed) …
    const simulate = (p: Plan) =>
      pc.simulateContract({ address: executor, abi: planExecutorAbi, functionName: 'executePlan', args: [p], account: walletClient.account });
    expect(await revertOf(simulate(plan))).toEqual({
      name: 'PlanExecutor__InvalidNonce',
      args: [before.nonce + 1n, before.nonce],
    });
    // … and so is the next nonce with the now-stale pin.
    expect(await revertOf(simulate({ ...plan, nonce: before.nonce + 1n }))).toEqual({
      name: 'PlanExecutor__PinMismatch',
      args: [0n, expect.stringMatching(new RegExp(`^${v3}$`, 'i'))],
    });
  });
});
