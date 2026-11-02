# Vault-side inexact-delivery guards for `addLiquidity` and `swapExactIn`

Status: proposed, implemented in PR #10 (branch `cursor/swap-inexact-delivery-0d6d`).
Date: 2026-11-02. Scope: `PoolmigoVaultUpgradeable` (and so `MySunVaultUpgradeable`, which adds no code).
Line references are at `aed498c` (the PR head before this change).

## 1. Problem

The vault funds two keeper ops out of its idle and then trusts what the adapter says happened.

### 1.1 addLiquidity (High)

`PoolmigoVaultUpgradeable.addLiquidity` (`contracts/src/PoolmigoVaultUpgradeable.sol:425-439`) approves the caps,
calls `ILiquidityAdapter.addLiquidity` (`:434-435`), revokes, and emits the adapter's numbers. It never looks at a
balance.

Every adapter sizes the op with its nominal pull, not with what arrived:

| adapter | pull | `avail = pull` | spend / refund from `avail` |
|---|---|---|---|
| `UniswapV3Adapter` | `:554` | `:555-556` | `:569`, `:574-576` |
| `UniswapV4Adapter` | `:596` | `:599-600` | `:628-633` |
| `UniswapV4HookedAdapter` | `:647` | `:650-651` | `:680-683` |
| `UniswapV4NativeEthAdapter` | `:701` | `:704-705` | `:734-737` |

If the vault-to-adapter transfer arrives short (fee-on-transfer, a fee switched on later, a token that taxes only
some senders, a 1-2 wei rounding token), `avail` overstates what the op holds by the shortfall `s`. The adapter
then spends and refunds `avail` anyway, so `s` comes out of whatever else it holds: its free idle and, on the three
v4 adapters, the fee bank (`bankedFees0/1`, which is token balance like any other).

Consequences:
- **Adapter reserves are spent.** Idle belonging to every holder becomes this op's principal or refund.
- **v4 bank under-backed.** Once `s` exceeds the free idle, `balance < bankedFees`. `_freeBalances()`
  (`UniswapV4Adapter.sol:1256-1260`, Hooked `:1307`, Native `:1368`) then underflows. That reverts `deploy`
  (`_swapToRangeRatio`, `:848`, and `_addLiquidity`, `:902`), so `deployTo` and every `deposit` whose split routes
  to that adapter revert too. It also reverts `removeLiquidity` idle-refund mode (`:668`). The vault's
  `totalTokens()` keeps counting a fee bank the adapter can't pay, and the performance fee is later charged on it.
- **The vault's books are wrong.** `LiquidityAdded` reports `spent`/`refunded` that never happened as stated.

### 1.2 swapExactIn output side (Medium)

`swapExactIn` (`PoolmigoVaultUpgradeable.sol:488-524`) checks `minAmountOut` against the adapter's *return value*
(`:512`, `:519-521`) and emits it in `SwapSettled` (`:523`). Every adapter sends that nominal `amountOut` to the vault
(V3 `:649`, V4 `:708`, Hooked `:759`, Native `:815`). If `tokenOut` delivers short on the adapter-to-vault leg, the
vault receives less than `minAmountOut` and the check still passes. If the executor-to-adapter leg is short, the
adapter pays the difference out of its `tokenOut` idle or bank, the same leak as 1.1. The existing check
(`:510-518`) watches `tokenIn` only.

### 1.3 Strict reserved check vs rounding tokens (Low)

The `tokenIn` check at `:515` is strict (`reservedAfter < reservedBefore` reverts). A token whose transfers can
credit 1-2 wei less than they debit (share/multiplier tokens that round the credit down, rebasing wrappers) makes
the adapter finish 1-2 wei lower on an honest swap. The check then reverts every swap of that token. There is no
fallback, so the keeper simply can't use that pair.

## 2. Proposal

One vault-side rule for both ops, plus a measured output for the swap.

**R1. Adapter reserves are never spent by a vault-funded op.** Before the call, snapshot the adapter's balance of
each token the op touches: the adapter's pair for `addLiquidity`, `[tokenIn, tokenOut]` for `swapExactIn`. After the
call, for each token:
- if `after >= before`: OK. Same-call fee banking (v4 `addLiquidity`) can only raise the balance.
- if `before - after > ROUNDING_TOLERANCE` (2 wei): revert `PoolmigoVault__AdapterReserveSpent`.
- otherwise (a 1-2 wei rounding drain): the vault sends `drain + ROUNDING_TOLERANCE` of that token from its own
  idle to the adapter, then requires `balance >= before` again (same error). The op's funder pays its own rounding,
  and adapter reserves stay intact. The extra ≤ 2 wei stays as adapter free idle, which `position()` still counts.

**R2. swapExactIn settles on what the vault received.** `amountOut = vault tokenOut balance after − before`,
measured after R1's top-up (so it is net of it). `minAmountOut` is checked against it, and `SwapSettled` emits it.
The adapter's return value is ignored.

Both checks run inside the existing `nonReentrant` lock. The snapshots are only sound because no other vault entry
point can move the vault's balances between them. The reentrancy test pins this.

### Why the tolerance is 2 and why the top-up

- 2 wei covers the rounding families seen in practice (stETH-style shares, multiplier/rebasing wrappers: ≤ 1 wei
  per transfer, ≤ 2 per op leg pair). Any real fee is ≥ 1 bp of a non-dust amount, far above 2 wei, and still
  reverts.
- Tolerance without a top-up lets every op drain up to 2 wei, and that adds up across ops. On v4 the free idle
  after a deploy is usually 0-1 wei, so the bank would end up under-backed, which is the 1.1 failure in slow
  motion. The top-up restores the strict invariant `after >= before` and keeps tolerance from accumulating.
- The top-up sends `drain + 2`, not `drain`, because the top-up transfer itself can round down by up to 2 wei.
- The top-up goes to a registered adapter, the op's own counterparty, and the value stays in `totalTokens()`.
  So it is not an egress path. It needs ≤ 4 wei of vault idle. If the vault holds less, the op reverts, which is
  safe.

## 3. Invariants

- I1 (both ops): for each touched token `t`, `balanceOf(adapter, t)` after the op ≥ before it.
- I2 (`swapExactIn`): `SwapSettled.amountOut` = the vault's measured net `tokenOut` gain, and it is ≥
  `p.minAmountOut`.
- I3: the vault's `tokenIn` outflow in `swapExactIn` is ≤ `amountIn + 2·ROUNDING_TOLERANCE`. It is exactly
  `amountIn` for exact tokens, since no top-up happens. The same bound applies per token to `addLiquidity` on top
  of the caps.
- I4: no change to storage, fees, share math, `deposit`, `redeem`, or any other path.

## 4. Residual risk (documented, not closed by this change)

R1 compares balances, so on the three v4 adapters, fees banked *inside the same `addLiquidity`* (`_bankFees`,
`UniswapV4Adapter.sol:598`) raise the balance and can hide a shortfall up to the amount banked. The vault cannot
separate "bank grew" from "nothing was spent" without reading adapter internals (`bankedFees0/1` are not part of
any interface, and `IAdapterFees.fees()` means different things on v3 and v4).

How it could be exploited:
- **Uniform fee-on-transfer tokens don't reach it.** Every adapter leg out of the adapter goes into a venue that
  checks what it received: v3 pool `M0/M1` and swap-callback balance checks, v4 `settle` deltas
  (`CurrencyNotSettled`). A short leg there reverts. V3 never banks in `addLiquidity` ("No harvest, no fee
  collection", `UniswapV3Adapter.sol:533`), so R1 is exact for V3.
- **What's left** is a token that taxes the vault-to-adapter leg but not the adapter-to-venue leg (selective by
  sender/recipient), on a v4 adapter, in an `addLiquidity` that banks at least the shortfall.

The full fix is adapter-side (`avail = measured receipt`), which needs an adapter redeploy (§5, option D). Basket
tokens are owner-registered, and `deposit` already rejects any token that doesn't deliver exactly to the vault
(`_pullExact`, K-31). So a selective-fee token would have to be both registered and selective toward adapters
specifically.

## 5. Alternatives considered

| | option | verdict |
|---|---|---|
| A | **Do nothing.** Rely on owner token curation and `_pullExact` at deposit. | Rejected. A fee can be switched on after registration (USDT-style), and 1.1's bank under-backing bricks deposits vault-wide. 1.2 lets the output floor be bypassed. |
| B | **Strict check only, no tolerance** (status quo for `tokenIn`). | Rejected for 1.3: rounding tokens can't be swapped at all. |
| C | **Tolerance, no top-up.** | Rejected: the drain adds up across ops and under-backs the v4 bank (see §2). |
| D | **Adapter redeploy.** `avail = balanceAfterPull − balanceBefore`, and refund from measured holdings. | The complete fix (also closes §4). But all four adapter classes are immutable, live, and hold positions: it means a redeploy, a position migration (`pullFrom` 10_000 → `removeAdapter` → `addAdapter` → redeploy liquidity) per adapter, and new deploy-script wiring. Recommended for the next adapter batch; it doesn't replace R1/R2, which still guard any third-party adapter. |
| E | **Measure the vault's refund via the allowance it left** (`pulled = cap − allowance`). | Rejected: it adds two calls per token, and it only catches uniform FoT, which real venues already reject. It doesn't close §4. |
| F | **Read the v4 bank (`bankedFees0/1`) from the vault.** | Rejected: couples the vault to one adapter family's storage, isn't in any interface, and third-party adapters don't have it. |
| G | **Revert on any `received != amountOut` in swapExactIn.** | Not needed: R1 already covers the adapter's side, and the measured minimum covers the vault's. Strict equality would reintroduce 1.3 on the output leg. |

## 6. Exact interface changes

Functions: **no signature change.**
- `addLiquidity(IPositionAdapter adapter, ILiquidityAdapter.AddLiquidityParams calldata p)`: unchanged.
- `swapExactIn(IPositionAdapter adapter, ISwapAdapter.SwapParams calldata p)`: unchanged.

Errors (in `IPoolmigoVault`):
- **added:** `error PoolmigoVault__AdapterReserveSpent(address adapter, address token, uint256 reserveBefore, uint256 reserveAfter);`
  (raised by R1 in both ops).
- `PoolmigoVault__InexactDelivery(address,uint256,uint256)`: kept (`deposit`'s `_pullExact`). `swapExactIn` no
  longer raises it.
- `PoolmigoVault__InsufficientAmountOut(uint256 minAmountOut, uint256 amountOut)`: unchanged. `amountOut` is now the
  measured value.

Events: **no signature change.**
- `SwapSettled(adapter, tokenIn, tokenOut, amountIn, amountOut)`: `amountOut` is now the vault's measured receipt
  (equal to the adapter return for exact tokens).
- `LiquidityAdded`: unchanged. It still carries the adapter's split, which R1 now guarantees was paid from this
  op's funds.

Constant (private, no ABI): `uint256 private constant ROUNDING_TOLERANCE = 2;`

## 7. Migration

- **Contracts changed:** `PoolmigoVaultUpgradeable` (+ `IPoolmigoVault` error). `MySunVaultUpgradeable` inherits
  it. No adapter, periphery or library change: `PoolmigoVaultCold` is untouched, but it is relinked with the new
  implementation.
- **Upgrade path:** UUPS `upgradeToAndCall(newImpl, "")` per proxy, owner (multisig + timelock). No reinitializer.
  Same `depositSplit_` constructor arg. The new implementation links the already-deployed `PoolmigoVaultCold`, or a
  fresh deploy of it. It is stateless, so either works.
- **Storage:** none. `PoolmigoVaultStorage` (ERC-7201) is untouched, and the new constant is bytecode only.
- **Bytecode:** the vault runtime grows by a few hundred bytes. The margin at `aed498c` is 3,602 B (20,974 B runtime).
  The final number is in the PR.
- **Keepers / off-chain:** swaps of a short-delivering `tokenOut` now report the smaller measured `amountOut`. Ops
  that previously reverted `InexactDelivery` in `swapExactIn` now revert `AdapterReserveSpent`.

## 8. Test plan

| # | test | guard it pins |
|---|---|---|
| T1 | FoT `addLiquidity` (vault-to-adapter leg taxed) through an adapter that sizes with `avail = pull`, as all four do: reverts `AdapterReserveSpent`; adapter reserve and vault idle unchanged | R1 in `addLiquidity` |
| T2 | FoT `tokenOut` (adapter-to-vault leg taxed) on the real V3 adapter: reverts `InsufficientAmountOut(minOut, measured)` | R2 |
| T3 | v4 fee bank not spendable: real `UniswapV4Adapter` with a backed bank, FoT `tokenIn`: `swapExactIn` reverts `AdapterReserveSpent`; `bankedFees0/1` and balance intact | R1 in `swapExactIn` (v4) |
| T4 | Reentrant `tokenIn` whose transfer hook calls back into the vault (`redeem`) during `swapExactIn`: reverts `ReentrancyGuardReentrantCall` | the `nonReentrant` lock the snapshots rely on |
| T5 | 1-wei rounding token on `swapExactIn` (real V3 adapter) and on `addLiquidity`: the op succeeds, the adapter balance is ≥ before, and the vault pays ≤ `amountIn + 2·ROUNDING_TOLERANCE` | tolerance + top-up |
| T6 | Existing exact-token suites (LiquidityOps, StrategyP3, SwapExactInDelivery, PlanExecutor, invariants) pass unchanged except for the renamed error | no regression |

Each new guard is removed once and its test is shown failing; the removal is then reverted (see PR).
A local anvil run upgrades a `2736e67` proxy to this implementation and exercises deposit, add/remove liquidity,
swap, fee skim, and redeem end to end (`contracts/script/local/`).
