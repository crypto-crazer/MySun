// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import {PoolKey} from "contracts/adapters/uniswap/v4/IPoolManagerMinimal.sol";

/// @notice Minimal subset of the Uniswap UniversalRouter ABI, written from the source of the DEPLOYED version:
///         `Uniswap/universal-router` tag `2.1.2` (commit 802fe4c; v4-periphery pinned at 545a5d2). Official RHC
///         instance 0x204FAca1764B154221e35c0d20aBb3c525710498 (`deploy-addresses/robinhood.json`); its getters below
///         were checked with `cast` against RHC (poolManager / V3_POSITION_MANAGER / V4_POSITION_MANAGER = the RHC
///         singletons). NEVER 0x66a9…A8Af on RHC: a byte-for-byte copy of the MAINNET router, wired to mainnet
///         immutables (its PoolManager / v3 factory / WETH9 have no code on RHC; its getters return the mainnet
///         addresses — the adapters' constructor wiring checks reject it).
/// @dev Written from the public ABI — no universal-router source is vendored.
interface IUniversalRouter {
    /// @dev UniversalRouter.execute: wraps the revert of a `.call`-style command only (permits, position-manager
    ///      calls, sub-plans). V3_SWAP_EXACT_IN and V4_SWAP are executed inline, so their errors bubble up raw.
    error ExecutionFailed(uint256 commandIndex, bytes message);
    /// @dev V3SwapRouter.v3SwapExactInput: final output below `amountOutMin` (selector 0x39d35496).
    error V3TooLittleReceived();
    /// @dev IV4Router: SWAP_EXACT_IN_SINGLE output below `amountOutMinimum` (selector 0x8b063d73).
    error V4TooLittleReceived(uint256 minAmountOutReceived, uint256 amountReceived);

    /// @dev selector 0x3593564c. `commands[i]` is one command byte, `inputs[i]` its ABI-encoded input. Reverts
    ///      `TransactionDeadlinePassed()` only when `block.timestamp > deadline`, so an in-tx caller passes
    ///      `block.timestamp`.
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;

    /// @dev v4-periphery ImmutableState — the PoolManager V4_SWAP trades on.
    function poolManager() external view returns (address);

    /// @dev MigratorImmutables — the v3 NFPM this router was deployed with (its `factory()` anchors the router
    ///      to a v3 deployment: 2.1.x exposes no `factory()` of its own).
    function V3_POSITION_MANAGER() external view returns (address);
}

/// @notice UniversalRouter command bytes (`contracts/libraries/Commands.sol` @ 2.1.2). The high bit
///         (FLAG_ALLOW_REVERT = 0x80) is never set: every command must succeed.
library URCommands {
    bytes1 internal constant V3_SWAP_EXACT_IN = 0x00;
    bytes1 internal constant V4_SWAP = 0x10;
}

/// @notice ABI of v4-periphery `IV4Router.ExactInputSingleParams` @ 545a5d2 (the SWAP_EXACT_IN_SINGLE params).
///         `minHopPriceX36` = 0 disables the per-hop price check; `amountIn` = 0 would mean "open delta" (never
///         used here: amounts are always explicit).
struct V4ExactInputSingleParams {
    PoolKey poolKey;
    bool zeroForOne;
    uint128 amountIn;
    uint128 amountOutMinimum;
    uint256 minHopPriceX36;
    bytes hookData;
}

/// @notice Encodes the two single-hop exact-input swaps the adapters send through the UniversalRouter. Payer is
///         always the caller (`payerIsUser` = true → Permit2 `transferFrom(caller, …)` with the router as spender),
///         and the output recipient is always an explicit address chosen by the caller (the adapter itself).
library UniversalRouterCodec {
    /// @dev v4 action ids (v4-periphery `Actions.sol` @ 545a5d2) — the V4_SWAP subset.
    uint8 internal constant SWAP_EXACT_IN_SINGLE = 0x06;
    uint8 internal constant SETTLE = 0x0b;
    uint8 internal constant TAKE = 0x0e;
    /// @dev ActionConstants.OPEN_DELTA: for TAKE, "the full credit" of the currency.
    uint256 internal constant OPEN_DELTA = 0;

    /// @dev One V3_SWAP_EXACT_IN through the single v3 pool (tokenIn, fee, tokenOut). Input layout (Dispatcher @
    ///      2.1.2): abi.encode(address recipient, uint256 amountIn, uint256 amountOutMin, bytes path,
    ///      bool payerIsUser, uint256[] minHopPriceX36) — the 6th field is new in 2.1.x and MUST be present (the
    ///      decoder bounds-checks it); empty = no per-hop check. path = abi.encodePacked(tokenIn, uint24 fee,
    ///      tokenOut). The router derives the pool as CREATE2(its v3 factory, tokens, fee).
    function v3ExactInSingle(
        address recipient,
        uint256 amountIn,
        uint256 amountOutMin,
        address tokenIn,
        uint24 fee,
        address tokenOut
    ) internal pure returns (bytes memory commands, bytes[] memory inputs) {
        commands = abi.encodePacked(URCommands.V3_SWAP_EXACT_IN);
        inputs = new bytes[](1);
        inputs[0] = abi.encode(
            recipient, amountIn, amountOutMin, abi.encodePacked(tokenIn, fee, tokenOut), true, new uint256[](0)
        );
    }

    /// @dev One V4_SWAP = abi.encode(bytes actions, bytes[] params) (BaseActionsRouter strict encoding) with
    ///      actions = [SWAP_EXACT_IN_SINGLE, SETTLE, TAKE]:
    ///      - SWAP_EXACT_IN_SINGLE: abi.encode(V4ExactInputSingleParams) — reverts V4TooLittleReceived below min;
    ///      - SETTLE: abi.encode(currencyIn, amountIn, true) — pays exactly amountIn from the caller via Permit2;
    ///      - TAKE: abi.encode(currencyOut, recipient, OPEN_DELTA) — the whole output to `recipient`.
    function v4ExactInSingle(
        PoolKey memory key,
        bool zeroForOne,
        uint128 amountIn,
        uint128 amountOutMin,
        address recipient
    ) internal pure returns (bytes memory commands, bytes[] memory inputs) {
        (address currencyIn, address currencyOut) =
            zeroForOne ? (key.currency0, key.currency1) : (key.currency1, key.currency0);
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            V4ExactInputSingleParams({
                poolKey: key,
                zeroForOne: zeroForOne,
                amountIn: amountIn,
                amountOutMinimum: amountOutMin,
                minHopPriceX36: 0,
                hookData: bytes("")
            })
        );
        params[1] = abi.encode(currencyIn, uint256(amountIn), true);
        params[2] = abi.encode(currencyOut, recipient, OPEN_DELTA);
        commands = abi.encodePacked(URCommands.V4_SWAP);
        inputs = new bytes[](1);
        inputs[0] = abi.encode(abi.encodePacked(SWAP_EXACT_IN_SINGLE, SETTLE, TAKE), params);
    }

    /// @dev True if `reason` is the router's min-out failure for either swap kind (raw — see ExecutionFailed).
    function isTooLittleReceived(bytes memory reason) internal pure returns (bool) {
        if (reason.length < 4) {
            return false;
        }
        bytes4 selector = bytes4(reason);
        return selector == IUniversalRouter.V3TooLittleReceived.selector
            || selector == IUniversalRouter.V4TooLittleReceived.selector;
    }
}
