// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.34;

import {Vm} from "forge-std/Vm.sol";
import {PoolmigoVaultCold} from "contracts/PoolmigoVaultCold.sol";

/**
 * @notice Makes {PoolmigoVaultCold} part of a script's link set, and checks that the linked library IS this build's.
 * @dev Forge links an external library into `vm.getCode` only when the executing script references it. The OZ
 *      plugin deploys the vault implementation from that bytecode, so every script that deploys or upgrades a
 *      vault implementation inherits this. The check runs in the script contract's constructor (before `run`).
 *
 *      Library address handling (docs/DEPLOYMENTS.md, "PoolmigoVaultCold"):
 *      - Production: deploy the library once, explicitly (`forge create src/PoolmigoVaultCold.sol:PoolmigoVaultCold`),
 *        record its address, and pass it to every vault-implementation script with
 *        `--libraries src/PoolmigoVaultCold.sol:PoolmigoVaultCold:<address>`. Forge then links that address and
 *        deploys nothing.
 *      - Without `--libraries`, Forge deploys the library itself via CREATE2 through the default deterministic
 *        deployer 0x4e59b44847b379578588920cA78FbF26c0B4956C (present on RHC 4663, read-only checked 2026-11-02).
 *      Either way the linked address must hold exactly this build's runtime: a library's code starts with
 *      `PUSH20 <own address>` (call protection), which the artifact carries as zeros, so the expected code is the
 *      artifact with that address patched in. A wrong `--libraries` address, a library from another build, or a
 *      missing deployer (no code) reverts here before anything is broadcast.
 */
abstract contract VaultColdLink {
    constructor() {
        Vm vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
        address lib = address(PoolmigoVaultCold);
        bytes memory expected = vm.getDeployedCode("PoolmigoVaultCold.sol:PoolmigoVaultCold");
        assembly ("memory-safe") {
            let p := add(expected, 0x21) // byte 1: the PUSH20 operand
            mstore(p, or(and(mload(p), not(shl(96, sub(shl(160, 1), 1)))), shl(96, lib)))
        }
        if (keccak256(lib.code) != keccak256(expected)) {
            revert("VaultColdLink: linked PoolmigoVaultCold is not this build's library");
        }
    }
}
