// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPositionAdapter} from "contracts/interfaces/IPositionAdapter.sol";

/**
 * @notice Test double for K-9: a working position adapter (holds what the vault deploys, reports its balances,
 *         withdraws pro-rata) that can be switched into a broken state where `position()` and/or
 *         `withdrawProportional` revert — e.g. a venue that bricks or a paused token inside the position.
 *         Not for production.
 */
contract BrokenPositionAdapter is IPositionAdapter {
    using SafeERC20 for IERC20;

    address public immutable vault;
    address[] private _tokens;
    bool public positionReverts;
    bool public withdrawReverts;

    error BrokenPositionAdapter__Broken();
    error BrokenPositionAdapter__OnlyVault();

    constructor(address[] memory tokens_, address vault_) {
        _tokens = tokens_;
        vault = vault_;
    }

    /// @notice Test helper: toggle the failure modes.
    function setBroken(bool position_, bool withdraw_) external {
        positionReverts = position_;
        withdrawReverts = withdraw_;
    }

    function dex() external pure returns (bytes32) {
        return bytes32("broken");
    }

    function poolId() external pure returns (bytes32) {
        return bytes32(uint256(0xdead));
    }

    function position() external view returns (address[] memory tokens, uint256[] memory amounts) {
        if (positionReverts) revert BrokenPositionAdapter__Broken();
        tokens = _tokens;
        amounts = new uint256[](tokens.length);
        for (uint256 i; i < tokens.length; ++i) {
            amounts[i] = IERC20(tokens[i]).balanceOf(address(this));
        }
    }

    function deploy(uint256[] calldata amounts) external returns (address[] memory tokens, uint256[] memory deployed) {
        if (msg.sender != vault) revert BrokenPositionAdapter__OnlyVault();
        tokens = _tokens;
        deployed = amounts;
        for (uint256 i; i < tokens.length; ++i) {
            if (amounts[i] != 0) IERC20(tokens[i]).safeTransferFrom(vault, address(this), amounts[i]);
        }
    }

    function withdrawProportional(uint256 sharesWad, address to)
        external
        returns (address[] memory tokens, uint256[] memory amounts, uint256[] memory fees)
    {
        if (msg.sender != vault) revert BrokenPositionAdapter__OnlyVault();
        if (withdrawReverts) revert BrokenPositionAdapter__Broken();
        tokens = _tokens;
        amounts = new uint256[](tokens.length);
        fees = new uint256[](tokens.length); // holds no fees
        for (uint256 i; i < tokens.length; ++i) {
            amounts[i] = Math.mulDiv(IERC20(tokens[i]).balanceOf(address(this)), sharesWad, 1e18);
            if (amounts[i] != 0) IERC20(tokens[i]).safeTransfer(to, amounts[i]);
        }
    }

    function harvest() external view returns (address[] memory tokens, uint256[] memory amounts) {
        if (msg.sender != vault) revert BrokenPositionAdapter__OnlyVault();
        tokens = _tokens;
        amounts = new uint256[](tokens.length);
    }

    function unwindAll(address to)
        external
        returns (address[] memory tokens, uint256[] memory amounts, uint256[] memory fees)
    {
        if (msg.sender != vault) revert BrokenPositionAdapter__OnlyVault();
        if (withdrawReverts) revert BrokenPositionAdapter__Broken();
        tokens = _tokens;
        amounts = new uint256[](tokens.length);
        fees = new uint256[](tokens.length); // holds no fees
        for (uint256 i; i < tokens.length; ++i) {
            amounts[i] = IERC20(tokens[i]).balanceOf(address(this));
            if (amounts[i] != 0) IERC20(tokens[i]).safeTransfer(to, amounts[i]);
        }
    }
}
