// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {MySunVaultUpgradeable} from "contracts/MySunVaultUpgradeable.sol";
import {PoolmigoVaultCold} from "contracts/PoolmigoVaultCold.sol";
import {IPoolmigoVault} from "contracts/interfaces/IPoolmigoVault.sol";
import {IPositionAdapter} from "contracts/interfaces/IPositionAdapter.sol";
import {MockToken} from "test/mocks/MockToken.sol";
import {MockSwapAdapter} from "test/mocks/MockSwapAdapter.sol";
import {VaultImplArgs} from "test/utils/VaultImplArgs.sol";
import {VaultColdLink} from "script/VaultColdLink.sol";

contract ColdLinkProbe is VaultColdLink {}

/**
 * @notice {PoolmigoVaultCold} drift guard: the library re-declares the vault's ERC-7201 struct, its slot and the
 *         constants its bodies need, because a linked library cannot read the vault's. These tests fail when the copies
 *         drift:
 *         - statically, from the compiler's AST (`ast = true`): struct members (name + type, in order), slot, and the
 *           `MAX_ADAPTERS` / `CAP_*` literals against the vault; `VIRTUAL_*` against the `2736e67` vault (the last
 *           implementation that declared them — they moved into the library) via its committed build-info;
 *         - dynamically, on a live proxy: fields the library writes are read back by the vault (and at the raw slot
 *           offsets), and fields the vault writes drive the library's logic.
 *         Plus: direct calls to the library (CALL, not the vault's DELEGATECALL) cannot write anything.
 */
contract VaultColdLibraryTest is Test {
    string internal constant COLD_ARTIFACT = "out/PoolmigoVaultCold.sol/PoolmigoVaultCold.json";
    string internal constant VAULT_ARTIFACT = "out/PoolmigoVaultUpgradeable.sol/PoolmigoVaultUpgradeable.json";
    string internal constant MAIN_BUILD_INFO = "previous-builds/build-info-2736e67/f8c6c014509ee2bd.json";
    bytes32 internal constant ERC7201_BASE = keccak256(abi.encode(uint256(keccak256("poolmigo.vault.storage")) - 1))
        & ~bytes32(uint256(0xff));
    uint256 internal constant GENESIS = 1_000e18;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");

    MockToken internal t0;
    MockToken internal t1;
    address[] internal basket;
    MySunVaultUpgradeable internal vault;

    function setUp() public {
        t0 = new MockToken("T0", "T0", 18);
        t1 = new MockToken("T1", "T1", 18);
        basket.push(address(t0));
        basket.push(address(t1));
        MySunVaultUpgradeable impl = new MySunVaultUpgradeable(VaultImplArgs.depositSplit());
        vault = MySunVaultUpgradeable(
            address(
                new ERC1967Proxy(
                    address(impl),
                    abi.encodeCall(
                        MySunVaultUpgradeable(address(0)).initialize,
                        (owner, "sunLP", "sunLP", basket, treasury, uint16(1000), GENESIS, uint256(0))
                    )
                )
            )
        );
    }

    /*//////////////////////////////////////////////////////////////
                        STATIC: COMPILER AST
    //////////////////////////////////////////////////////////////*/

    function test_Drift_StructLayoutIdentical() public view {
        string memory cold = vm.readFile(COLD_ARTIFACT);
        string memory vlt = vm.readFile(VAULT_ARTIFACT);
        string memory coldStruct = "$.ast.nodes[?(@.name=='PoolmigoVaultCold')].nodes[?(@.name=='PoolmigoVaultStorage')]";
        string memory vaultStruct =
            "$.ast.nodes[?(@.name=='PoolmigoVaultUpgradeable')].nodes[?(@.name=='PoolmigoVaultStorage')]";

        string[] memory coldNames = _strings(cold, string.concat(coldStruct, ".members[*].name"));
        string[] memory vaultNames = _strings(vlt, string.concat(vaultStruct, ".members[*].name"));
        string[] memory coldTypes = _strings(cold, string.concat(coldStruct, ".members[*].typeDescriptions.typeString"));
        string[] memory vaultTypes =
            _strings(vlt, string.concat(vaultStruct, ".members[*].typeDescriptions.typeString"));

        assertEq(vaultNames.length, 12, "vault struct has its 12 fields");
        assertEq(coldNames, vaultNames, "member names, in order");
        assertEq(coldTypes, vaultTypes, "member types, in order");
    }

    function test_Drift_StorageSlotIdentical() public view {
        bytes32 coldSlot = vm.parseJsonBytes32(
            vm.readFile(COLD_ARTIFACT),
            "$.ast.nodes[?(@.name=='PoolmigoVaultCold')].nodes[?(@.name=='POOLMIGO_VAULT_STORAGE_LOCATION')].value.value"
        );
        bytes32 vaultSlot = vm.parseJsonBytes32(
            vm.readFile(VAULT_ARTIFACT),
            "$.ast.nodes[?(@.name=='PoolmigoVaultUpgradeable')].nodes[?(@.name=='POOLMIGO_VAULT_STORAGE_LOCATION')].value.value"
        );
        assertEq(vaultSlot, ERC7201_BASE, "vault slot = ERC-7201(poolmigo.vault.storage)");
        assertEq(coldSlot, vaultSlot, "library slot = vault slot");
    }

    function test_Drift_ConstantsMatchVault() public view {
        string memory cold = vm.readFile(COLD_ARTIFACT);
        string memory vlt = vm.readFile(VAULT_ARTIFACT);
        string[3] memory names = ["MAX_ADAPTERS", "CAP_LIQUIDITY", "CAP_SWAP"];
        uint256[3] memory getters = [vault.MAX_ADAPTERS(), uint256(vault.CAP_LIQUIDITY()), uint256(vault.CAP_SWAP())];
        for (uint256 i; i < 3; ++i) {
            string memory c = _literal(cold, "PoolmigoVaultCold", names[i]);
            assertEq(c, _literal(vlt, "PoolmigoVaultUpgradeable", names[i]), names[i]);
            assertEq(vm.parseUint(c), getters[i], string.concat(names[i], " = vault getter"));
        }
    }

    /// @dev The vault no longer declares VIRTUAL_* (moved into the library in aed498c): the reference is the `2736e67`
    ///      vault, read from its committed build-info.
    function test_Drift_VirtualOffsetsMatchMainVault() public view {
        string memory cold = vm.readFile(COLD_ARTIFACT);
        string memory main = vm.readFile(MAIN_BUILD_INFO);
        string memory mainVault =
            "$.output.sources['src/PoolmigoVaultUpgradeable.sol'].ast.nodes[?(@.name=='PoolmigoVaultUpgradeable')].nodes[?(@.name=='";
        string[2] memory names = ["VIRTUAL_SHARES", "VIRTUAL_ASSETS"];
        for (uint256 i; i < 2; ++i) {
            string memory m = abi.decode(vm.parseJson(main, string.concat(mainVault, names[i], "')].value.value")), (string));
            assertEq(_literal(cold, "PoolmigoVaultCold", names[i]), m, names[i]);
        }
    }

    /*//////////////////////////////////////////////////////////////
                     DYNAMIC: ONE NAMESPACE, TWO CODES
    //////////////////////////////////////////////////////////////*/

    /// @dev Library writes (addAdapter / setAdapterCapability) are what the vault reads, at the struct's raw offsets
    ///      (adapters = base + 3, isAdapter = base + 4, capabilities = base + 9). Vault writes (initialize /
    ///      setMaxTotalSupply) are what the library reads (tokens = base + 1, genesisShares = base + 6,
    ///      maxTotalSupply = base + 7).
    function test_Layout_LibraryAndVaultShareTheNamespace() public {
        MockSwapAdapter a = new MockSwapAdapter(basket, address(vault), "A", bytes32(uint256(1)));
        vm.prank(owner);
        vault.addAdapter(IPositionAdapter(address(a)));
        uint256 base = uint256(ERC7201_BASE);

        assertEq(vault.adapterCount(), 1);
        assertEq(uint256(vm.load(address(vault), bytes32(base + 3))), 1, "adapters.length at base+3");
        assertEq(
            address(uint160(uint256(vm.load(address(vault), keccak256(abi.encode(base + 3)))))),
            address(a),
            "adapters[0]"
        );
        assertTrue(vault.isAdapter(address(a)));
        assertEq(uint256(vm.load(address(vault), keccak256(abi.encode(address(a), base + 4)))), 1, "isAdapter");
        uint8 caps = vault.CAP_LIQUIDITY() | vault.CAP_SWAP();
        assertEq(vault.adapterCapabilities(IPositionAdapter(address(a))), caps, "ERC-165 caps");
        assertEq(uint256(vm.load(address(vault), keccak256(abi.encode(address(a), base + 9)))), caps, "capabilities");

        uint8 capSwap = vault.CAP_SWAP();
        vm.prank(owner);
        vault.setAdapterCapability(IPositionAdapter(address(a)), capSwap, false);
        assertEq(vault.adapterCapabilities(IPositionAdapter(address(a))), vault.CAP_LIQUIDITY());

        // Vault-written fields the library reads.
        assertEq(uint256(vm.load(address(vault), bytes32(base + 1))), 2, "tokens.length at base+1");
        (address[] memory tokens_,) = vault.totalTokens();
        assertEq(tokens_, basket, "library reads the vault's registry");
        assertEq(uint256(vm.load(address(vault), bytes32(base + 6))), GENESIS, "genesisShares at base+6");
        vm.prank(owner);
        (uint256 shares,) = vault.previewDeposit(basket, _pair(1, 1));
        assertEq(shares, GENESIS, "library quotes genesis K");
        vm.prank(owner);
        vault.setMaxTotalSupply(GENESIS);
        assertEq(uint256(vm.load(address(vault), bytes32(base + 7))), GENESIS, "maxTotalSupply at base+7");
    }

    /// @dev MAX_ADAPTERS enforced by the library equals the vault's public constant.
    function test_Layout_MaxAdaptersEnforcedAtVaultConstant() public {
        uint256 max = vault.MAX_ADAPTERS();
        vm.startPrank(owner);
        for (uint256 i; i < max; ++i) {
            vault.addAdapter(IPositionAdapter(address(new MockSwapAdapter(basket, address(vault), "A", bytes32(i)))));
        }
        IPositionAdapter extra = IPositionAdapter(address(new MockSwapAdapter(basket, address(vault), "X", 0)));
        vm.expectRevert(abi.encodeWithSelector(IPoolmigoVault.PoolmigoVault__MaxAdaptersReached.selector, max));
        vault.addAdapter(extra);
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                         DIRECT CALLS TO THE LIBRARY
    //////////////////////////////////////////////////////////////*/

    /// @dev Every state-changing entry point carries Solidity's library call protection: a direct CALL (not the
    ///      vault's DELEGATECALL) reverts before the body runs, even with the arguments a real call would use.
    function test_DirectCall_StateChangingEntryPointsRevert() public {
        address lib = address(PoolmigoVaultCold);
        assertGt(lib.code.length, 0, "library deployed and linked");
        IPositionAdapter a = IPositionAdapter(address(new MockSwapAdapter(basket, address(vault), "A", 0)));
        bytes[4] memory calls = [
            abi.encodeWithSelector(PoolmigoVaultCold.addAdapter.selector, a),
            abi.encodeWithSelector(PoolmigoVaultCold.setAdapterCapability.selector, a, uint8(1), false),
            abi.encodeWithSelector(PoolmigoVaultCold.removeAdapter.selector, a),
            abi.encodeWithSelector(PoolmigoVaultCold.forceRemoveAdapter.selector, a)
        ];
        for (uint256 i; i < 4; ++i) {
            (bool ok, bytes memory ret) = lib.call(calls[i]);
            assertFalse(ok, "direct call reverts");
            assertEq(ret.length, 0, "call-protection revert (no data)");
        }
    }

    /// @dev The views carry no call protection (Solidity emits it for state-changing library functions only). Called
    ///      directly they cannot write, and they see the library's own storage, which is empty: `previewDeposit`
    ///      reverts (no basket), `totalTokens` / `previewRedeem` return an empty basket — never the vault's state.
    function test_DirectCall_ViewsRevertOrSeeEmptyBasket() public {
        address lib = address(PoolmigoVaultCold);
        (bool ok,) = lib.staticcall(abi.encodeWithSelector(PoolmigoVaultCold.previewDeposit.selector, basket, _pair(1, 1)));
        assertFalse(ok, "previewDeposit reverts");

        bytes memory ret;
        (ok, ret) = lib.staticcall(abi.encodeWithSelector(PoolmigoVaultCold.totalTokens.selector));
        assertTrue(ok);
        (address[] memory tokens_, uint256[] memory amounts) = abi.decode(ret, (address[], uint256[]));
        assertEq(tokens_.length + amounts.length, 0, "totalTokens: empty basket");

        (ok, ret) = lib.staticcall(abi.encodeWithSelector(PoolmigoVaultCold.previewRedeem.selector, 1, 1));
        assertTrue(ok);
        (tokens_, amounts) = abi.decode(ret, (address[], uint256[]));
        assertEq(tokens_.length + amounts.length, 0, "previewRedeem: empty basket");
    }

    /*//////////////////////////////////////////////////////////////
                      DEPLOY SCRIPTS: LINKED-LIBRARY CHECK
    //////////////////////////////////////////////////////////////*/

    /// @dev {VaultColdLink} (inherited by every vault-implementation script) accepts the library Forge linked.
    function test_ColdLink_AcceptsThisBuildsLibrary() public {
        new ColdLinkProbe();
    }

    /// @dev ... and rejects a linked address whose code is not this build's library: one flipped byte, or no code (a
    ///      wrong `--libraries` address, or a chain without the CREATE2 deployer).
    function test_ColdLink_RejectsForeignOrMissingCode() public {
        address lib = address(PoolmigoVaultCold);
        bytes memory code = lib.code;
        code[code.length - 1] ^= 0x01;
        vm.etch(lib, code);
        vm.expectRevert("VaultColdLink: linked PoolmigoVaultCold is not this build's library");
        new ColdLinkProbe();

        vm.etch(lib, "");
        vm.expectRevert("VaultColdLink: linked PoolmigoVaultCold is not this build's library");
        new ColdLinkProbe();
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    function _literal(string memory json, string memory unit, string memory name) internal pure returns (string memory) {
        return abi.decode(
            vm.parseJson(json, string.concat("$.ast.nodes[?(@.name=='", unit, "')].nodes[?(@.name=='", name, "')].value.value")),
            (string)
        );
    }

    function _strings(string memory json, string memory path) internal pure returns (string[] memory) {
        return abi.decode(vm.parseJson(json, path), (string[]));
    }

    function _pair(uint256 a, uint256 b) internal pure returns (uint256[] memory arr) {
        arr = new uint256[](2);
        arr[0] = a;
        arr[1] = b;
    }
}
