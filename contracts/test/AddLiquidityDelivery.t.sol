// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {MySunVaultUpgradeable} from "contracts/MySunVaultUpgradeable.sol";
import {IPoolmigoVault} from "contracts/interfaces/IPoolmigoVault.sol";
import {IPositionAdapter} from "contracts/interfaces/IPositionAdapter.sol";
import {ILiquidityAdapter} from "contracts/interfaces/ILiquidityAdapter.sol";
import {MockToken} from "test/mocks/MockToken.sol";
import {MockDeliveryToken} from "test/mocks/MockDeliveryToken.sol";
import {MockPullingAdapter} from "test/mocks/MockPullingAdapter.sol";
import {VaultImplArgs} from "test/utils/VaultImplArgs.sol";

/// @notice Vault-side reserve check on `addLiquidity`. {MockPullingAdapter} sizes the op with `avail = pull`, as all
///         four production adapters do, so a short vault-to-adapter delivery is paid from the adapter's reserve (its
///         idle and, on v4, the fee bank — both plain token balance, pre-funded here as RESERVED).
contract AddLiquidityDeliveryTest is Test {
    uint256 internal constant GENESIS = 1_000e18;
    uint256 internal constant SEED = 1_000e18;
    uint256 internal constant RESERVED = 250e18;
    uint256 internal constant CAP = 100e18;
    uint256 internal constant FEE_BPS = 500; // 5%

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal keeper = makeAddr("keeper");

    MockDeliveryToken internal dt;
    MockToken internal other;
    MySunVaultUpgradeable internal vault;
    MockPullingAdapter internal adapter;

    function setUp() public {
        dt = new MockDeliveryToken("Delivery", "DLV");
        other = new MockToken("Other", "OTH", 18);
        address[] memory basket = new address[](2);
        basket[0] = address(dt);
        basket[1] = address(other);

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
        adapter = new MockPullingAdapter(basket, address(vault), keccak256("PULL"), bytes32(uint256(1)));

        vm.startPrank(owner);
        vault.addAdapter(IPositionAdapter(address(adapter)));
        vault.setKeeper(keeper, true);
        dt.mint(owner, SEED);
        other.mint(owner, SEED);
        dt.approve(address(vault), SEED);
        other.approve(address(vault), SEED);
        vault.deposit(basket, _pair(SEED, SEED), GENESIS, owner);
        vm.stopPrank();

        dt.mint(address(adapter), RESERVED);
        other.mint(address(adapter), RESERVED);
    }

    /// @dev Fee on the vault-to-adapter leg: the adapter receives CAP − fee but spends + refunds CAP, so the fee would
    ///      come out of its reserve. The vault reverts and nothing moves.
    function test_FoT_AddLiquidity_RevertsReserveUntouched() public {
        dt.setFee(address(vault), FEE_BPS);
        uint256 fee = CAP * FEE_BPS / 10_000;

        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                IPoolmigoVault.PoolmigoVault__AdapterReserveSpent.selector,
                address(adapter),
                address(dt),
                RESERVED,
                RESERVED - fee
            )
        );
        vault.addLiquidity(IPositionAdapter(address(adapter)), _add(CAP, CAP));

        assertEq(dt.balanceOf(address(adapter)), RESERVED, "adapter reserve untouched");
        assertEq(other.balanceOf(address(adapter)), RESERVED);
        assertEq(dt.balanceOf(address(vault)), SEED, "vault idle untouched");
        assertEq(other.balanceOf(address(vault)), SEED);
    }

    /// @dev Exact tokens: the adapter ends where it started; the vault is down exactly the spent half.
    function test_Exact_AddLiquidity_ReserveUntouched() public {
        vm.prank(keeper);
        vm.expectEmit(true, true, true, true, address(vault));
        emit IPoolmigoVault.LiquidityAdded(keeper, address(adapter), 42, 1e18, CAP / 2, CAP / 2, CAP / 2, CAP / 2);
        vault.addLiquidity(IPositionAdapter(address(adapter)), _add(CAP, CAP));

        assertEq(dt.balanceOf(address(adapter)), RESERVED);
        assertEq(other.balanceOf(address(adapter)), RESERVED);
        assertEq(dt.balanceOf(address(vault)), SEED - CAP / 2);
        assertEq(other.balanceOf(address(vault)), SEED - CAP / 2);
    }

    /// @dev 1-wei rounding token: the vault-to-adapter leg credits 1 wei less, so the adapter finishes 1 wei short.
    ///      The vault tops it up (1 + 2 wei, credited 2) instead of reverting; the adapter reserve stays whole and the
    ///      vault pays 3 wei beyond the op itself (<= 2 × ROUNDING_TOLERANCE).
    function test_RoundingToken_AddLiquidity_ToppedUpNotReverted() public {
        dt.setRoundingLoss(address(vault), 1);

        vm.prank(keeper);
        vault.addLiquidity(IPositionAdapter(address(adapter)), _add(CAP, CAP));

        uint256 reserve = dt.balanceOf(address(adapter));
        assertGe(reserve, RESERVED, "reserve whole");
        assertLe(reserve, RESERVED + 2, "surplus <= tolerance");
        // Vault: −CAP pull, +CAP/2 refund, −3 top-up.
        assertEq(dt.balanceOf(address(vault)), SEED - CAP / 2 - 3, "vault pays the op's rounding");
        assertEq(other.balanceOf(address(adapter)), RESERVED, "exact token untouched");
    }

    /// @dev A 3-wei drain is one above the tolerance: no top-up, revert.
    function test_RoundingAboveTolerance_AddLiquidity_Reverts() public {
        dt.setRoundingLoss(address(vault), 3);
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                IPoolmigoVault.PoolmigoVault__AdapterReserveSpent.selector,
                address(adapter),
                address(dt),
                RESERVED,
                RESERVED - 3
            )
        );
        vault.addLiquidity(IPositionAdapter(address(adapter)), _add(CAP, CAP));
    }

    function _add(uint256 cap0, uint256 cap1) internal pure returns (ILiquidityAdapter.AddLiquidityParams memory p) {
        p = ILiquidityAdapter.AddLiquidityParams({
            tickLower: -120,
            tickUpper: 240,
            liquidity: 1e18,
            minLiquidity: 0,
            maxAmount0: cap0,
            maxAmount1: cap1,
            minSwapOut: 0
        });
    }

    function _pair(uint256 a, uint256 b) internal pure returns (uint256[] memory arr) {
        arr = new uint256[](2);
        arr[0] = a;
        arr[1] = b;
    }
}
