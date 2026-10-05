// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import {PoolKey} from "contracts/adapters/uniswap/v4/IPoolManagerMinimal.sol";

/**
 * @title ISwapExecutor
 * @notice Stateless single-hop exact-input swap service (strategy layer P1c, `notes/EXECUTION-PLANS.md`). The caller
 *         approves EXACTLY `amountIn` of the input token to the executor; the executor pulls it from the caller,
 *         swaps it, and the output lands directly in the CALLER's balance. Nothing else can be moved: every token
 *         flow is the caller's own, there is no recipient parameter, and nothing is held at rest. Raw token units
 *         only — no USD, no valuation.
 * @custom:security-contact security@mysun.example
 */
interface ISwapExecutor {
    /// @dev `amountIn == 0`.
    error SwapExecutor__ZeroAmount();
    /// @dev `minOut == 0` — an unbounded swap is never executed.
    error SwapExecutor__ZeroMinOut();
    /// @dev Constructor: a zero router / Permit2 address.
    error SwapExecutor__ZeroAddress();
    /// @dev Constructor: router / Permit2 without code.
    error SwapExecutor__NoCode(address account);
    /// @dev The venue's min-out check failed, or the caller's `tokenOut` balance grew by less than `minOut`.
    error SwapExecutor__SlippageExceeded(address tokenIn, uint256 amountIn, uint256 minAmountOut);

    /// @notice One executed swap: `caller` paid `amountIn` of `tokenIn` and received `amountOut` of `tokenOut`.
    event SwapExecuted(
        address indexed caller, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut
    );

    /// @notice The Uniswap UniversalRouter every swap executes through (immutable).
    function UNIVERSAL_ROUTER() external view returns (address);

    /// @notice The Permit2 the router pulls the swap input through (immutable).
    function PERMIT2() external view returns (address);

    /// @notice Swap exactly `amountIn` of `tokenIn` for at least `minOut` of `tokenOut` through the v3 pool
    ///         (tokenIn, fee, tokenOut) of the router's v3 factory; output to the caller.
    /// @param tokenIn Input token, pulled from the caller (`transferFrom` of exactly `amountIn`).
    /// @param fee v3 fee tier of the pool to trade on.
    /// @param tokenOut Output token, delivered to the caller.
    /// @param amountIn Exact input (> 0).
    /// @param minOut Output floor (> 0).
    /// @return amountOut The caller's `tokenOut` balance increase (>= `minOut`).
    function swapV3ExactIn(address tokenIn, uint24 fee, address tokenOut, uint256 amountIn, uint256 minOut)
        external
        returns (uint256 amountOut);

    /// @notice Swap exactly `amountIn` of the input currency of `key` (currency0 when `zeroForOne`) for at least
    ///         `minOut` of the other one through the v4 pool `key` on the router's PoolManager; output to the caller.
    ///         ERC-20 currencies only.
    /// @param key The v4 pool (any hooks are the caller's own choice).
    /// @param zeroForOne Direction: currency0 → currency1.
    /// @param amountIn Exact input (> 0, <= uint128 max), pulled from the caller.
    /// @param minOut Output floor (> 0, <= uint128 max).
    /// @return amountOut The caller's output-currency balance increase (>= `minOut`).
    function swapV4ExactIn(PoolKey calldata key, bool zeroForOne, uint256 amountIn, uint256 minOut)
        external
        returns (uint256 amountOut);
}
