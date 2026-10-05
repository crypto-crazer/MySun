// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import {DeployMySunVaultUpgradeable} from "./DeployMySunVaultUpgradeable.s.sol";

/**
 * @notice LEGACY — new deployments use `script/DeployMySunVaultUpgradeable.s.sol`.
 *
 * Same direct (non-CREATE3) deploy with the legacy `PoolmigoVaultUpgradeable` implementation artifact: the one
 * behind the pre-rebrand deployments (the 4663 rehearsal vault was deployed by this script — notes/DEPLOY-RHC.md
 * §1-alt; its receipt is `migoLP`, so pass NAME/SYMBOL to reproduce it). Kept so that deployment stays reproducible
 * and referenced paths resolve; env params, broadcast flow and logging are inherited unchanged (see the MySun
 * script's header).
 */
contract DeployPoolmigoVaultUpgradeable is DeployMySunVaultUpgradeable {
    function _artifact() internal pure override returns (string memory) {
        return "PoolmigoVaultUpgradeable.sol";
    }
}
