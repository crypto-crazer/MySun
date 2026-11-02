// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import {MockToken} from "test/mocks/MockToken.sol";

/**
 * @notice Exact ERC-20 until a knob is set. Mints and burns are always exact.
 *         - {setFee}: a transfer whose sender is `feeFrom` delivers `value - value * feeBps / 10_000` (fee-on-transfer
 *           that taxes one sender only, so later hops stay exact and a swap can complete short).
 *         - {setRoundingLoss}: a transfer whose sender is `roundingFrom` credits up to `roundingLoss` wei less than it
 *           debits (a share / multiplier token rounding the credit down).
 *         - {setReenter}: the next transfer whose sender is `reenterFrom` calls `target` with `data` once, and bubbles
 *           a revert.
 *         The shortfall is burned to 0xdead. Not for production.
 */
contract MockDeliveryToken is MockToken {
    address public feeFrom;
    uint256 public feeBps;
    address public roundingFrom;
    uint256 public roundingLoss;
    address public reenterFrom;
    address public reenterTarget;
    bytes internal _reenterData;

    constructor(string memory name_, string memory symbol_) MockToken(name_, symbol_, 18) {}

    function setFee(address from, uint256 bps) external {
        (feeFrom, feeBps) = (from, bps);
    }

    function setRoundingLoss(address from, uint256 loss) external {
        (roundingFrom, roundingLoss) = (from, loss);
    }

    function setReenter(address from, address target, bytes calldata data) external {
        (reenterFrom, reenterTarget, _reenterData) = (from, target, data);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0)) {
            super._update(from, to, value);
            return;
        }
        uint256 shortfall;
        if (from == roundingFrom) {
            shortfall = roundingLoss < value ? roundingLoss : value;
        }
        if (from == feeFrom && feeBps != 0) {
            shortfall += (value - shortfall) * feeBps / 10_000;
        }
        super._update(from, to, value - shortfall);
        if (shortfall != 0) {
            super._update(from, address(0xdead), shortfall);
        }
        address target = reenterTarget;
        if (from == reenterFrom && target != address(0)) {
            reenterTarget = address(0);
            (bool ok, bytes memory ret) = target.call(_reenterData);
            if (!ok) {
                assembly ("memory-safe") {
                    revert(add(ret, 0x20), mload(ret))
                }
            }
        }
    }
}
