// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import {Test} from "forge-std/Test.sol";
import {Upgrades, Options} from "openzeppelin-foundry-upgrades/Upgrades.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {PoolmigoCreate3, Create3Dispatcher} from "contracts/periphery/PoolmigoCreate3.sol";
import {MySunVaultUpgradeable} from "contracts/MySunVaultUpgradeable.sol";
import {MockToken} from "test/mocks/MockToken.sol";

/// @notice CREATE3 factory + deterministic vault deployment. The cross-chain half of the proof
///         (two fresh anvils, shifted nonces, same deployer) lives in script/deterministic-address-check.sh.
///         The factory binds each salt to its caller (effective salt = keccak256(salt ‖ msg.sender), K-17):
///         the address is a function of (factory, deployer, salt). In these tests the deployer is the test
///         contract unless pranked.
contract Create3Test is Test {
    PoolmigoCreate3 internal factory;
    bytes32 internal constant SALT = keccak256("poolmigo.salt.a");

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");

    function setUp() public {
        factory = new PoolmigoCreate3();
    }

    function _mockTokenCode() internal pure returns (bytes memory) {
        return abi.encodePacked(type(MockToken).creationCode, abi.encode("Mock USDG", "USDG", uint8(6)));
    }

    /*//////////////////////////////////////////////////////////////
                            1. ADDRESS MATH
    //////////////////////////////////////////////////////////////*/

    /// @dev Independent derivation: effective salt = keccak256(salt ++ deployer);
    ///      dispatcher = CREATE2(factory, effective salt, dispatcherInitCode);
    ///      target = keccak256(0xd6 0x94 ++ dispatcher ++ 0x01)[12:].
    function test_PredictedAddressMatchesIndependentFormula() public view {
        bytes32 effective = keccak256(abi.encodePacked(SALT, address(this)));
        address dispatcher =
            vm.computeCreate2Address(effective, keccak256(type(Create3Dispatcher).creationCode), address(factory));
        address expected = address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xd6), bytes1(0x94), dispatcher, bytes1(0x01)))))
        );

        assertEq(factory.dispatcherAddress(address(this), SALT), dispatcher, "dispatcher formula");
        assertEq(factory.create3Address(address(this), SALT), expected, "final address formula");
    }

    function test_DeployLandsAtPredictedAddress() public {
        address predicted = factory.create3Address(address(this), SALT);
        address deployed = factory.deploy(SALT, _mockTokenCode());

        assertEq(deployed, predicted, "actual == predicted");
        assertGt(predicted.code.length, 0, "code present");
        assertEq(MockToken(predicted).symbol(), "USDG", "constructor ran");
    }

    /*//////////////////////////////////////////////////////////////
                            2. SALT SEMANTICS
    //////////////////////////////////////////////////////////////*/

    function test_SameSaltTwiceReverts() public {
        factory.deploy(SALT, _mockTokenCode());
        vm.expectRevert(
            abi.encodeWithSelector(
                PoolmigoCreate3.Create3__SaltAlreadyUsed.selector, factory.dispatcherAddress(address(this), SALT)
            )
        );
        factory.deploy(SALT, _mockTokenCode());
    }

    function test_DifferentSaltsDifferentAddresses() public {
        bytes32 saltA = keccak256("poolmigo.salt.a");
        bytes32 saltB = keccak256("poolmigo.salt.b");
        assertTrue(
            factory.create3Address(address(this), saltA) != factory.create3Address(address(this), saltB),
            "salts are namespaces"
        );

        address a = factory.deploy(saltA, _mockTokenCode());
        address b = factory.deploy(saltB, _mockTokenCode());
        assertTrue(a != b, "both deployed, distinct");
    }

    /*//////////////////////////////////////////////////////////////
            3. NONCE INDEPENDENCE, CALLER BINDING (LOCAL) — K-17
    //////////////////////////////////////////////////////////////*/

    /// @dev The caller's nonce does not matter; the caller DOES (salt bound to msg.sender).
    function test_NonceDoesNotAffectAddressButCallerDoes() public {
        address alice = makeAddr("alice");
        address bob = makeAddr("bob");
        address predicted = factory.create3Address(alice, SALT);
        assertTrue(predicted != factory.create3Address(bob, SALT), "caller enters the address");
        assertTrue(predicted != factory.create3Address(address(this), SALT), "caller enters the address");

        vm.deal(alice, 1 ether);
        for (uint256 i; i < 5; ++i) {
            vm.prank(alice);
            (bool ok,) = address(0xBEEF).call{value: 1}("");
            assertTrue(ok);
        }

        vm.prank(alice);
        address deployed = factory.deploy(SALT, _mockTokenCode());
        assertEq(deployed, predicted, "nonce is irrelevant");

        // Same salt, other caller: no SaltAlreadyUsed — its own namespace, its own address.
        vm.prank(bob);
        address other = factory.deploy(SALT, _mockTokenCode());
        assertEq(other, factory.create3Address(bob, SALT));
        assertTrue(other != deployed, "same salt, different caller, different address");
    }

    /// @dev K-17: an attacker front-running the team with the team's documented salt cannot occupy the team's
    ///      address (and cannot make the team's deploy revert); the team still lands exactly where predicted.
    function test_AttackerCannotSquatTeamSalt() public {
        address team = makeAddr("team");
        address attacker = makeAddr("attacker");
        address teamAddress = factory.create3Address(team, SALT);

        vm.prank(attacker);
        address squat = factory.deploy(SALT, _mockTokenCode());
        assertTrue(squat != teamAddress, "attacker lands in its own namespace");
        assertEq(teamAddress.code.length, 0, "team address still free");
        assertEq(factory.dispatcherAddress(team, SALT).code.length, 0, "team dispatcher still free");

        vm.prank(team);
        address deployed = factory.deploy(SALT, _mockTokenCode());
        assertEq(deployed, teamAddress, "team deploy unaffected");
        assertEq(MockToken(deployed).symbol(), "USDG");

        // The attacker's own repeat still hits its own used salt.
        address attackerDispatcher = factory.dispatcherAddress(attacker, SALT);
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(PoolmigoCreate3.Create3__SaltAlreadyUsed.selector, attackerDispatcher));
        factory.deploy(SALT, _mockTokenCode());
    }

    /// @dev The team's (deployer, salt) is stable across repeated runs on a fresh factory at the same address —
    ///      the local stand-in for "same factory address + same deployer on every chain" — independent of the
    ///      creation code deployed.
    function test_TeamAddressStableAcrossFreshFactories() public {
        address team = makeAddr("team");
        address canonical = makeAddr("canonical-factory");
        bytes memory runtime = address(factory).code;
        address[2] memory landed;
        for (uint256 run; run < 2; ++run) {
            uint256 snap = vm.snapshotState();
            vm.etch(canonical, runtime); // a fresh factory at the shared address
            bytes memory code = run == 0
                ? _mockTokenCode()
                : abi.encodePacked(type(MockToken).creationCode, abi.encode("Other", "OTH", uint8(18)));
            vm.prank(team);
            landed[run] = PoolmigoCreate3(canonical).deploy(SALT, code);
            assertEq(landed[run], PoolmigoCreate3(canonical).create3Address(team, SALT));
            vm.revertToState(snap);
        }
        assertEq(landed[0], landed[1], "same (factory, deployer, salt) -> same address, any code");
    }

    function test_DispatcherLockedToFactory() public {
        factory.deploy(SALT, _mockTokenCode());
        Create3Dispatcher dispatcher = Create3Dispatcher(factory.dispatcherAddress(address(this), SALT));
        assertEq(dispatcher.factory(), address(factory), "factory recorded");

        vm.expectRevert(Create3Dispatcher.Create3Dispatcher__Unauthorized.selector);
        dispatcher.dispatch(hex"00");
    }

    /*//////////////////////////////////////////////////////////////
                    4. FULL VAULT STACK VIA CREATE3
    //////////////////////////////////////////////////////////////*/

    /// @dev Also proves the initializer's arg-only semantics: it runs with msg.sender == dispatcher
    ///      (atomic deploy+initialize inside the proxy constructor), yet state comes from the args.
    function test_VaultProxyDeploysDeterministicallyAndInitializes() public {
        MockToken usdg = new MockToken("Mock USDG", "USDG", 6);
        MockToken weth = new MockToken("Mock WETH", "WETH", 18);
        address[] memory basket = new address[](2);
        basket[0] = address(usdg);
        basket[1] = address(weth);

        bytes memory initData = abi.encodeCall(
            MySunVaultUpgradeable(address(0)).initialize,
            (owner, "sunEthLP", "sunEthLP", basket, treasury, uint16(1500), 10_000e18, 500_000e18)
        );
        Options memory opts;
        Upgrades.validateImplementation("MySunVaultUpgradeable.sol", opts);
        address implementation = address(new MySunVaultUpgradeable());

        address predicted = factory.create3Address(address(this), SALT);
        bytes memory proxyCode = abi.encodePacked(type(ERC1967Proxy).creationCode, abi.encode(implementation, initData));
        address proxy = factory.deploy(SALT, proxyCode);

        assertEq(proxy, predicted, "proxy at deterministic address");

        MySunVaultUpgradeable vault = MySunVaultUpgradeable(proxy);
        assertEq(vault.owner(), owner);
        assertEq(vault.treasury(), treasury);
        assertEq(vault.performanceFeeBps(), 1500);
        assertEq(vault.genesisShares(), 10_000e18);
        assertEq(vault.maxTotalSupply(), 500_000e18);
        assertEq(vault.adapterCount(), 0);
        assertEq(vault.tokens().length, 2);
        assertEq(Upgrades.getImplementationAddress(proxy), implementation, "EIP-1967 slot");
    }
}
