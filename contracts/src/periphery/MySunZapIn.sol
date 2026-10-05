// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.34;

import {PoolmigoZapIn} from "contracts/periphery/PoolmigoZapIn.sol";

/**
 * @title MySunZapIn
 * @author MySun
 * @notice Single-asset zap-in periphery — the artifact new MySun deployments ship.
 * @dev Thin wrapper, no code of its own: constructor wiring, immutables, guards, events and `ZapIn__*` errors are
 *      inherited unchanged from {PoolmigoZapIn}, which stays as the legacy artifact of the already-deployed zaps
 *      (notes/NAMING.md → Solidity identifiers). Solidity resolves `Type.member` only on the declaring contract, so
 *      name the events/errors through {PoolmigoZapIn} (e.g. `PoolmigoZapIn.ZapIn__ZeroAddress.selector`).
 * @custom:security-contact security@mysun.example
 */
contract MySunZapIn is PoolmigoZapIn {
    /// @param ur UniversalRouter 2.1.x.
    /// @param permit2 Canonical Permit2.
    /// @param owner_ Registry admin (multisig).
    constructor(address ur, address permit2, address owner_) PoolmigoZapIn(ur, permit2, owner_) {}
}
