// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MockSwapAdapter} from "test/mocks/MockSwapAdapter.sol";

/**
 * @notice {MockSwapAdapter} whose `addLiquidity` moves tokens the way the real adapters size it: it pulls both caps,
 *         takes `avail = pull` (the nominal amount, not what arrived — V3 / V4 / hooked / native all do this), sends
 *         half of each into the VENUE (the pool's share) and refunds `avail - spent` to the vault. A short delivery is
 *         therefore paid out of whatever else this adapter holds. `position()` also counts what sits at the venue.
 *         Not for production.
 */
contract MockPullingAdapter is MockSwapAdapter {
    using SafeERC20 for IERC20;

    uint256[2] public atVenue;

    constructor(address[] memory tokens_, address vault_, bytes32 dex_, bytes32 poolId_)
        MockSwapAdapter(tokens_, vault_, dex_, poolId_)
    {}

    function position() public view override returns (address[] memory tokens, uint256[] memory amounts) {
        (tokens, amounts) = super.position();
        amounts[0] += atVenue[0];
        amounts[1] += atVenue[1];
    }

    function addLiquidity(AddLiquidityParams calldata p)
        external
        override
        onlyVault
        returns (uint256, uint128, uint256, uint256, uint256, uint256)
    {
        (address[] memory t,) = super.position();
        uint256[2] memory avail = [p.maxAmount0, p.maxAmount1];
        uint256[2] memory spent;
        uint256[2] memory refunded;
        for (uint256 i; i < 2; ++i) {
            if (avail[i] == 0) continue;
            IERC20(t[i]).safeTransferFrom(vault, address(this), avail[i]);
            spent[i] = avail[i] / 2;
            refunded[i] = avail[i] - spent[i];
            atVenue[i] += spent[i];
            IERC20(t[i]).safeTransfer(VENUE, spent[i]);
            IERC20(t[i]).safeTransfer(vault, refunded[i]);
        }
        return (MOCK_TOKEN_ID, p.liquidity, spent[0], spent[1], refunded[0], refunded[1]);
    }
}
