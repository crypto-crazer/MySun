// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

/**
 * @title ILiquidityAdapter
 * @notice Precise-liquidity capability of a concentrated-liquidity {IPositionAdapter} (strategy layer P1,
 *         `notes/EXECUTION-PLANS.md`). The keeper sizes the operation (exact raw liquidity, absolute bounds, pull
 *         caps, swap floor); the adapter enforces the owner's range constraints and the venue guards. Every
 *         destination is hard-wired to the vault — no parameter can route funds anywhere else.
 *
 *         Token order is the adapter's `position()` order (`[token0, token1]`, pool order). Raw liquidity is the
 *         venue's own unit. No USD, no valuation.
 * @custom:security-contact security@mysun.example
 */
interface ILiquidityAdapter {
    struct AddLiquidityParams {
        int24 tickLower; // absolute, spacing-aligned, inside the adapter's constraints
        int24 tickUpper;
        uint128 liquidity; // raw target liquidity
        uint128 minLiquidity; // acceptable-actual floor (caps may bind actual below target)
        uint256 maxAmount0; // pull caps from the vault — approved, never exceeded
        uint256 maxAmount1;
        uint256 minSwapOut; // explicit floor on the internal ratio swap (stricter-of wins)
    }

    struct RemoveLiquidityParams {
        uint128 liquidity; // exact raw liquidity; 0 = idle-refund mode ONLY
        uint256 minPrincipal0; // floors apply to PRINCIPAL only — idle must never satisfy them
        uint256 minPrincipal1;
    }

    /// @notice Add up to `p.liquidity` to the position at `[p.tickLower, p.tickUpper]` (fresh mint, or increase of
    ///         the live position with the SAME bounds), pulling at most `p.maxAmount0/1` from the vault, and refund
    ///         the operation's unused amounts to the vault.
    /// @return tokenId Position id (new on a fresh mint).
    /// @return liquidityAdded Raw liquidity actually added (>= `p.minLiquidity`).
    /// @return amount0Spent Token0 added into the position.
    /// @return amount1Spent Token1 added into the position.
    /// @return amount0Refunded Token0 returned to the vault (this operation's leftover only).
    /// @return amount1Refunded Token1 returned to the vault (this operation's leftover only).
    function addLiquidity(AddLiquidityParams calldata p)
        external
        returns (
            uint256 tokenId,
            uint128 liquidityAdded,
            uint256 amount0Spent,
            uint256 amount1Spent,
            uint256 amount0Refunded,
            uint256 amount1Refunded
        );

    /// @notice `p.liquidity > 0`: remove exactly that raw liquidity, enforce the principal floors, collect the
    ///         position's fees, everything to the vault, position kept. `p.liquidity == 0`: refund the adapter's
    ///         free idle to the vault and touch nothing else.
    /// @return principal0 Token0 principal released by the removal.
    /// @return principal1 Token1 principal released by the removal.
    /// @return fees0 Token0 fees collected alongside.
    /// @return fees1 Token1 fees collected alongside.
    /// @return idleRefunded0 Token0 idle refunded (idle-refund mode only; 0 otherwise).
    /// @return idleRefunded1 Token1 idle refunded (idle-refund mode only; 0 otherwise).
    function removeLiquidity(RemoveLiquidityParams calldata p)
        external
        returns (
            uint256 principal0,
            uint256 principal1,
            uint256 fees0,
            uint256 fees1,
            uint256 idleRefunded0,
            uint256 idleRefunded1
        );

    /// @notice Live position id (0 = none). Read by the vault to tag its {removeLiquidity} event.
    /// @dev Not in the P1 shape proposal — added because the vault's `LiquidityRemoved` event carries the id and
    ///      `removeLiquidity` does not return it (see REPORT-EXECPLAN-P1.md).
    function tokenId() external view returns (uint256);

    /// @notice The owner's range constraints in one call, for keepers/planners sizing an {addLiquidity}: every range
    ///         must satisfy `minTick <= tickLower < tickUpper <= maxTick` and
    ///         `minRangeTicks <= tickUpper - tickLower <= maxRangeTicks` (bounds aligned to the venue's tick spacing).
    function rangeConstraints()
        external
        view
        returns (int24 minTick, int24 maxTick, int24 minRangeTicks, int24 maxRangeTicks);

    /// @notice The plan pin (strategy layer P3): the live position and the owner-config version in one call. With no
    ///         position the four position fields are 0; `configVersion` (starts at 1) is always the live counter and
    ///         moves on EVERY owner config change of the adapter — a plan pinned before such a change goes stale.
    function positionState()
        external
        view
        returns (uint256 tokenId, int24 tickLower, int24 tickUpper, uint128 liquidity, uint32 configVersion);
}
