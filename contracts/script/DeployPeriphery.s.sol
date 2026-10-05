// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import {Script, console2} from "forge-std/Script.sol";
import {MySunZapIn} from "contracts/periphery/MySunZapIn.sol";
import {MySunZapOut} from "contracts/periphery/MySunZapOut.sol";
import {PlanExecutor} from "contracts/periphery/PlanExecutor.sol";
import {IMySunVault} from "contracts/interfaces/IMySunVault.sol";
import {MySunVaultUpgradeable} from "contracts/MySunVaultUpgradeable.sol";

/**
 * @notice Deploys the periphery (MySunZapIn + MySunZapOut + the strategy-layer PlanExecutor) for one vault to a
 *         real network and wires it up —
 *         nothing is signed by anyone but the operator's own keystore account (`--account`, never a
 *         plaintext key). Runbook: notes/DEPLOY-RHC.md.
 *
 * Always `forge clean && forge build` first (the OZ-plugin pitfall does not apply here — no proxy — but the
 * clean build keeps deploy scripts deterministic).
 *
 * Robinhood MAINNET (chain 4663):
 *   cd contracts
 *   export VAULT=0x... OWNER=0x...   # OWNER = the vault owner / multisig that will administer the zaps
 *   forge script script/DeployPeriphery.s.sol --rpc-url rhc --account <keystore> --sender <addr> --broadcast
 *
 * Env params:
 *   VAULT       — the deployed MySun vault proxy whose shares the zaps serve (required; must answer
 *                 tokens() with a non-empty basket). Both zaps are registered to it and the PlanExecutor is
 *                 bound to it (immutable); the "stocks"-style vaults with mock tokens are NOT registered on the
 *                 zaps (no venue to route through).
 *   OWNER       — periphery owner (zap registry admin + PlanExecutor keeper admin). Default: the broadcasting
 *                 sender. If it differs from the sender, the script still deploys but prints the setup calls to
 *                 run FROM the owner account (registerVault + setRoute + PlanExecutor.setKeeper are onlyOwner).
 *   PLAN_KEEPER — optional: the keeper service address whitelisted on the PlanExecutor (`setKeeper`) — only when
 *                 sender == OWNER; otherwise the call is printed.
 *   NEW_OWNER   — optional: transfer ownership of all three to it at the end (Ownable2Step: it must then call
 *                 acceptOwnership()). Use when deploying from a hot account but the multisig should own it.
 *   UR         — UniversalRouter 2.1.x. Default: the RHC-wired official 2.1.2.
 *   PERMIT2    — Permit2. Default: canonical.
 *   TOKEN_IN / TOKEN_OUT — the ordered route pair. Default USDG → WETH (zap-in buys WETH with USDG; the
 *                          zap-out route is the reverse of it).
 *   ROUTE_FEE  — v3 fee tier of the route pool. Default 100.
 *   ROUTE_POOL — the route pool. Default: the deepest RHC USDG/WETH venue (v3 fee-100).
 *
 * Ownership: the PlanExecutor only works once it is a VAULT keeper (`vault.setKeeper(planExecutor, true)` — vault
 * owner only). The script grants it only when the sender IS the vault owner (`vault.owner()`, independent of OWNER);
 * otherwise it prints the call to run from the vault owner (multisig).
 *
 * Route params are pinned to the published defaults: TWAP window 600 s, max slippage 50 bps, max adverse
 * spot-vs-TWAP deviation 50 bps (research/zap-sandwich/findings.md).
 */
contract DeployPeriphery is Script {
    /* ---------------- verified RHC defaults (notes/RHC_ADDRESSES.md — never invent one) ---------------- */
    address internal constant DEFAULT_UR = 0x204FAca1764B154221e35c0d20aBb3c525710498; // official 2.1.2, RHC-wired
    address internal constant DEFAULT_PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3; // canonical
    address internal constant DEFAULT_USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168; // 6 dp
    address internal constant DEFAULT_WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73; // 18 dp
    address internal constant DEFAULT_POOL_FEE100 = 0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca; // deepest USDG/WETH

    uint16 internal constant ZAP_TWAP_WINDOW = 600;
    uint16 internal constant ZAP_SLIP_BPS = 50;
    uint16 internal constant ZAP_DEV_BPS = 50;

    function run() external returns (address zapIn, address zapOut, address planExecutor) {
        address vault = vm.envAddress("VAULT");
        address owner = vm.envOr("OWNER", msg.sender);
        address newOwner = vm.envOr("NEW_OWNER", address(0));
        address ur = vm.envOr("UR", DEFAULT_UR);
        address permit2 = vm.envOr("PERMIT2", DEFAULT_PERMIT2);
        address tokenIn = vm.envOr("TOKEN_IN", DEFAULT_USDG);
        address tokenOut = vm.envOr("TOKEN_OUT", DEFAULT_WETH);
        uint24 fee = uint24(vm.envOr("ROUTE_FEE", uint256(100)));
        address pool = vm.envOr("ROUTE_POOL", DEFAULT_POOL_FEE100);

        require(vault != address(0), "VAULT required");
        require(vault.code.length > 0, "VAULT has no code - deploy the vault first");

        bool canSetup = owner == msg.sender;
        vm.startBroadcast();
        zapIn = address(new MySunZapIn(ur, permit2, owner));
        zapOut = address(new MySunZapOut(ur, permit2, owner));
        if (canSetup) {
            MySunZapIn(zapIn).registerVault(vault);
            MySunZapIn(zapIn).setRoute(tokenIn, tokenOut, fee, pool, ZAP_TWAP_WINDOW, ZAP_SLIP_BPS, ZAP_DEV_BPS);
            MySunZapOut(zapOut).registerVault(vault);
            MySunZapOut(zapOut).setRoute(tokenOut, tokenIn, fee, pool, ZAP_TWAP_WINDOW, ZAP_SLIP_BPS, ZAP_DEV_BPS);
        }
        planExecutor = _deployPlanExecutor(vault, owner, canSetup);
        if (canSetup && newOwner != address(0) && newOwner != owner) {
            MySunZapIn(zapIn).transferOwnership(newOwner);
            MySunZapOut(zapOut).transferOwnership(newOwner);
            PlanExecutor(planExecutor).transferOwnership(newOwner);
        }
        vm.stopBroadcast();

        console2.log("== MySun periphery (zaps + plan executor) ==");
        console2.log("chainId       :", block.chainid);
        console2.log("vault         :", vault);
        console2.log("zap-in        :", zapIn);
        console2.log("zap-out       :", zapOut);
        console2.log("plan-executor :", planExecutor);
        console2.log("owner         :", owner);
        console2.log("route         :", tokenIn);
        console2.log("              ->", tokenOut);
        console2.log("fee           :", fee);
        console2.log("pool          :", pool);
        if (canSetup) {
            console2.log("registered + routes set (sender == owner)");
        } else {
            console2.log("sender != OWNER: run these FROM the owner account, then acceptOwnership if needed:");
            console2.log("  zapIn.registerVault(vault);         zapIn.setRoute(tokenIn, tokenOut, ...)");
            console2.log("  zapOut.registerVault(vault);        zapOut.setRoute(tokenOut, tokenIn, ...)");
            console2.log("  planExecutor.setKeeper(<keeper service>, true)");
        }
        _logPlanExecutorWiring(vault, canSetup);
        if (canSetup && newOwner != address(0) && newOwner != owner) {
            console2.log("pending owner (call acceptOwnership from it):", newOwner);
        }
        console2.log(
            "next: add zapIn / zapOut / planExecutor to shared/deployments.json under chains.<chainId>.periphery;"
        );
        console2.log("      make sure the plan executor holds a vault-keeper slot + has its own keeper (setKeeper)");
    }

    /// @dev PlanExecutor bound to `vault`, owned by `owner`. Vault-keeper slot only when the sender IS the vault owner
    ///      (`vault.owner()` — not necessarily OWNER); its own keeper (PLAN_KEEPER) only when sender == OWNER.
    function _deployPlanExecutor(address vault, address owner, bool canSetup) internal returns (address planExecutor) {
        planExecutor = address(new PlanExecutor(IMySunVault(vault), owner));
        if (MySunVaultUpgradeable(vault).owner() == msg.sender) {
            MySunVaultUpgradeable(vault).setKeeper(planExecutor, true);
        }
        address planKeeper = vm.envOr("PLAN_KEEPER", address(0));
        if (canSetup && planKeeper != address(0)) {
            PlanExecutor(planExecutor).setKeeper(planKeeper, true);
        }
    }

    function _logPlanExecutorWiring(address vault, bool canSetup) internal view {
        address planKeeper = vm.envOr("PLAN_KEEPER", address(0));
        if (canSetup && planKeeper != address(0)) {
            console2.log("plan-executor keeper set:", planKeeper);
        } else if (canSetup) {
            console2.log("PLAN_KEEPER unset: run planExecutor.setKeeper(<keeper service>, true) FROM the owner");
        }
        if (MySunVaultUpgradeable(vault).owner() == msg.sender) {
            console2.log("plan executor granted a vault-keeper slot (sender == vault owner)");
        } else {
            console2.log("sender != vault owner: run FROM the vault owner: vault.setKeeper(planExecutor, true)");
        }
    }
}
