// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import {Script, console2} from "forge-std/Script.sol";
import {Upgrades} from "openzeppelin-foundry-upgrades/Upgrades.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {MySunVaultUpgradeable} from "contracts/MySunVaultUpgradeable.sol";
import {IPositionAdapter} from "contracts/interfaces/IPositionAdapter.sol";
import {UniswapV3Adapter} from "contracts/adapters/UniswapV3Adapter.sol";
import {UniswapV4Adapter} from "contracts/adapters/UniswapV4Adapter.sol";
import {IUniswapV3PoolMinimal} from "contracts/adapters/uniswap/IUniswapV3PoolMinimal.sol";
import {INonfungiblePositionManager} from "contracts/adapters/uniswap/INonfungiblePositionManager.sol";
import {PoolKey} from "contracts/adapters/uniswap/v4/IPoolManagerMinimal.sol";
import {IPositionManagerMinimal} from "contracts/adapters/uniswap/v4/IPositionManagerMinimal.sol";
import {MySunZapIn} from "contracts/periphery/MySunZapIn.sol";
import {MySunZapOut} from "contracts/periphery/MySunZapOut.sol";
import {PlanExecutor} from "contracts/periphery/PlanExecutor.sol";
import {IMySunVault} from "contracts/interfaces/IMySunVault.sol";
import {UniversalRouterSwapExecutor} from "contracts/swap/UniversalRouterSwapExecutor.sol";
import {MockPositionAdapter} from "test/mocks/MockPositionAdapter.sol";
import {MockToken} from "test/mocks/MockToken.sol";

/**
 * @notice Local demo stack on an Anvil FORK of Robinhood Chain — the fork sibling of DemoLocal.s.sol.
 *
 * Deploys the same TWO vaults, but the flagship one is real:
 *   - "demo"   — basket [USDG, WETH] = the REAL RHC tokens, receipt `sunEthLP`, the REAL UniswapV3Adapter
 *                (USDG/WETH fee-100 pool) and the REAL UniswapV4Adapter (fee 500 / spacing 10 / no hooks;
 *                TWAP reference + default swap venue = the same v3 fee-100 pool). Both swap through the official
 *                UniversalRouter 2.1.2 (Permit2-pulled). Params mirror the fork suites:
 *                range ±300 ticks, TWAP window 1800 s, max slippage 100 bps.
 *   - "stocks" — unchanged from DemoLocal.s.sol: mUSDG + 5 mock stocks, receipt `sun5StocksLP`, mock adapters.
 * Plus the zap periphery, both owned by OWNER and registered to the "demo" vault only (the mock stocks have
 * no venue to route through): `MySunZapIn` (route USDG → WETH) and `MySunZapOut` (route WETH → USDG),
 * both TWAP-window 600 s / slippage 50 bps / deviation 50 bps on the same fee-100 pool — and the strategy-layer
 * `PlanExecutor` for the "demo" vault (owned by OWNER; a vault keeper itself, KEEPER whitelisted on it).
 * Genesis (owner deposits real USDG/WETH in kind → K) → keeper `deployTo` into BOTH real adapters (real
 * swaps, real LP NFTs owned by the adapters — asserted below). Writes `shared/deployment.local.json` (v2)
 * with extra root fields: `"fork": true`, `"mintable": false` (DemoLocal.s.sol omits both: absent = not a
 * fork, MockToken.mint available) and `"periphery"` = the two zaps + the plan executor
 * (`zapIn` / `zapOut` / `planExecutor`).
 *
 * Prerequisites — `script/fork-demo-up.sh` does all of this, in order:
 *   1. anvil --fork-url https://rpc.mainnet.chain.robinhood.com --chain-id 46630 --host 0.0.0.0 --port 8547
 *   2. fund OWNER / DEMO_USER / TRADER with real USDG + WETH (impersonate the fee-100 pool, transfer)
 *   3. cast rpc evm_increaseTime 1800 && cast rpc evm_mine   — the adapters' spot≈TWAP guard: on a frozen
 *      fork, one window forward makes the pool's 1800 s TWAP equal its spot (the fork suites' vm.warp)
 *   4. forge clean && forge build   (OZ plugin: fresh single build-info)
 *   5. forge script script/DemoLocalFork.s.sol --rpc-url http://127.0.0.1:8547 --broadcast \
 *        --private-key $ANVIL_DEV_KEY   # anvil #0 — LOCAL ONLY public test key
 *
 * The dev keys/accounts below are the publicly known Anvil defaults. LOCAL ONLY — the fork is a private
 * copy of the chain; nothing here is ever broadcast to Robinhood Chain.
 */
contract DemoLocalFork is Script {
    /* ================ Anvil dev accounts (public, well-known — LOCAL ONLY) ================ */
    address internal constant OWNER = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266; // #0, deployer
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
    /// @dev Keeper phase: share of each genesis leg deployed into the v3 / v4 adapter (rest stays idle).
    uint256 internal constant V3_DEPLOY_PCT = 40;
    uint256 internal constant V4_DEPLOY_PCT = 20;

    /* ---------------- vault B: "stocks" (mUSDG + 5 stocks) — as DemoLocal.s.sol ---------------- */
    uint256 internal constant STOCKS_GENESIS_SHARES = 25_000e18;
    uint256 internal constant STOCKS_MAX_TOTAL_SUPPLY = 1_000_000e18;
    uint256 internal constant N_STOCKS = 5;

    struct DemoVault {
        address vault;
        address[] basket; // [USDG, WETH] — vault registry order
        UniswapV3Adapter adapterV3;
        UniswapV4Adapter adapterV4;
        address swapExecutor; // shared by both adapters (stateless; not written to deployment.local.json)
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
        uint256 genUsdg = _usdgFor(GEN_WETH);
        require(
            IERC20(USDG).balanceOf(OWNER) >= genUsdg && IERC20(WETH).balanceOf(OWNER) >= GEN_WETH,
            "DemoLocalFork: OWNER not funded - run script/fork-demo-up.sh (funding step)"
        );

        /* ------------- phase 1: deploy stacks + periphery + genesis deposits (deployer = anvil #0) ------------- */
        vm.startBroadcast();
        DemoVault memory a = _deployDemoVault(genUsdg);
        (address zapIn, address zapOut) = _deployPeriphery(a.vault);
        address planExecutor = _deployPlanExecutor(a.vault);
        StocksVault memory b = _deployStocksVault(Upgrades.getImplementationAddress(a.vault));
        vm.stopBroadcast();

        /* ------- phase 2: keeper deploys capital into the REAL adapters + mock pairs (anvil #1) ------- */
        vm.startBroadcast(ANVIL_KEY_1);
        _keeperDemo(a, genUsdg);
        _keeperStocks(b);
        vm.stopBroadcast();

        _assertRealPositions(a);

        /* ------------------------------ logs + shared/deployment.local.json ------------------------------ */
        console2.log("== MySun local demo stack on the RHC fork (2 vaults + zap periphery + plan executor) ==");
        console2.log("chainId          :", block.chainid);
        console2.log("block            :", block.number);
        console2.log("owner            :", OWNER);
        console2.log("keeper           :", KEEPER);
        console2.log("demo user        :", DEMO_USER);
        console2.log("USDG (real)      :", USDG);
        console2.log("WETH (real)      :", WETH);
        console2.log("mUSDG (mock)     :", b.basket[0]);
        console2.log("zap-in           :", zapIn);
        console2.log("zap-out          :", zapOut);
        console2.log("plan-executor    :", planExecutor);
        _logDemo(a);
        _logStocks(b);

        string memory vaultsJson = string.concat(
            "[",
            _vaultJson("demo", "USDG / WETH basket (RHC fork - real Uniswap v3 + v4)", a.vault),
            ",",
            _vaultJson("stocks", "Stock-pair basket (5 stocks + mUSDG)", b.vault),
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
            "wrote ../shared/deployment.local.json (schema v2, 2 vaults, fork=true, mintable=false, periphery)"
        );
    }

    /* =============================== vault A: "demo" (real) =============================== */

    function _deployDemoVault(uint256 genUsdg) internal returns (DemoVault memory a) {
        a.basket = new address[](2);
        a.basket[0] = USDG;
        a.basket[1] = WETH;

        a.vault = Upgrades.deployUUPSProxy(
            "MySunVaultUpgradeable.sol",
            abi.encodeCall(
                MySunVaultUpgradeable(address(0)).initialize,
                (OWNER, "sunEthLP", "sunEthLP", a.basket, OWNER, FEE_BPS, GENESIS_SHARES, MAX_TOTAL_SUPPLY)
            )
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
        a.adapterV4 = new UniswapV4Adapter(
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

        MySunVaultUpgradeable vaultC = MySunVaultUpgradeable(a.vault);
        vaultC.addAdapter(IPositionAdapter(address(a.adapterV3)));
        vaultC.addAdapter(IPositionAdapter(address(a.adapterV4)));
        vaultC.setKeeper(KEEPER, true);

        // Genesis deposit — owner-only (this broadcast is anvil #0 == OWNER), REAL tokens funded by
        // fork-demo-up.sh: a 50/50 basket at the pool's spot, in kind; mints exactly GENESIS_SHARES (K).
        IERC20(USDG).approve(a.vault, genUsdg);
        IERC20(WETH).approve(a.vault, GEN_WETH);
        vaultC.deposit(a.basket, _pair(genUsdg, GEN_WETH), GENESIS_SHARES, OWNER);
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

    function _keeperDemo(DemoVault memory a, uint256 genUsdg) internal {
        MySunVaultUpgradeable vaultC = MySunVaultUpgradeable(a.vault);
        // Amounts are in ADAPTER order = pool order [WETH, USDG]. Each deploy swaps the surplus leg into the
        // deficit leg (TWAP-bounded) and mints a real LP position.
        vaultC.deployTo(
            IPositionAdapter(address(a.adapterV3)), _pair(GEN_WETH * V3_DEPLOY_PCT / 100, genUsdg * V3_DEPLOY_PCT / 100)
        );
        vaultC.deployTo(
            IPositionAdapter(address(a.adapterV4)), _pair(GEN_WETH * V4_DEPLOY_PCT / 100, genUsdg * V4_DEPLOY_PCT / 100)
        );
    }

    /// @dev Proof the flagship vault runs on real venues: each adapter owns exactly one live LP NFT.
    function _assertRealPositions(DemoVault memory a) internal view {
        uint256 id3 = a.adapterV3.tokenId();
        require(id3 != 0, "v3 adapter: no position minted");
        require(INonfungiblePositionManager(NFPM).ownerOf(id3) == address(a.adapterV3), "v3 NFT not owned by adapter");
        require(INonfungiblePositionManager(NFPM).balanceOf(address(a.adapterV3)) == 1, "v3 adapter NFT count != 1");
        uint256 id4 = a.adapterV4.tokenId();
        require(id4 != 0, "v4 adapter: no position minted");
        require(IPositionManagerMinimal(POSM).ownerOf(id4) == address(a.adapterV4), "v4 NFT not owned by adapter");
        require(IPositionManagerMinimal(POSM).getPositionLiquidity(id4) > 0, "v4 position has no liquidity");
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

    /* ==================================== helpers ==================================== */

    /// @dev USDG worth `wethAmount` at the fee-100 pool's spot (token0 = WETH, token1 = USDG) — genesis sizing
    ///      only, the same helper the fork suites use.
    function _usdgFor(uint256 wethAmount) internal view returns (uint256) {
        (uint160 sqrtP,,,,,,) = IUniswapV3PoolMinimal(POOL_FEE100).slot0();
        return Math.mulDiv(Math.mulDiv(wethAmount, sqrtP, 1 << 96), sqrtP, 1 << 96);
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
        _logAdapter("adapter (v3 REAL):", IPositionAdapter(address(a.adapterV3)), a.adapterV3.tokenId());
        console2.log("  tickLower      :", int256(a.adapterV3.tickLower()));
        console2.log("  tickUpper      :", int256(a.adapterV3.tickUpper()));
        _logAdapter("adapter (v4 REAL):", IPositionAdapter(address(a.adapterV4)), a.adapterV4.tokenId());
        console2.log("  tickLower      :", int256(a.adapterV4.tickLower()));
        console2.log("  tickUpper      :", int256(a.adapterV4.tickUpper()));
        console2.log("swap executor    :", a.swapExecutor);
    }

    function _logStocks(StocksVault memory b) internal view {
        _logVault("-- vault [stocks] --", b.vault);
        for (uint256 i; i < b.pairs.length; ++i) {
            console2.log("adapter (pair)   :", MockToken(b.basket[1 + i]).symbol(), address(b.pairs[i]));
        }
    }
}
