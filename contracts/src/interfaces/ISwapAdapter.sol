// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

/**
 * @title ISwapAdapter
 * @notice Swap capability of a {IPositionAdapter} (strategy layer P3, `notes/EXECUTION-PLANS.md`): the vault hands the
 *         adapter exactly `amountIn` of its free idle (force-approve, adapter pulls), the adapter swaps it through its
 *         own guarded venue path and returns the FULL output to the vault. Nothing is parked in the adapter; the
 *         destination is hard-wired to the vault (`msg.sender`). Raw token units only — no USD, no valuation.
 * @custom:security-contact security@mysun.example
 */
interface ISwapAdapter {
    struct SwapParams {
        address tokenIn; // one of the adapter's two tokens
        address tokenOut; // the other one
        uint256 amountIn; // exact input pulled from the vault (> 0)
        uint256 minAmountOut; // caller floor — the stricter of it and the adapter's own TWAP floor is enforced
    }

    /// @notice Swap exactly `p.amountIn` of `p.tokenIn` (pulled from the vault) for `p.tokenOut`, output to the vault.
    /// @return amountOut Output delivered to the vault (>= the effective floor).
    function swapExactIn(SwapParams calldata p) external returns (uint256 amountOut);
}
