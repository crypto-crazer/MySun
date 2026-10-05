// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.34;

import {PoolmigoZapOut} from "contracts/periphery/PoolmigoZapOut.sol";

/**
 * @title MySunZapOut
 * @author MySun
 * @notice Exit-zap periphery (receipt token → one output token) — the artifact new MySun deployments ship.
 * @dev Thin wrapper, no code of its own: constructor wiring, immutables, guards, events and `ZapOut__*` errors are
 *      inherited unchanged from {PoolmigoZapOut}, which stays as the legacy artifact of the already-deployed zaps
 *      (notes/NAMING.md → Solidity identifiers). Solidity resolves `Type.member` only on the declaring contract, so
 *      name the events/errors through {PoolmigoZapOut} (e.g. `PoolmigoZapOut.ZapOut__ZeroAddress.selector`).
 * @custom:security-contact security@mysun.example
 */
contract MySunZapOut is PoolmigoZapOut {
    /// @param ur UniversalRouter 2.1.x.
    /// @param permit2 Canonical Permit2.
    /// @param owner_ Registry admin (multisig).
    constructor(address ur, address permit2, address owner_) PoolmigoZapOut(ur, permit2, owner_) {}
}
