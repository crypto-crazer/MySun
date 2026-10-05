// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import {PoolKey} from "contracts/adapters/uniswap/v4/IPoolManagerMinimal.sol";

/// @notice Minimal subset of the Uniswap v4 PositionManager ABI. Selectors verified with `cast` against the
///         deployed RHC instance 0x58daec3116aae6D93017bAAea7749052E8a04fA7 (notes/RHC_ADDRESSES.md).
///
///         Positions are ERC721s ("Uniswap v4 Positions NFT"). Every liquidity operation goes through
///         {modifyLiquidities}, whose payload is `abi.encode(bytes actions, bytes[] params)` — one action byte
///         (see {V4Actions}) per params entry.
/// @dev Written from the public ABI — no v4-periphery source is vendored.
interface IPositionManagerMinimal {
    /// @dev selector 0xdd46508f. Reverts if `block.timestamp > deadline`.
    function modifyLiquidities(bytes calldata unlockData, uint256 deadline) external payable;

    /// @dev selector 0x75794a3c. The id the NEXT `MINT_POSITION` receives.
    function nextTokenId() external view returns (uint256 id);

    /// @dev selector 0x1efeed33
    function getPositionLiquidity(uint256 tokenId) external view returns (uint128 liquidity);

    /// @dev selector 0x7ba03aad. `info` packs poolId(bytes25) | tickUpper(24) | tickLower(24) | hasSubscriber(8).
    function getPoolAndPositionInfo(uint256 tokenId) external view returns (PoolKey memory key, uint256 info);

    /// @dev selector 0x70a08231 (ERC721)
    function balanceOf(address owner) external view returns (uint256 balance);

    /// @dev selector 0x6352211e (ERC721)
    function ownerOf(uint256 tokenId) external view returns (address owner);

    /// @dev selector 0xdc4c90d3
    function poolManager() external view returns (address manager);

    /// @dev selector 0x12261ee7
    function permit2() external view returns (address permit2_);
}
