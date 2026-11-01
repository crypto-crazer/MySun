// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC165} from "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {MySunVaultUpgradeable} from "contracts/MySunVaultUpgradeable.sol";
import {IPositionAdapter} from "contracts/interfaces/IPositionAdapter.sol";
import {ILiquidityAdapter} from "contracts/interfaces/ILiquidityAdapter.sol";
import {MockToken} from "test/mocks/MockToken.sol";
import {VaultImplArgs} from "test/utils/VaultImplArgs.sol";

/// @notice Fee slice shared by V3 `_withdrawFromPosition`, V4 `withdrawProportional` and the native adapter:
///         `fees_i = floor(feeBalance_i * sharesWad / 1e18)`, included in the delivered amount. `sharesWad` is
///         `floor(shares * 1e18 / supply)` on redeem and `sharesBps * 1e14` on `pullFrom`. Harvest and a positive
///         `removeLiquidity` realize the whole fee balance (V3 collect-max, V4 take-bank). Native amounts are the
///         same numbers in WETH. This mock is that formula, so one vault run covers the three adapters' reporting.
contract ProRataFeeAdapter is IPositionAdapter, ILiquidityAdapter, ERC165 {
    using SafeERC20 for IERC20;

    uint256 internal constant WAD = 1e18;

    address public immutable vault;
    IERC20 public immutable token0;
    IERC20 public immutable token1;
    uint256 public principal0;
    uint256 public principal1;
    uint256 public fees0;
    uint256 public fees1;

    error OnlyVault();

    modifier onlyVault() {
        if (msg.sender != vault) revert OnlyVault();
        _;
    }

    constructor(address vault_, IERC20 token0_, IERC20 token1_) {
        vault = vault_;
        token0 = token0_;
        token1 = token1_;
    }

    function accrue(uint256 f0, uint256 f1) external {
        if (f0 != 0) {
            MockToken(address(token0)).mint(address(this), f0);
            fees0 += f0;
        }
        if (f1 != 0) {
            MockToken(address(token1)).mint(address(this), f1);
            fees1 += f1;
        }
    }

    function dex() external pure returns (bytes32) {
        return keccak256("FEE_ORDER");
    }

    function poolId() external pure returns (bytes32) {
        return bytes32(uint256(1));
    }

    function position() public view returns (address[] memory tokens, uint256[] memory amounts) {
        tokens = _tokens();
        amounts = new uint256[](2);
        amounts[0] = principal0 + fees0;
        amounts[1] = principal1 + fees1;
    }

    function deploy(uint256[] calldata amounts)
        external
        onlyVault
        returns (address[] memory tokens, uint256[] memory deployed)
    {
        tokens = _tokens();
        deployed = new uint256[](2);
        if (amounts[0] != 0) {
            token0.safeTransferFrom(vault, address(this), amounts[0]);
            principal0 += amounts[0];
            deployed[0] = amounts[0];
        }
        if (amounts[1] != 0) {
            token1.safeTransferFrom(vault, address(this), amounts[1]);
            principal1 += amounts[1];
            deployed[1] = amounts[1];
        }
    }

    function withdrawProportional(uint256 sharesWad, address to)
        external
        onlyVault
        returns (address[] memory tokens, uint256[] memory amounts, uint256[] memory fees)
    {
        tokens = _tokens();
        amounts = new uint256[](2);
        fees = new uint256[](2);
        uint256 p0 = Math.mulDiv(principal0, sharesWad, WAD);
        uint256 p1 = Math.mulDiv(principal1, sharesWad, WAD);
        uint256 f0 = Math.mulDiv(fees0, sharesWad, WAD);
        uint256 f1 = Math.mulDiv(fees1, sharesWad, WAD);
        principal0 -= p0;
        principal1 -= p1;
        fees0 -= f0;
        fees1 -= f1;
        amounts[0] = p0 + f0;
        amounts[1] = p1 + f1;
        fees[0] = f0;
        fees[1] = f1;
        _send(to, amounts[0], amounts[1]);
    }

    function harvest() external onlyVault returns (address[] memory tokens, uint256[] memory amounts) {
        tokens = _tokens();
        amounts = new uint256[](2);
        amounts[0] = fees0;
        amounts[1] = fees1;
        fees0 = 0;
        fees1 = 0;
        _send(vault, amounts[0], amounts[1]);
    }

    function unwindAll(address to)
        external
        onlyVault
        returns (address[] memory tokens, uint256[] memory amounts, uint256[] memory fees)
    {
        tokens = _tokens();
        amounts = new uint256[](2);
        fees = new uint256[](2);
        fees[0] = fees0;
        fees[1] = fees1;
        amounts[0] = principal0 + fees0;
        amounts[1] = principal1 + fees1;
        principal0 = 0;
        principal1 = 0;
        fees0 = 0;
        fees1 = 0;
        _send(to, amounts[0], amounts[1]);
    }

    function tokenId() external pure returns (uint256) {
        return 7;
    }

    function rangeConstraints() external pure returns (int24, int24, int24, int24) {
        return (-887_272, 887_272, 1, 1_774_544);
    }

    function positionState() external pure returns (uint256, int24, int24, uint128, uint32) {
        return (7, -120, 120, 1, 1);
    }

    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return interfaceId == type(ILiquidityAdapter).interfaceId || super.supportsInterface(interfaceId);
    }

    function addLiquidity(AddLiquidityParams calldata)
        external
        pure
        returns (uint256, uint128, uint256, uint256, uint256, uint256)
    {
        revert("unused");
    }

    /// @dev Positive liquidity realizes the whole fee balance plus principal, matching V3 collect-max and V4 take-bank.
    function removeLiquidity(RemoveLiquidityParams calldata p)
        external
        onlyVault
        returns (uint256, uint256, uint256, uint256, uint256, uint256)
    {
        if (p.liquidity == 0) return (0, 0, 0, 0, 0, 0);
        uint256 p0 = principal0;
        uint256 p1 = principal1;
        uint256 f0 = fees0;
        uint256 f1 = fees1;
        principal0 = 0;
        principal1 = 0;
        fees0 = 0;
        fees1 = 0;
        _send(vault, p0 + f0, p1 + f1);
        return (p0, p1, f0, f1, 0, 0);
    }

    function _tokens() internal view returns (address[] memory tokens) {
        tokens = new address[](2);
        tokens[0] = address(token0);
        tokens[1] = address(token1);
    }

    function _send(address to, uint256 a0, uint256 a1) internal {
        if (a0 != 0) token0.safeTransfer(to, a0);
        if (a1 != 0) token1.safeTransfer(to, a1);
    }
}

/// @notice Issue #3: harvest-then-redeem and redeem-before-harvest charge the treasury the same fee on the
///         redeemed shares (within 1 wei). `pullFrom(10_000)` and a positive `removeLiquidity` match a full harvest.
contract FeeOrderTest is Test {
    uint256 internal constant GENESIS = 100e18;
    uint16 internal constant FEE_BPS = 1500;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal keeper = makeAddr("keeper");
    address internal attacker = makeAddr("attacker");

    struct World {
        MySunVaultUpgradeable vault;
        ProRataFeeAdapter adapter;
        MockToken t0;
        MockToken t1;
    }

    /// @dev Issue example. 100 shares, attacker holds 50, 100 principal and 100 fees, 15% fee.
    ///      Harvest first pays the treasury 15; the half attributable to the redeemed shares is 7.5.
    ///      Redeem first pays the treasury 7.5. The attacker receives 92.5 either way.
    function test_issueExample_redeemVsHarvest_attributableFeeMatches() public {
        World memory a = _world(FEE_BPS);
        World memory b = _world(FEE_BPS);
        _seedPosition(a, 100e18, 100e18, 100e18, 100e18);
        _seedPosition(b, 100e18, 100e18, 100e18, 100e18);
        _giveHalf(a);
        _giveHalf(b);

        uint256 shares = GENESIS / 2;

        vm.prank(keeper);
        a.vault.rebalance();
        uint256 harvestCut0 = a.t0.balanceOf(treasury);
        uint256 harvestCut1 = a.t1.balanceOf(treasury);
        vm.prank(attacker);
        a.vault.redeem(shares, attacker);

        vm.prank(attacker);
        b.vault.redeem(shares, attacker);

        assertEq(harvestCut0, 15e18, "harvest charges the whole fee");
        assertEq(harvestCut1, 15e18);
        assertEq(b.t0.balanceOf(treasury), 7.5e18, "redeem-first charges the exiting slice");
        assertEq(b.t1.balanceOf(treasury), 7.5e18);
        assertEq(b.t0.balanceOf(treasury), harvestCut0 / 2, "attributable fee matches");
        assertEq(b.t1.balanceOf(treasury), harvestCut1 / 2);
        assertEq(a.t0.balanceOf(attacker), b.t0.balanceOf(attacker), "receiver token0");
        assertEq(a.t1.balanceOf(attacker), b.t1.balanceOf(attacker), "receiver token1");
        assertEq(a.t0.balanceOf(attacker), 92.5e18);
    }

    /// @dev A 100% redemption charges the same treasury amount in either order (15% of 80e18 / 40e18).
    function test_fullRedeem_treasuryIdenticalEitherOrder() public {
        World memory a = _world(FEE_BPS);
        World memory b = _world(FEE_BPS);
        _seedPosition(a, 100e18, 80e18, 100e18, 40e18);
        _seedPosition(b, 100e18, 80e18, 100e18, 40e18);

        vm.prank(keeper);
        a.vault.rebalance();
        vm.prank(owner);
        a.vault.redeem(GENESIS, owner);

        vm.prank(owner);
        b.vault.redeem(GENESIS, owner);

        assertEq(a.t0.balanceOf(treasury), b.t0.balanceOf(treasury), "full exit token0");
        assertEq(a.t1.balanceOf(treasury), b.t1.balanceOf(treasury), "full exit token1");
        assertEq(a.t0.balanceOf(treasury), 12e18);
        assertEq(a.t1.balanceOf(treasury), 6e18);
        assertEq(a.t0.balanceOf(owner), b.t0.balanceOf(owner));
        assertEq(a.t1.balanceOf(owner), b.t1.balanceOf(owner));
    }

    function test_pullFromFull_matchesHarvest_pullFromHalf_withinRounding() public {
        World memory harvested = _world(FEE_BPS);
        World memory pulledAll = _world(FEE_BPS);
        World memory pulledHalf = _world(FEE_BPS);
        _seedPosition(harvested, 100e18, 100e18, 100e18, 100e18);
        _seedPosition(pulledAll, 100e18, 100e18, 100e18, 100e18);
        _seedPosition(pulledHalf, 100e18, 100e18, 100e18, 100e18);

        vm.prank(keeper);
        harvested.vault.rebalance();
        vm.prank(keeper);
        pulledAll.vault.pullFrom(IPositionAdapter(address(pulledAll.adapter)), 10_000);
        vm.prank(keeper);
        pulledHalf.vault.pullFrom(IPositionAdapter(address(pulledHalf.adapter)), 5_000);

        assertEq(pulledAll.t0.balanceOf(treasury), harvested.t0.balanceOf(treasury));
        assertEq(pulledAll.t1.balanceOf(treasury), harvested.t1.balanceOf(treasury));
        assertEq(pulledHalf.t0.balanceOf(treasury), harvested.t0.balanceOf(treasury) / 2);
        assertEq(pulledHalf.t1.balanceOf(treasury), harvested.t1.balanceOf(treasury) / 2);
    }

    function test_removeLiquidity_wholeBankMatchesHarvest() public {
        World memory harvested = _world(FEE_BPS);
        World memory removed = _world(FEE_BPS);
        _seedPosition(harvested, 100e18, 70e18, 100e18, 70e18);
        _seedPosition(removed, 100e18, 70e18, 100e18, 70e18);

        vm.prank(keeper);
        harvested.vault.rebalance();
        vm.prank(keeper);
        removed.vault
            .removeLiquidity(
                IPositionAdapter(address(removed.adapter)),
                ILiquidityAdapter.RemoveLiquidityParams({liquidity: 1, minPrincipal0: 0, minPrincipal1: 0})
            );

        assertEq(removed.t0.balanceOf(treasury), harvested.t0.balanceOf(treasury), "remove == harvest token0");
        assertEq(removed.t1.balanceOf(treasury), harvested.t1.balanceOf(treasury), "remove == harvest token1");
        assertEq(removed.t0.balanceOf(address(removed.vault)), 100e18 + 70e18 - harvested.t0.balanceOf(treasury));
    }

    /// @dev Attributable fee = `floor(harvestCut * shares / supply)` versus the redeem-first cut. Bound is 1 wei.
    function testFuzz_partialRedeem_attributableFeeWithinOneWei(
        uint128 principal0,
        uint128 fee0,
        uint128 principal1,
        uint128 fee1,
        uint16 bps,
        uint256 shareBps
    ) public {
        principal0 = uint128(bound(principal0, 0, 1e24));
        fee0 = uint128(bound(fee0, 0, 1e24));
        principal1 = uint128(bound(principal1, 0, 1e24));
        fee1 = uint128(bound(fee1, 0, 1e24));
        bps = uint16(bound(bps, 0, 3000));
        shareBps = bound(shareBps, 1, 10_000);
        if (principal0 + fee0 == 0 && principal1 + fee1 == 0) fee0 = 1;

        World memory harvested = _world(bps);
        World memory redeemed = _world(bps);
        _seedPosition(harvested, principal0, fee0, principal1, fee1);
        _seedPosition(redeemed, principal0, fee0, principal1, fee1);

        uint256 shares = GENESIS * shareBps / 10_000;
        if (shares == 0) shares = 1;

        vm.prank(keeper);
        harvested.vault.rebalance();
        uint256 h0 = harvested.t0.balanceOf(treasury);
        uint256 h1 = harvested.t1.balanceOf(treasury);

        vm.prank(owner);
        redeemed.vault.redeem(shares, owner);
        uint256 r0 = redeemed.t0.balanceOf(treasury);
        uint256 r1 = redeemed.t1.balanceOf(treasury);

        assertLe(_delta(r0, h0 * shares / GENESIS), 1, "token0 attributable");
        assertLe(_delta(r1, h1 * shares / GENESIS), 1, "token1 attributable");

        if (shareBps == 10_000) {
            assertEq(r0, h0, "100% redeem treasury token0");
            assertEq(r1, h1, "100% redeem treasury token1");
        }
    }

    function _delta(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a - b : b - a;
    }

    function _world(uint16 bps) internal returns (World memory w) {
        w.t0 = new MockToken("T0", "T0", 18);
        w.t1 = new MockToken("T1", "T1", 18);
        address[] memory basket = new address[](2);
        basket[0] = address(w.t0);
        basket[1] = address(w.t1);
        MySunVaultUpgradeable impl = new MySunVaultUpgradeable(VaultImplArgs.depositSplit());
        w.vault = MySunVaultUpgradeable(
            address(
                new ERC1967Proxy(
                    address(impl),
                    abi.encodeCall(
                        MySunVaultUpgradeable(address(0)).initialize,
                        (owner, "sunLP", "sunLP", basket, treasury, bps, GENESIS, uint256(0))
                    )
                )
            )
        );
        w.adapter = new ProRataFeeAdapter(address(w.vault), w.t0, w.t1);
        vm.prank(owner);
        w.vault.addAdapter(IPositionAdapter(address(w.adapter)));
        vm.prank(owner);
        w.vault.setKeeper(keeper, true);
    }

    /// @dev A zero principal is seeded as 1 wei so genesis can pull a non-zero basket. The fee bucket is separate.
    function _seedPosition(World memory w, uint256 p0, uint256 f0, uint256 p1, uint256 f1) internal {
        uint256 s0 = p0 == 0 ? 1 : p0;
        uint256 s1 = p1 == 0 ? 1 : p1;
        w.t0.mint(owner, s0);
        w.t1.mint(owner, s1);
        vm.startPrank(owner);
        w.t0.approve(address(w.vault), type(uint256).max);
        w.t1.approve(address(w.vault), type(uint256).max);
        address[] memory basket = new address[](2);
        basket[0] = address(w.t0);
        basket[1] = address(w.t1);
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = s0;
        amounts[1] = s1;
        w.vault.deposit(basket, amounts, GENESIS, owner);
        vm.stopPrank();
        uint256[] memory dep = new uint256[](2);
        dep[0] = s0;
        dep[1] = s1;
        vm.prank(keeper);
        w.vault.deployTo(IPositionAdapter(address(w.adapter)), dep);
        w.adapter.accrue(f0, f1);
    }

    function _giveHalf(World memory w) internal {
        vm.prank(owner);
        w.vault.transfer(attacker, GENESIS / 2);
    }
}
