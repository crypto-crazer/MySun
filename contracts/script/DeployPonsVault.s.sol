// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import {Script, console2} from "forge-std/Script.sol";
import {Upgrades, Options} from "openzeppelin-foundry-upgrades/Upgrades.sol";
import {MySunVaultUpgradeable} from "contracts/MySunVaultUpgradeable.sol";
import {IPositionAdapter} from "contracts/interfaces/IPositionAdapter.sol";
import {IAdapterFees} from "contracts/interfaces/IAdapterFees.sol";
import {PoolKey} from "contracts/adapters/uniswap/v4/IPoolManagerMinimal.sol";
import {DepositSplit} from "contracts/periphery/DepositSplit.sol";
import {UniswapV4HookedAdapter} from "contracts/adapters/UniswapV4HookedAdapter.sol";
import {VaultColdLink} from "./VaultColdLink.sol";

/// @notice OPS (4663 mainnet): deploy a SECOND vault — sunPonsLP — mirroring the demo chain's "pons" vault
///         (script/DemoLocalFork.s.sol) exactly: basket [USDG, PONS], treasury = owner, perf fee 1000 bps,
///         genesis K 8,000 sunPonsLP, cap 500,000 sunPonsLP, OWNER-only deposit split; keepers = burner +
///         ops keeper (same whitelist as sunEthLP); 3 UniswapV4HookedAdapter on the REAL mainnet PONS/USDG
///         FablesRamp pool (poolId 0x486435a1…, hook 0x08E5…, dynamic fee, spacing 60), range ±600 ticks,
///         TWAP 1800 s, slippage 200 bps, venue V4_POOL, shared UniversalRouter swap executor.
///   forge script script/DeployPonsVault.s.sol --rpc-url rhc --sender <owner> \
///     --account mysun-rehearsal --password-file <path> --broadcast
///   Env: OWNER (default msg.sender). No genesis deposit here — the first owner deposit mints the K share
///         constant (the owner funds PONS/USDG in kind out-of-band when ready).
contract DeployPonsVault is Script, VaultColdLink {
    address internal constant OWNER = 0x27447D6F3eCAA5f0c6b89a5b3D2FA03ff3392eaa; // burner — owner / treasury / keeper
    address internal constant OPS_KEEPER = 0x0856965c4A6346C5E33352A670CEb6E569DeF678; // same whitelist as sunEthLP
    address internal constant PONS = 0x39dBED3a2bd333467115dE45665cC57F813C4571; // currency0 / basket token1
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168; // currency1 / basket token0
    address internal constant FABLES_RAMP = 0x08E52564Bad99E05a694b4809F397edcA417A080; // bits 0x2080
    address internal constant POSM = 0x58daec3116aae6D93017bAAea7749052E8a04fA7; // v4 PositionManager
    address internal constant REF_POOL_PONS = 0x7A192E71564ec66eE0763e328a3Ac274942dE4e1; // v3 fee-10000 TWAP ref
    address internal constant UNIVERSAL_ROUTER = 0x204FAca1764B154221e35c0d20aBb3c525710498; // UR 2.1.2
    address internal constant SWAP_EXECUTOR = 0x413a67ca4E83A4782F7745858979fE059ccbB431; // shared ERC-20 executor
    uint24 internal constant V4_FEE = 0x800000; // DYNAMIC_FEE_FLAG — the hook resolves each swap's fee
    int24 internal constant V4_TICK_SPACING = 60;
    int24 internal constant RANGE_TICKS = 600; // ±600 around the TWAP, snapped outward to spacing 60
    uint32 internal constant TWAP_WINDOW = 1800;
    uint16 internal constant MAX_SLIPPAGE_BPS = 200;
    uint16 internal constant FEE_BPS = 1000; // 10% performance fee (mirrors sunEthLP + demo pons)
    uint256 internal constant GENESIS_SHARES = 10e18; // K = 10 shares: ~$1/share at a ~$10 genesis (mainnet test scale)
    uint256 internal constant MAX_TOTAL_SUPPLY = 500_000e18; // demo pons cap
    uint256 internal constant N_ADAPTERS = 3; // test set (demo has 8)

    function run() external {
        address owner = vm.envOr("OWNER", OWNER);
        require(msg.sender == owner, "DeployPonsVault: OWNER must be the broadcasting account");

        Options memory opts;
        // REAL on-chain DepositSplit (deployed 2026-10-11, stateless + reusable). NEVER evaluate
        // `new DepositSplit()` outside vm.broadcast here — that embeds a ghost address (see 161d5ec).
        opts.constructorData = abi.encode(0xe4339d8787296AAf206C1590E4A909cCabE766C1);

        address[] memory basket = new address[](2);
        basket[0] = USDG;
        basket[1] = PONS;

        console2.log("chainId              :", block.chainid);
        console2.log("deploying sunPonsLP   : basket [USDG, PONS]");
        console2.log("  fee bps             :", FEE_BPS);
        console2.log("  genesis K           :", GENESIS_SHARES);

        vm.startBroadcast();
        address vaultAddr = Upgrades.deployUUPSProxy(
            "MySunVaultUpgradeable.sol",
            abi.encodeCall(
                MySunVaultUpgradeable(address(0)).initialize,
                (owner, "sunPonsLP", "sunPonsLP", basket, owner, FEE_BPS, GENESIS_SHARES, MAX_TOTAL_SUPPLY)
            ),
            opts
        );
        console2.log("sunPonsLP vault       :", vaultAddr);
        MySunVaultUpgradeable vault = MySunVaultUpgradeable(vaultAddr);

        vault.setKeeper(OWNER, true);
        vault.setKeeper(OPS_KEEPER, true);
        console2.log("keepers              :", OWNER, "+", OPS_KEEPER);

        PoolKey memory key =
            PoolKey({currency0: PONS, currency1: USDG, fee: V4_FEE, tickSpacing: V4_TICK_SPACING, hooks: FABLES_RAMP});

        UniswapV4HookedAdapter[] memory added = new UniswapV4HookedAdapter[](N_ADAPTERS);
        for (uint256 i; i < N_ADAPTERS; ++i) {
            added[i] = new UniswapV4HookedAdapter(
                UniswapV4HookedAdapter.Config({
                    vault: vaultAddr,
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
            vault.addAdapter(IPositionAdapter(address(added[i])));
            console2.log("added hooked adapter :", address(added[i]));
        }
        vm.stopBroadcast();

        require(MySunVaultUpgradeable(vaultAddr).owner() == owner, "DeployPonsVault: owner mismatch");
        require(MySunVaultUpgradeable(vaultAddr).isKeeper(OWNER), "DeployPonsVault: keeper not whitelisted");
        require(MySunVaultUpgradeable(vaultAddr).isKeeper(OPS_KEEPER), "DeployPonsVault: ops keeper not whitelisted");
        for (uint256 i; i < N_ADAPTERS; ++i) {
            UniswapV4HookedAdapter a = added[i];
            require(vault.isAdapter(address(a)), "DeployPonsVault: NOT registered");
            require(address(a.VAULT()) == vaultAddr, "DeployPonsVault: wrong vault");
            require(a.HOOKS() == FABLES_RAMP, "DeployPonsVault: hook mismatch");
            require(a.supportsInterface(type(IAdapterFees).interfaceId), "DeployPonsVault: missing IAdapterFees");
            console2.log("verify OK            :", address(a));
        }
        console2.log("final adapterCount   :", vault.adapterCount());
        console2.log(
            "next                 : owner funds PONS+USDG -> vault.deposit (genesis K) -> keeper deployTo per adapter"
        );
    }
}
