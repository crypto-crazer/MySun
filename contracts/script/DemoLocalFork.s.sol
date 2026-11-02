// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import {Script, console2} from "forge-std/Script.sol";
import {Upgrades, Options} from "openzeppelin-foundry-upgrades/Upgrades.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {MySunVaultUpgradeable} from "contracts/MySunVaultUpgradeable.sol";
import {DepositSplit} from "contracts/periphery/DepositSplit.sol";
import {IPositionAdapter} from "contracts/interfaces/IPositionAdapter.sol";
import {UniswapV3Adapter} from "contracts/adapters/UniswapV3Adapter.sol";
import {UniswapV4Adapter} from "contracts/adapters/UniswapV4Adapter.sol";
import {UniswapV4HookedAdapter} from "contracts/adapters/UniswapV4HookedAdapter.sol";
import {UniswapV4NativeEthAdapter} from "contracts/adapters/UniswapV4NativeEthAdapter.sol";
import {INativeWrapperMinimal} from "contracts/adapters/uniswap/IWETH9Minimal.sol";
import {IUniswapV3PoolMinimal} from "contracts/adapters/uniswap/IUniswapV3PoolMinimal.sol";
import {INonfungiblePositionManager} from "contracts/adapters/uniswap/INonfungiblePositionManager.sol";
import {PoolKey} from "contracts/adapters/uniswap/v4/IPoolManagerMinimal.sol";
import {IPositionManagerMinimal} from "contracts/adapters/uniswap/v4/IPositionManagerMinimal.sol";
import {IPermit2Minimal} from "contracts/adapters/uniswap/v4/IPermit2Minimal.sol";
import {MySunZapIn} from "contracts/periphery/MySunZapIn.sol";
import {MySunZapOut} from "contracts/periphery/MySunZapOut.sol";
import {PlanExecutor} from "contracts/periphery/PlanExecutor.sol";
import {IMySunVault} from "contracts/interfaces/IMySunVault.sol";
import {UniversalRouterSwapExecutor} from "contracts/swap/UniversalRouterSwapExecutor.sol";
import {UniversalRouterNativeSwapExecutor} from "contracts/swap/UniversalRouterNativeSwapExecutor.sol";
import {MockPositionAdapter} from "test/mocks/MockPositionAdapter.sol";
import {MockToken} from "test/mocks/MockToken.sol";
import {VaultColdLink} from "./VaultColdLink.sol";

/**
 * @notice Local demo stack on an Anvil FORK of Robinhood Chain — the fork sibling of DemoLocal.s.sol.
 *
 * Deploys TWO real vaults (and, opt-in, the mock "stocks" vault of DemoLocal.s.sol):
 *   - "demo"   — basket [USDG, WETH] = the REAL RHC tokens, receipt `sunEthLP`, NINE real adapters: ONE
 *                UniswapV3Adapter (USDG/WETH fee-100 pool; range ±300, TWAP 1800 s, slippage 100 bps) + EIGHT identical
 *                UniswapV4NativeEthAdapters on the NATIVE ETH/USDG v4 pool behind the FablesRampETH hook (dynamic fee,
 *                spacing 10; TWAP reference = the same v3 fee-100 pool; swap venue = the native pool itself through a
 *                dedicated UniversalRouterNativeSwapExecutor — the WETH⇄ETH bridge; params mirror
 *                test/fork/FablesRampEthUsdg.fork.t.sol: range ±600, TWAP 1800 s, slippage 200 bps). The basket holds
 *                WETH, never native ETH. The keeper seeds all nine with equal slices, so a deposit fans out over all.
 *                The former hookless UniswapV4Adapter (fee 500 / spacing 10) is no longer deployed by default —
 *                `DEMO_DEPLOY_V4_HOOKLESS=true` brings it back (then ten adapters).
 *   - "pons"   — basket [USDG, PONS] = the REAL RHC tokens, receipt `sunPonsLP`, EIGHT identical REAL
 *                UniswapV4HookedAdapters on the PONS/USDG v4 pool behind the FablesRamp hook (dynamic fee, spacing 60;
 *                TWAP reference = the v3 PONS/USDG fee-10000 pool; swap venue = the hooked v4 pool itself, the deep
 *                venue). Params mirror test/fork/FablesRampPons.fork.t.sol: range ±600 ticks, TWAP window 1800 s,
 *                max slippage 200 bps. The keeper seeds all eight with equal slices.
 *   - "stocks" — OFF by default; `DEMO_DEPLOY_STOCKS=true` deploys it as before (mUSDG + 5 mock stocks, receipt
 *                `sun5StocksLP`, mock adapters) and adds it to the registry between "demo" and "pons".
 * Plus the zap periphery, both owned by OWNER and registered to the "demo" vault only: `MySunZapIn` (route USDG → WETH)
 * and `MySunZapOut` (route WETH → USDG), both TWAP-window 600 s / slippage 50 bps / deviation 50 bps on the same
 * fee-100 pool — and the strategy-layer `PlanExecutor` for the "demo" vault (owned by OWNER; a vault keeper itself,
 * KEEPER whitelisted on it).
 * Genesis (owner deposits real USDG/WETH in kind → K) → keeper `deployTo` into EVERY real adapter (real
 * swaps, real LP NFTs owned by the adapters — asserted below). Writes `shared/deployment.local.json` (v2)
 * with extra root fields: `"fork": true`, `"mintable": false` (DemoLocal.s.sol omits both: absent = not a
 * fork, MockToken.mint available) and `"periphery"` = the two zaps + the plan executor
 * (`zapIn` / `zapOut` / `planExecutor`).
 *
 * Prerequisites — `script/fork-demo-up.sh` does all of this, in order:
 *   1. anvil --fork-url https://rpc.mainnet.chain.robinhood.com --chain-id 46630 --host 0.0.0.0 --port 8547
 *   2. fund OWNER / DEMO_USER / TRADER with real USDG + WETH (impersonate the fee-100 pool, transfer) and real PONS
 *      (impersonate 0x…dEaD, transfer)
 *   3. cast rpc evm_increaseTime 1800 && cast rpc evm_mine   — the adapters' spot≈TWAP guard: on a frozen
 *      fork, one window forward makes the pool's 1800 s TWAP equal its spot (the fork suites' vm.warp)
 *   4. forge clean && forge build   (OZ plugin: fresh single build-info)
 *   5. forge script script/DemoLocalFork.s.sol --rpc-url http://127.0.0.1:8547 --broadcast \
 *        --private-key $DEPLOYER_KEY    # anvil #201 (= OWNER) — LOCAL ONLY public test key
 *
 * Deployer = anvil #201 of the public test mnemonic, NOT #0/#200: those keys are world-known and third parties
 * use them on RHC mainnet (nonces drifted: 0x6f3/0x6fc for #0, 89 for #200 at fork block 83309800), so every CREATE
 * address of the stack drifts with it. #201 has never sent a transaction on RHC (nonce 0), so the stack's
 * addresses only change when this script does. Both broadcast phases run `vm.startBroadcast(OWNER)`: forge
 * refuses to run unless the key it was given IS #201.
 *
 * The dev keys/accounts below are the publicly known Anvil defaults. LOCAL ONLY — the fork is a private
 * copy of the chain; nothing here is ever broadcast to Robinhood Chain.
 */
contract DemoLocalFork is Script, VaultColdLink {
    /* ================ Anvil dev accounts (public, well-known — LOCAL ONLY) ================ */
    address internal constant OWNER = 0x9B63F0Cef479924E5d2C4E22DBE31E6d0353B448; // #201, deployer (nonce-stable)
    address internal constant KEEPER = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8; // #1, keeper service
    address internal constant DEMO_USER = 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC; // #2, frontend tester
    uint256 internal constant ANVIL_KEY_1 = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d; // #1 — LOCAL ONLY

    /// @dev RPC written into the JSON — the shared dev chain, regardless of which RPC this run used.
    string internal constant RPC_URL = "http://127.0.0.1:8547";
    uint16 internal constant FEE_BPS = 1000; // 10% performance fee (both vaults)
    uint256 internal constant EXPECTED_CHAIN_ID = 46630; // the fork runs with the RHC testnet id

    /* ============ verified RHC addresses (notes/RHC_ADDRESSES.md — never invent one) ============ */
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168; // 6 dp, v3/v4 token1
    address internal constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73; // 18 dp, v3/v4 token0
    address internal constant POOL_FEE100 = 0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca; // v3 USDG/WETH 0.01%
    address internal constant NFPM = 0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3; // v3 NonfungiblePositionManager
    /// @dev Official UniversalRouter 2.1.2 (Uniswap `deploy-addresses/robinhood.json`) — the adapters' swap router.
    address internal constant UNIVERSAL_ROUTER = 0x204FAca1764B154221e35c0d20aBb3c525710498;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3; // canonical
    address internal constant POSM = 0x58daec3116aae6D93017bAAea7749052E8a04fA7; // v4 PositionManager
    uint24 internal constant V4_FEE = 500;
    int24 internal constant V4_TICK_SPACING = 10;

    /* ---------------- adapter params (mirror test/fork/*.fork.t.sol) ---------------- */
    int24 internal constant RANGE_BELOW = 300;
    int24 internal constant RANGE_ABOVE = 300;
    uint32 internal constant TWAP_WINDOW = 1800;
    uint16 internal constant MAX_SLIPPAGE_BPS = 100;

    /* ---------------- zap periphery params (zap-in / zap-out) ---------------- */
    uint16 internal constant ZAP_TWAP_WINDOW = 600;
    uint16 internal constant ZAP_SLIP_BPS = 50;
    uint16 internal constant ZAP_DEV_BPS = 50;

    /* ---------------- vault A: "demo" (USDG / WETH, real) ---------------- */
    /// @dev Genesis K: demo stand-in for the team's one-time off-chain valuation of the seed basket
    ///      (10 WETH + its USDG equivalent ≈ 2 × 26.8k USDG at the fork's spot → ≈ 1 USDG per sunEthLP).
    uint256 internal constant GENESIS_SHARES = 50_000e18;
    uint256 internal constant GEN_WETH = 10e18;
    uint256 internal constant MAX_TOTAL_SUPPLY = 500_000e18;
    /// @dev The native ETH/USDG v4 pool (currency0 = native ETH) behind FablesRampETH (bits 0x2080, fee-override only).
    address internal constant FABLES_RAMP_ETH = 0x06a889870C8f83640D6816319f72e2aA579b6080;
    uint24 internal constant ETH_V4_FEE = 0x800000; // LPFeeLibrary.DYNAMIC_FEE_FLAG — the hook resolves each swap's fee
    int24 internal constant ETH_V4_TICK_SPACING = 10;
    bytes32 internal constant ETH_V4_POOL_ID = 0xbac3aa3b91584a53a579b3c999a56756e954e59247e497bad1d25a4334bde551;
    int24 internal constant ETH_RANGE = 600; // ±600 ticks around the TWAP, snapped outward to spacing 10
    /// @dev 2%: covers the hook fee (700 pips live), impact and the v4-spot / v3-TWAP basis.
    uint16 internal constant ETH_MAX_SLIPPAGE_BPS = 200;
    uint256 internal constant N_NATIVE_ADAPTERS = 8; // 1 + 7 identical mirrors — the deposit split fans out over all

    /* ---------------- opt-in sections (env, default OFF — the final demo spec is "demo" + "pons") ---------------- */
    /// @dev `DEMO_DEPLOY_STOCKS=true`: also deploy the mock "stocks" vault (and list it in the registry).
    bool internal deployStocks;
    /// @dev `DEMO_DEPLOY_V4_HOOKLESS=true`: also deploy the hookless UniswapV4Adapter on the "demo" vault.
    bool internal deployV4Hookless;

    /* ---------------- vault B: "stocks" (mUSDG + 5 stocks) — as DemoLocal.s.sol ---------------- */
    uint256 internal constant STOCKS_GENESIS_SHARES = 25_000e18;
    uint256 internal constant STOCKS_MAX_TOTAL_SUPPLY = 1_000_000e18;
    uint256 internal constant N_STOCKS = 5;

    struct DemoVault {
        address vault;
        address depositSplit; // the implementation's DepositSplit (not written to deployment.local.json)
        address[] basket; // [USDG, WETH] — vault registry order
        UniswapV3Adapter adapterV3;
        UniswapV4Adapter adapterV4; // address(0) unless DEMO_DEPLOY_V4_HOOKLESS
        address swapExecutor; // the shared ERC-20 executor (v3 / v4 / hooked adapters; not in deployment.local.json)
        UniswapV4NativeEthAdapter[] natives; // N_NATIVE_ADAPTERS identical adapters, pool order [WETH, USDG]
        address nativeExecutor; // the natives' UniversalRouterNativeSwapExecutor (not in deployment.local.json)
    }

    /* ---------------- vault C: "pons" (USDG / PONS, real hooked v4) ---------------- */
    address internal constant PONS = 0x39dBED3a2bd333467115dE45665cC57F813C4571; // 18 dp, v3/v4 token0
    /// @dev FablesRamp: permission bits 0x2080 (beforeInitialize + beforeSwap) — a fee-override-only hook.
    address internal constant FABLES_RAMP = 0x08E52564Bad99E05a694b4809F397edcA417A080;
    /// @dev v3 PONS/USDG fee-10000 — the factory's canonical pool for the pair: the adapters' TWAP reference only.
    address internal constant REF_POOL_PONS = 0x7A192E71564ec66eE0763e328a3Ac274942dE4e1;
    uint24 internal constant PONS_V4_FEE = 0x800000; // LPFeeLibrary.DYNAMIC_FEE_FLAG — the hook resolves each swap's fee
    int24 internal constant PONS_V4_TICK_SPACING = 60;
    bytes32 internal constant PONS_V4_POOL_ID = 0x486435a1f76cd58193f854c6e6213cd05fd58d637865d02065ff558b387fa6ea;
    int24 internal constant PONS_RANGE = 600; // ±600 ticks around the TWAP, snapped outward to spacing 60
    /// @dev 2%: covers the hook fee (~35–57 bps per swap), impact and the v4-spot / v3-TWAP basis (tens of ticks).
    uint16 internal constant PONS_MAX_SLIPPAGE_BPS = 200;
    uint256 internal constant N_PONS_ADAPTERS = 8; // 1 + 7 identical mirrors — the deposit split fans out over all
    /// @dev Genesis K: demo stand-in for the one-time off-chain valuation (10k PONS + its USDG equivalent ≈
    ///      2 × 4.1k USDG at PONS ≈ 0.41 USDG → ≈ 1 USDG per sunPonsLP, the same display convention as "demo").
    uint256 internal constant PONS_GENESIS_SHARES = 8_000e18;
    uint256 internal constant GEN_PONS = 10_000e18;
    uint256 internal constant PONS_MAX_TOTAL_SUPPLY = 500_000e18;

    struct PonsVault {
        address vault;
        address[] basket; // [USDG, PONS] — vault registry order
        UniswapV4HookedAdapter[] adapters; // N_PONS_ADAPTERS identical adapters, pool order [PONS, USDG]
        address swapExecutor; // the demo vault's shared stateless executor
    }

    struct StocksVault {
        address vault;
        address[] basket; // [mUSDG, mNVDA, mAAPL, mTSLA, mSPY, mGME]
        MockPositionAdapter[] pairs; // pairs[i] = [mUSDG, stock i]
    }

    function run() external {
        require(block.chainid == EXPECTED_CHAIN_ID, "DemoLocalFork: not the local fork (chain id)");
        require(
            USDG.code.length > 0 && POOL_FEE100.code.length > 0, "DemoLocalFork: RHC contracts missing - not a fork"
        );
        deployStocks = vm.envOr("DEMO_DEPLOY_STOCKS", false);
        deployV4Hookless = vm.envOr("DEMO_DEPLOY_V4_HOOKLESS", false);
        uint256 genUsdg = _usdgFor(GEN_WETH);
        uint256 genUsdgPons = _usdgForPons(GEN_PONS);
        require(
            IERC20(USDG).balanceOf(OWNER) >= genUsdg + genUsdgPons && IERC20(WETH).balanceOf(OWNER) >= GEN_WETH
                && IERC20(PONS).balanceOf(OWNER) >= GEN_PONS,
            "DemoLocalFork: OWNER not funded - run script/fork-demo-up.sh (funding step)"
        );

        /* ------------- phase 1: deploy stacks + periphery + genesis deposits (deployer = anvil #201) ------------- */
        vm.startBroadcast(OWNER);
        DemoVault memory a = _deployDemoVault(genUsdg);
        (address zapIn, address zapOut) = _deployPeriphery(a.vault);
        address planExecutor = _deployPlanExecutor(a.vault);
        StocksVault memory b;
        if (deployStocks) {
            b = _deployStocksVault(Upgrades.getImplementationAddress(a.vault));
        }
        vm.stopBroadcast();

        /* ------- phase 2: keeper deploys capital into the REAL adapters (+ mock pairs, opt-in) (anvil #1) ------- */
        vm.startBroadcast(ANVIL_KEY_1);
        _keeperDemo(a);
        if (deployStocks) {
            _keeperStocks(b);
        }
        vm.stopBroadcast();

        _assertRealPositions(a);

        /* --- phase 3: vault "pons" — deployed AFTER everything above, so every earlier address is unchanged --- */
        vm.startBroadcast(OWNER);
        PonsVault memory c = _deployPonsVault(a.swapExecutor, a.depositSplit, genUsdgPons);
        vm.stopBroadcast();

        /* ----------- phase 4: keeper seeds all eight hooked adapters with equal slices (anvil #1) ----------- */
        vm.startBroadcast(ANVIL_KEY_1);
        _keeperPons(c);
        vm.stopBroadcast();

        _assertPonsPositions(c);

        /* ------------------------------ logs + shared/deployment.local.json ------------------------------ */
        console2.log("== MySun local demo stack on the RHC fork (demo + pons, zap periphery + plan executor) ==");
        console2.log("chainId          :", block.chainid);
        console2.log("block            :", block.number);
        console2.log("owner            :", OWNER);
        console2.log("keeper           :", KEEPER);
        console2.log("demo user        :", DEMO_USER);
        console2.log("USDG (real)      :", USDG);
        console2.log("WETH (real)      :", WETH);
        console2.log("PONS (real)      :", PONS);
        console2.log("zap-in           :", zapIn);
        console2.log("zap-out          :", zapOut);
        console2.log("plan-executor    :", planExecutor);
        _logDemo(a);
        if (deployStocks) {
            console2.log("mUSDG (mock)     :", b.basket[0]);
            _logStocks(b);
        }
        _logPons(c);

        string memory vaultsJson = string.concat(
            "[", _vaultJson("demo", "USDG / WETH basket (RHC fork - real Uniswap v3 + Fables ETH v4)", a.vault)
        );
        if (deployStocks) {
            vaultsJson =
                string.concat(vaultsJson, ",", _vaultJson("stocks", "Stock-pair basket (5 stocks + mUSDG)", b.vault));
        }
        vaultsJson = string.concat(
            vaultsJson,
            ",",
            _vaultJson("pons", "PONS / USDG basket (RHC fork - real Uniswap v4 FablesRamp)", c.vault),
            "]"
        );
        string memory periphObj = "periphery";
        vm.serializeAddress(periphObj, "zapIn", zapIn);
        vm.serializeAddress(periphObj, "zapOut", zapOut);
        string memory periphJson = vm.serializeAddress(periphObj, "planExecutor", planExecutor);
        // Seed the root via serializeJson: serializeString would store a JSON *array* as an escaped
        // string (only object-shaped values are parsed), so `vaults` / `periphery` go in as parsed JSON.
        string memory root = "deployment";
        vm.serializeJson(root, string.concat("{\"vaults\":", vaultsJson, ",\"periphery\":", periphJson, "}"));
        vm.serializeUint(root, "version", 2);
        vm.serializeUint(root, "chainId", block.chainid);
        // Optional v2 root fields; absent (DemoLocal.s.sol) = fork false / mintable true.
        vm.serializeBool(root, "fork", true);
        vm.serializeBool(root, "mintable", false);
        string memory json = vm.serializeString(root, "rpcUrl", RPC_URL);
        vm.writeJson(json, "../shared/deployment.local.json");
        console2.log(
            deployStocks
                ? "wrote ../shared/deployment.local.json (schema v2, 3 vaults: demo, stocks, pons; fork, periphery)"
                : "wrote ../shared/deployment.local.json (schema v2, 2 vaults: demo, pons; fork, periphery)"
        );
    }

    /* =============================== vault A: "demo" (real) =============================== */

    function _deployDemoVault(uint256 genUsdg) internal returns (DemoVault memory a) {
        a.basket = new address[](2);
        a.basket[0] = USDG;
        a.basket[1] = WETH;

        // The stateless deposit splitter the implementation pins (immutable); shared by both vaults' proxies.
        a.depositSplit = address(new DepositSplit());
        Options memory opts;
        opts.constructorData = abi.encode(a.depositSplit);
        a.vault = Upgrades.deployUUPSProxy(
            "MySunVaultUpgradeable.sol",
            abi.encodeCall(
                MySunVaultUpgradeable(address(0)).initialize,
                (OWNER, "sunEthLP", "sunEthLP", a.basket, OWNER, FEE_BPS, GENESIS_SHARES, MAX_TOTAL_SUPPLY)
            ),
            opts
        );

        a.swapExecutor = address(new UniversalRouterSwapExecutor(UNIVERSAL_ROUTER, PERMIT2));
        a.adapterV3 = new UniswapV3Adapter(
            UniswapV3Adapter.Config({
                vault: a.vault,
                pool: POOL_FEE100,
                positionManager: NFPM,
                swapRouter: UNIVERSAL_ROUTER,
                permit2: PERMIT2,
                swapExecutor: a.swapExecutor,
                owner: OWNER,
                rangeTicksBelow: RANGE_BELOW,
                rangeTicksAbove: RANGE_ABOVE,
                twapWindow: TWAP_WINDOW,
                maxSlippageBps: MAX_SLIPPAGE_BPS
            })
        );
        if (deployV4Hookless) {
            a.adapterV4 = _deployHooklessV4(a);
        }
        _deployNatives(a);

        MySunVaultUpgradeable vaultC = MySunVaultUpgradeable(a.vault);
        vaultC.addAdapter(IPositionAdapter(address(a.adapterV3)));
        if (deployV4Hookless) {
            vaultC.addAdapter(IPositionAdapter(address(a.adapterV4)));
        }
        for (uint256 i; i < N_NATIVE_ADAPTERS; ++i) {
            vaultC.addAdapter(IPositionAdapter(address(a.natives[i])));
        }
        vaultC.setKeeper(KEEPER, true);

        // Genesis deposit — owner-only (this broadcast is anvil #201 == OWNER), REAL tokens funded by
        // fork-demo-up.sh: a 50/50 basket at the pool's spot, in kind; mints exactly GENESIS_SHARES (K). No adapter
        // holds anything yet, so the deposit split skips them all and the genesis stays idle for the keeper phase.
        IERC20(USDG).approve(a.vault, genUsdg);
        IERC20(WETH).approve(a.vault, GEN_WETH);
        vaultC.deposit(a.basket, _pair(genUsdg, GEN_WETH), GENESIS_SHARES, OWNER);
    }

    /// @dev The former second "demo" adapter, opt-in (`DEMO_DEPLOY_V4_HOOKLESS`): hookless USDG/WETH fee-500 v4 pool.
    function _deployHooklessV4(DemoVault memory a) internal returns (UniswapV4Adapter) {
        return new UniswapV4Adapter(
            UniswapV4Adapter.Config({
                vault: a.vault,
                positionManager: POSM,
                poolKey: PoolKey({
                    currency0: WETH, currency1: USDG, fee: V4_FEE, tickSpacing: V4_TICK_SPACING, hooks: address(0)
                }),
                refPool: POOL_FEE100,
                swapRouter: UNIVERSAL_ROUTER,
                swapExecutor: a.swapExecutor,
                owner: OWNER,
                rangeTicksBelow: RANGE_BELOW,
                rangeTicksAbove: RANGE_ABOVE,
                twapWindow: TWAP_WINDOW,
                maxSlippageBps: MAX_SLIPPAGE_BPS
            })
        );
    }

    /// @dev The dedicated native executor (the router, and the PositionManager's own Permit2 and WETH9 — read from the
    ///      fork exactly as the adapter's constructor does) + EIGHT identical native adapters on the V4_POOL venue.
    function _deployNatives(DemoVault memory a) internal {
        a.nativeExecutor = address(
            new UniversalRouterNativeSwapExecutor(
                UNIVERSAL_ROUTER, IPositionManagerMinimal(POSM).permit2(), INativeWrapperMinimal(POSM).WETH9()
            )
        );
        a.natives = new UniswapV4NativeEthAdapter[](N_NATIVE_ADAPTERS);
        for (uint256 i; i < N_NATIVE_ADAPTERS; ++i) {
            a.natives[i] = new UniswapV4NativeEthAdapter(
                UniswapV4NativeEthAdapter.Config({
                    vault: a.vault,
                    positionManager: POSM,
                    poolKey: _ethKey(),
                    refPool: POOL_FEE100,
                    swapRouter: UNIVERSAL_ROUTER,
                    swapExecutor: a.nativeExecutor,
                    owner: OWNER,
                    rangeTicksBelow: ETH_RANGE,
                    rangeTicksAbove: ETH_RANGE,
                    twapWindow: TWAP_WINDOW,
                    maxSlippageBps: ETH_MAX_SLIPPAGE_BPS
                })
            );
            // The native pool is the chain's deepest USDG/WETH venue: swap there (through the native executor).
            a.natives[i].setSwapVenue(UniswapV4NativeEthAdapter.SwapVenue.V4_POOL);
        }
    }

    function _ethKey() internal pure returns (PoolKey memory) {
        return PoolKey({
            currency0: address(0),
            currency1: USDG,
            fee: ETH_V4_FEE,
            tickSpacing: ETH_V4_TICK_SPACING,
            hooks: FABLES_RAMP_ETH
        });
    }

    /* ============================ zap periphery (vault "demo" only) ============================ */

    /// @dev Zap-in + zap-out, owned by OWNER (this broadcast), registered to the "demo" vault only (the mock
    ///      stocks have no venue to route through). The routes mirror the adapters' venue: USDG ↔ WETH on the
    ///      same fee-100 pool, with the zap guard window (600 s) and the published defaults (50 / 50 bps).
    function _deployPeriphery(address vault) internal returns (address zapIn, address zapOut) {
        zapIn = address(new MySunZapIn(UNIVERSAL_ROUTER, PERMIT2, OWNER));
        zapOut = address(new MySunZapOut(UNIVERSAL_ROUTER, PERMIT2, OWNER));
        MySunZapIn(zapIn).registerVault(vault);
        MySunZapIn(zapIn).setRoute(USDG, WETH, 100, POOL_FEE100, ZAP_TWAP_WINDOW, ZAP_SLIP_BPS, ZAP_DEV_BPS);
        MySunZapOut(zapOut).registerVault(vault);
        MySunZapOut(zapOut).setRoute(WETH, USDG, 100, POOL_FEE100, ZAP_TWAP_WINDOW, ZAP_SLIP_BPS, ZAP_DEV_BPS);
    }

    /// @dev Strategy-layer P3 executor for the "demo" vault, owned by OWNER (this broadcast): a vault keeper itself
    ///      (the vault sees IT as `msg.sender` for every plan component) and KEEPER whitelisted to call `executePlan`.
    function _deployPlanExecutor(address vault) internal returns (address planExecutor) {
        planExecutor = address(new PlanExecutor(IMySunVault(vault), OWNER));
        MySunVaultUpgradeable(vault).setKeeper(planExecutor, true);
        PlanExecutor(planExecutor).setKeeper(KEEPER, true);
    }

    /// @dev Equal slices of the vault's idle (floor of 1/n per leg) into EVERY registered adapter — v3, (opt-in hookless
    ///      v4,) the eight natives — so a later deposit fans out over all of them; the division dust stays idle.
    ///      Amounts are in ADAPTER order = pool order [WETH, USDG] for all of them (WETH stands in for the native leg).
    ///      Each deploy swaps the surplus leg into the deficit leg (TWAP-bounded) and mints a real LP position.
    function _keeperDemo(DemoVault memory a) internal {
        MySunVaultUpgradeable vaultC = MySunVaultUpgradeable(a.vault);
        IPositionAdapter[] memory all = vaultC.adapters();
        uint256 sliceWeth = IERC20(WETH).balanceOf(a.vault) / all.length;
        uint256 sliceUsdg = IERC20(USDG).balanceOf(a.vault) / all.length;
        for (uint256 i; i < all.length; ++i) {
            vaultC.deployTo(all[i], _pair(sliceWeth, sliceUsdg));
        }
    }

    /// @dev Proof the flagship vault runs on real venues: each adapter owns exactly one live LP NFT.
    function _assertRealPositions(DemoVault memory a) internal view {
        uint256 id3 = a.adapterV3.tokenId();
        require(id3 != 0, "v3 adapter: no position minted");
        require(INonfungiblePositionManager(NFPM).ownerOf(id3) == address(a.adapterV3), "v3 NFT not owned by adapter");
        require(INonfungiblePositionManager(NFPM).balanceOf(address(a.adapterV3)) == 1, "v3 adapter NFT count != 1");
        if (deployV4Hookless) {
            uint256 id4 = a.adapterV4.tokenId();
            require(id4 != 0, "v4 adapter: no position minted");
            require(IPositionManagerMinimal(POSM).ownerOf(id4) == address(a.adapterV4), "v4 NFT not owned by adapter");
            require(IPositionManagerMinimal(POSM).getPositionLiquidity(id4) > 0, "v4 position has no liquidity");
        }
        _assertNativePositions(a);
    }

    /// @dev The eight natives: each owns exactly one live NFT on the native FablesRampETH pool; the vault's basket view
    ///      reads through every adapter; no ETH rests in an adapter or the native executor; no allowance stands.
    function _assertNativePositions(DemoVault memory a) internal view {
        IPositionManagerMinimal posm = IPositionManagerMinimal(POSM);
        IPositionAdapter[] memory all = MySunVaultUpgradeable(a.vault).adapters();
        require(all.length == 1 + (deployV4Hookless ? 1 : 0) + N_NATIVE_ADAPTERS, "demo vault adapter count");
        uint256 sumWeth = IERC20(WETH).balanceOf(a.vault);
        uint256 sumUsdg = IERC20(USDG).balanceOf(a.vault);
        for (uint256 i; i < all.length; ++i) {
            (, uint256[] memory held) = all[i].position(); // pool order [WETH, USDG] for every demo adapter
            sumWeth += held[0];
            sumUsdg += held[1];
        }
        for (uint256 i; i < N_NATIVE_ADAPTERS; ++i) {
            address ad = address(a.natives[i]);
            uint256 id = a.natives[i].tokenId();
            require(id != 0, "native adapter: no position minted");
            require(posm.balanceOf(ad) == 1, "native adapter NFT count != 1");
            require(posm.ownerOf(id) == ad, "native NFT not owned by adapter");
            (PoolKey memory key,) = posm.getPoolAndPositionInfo(id);
            require(keccak256(abi.encode(key)) == ETH_V4_POOL_ID, "native NFT not on the FablesRampETH pool");
            require(posm.getPositionLiquidity(id) > 0, "native position has no liquidity");
            require(ad.balance == 0, "native adapter holds ETH");
            _assertNativeAllowances(a, ad);
        }
        (address[] memory t, uint256[] memory totals) = MySunVaultUpgradeable(a.vault).totalTokens();
        require(t[0] == USDG && t[1] == WETH, "demo vault registry order");
        require(totals[0] == sumUsdg && totals[1] == sumWeth, "demo vault totals != idle + adapter positions");
        require(a.nativeExecutor.balance == 0, "native executor holds ETH");
        for (uint256 j; j < 2; ++j) {
            address token = a.basket[j];
            require(IERC20(token).balanceOf(a.nativeExecutor) == 0, "native executor holds tokens");
            require(IERC20(token).allowance(a.nativeExecutor, PERMIT2) == 0, "native executor -> Permit2 allowance");
            (uint160 inner,,) = IPermit2Minimal(PERMIT2).allowance(a.nativeExecutor, token, UNIVERSAL_ROUTER);
            require(inner == 0, "native executor Permit2 -> router allowance");
        }
    }

    function _assertNativeAllowances(DemoVault memory a, address ad) internal view {
        for (uint256 j; j < 2; ++j) {
            address token = a.basket[j];
            require(IERC20(token).allowance(a.vault, ad) == 0, "vault -> native adapter allowance");
            require(IERC20(token).allowance(ad, a.nativeExecutor) == 0, "native adapter -> executor allowance");
            require(IERC20(token).allowance(ad, PERMIT2) == 0, "native adapter -> Permit2 allowance");
            require(IERC20(token).allowance(ad, POSM) == 0, "native adapter -> PositionManager allowance");
            (uint160 amount,,) = IPermit2Minimal(PERMIT2).allowance(ad, token, POSM);
            require(amount == 0, "native adapter Permit2 -> PositionManager allowance");
        }
    }

    /* ============================== vault B: "stocks" (mock) ============================== */

    function _deployStocksVault(address implementation) internal returns (StocksVault memory b) {
        MockToken usdg = new MockToken("Mock USDG", "mUSDG", 6);
        MockToken[N_STOCKS] memory stocks = [
            new MockToken("Mock NVDA", "mNVDA", 18),
            new MockToken("Mock AAPL", "mAAPL", 18),
            new MockToken("Mock TSLA", "mTSLA", 18),
            new MockToken("Mock SPY", "mSPY", 18),
            new MockToken("Mock GME", "mGME", 18)
        ];
        bytes32[N_STOCKS] memory poolIds = [
            bytes32("mNVDA/mUSDG 0.30%"),
            bytes32("mAAPL/mUSDG 0.30%"),
            bytes32("mTSLA/mUSDG 0.30%"),
            bytes32("mSPY/mUSDG 0.05%"),
            bytes32("mGME/mUSDG 1.00%")
        ];

        b.basket = new address[](1 + N_STOCKS);
        b.basket[0] = address(usdg);
        for (uint256 i; i < N_STOCKS; ++i) {
            b.basket[1 + i] = address(stocks[i]);
        }

        // Second proxy over the demo vault's implementation (validated by Upgrades.deployUUPSProxy above).
        b.vault = address(
            new ERC1967Proxy(
                implementation,
                abi.encodeCall(
                    MySunVaultUpgradeable(address(0)).initialize,
                    (
                        OWNER,
                        "sun5StocksLP",
                        "sun5StocksLP",
                        b.basket,
                        OWNER,
                        FEE_BPS,
                        STOCKS_GENESIS_SHARES,
                        STOCKS_MAX_TOTAL_SUPPLY
                    )
                )
            )
        );
        MySunVaultUpgradeable vaultC = MySunVaultUpgradeable(b.vault);

        b.pairs = new MockPositionAdapter[](N_STOCKS);
        for (uint256 i; i < N_STOCKS; ++i) {
            address[] memory pairTokens = new address[](2);
            pairTokens[0] = address(usdg);
            pairTokens[1] = address(stocks[i]);
            b.pairs[i] = new MockPositionAdapter(pairTokens, b.vault, bytes32("uniswap-v3"), poolIds[i]);
            vaultC.addAdapter(b.pairs[i]);
        }
        vaultC.setKeeper(KEEPER, true);

        // Fund: owner seeds the stocks basket; demo user gets a spread of every stock.
        usdg.mint(OWNER, 50_000e6);
        usdg.mint(DEMO_USER, 100_000e6);
        usdg.approve(b.vault, type(uint256).max);
        for (uint256 i; i < N_STOCKS; ++i) {
            stocks[i].mint(OWNER, 100e18);
            stocks[i].mint(DEMO_USER, 50e18);
            stocks[i].approve(b.vault, type(uint256).max);
        }

        // Genesis deposit — owner-only; mints exactly STOCKS_GENESIS_SHARES (K).
        uint256[] memory boot = new uint256[](1 + N_STOCKS);
        boot[0] = 20_000e6;
        for (uint256 i; i < N_STOCKS; ++i) {
            boot[1 + i] = 10e18;
        }
        vaultC.deposit(b.basket, boot, STOCKS_GENESIS_SHARES, OWNER);
    }

    function _keeperStocks(StocksVault memory b) internal {
        MySunVaultUpgradeable vaultC = MySunVaultUpgradeable(b.vault);
        // Two of the five pairs get capital (NVDA, AAPL); the other three stay empty (idle-only legs).
        vaultC.deployTo(b.pairs[0], _pair(4_000e6, 4e18));
        vaultC.deployTo(b.pairs[1], _pair(3_000e6, 3e18));

        b.pairs[0].simulateFees(_pair(40e6, 0.04e18));
        b.pairs[1].simulateFees(_pair(30e6, 0.03e18));
    }

    /* ======================== vault C: "pons" (real, FablesRamp-hooked v4) ======================== */

    /// @dev Phase 3 (anvil #201 == OWNER). The vault goes through the OZ plugin like "demo" (its own validated
    ///      implementation, same DepositSplit); the eight adapters share the demo vault's stateless swap executor.
    function _deployPonsVault(address swapExecutor, address depositSplit, uint256 genUsdg)
        internal
        returns (PonsVault memory c)
    {
        c.basket = new address[](2);
        c.basket[0] = USDG;
        c.basket[1] = PONS;
        c.swapExecutor = swapExecutor;

        Options memory opts;
        opts.constructorData = abi.encode(depositSplit);
        c.vault = Upgrades.deployUUPSProxy(
            "MySunVaultUpgradeable.sol",
            abi.encodeCall(
                MySunVaultUpgradeable(address(0)).initialize,
                (OWNER, "sunPonsLP", "sunPonsLP", c.basket, OWNER, FEE_BPS, PONS_GENESIS_SHARES, PONS_MAX_TOTAL_SUPPLY)
            ),
            opts
        );
        MySunVaultUpgradeable vaultC = MySunVaultUpgradeable(c.vault);

        c.adapters = new UniswapV4HookedAdapter[](N_PONS_ADAPTERS);
        for (uint256 i; i < N_PONS_ADAPTERS; ++i) {
            c.adapters[i] = new UniswapV4HookedAdapter(
                UniswapV4HookedAdapter.Config({
                    vault: c.vault,
                    positionManager: POSM,
                    poolKey: _ponsKey(),
                    refPool: REF_POOL_PONS,
                    swapRouter: UNIVERSAL_ROUTER,
                    swapExecutor: swapExecutor,
                    owner: OWNER,
                    rangeTicksBelow: PONS_RANGE,
                    rangeTicksAbove: PONS_RANGE,
                    twapWindow: TWAP_WINDOW,
                    maxSlippageBps: PONS_MAX_SLIPPAGE_BPS
                })
            );
            // The hooked v4 pool is the pair's deep venue (the v3 fee-10000 reference is thin): swap there.
            c.adapters[i].setSwapVenue(UniswapV4HookedAdapter.SwapVenue.V4_POOL);
            vaultC.addAdapter(IPositionAdapter(address(c.adapters[i])));
        }
        vaultC.setKeeper(KEEPER, true);

        // Genesis deposit — owner-only, REAL tokens funded by fork-demo-up.sh: a 50/50 basket at the reference
        // pool's spot, in kind; mints exactly PONS_GENESIS_SHARES (K). No adapter holds anything yet, so the
        // deposit split skips them all and the genesis stays idle for the keeper phase.
        IERC20(USDG).approve(c.vault, genUsdg);
        IERC20(PONS).approve(c.vault, GEN_PONS);
        vaultC.deposit(c.basket, _pair(genUsdg, GEN_PONS), PONS_GENESIS_SHARES, OWNER);
    }

    /// @dev Phase 4 (anvil #1 == KEEPER): equal slices of the vault's idle (floor of 1/8 per leg) into each adapter, in
    ///      ADAPTER order = pool order [PONS, USDG]. Each deploy runs its ratio swap on the hooked pool (TWAP-bounded,
    ///      hook-priced) and mints a real position; the < 8 wei per leg of division dust stays idle in the vault.
    function _keeperPons(PonsVault memory c) internal {
        MySunVaultUpgradeable vaultC = MySunVaultUpgradeable(c.vault);
        uint256 slicePons = IERC20(PONS).balanceOf(c.vault) / N_PONS_ADAPTERS;
        uint256 sliceUsdg = IERC20(USDG).balanceOf(c.vault) / N_PONS_ADAPTERS;
        for (uint256 i; i < N_PONS_ADAPTERS; ++i) {
            vaultC.deployTo(IPositionAdapter(address(c.adapters[i])), _pair(slicePons, sliceUsdg));
        }
    }

    /// @dev Proof the "pons" vault runs on the real hooked pool: each adapter owns exactly one live NFT minted on the
    ///      FablesRamp PONS/USDG pool, the vault's basket view reads through all eight, and no allowance stands.
    function _assertPonsPositions(PonsVault memory c) internal view {
        IPositionManagerMinimal posm = IPositionManagerMinimal(POSM);
        uint256 sumPons = IERC20(PONS).balanceOf(c.vault);
        uint256 sumUsdg = IERC20(USDG).balanceOf(c.vault);
        for (uint256 i; i < N_PONS_ADAPTERS; ++i) {
            address ad = address(c.adapters[i]);
            uint256 id = c.adapters[i].tokenId();
            require(id != 0, "pons adapter: no position minted");
            require(posm.balanceOf(ad) == 1, "pons adapter NFT count != 1");
            require(posm.ownerOf(id) == ad, "pons NFT not owned by adapter");
            (PoolKey memory key,) = posm.getPoolAndPositionInfo(id);
            require(keccak256(abi.encode(key)) == PONS_V4_POOL_ID, "pons NFT not on the hooked pool");
            require(posm.getPositionLiquidity(id) > 0, "pons position has no liquidity");
            (, uint256[] memory held) = c.adapters[i].position(); // pool order [PONS, USDG]
            sumPons += held[0];
            sumUsdg += held[1];
            _assertNoAllowances(c, ad);
        }
        (address[] memory t, uint256[] memory totals) = MySunVaultUpgradeable(c.vault).totalTokens();
        require(t[0] == USDG && t[1] == PONS, "pons vault registry order");
        require(totals[0] == sumUsdg && totals[1] == sumPons, "pons vault totals != idle + adapter positions");
        for (uint256 j; j < 2; ++j) {
            address token = c.basket[j];
            require(IERC20(token).balanceOf(c.swapExecutor) == 0, "executor holds tokens");
            require(IERC20(token).allowance(c.swapExecutor, PERMIT2) == 0, "executor -> Permit2 allowance");
            (uint160 inner,,) = IPermit2Minimal(PERMIT2).allowance(c.swapExecutor, token, UNIVERSAL_ROUTER);
            require(inner == 0, "executor Permit2 -> router allowance");
        }
    }

    function _assertNoAllowances(PonsVault memory c, address ad) internal view {
        for (uint256 j; j < 2; ++j) {
            address token = c.basket[j];
            require(IERC20(token).allowance(c.vault, ad) == 0, "vault -> adapter allowance");
            require(IERC20(token).allowance(ad, c.swapExecutor) == 0, "adapter -> executor allowance");
            require(IERC20(token).allowance(ad, PERMIT2) == 0, "adapter -> Permit2 allowance");
            (uint160 amount,,) = IPermit2Minimal(PERMIT2).allowance(ad, token, POSM);
            require(amount == 0, "adapter Permit2 -> PositionManager allowance");
        }
    }

    function _ponsKey() internal pure returns (PoolKey memory) {
        return PoolKey({
            currency0: PONS, currency1: USDG, fee: PONS_V4_FEE, tickSpacing: PONS_V4_TICK_SPACING, hooks: FABLES_RAMP
        });
    }

    /* ==================================== helpers ==================================== */

    /// @dev USDG worth `wethAmount` at the fee-100 pool's spot (token0 = WETH, token1 = USDG) — genesis sizing
    ///      only, the same helper the fork suites use.
    function _usdgFor(uint256 wethAmount) internal view returns (uint256) {
        (uint160 sqrtP,,,,,,) = IUniswapV3PoolMinimal(POOL_FEE100).slot0();
        return Math.mulDiv(Math.mulDiv(wethAmount, sqrtP, 1 << 96), sqrtP, 1 << 96);
    }

    /// @dev USDG worth `ponsAmount` at the v3 PONS/USDG reference pool's spot (token0 = PONS, token1 = USDG) — genesis
    ///      sizing only, the same helper test/fork/FablesRampPons.fork.t.sol uses.
    function _usdgForPons(uint256 ponsAmount) internal view returns (uint256) {
        (uint160 sqrtP,,,,,,) = IUniswapV3PoolMinimal(REF_POOL_PONS).slot0();
        return Math.mulDiv(Math.mulDiv(ponsAmount, sqrtP, 1 << 96), sqrtP, 1 << 96);
    }

    function _pair(uint256 x, uint256 y) internal pure returns (uint256[] memory arr) {
        arr = new uint256[](2);
        arr[0] = x;
        arr[1] = y;
    }

    /// @dev One entry of the v2 `vaults` array; name/symbol are read back from the chain.
    function _vaultJson(string memory key, string memory label, address vault) internal returns (string memory) {
        MySunVaultUpgradeable vaultC = MySunVaultUpgradeable(vault);
        string memory receiptObj = string.concat("receipt_", key);
        vm.serializeString(receiptObj, "name", vaultC.name());
        string memory receipt = vm.serializeString(receiptObj, "symbol", vaultC.symbol());

        string memory obj = string.concat("vault_", key);
        vm.serializeString(obj, "key", key);
        vm.serializeString(obj, "label", label);
        vm.serializeString(obj, "receipt", receipt);
        vm.serializeAddress(obj, "vault", vault);
        vm.serializeAddress(obj, "implementation", Upgrades.getImplementationAddress(vault));
        vm.serializeAddress(obj, "keeper", KEEPER);
        return vm.serializeAddress(obj, "demoUser", DEMO_USER);
    }

    function _logVault(string memory title, address vault) internal view {
        MySunVaultUpgradeable vaultC = MySunVaultUpgradeable(vault);
        console2.log(title);
        console2.log("vault (proxy)    :", vault);
        console2.log("implementation   :", Upgrades.getImplementationAddress(vault));
        console2.log("name / symbol    :", vaultC.name(), vaultC.symbol());
        console2.log("genesis shares   :", vaultC.genesisShares());
        console2.log("totalSupply      :", vaultC.totalSupply());
        console2.log("maxTotalSupply   :", vaultC.maxTotalSupply());
        (address[] memory t, uint256[] memory amt) = vaultC.totalTokens();
        for (uint256 i; i < t.length; ++i) {
            console2.log("total", IERC20Metadata(t[i]).symbol(), amt[i]);
        }
        for (uint256 i; i < t.length; ++i) {
            console2.log("idle ", IERC20Metadata(t[i]).symbol(), IERC20(t[i]).balanceOf(vault));
        }
    }

    function _logAdapter(string memory title, IPositionAdapter adapter, uint256 tokenId) internal view {
        (address[] memory t, uint256[] memory amt) = adapter.position();
        console2.log(title, address(adapter));
        console2.log("  LP NFT tokenId :", tokenId);
        for (uint256 i; i < t.length; ++i) {
            console2.log("  position", IERC20Metadata(t[i]).symbol(), amt[i]);
        }
    }

    function _logDemo(DemoVault memory a) internal view {
        _logVault("-- vault [demo] --", a.vault);
        console2.log("deposit splitter :", a.depositSplit);
        _logAdapter("adapter (v3 REAL):", IPositionAdapter(address(a.adapterV3)), a.adapterV3.tokenId());
        console2.log("  tickLower      :", int256(a.adapterV3.tickLower()));
        console2.log("  tickUpper      :", int256(a.adapterV3.tickUpper()));
        if (deployV4Hookless) {
            _logAdapter("adapter (v4 REAL):", IPositionAdapter(address(a.adapterV4)), a.adapterV4.tokenId());
            console2.log("  tickLower      :", int256(a.adapterV4.tickLower()));
            console2.log("  tickUpper      :", int256(a.adapterV4.tickUpper()));
        }
        console2.log("swap executor    :", a.swapExecutor);
        console2.log("native executor  :", a.nativeExecutor);
        console2.log("hook (FablesRampETH):", FABLES_RAMP_ETH);
        for (uint256 i; i < a.natives.length; ++i) {
            UniswapV4NativeEthAdapter ad = a.natives[i];
            _logAdapter("adapter (v4 native REAL):", IPositionAdapter(address(ad)), ad.tokenId());
            console2.log("  liquidity      :", IPositionManagerMinimal(POSM).getPositionLiquidity(ad.tokenId()));
            console2.log("  tickLower      :", int256(ad.tickLower()));
            console2.log("  tickUpper      :", int256(ad.tickUpper()));
        }
    }

    function _logStocks(StocksVault memory b) internal view {
        _logVault("-- vault [stocks] --", b.vault);
        for (uint256 i; i < b.pairs.length; ++i) {
            console2.log("adapter (pair)   :", MockToken(b.basket[1 + i]).symbol(), address(b.pairs[i]));
        }
    }

    function _logPons(PonsVault memory c) internal view {
        _logVault("-- vault [pons] --", c.vault);
        console2.log("TWAP reference   :", REF_POOL_PONS);
        console2.log("hook (FablesRamp):", FABLES_RAMP);
        for (uint256 i; i < c.adapters.length; ++i) {
            UniswapV4HookedAdapter ad = c.adapters[i];
            _logAdapter("adapter (v4 hooked REAL):", IPositionAdapter(address(ad)), ad.tokenId());
            console2.log("  liquidity      :", IPositionManagerMinimal(POSM).getPositionLiquidity(ad.tokenId()));
            console2.log("  tickLower      :", int256(ad.tickLower()));
            console2.log("  tickUpper      :", int256(ad.tickUpper()));
        }
    }
}
