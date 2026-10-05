// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC165} from "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import {ILiquidityAdapter} from "contracts/interfaces/ILiquidityAdapter.sol";
import {MockPositionAdapter} from "test/mocks/MockPositionAdapter.sol";
import {MockToken} from "test/mocks/MockToken.sol";

/**
 * @notice {MockPositionAdapter} plus a minimal {ILiquidityAdapter}: records the last params of each op and the
 *         vault allowance it saw on `addLiquidity`, returns deterministic values, and MOVES NOTHING (no pull, no
 *         refund) — it exercises the vault wrappers' plumbing only — unless {setRemoveDelivers} opts in: then a
 *         removal-mode `removeLiquidity` MINTS the reported principal + fees to the vault (so the vault's fee skim can
 *         be checked for conservation). Not for production.
 *         Returns: add → (MOCK_TOKEN_ID, liquidity, maxAmount0 / 2, maxAmount1 / 2, 1, 2);
 *         remove → (11, 12, 13, 14, 0, 0), or (0, 0, 0, 0, 15, 16) in idle-refund mode (liquidity == 0).
 *         ERC-165: advertises {ILiquidityAdapter} only (so the vault derives CAP_LIQUIDITY, never CAP_SWAP).
 *         {positionState}: (MOCK_TOKEN_ID, -120, 240, 1e18, 1) by default; tests move it with {setPositionState}.
 */
contract MockLiquidityAdapter is MockPositionAdapter, ILiquidityAdapter, ERC165 {
    uint256 public constant MOCK_TOKEN_ID = 42;

    AddLiquidityParams internal _lastAdd;
    RemoveLiquidityParams internal _lastRemove;
    uint256 public addCalls;
    uint256 public removeCalls;
    /// @dev Test probe: allowance the vault had granted this adapter at the moment of the last `addLiquidity`.
    uint256[2] public allowanceSeenOnAdd;

    int24 internal _pinLower = -120;
    int24 internal _pinUpper = 240;
    uint128 internal _pinLiquidity = 1e18;
    uint32 internal _pinVersion = 1;
    /// @dev Opt-in: a removal-mode `removeLiquidity` mints its reported principal + fees to the vault.
    bool public removeDelivers;

    constructor(address[] memory tokens_, address vault_, bytes32 dex_, bytes32 poolId_)
        MockPositionAdapter(tokens_, vault_, dex_, poolId_)
    {}

    function lastAdd() external view returns (AddLiquidityParams memory) {
        return _lastAdd;
    }

    function lastRemove() external view returns (RemoveLiquidityParams memory) {
        return _lastRemove;
    }

    function tokenId() external pure returns (uint256) {
        return MOCK_TOKEN_ID;
    }

    /// @dev Stores no constraints: constant spacing-1 widest box (TickMath.MIN_TICK / MAX_TICK).
    function rangeConstraints() external pure returns (int24, int24, int24, int24) {
        return (-887_272, 887_272, 1, 1_774_544);
    }

    /// @notice Test helper: what {positionState} reports next (the token id stays MOCK_TOKEN_ID).
    function setPositionState(int24 lower, int24 upper, uint128 liquidity, uint32 version) external {
        (_pinLower, _pinUpper, _pinLiquidity, _pinVersion) = (lower, upper, liquidity, version);
    }

    /// @notice Test helper: make removal-mode `removeLiquidity` deliver (mint) what it reports to the vault.
    function setRemoveDelivers(bool on) external {
        removeDelivers = on;
    }

    function positionState() external view returns (uint256, int24, int24, uint128, uint32) {
        return (MOCK_TOKEN_ID, _pinLower, _pinUpper, _pinLiquidity, _pinVersion);
    }

    function supportsInterface(bytes4 interfaceId) public view virtual override returns (bool) {
        return interfaceId == type(ILiquidityAdapter).interfaceId || super.supportsInterface(interfaceId);
    }

    function addLiquidity(AddLiquidityParams calldata p)
        external
        onlyVault
        returns (uint256, uint128, uint256, uint256, uint256, uint256)
    {
        _lastAdd = p;
        ++addCalls;
        (address[] memory t,) = position();
        for (uint256 i; i < 2; ++i) {
            allowanceSeenOnAdd[i] = IERC20(t[i]).allowance(vault, address(this));
        }
        return (MOCK_TOKEN_ID, p.liquidity, p.maxAmount0 / 2, p.maxAmount1 / 2, 1, 2);
    }

    function removeLiquidity(RemoveLiquidityParams calldata p)
        external
        onlyVault
        returns (uint256, uint256, uint256, uint256, uint256, uint256)
    {
        _lastRemove = p;
        ++removeCalls;
        if (p.liquidity == 0) {
            return (0, 0, 0, 0, 15, 16);
        }
        if (removeDelivers) {
            (address[] memory t,) = position();
            MockToken(t[0]).mint(vault, 11 + 13);
            MockToken(t[1]).mint(vault, 12 + 14);
        }
        return (11, 12, 13, 14, 0, 0);
    }
}
