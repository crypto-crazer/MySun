// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {ISwapExecutor} from "contracts/interfaces/ISwapExecutor.sol";
import {IUniversalRouter, UniversalRouterCodec} from "contracts/adapters/uniswap/IUniversalRouter.sol";
import {IPermit2Minimal} from "contracts/adapters/uniswap/v4/IPermit2Minimal.sol";
import {PoolKey} from "contracts/adapters/uniswap/v4/IPoolManagerMinimal.sol";

/**
 * @title UniversalRouterSwapExecutor
 * @author MySun
 * @notice The UniversalRouter / Permit2 swap machinery the Uniswap adapters used to carry inline, extracted into ONE
 *         shared contract (strategy layer P1c — EIP-170 budget). Single-hop exact-input swaps through the official
 *         Uniswap UniversalRouter (2.1.x): `V3_SWAP_EXACT_IN` ({swapV3ExactIn}) or `V4_SWAP` = SWAP_EXACT_IN_SINGLE +
 *         SETTLE + TAKE ({swapV4ExactIn}). The executor sits in the seat the adapter used to occupy:
 *         1. pulls exactly `amountIn` from `msg.sender` (callers approve exactly `amountIn`, then reset to 0);
 *         2. ERC-20 allowance to Permit2 and Permit2 allowance to the router, both exactly `amountIn` (the latter
 *            expiring this block);
 *         3. `execute` with recipient = `msg.sender`; the router's min-out revert (`V3TooLittleReceived` /
 *            `V4TooLittleReceived`) is surfaced as `SwapExecutor__SlippageExceeded`, any other revert bubbles raw;
 *         4. both allowance layers back to 0;
 *         5. `msg.sender`'s `tokenOut` balance delta is re-checked against `minOut` and returned.
 *
 *         Permissionless-safe by construction — no allowlist needed: the only tokens that ever move are the
 *         caller's own `amountIn`, the output goes back to the caller (no recipient parameter), nothing is held at
 *         rest (the router pulls the whole input through Permit2 in the same call), and no allowance survives a
 *         call. A third party calling it can only swap its own tokens to itself. Stateless: immutables only — no
 *         owner, no storage, no pause, nothing to upgrade. Price guards (TWAP, spot deviation, sizing) are the
 *         CALLER's job: this contract enforces only the caller's non-zero `minOut`.
 *
 *         Venue: `fee` / `key` are caller-supplied; the router derives the v3 pool as CREATE2(its v3 factory,
 *         tokens, fee) and trades v4 on its own PoolManager. The adapters validate at construction that the
 *         executor's router is wired to their venue.
 *
 * @dev Not audited.
 * @custom:security-contact security@mysun.example
 */
contract UniversalRouterSwapExecutor is ISwapExecutor, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    /// @inheritdoc ISwapExecutor
    address public immutable UNIVERSAL_ROUTER;
    /// @inheritdoc ISwapExecutor
    address public immutable PERMIT2;

    /// @dev Router and Permit2 must be non-zero and have code. The router's venue wiring is checked by each caller
    ///      (the adapters compare it against their own validated router).
    constructor(address universalRouter, address permit2) {
        if (universalRouter == address(0) || permit2 == address(0)) {
            revert SwapExecutor__ZeroAddress();
        }
        if (universalRouter.code.length == 0) {
            revert SwapExecutor__NoCode(universalRouter);
        }
        if (permit2.code.length == 0) {
            revert SwapExecutor__NoCode(permit2);
        }
        UNIVERSAL_ROUTER = universalRouter;
        PERMIT2 = permit2;
    }

    /// @inheritdoc ISwapExecutor
    function swapV3ExactIn(address tokenIn, uint24 fee, address tokenOut, uint256 amountIn, uint256 minOut)
        external
        nonReentrant
        returns (uint256 amountOut)
    {
        (bytes memory commands, bytes[] memory inputs) =
            UniversalRouterCodec.v3ExactInSingle(msg.sender, amountIn, minOut, tokenIn, fee, tokenOut);
        amountOut = _swap(tokenIn, tokenOut, amountIn, minOut, commands, inputs);
    }

    /// @inheritdoc ISwapExecutor
    function swapV4ExactIn(PoolKey calldata key, bool zeroForOne, uint256 amountIn, uint256 minOut)
        external
        nonReentrant
        returns (uint256 amountOut)
    {
        (address tokenIn, address tokenOut) =
            zeroForOne ? (key.currency0, key.currency1) : (key.currency1, key.currency0);
        (bytes memory commands, bytes[] memory inputs) = UniversalRouterCodec.v4ExactInSingle(
            key, zeroForOne, SafeCast.toUint128(amountIn), SafeCast.toUint128(minOut), msg.sender
        );
        amountOut = _swap(tokenIn, tokenOut, amountIn, minOut, commands, inputs);
    }

    /// @dev The shared flow (see the contract NatSpec). `outBefore` is read after the pull, so the delta is the
    ///      router's delivery only.
    function _swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        bytes memory commands,
        bytes[] memory inputs
    ) internal returns (uint256 amountOut) {
        if (amountIn == 0) {
            revert SwapExecutor__ZeroAmount();
        }
        if (minOut == 0) {
            revert SwapExecutor__ZeroMinOut();
        }
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        uint256 outBefore = IERC20(tokenOut).balanceOf(msg.sender);

        IERC20(tokenIn).forceApprove(PERMIT2, amountIn);
        IPermit2Minimal(PERMIT2)
            .approve(tokenIn, UNIVERSAL_ROUTER, SafeCast.toUint160(amountIn), uint48(block.timestamp));
        try IUniversalRouter(UNIVERSAL_ROUTER).execute(commands, inputs, block.timestamp) {}
        catch (bytes memory reason) {
            if (UniversalRouterCodec.isTooLittleReceived(reason)) {
                revert SwapExecutor__SlippageExceeded(tokenIn, amountIn, minOut);
            }
            assembly ("memory-safe") {
                revert(add(reason, 0x20), mload(reason))
            }
        }
        // Never leave a standing allowance: both layers back to 0.
        IPermit2Minimal(PERMIT2).approve(tokenIn, UNIVERSAL_ROUTER, 0, 0);
        IERC20(tokenIn).forceApprove(PERMIT2, 0);

        amountOut = IERC20(tokenOut).balanceOf(msg.sender) - outBefore;
        if (amountOut < minOut) {
            revert SwapExecutor__SlippageExceeded(tokenIn, amountIn, minOut);
        }
        emit SwapExecuted(msg.sender, tokenIn, tokenOut, amountIn, amountOut);
    }
}
