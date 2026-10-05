// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import {IPositionAdapter} from "contracts/interfaces/IPositionAdapter.sol";
import {ILiquidityAdapter} from "contracts/interfaces/ILiquidityAdapter.sol";
import {ISwapAdapter} from "contracts/interfaces/ISwapAdapter.sol";

/**
 * @notice Recording stand-in for the vault's keeper surface as {PlanExecutor} sees it: every call is appended to a
 *         trail (`kind` in the executor's numbering, adapter, ABI-encoded typed params) so tests can assert the exact
 *         order and dispatch shape. `totalSupply` is settable; `failAt` makes the n-th call (1-based) revert; with
 *         `reenterData` set, the first call re-enters the executor. Not for production.
 */
contract MockPlanVault {
    struct Call {
        uint8 kind;
        address caller;
        address adapter;
        bytes params;
    }

    error MockPlanVault__Fail(uint256 callNumber);

    uint256 public totalSupply;
    uint256 public failAt;
    address public reenterTarget;
    bytes public reenterData;
    Call[] internal _calls;

    function setTotalSupply(uint256 supply) external {
        totalSupply = supply;
    }

    function setFailAt(uint256 n) external {
        failAt = n;
    }

    function setReenter(address target, bytes calldata data) external {
        reenterTarget = target;
        reenterData = data;
    }

    function callCount() external view returns (uint256) {
        return _calls.length;
    }

    function callAt(uint256 i) external view returns (Call memory) {
        return _calls[i];
    }

    function rebalance() external returns (address[] memory, uint256[] memory, uint256[] memory) {
        _record(0, address(0), "");
    }

    function swapExactIn(IPositionAdapter adapter, ISwapAdapter.SwapParams calldata p) external {
        _record(1, address(adapter), abi.encode(p));
    }

    function addLiquidity(IPositionAdapter adapter, ILiquidityAdapter.AddLiquidityParams calldata p) external {
        _record(2, address(adapter), abi.encode(p));
    }

    function removeLiquidity(IPositionAdapter adapter, ILiquidityAdapter.RemoveLiquidityParams calldata p) external {
        _record(3, address(adapter), abi.encode(p));
    }

    function pullFrom(IPositionAdapter adapter, uint256 sharesBps)
        external
        returns (address[] memory, uint256[] memory)
    {
        _record(4, address(adapter), abi.encode(sharesBps));
    }

    function _record(uint8 kind, address adapter, bytes memory params) internal {
        _calls.push(Call(kind, msg.sender, adapter, params));
        if (_calls.length == failAt) {
            revert MockPlanVault__Fail(failAt);
        }
        if (reenterTarget != address(0) && _calls.length == 1) {
            (bool ok, bytes memory ret) = reenterTarget.call(reenterData);
            if (!ok) {
                assembly ("memory-safe") {
                    revert(add(ret, 0x20), mload(ret))
                }
            }
        }
    }
}
