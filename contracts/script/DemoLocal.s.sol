// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import {Script, console2} from "forge-std/Script.sol";
import {Upgrades} from "openzeppelin-foundry-upgrades/Upgrades.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {MySunVaultUpgradeable} from "contracts/MySunVaultUpgradeable.sol";
import {MockPositionAdapter} from "test/mocks/MockPositionAdapter.sol";
import {MockToken} from "test/mocks/MockToken.sol";

/**
 * @notice One-shot local demo stack for Anvil — the shared dev chain for frontend/backend work.
 *
 * Deploys TWO vaults on one chain (per-vault receipt naming — notes/NAMING.md):
 *   - "demo"   — mUSDG/mWETH basket, receipt `sunEthLP`, TWO mock position adapters (stand-ins for
 *                Uniswap V3 + V4 pools). Deploy order and values are unchanged from the one-vault
 *                stack, so on a fresh anvil its addresses are the same as before.
 *   - "stocks" — mUSDG + 5 mock stock tokens (mNVDA, mAAPL, mTSLA, mSPY, mGME), receipt
 *                `sun5StocksLP`, one mock adapter per mUSDG/stock pair. Its proxy reuses the demo
 *                vault's (already OZ-validated) implementation.
 * For each vault: the owner-only genesis deposit (mints K), the keeper deploys part of the capital
 * into adapters, harvestable fees are seeded. Writes `shared/deployment.local.json` in the v2
 * (multi-vault) schema — the single source of truth for addresses consumed by frontend/ and backend/.
 *
 * Usage (with anvil running):
 *   anvil --port 8547 --chain-id 46630
 *   forge clean && forge build          # OZ plugin requirement: fresh single build-info
 *   forge script script/DemoLocal.s.sol --rpc-url http://127.0.0.1:8547 --broadcast \
 *     --private-key $ANVIL_DEV_KEY      # anvil #0 — LOCAL ONLY public test key
 *
 * The dev keys/accounts below are the publicly known Anvil defaults. They are inert and must
 * NEVER be funded on a real network. Run against a FRESH anvil (re-running against a used chain
 * would deploy a second stack; that is harmless but confusing).
 */
contract DemoLocal is Script {
    /* ================ Anvil dev accounts (public, well-known — LOCAL ONLY) ================ */
    address internal constant OWNER = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266; // #0, deployer
    address internal constant KEEPER = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8; // #1, keeper service
    address internal constant DEMO_USER = 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC; // #2, frontend tester
    uint256 internal constant ANVIL_KEY_1 = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d; // #1 — LOCAL ONLY

    /// @dev RPC written into the JSON — the shared dev chain, regardless of which RPC this run used.
    string internal constant RPC_URL = "http://127.0.0.1:8547";
    uint16 internal constant FEE_BPS = 1000; // 10% performance fee (both vaults)

    /* ---------------- vault A: "demo" (mUSDG / mWETH) ---------------- */
    /// @dev Genesis K: demo stand-in for the team's one-time off-chain valuation of the seed basket.
    uint256 internal constant GENESIS_SHARES = 10_000e18;
    /// @dev Receipt-token supply cap (PRD F1.2), raised in stages by the owner. 0 would mean uncapped.
    uint256 internal constant MAX_TOTAL_SUPPLY = 500_000e18;

    /* ---------------- vault B: "stocks" (mUSDG + 5 stocks) ---------------- */
    uint256 internal constant STOCKS_GENESIS_SHARES = 25_000e18;
    uint256 internal constant STOCKS_MAX_TOTAL_SUPPLY = 1_000_000e18;
    uint256 internal constant N_STOCKS = 5;

    struct DemoVault {
        address vault;
        address[] basket;
        MockPositionAdapter adapterV3;
        MockPositionAdapter adapterV4;
    }

    struct StocksVault {
        address vault;
        address[] basket; // [mUSDG, mNVDA, mAAPL, mTSLA, mSPY, mGME]
        MockPositionAdapter[] pairs; // pairs[i] = [mUSDG, stock i]
    }

    function run() external {
        /* ------------- phase 1: deploy stacks + genesis deposits (deployer = anvil #0) ------------- */
        vm.startBroadcast();
        MockToken usdg = new MockToken("Mock USDG", "mUSDG", 6);
        MockToken weth = new MockToken("Mock WETH", "mWETH", 18);
        DemoVault memory a = _deployDemoVault(usdg, weth);
        StocksVault memory b = _deployStocksVault(usdg, Upgrades.getImplementationAddress(a.vault));
        vm.stopBroadcast();

        /* ------- phase 2: keeper deploys capital into adapters + seeds fees (anvil #1) ------- */
        vm.startBroadcast(ANVIL_KEY_1);
        _keeperDemo(a);
        _keeperStocks(b);
        vm.stopBroadcast();

        /* ------------------------------ logs + shared/deployment.local.json ------------------------------ */
        console2.log("== MySun local demo stack (2 vaults) ==");
        console2.log("chainId          :", block.chainid);
        console2.log("owner            :", OWNER);
        console2.log("keeper           :", KEEPER);
        console2.log("demo user        :", DEMO_USER);
        console2.log("mUSDG            :", address(usdg));
        console2.log("mWETH            :", address(weth));
        _logDemo(a);
        _logStocks(b);

        string memory vaultsJson = string.concat(
            "[",
            _vaultJson("demo", "mUSDG / mWETH basket", a.vault),
            ",",
            _vaultJson("stocks", "Stock-pair basket (5 stocks + mUSDG)", b.vault),
            "]"
        );
        // Seed the root via serializeJson: serializeString would store a JSON *array* as an escaped
        // string (only object-shaped values are parsed), so `vaults` goes in as parsed JSON.
        string memory root = "deployment";
        vm.serializeJson(root, string.concat("{\"vaults\":", vaultsJson, "}"));
        vm.serializeUint(root, "version", 2);
        vm.serializeUint(root, "chainId", block.chainid);
        string memory json = vm.serializeString(root, "rpcUrl", RPC_URL);
        vm.writeJson(json, "../shared/deployment.local.json");
        console2.log("wrote ../shared/deployment.local.json (schema v2, 2 vaults)");
    }

    /* =============================== vault A: "demo" =============================== */

    function _deployDemoVault(MockToken usdg, MockToken weth) internal returns (DemoVault memory a) {
        a.basket = new address[](2);
        a.basket[0] = address(usdg);
        a.basket[1] = address(weth);

        a.vault = Upgrades.deployUUPSProxy(
            "MySunVaultUpgradeable.sol",
            abi.encodeCall(
                MySunVaultUpgradeable(address(0)).initialize,
                (OWNER, "sunEthLP", "sunEthLP", a.basket, OWNER, FEE_BPS, GENESIS_SHARES, MAX_TOTAL_SUPPLY)
            )
        );

        a.adapterV3 = new MockPositionAdapter(a.basket, a.vault, bytes32("uniswap-v3"), bytes32("mUSDG/mWETH 0.05%"));
        a.adapterV4 = new MockPositionAdapter(a.basket, a.vault, bytes32("uniswap-v4"), bytes32("mUSDG/mWETH 0.30%"));

        MySunVaultUpgradeable vaultC = MySunVaultUpgradeable(a.vault);
        vaultC.addAdapter(a.adapterV3);
        vaultC.addAdapter(a.adapterV4);
        vaultC.setKeeper(KEEPER, true);

        // Fund the demo actors generously.
        usdg.mint(OWNER, 1_000_000e6);
        weth.mint(OWNER, 500e18);
        usdg.mint(DEMO_USER, 250_000e6);
        weth.mint(DEMO_USER, 50e18);

        // Genesis deposit — owner-only (this broadcast is anvil #0 == OWNER); defines the basket and mints
        // exactly GENESIS_SHARES (K), independent of the amounts.
        usdg.approve(a.vault, type(uint256).max);
        weth.approve(a.vault, type(uint256).max);
        uint256[] memory boot = new uint256[](2);
        boot[0] = 100_000e6;
        boot[1] = 10e18;
        vaultC.deposit(a.basket, boot, GENESIS_SHARES, OWNER);
    }

    function _keeperDemo(DemoVault memory a) internal {
        MySunVaultUpgradeable vaultC = MySunVaultUpgradeable(a.vault);
        vaultC.deployTo(a.adapterV3, _pair(50_000e6, 5e18));
        vaultC.deployTo(a.adapterV4, _pair(25_000e6, 2.5e18));

        // Pretend both positions accrued trading fees (harvestable via rebalance()).
        a.adapterV3.simulateFees(_pair(250e6, 0.05e18));
        a.adapterV4.simulateFees(_pair(100e6, 0.02e18));
    }

    /* ============================== vault B: "stocks" ============================== */

    function _deployStocksVault(MockToken usdg, address implementation) internal returns (StocksVault memory b) {
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

        // Second proxy over the demo vault's implementation (validated by Upgrades.deployUUPSProxy above;
        // same bytecode, so no second implementation is deployed).
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
            console2.log("total", MockToken(t[i]).symbol(), amt[i]);
        }
    }

    function _logDemo(DemoVault memory a) internal view {
        _logVault("-- vault [demo] --", a.vault);
        console2.log("adapter (v3 mock):", address(a.adapterV3));
        console2.log("adapter (v4 mock):", address(a.adapterV4));
    }

    function _logStocks(StocksVault memory b) internal view {
        _logVault("-- vault [stocks] --", b.vault);
        for (uint256 i; i < b.pairs.length; ++i) {
            console2.log("adapter (pair)   :", MockToken(b.basket[1 + i]).symbol(), address(b.pairs[i]));
        }
    }
}
