// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

/// @notice Action ids understood by the v4 PositionManager's `modifyLiquidities` (public v4-periphery action
///         encoding). Only the subset the adapter uses. Exercised end-to-end against the deployed RHC
///         PositionManager by `test/fork/UniswapV4Adapter.fork.t.sol`.
///
///         Params ABI per action:
///         - INCREASE_LIQUIDITY: abi.encode(uint256 tokenId, uint256 liquidity, uint128 amount0Max,
///                                          uint128 amount1Max, bytes hookData)
///         - DECREASE_LIQUIDITY: abi.encode(uint256 tokenId, uint256 liquidity, uint128 amount0Min,
///                                          uint128 amount1Min, bytes hookData)
///         - MINT_POSITION:      abi.encode(PoolKey, int24 tickLower, int24 tickUpper, uint256 liquidity,
///                                          uint128 amount0Max, uint128 amount1Max, address owner, bytes hookData)
///         - BURN_POSITION:      abi.encode(uint256 tokenId, uint128 amount0Min, uint128 amount1Min, bytes hookData)
///         - SETTLE_PAIR:        abi.encode(address currency0, address currency1) — pays the full debt of both
///                               currencies from the caller via Permit2
///         - TAKE_PAIR:          abi.encode(address currency0, address currency1, address recipient) — takes the
///                               full credit of both currencies
/// @dev In v4 every liquidity modification also settles the position's accrued fees into the caller's delta
///      (there is no `tokensOwed`): DECREASE_LIQUIDITY with liquidity = 0 + TAKE_PAIR = collect fees only.
library V4Actions {
    uint8 internal constant INCREASE_LIQUIDITY = 0x00;
    uint8 internal constant DECREASE_LIQUIDITY = 0x01;
    uint8 internal constant MINT_POSITION = 0x02;
    uint8 internal constant BURN_POSITION = 0x03;
    uint8 internal constant SETTLE_PAIR = 0x0d;
    uint8 internal constant TAKE_PAIR = 0x11;
}
