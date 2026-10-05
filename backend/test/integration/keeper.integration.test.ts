/**
 * Integration tests against the LIVE local anvil demo stack — the chain registry's `local` entry
 * (`shared/deployments.json` + the `shared/deployment.local.json` overlay).
 *
 * They skip themselves when the RPC is unreachable, and refuse to run against anything that is not
 * a local chain (see `assertLocalChain`). They DO send real transactions to that local chain:
 *   a) a dry-run tick changes nothing on chain and plans what we expect;
 *   b) an executing tick performs one real `deployTo` and the adapter position grows by exactly
 *      the amounts sent;
 *   c) seeded mock fees are harvested by `rebalance()` and 10% of each token reaches the treasury;
 *   f) `VAULT=stocks` targets the second vault the registry lists (dry run — nothing moves).
 *
 * (a)–(e) act on the registry's first vault (`demo`); its two adapters are read from the vault's
 * `adapters()` (registry v2 no longer lists adapters).
 *
 * Two stacks (shared/deployment.local.json): the all-mock DemoLocal.s.sol, or the RHC fork
 * (`fork: true` — DemoLocalFork.s.sol), where `demo` holds REAL USDG / WETH in the REAL Uniswap v3 / v4
 * adapters. Only what is mock-specific about the default vault differs on the fork:
 *   b) a real v3 deploy swaps to the range ratio, so the position does not grow by exactly the amounts:
 *      idle still falls by exactly the amounts, the NFT's liquidity grows, and the keeper's
 *      post-condition report equals the observed delta exactly;
 *   c) `simulateFees` exists only on the mock — the exact seeded-fee harvest runs on the `stocks`
 *      vault's mock adapters instead, and
 *   c2) the default vault harvests REAL fees: a trader swaps through the v3 pool, the expected harvest is
 *      each adapter's `harvest()` simulated as the vault, and the tick must match it exactly.
 *
 * Test order matters within this file: (b) moves idle into adapter V3, (c) then harvests.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { erc20Abi as fullErc20Abi, parseAbi } from 'viem';

import { erc20Abi, mockAdapterTestAbi, vaultAbi } from '../../src/abi/generated.js';
import { runTick, preflight } from '../../src/keeper.js';
import { observe, readAdapterPosition } from '../../src/vault.js';
import type { Address } from '../../src/types.js';
import {
  ANVIL_KEY_1,
  ANVIL_KEY_3,
  isStackReachable,
  localWallet,
  makeHarness,
  readDeployment,
  renderLog,
  type Harness,
} from './helpers.js';

const reachable = await isStackReachable();
if (!reachable) {
  // eslint-disable-next-line no-console -- visible skip reason is the point
  console.warn(
    '[integration] local anvil stack unreachable — skipping. Start it with:\n' +
      '  anvil --port 8547 --chain-id 46630   (demo stack via contracts/script/DemoLocal.s.sol)',
  );
}

const BPS = 10_000n;

/** The real UniswapV3Adapter's public immutables / state this suite reads on the fork stack. */
const v3AdapterAbi = parseAbi([
  'function tokenId() view returns (uint256)',
  'function POSITION_MANAGER() view returns (address)',
  'function POOL_FEE() view returns (uint24)',
]);
const nfpmAbi = parseAbi([
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
]);
/** IPositionAdapter.harvest — vault-only; simulated here as the vault to learn what a harvest returns. */
const adapterHarvestAbi = parseAbi(['function harvest() returns (address[] tokens, uint256[] amounts)']);
const swapRouter02Abi = parseAbi([
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
]);
/**
 * RHC's v3 SwapRouter02 — the venue OTHER market participants trade through (notes/SWAP-DESIGN.md).
 * The adapters' own `SWAP_ROUTER()` is the UniversalRouter 2.1.2 since 2026-10-01 (no `exactInputSingle`),
 * so this suite does not read it from the adapter anymore.
 */
const V3_SWAP_ROUTER02 = '0xCaf681a66D020601342297493863E78C959E5cb2' as Address;

/**
 * Independent restatement of the policy arithmetic, written out longhand so a bug in policy.ts
 * cannot make this assertion pass by agreeing with itself.
 */
function expectedPerAdapter(
  idle: bigint,
  inAdapters: bigint,
  targetIdleBps: bigint,
  maxPerTickBps: bigint,
  adapterCount: bigint,
): bigint {
  const total = idle + inAdapters;
  const targetIdle = (total * targetIdleBps) / BPS;
  const excess = idle > targetIdle ? idle - targetIdle : 0n;
  const cap = (total * maxPerTickBps) / BPS;
  const budget = excess < cap ? excess : cap;
  return budget / adapterCount;
}

describe.skipIf(!reachable)('keeper against the live local stack', () => {
  const deployment = reachable ? readDeployment() : undefined;
  /** The RHC fork stack: the default vault's tokens and adapters are REAL (see the file header). */
  const FORK = deployment?.entry.fork === true;
  // The demo vault's adapters, in registration order (DemoLocal*.s.sol: V3 first, then V4) — mocks on
  // the all-mock stack, the real UniswapV3Adapter / UniswapV4Adapter on the fork.
  let adapterV3: Address;
  let adapterV4: Address;

  beforeAll(async () => {
    const h = makeHarness();
    // Fails loudly (rather than mysteriously) if the demo stack was redeployed without the keeper.
    await preflight(h);
    const adapters = await h.clients.publicClient.readContract({
      address: h.cfg.vaultAddress,
      abi: vaultAbi,
      functionName: 'adapters',
    });
    expect(adapters).toHaveLength(2);
    [adapterV3, adapterV4] = adapters as unknown as [Address, Address];
  });

  it('a) dry run: plans the expected deployments and changes nothing on chain', async () => {
    const h: Harness = makeHarness({ DRY_RUN: 'true', REBALANCE_INTERVAL_SEC: '86400' });
    const before = await observe(h.clients, h.cfg.vaultAddress);

    const result = await runTick(h);

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.paused).toBe(false);
    expect(result.decision.plans).toHaveLength(before.state.adapters.length);
    expect(result.deploys.every((d) => d.outcome === 'simulated')).toBe(true);

    // The plan matches the longhand arithmetic, per token, per adapter.
    const adapterCount = BigInt(before.state.adapters.length);
    before.state.tokens.forEach((token, i) => {
      const idle = before.state.idle[i]!;
      const inAdapters = before.state.adapters.reduce((acc, a) => {
        const j = a.tokens.findIndex((t) => t.toLowerCase() === token.toLowerCase());
        return acc + (j >= 0 ? a.amounts[j]! : 0n);
      }, 0n);
      const expectedAmount = expectedPerAdapter(idle, inAdapters, 2000n, 5000n, adapterCount);

      for (const plan of result.decision.plans) {
        const j = plan.tokens.findIndex((t) => t.toLowerCase() === token.toLowerCase());
        expect(plan.amounts[j]).toBe(expectedAmount);
      }
    });

    // Nothing moved: idle balances and every adapter position are byte-identical.
    const after = await observe(h.clients, h.cfg.vaultAddress);
    expect(after.state.idle).toEqual(before.state.idle);
    expect(after.state.adapters.map((a) => a.amounts)).toEqual(
      before.state.adapters.map((a) => a.amounts),
    );

    // And the tick was recorded, so a restart resumes rather than repeats blindly.
    expect(h.store.read().state.tickCount).toBe(1);
    expect(h.store.read().state.lastRebalanceAt).toBeNull(); // dry run never advances the gate

    // The observation names the chain it read, by its registry name.
    const observed = h.records.find((r) => r.msg === 'observed vault');
    expect(observed).toMatchObject({
      chain: deployment!.entry.name,
      chainId: deployment!.chainId,
      vault: deployment!.vault,
      vaultKey: 'demo', // the registry's first vault
      receiptSymbol: deployment!.receipt.symbol,
    });
    expect(h.cfg).toMatchObject({ vaultKey: 'demo', receiptSymbol: deployment!.receipt.symbol });
    expect(h.clients.chain.name).toBe(deployment!.entry.name);

    process.stdout.write(`\n--- dry-run tick log ---\n${renderLog(h.records)}\n`);
  });

  it(
    FORK
      ? 'b) [fork] execute: one real deployTo — idle falls by exactly the amounts, the real v3 NFT gains liquidity'
      : 'b) execute: one real deployTo grows the adapter position by exactly the amounts sent',
    async () => {
    // Weight the whole budget onto adapter V3 so exactly one transaction is sent this tick.
    const h: Harness = makeHarness({
      DRY_RUN: 'false',
      REBALANCE_INTERVAL_SEC: '86400',
      ADAPTER_WEIGHTS: `${adapterV3}:1,${adapterV4}:0`,
    });

    // Park the harvest gate: with a fresh state file the harvest is due immediately, and
    // `rebalance()` moves fees OUT of `position()` in the same tick — which would make the
    // read-back below measure the deploy and the harvest together.
    h.store.write({ ...h.store.read().state, lastRebalanceAt: Math.floor(Date.now() / 1000) });

    const before = await observe(h.clients, h.cfg.vaultAddress);
    const posBefore = await readAdapterPosition(h.clients.publicClient, adapterV3);
    const v3Liquidity = async (): Promise<bigint> => {
      const pc = h.clients.publicClient;
      const [nfpm, id] = await Promise.all([
        pc.readContract({ address: adapterV3, abi: v3AdapterAbi, functionName: 'POSITION_MANAGER' }),
        pc.readContract({ address: adapterV3, abi: v3AdapterAbi, functionName: 'tokenId' }),
      ]);
      const position = await pc.readContract({ address: nfpm, abi: nfpmAbi, functionName: 'positions', args: [id] });
      return position[7];
    };
    const liquidityBefore = FORK ? await v3Liquidity() : 0n;

    const result = await runTick(h);
    expect(result.rebalance.outcome).toBe('skipped'); // this tick is purely a deploy

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(false);
    const sent = result.deploys.filter((d) => d.outcome === 'sent');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.adapter.toLowerCase()).toBe(adapterV3.toLowerCase());
    expect(sent[0]?.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result.deploys.find((d) => d.outcome === 'skipped')?.reason).toBe('zero-weight');

    const intended = sent[0]!;
    // Whole budget to one adapter (weights 1 / 0), so the longhand amount is the full budget.
    const adapterCount = 1n;
    before.state.tokens.forEach((token, i) => {
      const idle = before.state.idle[i]!;
      const inAdapters = before.state.adapters.reduce((acc, a) => {
        const j = a.tokens.findIndex((t) => t.toLowerCase() === token.toLowerCase());
        return acc + (j >= 0 ? a.amounts[j]! : 0n);
      }, 0n);
      const j = intended.tokens.findIndex((t) => t.toLowerCase() === token.toLowerCase());
      expect(intended.amounts[j]).toBe(
        expectedPerAdapter(idle, inAdapters, 2000n, 5000n, adapterCount),
      );
    });

    // Post-condition: position() grew by exactly the amounts, and idle fell by exactly the same.
    const posAfter = await readAdapterPosition(h.clients.publicClient, adapterV3);
    expect(posAfter.tokens).toEqual(posBefore.tokens);
    if (!FORK) {
      posAfter.tokens.forEach((token, i) => {
        const j = intended.tokens.findIndex((t) => t.toLowerCase() === token.toLowerCase());
        expect(posAfter.amounts[i]! - posBefore.amounts[i]!).toBe(intended.amounts[j]);
      });
      expect(intended.mismatches).toEqual([]);
    } else {
      // Real UniswapV3Adapter: deploy() swaps the surplus leg into the deficit one (TWAP-bounded) and adds
      // ALL of it as liquidity, so per-token deltas differ from the amounts sent. What must hold exactly:
      // the capital went into the SAME NFT as more liquidity (idle fell by exactly the amounts — below),
      // and the keeper's post-condition report is the observed delta, token by token.
      expect(await v3Liquidity()).toBeGreaterThan(liquidityBefore);
      const expectedMismatches = intended.tokens.flatMap((token, j) => {
        const i = posAfter.tokens.findIndex((t) => t.toLowerCase() === token.toLowerCase());
        const observed = posAfter.amounts[i]! - posBefore.amounts[i]!;
        return observed === intended.amounts[j] ? [] : [{ token, expected: intended.amounts[j], observed }];
      });
      expect(intended.mismatches).toEqual(expectedMismatches);
    }

    const after = await observe(h.clients, h.cfg.vaultAddress);
    after.state.tokens.forEach((token, i) => {
      const j = intended.tokens.findIndex((t) => t.toLowerCase() === token.toLowerCase());
      expect(before.state.idle[i]! - after.state.idle[i]!).toBe(intended.amounts[j]);
    });

    // The vault must never be left with a standing allowance to the adapter.
    for (const token of after.state.tokens) {
      const allowance = await h.clients.publicClient.readContract({
        address: token,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [h.cfg.vaultAddress, adapterV3],
      });
      expect(allowance).toBe(0n);
    }

    expect(h.store.read().state.lastDeployTxs[0]?.hash).toBe(intended.txHash);

    process.stdout.write(`\n--- execute tick log ---\n${renderLog(h.records)}\n`);
    },
  );

  /**
   * Seed fees on MOCK adapters (`simulateFees` is permissionless on the mock), then one executing tick:
   * `rebalance()` must harvest exactly what the adapters report as harvestable, send floor(10%) of each
   * token to the treasury, and leave nothing behind. `vaultKey` undefined = the registry's first vault.
   */
  async function harvestSeededMockFees(vaultKey: string | undefined, seed: (i: number) => readonly [bigint, bigint]) {
    const wallet = localWallet(deployment!, ANVIL_KEY_1);
    const probe = makeHarness({}, vaultKey);
    const adapters = (await probe.clients.publicClient.readContract({
      address: probe.cfg.vaultAddress,
      abi: vaultAbi,
      functionName: 'adapters',
    })) as readonly Address[];

    for (const [i, adapter] of adapters.entries()) {
      const hash = await wallet.writeContract({
        address: adapter,
        abi: mockAdapterTestAbi,
        functionName: 'simulateFees',
        args: [[...seed(i)]],
      });
      await probe.clients.publicClient.waitForTransactionReceipt({ hash });
    }

    // REBALANCE_INTERVAL_SEC=0 makes the harvest due on this tick; weights 0 so no deploy runs and
    // the assertion below sees only what rebalance() moved.
    const h: Harness = makeHarness(
      {
        DRY_RUN: 'false',
        REBALANCE_INTERVAL_SEC: '0',
        TARGET_IDLE_BPS: '10000', // keep everything idle => zero deploy budget this tick
      },
      vaultKey,
    );

    const vaultTokens = await h.clients.publicClient.readContract({
      address: h.cfg.vaultAddress,
      abi: vaultAbi,
      functionName: 'tokens',
    });
    const feeBps = await h.clients.publicClient.readContract({
      address: h.cfg.vaultAddress,
      abi: vaultAbi,
      functionName: 'performanceFeeBps',
    });
    const treasury = await h.clients.publicClient.readContract({
      address: h.cfg.vaultAddress,
      abi: vaultAbi,
      functionName: 'treasury',
    });
    expect(feeBps).toBe(1000); // 10% on the local stack

    // Everything currently harvestable across every adapter, per registry token.
    const expectedHarvest = new Map<string, bigint>(vaultTokens.map((t) => [t.toLowerCase(), 0n]));
    const adapterTokens = new Map<Address, readonly Address[]>();
    for (const adapter of adapters) {
      const [tokens] = await h.clients.publicClient.readContract({
        address: adapter,
        abi: mockAdapterTestAbi,
        functionName: 'position',
      });
      adapterTokens.set(adapter, tokens);
      for (let i = 0; i < tokens.length; i += 1) {
        const harvestable = await h.clients.publicClient.readContract({
          address: adapter,
          abi: mockAdapterTestAbi,
          functionName: 'harvestable',
          args: [BigInt(i)],
        });
        const key = tokens[i]!.toLowerCase();
        expectedHarvest.set(key, (expectedHarvest.get(key) ?? 0n) + harvestable);
      }
    }
    expect([...expectedHarvest.values()].every((v) => v > 0n)).toBe(true);

    const treasuryBefore = await Promise.all(
      vaultTokens.map((token) =>
        h.clients.publicClient.readContract({
          address: token,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [treasury],
        }),
      ),
    );

    const result = await runTick(h);

    expect(result.ok).toBe(true);
    expect(result.decision.plans).toHaveLength(0); // TARGET_IDLE_BPS=10000 => nothing to deploy
    expect(result.rebalance.outcome).toBe('sent');
    expect(result.rebalance.txHash).toMatch(/^0x[0-9a-f]{64}$/);

    const harvested = result.rebalance.harvested!;
    expect(harvested).toHaveLength(vaultTokens.length);

    for (const entry of harvested) {
      const expectedAmount = expectedHarvest.get(entry.token.toLowerCase())!;
      expect(entry.amount).toBe(expectedAmount);
      // Fee is floor(harvested * feeBps / 10_000), charged in kind, per token.
      expect(entry.fee).toBe((expectedAmount * BigInt(feeBps)) / BPS);
    }

    // The fee really arrived at the treasury, in kind, per token.
    const treasuryAfter = await Promise.all(
      vaultTokens.map((token) =>
        h.clients.publicClient.readContract({
          address: token,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [treasury],
        }),
      ),
    );
    vaultTokens.forEach((token, i) => {
      const entry = harvested.find((x) => x.token.toLowerCase() === token.toLowerCase())!;
      expect(treasuryAfter[i]! - treasuryBefore[i]!).toBe(entry.fee);
    });

    // Nothing harvestable is left behind.
    for (const adapter of adapters) {
      for (let i = 0; i < adapterTokens.get(adapter)!.length; i += 1) {
        const left = await h.clients.publicClient.readContract({
          address: adapter,
          abi: mockAdapterTestAbi,
          functionName: 'harvestable',
          args: [BigInt(i)],
        });
        expect(left).toBe(0n);
      }
    }

    // A confirmed harvest advances the interval gate in the durable state.
    const state = h.store.read().state;
    expect(state.lastRebalanceAt).not.toBeNull();
    expect(state.lastRebalanceTx?.hash).toBe(result.rebalance.txHash);

    process.stdout.write(`\n--- rebalance tick log (${vaultKey ?? 'default vault'}) ---\n${renderLog(h.records)}\n`);
  }

  it.runIf(!FORK)('c) rebalance: harvests seeded fees and sends exactly performanceFeeBps to the treasury', async () => {
    // 500 / 250 mUSDG and 0.1 / 0.05 mWETH on the demo vault's V3 / V4 mock adapters.
    await harvestSeededMockFees(undefined, (i) => (i === 0 ? [500_000000n, 100000000000000000n] : [250_000000n, 50000000000000000n]));
  });

  it.runIf(FORK)('c) [fork] rebalance on the mock-adapter vault (stocks): seeded fees harvested exactly, 10% to the treasury', async () => {
    // The fork's default vault has no `simulateFees` (real adapters — see c2); the stocks vault keeps
    // five mock pair adapters [mUSDG, stock i]: seed every pair so all six basket tokens have fees.
    await harvestSeededMockFees('stocks', () => [100_000000n, 100000000000000000n]);
  });

  it.runIf(FORK)('c2) [fork] rebalance on the REAL adapters: real swap volume, real fees harvested exactly, 10% to the treasury', async () => {
    const pc = makeHarness().clients.publicClient;
    const vault = deployment!.vault;
    const [vaultTokens, feeBps, treasury] = await Promise.all([
      pc.readContract({ address: vault, abi: vaultAbi, functionName: 'tokens' }),
      pc.readContract({ address: vault, abi: vaultAbi, functionName: 'performanceFeeBps' }),
      pc.readContract({ address: vault, abi: vaultAbi, functionName: 'treasury' }),
    ]);
    expect(feeBps).toBe(1000);

    // Real volume through the v3 adapter's own pool: the fee tier is read from the adapter; the trader
    // acts as an ordinary market participant on the fixed RHC SwapRouter02 (`V3_SWAP_ROUTER02` — the
    // adapter's own SWAP_ROUTER is the UniversalRouter 2.1.2 since 2026-10-01 and has no
    // `exactInputSingle`). The trader swaps USDG → WETH and all of it back, so fees accrue in BOTH tokens.
    const poolFee = await pc.readContract({ address: adapterV3, abi: v3AdapterAbi, functionName: 'POOL_FEE' });
    const router = V3_SWAP_ROUTER02;
    // The frozen stack must carry the router's code — a missing cache entry would make every swap a
    // silent no-op (fork-demo-up.sh warms it; this keeps the failure mode explicit if it regresses).
    expect((await pc.getCode({ address: router }))?.length ?? 0).toBeGreaterThan(2);
    const [usdg, weth] = vaultTokens as readonly [Address, Address]; // DemoLocalFork basket: [USDG, WETH]
    const trader = localWallet(deployment!, ANVIL_KEY_3);
    const balance = (token: Address) =>
      pc.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [trader.account.address] });
    const swap = async (tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<bigint> => {
      await pc.waitForTransactionReceipt({
        hash: await trader.writeContract({ address: tokenIn, abi: fullErc20Abi, functionName: 'approve', args: [router, amountIn] }),
      });
      const before = await balance(tokenOut);
      const receipt = await pc.waitForTransactionReceipt({
        hash: await trader.writeContract({
          address: router,
          abi: swapRouter02Abi,
          functionName: 'exactInputSingle',
          args: [{ tokenIn, tokenOut, fee: poolFee, recipient: trader.account.address, amountIn, amountOutMinimum: 1n, sqrtPriceLimitX96: 0n }],
        }),
      });
      expect(receipt.status).toBe('success');
      return (await balance(tokenOut)) - before;
    };
    const wethOut = await swap(usdg, weth, 100_000_000000n); // 100k USDG in
    expect(wethOut).toBeGreaterThan(0n);
    expect(await swap(weth, usdg, wethOut)).toBeGreaterThan(0n);

    // Expected harvest = each adapter's harvest() simulated as the vault (the only allowed caller), in
    // the same state the tick will execute in. The v3 NFT must have earned real fees in both tokens.
    const simulateHarvest = async (adapter: Address) =>
      (await pc.simulateContract({ address: adapter, abi: adapterHarvestAbi, functionName: 'harvest', account: vault })).result;
    const expectedHarvest = new Map<string, bigint>(vaultTokens.map((t) => [t.toLowerCase(), 0n]));
    for (const adapter of [adapterV3, adapterV4]) {
      const [tokens, amounts] = await simulateHarvest(adapter);
      tokens.forEach((t, i) => expectedHarvest.set(t.toLowerCase(), expectedHarvest.get(t.toLowerCase())! + amounts[i]!));
      if (adapter === adapterV3) expect(amounts.every((a) => a > 0n)).toBe(true);
    }

    const treasuryBefore = await Promise.all(
      vaultTokens.map((token) => pc.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [treasury] })),
    );

    const h: Harness = makeHarness({ DRY_RUN: 'false', REBALANCE_INTERVAL_SEC: '0', TARGET_IDLE_BPS: '10000' });
    const result = await runTick(h);
    expect(result.ok).toBe(true);
    expect(result.decision.plans).toHaveLength(0);
    expect(result.rebalance.outcome).toBe('sent');

    const harvested = result.rebalance.harvested!;
    expect(harvested).toHaveLength(vaultTokens.length);
    for (const entry of harvested) {
      const expectedAmount = expectedHarvest.get(entry.token.toLowerCase())!;
      expect(entry.amount).toBe(expectedAmount);
      expect(entry.fee).toBe((expectedAmount * BigInt(feeBps)) / BPS);
    }
    const treasuryAfter = await Promise.all(
      vaultTokens.map((token) => pc.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [treasury] })),
    );
    vaultTokens.forEach((token, i) => {
      const entry = harvested.find((x) => x.token.toLowerCase() === token.toLowerCase())!;
      expect(entry.fee).toBeGreaterThan(0n);
      expect(treasuryAfter[i]! - treasuryBefore[i]!).toBe(entry.fee);
    });

    // Nothing harvestable is left behind on either real adapter.
    for (const adapter of [adapterV3, adapterV4]) {
      const [, left] = await simulateHarvest(adapter);
      expect(left.every((a) => a === 0n)).toBe(true);
    }
    expect(h.store.read().state.lastRebalanceTx?.hash).toBe(result.rebalance.txHash);

    process.stdout.write(`\n--- real-venue rebalance tick log ---\n${renderLog(h.records)}\n`);
  });

  it('d) a not-yet-due harvest is skipped with an explicit reason', async () => {
    const h: Harness = makeHarness({ DRY_RUN: 'true', REBALANCE_INTERVAL_SEC: '86400' });
    h.store.write({ ...h.store.read().state, lastRebalanceAt: Math.floor(Date.now() / 1000) });

    const result = await runTick(h);
    expect(result.rebalance.due).toBe(false);
    expect(result.rebalance.reason).toBe('interval-not-elapsed');
    expect(result.rebalance.secondsUntilDue).toBeGreaterThan(86_000);
  });

  it('e) preflight rejects an address the vault does not recognise as a keeper', async () => {
    const h = makeHarness({
      // Anvil account #9 — a funded local account that was never granted the keeper role.
      KEEPER_PRIVATE_KEY: undefined,
      KEEPER_ADDRESS: '0xa0Ee7A142d267C1f36714E4a8F75612F20a79720',
    });
    await expect(preflight(h)).rejects.toThrow(/not an authorised keeper/);
  });

  it('f) VAULT=stocks: preflight + a dry-run tick act on the stocks vault, and nothing moves', async () => {
    const stocks = readDeployment('stocks');
    expect(stocks.vault.toLowerCase()).not.toBe(deployment!.vault.toLowerCase());

    // Registry-driven selection, as the CLI does it: VAULT names the vault, no VAULT_ADDRESS.
    const h = makeHarness(
      { VAULT: 'stocks', VAULT_ADDRESS: undefined, DRY_RUN: 'true', REBALANCE_INTERVAL_SEC: '86400' },
      'stocks',
    );
    expect(h.cfg).toMatchObject({
      vaultAddress: stocks.vault,
      vaultKey: 'stocks',
      vaultLabel: stocks.label,
      receiptName: stocks.receipt.name,
      receiptSymbol: stocks.receipt.symbol,
    });

    await preflight(h);
    const before = await observe(h.clients, h.cfg.vaultAddress);
    const result = await runTick(h);
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.deploys.every((d) => d.outcome !== 'sent')).toBe(true);

    for (const msg of ['preflight ok', 'observed vault']) {
      expect(h.records.find((r) => r.msg === msg)).toMatchObject({
        vault: stocks.vault,
        vaultKey: 'stocks',
        receiptSymbol: stocks.receipt.symbol,
      });
    }
    // The stocks basket is mUSDG + 5 stock tokens — not the demo vault's two.
    expect(before.state.tokens).toHaveLength(6);

    const after = await observe(h.clients, h.cfg.vaultAddress);
    expect(after.state.idle).toEqual(before.state.idle);
    expect(after.state.adapters.map((a) => a.amounts)).toEqual(
      before.state.adapters.map((a) => a.amounts),
    );
  });
});
