// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice ERC-20 with configurable transfer behaviour for the exact-delivery pull tests (K-31):
///         `feeBps` burns a slice out of the recipient side (short delivery — fee-on-transfer) and
///         `bonusBps` mints an extra slice to the recipient (excess delivery — rebase-up). Both zero
///         behaves exactly like a standard token; mints and burns themselves are untouched.
contract MockBehaviorToken is ERC20 {
    uint256 public feeBps;
    uint256 public bonusBps;

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function setBehavior(uint256 feeBps_, uint256 bonusBps_) external {
        feeBps = feeBps_;
        bonusBps = bonusBps_;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0)) {
            super._update(from, to, value);
            return;
        }
        super._update(from, to, value);
        uint256 fee = (value * feeBps) / 10_000;
        if (fee != 0) {
            super._update(to, address(0xdead), fee);
        }
        uint256 bonus = (value * bonusBps) / 10_000;
        if (bonus != 0) {
            _mint(to, bonus);
        }
    }
}
