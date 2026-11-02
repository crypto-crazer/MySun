// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import {Script, console2} from "forge-std/Script.sol";
import {Upgrades, Options} from "openzeppelin-foundry-upgrades/Upgrades.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {MySunVaultUpgradeable} from "contracts/MySunVaultUpgradeable.sol";
import {DepositSplit} from "contracts/periphery/DepositSplit.sol";
import {IPositionAdapter} from "contracts/interfaces/IPositionAdapter.sol";
import {UniswapV4Adapter} from "contracts/adapters/UniswapV4Adapter.sol";
import {UniswapV4HookedAdapter} from "contracts/adapters/UniswapV4HookedAdapter.sol";
import {UniswapV4NativeEthAdapter} from "contracts/adapters/UniswapV4NativeEthAdapter.sol";
import {IUniswapV3PoolMinimal} from "contracts/adapters/uniswap/IUniswapV3PoolMinimal.sol";
import {PoolKey} from "contracts/adapters/uniswap/v4/IPoolManagerMinimal.sol";
import {PoolmigoZapIn} from "contracts/periphery/PoolmigoZapIn.sol";
import {PoolmigoZapOut} from "contracts/periphery/PoolmigoZapOut.sol";
import {VaultColdLink} from "./VaultColdLink.sol";

/// @notice MAINNET (4663) deployment of the 3-pool "sunTriLP" vault — mirror of the demo `DemoTriPool.s.sol`
///         minus any local-chain provisioning, signed by the burner keystore (owner/treasury/keeper).
///         PHASE=1 (default): DepositSplit + vault proxy (initialize with K) + 18 v4 adapters + owner wiring
///         (swap venue ×18, addAdapter ×18, keepers) + zap registration/routes. PHASE=2: owner genesis deposit
///         (mints exactly K; needs the burner to HOLD the seed basket) + keeper deployTo of the whole idle.
contract DeployTriVaultMainnet is Script, VaultColdLink {
    using SafeERC20 for IERC20;

    address internal constant OWNER = 0x27447D6F3eCAA5f0c6b89a5b3D2FA03ff3392eaa; // burner (owner=treasury=keeper)
    address internal constant KEEPER_OPS = 0x0856965c4A6346C5E33352A670CEb6E569DeF678; // strategy executor

    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168; // 6 dp
    address internal constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73; // 18 dp
    address internal constant PONS = 0x39dBED3a2bd333467115dE45665cC57F813C4571; // 18 dp

    address internal constant POSM = 0x58daec3116aae6D93017bAAea7749052E8a04fA7;
    address internal constant UNIVERSAL_ROUTER = 0x204FAca1764B154221e35c0d20aBb3c525710498; // UR 2.1.2
    address internal constant EXEC_NATIVE = 0x58452CF80a0819A75a3b94347F706280CCC03D04; // shared (mainnet)
    address internal constant EXEC_ERC20 = 0x413a67ca4E83A4782F7745858979fE059ccbB431; // shared (mainnet)

    address internal constant FABLES_RAMP_ETH = 0x06a889870C8f83640D6816319f72e2aA579b6080; // ETH/USDG market hook
    address internal constant FABLES_RAMP = 0x08E52564Bad99E05a694b4809F397edcA417A080; // PONS/USDG market hook
    address internal constant FABLES_ETH_PONS = 0x594e8e6281eDf2d363a0293a50004Cf868E7a080; // ETH/PONS market hook

    address internal constant POOL_FEE100 = 0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca; // v3 USDG/WETH 0.05%… fee-100
    address internal constant REF_POOL_PONS = 0x7A192E71564ec66eE0763e328a3Ac274942dE4e1; // v3 PONS/USDG 1%
    address internal constant REF_POOL_WETH_PONS = 0x10CC6BD38112cAc182db90B6a71d8Bb5939526bA; // v3 WETH/PONS 1%

    address internal constant ZAP_IN = 0x8187691738907dCCBB34f6Aa82059CCF1Ae3870f; // mainnet shared
    address internal constant ZAP_OUT = 0xd9151216e2Ab52b446aAb0207Ab34652b44D228C; // mainnet shared

    uint24 internal constant REF_WETH_PONS_FEE = 10_000;
    uint16 internal constant FEE_BPS = 1000; // 10% performance fee (mirror sunEthLP / sunPonsLP)
    uint256 internal constant MAX_TOTAL_SUPPLY = 0; // uncapped (mirror sunEthLP)
    uint256 internal constant N_PER_POOL = 6;
    int24 internal constant RANGE = 600;
    uint32 internal constant TWAP_WINDOW = 1800;
    uint16 internal constant MAX_SLIPPAGE_BPS = 200;

    function _ethKey() internal pure returns (PoolKey memory) {
        return PoolKey({currency0: address(0), currency1: USDG, fee: 0x800000, tickSpacing: 10, hooks: FABLES_RAMP_ETH});
    }

    function _ponsKey() internal pure returns (PoolKey memory) {
        return PoolKey({currency0: PONS, currency1: USDG, fee: 0x800000, tickSpacing: 60, hooks: FABLES_RAMP});
    }

    function _ethPonsKey() internal pure returns (PoolKey memory) {
        return PoolKey({currency0: address(0), currency1: PONS, fee: 0x800000, tickSpacing: 60, hooks: FABLES_ETH_PONS});
    }

    function _v3Sqrt(address pool) internal view returns (uint160 sqrtP) {
        (sqrtP,,,,,,) = IUniswapV3PoolMinimal(pool).slot0();
    }

    function _quote1to0(uint256 amount1, uint160 sqrtP) internal pure returns (uint256) {
        return Math.mulDiv(Math.mulDiv(amount1, 1 << 96, sqrtP), 1 << 96, sqrtP);
    }

    function run() external {
        require(block.chainid == 4663, "DeployTriVaultMainnet: not RHC mainnet (4663)!");
        address signer = vm.envOr("OWNER", OWNER);
        string memory phase = vm.envString("PHASE");
        if (bytes(phase).length == 0) phase = "1";

        if (keccak256(bytes(phase)) == keccak256("1")) {
            _phase1(signer);
        } else if (keccak256(bytes(phase)) == keccak256("2")) {
            _phase2(signer);
        } else {
            revert("DeployTriVaultMainnet: PHASE must be 1 or 2");
        }
    }

    /* ================== PHASE 1: every CREATE + owner wiring ================== */

    function _phase1(address signer) internal {
        uint256 genesisShares = vm.envOr("TRI_GENESIS_SHARES", uint256(10e18));

        vm.startBroadcast(signer);
        address depositSplit = address(new DepositSplit());

        Options memory opts;
        opts.constructorData = abi.encode(depositSplit);
        address[] memory basket = new address[](3);
        basket[0] = USDG;
        basket[1] = WETH;
        basket[2] = PONS;
        address vault = Upgrades.deployUUPSProxy(
            "MySunVaultUpgradeable.sol",
            abi.encodeCall(
                MySunVaultUpgradeable(address(0)).initialize,
                (OWNER, "sunTriLP", "sunTriLP", basket, OWNER, FEE_BPS, genesisShares, MAX_TOTAL_SUPPLY)
            ),
            opts
        );

        address[] memory adapters = new address[](3 * N_PER_POOL);
        for (uint256 i; i < N_PER_POOL; ++i) {
            adapters[i] = _native(vault, _ethKey(), POOL_FEE100);
        }
        for (uint256 i; i < N_PER_POOL; ++i) {
            adapters[N_PER_POOL + i] = _hooked(vault);
        }
        for (uint256 i; i < N_PER_POOL; ++i) {
            adapters[2 * N_PER_POOL + i] = _native(vault, _ethPonsKey(), REF_POOL_WETH_PONS);
        }

        MySunVaultUpgradeable vaultC = MySunVaultUpgradeable(vault);
        for (uint256 i; i < adapters.length; ++i) {
            UniswapV4Adapter(adapters[i]).setSwapVenue(UniswapV4Adapter.SwapVenue.V4_POOL);
            vaultC.addAdapter(IPositionAdapter(adapters[i]));
        }
        vaultC.setKeeper(OWNER, true);
        vaultC.setKeeper(KEEPER_OPS, true);

        _wireZaps(vault);

        vm.stopBroadcast();

        require(vaultC.adapterCount() == 3 * N_PER_POOL, "adapterCount != 18");
        console2.log("TriVaultMainnet PHASE1 done");
        console2.log("  vault:", vault);
        console2.log("  depositSplit:", depositSplit);
        console2.log("  genesisShares (K):", genesisShares);
        for (uint256 i; i < adapters.length; ++i) {
            console2.log("  adapter", i, ":", adapters[i]);
        }
    }

    function _native(address vault, PoolKey memory key, address refPool) internal returns (address) {
        return address(
            new UniswapV4NativeEthAdapter(
                UniswapV4NativeEthAdapter.Config({
                    vault: vault,
                    positionManager: POSM,
                    poolKey: key,
                    refPool: refPool,
                    swapRouter: UNIVERSAL_ROUTER,
                    swapExecutor: EXEC_NATIVE,
                    owner: OWNER,
                    rangeTicksBelow: RANGE,
                    rangeTicksAbove: RANGE,
                    twapWindow: TWAP_WINDOW,
                    maxSlippageBps: MAX_SLIPPAGE_BPS
                })
            )
        );
    }

    function _hooked(address vault) internal returns (address) {
        return address(
            new UniswapV4HookedAdapter(
                UniswapV4HookedAdapter.Config({
                    vault: vault,
                    positionManager: POSM,
                    poolKey: _ponsKey(),
                    refPool: REF_POOL_PONS,
                    swapRouter: UNIVERSAL_ROUTER,
                    swapExecutor: EXEC_ERC20,
                    owner: OWNER,
                    rangeTicksBelow: RANGE,
                    rangeTicksAbove: RANGE,
                    twapWindow: TWAP_WINDOW,
                    maxSlippageBps: MAX_SLIPPAGE_BPS
                })
            )
        );
    }

    /// @dev Mirror the demo step 8: tri registered on the shared mainnet zaps, USDG↔PONS on the v3 fee-10000 pool
    ///      (600 s window / 200 bps slip — the 1% fee cannot fill under 50 bps / 50 bps deviation). Idempotent.
    function _wireZaps(address vault) internal {
        if (!PoolmigoZapIn(ZAP_IN).isVaultRegistered(vault)) {
            PoolmigoZapIn(ZAP_IN).registerVault(vault);
        }
        (address refPool,,,,) = PoolmigoZapIn(ZAP_IN).routes(USDG, PONS);
        if (refPool == address(0)) {
            // 0s select the defaults EXCEPT slippage: 200 bps (demo-tri route; a 50 bps cap can never fill)
            PoolmigoZapIn(ZAP_IN)
                .setRoute(USDG, PONS, REF_WETH_PONS_FEE, REF_POOL_PONS, uint16(600), uint16(200), uint16(50));
        }
        if (!PoolmigoZapOut(ZAP_OUT).isVaultRegistered(vault)) {
            PoolmigoZapOut(ZAP_OUT).registerVault(vault);
        }
        (address refOut,,,,) = PoolmigoZapOut(ZAP_OUT).routes(PONS, USDG);
        if (refOut == address(0)) {
            PoolmigoZapOut(ZAP_OUT)
                .setRoute(PONS, USDG, REF_WETH_PONS_FEE, REF_POOL_PONS, uint16(600), uint16(200), uint16(50));
        }
    }

    /* ================== PHASE 2: owner genesis + keeper deployTo ================== */

    function _phase2(address signer) internal {
        uint256 genesisShares = vm.envOr("TRI_GENESIS_SHARES", uint256(10e18));
        MySunVaultUpgradeable vaultC = MySunVaultUpgradeable(vm.envAddress("TRI_VAULT"));
        require(vaultC.totalSupply() == 0, "DeployTriVaultMainnet: vault already seeded (supply > 0)");

        // [USDG, WETH, PONS] ≈ genesisShares/3 USDG each at the v3 reference spots (same sizing as the demo).
        uint256[] memory gen = new uint256[](3);
        gen[0] = genesisShares / 3 / 1e12;
        gen[1] = _quote1to0(gen[0], _v3Sqrt(POOL_FEE100));
        gen[2] = _quote1to0(gen[0], _v3Sqrt(REF_POOL_PONS));
        require(
            IERC20(USDG).balanceOf(OWNER) >= gen[0] && IERC20(WETH).balanceOf(OWNER) >= gen[1]
                && IERC20(PONS).balanceOf(OWNER) >= gen[2],
            "DeployTriVaultMainnet: owner cannot fund the genesis (balances < sized basket)"
        );

        address[] memory basket = new address[](3);
        basket[0] = USDG;
        basket[1] = WETH;
        basket[2] = PONS;

        vm.startBroadcast(signer);
        for (uint256 i; i < 3; ++i) {
            IERC20(basket[i]).forceApprove(address(vaultC), gen[i]);
        }
        vaultC.deposit(basket, gen, genesisShares, OWNER); // mints EXACTLY K (supply 0 → owner-gated genesis)
        _keeperDeployIdle(vaultC); // the burner IS a keeper: seeds all 18 adapters from the idle
        vm.stopBroadcast();

        require(vaultC.totalSupply() == genesisShares, "supply != K");
        IPositionAdapter[] memory all = vaultC.adapters();
        for (uint256 i; i < all.length; ++i) {
            (address[] memory pt, uint256[] memory pos) = all[i].position();
            require(pos[0] != 0 && pos[1] != 0, string.concat("adapter ", vm.toString(i), " is empty"));
            console2.log("  slot", i, ":", pos[0]);
            console2.log("       /", pt[0], pos[1], pt[1]);
        }
        console2.log("TriVaultMainnet PHASE2 done - supply", genesisShares);
    }

    /// @dev Equal slices of the vault idle → every adapter, with the demo's ±10% tilt (position() token order).
    function _keeperDeployIdle(MySunVaultUpgradeable vaultC) internal {
        IPositionAdapter[] memory all = vaultC.adapters();
        address[] memory reg = vaultC.tokens();
        uint256[] memory slice = new uint256[](reg.length);
        for (uint256 j; j < reg.length; ++j) {
            uint256 holders;
            for (uint256 i; i < all.length; ++i) {
                (address[] memory pt,) = all[i].position();
                if (pt[0] == reg[j] || pt[1] == reg[j]) holders++;
            }
            slice[j] = IERC20(reg[j]).balanceOf(address(vaultC)) / holders;
        }
        for (uint256 i; i < all.length; ++i) {
            (address[] memory pt,) = all[i].position();
            bool usdgPair = pt[0] == USDG || pt[1] == USDG;
            uint256[] memory amounts = new uint256[](2);
            for (uint256 k; k < 2; ++k) {
                uint256 tilt = !usdgPair ? 9 : pt[k] == USDG ? 10 : 11; // tenths of a slice
                for (uint256 j; j < reg.length; ++j) {
                    if (pt[k] == reg[j]) amounts[k] = slice[j] * tilt / 10;
                }
            }
            vaultC.deployTo(all[i], amounts);
        }
    }
}
