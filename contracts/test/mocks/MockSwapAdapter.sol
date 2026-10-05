// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ISwapAdapter} from "contracts/interfaces/ISwapAdapter.sol";
import {MockLiquidityAdapter} from "test/mocks/MockLiquidityAdapter.sol";
import {MockToken} from "test/mocks/MockToken.sol";

/**
 * @notice {MockLiquidityAdapter} plus {ISwapAdapter} (ERC-165 advertises both). `swapExactIn` pulls exactly `amountIn`
 *         of `tokenIn` from the vault (recording the allowance it saw), hands it to a VENUE sink, mints
 *         `amountIn * rateWad / 1e18` of `tokenOut` straight to the vault and returns that — it enforces NO floor, so
 *         the vault's own min-out belt can be exercised. Not for production.
 */
contract MockSwapAdapter is MockLiquidityAdapter, ISwapAdapter {
    using SafeERC20 for IERC20;

    address public constant VENUE = address(0xbeef);

    uint256 public rateWad = 1e18;
    uint256 public swapCalls;
    uint256 public allowanceSeenOnSwap;
    SwapParams internal _lastSwap;

    constructor(address[] memory tokens_, address vault_, bytes32 dex_, bytes32 poolId_)
        MockLiquidityAdapter(tokens_, vault_, dex_, poolId_)
    {}

    function setRateWad(uint256 rateWad_) external {
        rateWad = rateWad_;
    }

    function lastSwap() external view returns (SwapParams memory) {
        return _lastSwap;
    }

    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return interfaceId == type(ISwapAdapter).interfaceId || super.supportsInterface(interfaceId);
    }

    function swapExactIn(SwapParams calldata p) external onlyVault returns (uint256 amountOut) {
        _lastSwap = p;
        ++swapCalls;
        allowanceSeenOnSwap = IERC20(p.tokenIn).allowance(vault, address(this));
        IERC20(p.tokenIn).safeTransferFrom(vault, VENUE, p.amountIn);
        amountOut = (p.amountIn * rateWad) / 1e18;
        MockToken(p.tokenOut).mint(vault, amountOut);
    }
}
