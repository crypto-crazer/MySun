// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import {Script, console2} from "forge-std/Script.sol";
import {MySunVaultUpgradeable} from "contracts/MySunVaultUpgradeable.sol";
import {IPositionAdapter} from "contracts/interfaces/IPositionAdapter.sol";
import {IAdapterFees} from "contracts/interfaces/IAdapterFees.sol";
import {PoolKey} from "contracts/adapters/uniswap/v4/IPoolManagerMinimal.sol";
import {UniswapV4HookedAdapter} from "contracts/adapters/UniswapV4HookedAdapter.sol";

/// @notice OPS (4663 mainnet): extend sunPonsLP from 3 -> 6 v4-hooked adapters.
///         Same recipe as DeployPonsVault.s.sol's adapter loop — PONS/USDG FablesRamp pool (dynamic fee,
///         spacing 60), range +-600, TWAP 1800 s, slippage 200 bps, venue V4_POOL, shared executor.
///         DEPLOYS ONLY (broadcast as the owner, `--sender <owner>` + `--account`); then register each
///         deployed address on the vault with owner-signed `cast send … addAdapter(address)` (owner-only),
///         then redistribute liquidity with keeper pullFrom/deployTo.
///   forge clean && forge build -q
///   forge script script/AddPonsHookedAdapters.s.sol --rpc-url rhc --sender 0x27447D… \
///     --account mysun-rehearsal --password-file <path> --broadcast
contract AddPonsHookedAdapters is Script {
    address internal constant OWNER = 0x27447D6F3eCAA5f0c6b89a5b3D2FA03ff3392eaa; // burner — owner / treasury
    address internal constant VAULT = 0x0621252C87307Ed4F07a644F1Ad3a7bb7340c35f; // sunPonsLP (v3, live)
    address internal constant PONS = 0x39dBED3a2bd333467115dE45665cC57F813C4571; // currency0
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168; // currency1
    address internal constant FABLES_RAMP = 0x08E52564Bad99E05a694b4809F397edcA417A080; // bits 0x2080
    address internal constant POSM = 0x58daec3116aae6D93017bAAea7749052E8a04fA7;
    address internal constant REF_POOL_PONS = 0x7A192E71564ec66eE0763e328a3Ac274942dE4e1; // v3 fee-10000 TWAP ref
    address internal constant UNIVERSAL_ROUTER = 0x204FAca1764B154221e35c0d20aBb3c525710498; // UR 2.1.2
    address internal constant SWAP_EXECUTOR = 0x413a67ca4E83A4782F7745858979fE059ccbB431; // shared ERC-20 executor
    uint24 internal constant V4_FEE = 0x800000; // DYNAMIC_FEE_FLAG — the hook resolves each swap's fee
    int24 internal constant V4_TICK_SPACING = 60;
    int24 internal constant RANGE_TICKS = 600;
    uint32 internal constant TWAP_WINDOW = 1800;
    uint16 internal constant MAX_SLIPPAGE_BPS = 200;
    uint256 internal constant N_ADD = 3; // 3 -> 6

    function run() external {
        address owner = vm.envOr("OWNER", msg.sender);
        require(msg.sender == owner, "AddPonsHooked: OWNER must be the broadcasting account");
        PoolKey memory key = PoolKey({
            currency0: PONS,
            currency1: USDG,
            fee: V4_FEE,
            tickSpacing: V4_TICK_SPACING,
            hooks: FABLES_RAMP
        });
        vm.startBroadcast();
        UniswapV4HookedAdapter[] memory added = new UniswapV4HookedAdapter[](N_ADD);
        for (uint256 i; i < N_ADD; ++i) {
            added[i] = new UniswapV4HookedAdapter(
                UniswapV4HookedAdapter.Config({
                    vault: VAULT,
                    positionManager: POSM,
                    poolKey: key,
                    refPool: REF_POOL_PONS,
                    swapRouter: UNIVERSAL_ROUTER,
                    swapExecutor: SWAP_EXECUTOR,
                    owner: owner,
                    rangeTicksBelow: RANGE_TICKS,
                    rangeTicksAbove: RANGE_TICKS,
                    twapWindow: TWAP_WINDOW,
                    maxSlippageBps: MAX_SLIPPAGE_BPS
                })
            );
            added[i].setSwapVenue(UniswapV4HookedAdapter.SwapVenue.V4_POOL);
        }
        vm.stopBroadcast();
        for (uint256 i; i < N_ADD; ++i) console2.log("deployed adapter     :", address(added[i]));
    }
}