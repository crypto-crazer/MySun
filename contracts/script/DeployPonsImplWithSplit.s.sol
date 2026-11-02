// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {Upgrades, Options} from "openzeppelin-foundry-upgrades/Upgrades.sol";
import {VaultColdLink} from "./VaultColdLink.sol";

/// @notice Deploy the MySunVaultUpgradeable implementation whose constructor pins the REAL
///          DepositSplit address (broadcast by DeployPonsDepositSplit). Broadcast separately
///          (no auth gate on CREATE2), then call ballot manually:
///          cast send PROXY "upgradeToAndCall(address,bytes)" IMPL "" (owner-only).
contract DeployPonsImplWithSplit is Script, VaultColdLink {
    function run() external {
        Options memory opts;
        opts.constructorData = abi.encode(0xe4339d8787296AAf206C1590E4A909cCabE766C1); // real, on-chain 2026-10-11
        opts.referenceBuildInfoDir = "previous-builds/build-info-v1";
        opts.referenceContract = "build-info-v1:MySunVaultUpgradeable";
        address impl = Upgrades.deployImplementation("MySunVaultUpgradeable.sol", opts);
        console2.log("impl:", impl);
    }
}
