// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {Upgrades, Options} from "openzeppelin-foundry-upgrades/Upgrades.sol";
import {DepositSplit} from "contracts/periphery/DepositSplit.sol";
import {MySunVaultUpgradeable} from "contracts/MySunVaultUpgradeable.sol";
import {VaultColdLink} from "./VaultColdLink.sol";

/// @notice Fix the sunPonsLP implementation on mainnet 4663: the original deploy embedded a
///         `new DepositSplit()` evaluated OUTSIDE vm.broadcast, so the impl immutable points at a
///         non-existent address (0xC7f2Cf48…) and every deposit reverts. This script
///         (1) broadcasts a REAL DepositSplit create, then (2) redeploys the implementation with
///         the real address as constructor arg and upgrades the proxy (UUPS, owner-only).
///         Adapters reference the proxy — unaffected. Storage layout unchanged (same source).
contract FixPonsVaultImpl is Script, VaultColdLink {
    address internal constant PROXY = 0x491941246B26A6E9a8CD43BaaFD905492a541667;
    address internal constant OWNER = 0x27447D6F3eCAA5f0c6b89a5b3D2FA03ff3392eaa;

    function run() external {
        require(msg.sender == OWNER, "FixPonsVaultImpl: owner only");
        console2.log("chainId                 :", block.chainid);
        console2.log("proxy                   :", PROXY);
        console2.log("old impl                :", Upgrades.getImplementationAddress(PROXY));

        // (1) Real on-chain CREATE — no ghost addresses this time.
        vm.startBroadcast();
        DepositSplit ds = new DepositSplit();
        vm.stopBroadcast();
        console2.log("DepositSplit (broadcast):", address(ds));

        // (2) Redeploy impl with the real DepositSplit + upgrade the proxy (plugin validates + broadcasts).
        Options memory opts;
        opts.constructorData = abi.encode(address(ds));
        opts.referenceBuildInfoDir = "previous-builds/build-info-v1";
        opts.referenceContract = "build-info-v1:MySunVaultUpgradeable";
        Upgrades.upgradeProxy(PROXY, "MySunVaultUpgradeable.sol", "", opts);

        address impl = Upgrades.getImplementationAddress(PROXY);
        console2.log("new impl                :", impl);
        console2.log("new impl code size      :", impl.code.length);
    }
}
