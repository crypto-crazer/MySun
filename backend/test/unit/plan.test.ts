import { describe, expect, expectTypeOf, it } from 'vitest';

import { decodeAbiParameters, encodeAbiParameters, getAddress, keccak256, parseAbiParameters, size, zeroAddress } from 'viem';

import { planExecutorAbi } from '../../src/abi/generated.js';
import {
  ADD_LIQUIDITY_PARAMS,
  PAYLOAD_SIZE,
  PLAN_KIND,
  PLAN_PARAM,
  REMOVE_LIQUIDITY_PARAMS,
  SWAP_PARAMS,
  addLiquidity,
  assertPlanWellFormed,
  closePosition,
  pinFromPositionState,
  planId,
  rebalance,
  removeLiquidity,
  swapExactIn,
  type AddLiquidityParams,
  type Plan,
  type RemoveLiquidityParams,
  type SwapParams,
} from '../../src/plan.js';
import type { Address } from '../../src/types.js';

/** Deterministic fake addresses: `addr('a')` -> 0xaaaa…aa. */
function addr(seed: string): Address {
  return `0x${seed.repeat(40).slice(0, 40)}` as Address;
}

const V3 = addr('1');
const V4 = addr('2');
// Checksummed: decoded addresses come back checksummed.
const USDG = getAddress(addr('a'));
const WETH = getAddress(addr('b'));

/** 32-byte big-endian word of a (possibly negative) integer, two's complement — written out longhand. */
function word(v: bigint): string {
  return (v < 0n ? (1n << 256n) + v : v).toString(16).padStart(64, '0');
}

const ADD: AddLiquidityParams = {
  tickLower: -197601,
  tickUpper: -197001,
  liquidity: 139530859493669n,
  minLiquidity: 139000000000000n,
  maxAmount0: 4n * 10n ** 18n,
  maxAmount1: 10_810_068_955n,
  minSwapOut: 0n,
};

describe('plan — struct definitions are the contract ones', () => {
  const shape = (p: { components: readonly { name?: string; type: string }[] }) =>
    p.components.map((c) => `${c.type} ${c.name ?? ''}`);

  it('AddLiquidityParams / RemoveLiquidityParams / SwapParams match ILiquidityAdapter / ISwapAdapter field for field', () => {
    expect(shape(ADD_LIQUIDITY_PARAMS)).toEqual([
      'int24 tickLower',
      'int24 tickUpper',
      'uint128 liquidity',
      'uint128 minLiquidity',
      'uint256 maxAmount0',
      'uint256 maxAmount1',
      'uint256 minSwapOut',
    ]);
    expect(shape(REMOVE_LIQUIDITY_PARAMS)).toEqual(['uint128 liquidity', 'uint256 minPrincipal0', 'uint256 minPrincipal1']);
    expect(shape(SWAP_PARAMS)).toEqual(['address tokenIn', 'address tokenOut', 'uint256 amountIn', 'uint256 minAmountOut']);
  });

  it('Plan matches PlanExecutor.Plan (Pin[] + Component[] included)', () => {
    expect(shape(PLAN_PARAM)).toEqual([
      'uint256 nonce',
      'uint64 deadline',
      'uint256 expectedTotalSupply',
      'tuple[] pins',
      'tuple[] components',
    ]);
    const [pins, components] = [PLAN_PARAM.components[3], PLAN_PARAM.components[4]];
    expect(shape(pins)).toEqual([
      'address adapter',
      'uint256 tokenId',
      'int24 tickLower',
      'int24 tickUpper',
      'uint128 liquidity',
      'uint32 configVersion',
    ]);
    expect(shape(components)).toEqual(['uint8 kind', 'address adapter', 'bytes payload']);
  });

  it('the TS types are the narrow struct types (int24 → number, uint128 → bigint)', () => {
    expectTypeOf<AddLiquidityParams['tickLower']>().toEqualTypeOf<number>();
    expectTypeOf<AddLiquidityParams['liquidity']>().toEqualTypeOf<bigint>();
    expectTypeOf<RemoveLiquidityParams['minPrincipal1']>().toEqualTypeOf<bigint>();
    expectTypeOf<SwapParams['tokenIn']>().toEqualTypeOf<`0x${string}`>();
    expectTypeOf<Plan['deadline']>().toEqualTypeOf<bigint>();
    expectTypeOf<Plan['pins'][number]['configVersion']>().toEqualTypeOf<number>();
  });

  it('every kind has its KIND_* constant in the executor ABI, and the payload sizes are the contract ones', () => {
    const consts = planExecutorAbi.filter((m) => m.type === 'function' && m.name.startsWith('KIND_')).map((m) => m.name);
    expect(consts.sort()).toEqual(
      ['KIND_ADD_LIQUIDITY', 'KIND_CLOSE_POSITION', 'KIND_HARVEST', 'KIND_REMOVE_LIQUIDITY', 'KIND_SWAP'].sort(),
    );
    expect(PLAN_KIND).toEqual({ Harvest: 0, Swap: 1, AddLiquidity: 2, RemoveLiquidity: 3, ClosePosition: 4 });
    expect(PAYLOAD_SIZE).toEqual({ 0: 0, 1: 128, 2: 224, 3: 96, 4: 0 });
  });

  it('the generated executor ABI carries no owner-only setter', () => {
    const names = planExecutorAbi.map((m) => ('name' in m ? m.name : ''));
    expect(names).not.toContain('setKeeper');
    expect(names).not.toContain('transferOwnership');
    expect(names).toEqual(expect.arrayContaining(['executePlan', 'nonces', 'isKeeper', 'PlanExecuted', 'KeeperSet']));
  });
});

describe('plan — component builders', () => {
  it('addLiquidity: kind 2, the adapter, payload = abi.encode(AddLiquidityParams) word by word', () => {
    const c = addLiquidity(V3, ADD);
    expect(c.kind).toBe(PLAN_KIND.AddLiquidity);
    expect(c.adapter).toBe(V3);
    expect(size(c.payload)).toBe(PAYLOAD_SIZE[PLAN_KIND.AddLiquidity]);
    // A static struct encodes inline: one word per field, int24 sign-extended.
    expect(c.payload).toBe(
      `0x${[
        word(-197601n),
        word(-197001n),
        word(ADD.liquidity),
        word(ADD.minLiquidity),
        word(ADD.maxAmount0),
        word(ADD.maxAmount1),
        word(0n),
      ].join('')}`,
    );
    expect(decodeAbiParameters([ADD_LIQUIDITY_PARAMS], c.payload)[0]).toEqual(ADD);
  });

  it('removeLiquidity: kind 3, 96-byte payload; idle-refund mode is liquidity 0', () => {
    const p: RemoveLiquidityParams = { liquidity: 0n, minPrincipal0: 0n, minPrincipal1: 0n };
    const c = removeLiquidity(V4, p);
    expect(c).toMatchObject({ kind: PLAN_KIND.RemoveLiquidity, adapter: V4 });
    expect(c.payload).toBe(`0x${word(0n).repeat(3)}`);
    const exact = removeLiquidity(V4, { liquidity: 5n, minPrincipal0: 6n, minPrincipal1: 7n });
    expect(exact.payload).toBe(`0x${word(5n)}${word(6n)}${word(7n)}`);
  });

  it('swapExactIn: kind 1, 128-byte payload, addresses left-padded', () => {
    const p: SwapParams = { tokenIn: USDG, tokenOut: WETH, amountIn: 1_000_000n, minAmountOut: 1n };
    const c = swapExactIn(V3, p);
    expect(c).toMatchObject({ kind: PLAN_KIND.Swap, adapter: V3 });
    expect(c.payload).toBe(
      `0x${'0'.repeat(24)}${USDG.slice(2).toLowerCase()}${'0'.repeat(24)}${WETH.slice(2).toLowerCase()}${word(1_000_000n)}${word(1n)}`,
    );
    expect(decodeAbiParameters([SWAP_PARAMS], c.payload)[0]).toEqual(p);
  });

  it('rebalance (Harvest): kind 0, zero adapter, empty payload; closePosition: kind 4, empty payload', () => {
    expect(rebalance()).toEqual({ kind: PLAN_KIND.Harvest, adapter: zeroAddress, payload: '0x' });
    expect(closePosition(V4)).toEqual({ kind: PLAN_KIND.ClosePosition, adapter: V4, payload: '0x' });
  });

  it('out-of-range values fail at encode time, not on chain', () => {
    expect(() => addLiquidity(V3, { ...ADD, tickLower: 2 ** 23 })).toThrow();
    expect(() => addLiquidity(V3, { ...ADD, liquidity: 1n << 128n })).toThrow();
    expect(() => removeLiquidity(V3, { liquidity: -1n, minPrincipal0: 0n, minPrincipal1: 0n })).toThrow();
  });

  it('pinFromPositionState maps positionState() field for field', () => {
    expect(pinFromPositionState(V3, [1361677n, -197601, -197001, 13953085949366978n, 1])).toEqual({
      adapter: V3,
      tokenId: 1361677n,
      tickLower: -197601,
      tickUpper: -197001,
      liquidity: 13953085949366978n,
      configVersion: 1,
    });
  });
});

describe('plan — well-formedness and planId', () => {
  const pin = pinFromPositionState(V3, [1361677n, -197601, -197001, 13953085949366978n, 1]);
  const plan: Plan = {
    nonce: 0n,
    deadline: 1_790_000_000n,
    expectedTotalSupply: 50_000n * 10n ** 18n,
    pins: [pin],
    components: [addLiquidity(V3, ADD), rebalance()],
  };

  it('accepts a pinned plan (Harvest needs no pin)', () => {
    expect(() => assertPlanWellFormed(plan)).not.toThrow();
  });

  it('rejects what the executor would reject upfront: unpinned adapter, wrong payload size, unknown kind', () => {
    expect(() => assertPlanWellFormed({ pins: [], components: [addLiquidity(V3, ADD)] })).toThrow(
      `plan component 0: adapter ${V3} is not pinned`,
    );
    expect(() =>
      assertPlanWellFormed({ pins: [pin], components: [{ kind: PLAN_KIND.ClosePosition, adapter: V3, payload: '0x00' }] }),
    ).toThrow('plan component 0: payload is 1 bytes, kind 4 needs 0');
    expect(() => assertPlanWellFormed({ pins: [pin], components: [{ kind: 9, adapter: V3, payload: '0x' }] })).toThrow(
      'plan component 0: unsupported kind 9',
    );
  });

  it('planId = keccak256(abi.encode(plan)) — matches an independent restatement of the Solidity struct', () => {
    const independent = parseAbiParameters(
      '(uint256 nonce, uint64 deadline, uint256 expectedTotalSupply, ' +
        '(address adapter, uint256 tokenId, int24 tickLower, int24 tickUpper, uint128 liquidity, uint32 configVersion)[] pins, ' +
        '(uint8 kind, address adapter, bytes payload)[] components)',
    );
    const encoded = encodeAbiParameters(independent, [plan]);
    // abi.encode of ONE dynamic struct: a head word (offset 0x20), then the tuple.
    expect(encoded.slice(2, 66)).toBe(word(32n));
    expect(planId(plan)).toBe(keccak256(encoded));
    // Any field change changes the id (nonce here).
    expect(planId({ ...plan, nonce: 1n })).not.toBe(planId(plan));
  });
});
