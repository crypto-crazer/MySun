// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import {ERC165} from "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IPositionAdapter} from "contracts/interfaces/IPositionAdapter.sol";
import {ILiquidityAdapter} from "contracts/interfaces/ILiquidityAdapter.sol";
import {MockToken} from "test/mocks/MockToken.sol";

/// @notice Fee slice shared by V3 `_withdrawFromPosition`, V4 `withdrawProportional` and the native adapter:
///         `fees_i = floor(feeBalance_i * sharesWad / 1e18)`, included in the delivered amount. `sharesWad` is
///         `floor(shares * 1e18 / supply)` on redeem and `sharesBps * 1e14` on `pullFrom`. Harvest and a positive
///         `removeLiquidity` realize the whole fee balance (V3 collect-max, V4 take-bank). Native amounts are the
///         same numbers in WETH. This mock is that formula, so one vault run covers the three adapters' reporting.
contract ProRataFeeAdapter is IPositionAdapter, ILiquidityAdapter, ERC165 {
    using SafeERC20 for IERC20;

    uint256 internal constant WAD = 1e18;

    address public immutable vault;
    IERC20 public immutable token0;
    IERC20 public immutable token1;
    uint256 public principal0;
    uint256 public principal1;
    uint256 public fees0;
    uint256 public fees1;

    error OnlyVault();

    modifier onlyVault() {
        if (msg.sender != vault) revert OnlyVault();
        _;
    }

    constructor(address vault_, IERC20 token0_, IERC20 token1_) {
        vault = vault_;
        token0 = token0_;
        token1 = token1_;
    }

    function accrue(uint256 f0, uint256 f1) external {
        if (f0 != 0) {
            MockToken(address(token0)).mint(address(this), f0);
            fees0 += f0;
        }
        if (f1 != 0) {
            MockToken(address(token1)).mint(address(this), f1);
            fees1 += f1;
        }
    }

    function dex() external pure returns (bytes32) {
        return keccak256("FEE_ORDER");
    }

    function poolId() external pure returns (bytes32) {
        return bytes32(uint256(1));
    }

    function position() public view returns (address[] memory tokens, uint256[] memory amounts) {
        tokens = _tokens();
        amounts = new uint256[](2);
        amounts[0] = principal0 + fees0;
        amounts[1] = principal1 + fees1;
    }

    function deploy(uint256[] calldata amounts)
        external
        onlyVault
        returns (address[] memory tokens, uint256[] memory deployed)
    {
        tokens = _tokens();
        deployed = new uint256[](2);
        if (amounts[0] != 0) {
            token0.safeTransferFrom(vault, address(this), amounts[0]);
            principal0 += amounts[0];
            deployed[0] = amounts[0];
        }
        if (amounts[1] != 0) {
            token1.safeTransferFrom(vault, address(this), amounts[1]);
            principal1 += amounts[1];
            deployed[1] = amounts[1];
        }
    }

    function withdrawProportional(uint256 sharesWad, address to)
        external
        onlyVault
        returns (address[] memory tokens, uint256[] memory amounts, uint256[] memory fees)
    {
        tokens = _tokens();
        amounts = new uint256[](2);
        fees = new uint256[](2);
        uint256 p0 = Math.mulDiv(principal0, sharesWad, WAD);
        uint256 p1 = Math.mulDiv(principal1, sharesWad, WAD);
        uint256 f0 = Math.mulDiv(fees0, sharesWad, WAD);
        uint256 f1 = Math.mulDiv(fees1, sharesWad, WAD);
        principal0 -= p0;
        principal1 -= p1;
        fees0 -= f0;
        fees1 -= f1;
        amounts[0] = p0 + f0;
        amounts[1] = p1 + f1;
        fees[0] = f0;
        fees[1] = f1;
        _send(to, amounts[0], amounts[1]);
    }

    function harvest() external onlyVault returns (address[] memory tokens, uint256[] memory amounts) {
        tokens = _tokens();
        amounts = new uint256[](2);
        amounts[0] = fees0;
        amounts[1] = fees1;
        fees0 = 0;
        fees1 = 0;
        _send(vault, amounts[0], amounts[1]);
    }

    function unwindAll(address to)
        external
        onlyVault
        returns (address[] memory tokens, uint256[] memory amounts, uint256[] memory fees)
    {
        tokens = _tokens();
        amounts = new uint256[](2);
        fees = new uint256[](2);
        fees[0] = fees0;
        fees[1] = fees1;
        amounts[0] = principal0 + fees0;
        amounts[1] = principal1 + fees1;
        principal0 = 0;
        principal1 = 0;
        fees0 = 0;
        fees1 = 0;
        _send(to, amounts[0], amounts[1]);
    }

    function tokenId() external pure returns (uint256) {
        return 7;
    }

    function rangeConstraints() external pure returns (int24, int24, int24, int24) {
        return (-887_272, 887_272, 1, 1_774_544);
    }

    function positionState() external pure returns (uint256, int24, int24, uint128, uint32) {
        return (7, -120, 120, 1, 1);
    }

    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return interfaceId == type(ILiquidityAdapter).interfaceId || super.supportsInterface(interfaceId);
    }

    function addLiquidity(AddLiquidityParams calldata)
        external
        pure
        returns (uint256, uint128, uint256, uint256, uint256, uint256)
    {
        revert("unused");
    }

    /// @dev Positive liquidity realizes the whole fee balance plus principal, matching V3 collect-max and V4 take-bank.
    function removeLiquidity(RemoveLiquidityParams calldata p)
        external
        onlyVault
        returns (uint256, uint256, uint256, uint256, uint256, uint256)
    {
        if (p.liquidity == 0) return (0, 0, 0, 0, 0, 0);
        uint256 p0 = principal0;
        uint256 p1 = principal1;
        uint256 f0 = fees0;
        uint256 f1 = fees1;
        principal0 = 0;
        principal1 = 0;
        fees0 = 0;
        fees1 = 0;
        _send(vault, p0 + f0, p1 + f1);
        return (p0, p1, f0, f1, 0, 0);
    }

    function _tokens() internal view returns (address[] memory tokens) {
        tokens = new address[](2);
        tokens[0] = address(token0);
        tokens[1] = address(token1);
    }

    function _send(address to, uint256 a0, uint256 a1) internal {
        if (a0 != 0) token0.safeTransfer(to, a0);
        if (a1 != 0) token1.safeTransfer(to, a1);
    }
}
