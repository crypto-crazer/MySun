# Redeem: per-token minimum amounts

| | |
|---|---|
| Status | Proposed. Design only, no Solidity on this branch. Pending review. |
| Date | 2026-11-01 |
| Branch | `cursor/swap-inexact-delivery-0d6d` (PR #10) |
| Scope | Vault only: `contracts/src/PoolmigoVaultUpgradeable.sol`, `contracts/src/interfaces/IPoolmigoVault.sol`. No adapter change. |
| Finding | "`redeem` has no per-token minimum outputs; adapters pass 0 mins to `decreaseLiquidity`; a large in-kind redeem can be sandwiched" (filed as Medium) |

All `file:line` references are to the branch head that carries this document. Paths are relative to `contracts/`.

## 0. Background

A reviewer new to the repository needs these facts first.

- **The vault** is a UUPS proxy with ERC-7201 namespaced storage (`PoolmigoVaultStorage`,
  `src/PoolmigoVaultUpgradeable.sol:114`). A share is a pro-rata claim on a basket of tokens, for example USDG + WETH.
  It is not a USD claim. The basket is held in two places: as the vault's own balances ("idle"), and inside
  registered **adapters**. Each adapter wraps one LP position on one pool of one DEX: Uniswap v3, Uniswap v4,
  v4 with a restricted hook, or v4 with native ETH.
- **`redeem(shares, receiver)`** burns the shares and pays out in kind. The receiver gets its pro-rata slice of
  the vault's idle balances plus each adapter's `withdrawProportional(sharesWad)` slice. The performance fee is
  deducted from the accrued-fee part of those slices only. No swap and no oracle are involved.
- **Two implementation contracts share one codebase.** `PoolmigoVaultUpgradeable` sits behind the legacy proxies,
  and `MySunVaultUpgradeable` is a code-free subclass used for new deployments (`src/MySunVaultUpgradeable.sol:27`).
  Every change below applies to both.
- **Upgrade authority** is the owner, a multisig behind a timelock. `_authorizeUpgrade` is `onlyOwner`
  (`src/PoolmigoVaultUpgradeable.sol:908`).

## 1. Problem

### 1.1 What the code does

- `redeem` (`src/PoolmigoVaultUpgradeable.sol:327-372`) takes no bound on what the receiver gets. It checks only
  `shares != 0`, `receiver != 0`, not paused, and the caller's balance (`:332-342`). It then computes
  `out = idleOut[i] + amounts[i] - cut[i]` (`:364`) and transfers that amount, whatever it is.
- `deposit` does take a bound, and the bound is mandatory: `minShares` must be non-zero and
  `shares < minShares` reverts (`:278-295`). The exit side has nothing equivalent.
- The adapter slices come from `_exitAll` (`:1098-1122`) through `_withdrawFrom` (`:1087-1092`), which calls
  `IPositionAdapter.withdrawProportional` (`src/interfaces/IPositionAdapter.sol:38`).
- Every adapter removes liquidity at the pool's current spot price with **zero minimums**. This is deliberate and
  documented as "a redemption must never be blocked":
  - Uniswap v3: `_decreaseLiquidity(id, liquidityOut, 0, 0)` at `src/adapters/UniswapV3Adapter.sol:910`
    (`unwindAll`: `:494`; rationale: `:405`).
  - Uniswap v4: `DECREASE_LIQUIDITY` / `BURN_POSITION` with `uint128(0)` mins at
    `src/adapters/UniswapV4Adapter.sol:986` and `:989` (rationale: `:454`).
  - v4 hooked: `src/adapters/UniswapV4HookedAdapter.sol:1037` and `:1040`.
  - v4 native ETH: `src/adapters/UniswapV4NativeEthAdapter.sol:1095` and `:1097`.
- `previewRedeem` (`src/PoolmigoVaultUpgradeable.sol:884-901`) reads each adapter's spot `position()`. It
  returns an upper bound on each token delivered. A client can compute what it expects to receive but has no
  way to make the transaction enforce it.

### 1.2 What investigation shows: the value-extraction claim does not hold

The finding claims an attacker pushes the pool price, the redeemer receives a skewed token mix, and the attacker
keeps the difference. The first two parts are true. The third is not, for the following reason.

**The skewed mix is worth at least the fair slice at the true price.** Take a v3/v4 position on the range
`[Pa, Pb]` with liquidity `L`. Its holdings at price `p` are
`x(p) = L(1/√p − 1/√Pb)` and `y(p) = L(√p − √Pa)`. Value those holdings at the true price `P`:
`W(p) = P·x(p) + y(p)`. Then `dW/dp = (L / 2√p)·(1 − P/p)`. This is negative for `p < P` and positive for
`p > P`, and `W` is constant outside the range. So `W(p) ≥ W(P)` for every `p`. In words: an AMM's reserves at
price `P` are the cheapest point on its curve when valued at `P`. A redeemer whose slice is released at a
manipulated spot `p` therefore receives tokens worth at least the fair slice, measured at the true price.

**The sandwich loses money.** The attacker's first leg pays a slippage loss `s` into the pool. The redeemer
removes a fraction `f` of the liquidity and takes `f·s` of that loss with it. The attacker's return leg then
recovers only `(1 − f)·s`. The attacker's net result is `−f·s` minus swap fees on both legs. The remaining
holders end at exactly their fair share.

**Worked example** (full range, fees ignored, the pool is entirely the vault's position):

| step | pool A / B | attacker | redeemer (burns 50%) |
|---|---|---|---|
| start, true price 1 | 100 / 100 | 0 | fair slice = 50 A + 50 B = **100** |
| attacker sells 100 A | 200 / 50 | −100 A, +50 B | |
| redeem 50% at spot 0.25 | 100 / 25 | | +100 A, +25 B = **125** |
| attacker restores price 1 | 50 / 50 | +50 A, −25 B → net −50 A, +25 B = **−25** | |

The remaining holders keep 50 A + 50 B, which is their fair half. The redeemer comes out ahead and the
attacker loses 25.

**Other paths checked:**

- **Nothing swaps on the redeem path.** The vault never swaps. Adapters "NEVER swap, never read the TWAP" on
  withdraw and unwind (`src/adapters/UniswapV4HookedAdapter.sol:66-67`).
- **No hook can tax a removal.** The hooked and native-ETH adapters reject any hook that has a remove-liquidity
  callback or any `*_RETURNS_DELTA` permission bit (`HOOK_FORBIDDEN_FLAGS = 0x0F0F`,
  `src/adapters/UniswapV4HookedAdapter.sol:310`, `src/adapters/UniswapV4NativeEthAdapter.sol:339`).
- **Single-token exits already have slippage bounds.** `PoolmigoZapOut` sells the in-kind tokens, and each sale
  carries a TWAP-floored `minOut` (`src/periphery/PoolmigoZapOut.sol:465`). The zap as a whole also checks the
  caller's `minAmountOut` (`:275`) and sells the measured balance deltas, not the reported amounts.

**Conclusion:** the in-kind redeemer suffers no value loss from the described sandwich. The severity should be
reconsidered; this document suggests **Low**, as hardening plus integration parity. Reviewers should confirm or
override that call.

### 1.3 Why a per-token bound is still worth adding

"Worth more at the true price" only helps a redeemer who can actually trade at the true price. Between the
quote (`previewRedeem`, read at signing) and inclusion of the transaction, these exposures have no bound today:

1. **Composition.** A redeem that lands at a dislocated spot price, whether organic or manipulated, hands over
   an arbitrarily skewed token mix, and the result is final. A redeemer who needs a specific token (to repay a
   loan, to sell on another venue, for accounting) has no way to refuse it.
2. **Privileged actions that change the outcome**, landing before the redeem through ordinary transaction
   ordering (no MEV needed):
   - `setPerformanceFeeBps` (`:711`) can raise the fee to 30% of the fee part.
   - `forceRemoveAdapter` (`:664`) drops an adapter's holdings from the redeemable pool. A redeem landing after
     it receives nothing from that adapter.
   - Keeper `swapExactIn`, `pullFrom`, `removeLiquidity` and `rebalance` change the vault's token mix. Their
     value is TWAP-guarded; their mix is not.
   - `addToken` (`:570`) changes the registry the amounts are indexed by.
3. **Adapter faults.** An adapter that under-delivers beyond rounding dust is accepted silently today.
4. **Parity.** The deposit side has a mandatory `minShares`. Exit-side minimums are standard practice: Uniswap's
   NFPM has `amount0Min` / `amount1Min`, and ERC-4626 routers bound exits. Wallets and contracts that compose
   `redeem` expect a way to bound the outcome.

## 2. Proposal

**In plain words.** Add a second `redeem` that also takes `minAmounts`. Entry `i` is the least amount of
`tokens()[i]` the caller accepts, after the performance fee. The vault computes each payout exactly as it does
today. If any payout is below its minimum, the whole transaction reverts: no shares are burned and no tokens
move. The existing two-argument `redeem` stays and behaves exactly as now. The frontend switches to the new
overload and sets the minimums from `previewRedeem` minus the user's tolerance at signing time.

**Invariants kept:**

- **K1:** No redemption is blocked by anything the redeemer did not opt into. `redeem(s, r)` is unchanged, and
  `redeem(s, r, zeros)` behaves identically to it.
- **K2:** No oracle, no TWAP read, no swap on the redeem path.
- **K3:** In-kind and pro-rata with today's rounding. Dust stays with the remaining holders, and the vault never
  over-delivers.
- **K4:** Fee-at-exit is unchanged. The minimum is compared with the **net** amount, after the fee cut.
- **K5:** Adapters and `IPositionAdapter` are untouched.
- **K6:** No storage change.

**Invariants added:**

- **A1:** If `redeem(s, r, m)` returns, then for every `i`: `amounts[i] >= m[i]`, `amounts[i]` is exactly what
  `r` received, and it equals `Redeemed.amounts[i]`.
- **A2:** If any `amounts[i] < m[i]`, the call reverts with `PoolmigoVault__InsufficientRedeemOut(token, min,
  actual)` for the first such token. The revert is atomic: shares are not burned and no adapter state changes.
- **A3:** `m.length` must equal `tokens().length` at execution, otherwise `PoolmigoVault__LengthMismatch`. A
  quote taken against an older registry fails closed.

## 3. Alternatives considered

| # | Alternative | Verdict |
|---|---|---|
| 3.1 | **Do nothing.** Section 1.2 shows no value extraction. | Rejected as the plan, kept as the fallback. The exposures in section 1.3 remain and the fix is small. If the bytecode budget (section 4.4) cannot be met, accepting this residual risk is defensible because the real severity is Low. |
| 3.2 | **Vault-side only, no adapter redeploy.** Check the aggregate net payout per token in the vault. | **Chosen.** It bounds exactly what the user receives, which is the sum across adapters plus idle minus the fee. One upgrade per proxy; adapters and positions are untouched. |
| 3.3 | **Adapter-side minimums.** Pass per-adapter, per-token minimums through `withdrawProportional` into `decreaseLiquidity`. | Rejected. It changes `IPositionAdapter`, so every adapter must be redeployed and every live position migrated (pull 100%, remove the adapter, register the new one, redeploy liquidity). Callers would have to know the vault's internal per-adapter split, which keeper actions keep changing. It also contradicts the adapters' "never block" rule. It protects nothing the aggregate check misses. |
| 3.4 | **TWAP/spot deviation check on redeem.** Revert if any pool's spot is more than X away from its TWAP. | Rejected. **(a)** The vault is oracle-free by design. Adapters would need a TWAP read on the exit path (an adapter change), and the v4 adapters have no TWAP of their own; they read a v3 reference pool. An oracle outage or short observation history would then block every redemption, breaking K1 and the adapters' stated rule that "an oracle outage can never block a redemption". **(b)** It creates a global griefing lever: anyone who pushes spot past X blocks all redemptions. **(c)** It protects against a value loss that section 1.2 shows does not exist, and does nothing about the fee changes, `forceRemoveAdapter` or registry changes in section 1.3. **(d)** X is protocol-wide and suits neither small nor large redeemers. Per-token minimums are opt-in and per transaction, use the user's own tolerance, revert only that transaction, and cover every item in section 1.3. |
| 3.5 | **One value-denominated minimum**, for example a total value in USDG. | Rejected. It needs a price, which means an oracle; same objections as 3.4 (a) and (b). |
| 3.6 | **Periphery `RedeemRouter`.** It pulls the shares, redeems to itself, checks balance deltas per token, and forwards. | Rejected as the primary design: it costs an extra approval and transfer, and anyone calling the vault directly stays unprotected. It adds zero vault bytecode, so it is the **fallback if section 4.4 cannot be met**. |
| 3.7 | **Also add a `deadline`.** | Not included. The minimums already bound the outcome, and every extra parameter costs bytecode. Can be added later as another additive overload. |

## 4. Exact changes

### 4.1 `src/interfaces/IPoolmigoVault.sol`

```solidity
/// @notice A redemption would deliver less of `token` than the caller's floor.
error PoolmigoVault__InsufficientRedeemOut(address token, uint256 minAmount, uint256 amount);

/// @notice {redeem} with a per-token floor on the NET amount delivered (registry order, `tokens()`).
function redeem(uint256 shares, address receiver, uint256[] calldata minAmounts)
    external
    returns (address[] memory tokens_, uint256[] memory amounts);
```

`redeem(uint256,address)` is unchanged: same selector, same behaviour.

### 4.2 `src/PoolmigoVaultUpgradeable.sol`

```solidity
function redeem(uint256 shares, address receiver)
    external nonReentrant returns (address[] memory, uint256[] memory)
{
    return _redeem(shares, receiver, new uint256[](0)); // no floors: today's behaviour
}

function redeem(uint256 shares, address receiver, uint256[] calldata minAmounts)
    external nonReentrant returns (address[] memory, uint256[] memory)
{
    if (minAmounts.length != _s().tokens.length) revert PoolmigoVault__LengthMismatch();
    return _redeem(shares, receiver, minAmounts);
}

/// @dev Today's `redeem` body, unchanged except for one check in the payout loop.
function _redeem(uint256 shares, address receiver, uint256[] memory minAmounts)
    private returns (address[] memory tokens_, uint256[] memory amounts)
{
    // ... existing body (:332-362) ...
    for (uint256 i; i < n; ++i) {
        uint256 out = idleOut[i] + amounts[i] - cut[i];
        if (minAmounts.length != 0 && out < minAmounts[i]) {
            revert PoolmigoVault__InsufficientRedeemOut(tokens_[i], minAmounts[i], out);
        }
        amounts[i] = out;
        if (out != 0) IERC20(tokens_[i]).safeTransfer(receiver, out);
    }
    emit Redeemed(msg.sender, receiver, shares, tokens_, amounts);
}
```

Notes:

- An empty array means "no floors" only on the internal path. The public overload requires exactly one entry
  per registry token (A3), so a caller cannot get the unprotected behaviour from the new overload by mistake.
- A revert in the middle of the loop undoes the earlier transfers, the burn, and every adapter withdrawal; the
  whole call is one transaction.
- Update the NatSpec of both overloads and of `previewRedeem` to say how floors should be derived (section 5.3).

### 4.3 Events, errors, storage

- **Events:** none added or changed. `Redeemed` already carries the net delivered amounts. The floors are in
  calldata and are not emitted.
- **Errors:** one new error, `PoolmigoVault__InsufficientRedeemOut`. Reusing `PoolmigoVault__InsufficientAmountOut`
  would save a few bytes but would not say which token failed.
- **Storage:** none. `PoolmigoVaultStorage` is untouched, so the append-only rule is not exercised.

### 4.4 Bytecode budget: a prerequisite

Measured on this branch with `forge build --sizes` (Solc 0.8.34, `optimizer_runs = 100`):

| implementation | runtime size | EIP-170 margin |
|---|---|---|
| `PoolmigoVaultUpgradeable` at `2736e67` (before PR #10) | 24,545 B | +31 B |
| `PoolmigoVaultUpgradeable` at `cb845e3` (PR #10's `swapExactIn` exact-delivery check) | 24,845 B | **−269 B** |
| `PoolmigoVaultUpgradeable` with PR #10's performance-fee bound (`_skimPerformanceFee` clamp) | 24,930 B | **−354 B** |

With PR #10 the vault is **already over the EIP-170 limit of 24,576 B**, and the overload adds an external entry point,
a wrapper and an error. This design cannot ship until room is found. Options, roughly from cheapest:

1. Move display-only views (`previewRedeem`, `previewDeposit`) into a periphery lens contract. This is an ABI
   change for readers.
2. Lower `optimizer_runs` further. `foundry.toml` already trades gas for size at 100 runs.
3. Confirm whether the target chain enforces EIP-170 (not verified here). Even if it does not, the repo's own
   rule (`foundry.toml`) is to stay under it.
4. Fall back to alternative 3.6 (periphery router), which costs zero vault bytes.

## 5. Migration

### 5.1 Proxy upgrade, not redeploy

- **Upgrade, don't redeploy.** Each live proxy is upgraded with UUPS `upgradeToAndCall(newImplementation, "")`
  from the owner multisig through the timelock. No reinitializer and no data call are needed.
- **Legacy proxies** move to a new `PoolmigoVaultUpgradeable` build; **MySun proxies** move to a new
  `MySunVaultUpgradeable` build. The code is the same.
- **Constructor argument:** `depositSplit_` is an immutable, so the new implementation must be constructed with
  the **same** `IDepositSplit` address as the current one.
- **Nothing else is redeployed:** proxies, adapters, `PoolmigoZapIn`, `PoolmigoZapOut`, `RewardFarm` and
  `PlanExecutor` stay as they are, and no position moves.
- **Rollback** is an upgrade back to the previous implementation. There is no state to migrate in either direction.

### 5.2 Storage layout

- **No storage change.** The ERC-7201 struct is untouched.
- `forge inspect PoolmigoVaultUpgradeable storageLayout --json` shows an empty layout both before and after,
  because namespaced storage is not part of that report. The authoritative check is OZ `validateUpgrade` against
  the reference build in `previous-builds/`, as `test/MySunArtifacts.t.sol` already does.

### 5.3 ABI and integration impact

- **The change is additive.** One function overload and one error are added. Old calldata keeps working.
- **viem / wagmi** resolve overloads by argument count. The frontend's existing
  `functionName: 'redeem', args: [shares, address]` call (`frontend/src/components/deposit/DepositCard.tsx:970`)
  keeps resolving to the old overload.
- **ethers v5/v6:** `contract.redeem(...)` becomes ambiguous, so integrators must use the full signature, for
  example `contract["redeem(uint256,address,uint256[])"]`.
- **Generated ABIs:** regenerate `shared/abis/PoolmigoVaultUpgradeable.json`,
  `shared/abis/MySunVaultUpgradeable.json` and `frontend/src/config/generated.ts`.
- **Frontend withdraw flow:** switch to the overload with
  `min_i = floor(preview_i × (10_000 − τ_bps) / 10_000)`, minus a dust allowance of a few raw units per adapter.
  The allowance is needed because `previewRedeem` is an upper bound: adapter flooring can make delivery fall a
  few raw units short (`src/PoolmigoVaultUpgradeable.sol:870-882`). Saturate the result at 0.
- **`PoolmigoZapOut`** is unchanged. It calls the two-argument `redeem` through its own
  `IPoolmigoZapOutVault` interface (`src/periphery/PoolmigoZapOut.sol:26`), and its `minAmountOut` already
  bounds its single-token output.
- **Indexers and event consumers** are unaffected.

### 5.4 Shipping

Ship with the **next implementation upgrade**, bundled with PR #10's `swapExactIn` exact-delivery fix and its
performance-fee bound, so there is one timelock cycle and one audit diff. Given the Low severity in section 1.2,
it does not justify an upgrade of its own. Section 4.4 has to be resolved first.

## 6. Test plan

### 6.1 Unit tests (new `test/RedeemMinAmounts.t.sol`, mock adapters as in `test/FeeAtExit.t.sol`)

| id | case | expectation |
|---|---|---|
| U1 | Equivalence fuzz over shares, holdings, fee bps and fee split: `redeem(s, r)` vs `redeem(s, r, zeros(n))` from the same snapshot | identical balances, return values and events |
| U2 | **Floor exactly at the actual output**, per token | passes |
| U3 | **Floor just above** (`actual + 1`) on one token, the other token at exactly its actual | reverts `InsufficientRedeemOut(token, actual + 1, actual)` |
| U4 | **Floor just below** (`actual − 1`) | passes, and delivers `actual` |
| U5 | Revert is atomic | receiver and treasury balances, `totalSupply`, the caller's shares and adapter positions all unchanged |
| U6 | `minAmounts.length` is `n − 1` or `n + 1`; `addToken` between quote and call | `LengthMismatch` |
| U7 | Fee interaction: the floor applies net of the cut; the owner raises `performanceFeeBps` between quote and call | reverts exactly at the computed threshold |
| U8 | `forceRemoveAdapter` lands before the redeem | reverts with floors, passes without |
| U9 | Paused, zero shares, zero receiver, insufficient shares | the existing errors, raised before the floor check |
| U10 | Floors derived from `previewRedeem` with the documented tolerance and dust allowance, quiescent state (fuzz) | always passes, so the frontend recipe is safe |

### 6.2 Adversarial tests

| id | case | expectation |
|---|---|---|
| S1 | **Sandwich simulation around redeem.** A test AMM (constant product, plus a concentrated-range variant) backs a mock adapter: the attacker front-runs to push the price, the redeem executes, the attacker back-runs to restore it. Fuzz the push size and direction, including pushes that take the range out of range. | **(a)** At the pre-attack price, the redeemer's value is at least the fair slice minus dust. **(b)** The attacker's PnL is below zero. **(c)** The remaining holders' value is at least what it was. **(d)** With floors set to `preview × (1 − τ)`, a push that skews a leg below its floor reverts the redeem, and a push within τ passes. Points (a) to (c) pin down the analysis in section 1.2. |
| S2 | **Multi-pool / multi-DEX vault.** Three tokens; a v3 adapter and a v4 adapter on the same pair, plus a third pool on another pair. Push only one pool. | Floors are checked against the aggregate across adapters plus idle minus the cut. The untouched token's floor passes and the pushed pool's token fails. Registry order is respected. |
| S3 | **Native ETH path.** A vault with `UniswapV4NativeEthAdapter`, where the basket holds WETH. | The floor applies to the WETH amount. The receiver gets WETH and never ETH. The fee is skimmed on the WETH fee leg. Floors at ±1 around the WETH output behave as in U3 and U4. |
| S4 | **Under-delivering adapter.** A mock adapter returns less than its honest slice. | The floor reverts. |
| S5 | **Reentrancy.** A basket token with a transfer callback (`test/mocks/MockBehaviorToken.sol`) tries to re-enter either overload. | Blocked by `nonReentrant` on both overloads. |

### 6.3 Fork, upgrade and size checks

- **Fork tests on the target chain:** repeat S1 to S3 against the real USDG/WETH v3 pool and the v4 native
  ETH/USDG pool. The existing NatSpec refers to `test/fork/FablesRampEthUsdg.fork.t.sol`, but that file is not
  in this repository snapshot, so fork coverage has to be (re)established.
- **Upgrade:** OZ `validateUpgrade` against `previous-builds/` (existing `test/MySunArtifacts.t.sol` pattern).
  Then upgrade a populated proxy and check that state is preserved and that both the old and new selectors work.
- **Size:** add a CI step or test that fails when either vault implementation exceeds 24,576 B (section 4.4).
  Nothing guards this today.
- **Coverage:** `PoolmigoVaultUpgradeable` line and branch coverage must not drop. The new length and floor
  branches must be covered.
