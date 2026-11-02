// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.34;

import {Script, console2} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {MySunVaultUpgradeable} from "contracts/MySunVaultUpgradeable.sol";
import {DepositSplit} from "contracts/periphery/DepositSplit.sol";
import {IPositionAdapter} from "contracts/interfaces/IPositionAdapter.sol";
import {ILiquidityAdapter} from "contracts/interfaces/ILiquidityAdapter.sol";
import {ISwapAdapter} from "contracts/interfaces/ISwapAdapter.sol";
import {MockToken} from "test/mocks/MockToken.sol";
import {MockPullingAdapter} from "test/mocks/MockPullingAdapter.sol";

/**
 * @notice PR #10 local merge gate — ANVIL ONLY (reverts on any chain id but 31337).
 *         1. Deploys the MAIN (`2736e67`) vault implementation from its build artifact behind an ERC1967 proxy, with
 *            mock tokens and a {MockPullingAdapter}, and seeds state (genesis deposit + a keeper deploy).
 *         2. Deploys this tree's implementation (Forge deploys and links {PoolmigoVaultCold} first) and upgrades the
 *            proxy through UUPS `upgradeToAndCall`, then checks every piece of seeded state survived.
 *         3. Runs deposit, addLiquidity / removeLiquidity, rebalance (fee skim), swapExactIn and redeem end to end.
 *
 * Usage (from contracts/):
 *   anvil --hardfork cancun --port 8547
 *   forge clean && forge build
 *   # the main implementation's artifact, built from a `2736e67` checkout with the same compiler settings:
 *   cp <main checkout>/contracts/out/MySunVaultUpgradeable.sol/MySunVaultUpgradeable.json \
 *      cache/main-2736e67-MySunVaultUpgradeable.json
 *   forge script script/local/UpgradeE2ELocal.s.sol --rpc-url http://127.0.0.1:8547 --broadcast \
 *     --sender 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
 *
 * The keys below are anvil's public, well-known dev keys — LOCAL ONLY, never fund them anywhere.
 */
contract UpgradeE2ELocal is Script {
    uint256 internal constant OWNER_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80; // #0
    uint256 internal constant KEEPER_KEY = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d; // #1
    uint256 internal constant USER_KEY = 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a; // #2
    address internal constant TREASURY = 0x90F79bf6EB2c4f870365E785982E1f101E93b906; // #3

    string internal constant MAIN_ARTIFACT = "cache/main-2736e67-MySunVaultUpgradeable.json";
    uint256 internal constant GENESIS = 10_000e18;
    uint16 internal constant FEE_BPS = 1000;

    address internal owner;
    address internal keeper;
    address internal user;
    MockToken internal usdg;
    MockToken internal weth;
    address[] internal basket;
    MySunVaultUpgradeable internal vault;
    MockPullingAdapter internal adapter;

    struct Snap {
        string name;
        string symbol;
        uint256 supply;
        uint256 ownerShares;
        address treasury;
        uint16 feeBps;
        uint256 genesisShares;
        uint256 adapterCount;
        uint8 caps;
        bool keeperSet;
        uint256 idle0;
        uint256 idle1;
        uint256 total0;
        uint256 total1;
    }

    function run() external {
        require(block.chainid == 31337, "UpgradeE2ELocal: anvil only");
        (owner, keeper, user) = (vm.addr(OWNER_KEY), vm.addr(KEEPER_KEY), vm.addr(USER_KEY));

        /* ---------------- 1. main implementation + seeded state ---------------- */
        bytes memory mainInit = vm.parseJsonBytes(vm.readFile(MAIN_ARTIFACT), ".bytecode.object");
        vm.startBroadcast(OWNER_KEY);
        usdg = new MockToken("Mock USDG", "mUSDG", 6);
        weth = new MockToken("Mock WETH", "mWETH", 18);
        basket.push(address(usdg));
        basket.push(address(weth));
        DepositSplit split = new DepositSplit();
        address mainImpl = _create(abi.encodePacked(mainInit, abi.encode(address(split))));
        vault = MySunVaultUpgradeable(
            address(
                new ERC1967Proxy(
                    mainImpl,
                    abi.encodeCall(
                        MySunVaultUpgradeable(address(0)).initialize,
                        (owner, "sunEthLP", "sunEthLP", basket, TREASURY, FEE_BPS, GENESIS, uint256(0))
                    )
                )
            )
        );
        adapter = new MockPullingAdapter(basket, address(vault), keccak256("E2E"), bytes32(uint256(1)));
        vault.addAdapter(IPositionAdapter(address(adapter)));
        vault.setKeeper(keeper, true);
        usdg.mint(owner, 10_000e6);
        weth.mint(owner, 5e18);
        usdg.approve(address(vault), 10_000e6);
        weth.approve(address(vault), 5e18);
        vault.deposit(basket, _pair(10_000e6, 5e18), GENESIS, owner);
        vm.stopBroadcast();

        vm.startBroadcast(KEEPER_KEY);
        vault.deployTo(IPositionAdapter(address(adapter)), _pair(2_000e6, 1e18));
        vm.stopBroadcast();

        console2.log("main implementation (2736e67):", mainImpl);
        console2.log("proxy:", address(vault));
        console2.log("adapter:", address(adapter));
        Snap memory before = _snap();
        _logSnap("seeded on main", before);

        /* ---------------- 2. UUPS upgrade to this tree ---------------- */
        vm.startBroadcast(OWNER_KEY);
        MySunVaultUpgradeable newImpl = new MySunVaultUpgradeable(address(split));
        vault.upgradeToAndCall(address(newImpl), "");
        vm.stopBroadcast();

        address implNow = address(uint160(uint256(vm.load(address(vault), ERC1967Utils.IMPLEMENTATION_SLOT))));
        require(implNow == address(newImpl), "implementation slot");
        console2.log("PR implementation:", address(newImpl));
        Snap memory upgraded = _snap();
        _logSnap("after upgrade", upgraded);
        _requireSame(before, upgraded);
        console2.log("state check: every seeded field identical after upgrade");

        /* ---------------- 3. flows on the upgraded proxy ---------------- */
        // deposit (second holder)
        vm.startBroadcast(OWNER_KEY);
        usdg.mint(user, 1_000e6);
        weth.mint(user, 1e18);
        vm.stopBroadcast();
        (uint256 quote,) = vault.previewDeposit(basket, _pair(1_000e6, 1e18));
        vm.startBroadcast(USER_KEY);
        usdg.approve(address(vault), 1_000e6);
        weth.approve(address(vault), 1e18);
        uint256 minted = vault.deposit(basket, _pair(1_000e6, 1e18), quote, user);
        vm.stopBroadcast();
        console2.log("deposit: user shares minted", minted);

        // keeper: precise add / remove, harvest with fee skim, swap
        vm.startBroadcast(OWNER_KEY);
        adapter.setRemoveDelivers(true);
        adapter.simulateFees(_pair(50e6, 0.02e18));
        adapter.setRateWad(5e26); // 100e6 mUSDG (6 dp) -> 0.05e18 mWETH
        vm.stopBroadcast();
        vm.startBroadcast(KEEPER_KEY);
        vault.addLiquidity(
            IPositionAdapter(address(adapter)),
            ILiquidityAdapter.AddLiquidityParams({
                tickLower: -120,
                tickUpper: 240,
                liquidity: 1e18,
                minLiquidity: 0,
                maxAmount0: 1_000e6,
                maxAmount1: 0.5e18,
                minSwapOut: 0
            })
        );
        vault.removeLiquidity(
            IPositionAdapter(address(adapter)),
            ILiquidityAdapter.RemoveLiquidityParams({liquidity: 1, minPrincipal0: 0, minPrincipal1: 0})
        );
        (, uint256[] memory harvested, uint256[] memory cut) = vault.rebalance();
        vault.swapExactIn(
            IPositionAdapter(address(adapter)),
            ISwapAdapter.SwapParams({
                tokenIn: address(usdg), tokenOut: address(weth), amountIn: 100e6, minAmountOut: 0.05e18
            })
        );
        vm.stopBroadcast();
        console2.log("rebalance: harvested mUSDG", harvested[0], "mWETH", harvested[1]);
        console2.log("rebalance: fee to treasury mUSDG", cut[0], "mWETH", cut[1]);
        console2.log("treasury balances mUSDG", usdg.balanceOf(TREASURY), "mWETH", weth.balanceOf(TREASURY));

        // redeem: the user exits fully, the owner exits half
        vm.startBroadcast(USER_KEY);
        (, uint256[] memory userOut) = vault.redeem(minted, user);
        vm.stopBroadcast();
        vm.startBroadcast(OWNER_KEY);
        (, uint256[] memory ownerOut) = vault.redeem(GENESIS / 2, owner);
        vm.stopBroadcast();
        console2.log("redeem user: mUSDG", userOut[0], "mWETH", userOut[1]);
        console2.log("redeem owner (half): mUSDG", ownerOut[0], "mWETH", ownerOut[1]);
        _logSnap("final", _snap());
    }

    function _create(bytes memory initCode) internal returns (address deployed) {
        assembly ("memory-safe") {
            deployed := create(0, add(initCode, 0x20), mload(initCode))
        }
        require(deployed != address(0), "main implementation create failed");
    }

    function _snap() internal view returns (Snap memory s) {
        s.name = vault.name();
        s.symbol = vault.symbol();
        s.supply = vault.totalSupply();
        s.ownerShares = vault.balanceOf(owner);
        s.treasury = vault.treasury();
        s.feeBps = vault.performanceFeeBps();
        s.genesisShares = vault.genesisShares();
        s.adapterCount = vault.adapterCount();
        s.caps = vault.adapterCapabilities(IPositionAdapter(address(adapter)));
        s.keeperSet = vault.isKeeper(keeper);
        s.idle0 = IERC20(basket[0]).balanceOf(address(vault));
        s.idle1 = IERC20(basket[1]).balanceOf(address(vault));
        (, uint256[] memory totals) = vault.totalTokens();
        (s.total0, s.total1) = (totals[0], totals[1]);
    }

    function _requireSame(Snap memory a, Snap memory b) internal pure {
        require(keccak256(abi.encode(a)) == keccak256(abi.encode(b)), "state changed across the upgrade");
    }

    function _logSnap(string memory label, Snap memory s) internal pure {
        console2.log("--", label);
        console2.log("   name / symbol", s.name, s.symbol);
        console2.log("   totalSupply", s.supply, "owner shares", s.ownerShares);
        console2.log("   treasury", s.treasury);
        console2.log("   feeBps", s.feeBps, "genesisShares", s.genesisShares);
        console2.log("   adapters", s.adapterCount, "caps", s.caps);
        console2.log("   keeper set", s.keeperSet);
        console2.log("   idle mUSDG", s.idle0, "mWETH", s.idle1);
        console2.log("   totalTokens mUSDG", s.total0, "mWETH", s.total1);
    }

    function _pair(uint256 a, uint256 b) internal pure returns (uint256[] memory arr) {
        arr = new uint256[](2);
        arr[0] = a;
        arr[1] = b;
    }
}
