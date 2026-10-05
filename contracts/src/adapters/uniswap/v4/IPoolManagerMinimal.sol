// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

/// @notice Uniswap v4 pool identifier (the `PoolKey` of the v4 ABI). `Currency` is an address-typed value in
///         the ABI, so it encodes identically to `address`. poolId = keccak256(abi.encode(key)).
/// @dev Written from the public ABI — no v4-core source is vendored (v4-core is BUSL-1.1).
struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

/// @notice Minimal subset of the Uniswap v4 PoolManager ABI. Selectors verified with `cast` against the
///         deployed RHC singleton 0x8366a39CC670B4001A1121B8F6A443A643e40951 (notes/RHC_ADDRESSES.md).
///         The adapter only reads state (`extsload`); the unlock/swap/settle surface serves test traders.
interface IPoolManagerMinimal {
    /// @dev ABI of the v4 `SwapParams` (amountSpecified < 0 = exact input).
    struct SwapParams {
        bool zeroForOne;
        int256 amountSpecified;
        uint160 sqrtPriceLimitX96;
    }

    /// @dev selector 0x1e2eaeaf
    function extsload(bytes32 slot) external view returns (bytes32 value);

    /// @dev selector 0x35fd631a
    function extsload(bytes32 startSlot, uint256 nSlots) external view returns (bytes32[] memory values);

    /// @dev selector 0x48c89491
    function unlock(bytes calldata data) external returns (bytes memory result);

    /// @dev selector 0xf3cd914c. Returns a packed `BalanceDelta`: amount0 in the high 128 bits, amount1 low.
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData)
        external
        returns (int256 swapDelta);

    /// @dev selector 0xa5841194
    function sync(address currency) external;

    /// @dev selector 0x11da60b4
    function settle() external payable returns (uint256 paid);

    /// @dev selector 0x0b0d9c09
    function take(address currency, address to, uint256 amount) external;
}

/// @notice Callback the PoolManager invokes on the `unlock` caller.
interface IUnlockCallback {
    function unlockCallback(bytes calldata data) external returns (bytes memory result);
}
