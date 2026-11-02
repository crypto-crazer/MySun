// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import {Script, console2} from "forge-std/Script.sol";
import {DepositSplit} from "contracts/periphery/DepositSplit.sol";
import {VaultColdLink} from "./VaultColdLink.sol";

/**
 * @notice Resolves the {DepositSplit} a vault implementation pins at construction (its immutable): the `DEPOSIT_SPLIT`
 *         env address if set (must have code), else a fresh deployment by the broadcasting account. Call it INSIDE
 *         the broadcast, before the implementation is created. The splitter is stateless and ownerless, so reusing
 *         one per chain and deploying a fresh one are equivalent; reuse keeps the chain's registry short.
 */
abstract contract DepositSplitEnv is Script, VaultColdLink {
    function _depositSplit() internal returns (address split) {
        split = vm.envOr("DEPOSIT_SPLIT", address(0));
        if (split == address(0)) {
            split = address(new DepositSplit());
        } else {
            require(split.code.length > 0, "DEPOSIT_SPLIT has no code");
        }
    }
}

/**
 * @notice Deploys the stateless {DepositSplit} once per chain — the vault-implementation constructor argument
 *         (deposit-deploy, T2d). Run it before the vault scripts and export the printed address as `DEPOSIT_SPLIT`
 *         (`DeployMySunVaultUpgradeable` / `DeployDeterministic` / `UpgradeExample` deploy one themselves if unset).
 *         No constructor arguments, no owner, nothing to wire. Runbook: notes/DEPLOY-RHC.md.
 *
 *   forge script script/DeployDepositSplit.s.sol --rpc-url <rpc> --account <keystore> --sender <addr> --broadcast
 */
contract DeployDepositSplit is Script {
    function run() external returns (address split) {
        vm.startBroadcast();
        split = address(new DepositSplit());
        vm.stopBroadcast();
        console2.log("DEPOSIT_SPLIT=%s", split);
    }
}
