// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.34;

import {PoolmigoVaultUpgradeable} from "contracts/PoolmigoVaultUpgradeable.sol";
import {IMySunVault} from "contracts/interfaces/IMySunVault.sol";

/**
 * @title MySunVaultUpgradeable
 * @author MySun
 * @notice The vault implementation new MySun deployments ship (UUPS proxy + this implementation).
 * @dev Thin wrapper, no code of its own: logic, ERC-7201 namespace (`poolmigo.vault.storage`), initializer,
 *      roles, fees and custom errors are inherited unchanged from {PoolmigoVaultUpgradeable}, which stays as the
 *      legacy artifact — the implementation behind the already-deployed proxies and the OZ upgrade-validation
 *      reference for them (notes/NAMING.md → Solidity identifiers). Never add state or logic here: a change
 *      belongs in the shared implementation (or, for a new version, in a new namespaced upgrade contract).
 *      Solidity resolves `Type.member` only on the declaring contract: encode `initialize` through an instance
 *      (`abi.encodeCall(MySunVaultUpgradeable(address(0)).initialize, (...))`) and name events/errors through
 *      {IPoolmigoVault}, which declares them.
 *
 *      OZ validation: the one allowance below is `missing-initializer` (error-001), scoped to this contract. The
 *      validator only counts `internal`/`public` parent initializers, so the inherited `external initialize` is
 *      invisible to it and `__ERC20_init` / `__Ownable_init` look uncalled. They are called: that `initialize` is
 *      validated with every check on as part of {PoolmigoVaultUpgradeable}, and this contract adds no code
 *      (test/MySunArtifacts.t.sol). Every other check, storage layout included, still runs here.
 * @custom:oz-upgrades-unsafe-allow missing-initializer
 * @custom:security-contact security@mysun.example
 */
contract MySunVaultUpgradeable is PoolmigoVaultUpgradeable, IMySunVault {
    /// @dev Empty on purpose: the inherited constructor locks the implementation (`_disableInitializers`). Declared
    ///      so the ABI matches the legacy artifact's entry for entry (it carries the same `constructor()`).
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {}
}
