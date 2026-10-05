// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.34;

/**
 * @title IPositionAdapter
 * @notice Uniform interface the vault uses to operate ONE LP position on ONE pool of ONE DEX.
 *         The vault holds a set of these (see registry in PoolmigoVaultUpgradeable), so it spans
 *         MULTIPLE DEXs and MULTIPLE pools simultaneously.
 *
 *         Adapters speak TOKEN VECTORS (parallel `tokens` / `amounts` arrays), never USD scalars.
 *         Token balances are the ground truth for share accounting; no oracle is load-bearing here.
 *         `position()` reports the venue's state at SPOT (2026-09-22 read-choice decision — a
 *         manipulated or lagged read can only over-price a depositor; `deposit` enforces a non-zero
 *         `minShares`). Price guards live INSIDE adapters only where they still swap (deploy
 *         ratio-adjustment, rebalance).
 * @custom:security-contact security@mysun.example
 */
interface IPositionAdapter {
    function dex() external view returns (bytes32);
    function poolId() external view returns (bytes32);

    /// @notice token→amount map of the extractable value this adapter controls: idle + principal + uncollected
    ///         fees NET of the vault's performance fee (fee-at-exit: skimmed whenever fees leave a position).
    ///         Parallel arrays, index-aligned; token order is stable per adapter.
    function position() external view returns (address[] memory tokens, uint256[] memory amounts);

    /// @notice Pull `amounts[i]` of position-token[i] from the vault (approve-pull; the vault
    ///         forceApproves first) and deploy into the position. amounts is aligned to the
    ///         current position() token order.
    function deploy(uint256[] calldata amounts) external returns (address[] memory tokens, uint256[] memory deployed);

    /// @notice Send floor(sharesWad/1e18) of everything this adapter holds, in kind, to `to`.
    /// @dev `sharesWad` is a 1e18-scaled fraction in (0, 1e18]; the vault passes floor(shares * 1e18 / supply)
    ///      on redeem and sharesBps * 1e14 on `pullFrom`. 1e18 = everything (the position is closed).
    ///      `fees[i]` = the accrued position fees included in `amounts[i]` (index-aligned with `tokens`), floor-
    ///      conservative (never over-reported) and `fees[i] <= amounts[i]`. Adapters only REPORT the split; the
    ///      vault skims its performance fee on it (fee policy is the vault's).
    function withdrawProportional(uint256 sharesWad, address to)
        external
        returns (address[] memory tokens, uint256[] memory amounts, uint256[] memory fees);

    /// @notice Collect fees/rewards and send them in kind to the vault; return what was sent (all of it is fees).
    function harvest() external returns (address[] memory tokens, uint256[] memory amounts);

    /// @notice Unwind this entire position in kind to `to` (emergency).
    /// @dev `fees` as in {withdrawProportional}: the accrued fees included in `amounts`, `fees[i] <= amounts[i]`.
    function unwindAll(address to)
        external
        returns (address[] memory tokens, uint256[] memory amounts, uint256[] memory fees);
}
