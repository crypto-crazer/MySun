// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import {Script, console2} from "forge-std/Script.sol";
import {Upgrades, Options} from "openzeppelin-foundry-upgrades/Upgrades.sol";
import {MySunVaultUpgradeExample} from "contracts/MySunVaultUpgradeExample.sol";

/// @notice Upgrades a live MySun vault proxy to the upgrade-example implementation (an upgrade-path
/// fixture, not a released version). PROXY env = proxy address; owner key signs.
contract UpgradeExample is Script {
    function run() external {
        address proxy = vm.envAddress("PROXY");
        Options memory opts;
        opts.unsafeAllow = "missing-initializer,missing-initializer-call";
        vm.startBroadcast();
        Upgrades.upgradeProxy(
            proxy,
            "MySunVaultUpgradeExample.sol",
            abi.encodeCall(MySunVaultUpgradeExample.initializeExample, (3600)),
            opts
        );
        vm.stopBroadcast();
        console2.log("Upgraded proxy to the upgrade example:", proxy);
        console2.log("  new implementation:", Upgrades.getImplementationAddress(proxy));
    }
}
