// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import {Script, console2} from "forge-std/Script.sol";
import {MySunVaultUpgradeable} from "contracts/MySunVaultUpgradeable.sol";
import {IPositionAdapter} from "contracts/interfaces/IPositionAdapter.sol";
import {UniswapV3Adapter} from "contracts/adapters/UniswapV3Adapter.sol";
import {UniswapV4Adapter} from "contracts/adapters/UniswapV4Adapter.sol";
import {PoolKey} from "contracts/adapters/uniswap/v4/IPoolManagerMinimal.sol";
import {UniversalRouterSwapExecutor} from "contracts/swap/UniversalRouterSwapExecutor.sol";

/**
 * @notice Deploy the real Uniswap adapters (v3 + v4) for a deployed vault, one chain at a time. Nothing is
 *         signed here by anyone but the operator's own keystore account:
 *
 *   cd contracts
 *   VAULT=0x… forge script script/DeployAdapters.s.sol --rpc-url rhc --account <keystore> --broadcast
 *
 * Env:
 *   VAULT  — the vault PROXY the adapters serve (required — it is an immutable of both adapters; deploy the
 *            vault first, script/DeployMySunVaultUpgradeable.s.sol).
 *   OWNER  — the adapters' parameter admin (default: the broadcasting account; a production chain should
 *            use the team's multisig).
 *   KEEPER — optional keeper to enable in the same run (needs VAULT set and a broadcasting account that
 *            owns the vault).
 *   UR / PERMIT2 / POOL / NFPM — address overrides; the defaults are RHC mainnet (v3 fee-100 USDG/WETH pool as
 *   reference venue).
 *   WETH / USDG / POSM — v4-only address overrides (the v4 pool key currencies + v4 PositionManager; same RHC
 *   mainnet defaults); read only when DEPLOY_V4 is true.
 *   SWAP_EXECUTOR — optional already-deployed UniversalRouterSwapExecutor (stateless, no privileges) on exactly
 *   (UR, PERMIT2); unset = deploy a fresh one first in this run. Both adapters wire it immutably (their
 *   constructors reject an executor on another router / Permit2).
 *   DEPLOY_V4 — bool, default true (v3 + v4). `false` = v3 ONLY: no v4 adapter is constructed or registered
 *   (WETH / USDG / POSM are never read from the env — left zero — so no usable v4 wiring is needed) and
 *   `adapterV4` returns address(0).
 *   The RHC rehearsal runs with DEPLOY_V4=false (owner decision: v3-only there):
 *
 *   VAULT=0x… DEPLOY_V4=false forge script script/DeployAdapters.s.sol --rpc-url rhc --account <keystore> --broadcast
 *
 * When the broadcasting account owns the vault, the deployed adapters are added to it (and the keeper enabled);
 * otherwise the exact follow-up calls are printed for the vault owner. Parameters mirror the fork suites:
 * range ±300 ticks around TWAP, window 1800 s, max slippage 100 bps; the v4 pool is fee 500 / spacing 10 /
 * no hooks, its reference venue (and default swap pool) the v3 fee-100 pool.
 */
contract DeployAdapters is Script {
    /* --------------------------- venue defaults (notes/RHC_ADDRESSES.md) --------------------------- */
    address internal constant DEFAULT_UR = 0x204FAca1764B154221e35c0d20aBb3c525710498; // UniversalRouter 2.1.2
    address internal constant PERMIT2_CANONICAL = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant DEFAULT_WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address internal constant DEFAULT_USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant DEFAULT_POOL = 0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca; // v3 fee 100
    address internal constant DEFAULT_NFPM = 0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3;
    address internal constant DEFAULT_POSM = 0x58daec3116aae6D93017bAAea7749052E8a04fA7; // v4 PositionManager

    /* --------------------------------- parameters (fork-suite values) -------------------------------- */
    int24 internal constant RANGE_BELOW = 300;
    int24 internal constant RANGE_ABOVE = 300;
    uint32 internal constant TWAP_WINDOW = 1800;
    uint16 internal constant MAX_SLIPPAGE_BPS = 100;
    uint24 internal constant V4_FEE = 500;
    int24 internal constant V4_TICK_SPACING = 10;

    /// @dev Everything the run reads from the env (see the contract NatSpec for each variable).
    struct Params {
        address vault;
        address owner;
        address keeper;
        address ur;
        address permit2;
        address weth;
        address usdg;
        address pool;
        address nfpm;
        address posm;
        address executor;
        bool deployV4;
    }

    function run() external returns (address adapterV3, address adapterV4) {
        return _deploy(_paramsFromEnv());
    }

    function _paramsFromEnv() internal view returns (Params memory p) {
        p.deployV4 = vm.envOr("DEPLOY_V4", true);
        p.vault = vm.envAddress("VAULT");
        p.owner = vm.envOr("OWNER", msg.sender);
        p.keeper = vm.envOr("KEEPER", address(0));
        p.ur = vm.envOr("UR", DEFAULT_UR);
        p.permit2 = vm.envOr("PERMIT2", PERMIT2_CANONICAL);
        p.pool = vm.envOr("POOL", DEFAULT_POOL);
        p.nfpm = vm.envOr("NFPM", DEFAULT_NFPM);
        p.executor = vm.envOr("SWAP_EXECUTOR", address(0));
        // v4-only wiring: never read in v3-only mode (left zero), so no v4 env value can affect a v3 run.
        if (p.deployV4) {
            p.weth = vm.envOr("WETH", DEFAULT_WETH);
            p.usdg = vm.envOr("USDG", DEFAULT_USDG);
            p.posm = vm.envOr("POSM", DEFAULT_POSM);
        }
    }

    function _deploy(Params memory p) internal returns (address adapterV3, address adapterV4) {
        require(msg.sender == p.owner, "DeployAdapters: OWNER must be the broadcasting account");

        vm.startBroadcast();
        if (p.executor == address(0)) {
            p.executor = address(new UniversalRouterSwapExecutor(p.ur, p.permit2));
        }
        adapterV3 = address(
            new UniswapV3Adapter(
                UniswapV3Adapter.Config({
                    vault: p.vault,
                    pool: p.pool,
                    positionManager: p.nfpm,
                    swapRouter: p.ur,
                    permit2: p.permit2,
                    swapExecutor: p.executor,
                    owner: p.owner,
                    rangeTicksBelow: RANGE_BELOW,
                    rangeTicksAbove: RANGE_ABOVE,
                    twapWindow: TWAP_WINDOW,
                    maxSlippageBps: MAX_SLIPPAGE_BPS
                })
            )
        );
        if (p.deployV4) {
            adapterV4 = address(
                new UniswapV4Adapter(
                    UniswapV4Adapter.Config({
                        vault: p.vault,
                        positionManager: p.posm,
                        poolKey: PoolKey({
                            currency0: p.weth,
                            currency1: p.usdg,
                            fee: V4_FEE,
                            tickSpacing: V4_TICK_SPACING,
                            hooks: address(0)
                        }),
                        refPool: p.pool,
                        swapRouter: p.ur,
                        swapExecutor: p.executor,
                        owner: p.owner,
                        rangeTicksBelow: RANGE_BELOW,
                        rangeTicksAbove: RANGE_ABOVE,
                        twapWindow: TWAP_WINDOW,
                        maxSlippageBps: MAX_SLIPPAGE_BPS
                    })
                )
            );
        }

        bool canSetup = p.vault.code.length > 0 && MySunVaultUpgradeable(p.vault).owner() == msg.sender;
        if (canSetup) {
            MySunVaultUpgradeable(p.vault).addAdapter(IPositionAdapter(adapterV3));
            if (p.deployV4) MySunVaultUpgradeable(p.vault).addAdapter(IPositionAdapter(adapterV4));
            if (p.keeper != address(0)) MySunVaultUpgradeable(p.vault).setKeeper(p.keeper, true);
        }
        vm.stopBroadcast();

        _log(p, adapterV3, adapterV4, canSetup);
    }

    function _log(Params memory p, address adapterV3, address adapterV4, bool canSetup) internal view {
        console2.log("mode      :", p.deployV4 ? "v3 + v4" : "v3 ONLY (DEPLOY_V4=false) - no v4 adapter deployed");
        console2.log("chainId   :", block.chainid);
        console2.log("vault     :", p.vault);
        console2.log("adapterV3 :", adapterV3);
        if (p.deployV4) {
            console2.log("adapterV4 :", adapterV4);
        } else {
            console2.log("adapterV4 : none (skipped: DEPLOY_V4=false)");
        }
        console2.log("owner     :", p.owner);
        console2.log("ur        :", p.ur);
        console2.log("executor  :", p.executor);
        console2.log("pool (v3) :", p.pool);
        console2.log("nfpm      :", p.nfpm);
        if (p.deployV4) console2.log("posm      :", p.posm);
        if (canSetup) {
            if (p.deployV4) {
                console2.log("vault: both adapters added (v3 + v4); keeper enabled:", p.keeper != address(0));
            } else {
                console2.log("vault: ONLY the v3 adapter added (no v4); keeper enabled:", p.keeper != address(0));
            }
        } else {
            console2.log("vault has no code OR is not owned by the sender - run these from the vault owner:");
            console2.log("  vault.addAdapter(", adapterV3);
            if (p.deployV4) console2.log("  vault.addAdapter(", adapterV4);
            if (p.keeper != address(0)) {
                console2.log("  vault.setKeeper(keeper, true) with keeper:", p.keeper);
            }
        }
        console2.log("next: the zap periphery (script/DeployPeriphery.s.sol), then the keeper service");
    }
}
