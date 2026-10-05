// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import {Test} from "forge-std/Test.sol";
import {Upgrades, Options} from "openzeppelin-foundry-upgrades/Upgrades.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {MySunVaultUpgradeable} from "contracts/MySunVaultUpgradeable.sol";
import {PoolmigoVaultUpgradeable} from "contracts/PoolmigoVaultUpgradeable.sol";
import {IMySunVault} from "contracts/interfaces/IMySunVault.sol";
import {IPoolmigoVault} from "contracts/interfaces/IPoolmigoVault.sol";
import {MySunZapIn} from "contracts/periphery/MySunZapIn.sol";
import {MySunZapOut} from "contracts/periphery/MySunZapOut.sol";
import {PoolmigoZapIn} from "contracts/periphery/PoolmigoZapIn.sol";
import {PoolmigoZapOut} from "contracts/periphery/PoolmigoZapOut.sol";
import {Create3Dispatcher} from "contracts/periphery/PoolmigoCreate3.sol";
import {MockToken} from "test/mocks/MockToken.sol";
import {MockV3Factory} from "test/mocks/MockV3Pool.sol";
import {MockPermit2Router} from "test/mocks/MockPermit2Router.sol";

/**
 * @notice The MySun-named artifacts (notes/NAMING.md → Solidity identifiers) are thin wrappers over the legacy
 *         `Poolmigo*` implementations: same runtime code, ABI selectors, ERC-7201 namespace and initializer. This
 *         suite pins that equivalence, OZ upgrade-safety against the legacy reference (the already-deployed proxies'
 *         implementation), and the identifiers the rename must never move (namespace slot, CREATE3 salts, factory
 *         source and dispatcher executable init code).
 */
contract MySunArtifactsTest is Test {
    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal keeper = makeAddr("keeper");

    uint16 internal constant FEE_BPS = 1000;
    uint256 internal constant GENESIS = 1_000e18;

    /// @dev The shipped vault namespace (`erc7201:poolmigo.vault.storage`) — the deployed proxies' storage root.
    bytes32 internal constant VAULT_NAMESPACE_SLOT = 0xac5b1d856d96bdb992e4d284c4f305568246dd601ded20a127e04a49bd0b7b00;
    /// @dev Excludes solc's CBOR metadata suffix, whose absolute remappings vary with the checkout path.
    bytes32 internal constant DISPATCHER_EXECUTABLE_HASH =
        0xf35de960e9a46326d2d15b61974531f7a8a324ba0233a9f7c9c80075f1a3c31b;
    /// @dev `PoolmigoCreate3.sol` is byte-identical to the pre-rename baseline.
    bytes32 internal constant POOLMIGO_CREATE3_SOURCE_HASH =
        0x2d1cc60002d6d049ab3f5c010b171382217f9c10b0d24e04425c23bdfdfc0993;

    MockToken internal usdg;
    MockToken internal weth;

    function setUp() public {
        usdg = new MockToken("Mock USDG", "USDG", 6);
        weth = new MockToken("Mock WETH", "WETH", 18);
    }

    /*//////////////////////////////////////////////////////////////
                         VAULT — DEPLOY / INITIALIZE
    //////////////////////////////////////////////////////////////*/

    function test_MySunVault_DeploysAndInitializesWithSunEthLP() public {
        MySunVaultUpgradeable vault =
            MySunVaultUpgradeable(Upgrades.deployUUPSProxy("MySunVaultUpgradeable.sol", _initData("sunEthLP")));

        assertEq(vault.name(), "sunEthLP");
        assertEq(vault.symbol(), "sunEthLP");
        assertEq(vault.owner(), owner);
        assertEq(vault.treasury(), treasury);
        assertEq(vault.performanceFeeBps(), FEE_BPS);
        assertEq(vault.genesisShares(), GENESIS);
        assertEq(vault.maxTotalSupply(), 0);
        assertEq(vault.tokens().length, 2);

        // Same ERC-7201 root as the legacy vault: slot word 0 packs `treasury` (160 bits) + `performanceFeeBps` (16).
        uint256 word0 = uint256(vm.load(address(vault), VAULT_NAMESPACE_SLOT));
        assertEq(address(uint160(word0)), treasury, "treasury at namespace slot");
        assertEq(uint16(word0 >> 160), FEE_BPS, "fee bps packed after treasury");

        // The implementation is locked (inherited constructor) — only proxies initialize.
        address impl = Upgrades.getImplementationAddress(address(vault));
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        MySunVaultUpgradeable(impl).initialize(owner, "x", "x", _basket(), treasury, FEE_BPS, GENESIS, 0);

        // Initializer semantics unchanged: one-shot on the proxy, legacy-named custom errors.
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        vault.initialize(owner, "x", "x", _basket(), treasury, FEE_BPS, GENESIS, 0);
        vm.expectRevert(IPoolmigoVault.PoolmigoVault__EmptyReceiptName.selector);
        new ERC1967Proxy(impl, _initData(""));
    }

    /// @dev The MySun type converts implicitly to both interface names (same surface — a typed alias, no new member).
    function test_MySunVault_IsBothInterfaces() public {
        MySunVaultUpgradeable vault =
            MySunVaultUpgradeable(Upgrades.deployUUPSProxy("MySunVaultUpgradeable.sol", _initData("sunEthLP")));
        IMySunVault asMySun = vault;
        IPoolmigoVault asLegacy = asMySun;
        assertEq(address(asLegacy), address(vault));
    }

    /*//////////////////////////////////////////////////////////////
                  BYTECODE / SELECTOR IDENTITY WITH LEGACY
    //////////////////////////////////////////////////////////////*/

    /// @dev Runtime code minus the CBOR metadata trailer is byte-identical, so every dispatch selector, error selector,
    ///      event topic, storage access and code path is the legacy one. (Artifact runtime code carries zeroed
    ///      immutables, so the UUPS self-address immutable does not perturb the vault comparison.)
    function test_RuntimeCode_IdenticalToLegacyModuloMetadata() public view {
        _assertSameRuntime(
            "MySunVaultUpgradeable.sol:MySunVaultUpgradeable", "PoolmigoVaultUpgradeable.sol:PoolmigoVaultUpgradeable"
        );
        _assertSameRuntime("MySunZapIn.sol:MySunZapIn", "PoolmigoZapIn.sol:PoolmigoZapIn");
        _assertSameRuntime("MySunZapOut.sol:MySunZapOut", "PoolmigoZapOut.sol:PoolmigoZapOut");
    }

    /// @dev The compiler's method-identifier tables match key for key and selector for selector.
    function test_MethodIdentifiers_IdenticalToLegacy() public view {
        _assertSameMethodIds("MySunVaultUpgradeable", "PoolmigoVaultUpgradeable");
        _assertSameMethodIds("MySunZapIn", "PoolmigoZapIn");
        _assertSameMethodIds("MySunZapOut", "PoolmigoZapOut");
        _assertSameMethodIds("MySunVaultUpgradeExample", "PoolmigoVaultUpgradeExample");
    }

    /*//////////////////////////////////////////////////////////////
                OZ UPGRADE SAFETY AGAINST THE LEGACY REFERENCE
    //////////////////////////////////////////////////////////////*/

    /// @dev The MySun artifact passes with no call-site unsafeAllow options (its narrowly scoped source annotation is
    ///      documented on the wrapper), and the legacy artifact validates standalone with no allowance.
    function test_OZ_MySunValidatesAsUpgradeOfLegacy() public {
        Options memory none;
        Upgrades.validateImplementation("MySunVaultUpgradeable.sol", none);
        Upgrades.validateImplementation("PoolmigoVaultUpgradeable.sol", none);

        Options memory opts;
        opts.referenceContract = "PoolmigoVaultUpgradeable.sol";
        Upgrades.validateUpgrade("MySunVaultUpgradeable.sol", opts);
    }

    /// @dev Both upgrade fixtures validate against their own annotated base (`@custom:oz-upgrades-from`); same narrow
    ///      reinitializer allowance the existing upgrade test uses.
    function test_OZ_UpgradeExamplesValidate() public {
        Options memory opts;
        opts.unsafeAllow = "missing-initializer,missing-initializer-call";
        Upgrades.validateUpgrade("MySunVaultUpgradeExample.sol", opts);
        Upgrades.validateUpgrade("PoolmigoVaultUpgradeExample.sol", opts);
    }

    /// @dev A legacy-artifact proxy upgrades in place to the MySun implementation with every field intact (the
    ///      receipt keeps its initialized `migoLP` name — on-chain names never change).
    function test_LegacyProxy_UpgradesToMySun_StatePreserved() public {
        address proxy = Upgrades.deployUUPSProxy("PoolmigoVaultUpgradeable.sol", _initData("migoLP"));
        PoolmigoVaultUpgradeable legacy = PoolmigoVaultUpgradeable(proxy);
        vm.startPrank(owner);
        legacy.setKeeper(keeper, true);
        legacy.setMaxTotalSupply(5_000e18);
        vm.stopPrank();
        address legacyImpl = Upgrades.getImplementationAddress(proxy);

        Options memory opts;
        opts.referenceContract = "PoolmigoVaultUpgradeable.sol";
        vm.startPrank(owner);
        Upgrades.upgradeProxy(proxy, "MySunVaultUpgradeable.sol", "", opts);
        vm.stopPrank();

        MySunVaultUpgradeable vault = MySunVaultUpgradeable(proxy);
        assertTrue(Upgrades.getImplementationAddress(proxy) != legacyImpl, "implementation swapped");
        assertEq(vault.name(), "migoLP");
        assertEq(vault.symbol(), "migoLP");
        assertEq(vault.owner(), owner);
        assertEq(vault.treasury(), treasury);
        assertEq(vault.performanceFeeBps(), FEE_BPS);
        assertEq(vault.genesisShares(), GENESIS);
        assertEq(vault.maxTotalSupply(), 5_000e18);
        assertTrue(vault.isKeeper(keeper));
        assertEq(vault.tokens()[0], address(usdg));
        assertEq(vault.tokens()[1], address(weth));
    }

    /*//////////////////////////////////////////////////////////////
                            ZAPS — CONSTRUCTOR WIRING
    //////////////////////////////////////////////////////////////*/

    function test_MySunZaps_ConstructorWiringMatchesLegacy() public {
        MockV3Factory factory = new MockV3Factory();
        MockPermit2Router router = new MockPermit2Router(factory);

        MySunZapIn zapIn = new MySunZapIn(address(router), address(router), owner);
        PoolmigoZapIn legacyIn = new PoolmigoZapIn(address(router), address(router), owner);
        assertEq(address(zapIn.UNIVERSAL_ROUTER()), address(router));
        assertEq(address(zapIn.PERMIT2()), address(router));
        assertEq(zapIn.FACTORY(), address(factory));
        assertEq(zapIn.owner(), owner);
        assertEq(zapIn.FACTORY(), legacyIn.FACTORY());
        // Same immutables → the deployed runtime code is identical to the legacy zap's apart from the metadata.
        assertEq(_stripMetadata(address(zapIn).code), _stripMetadata(address(legacyIn).code), "zap-in runtime");

        MySunZapOut zapOut = new MySunZapOut(address(router), address(router), owner);
        PoolmigoZapOut legacyOut = new PoolmigoZapOut(address(router), address(router), owner);
        assertEq(address(zapOut.UNIVERSAL_ROUTER()), address(router));
        assertEq(address(zapOut.PERMIT2()), address(router));
        assertEq(zapOut.FACTORY(), address(factory));
        assertEq(zapOut.owner(), owner);
        assertEq(_stripMetadata(address(zapOut).code), _stripMetadata(address(legacyOut).code), "zap-out runtime");

        // Constructor guards forwarded unchanged (legacy-named errors, same selectors).
        vm.expectRevert(PoolmigoZapIn.ZapIn__ZeroAddress.selector);
        new MySunZapIn(address(0), address(router), owner);
        vm.expectRevert(abi.encodeWithSelector(PoolmigoZapOut.ZapOut__NoCode.selector, address(0xdead)));
        new MySunZapOut(address(0xdead), address(router), owner);
    }

    /*//////////////////////////////////////////////////////////////
                    IDENTIFIERS THE RENAME MUST NOT MOVE
    //////////////////////////////////////////////////////////////*/

    function test_VaultNamespace_Unchanged() public pure {
        bytes32 derived =
            keccak256(abi.encode(uint256(keccak256("poolmigo.vault.storage")) - 1)) & ~bytes32(uint256(0xff));
        assertEq(derived, VAULT_NAMESPACE_SLOT);
    }

    function test_Create3_SourceAndDispatcherLogic_Unchanged() public view {
        string memory create3Source = vm.readFile("src/periphery/PoolmigoCreate3.sol");
        assertEq(keccak256(bytes(create3Source)), POOLMIGO_CREATE3_SOURCE_HASH, "CREATE3 source changed");
        assertEq(
            keccak256(_stripMetadata(type(Create3Dispatcher).creationCode)),
            DISPATCHER_EXECUTABLE_HASH,
            "dispatcher executable init code"
        );
        string memory script = vm.readFile("script/DeployDeterministic.s.sol");
        assertTrue(
            vm.indexOf(script, 'vm.envOr("SALT", keccak256("poolmigo.vault.v1"))') != type(uint256).max,
            "default vault salt text"
        );
    }

    /*//////////////////////////////////////////////////////////////
                                 HELPERS
    //////////////////////////////////////////////////////////////*/

    function _basket() internal view returns (address[] memory t) {
        t = new address[](2);
        t[0] = address(usdg);
        t[1] = address(weth);
    }

    function _initData(string memory receipt) internal view returns (bytes memory) {
        return abi.encodeCall(
            MySunVaultUpgradeable(address(0)).initialize,
            (owner, receipt, receipt, _basket(), treasury, FEE_BPS, GENESIS, 0)
        );
    }

    function _assertSameRuntime(string memory mySun, string memory legacy) internal view {
        bytes memory a = _stripMetadata(vm.getDeployedCode(mySun));
        bytes memory b = _stripMetadata(vm.getDeployedCode(legacy));
        assertGt(a.length, 0, mySun);
        assertEq(a, b, mySun);
    }

    function _assertSameMethodIds(string memory mySun, string memory legacy) internal view {
        string memory ja = vm.readFile(string.concat("out/", mySun, ".sol/", mySun, ".json"));
        string memory jb = vm.readFile(string.concat("out/", legacy, ".sol/", legacy, ".json"));
        string[] memory ka = vm.parseJsonKeys(ja, ".methodIdentifiers");
        string[] memory kb = vm.parseJsonKeys(jb, ".methodIdentifiers");
        assertEq(ka.length, kb.length, mySun);
        assertGt(ka.length, 0, mySun);
        for (uint256 i; i < ka.length; ++i) {
            assertEq(ka[i], kb[i], mySun);
            string memory path = string.concat(".methodIdentifiers['", ka[i], "']");
            assertEq(vm.parseJsonString(ja, path), vm.parseJsonString(jb, path), ka[i]);
        }
    }

    /// @dev Drops solc's CBOR metadata trailer (its byte length is the code's last two bytes, big-endian).
    function _stripMetadata(bytes memory code) internal pure returns (bytes memory out) {
        uint256 n = code.length;
        uint256 cbor = (uint256(uint8(code[n - 2])) << 8) | uint8(code[n - 1]);
        out = new bytes(n - cbor - 2);
        for (uint256 i; i < out.length; ++i) {
            out[i] = code[i];
        }
    }
}
