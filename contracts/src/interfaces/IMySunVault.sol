// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import {IPoolmigoVault} from "contracts/interfaces/IPoolmigoVault.sol";

/**
 * @title IMySunVault
 * @notice External surface of the MySun vault — the name new code imports.
 * @dev Adds no member: every function, event and custom error is inherited from {IPoolmigoVault}, so selectors
 *      and error names (`PoolmigoVault__*`) are those of the deployed vaults and one decoder serves both
 *      (notes/NAMING.md → Solidity identifiers). `IPoolmigoVault` stays as the declaring (legacy) interface.
 * @custom:security-contact security@mysun.example
 */
interface IMySunVault is IPoolmigoVault {}
