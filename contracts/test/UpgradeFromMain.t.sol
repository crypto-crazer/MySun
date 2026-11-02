// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {Upgrades, Options} from "openzeppelin-foundry-upgrades/Upgrades.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {MySunVaultUpgradeable} from "contracts/MySunVaultUpgradeable.sol";
import {IPositionAdapter} from "contracts/interfaces/IPositionAdapter.sol";
import {MockToken} from "test/mocks/MockToken.sol";
import {MockSwapAdapter} from "test/mocks/MockSwapAdapter.sol";
import {VaultImplArgs} from "test/utils/VaultImplArgs.sol";

/**
 * @notice Upgrade from the live-beta implementation (`2736e67`, the PR's base on main) to this tree's linked
 *         implementation. The reference is a committed snapshot: `previous-builds/build-info-2736e67/` is the solc
 *         build-info of `2736e67`'s `src/MySunVaultUpgradeable.sol` (same compiler settings). The OZ validator checks
 *         the upgrade against it (`referenceBuildInfoDir`), and the old implementation is deployed from the creation
 *         code in that same build-info, so the proxy really starts on main's bytecode.
 */
contract UpgradeFromMainTest is Test {
    string internal constant MAIN_BUILD_INFO_DIR = "previous-builds/build-info-2736e67";
    string internal constant MAIN_BUILD_INFO = "previous-builds/build-info-2736e67/f8c6c014509ee2bd.json";
    string internal constant MAIN_REFERENCE = "build-info-2736e67:MySunVaultUpgradeable";
    uint256 internal constant GENESIS = 1_000e18;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal keeper = makeAddr("keeper");
    address internal risk = makeAddr("risk");
    address internal user = makeAddr("user");

    MockToken internal t0;
    MockToken internal t1;
    address[] internal basket;
    MySunVaultUpgradeable internal vault;
    MockSwapAdapter internal adapter;
    address internal mainImpl;

    function setUp() public {
        t0 = new MockToken("T0", "T0", 6);
        t1 = new MockToken("T1", "T1", 18);
        basket.push(address(t0));
        basket.push(address(t1));

        string memory code = vm.parseJsonString(
            vm.readFile(MAIN_BUILD_INFO),
            "$.output.contracts['src/MySunVaultUpgradeable.sol'].MySunVaultUpgradeable.evm.bytecode.object"
        );
        bytes memory init = abi.encodePacked(vm.parseBytes(string.concat("0x", code)), abi.encode(VaultImplArgs.depositSplit()));
        address impl;
        assembly ("memory-safe") {
            impl := create(0, add(init, 0x20), mload(init))
        }
        require(impl != address(0), "main implementation create");
        mainImpl = impl;
        vault = MySunVaultUpgradeable(
            address(
                new ERC1967Proxy(
                    impl,
                    abi.encodeCall(
                        MySunVaultUpgradeable(address(0)).initialize,
                        (owner, "sunEthLP", "sunEthLP", basket, treasury, uint16(1000), GENESIS, 5_000e18)
                    )
                )
            )
        );
        adapter = new MockSwapAdapter(basket, address(vault), "A", bytes32(uint256(1)));

        // Seed every storage field through main's code.
        vm.startPrank(owner);
        vault.addAdapter(IPositionAdapter(address(adapter)));
        vault.setAdapterCapability(IPositionAdapter(address(adapter)), vault.CAP_SWAP(), false);
        vault.setKeeper(keeper, true);
        vault.setRiskManager(risk, true);
        vault.setPerformanceFeeBps(1500);
        t0.mint(owner, 1_000e6);
        t1.mint(owner, 1e18);
        t0.approve(address(vault), type(uint256).max);
        t1.approve(address(vault), type(uint256).max);
        vault.deposit(basket, _pair(1_000e6, 1e18), GENESIS, owner);
        vm.stopPrank();
        vm.prank(keeper);
        vault.deployTo(IPositionAdapter(address(adapter)), _pair(400e6, 0.4e18));
    }

    function test_MainSnapshot_ValidatesAndUpgradesToLinkedImplementation() public {
        assertEq(mainImpl.code.length, 24_545, "proxy starts on main's runtime (24,545 B)");
        assertEq(Upgrades.getImplementationAddress(address(vault)), mainImpl);
        (, uint256[] memory totalsBefore) = vault.totalTokens();

        Options memory opts;
        opts.referenceBuildInfoDir = MAIN_BUILD_INFO_DIR;
        opts.referenceContract = MAIN_REFERENCE;
        opts.constructorData = abi.encode(VaultImplArgs.depositSplit());
        Upgrades.validateUpgrade("MySunVaultUpgradeable.sol", opts);
        vm.startPrank(owner);
        Upgrades.upgradeProxy(address(vault), "MySunVaultUpgradeable.sol", "", opts);
        vm.stopPrank();

        address newImpl = Upgrades.getImplementationAddress(address(vault));
        assertTrue(newImpl != mainImpl, "implementation swapped");
        assertEq(vault.name(), "sunEthLP");
        assertEq(vault.symbol(), "sunEthLP");
        assertEq(vault.owner(), owner);
        assertEq(vault.treasury(), treasury);
        assertEq(vault.performanceFeeBps(), 1500);
        assertEq(vault.genesisShares(), GENESIS);
        assertEq(vault.maxTotalSupply(), 5_000e18);
        assertFalse(vault.paused());
        assertTrue(vault.isKeeper(keeper));
        assertTrue(vault.isRiskManager(risk));
        assertTrue(vault.isAdapter(address(adapter)));
        assertEq(vault.adapterCount(), 1);
        assertEq(address(vault.adapterAt(0)), address(adapter));
        assertEq(vault.adapterCapabilities(IPositionAdapter(address(adapter))), vault.CAP_LIQUIDITY());
        assertEq(vault.tokens(), basket);
        assertTrue(vault.isToken(address(t0)) && vault.isToken(address(t1)));
        assertEq(vault.totalSupply(), GENESIS);
        assertEq(vault.balanceOf(owner), GENESIS);
        (, uint256[] memory totalsAfter) = vault.totalTokens();
        assertEq(totalsAfter, totalsBefore, "basket totals");

        // The linked library paths and the user paths work on the upgraded proxy.
        MockSwapAdapter second = new MockSwapAdapter(basket, address(vault), "B", bytes32(uint256(2)));
        vm.startPrank(owner);
        vault.addAdapter(IPositionAdapter(address(second)));
        vault.removeAdapter(IPositionAdapter(address(second)));
        vm.stopPrank();
        assertEq(vault.adapterCount(), 1);

        t0.mint(user, 100e6);
        t1.mint(user, 0.1e18);
        vm.startPrank(user);
        t0.approve(address(vault), type(uint256).max);
        t1.approve(address(vault), type(uint256).max);
        uint256 minted = vault.deposit(basket, _pair(100e6, 0.1e18), 1, user);
        (, uint256[] memory out) = vault.redeem(minted, user);
        vm.stopPrank();
        assertGt(minted, 0);
        assertLe(out[0], 100e6, "never over-delivers");
        assertApproxEqAbs(out[0], 100e6, 2);
    }

    function _pair(uint256 a, uint256 b) internal pure returns (uint256[] memory arr) {
        arr = new uint256[](2);
        arr[0] = a;
        arr[1] = b;
    }
}
