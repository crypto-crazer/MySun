// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

/// @notice Minimal subset of Permit2's AllowanceTransfer ABI. Selectors verified with `cast` against the
///         canonical deployment 0x000000000022D473030F116dDEE9F6B43aC78BA3 on RHC (notes/RHC_ADDRESSES.md).
interface IPermit2Minimal {
    /// @dev selector 0x87517c45. `spender` may pull up to `amount` of `token` from msg.sender until `expiration`
    ///      (inclusive: Permit2 reverts only when `block.timestamp > expiration`; 0 = this block).
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;

    /// @dev selector 0x927da105
    function allowance(address user, address token, address spender)
        external
        view
        returns (uint160 amount, uint48 expiration, uint48 nonce);
}
