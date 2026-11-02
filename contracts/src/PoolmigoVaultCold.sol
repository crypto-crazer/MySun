// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ERC165Checker} from "@openzeppelin/contracts/utils/introspection/ERC165Checker.sol";

import {IPoolmigoVault} from "contracts/interfaces/IPoolmigoVault.sol";
import {IPositionAdapter} from "contracts/interfaces/IPositionAdapter.sol";
import {ILiquidityAdapter} from "contracts/interfaces/ILiquidityAdapter.sol";
import {ISwapAdapter} from "contracts/interfaces/ISwapAdapter.sol";

/**
 * @title PoolmigoVaultCold
 * @author MySun
 * @notice Linked external library for the cold and bulky vault paths that do not fit EIP-170:
 *         adapter registry writes, the deposit quote, basket totals, and the redeem preview.
 * @dev Deployed once per implementation and linked into {PoolmigoVaultUpgradeable} (Foundry deploys and links it
 *      before `forge test` / `forge script`; `vm.getCode` then returns the linked creation code the OZ plugin
 *      deploys). Every entry point runs via DELEGATECALL, so `address(this)` is the proxy, events and reverts
 *      come from the proxy, and storage is the proxy's ERC-7201 namespace below — the same slot and the same
 *      field order as `PoolmigoVaultStorage` in the vault. This library has no state of its own and no
 *      `selfdestruct`. It is not an authority: the vault keeps `onlyOwner` / keeper gates and calls in.
 *
 *      Share-supply and owner reads go back through the proxy (`IVaultSurface`) so they hit the real ERC-20 /
 *      Ownable getters instead of a second copy of those slots.
 * @custom:security-contact security@mysun.example
 */
library PoolmigoVaultCold {
    using Math for uint256;

    /// @dev Identical layout to {PoolmigoVaultUpgradeable}'s `PoolmigoVaultStorage` (the annotated ERC-7201 struct
    ///      stays on the vault). Do not reorder, insert, or retype.
    struct PoolmigoVaultStorage {
        address treasury;
        uint16 performanceFeeBps;
        bool paused;
        address[] tokens;
        mapping(address token => bool registered) isToken;
        IPositionAdapter[] adapters;
        mapping(address adapter => bool registered) isAdapter;
        mapping(address keeper => bool allowed) isKeeper;
        uint256 genesisShares;
        uint256 maxTotalSupply;
        mapping(address manager => bool allowed) isRiskManager;
        mapping(address adapter => uint8 mask) capabilities;
    }

    // keccak256(abi.encode(uint256(keccak256("poolmigo.vault.storage")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant POOLMIGO_VAULT_STORAGE_LOCATION =
        0xac5b1d856d96bdb992e4d284c4f305568246dd601ded20a127e04a49bd0b7b00;

    /// @dev Must match the vault's public constants (the getters stay on the vault; the values are duplicated here
    ///      because a linked library cannot read the vault's constants).
    uint256 private constant MAX_ADAPTERS = 32;
    uint8 private constant CAP_LIQUIDITY = 1;
    uint8 private constant CAP_SWAP = 2;
    uint256 private constant NOT_FOUND = type(uint256).max;
    uint256 private constant WAD = 1e18;

    /// @dev Virtual shares / virtual assets for the DEPOSIT quote only (redeem stays real pro-rata).
    ///      VS = VA = 1, OZ ERC-4626's offset-0 ratio, tuned down from 1e6/1 because the deposit side is
    ///      virtual but redeem is real: a deposit→redeem round trip on token i returns <= what was pulled
    ///      iff VS/VA <= S/T_i. At the ≈$1/share genesis scale that holds for every token priced >= 1 display
    ///      unit per whole token. The donation defence does not rest on the virtual size: genesis is
    ///      owner-gated with a large K, and deposits pull only ceil(shares * (T + VA) / (S + VS)).
    uint256 private constant VIRTUAL_SHARES = 1;
    uint256 private constant VIRTUAL_ASSETS = 1;

    function _s() private pure returns (PoolmigoVaultStorage storage $) {
        assembly {
            $.slot := POOLMIGO_VAULT_STORAGE_LOCATION
        }
    }

    /*//////////////////////////////////////////////////////////////
                            ADAPTER REGISTRY
    //////////////////////////////////////////////////////////////*/

    /// @dev Body of {PoolmigoVaultUpgradeable-addAdapter}. Caller is `onlyOwner`.
    function addAdapter(IPositionAdapter adapter) external {
        if (address(adapter) == address(0)) {
            revert IPoolmigoVault.PoolmigoVault__ZeroAddress();
        }
        PoolmigoVaultStorage storage $ = _s();
        if ($.isAdapter[address(adapter)]) {
            revert IPoolmigoVault.PoolmigoVault__AdapterAlreadyRegistered(address(adapter));
        }
        if ($.adapters.length >= MAX_ADAPTERS) {
            revert IPoolmigoVault.PoolmigoVault__MaxAdaptersReached(MAX_ADAPTERS);
        }
        (address[] memory t,) = _positionOf(adapter);
        uint256 n = t.length;
        if (n == 0) {
            revert IPoolmigoVault.PoolmigoVault__AdapterNoTokens(address(adapter));
        }
        for (uint256 i; i < n; ++i) {
            if (t[i] == address(0)) {
                revert IPoolmigoVault.PoolmigoVault__ZeroAddress();
            }
            if (!$.isToken[t[i]]) {
                revert IPoolmigoVault.PoolmigoVault__AdapterTokenNotRegistered(address(adapter), t[i]);
            }
        }
        $.isAdapter[address(adapter)] = true;
        $.adapters.push(adapter);
        emit IPoolmigoVault.AdapterAdded(address(adapter), adapter.dex(), adapter.poolId());
        uint8 caps = _supportedCapabilities(adapter);
        $.capabilities[address(adapter)] = caps;
        emit IPoolmigoVault.AdapterCapabilitySet(address(adapter), caps);
    }

    /// @dev Body of {PoolmigoVaultUpgradeable-setAdapterCapability}. Caller is `onlyOwner`.
    function setAdapterCapability(IPositionAdapter adapter, uint8 capBit, bool enabled) external {
        PoolmigoVaultStorage storage $ = _s();
        _requireRegistered($, adapter);
        if (capBit != CAP_LIQUIDITY && capBit != CAP_SWAP) {
            revert IPoolmigoVault.PoolmigoVault__InvalidCapability(capBit);
        }
        uint8 caps = $.capabilities[address(adapter)];
        if (enabled) {
            if (_supportedCapabilities(adapter) & capBit == 0) {
                revert IPoolmigoVault.PoolmigoVault__CapabilityUnsupported(address(adapter), capBit);
            }
            caps |= capBit;
        } else {
            caps &= ~capBit;
        }
        $.capabilities[address(adapter)] = caps;
        emit IPoolmigoVault.AdapterCapabilitySet(address(adapter), caps);
    }

    /// @dev Body of {PoolmigoVaultUpgradeable-removeAdapter}. Caller is `onlyOwner`.
    function removeAdapter(IPositionAdapter adapter) external {
        PoolmigoVaultStorage storage $ = _s();
        _requireRegistered($, adapter);
        (address[] memory t, uint256[] memory a) = _positionOf(adapter);
        uint256 n = t.length;
        for (uint256 i; i < n; ++i) {
            if (a[i] != 0) {
                revert IPoolmigoVault.PoolmigoVault__AdapterStillFunded(address(adapter), t[i], a[i]);
            }
        }
        _dropAdapter($, adapter);
        emit IPoolmigoVault.AdapterRemoved(address(adapter));
    }

    /// @dev Body of {PoolmigoVaultUpgradeable-forceRemoveAdapter}. Caller is `onlyOwner`. Never calls the adapter.
    function forceRemoveAdapter(IPositionAdapter adapter) external {
        PoolmigoVaultStorage storage $ = _s();
        _requireRegistered($, adapter);
        _dropAdapter($, adapter);
        emit IPoolmigoVault.AdapterForceRemoved(address(adapter));
    }

    /*//////////////////////////////////////////////////////////////
                          QUOTE AND TOTALS
    //////////////////////////////////////////////////////////////*/

    /// @dev Body of {PoolmigoVaultUpgradeable-totalTokens}.
    function totalTokens() external view returns (address[] memory tokens_, uint256[] memory amounts) {
        return _totalTokens();
    }

    /// @dev Body of {PoolmigoVaultUpgradeable-previewRedeem}. `supply` is the vault's receipt totalSupply, read by
    ///      the vault so this stays a single delegatecall with no callback.
    function previewRedeem(uint256 shares, uint256 supply)
        external
        view
        returns (address[] memory tokens_, uint256[] memory owedAmounts)
    {
        tokens_ = _s().tokens;
        uint256 n = tokens_.length;
        owedAmounts = new uint256[](n);
        if (supply == 0 || shares == 0) {
            return (tokens_, owedAmounts);
        }
        uint256 sharesWad = shares.mulDiv(WAD, supply, Math.Rounding.Floor);
        uint256[] memory slices = _adapterSlices(tokens_, sharesWad);
        for (uint256 i; i < n; ++i) {
            owedAmounts[i] = slices[i] + shares.mulDiv(_idle(tokens_[i]), supply, Math.Rounding.Floor);
        }
    }

    /// @dev Body of {PoolmigoVaultUpgradeable-_previewDeposit}. `msg.sender` is the original caller (delegatecall).
    ///      Share supply and owner are read from the proxy after the basket snapshot, same order as the vault.
    function previewDeposit(address[] calldata tokens_, uint256[] calldata amounts_)
        external
        view
        returns (uint256 shares, uint256[] memory required)
    {
        uint256 n = tokens_.length;
        if (n == 0 || n != amounts_.length) {
            revert IPoolmigoVault.PoolmigoVault__LengthMismatch();
        }

        (address[] memory registry, uint256[] memory totals) = _totalTokens();
        uint256 m = registry.length;

        (uint256[] memory offeredAt, uint256[] memory registryIdx) = _mapOffered(registry, tokens_, n, m);

        uint256 supply = IVaultSurface(address(this)).totalSupply();
        required = new uint256[](n);

        if (supply == 0) {
            if (msg.sender != IVaultSurface(address(this)).owner()) {
                revert IPoolmigoVault.PoolmigoVault__GenesisNotOwner();
            }
            for (uint256 r; r < m; ++r) {
                if (offeredAt[r] == NOT_FOUND) {
                    revert IPoolmigoVault.PoolmigoVault__MissingBasketToken(registry[r]);
                }
            }
            for (uint256 i; i < n; ++i) {
                if (amounts_[i] == 0) {
                    revert IPoolmigoVault.PoolmigoVault__ZeroAmount();
                }
                required[i] = amounts_[i];
            }
            shares = _s().genesisShares;
        } else {
            shares = _bindingShares(registry, totals, offeredAt, amounts_, supply);
            if (shares == 0) {
                revert IPoolmigoVault.PoolmigoVault__ZeroShares();
            }
            _fillRequired(required, registryIdx, totals, amounts_, shares, supply);
        }

        uint256 cap = _s().maxTotalSupply;
        if (cap != 0 && supply + shares > cap) {
            revert IPoolmigoVault.PoolmigoVault__SupplyCapExceeded(supply + shares, cap);
        }
    }

    /*//////////////////////////////////////////////////////////////
                               HELPERS
    //////////////////////////////////////////////////////////////*/

    function _requireRegistered(PoolmigoVaultStorage storage $, IPositionAdapter adapter) private view {
        if (!$.isAdapter[address(adapter)]) {
            revert IPoolmigoVault.PoolmigoVault__AdapterNotRegistered(address(adapter));
        }
    }

    /// @dev Unregister `adapter` (swap-and-pop). Never calls it.
    function _dropAdapter(PoolmigoVaultStorage storage $, IPositionAdapter adapter) private {
        $.isAdapter[address(adapter)] = false;
        delete $.capabilities[address(adapter)];

        IPositionAdapter[] storage arr = $.adapters;
        uint256 len = arr.length;
        for (uint256 i; i < len; ++i) {
            if (address(arr[i]) == address(adapter)) {
                arr[i] = arr[len - 1];
                arr.pop();
                break;
            }
        }
    }

    function _supportedCapabilities(IPositionAdapter adapter) private view returns (uint8 caps) {
        if (ERC165Checker.supportsERC165InterfaceUnchecked(address(adapter), type(ILiquidityAdapter).interfaceId)) {
            caps = CAP_LIQUIDITY;
        }
        if (ERC165Checker.supportsERC165InterfaceUnchecked(address(adapter), type(ISwapAdapter).interfaceId)) {
            caps |= CAP_SWAP;
        }
    }

    function _totalTokens() private view returns (address[] memory tokens_, uint256[] memory amounts) {
        PoolmigoVaultStorage storage $ = _s();
        tokens_ = $.tokens;
        uint256 n = tokens_.length;
        amounts = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            amounts[i] = _idle(tokens_[i]);
        }
        uint256 len = $.adapters.length;
        for (uint256 i; i < len; ++i) {
            (address[] memory t, uint256[] memory a) = _positionOf(_adapterAt(i));
            _accumulate(tokens_, amounts, t, a);
        }
    }

    function _adapterSlices(address[] memory registry, uint256 sharesWad)
        private
        view
        returns (uint256[] memory slices)
    {
        uint256 n = registry.length;
        slices = new uint256[](n);
        if (sharesWad == 0) {
            return slices;
        }
        PoolmigoVaultStorage storage $ = _s();
        uint256 len = $.adapters.length;
        for (uint256 i; i < len; ++i) {
            (address[] memory t, uint256[] memory a) = _positionOf(_adapterAt(i));
            uint256 m = t.length;
            for (uint256 j; j < m; ++j) {
                uint256 idx = _indexOf(registry, t[j]);
                if (idx != NOT_FOUND) {
                    slices[idx] += a[j].mulDiv(sharesWad, WAD, Math.Rounding.Floor);
                }
            }
        }
    }

    function _accumulate(address[] memory registry, uint256[] memory totals, address[] memory t, uint256[] memory a)
        private
        pure
    {
        uint256 n = t.length;
        if (a.length != n) {
            revert IPoolmigoVault.PoolmigoVault__LengthMismatch();
        }
        for (uint256 i; i < n; ++i) {
            if (a[i] == 0) {
                continue;
            }
            uint256 idx = _indexOf(registry, t[i]);
            if (idx != NOT_FOUND) {
                totals[idx] += a[i];
            }
        }
    }

    function _mapOffered(address[] memory registry, address[] calldata tokens_, uint256 n, uint256 m)
        private
        pure
        returns (uint256[] memory offeredAt, uint256[] memory registryIdx)
    {
        offeredAt = new uint256[](m);
        for (uint256 r; r < m; ++r) {
            offeredAt[r] = NOT_FOUND;
        }
        registryIdx = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            uint256 r = _indexOf(registry, tokens_[i]);
            if (r == NOT_FOUND) {
                revert IPoolmigoVault.PoolmigoVault__TokenNotRegistered(tokens_[i]);
            }
            if (offeredAt[r] != NOT_FOUND) {
                revert IPoolmigoVault.PoolmigoVault__DuplicateToken(tokens_[i]);
            }
            offeredAt[r] = i;
            registryIdx[i] = r;
        }
    }

    /// @dev Min-ratio share count over the participating tokens (T_i > 0, offered with amount_i > 0):
    ///      min_i floor(amount_i * (S + VS) / (T_i + VA)). Every held token must be offered non-zero —
    ///      an omitted or zero-offered held token reverts `MissingBasketToken` / `ZeroAmount` in registry
    ///      order (the dust exemption is gone: merged sub-wei draws composed into >= 1 wei at redeem, K-14).
    ///      T_i == 0 is optional. The second loop runs only when a held token was omitted.
    function _bindingShares(
        address[] memory registry,
        uint256[] memory totals,
        uint256[] memory offeredAt,
        uint256[] calldata amounts_,
        uint256 supply
    ) private pure returns (uint256 shares) {
        bool bound;
        bool omitted;
        uint256 m = registry.length;
        for (uint256 r; r < m; ++r) {
            if (totals[r] == 0) {
                continue;
            }
            uint256 i = offeredAt[r];
            if (i == NOT_FOUND || amounts_[i] == 0) {
                omitted = true;
                continue;
            }
            uint256 candidate =
                amounts_[i].mulDiv(supply + VIRTUAL_SHARES, totals[r] + VIRTUAL_ASSETS, Math.Rounding.Floor);
            if (!bound || candidate < shares) {
                shares = candidate;
                bound = true;
            }
        }
        if (omitted) {
            for (uint256 r; r < m; ++r) {
                uint256 total = totals[r];
                if (total == 0) {
                    continue;
                }
                uint256 i = offeredAt[r];
                if (i != NOT_FOUND && amounts_[i] != 0) {
                    continue;
                }
                if (i == NOT_FOUND) {
                    revert IPoolmigoVault.PoolmigoVault__MissingBasketToken(registry[r]);
                }
                revert IPoolmigoVault.PoolmigoVault__ZeroAmount();
            }
        }
    }

    function _fillRequired(
        uint256[] memory required,
        uint256[] memory registryIdx,
        uint256[] memory totals,
        uint256[] calldata amounts_,
        uint256 shares,
        uint256 supply
    ) private pure {
        uint256 n = required.length;
        for (uint256 i; i < n; ++i) {
            uint256 total = totals[registryIdx[i]];
            if (total != 0 && amounts_[i] != 0) {
                required[i] = shares.mulDiv(total + VIRTUAL_ASSETS, supply + VIRTUAL_SHARES, Math.Rounding.Ceil);
            }
        }
    }

    function _idle(address token) private view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }

    function _adapterAt(uint256 index) private view returns (IPositionAdapter) {
        return _s().adapters[index];
    }

    function _positionOf(IPositionAdapter adapter) private view returns (address[] memory, uint256[] memory) {
        return adapter.position();
    }

    function _indexOf(address[] memory registry, address token) private pure returns (uint256 idx) {
        uint256 n = registry.length;
        for (uint256 i; i < n; ++i) {
            if (registry[i] == token) {
                return i;
            }
        }
        return NOT_FOUND;
    }
}

/// @dev The two vault getters the deposit quote reads back through the proxy (delegatecall keeps `address(this)`
///      as the proxy). Declared outside the library so the call is a real CALL, not another link.
interface IVaultSurface {
    function totalSupply() external view returns (uint256);
    function owner() external view returns (address);
}
