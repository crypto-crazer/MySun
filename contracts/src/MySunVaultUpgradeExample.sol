// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.34;

import {MySunVaultUpgradeable} from "contracts/MySunVaultUpgradeable.sol";

/**
 * @title MySunVaultUpgradeExample
 * @notice Example next implementation used to prove the upgrade path of {MySunVaultUpgradeable} is storage-safe.
 *         This is an upgrade-path fixture, NOT a released version: it appends ONE field to a NEW namespaced
 *         storage struct (never touches the shipped namespace/layout) and adds a reinitializer to set it (read
 *         back via its namespaced slot). Kept minimal (TEST-ONLY): it inherits the whole vault and must itself
 *         stay under EIP-170. Same fixture as the legacy {PoolmigoVaultUpgradeExample}, on the MySun base.
 * @dev Storage rule (upgrade skill): the shipped ERC-7201 namespace is untouched; this example uses
 *      its OWN namespace, so there is zero possibility of layout collision. A custom annotation
 *      below records the upgrade source for the OZ plugin validator.
 * @custom:oz-upgrades-from MySunVaultUpgradeable
 * @custom:security-contact security@mysun.example
 */
contract MySunVaultUpgradeExample is MySunVaultUpgradeable {
    /// @custom:storage-location erc7201:mysun.vault.example.storage
    struct MySunVaultUpgradeExampleStorage {
        uint64 minRebalanceInterval; // the param this example adds on upgrade
    }

    // keccak256(abi.encode(uint256(keccak256("mysun.vault.example.storage")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant MYSUN_VAULT_UPGRADE_EXAMPLE_STORAGE_LOCATION =
        0xcca7159ac201d617b51ce7033b4f9c4a1b9f7200d111d0202b4a866e29c27b00;

    function _example() private pure returns (MySunVaultUpgradeExampleStorage storage $) {
        assembly {
            $.slot := MYSUN_VAULT_UPGRADE_EXAMPLE_STORAGE_LOCATION
        }
    }

    /// @notice The upgrade initializer — runs exactly once on upgrade (reinitializer(2)), owner only.
    /// @dev Parent initializers (ERC20/Ownable/etc.) already ran in the base `initialize` and MUST NOT
    ///      run again — doing so would revert or wipe state. This reinitializer only sets the example's
    ///      new field. `onlyOwner`: if the proxy were upgraded with empty call data, a third party could
    ///      otherwise consume the one-shot reinitializer. The atomic `upgradeToAndCall` path is
    ///      unaffected — the proxy delegatecalls with the owner as `msg.sender`.
    function initializeExample(uint64 minRebalanceInterval_) external onlyOwner reinitializer(2) {
        _example().minRebalanceInterval = minRebalanceInterval_;
    }
}
