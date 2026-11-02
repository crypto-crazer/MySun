// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.34;

import {PoolmigoVaultCold} from "contracts/PoolmigoVaultCold.sol";

/**
 * @notice Makes {PoolmigoVaultCold} part of a script's link set.
 * @dev Forge links an external library into `vm.getCode` only when the executing script references it. The OZ
 *      plugin deploys the vault implementation from that bytecode, so every script that deploys or upgrades a
 *      vault implementation inherits this. The call runs in the script contract's constructor (before `run`,
 *      outside `vm.startBroadcast`); Forge deploys the library first and broadcasts that create with the script.
 *      Reading an empty script address returns an empty basket — the call cannot revert.
 */
abstract contract VaultColdLink {
    constructor() {
        (address[] memory tokens,) = PoolmigoVaultCold.totalTokens();
        // An unused view would be a candidate for deletion. This condition is not statically false.
        if (tokens.length == type(uint256).max) revert("VaultColdLink");
    }
}
