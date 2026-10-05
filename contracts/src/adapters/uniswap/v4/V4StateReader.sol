// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import {IPoolManagerMinimal} from "contracts/adapters/uniswap/v4/IPoolManagerMinimal.sol";

/// @notice Reads Uniswap v4 pool state straight out of the PoolManager's storage via `extsload` — the v4
///         PoolManager exposes no per-pool getters. Layout (pools mapping at slot 6, derived empirically on RHC —
///         notes/RHC_ADDRESSES.md):
///           state      = keccak256(abi.encodePacked(poolId, uint256(6)))
///           state + 0  = slot0            sqrtPriceX96 (160) | tick (24) | protocolFee (24) | lpFee (24)
///           state + 1  = feeGrowthGlobal0X128
///           state + 2  = feeGrowthGlobal1X128
///           state + 3  = liquidity
///           state + 4  = mapping(int24 => TickInfo)   {uint128 liquidityGross | int128 liquidityNet;
///                                                       feeGrowthOutside0X128; feeGrowthOutside1X128}
///           state + 6  = mapping(bytes32 => Position) {uint128 liquidity; feeGrowthInside0LastX128;
///                                                       feeGrowthInside1LastX128}
///         Cross-checked on the RHC fork: the fees this reader predicts equal what the PositionManager pays out.
/// @dev Written from the storage layout — no v4-core source is vendored.
library V4StateReader {
    uint256 internal constant POOLS_SLOT = 6;
    uint256 internal constant FEE_GROWTH_GLOBAL0_OFFSET = 1;
    uint256 internal constant TICKS_OFFSET = 4;
    uint256 internal constant POSITIONS_OFFSET = 6;

    /// @dev The pool's spot price and current tick. sqrtPriceX96 == 0 ⇔ the pool is not initialized.
    function getSlot0(IPoolManagerMinimal manager, bytes32 poolId)
        internal
        view
        returns (uint160 sqrtPriceX96, int24 tick)
    {
        uint256 data = uint256(manager.extsload(_stateSlot(poolId)));
        sqrtPriceX96 = uint160(data);
        tick = int24(uint24(data >> 160));
    }

    function getFeeGrowthGlobals(IPoolManagerMinimal manager, bytes32 poolId)
        internal
        view
        returns (uint256 feeGrowthGlobal0X128, uint256 feeGrowthGlobal1X128)
    {
        bytes32[] memory data = manager.extsload(bytes32(uint256(_stateSlot(poolId)) + FEE_GROWTH_GLOBAL0_OFFSET), 2);
        feeGrowthGlobal0X128 = uint256(data[0]);
        feeGrowthGlobal1X128 = uint256(data[1]);
    }

    function getTickFeeGrowthOutside(IPoolManagerMinimal manager, bytes32 poolId, int24 tick)
        internal
        view
        returns (uint256 feeGrowthOutside0X128, uint256 feeGrowthOutside1X128)
    {
        bytes32 ticksMapping = bytes32(uint256(_stateSlot(poolId)) + TICKS_OFFSET);
        bytes32 slot = keccak256(abi.encodePacked(int256(tick), ticksMapping));
        bytes32[] memory data = manager.extsload(bytes32(uint256(slot) + 1), 2);
        feeGrowthOutside0X128 = uint256(data[0]);
        feeGrowthOutside1X128 = uint256(data[1]);
    }

    /// @dev `posKey` = {positionKey}(owner, tickLower, tickUpper, salt); for PositionManager positions the owner is
    ///      the PositionManager and salt = bytes32(tokenId).
    function getPositionState(IPoolManagerMinimal manager, bytes32 poolId, bytes32 posKey)
        internal
        view
        returns (uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128)
    {
        bytes32 positionsMapping = bytes32(uint256(_stateSlot(poolId)) + POSITIONS_OFFSET);
        bytes32 slot = keccak256(abi.encodePacked(posKey, positionsMapping));
        bytes32[] memory data = manager.extsload(slot, 3);
        liquidity = uint128(uint256(data[0]));
        feeGrowthInside0LastX128 = uint256(data[1]);
        feeGrowthInside1LastX128 = uint256(data[2]);
    }

    function positionKey(address owner, int24 tickLower, int24 tickUpper, bytes32 salt)
        internal
        pure
        returns (bytes32 key)
    {
        key = keccak256(abi.encodePacked(owner, tickLower, tickUpper, salt));
    }

    function _stateSlot(bytes32 poolId) private pure returns (bytes32 slot) {
        slot = keccak256(abi.encodePacked(poolId, POOLS_SLOT));
    }
}
