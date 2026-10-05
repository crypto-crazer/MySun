# Events reference

Every event the MySun contracts **themselves** define, for indexers, dashboards and integrators. New deployments
ship the MySun-named contracts (`MySunVaultUpgradeable`, `MySunZapIn`, `MySunZapOut`) — thin wrappers that
inherit everything from the pre-rebrand `Poolmigo*` implementations earlier deployments run, where the events are
declared. Event signatures do not include contract names, so topics are identical for both generations.
Standard events inherited from OpenZeppelin are not listed: ERC-20 `Transfer` / `Approval` on the
receipt token, `Upgraded` on UUPS upgrades, and `OwnershipTransferStarted` / `OwnershipTransferred`
(ownership here is always `Ownable2Step`). Sources: `contracts/src/`.

Vector-valued arguments (`tokens[]`, `amounts[]`, `harvested[]`, `fees[]`) are in **registry order** —
the vault's basket order — and parallel to each other.

## Vault — `MySunVaultUpgradeable` (earlier deployments: `PoolmigoVaultUpgradeable`)

(Declared in `IPoolmigoVault.sol`.)

- **`TokenAdded(address indexed token)`** — one per basket token, as the registry is populated at
  initialization.
- **`Deposited(address indexed sender, address indexed receiver, address[] tokens, uint256[] amounts,
  uint256 shares)`** — an in-kind deposit; `amounts` is what was actually pulled and `shares` what was
  minted (an ordinary deposit or the owner-gated genesis).
- **`Redeemed(address indexed sender, address indexed receiver, uint256 shares, address[] tokens,
  uint256[] amounts)`** — an in-kind redemption; `amounts` is what was paid out.
- **`Deployed(address indexed keeper, address indexed adapter, address[] tokens, uint256[] amounts)`** —
  keeper `deployTo`: capital sent vault → adapter.
- **`PulledFrom(address indexed keeper, address indexed adapter, uint256 sharesBps, address[] tokens,
  uint256[] amounts)`** — keeper `pullFrom`: `amounts` received adapter → vault (`sharesBps` = the
  fraction requested).
- **`Rebalanced(address indexed keeper, address[] tokens, uint256[] harvested, uint256[] fees)`** — one
  per keeper `rebalance`: gross harvested fees/rewards versus the performance-fee slice taken from them.
- **`LiquidityAdded(address indexed keeper, address indexed adapter, uint256 indexed tokenId, uint128
  liquidityAdded, uint256 spent0, uint256 spent1, uint256 refunded0, uint256 refunded1)`** — keeper
  `addLiquidity`: an exact-liquidity add through the adapter; `spent` = what the venue took, `refunded` =
  the unused part of this call's pull (returned to the vault).
- **`LiquidityRemoved(address indexed keeper, address indexed adapter, uint256 indexed tokenId, uint128
  liquidity, uint256 principal0, uint256 principal1, uint256 fees0, uint256 fees1, uint256 idleRefunded0,
  uint256 idleRefunded1)`** — keeper `removeLiquidity`: principal and fees reported apart (fees never
  satisfy a floor and are never principal); with `liquidity = 0` it is the idle-refund mode
  (`idleRefunded` only).
- **`PerformanceFeeAccrued(address indexed treasury, address[] tokens, uint256[] fees)`** — the fee slice
  set aside for the treasury during a rebalance (in kind, never on principal).
- **`SwapSettled(address indexed adapter, address indexed tokenIn, address indexed tokenOut, uint256
  amountIn, uint256 amountOut)`** — keeper `swapExactIn`: vault idle swapped through the adapter's guarded
  venue path (the adapter emits its own `Swapped`, the shared executor `SwapExecuted`); the output settles
  back into the vault.
- **`EmergencyUnwound(address indexed caller, address[] tokens, uint256[] amounts)`** — owner or risk
  manager `emergencyUnwind`: everything pulled back in kind; rebalances are left paused (see
  `PausedSet`).
- **`AdapterAdded(address indexed adapter, bytes32 indexed dex, bytes32 indexed poolId)`** — registry
  add; `dex` / `poolId` are read from the adapter's own report.
- **`AdapterCapabilitySet(address indexed adapter, uint8 capabilities)`** — the adapter's capability mask
  (bit 0 `CAP_LIQUIDITY`, bit 1 `CAP_SWAP`) after a change: derived from the adapter's own ERC-165 answers
  at `addAdapter` (the owner can narrow, never fake, a bit) or owner-toggled via `setAdapterCapability`.
- **`AdapterRemoved(address indexed adapter)`** — graceful removal (position must be empty).
- **`AdapterForceRemoved(address indexed adapter)`** — recovery removal that does not call the adapter;
  whatever assets it still holds stay in it.
- **`KeeperSet(address indexed keeper, bool allowed)`** — keeper whitelist flipped.
- **`RiskManagerSet(address indexed manager, bool allowed)`** — risk-manager whitelist flipped (fast-reaction
  role: one-way `pause()` + `emergencyUnwind()` only — never unpause, never funds).
- **`TreasurySet(address indexed oldTreasury, address indexed newTreasury)`**.
- **`PerformanceFeeSet(uint16 oldBps, uint16 newBps)`**.
- **`PausedSet(bool paused)`** — the vault-wide pause switch (a full safety freeze: deposits,
  redemptions, deploys and rebalances all stop; unpausing is owner-only). Emitted by `setPaused`,
  the one-way `pause()` (owner or a risk manager), and `emergencyUnwind`.
- **`MaxTotalSupplySet(uint256 oldCap, uint256 newCap)`** — supply cap changed; also emitted at
  initialization (with `oldCap = 0`).

## Venue adapters — `UniswapV3Adapter` / `UniswapV4Adapter`

Same name and shape in both unless noted; the v4 differences are called out below the shared list.

- **`RangeSet(int24 ticksBelow, int24 ticksAbove)`** — owner: fresh-range width around the TWAP tick.
- **`TwapWindowSet(uint32 oldWindow, uint32 newWindow)`** — owner: the reference TWAP window.
- **`MaxSlippageSet(uint16 oldBps, uint16 newBps)`** — owner: the deploy-time swap guard.
- **`PositionMinted(uint256 indexed tokenId, int24 tickLower, int24 tickUpper)`** — one per LP position
  the adapter mints on the venue.
- **`PositionBurned(uint256 indexed tokenId)`** — one per existing position it burns (range redeploy or
  unwind).
- **`Swapped(address indexed tokenIn, uint256 amountIn, uint256 amountOut, uint256 minAmountOut)`** —
  every venue swap — deploy/add-time ratio swaps and the vault-funded `swapExactIn` alike; v4 adds the
  venue: **`…, SwapVenue venue)`**.
- **`LiquidityDeployed(uint256 pulled0, uint256 pulled1, uint256 used0, uint256 used1, uint128
  liquidity)`** — `pulled` = what came from the vault, `used` = what the venue actually took (the
  residue returns to the vault), `liquidity` = units minted.
- **`Withdrawn(address indexed to, uint256 sharesWad, uint256 amount0, uint256 amount1)`** —
  proportional withdraw back to the vault.
- **`Harvested(uint256 amount0, uint256 amount1)`** — fees/rewards collected by `harvest`.
- **`Unwound(address indexed to, uint256 amount0, uint256 amount1)`** — full position exit.
- **`RangeConstraintsSet(int24 minTick, int24 maxTick, int24 minRangeTicks, int24 maxRangeTicks)`** —
  owner: the tick box and width bounds every `addLiquidity` range must satisfy.
- **`LiquidityAdded(uint256 indexed tokenId, uint128 liquidity, uint256 spent0, uint256 spent1, uint256
  refunded0, uint256 refunded1)`** — an exact-liquidity add by the vault (`spent` post-swap, `refunded` =
  this call's leftover sent back to the vault).
- **`LiquidityRemoved(uint256 indexed tokenId, uint128 liquidity, uint256 principal0, uint256 principal1,
  uint256 fees0, uint256 fees1)`** — an exact-liquidity removal by the vault; v4 reports the whole fee bank
  as `fees` (banked fees are never principal).
- **`IdleRefunded(uint256 amount0, uint256 amount1)`** — idle-refund mode: the free idle sent back to the
  vault (v4 leaves the fee bank in place for `harvest`).

v4-only:

- **`FeesBanked(uint256 amount0, uint256 amount1)`** — vouchers banked while position liquidity changes;
  banked fees are not principal until settled.
- **`SwapVenueSet(SwapVenue oldVenue, SwapVenue newVenue)`** — owner venue switch
  (`V3_REF_POOL` ↔ `V4_POOL`); also emitted at construction stating the default.

## Swap executor — `UniversalRouterSwapExecutor`

(Declared in `ISwapExecutor.sol`.)

- **`SwapExecuted(address indexed caller, address indexed tokenIn, address indexed tokenOut, uint256
  amountIn, uint256 amountOut)`** — one per exact-input swap executed for the caller (the adapters). The
  executor is permissionless and stateless: it moves only the caller's own tokens and returns the output
  to the caller, so it holds no funds and no approvals between calls.

## Plan executor — `PlanExecutor` (strategy layer)

- **`PlanExecuted(bytes32 indexed planId, address indexed keeper, uint256 nonce)`** — one per successful
  `executePlan`; `planId = keccak256(abi.encode(plan))` (the component list), `nonce` the caller's consumed
  plan nonce (per keeper, strictly sequential).
- **`KeeperSet(address indexed keeper, bool allowed)`** — the executor's **own** caller whitelist (distinct
  from the vault's keeper set of the same name): only these addresses may call `executePlan`, and the
  executor itself must additionally be one of the vault's keepers for the components to land.

## Zap periphery — `MySunZapIn` / `MySunZapOut` (earlier deployments: `PoolmigoZapIn` / `PoolmigoZapOut`)

Both:

- **`VaultRegistered(address indexed vault)`** / **`VaultDisabled(address indexed vault)`** — owner
  registry of the vaults the zap may serve.
- **`RouteSet(address indexed tokenIn, address indexed tokenOut, address indexed refPool, uint24
  swapFee, uint16 twapWindow, uint16 maxSlippageBps, uint16 maxDeviationBps)`** — owner route (swap
  venue + guard parameters) set or updated.

Zap-in only:

- **`ZapDeposited(address indexed caller, address indexed vault, address indexed tokenIn, uint256
  amountIn, uint256 shares, address receiver)`** — a one-token deposit: swapped, deposited, shares to
  `receiver`.
- **`ZapRefunded(address indexed caller, address indexed token, uint256 amount)`** — dust returned to
  the caller (valuation residue of the exact pull).

Zap-out only:

- **`ZapRedeemed(address indexed caller, address indexed vault, address indexed tokenOut, uint256
  shares, uint256 amountOut, address receiver, uint256[] redeemed)`** — a one-token exit; `redeemed` is
  the in-kind payout the vault reported (reporting only — the sales are sized on the zap's measured
  balance deltas).
- **`ZapSold(address indexed caller, address indexed tokenIn, address indexed tokenOut, uint256
  amountIn, uint256 amountOut)`** — one per swapped leg.
- **`ZapPassThrough(address indexed caller, address indexed token, uint256 amount)`** — that amount is
  delivered in kind, without a swap (no route, or below the dust-sale threshold).

## Upgrade example — `PoolmigoVaultUpgradeExample`

- **`MinRebalanceIntervalSet(uint64 interval)`** — the example upgrade's added parameter; re-emitted on
  change.
