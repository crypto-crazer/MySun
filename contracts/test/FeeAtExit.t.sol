// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import {Test, Vm} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {MySunVaultUpgradeable} from "contracts/MySunVaultUpgradeable.sol";
import {IPoolmigoVault} from "contracts/interfaces/IPoolmigoVault.sol";
import {IPositionAdapter} from "contracts/interfaces/IPositionAdapter.sol";
import {ILiquidityAdapter} from "contracts/interfaces/ILiquidityAdapter.sol";
import {MockToken} from "test/mocks/MockToken.sol";
import {MockPositionAdapter} from "test/mocks/MockPositionAdapter.sol";
import {MockLiquidityAdapter} from "test/mocks/MockLiquidityAdapter.sol";
import {ProRataFeeAdapter} from "test/mocks/ProRataFeeAdapter.sol";
import {VaultImplArgs} from "test/utils/VaultImplArgs.sol";

/**
 * @notice Fee-at-exit (owner ruling 2026-10-03): whenever accrued position fees leave a position the vault skims
 *         `performanceFeeBps` of them to `treasury` FIRST, in kind, per token — on {redeem}, {pullFrom},
 *         {removeLiquidity} and {emergencyUnwind} as on {rebalance}. Principal and idle are never skimmed. The fee
 *         split comes from the adapters' own return values (mocks: {MockPositionAdapter-setReportedFeeBps}, and
 *         {MockLiquidityAdapter-setRemoveDelivers} for a removal that really delivers what it reports).
 */
contract FeeAtExitTest is Test {
    MySunVaultUpgradeable internal vault;
    MockToken internal usdg; // 6dp
    MockToken internal weth; // 18dp
    MockPositionAdapter internal a1;
    MockPositionAdapter internal a2;
    MockLiquidityAdapter internal la;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal keeper = makeAddr("keeper");
    address internal bob = makeAddr("bob");
    address internal attacker = makeAddr("attacker");

    struct World {
        MySunVaultUpgradeable vault;
        ProRataFeeAdapter adapter;
        MockToken t0;
        MockToken t1;
    }

    uint16 internal constant FEE_BPS = 1000; // the ruling's 10%
    uint16 internal constant ORDER_FEE_BPS = 1500; // the issue #3 example's 15%
    uint256 internal constant BPS = 10_000;
    uint256 internal constant GENESIS = 1_000e18;
    uint256 internal constant SEED_USDG = 1_000e6;
    uint256 internal constant SEED_WETH = 1e18;

    address[] internal basket;

    function setUp() public {
        usdg = new MockToken("Mock USDG", "USDG", 6);
        weth = new MockToken("Mock WETH", "WETH", 18);
        basket.push(address(usdg));
        basket.push(address(weth));

        MySunVaultUpgradeable impl = new MySunVaultUpgradeable(VaultImplArgs.depositSplit());
        vault = MySunVaultUpgradeable(
            address(
                new ERC1967Proxy(
                    address(impl),
                    abi.encodeCall(
                        MySunVaultUpgradeable(address(0)).initialize,
                        (owner, "sunEthLP", "sunEthLP", basket, treasury, FEE_BPS, GENESIS, uint256(0))
                    )
                )
            )
        );
        a1 = new MockPositionAdapter(basket, address(vault), keccak256("A1"), bytes32(uint256(1)));
        a2 = new MockPositionAdapter(basket, address(vault), keccak256("A2"), bytes32(uint256(2)));
        la = new MockLiquidityAdapter(basket, address(vault), keccak256("LA"), bytes32(uint256(3)));

        vm.startPrank(owner);
        vault.addAdapter(IPositionAdapter(address(a1)));
        vault.addAdapter(IPositionAdapter(address(a2)));
        vault.addAdapter(IPositionAdapter(address(la)));
        vault.setKeeper(keeper, true);
        usdg.mint(owner, SEED_USDG);
        weth.mint(owner, SEED_WETH);
        usdg.approve(address(vault), type(uint256).max);
        weth.approve(address(vault), type(uint256).max);
        vault.deposit(basket, _amts(SEED_USDG, SEED_WETH), GENESIS, owner);
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                                 REDEEM
    //////////////////////////////////////////////////////////////*/

    /// @dev Idle slice + adapter slice − floor(fees × 10%) to the receiver; the cut to the treasury; the vault keeps
    ///      exactly the remaining holders' idle; `Redeemed.amounts` and the return value are the NET delivery.
    function test_Redeem_SkimsFeeSliceAndReportsNet() public {
        _deploy(a1, 500e6, 0.5e18);
        a1.setReportedFeeBps(2_000); // 20% of the delivered slice is accrued fees

        // Quarter of the supply: idle slice 125e6 / 0.125e18; a1 slice 125e6 / 0.125e18 of which fees 25e6 / 0.025e18.
        uint256[] memory cut = _amts(2.5e6, 0.0025e18);
        uint256[] memory net = _amts(250e6 - 2.5e6, 0.25e18 - 0.0025e18);
        uint256[2] memory vaultBefore = _bal(address(vault));

        vm.prank(owner);
        vm.expectEmit(true, false, false, true, address(vault));
        emit IPoolmigoVault.PerformanceFeeAccrued(treasury, basket, cut);
        vm.expectEmit(true, true, false, true, address(vault));
        emit IPoolmigoVault.Redeemed(owner, bob, GENESIS / 4, basket, net);
        (address[] memory t, uint256[] memory sent) = vault.redeem(GENESIS / 4, bob);

        assertEq(t[0], address(usdg));
        assertEq(sent[0], net[0], "return = net");
        assertEq(sent[1], net[1], "return = net");
        assertEq(usdg.balanceOf(bob), net[0], "receiver got the net");
        assertEq(weth.balanceOf(bob), net[1]);
        assertEq(usdg.balanceOf(treasury), cut[0], "treasury got the cut");
        assertEq(weth.balanceOf(treasury), cut[1]);
        // The vault paid out exactly its idle slice (the adapter slice passed through, minus the cut).
        assertEq(usdg.balanceOf(address(vault)), vaultBefore[0] - 125e6);
        assertEq(weth.balanceOf(address(vault)), vaultBefore[1] - 0.125e18);
        // Principal + fees left the adapter pro-rata; no approvals linger.
        (, uint256[] memory pos) = a1.position();
        assertEq(pos[0], 375e6);
        assertEq(pos[1], 0.375e18);
    }

    /// @dev The cut is floor(Σ fees × bps) over the COMBINED fee slices of all adapters (like {rebalance}'s combined
    ///      harvest) — two 5-wei fee slices skim 1 wei, not 0 + 0. A token whose cut floors to 0 gets no transfer and,
    ///      when no token has a cut, there is no event.
    function test_Redeem_CutFloorsOnCombinedFees() public {
        _deploy(a1, 10, 0);
        _deploy(a2, 10, 0);
        a1.setReportedFeeBps(BPS);
        a2.setReportedFeeBps(BPS);
        // Half the supply: each adapter delivers 5 wei of USDG, all of it fees → Σ 10 → cut 1 (WETH: no fees, cut 0).
        vm.prank(owner);
        vm.expectEmit(true, false, false, true, address(vault));
        emit IPoolmigoVault.PerformanceFeeAccrued(treasury, basket, _amts(1, 0));
        (, uint256[] memory sent) = vault.redeem(GENESIS / 2, bob);
        assertEq(usdg.balanceOf(treasury), 1);
        assertEq(weth.balanceOf(treasury), 0);
        assertEq(sent[0], (SEED_USDG - 20) / 2 + 10 - 1);
        assertEq(sent[1], SEED_WETH / 2);
        assertEq(usdg.balanceOf(bob), sent[0]);

        // A fifth of the remaining supply: 1 wei fee slice per adapter → Σ 2 → 10% floors to 0 → no transfer, no event.
        vm.recordLogs();
        vm.prank(owner);
        vault.redeem(GENESIS / 10, bob);
        assertEq(_feeEvents(vm.getRecordedLogs()), 0, "zero cut: no event");
        assertEq(usdg.balanceOf(treasury), 1, "zero cut: no transfer");
    }

    /// @dev `performanceFeeBps == 0`: redeem delivers the full gross slice, nothing to the treasury, no fee event.
    function test_Redeem_ZeroFeeBpsIsNoOp() public {
        vm.prank(owner);
        vault.setPerformanceFeeBps(0);
        _deploy(a1, 500e6, 0.5e18);
        a1.setReportedFeeBps(BPS);

        vm.recordLogs();
        vm.prank(owner);
        (, uint256[] memory sent) = vault.redeem(GENESIS / 4, bob);
        assertEq(_feeEvents(vm.getRecordedLogs()), 0, "no PerformanceFeeAccrued");
        assertEq(sent[0], 250e6);
        assertEq(sent[1], 0.25e18);
        assertEq(usdg.balanceOf(treasury) + weth.balanceOf(treasury), 0);
    }

    /// @dev Adapters reporting no fees (the default) → no skim even with a non-zero fee: principal is never skimmed.
    function test_Redeem_PrincipalOnlyIsNoOp() public {
        _deploy(a1, 500e6, 0.5e18);
        a1.simulateFees(_amts(50e6, 0)); // accrued, but this mock reports a 0 fee split by default
        vm.recordLogs();
        vm.prank(owner);
        vault.redeem(GENESIS / 4, bob);
        assertEq(_feeEvents(vm.getRecordedLogs()), 0);
        assertEq(usdg.balanceOf(treasury), 0);
    }

    /// @dev The last holder redeems everything at the max fee with an all-fees adapter slice: the redemption still
    ///      goes through (the skim only adds plain transfers) and the vault ends EMPTY — every unit went to the
    ///      receiver or the treasury (it never paid out more than it held).
    function test_Redeem_FullSupplyAtMaxFeeDrainsExactly() public {
        vm.prank(owner);
        vault.setPerformanceFeeBps(3000);
        _deploy(a1, 400e6, 0.4e18);
        _deploy(a2, 100e6, 0);
        a1.setReportedFeeBps(BPS);
        a2.setReportedFeeBps(3_333);

        vm.prank(owner);
        (, uint256[] memory sent) = vault.redeem(GENESIS, bob);

        uint256 fees0 = 400e6 + Math.mulDiv(100e6, 3_333, BPS);
        uint256 cut0 = Math.mulDiv(fees0, 3000, BPS);
        uint256 cut1 = Math.mulDiv(0.4e18, 3000, BPS);
        assertEq(usdg.balanceOf(treasury), cut0);
        assertEq(weth.balanceOf(treasury), cut1);
        assertEq(sent[0], SEED_USDG - cut0);
        assertEq(sent[1], SEED_WETH - cut1);
        assertEq(usdg.balanceOf(bob), sent[0]);
        assertEq(weth.balanceOf(bob), sent[1]);
        assertEq(usdg.balanceOf(address(vault)) + weth.balanceOf(address(vault)), 0, "vault drained exactly");
        assertEq(vault.totalSupply(), 0);
    }

    /// @dev Conservation per token for any shares / fee split / fee bps: what left the vault + adapters equals what
    ///      reached the receiver + the treasury; the cut is floor(Σ fees × bps); the receiver got exactly
    ///      `Redeemed.amounts`; nothing stays behind in the vault beyond the remaining holders' idle.
    function testFuzz_Redeem_Conservation(uint256 shares, uint256 split1, uint256 split2, uint16 feeBps) public {
        shares = bound(shares, 1, GENESIS);
        split1 = bound(split1, 0, BPS);
        split2 = bound(split2, 0, BPS);
        feeBps = uint16(bound(feeBps, 0, 3000));
        vm.prank(owner);
        vault.setPerformanceFeeBps(feeBps);
        _deploy(a1, 300e6 + 7, 0.3e18 + 3);
        _deploy(a2, 200e6 + 1, 0.2e18 + 11);
        a1.simulateFees(_amts(13e6 + 5, 0.01e18 + 9));
        a1.setReportedFeeBps(split1);
        a2.setReportedFeeBps(split2);

        uint256 sharesWad = Math.mulDiv(shares, 1e18, GENESIS);
        uint256[2] memory idleSlice;
        uint256[2] memory fees;
        uint256[2] memory gross;
        for (uint256 i; i < 2; ++i) {
            idleSlice[i] = Math.mulDiv(shares, _tok(i).balanceOf(address(vault)), GENESIS);
            (uint256 g1, uint256 f1) = _slice(a1, i, sharesWad, split1);
            (uint256 g2, uint256 f2) = _slice(a2, i, sharesWad, split2);
            gross[i] = g1 + g2;
            fees[i] = f1 + f2;
        }
        uint256[2] memory systemBefore = _system();

        vm.prank(owner);
        (, uint256[] memory sent) = vault.redeem(shares, bob);

        uint256[2] memory systemAfter = _system();
        for (uint256 i; i < 2; ++i) {
            uint256 cut = Math.mulDiv(fees[i], feeBps, BPS);
            assertLe(fees[i], gross[i], "fees <= amounts");
            assertEq(_tok(i).balanceOf(treasury), cut, "cut = floor(sum fees * bps)");
            assertEq(sent[i], idleSlice[i] + gross[i] - cut, "net = idle + slices - cut");
            assertEq(_tok(i).balanceOf(bob), sent[i], "receiver got Redeemed.amounts");
            assertEq(systemBefore[i] - systemAfter[i], sent[i] + cut, "in == out + cut");
        }
    }

    /*//////////////////////////////////////////////////////////////
                                PULLFROM
    //////////////////////////////////////////////////////////////*/

    /// @dev The cut leaves to the treasury; the rest of the slice stays as vault idle; `PulledFrom` keeps the GROSS
    ///      amounts (as does the return value); basket totals drop by exactly the cut.
    function test_PullFrom_SkimsFeesRestStaysIdle() public {
        _deploy(a1, 400e6, 0.4e18);
        a1.setReportedFeeBps(5_000);
        (, uint256[] memory totalsBefore) = vault.totalTokens();
        uint256[2] memory idleBefore = _bal(address(vault));

        uint256[] memory cut = _amts(5e6, 0.005e18); // 10% of fees 50e6 / 0.05e18 inside the 100e6 / 0.1e18 slice
        vm.prank(keeper);
        vm.expectEmit(true, false, false, true, address(vault));
        emit IPoolmigoVault.PerformanceFeeAccrued(treasury, basket, cut);
        vm.expectEmit(true, true, false, true, address(vault));
        emit IPoolmigoVault.PulledFrom(keeper, address(a1), 2_500, basket, _amts(100e6, 0.1e18));
        (, uint256[] memory got) = vault.pullFrom(IPositionAdapter(address(a1)), 2_500);

        assertEq(got[0], 100e6, "gross");
        assertEq(got[1], 0.1e18, "gross");
        assertEq(usdg.balanceOf(address(vault)), idleBefore[0] + 100e6 - cut[0]);
        assertEq(weth.balanceOf(address(vault)), idleBefore[1] + 0.1e18 - cut[1]);
        assertEq(usdg.balanceOf(treasury), cut[0]);
        assertEq(weth.balanceOf(treasury), cut[1]);
        (, uint256[] memory totalsAfter) = vault.totalTokens();
        assertEq(totalsBefore[0] - totalsAfter[0], cut[0], "totals drop by the cut only");
        assertEq(totalsBefore[1] - totalsAfter[1], cut[1]);
        assertEq(usdg.balanceOf(keeper) + weth.balanceOf(keeper), 0, "nothing reaches the caller");
    }

    /// @dev Floor per token: 99 wei of fees at 10% skim 9; 9 wei skim 0 → no transfer, no event.
    function test_PullFrom_FloorAndZeroSlice() public {
        _deploy(a1, 396, 36);
        a1.setReportedFeeBps(BPS);
        vm.prank(keeper);
        vm.expectEmit(true, false, false, true, address(vault));
        emit IPoolmigoVault.PerformanceFeeAccrued(treasury, basket, _amts(9, 0));
        vault.pullFrom(IPositionAdapter(address(a1)), 2_500); // 99 USDG wei (cut 9), 9 WETH wei (cut 0)
        assertEq(usdg.balanceOf(treasury), 9);
        assertEq(weth.balanceOf(treasury), 0);

        _deploy(a2, 36, 0);
        a2.setReportedFeeBps(BPS);
        vm.recordLogs();
        vm.prank(keeper);
        vault.pullFrom(IPositionAdapter(address(a2)), 2_500); // 9 wei of fees → cut 0
        assertEq(_feeEvents(vm.getRecordedLogs()), 0, "zero cut: no event");
        assertEq(usdg.balanceOf(treasury), 9, "zero cut: no transfer");
    }

    function test_PullFrom_ZeroFeeBpsIsNoOp() public {
        vm.prank(owner);
        vault.setPerformanceFeeBps(0);
        _deploy(a1, 400e6, 0.4e18);
        a1.setReportedFeeBps(BPS);
        uint256[2] memory idleBefore = _bal(address(vault));
        vm.recordLogs();
        vm.prank(keeper);
        vault.pullFrom(IPositionAdapter(address(a1)), 10_000);
        assertEq(_feeEvents(vm.getRecordedLogs()), 0);
        assertEq(usdg.balanceOf(address(vault)), idleBefore[0] + 400e6, "whole slice stays idle");
        assertEq(weth.balanceOf(address(vault)), idleBefore[1] + 0.4e18);
    }

    /*//////////////////////////////////////////////////////////////
                            REMOVELIQUIDITY
    //////////////////////////////////////////////////////////////*/

    /// @dev The skim runs on the adapter-reported `fees0/fees1` only (principal never): at the max 30% fee,
    ///      floor(13 × 30%) = 3 and floor(14 × 30%) = 4. `LiquidityRemoved` keeps the adapter's gross split.
    function test_RemoveLiquidity_SkimsReportedFeesOnly() public {
        vm.prank(owner);
        vault.setPerformanceFeeBps(3000);
        la.setRemoveDelivers(true);
        uint256[2] memory idleBefore = _bal(address(vault));

        vm.prank(keeper);
        vm.expectEmit(true, false, false, true, address(vault));
        emit IPoolmigoVault.PerformanceFeeAccrued(treasury, basket, _amts(3, 4));
        vm.expectEmit(true, true, true, true, address(vault));
        emit IPoolmigoVault.LiquidityRemoved(keeper, address(la), 42, 7e17, 11, 12, 13, 14, 0, 0);
        vault.removeLiquidity(IPositionAdapter(address(la)), ILiquidityAdapter.RemoveLiquidityParams(7e17, 5, 6));

        assertEq(usdg.balanceOf(treasury), 3);
        assertEq(weth.balanceOf(treasury), 4);
        // Conservation: the vault keeps principal + fees − cut.
        assertEq(usdg.balanceOf(address(vault)), idleBefore[0] + 11 + 13 - 3);
        assertEq(weth.balanceOf(address(vault)), idleBefore[1] + 12 + 14 - 4);
    }

    /// @dev Idle-refund mode reports no fees → no skim; `performanceFeeBps == 0` → no skim either.
    function test_RemoveLiquidity_IdleModeAndZeroFeeBpsAreNoOps() public {
        vm.recordLogs();
        vm.prank(keeper);
        vault.removeLiquidity(IPositionAdapter(address(la)), ILiquidityAdapter.RemoveLiquidityParams(0, 0, 0));
        assertEq(_feeEvents(vm.getRecordedLogs()), 0, "idle refund is never skimmed");

        vm.prank(owner);
        vault.setPerformanceFeeBps(0);
        la.setRemoveDelivers(true);
        vm.recordLogs();
        vm.prank(keeper);
        vault.removeLiquidity(IPositionAdapter(address(la)), ILiquidityAdapter.RemoveLiquidityParams(1, 0, 0));
        assertEq(_feeEvents(vm.getRecordedLogs()), 0, "0 bps");
        assertEq(usdg.balanceOf(treasury) + weth.balanceOf(treasury), 0);
    }

    /*//////////////////////////////////////////////////////////////
                            EMERGENCYUNWIND
    //////////////////////////////////////////////////////////////*/

    /// @dev No emergency exemption: the combined fees the unwinds report are skimmed; `EmergencyUnwound` and the
    ///      return value stay GROSS; the vault pauses as before.
    function test_EmergencyUnwind_SkimsFeesAndPauses() public {
        _deploy(a1, 500e6, 0.5e18);
        _deploy(a2, 400e6, 0.4e18);
        a1.simulateFees(_amts(10e6, 0));
        a1.setReportedFeeBps(1_000); // 10% of a1's 510e6 / 0.5e18 = 51e6 / 0.05e18 fees
        // a2 reports none.
        uint256[] memory cut = _amts(5.1e6, 0.005e18);

        vm.prank(owner);
        vm.expectEmit(false, false, false, true, address(vault));
        emit IPoolmigoVault.PausedSet(true);
        vm.expectEmit(true, false, false, true, address(vault));
        emit IPoolmigoVault.PerformanceFeeAccrued(treasury, basket, cut);
        vm.expectEmit(true, false, false, true, address(vault));
        emit IPoolmigoVault.EmergencyUnwound(owner, basket, _amts(910e6, 0.9e18));
        (, uint256[] memory unwound) = vault.emergencyUnwind();

        assertEq(unwound[0], 910e6, "gross");
        assertEq(unwound[1], 0.9e18, "gross");
        assertTrue(vault.paused());
        assertEq(usdg.balanceOf(treasury), cut[0]);
        assertEq(weth.balanceOf(treasury), cut[1]);
        assertEq(usdg.balanceOf(address(vault)), SEED_USDG + 10e6 - cut[0], "everything else back in the vault");
        assertEq(weth.balanceOf(address(vault)), SEED_WETH - cut[1]);
    }

    function test_EmergencyUnwind_ZeroFeeBpsIsNoOp() public {
        vm.prank(owner);
        vault.setPerformanceFeeBps(0);
        _deploy(a1, 500e6, 0.5e18);
        a1.setReportedFeeBps(BPS);
        vm.recordLogs();
        vm.prank(owner);
        vault.emergencyUnwind();
        assertEq(_feeEvents(vm.getRecordedLogs()), 0);
        assertEq(usdg.balanceOf(address(vault)), SEED_USDG);
        assertTrue(vault.paused());
    }

    /*//////////////////////////////////////////////////////////////
                FEE BOUND: CUT <= WHAT THE CALL DELIVERED
    //////////////////////////////////////////////////////////////*/

    /// @dev An adapter that over-reports its fee split (5x the slice it delivers) is charged on the slice only: 30% of
    ///      the slice. Uncapped, the cut would be 150% of the slice, paid out of the receiver's own idle slice.
    function test_FeeBound_Redeem_OverReportCappedAtSlice() public {
        vm.prank(owner);
        vault.setPerformanceFeeBps(3000);
        _deploy(a1, 500e6, 0.5e18);
        a1.setReportedFeeBps(5 * BPS);

        // Quarter of the supply: idle slice 125e6 / 0.125e18, a1 slice 125e6 / 0.125e18 (reported fees 5x that).
        uint256[] memory cut = _amts(37.5e6, 0.0375e18);
        vm.prank(owner);
        vm.expectEmit(true, false, false, true, address(vault));
        emit IPoolmigoVault.PerformanceFeeAccrued(treasury, basket, cut);
        (, uint256[] memory sent) = vault.redeem(GENESIS / 4, bob);

        assertEq(sent[0], 250e6 - cut[0], "idle slice + adapter slice - capped cut");
        assertEq(sent[1], 0.25e18 - cut[1]);
        assertEq(usdg.balanceOf(treasury), cut[0]);
        assertEq(weth.balanceOf(treasury), cut[1]);
        assertEq(usdg.balanceOf(address(vault)), 375e6, "remaining holders' idle untouched");
        assertEq(weth.balanceOf(address(vault)), 0.375e18);
    }

    /// @dev {pullFrom}: a 10x over-report skims 30% of the slice; the vault's prior idle (every holder's) is never cut.
    function test_FeeBound_PullFrom_OverReportNeverTouchesIdle() public {
        vm.prank(owner);
        vault.setPerformanceFeeBps(3000);
        _deploy(a1, 400e6, 0.4e18);
        a1.setReportedFeeBps(10 * BPS);
        uint256[2] memory idleBefore = _bal(address(vault));

        vm.prank(keeper);
        vault.pullFrom(IPositionAdapter(address(a1)), 2_500); // slice 100e6 / 0.1e18

        assertEq(usdg.balanceOf(treasury), 30e6, "30% of the slice, not of 10x it");
        assertEq(weth.balanceOf(treasury), 0.03e18);
        assertEq(usdg.balanceOf(address(vault)), idleBefore[0] + 70e6);
        assertEq(weth.balanceOf(address(vault)), idleBefore[1] + 0.07e18);
    }

    /// @dev {emergencyUnwind}: a 4x over-report still completes (clamp, not revert) and skims 30% of what came back.
    function test_FeeBound_EmergencyUnwind_OverReportStillUnwinds() public {
        vm.prank(owner);
        vault.setPerformanceFeeBps(3000);
        _deploy(a1, 500e6, 0.5e18);
        a1.setReportedFeeBps(4 * BPS);

        vm.prank(owner);
        (, uint256[] memory unwound) = vault.emergencyUnwind();

        assertEq(unwound[0], 500e6, "gross");
        assertTrue(vault.paused());
        assertEq(usdg.balanceOf(treasury), 150e6, "30% of what came back");
        assertEq(weth.balanceOf(treasury), 0.15e18);
        assertEq(usdg.balanceOf(address(vault)), SEED_USDG - 150e6);
        assertEq(weth.balanceOf(address(vault)), SEED_WETH - 0.15e18);
    }

    /// @dev {redeem}, any shares / split (honest or up to 10x over-reported) / fee bps: cut = floor(min(Σ fees, Σ slices)
    ///      × bps) <= the slices, and the receiver always gets at least its own idle slice.
    function testFuzz_FeeBound_Redeem(uint256 shares, uint256 split1, uint256 split2, uint16 feeBps) public {
        shares = bound(shares, 1, GENESIS);
        split1 = bound(split1, 0, 10 * BPS);
        split2 = bound(split2, 0, 10 * BPS);
        feeBps = uint16(bound(feeBps, 0, 3000));
        vm.prank(owner);
        vault.setPerformanceFeeBps(feeBps);
        _deploy(a1, 300e6 + 7, 0.3e18 + 3);
        _deploy(a2, 200e6 + 1, 0.2e18 + 11);
        a1.simulateFees(_amts(13e6 + 5, 0.01e18 + 9));
        a1.setReportedFeeBps(split1);
        a2.setReportedFeeBps(split2);

        uint256 sharesWad = Math.mulDiv(shares, 1e18, GENESIS);
        uint256[2] memory idleSlice;
        uint256[2] memory fees;
        uint256[2] memory gross;
        for (uint256 i; i < 2; ++i) {
            idleSlice[i] = Math.mulDiv(shares, _tok(i).balanceOf(address(vault)), GENESIS);
            (uint256 g1, uint256 f1) = _slice(a1, i, sharesWad, split1);
            (uint256 g2, uint256 f2) = _slice(a2, i, sharesWad, split2);
            gross[i] = g1 + g2;
            fees[i] = f1 + f2;
        }

        vm.prank(owner);
        (, uint256[] memory sent) = vault.redeem(shares, bob);

        for (uint256 i; i < 2; ++i) {
            uint256 cut = Math.mulDiv(Math.min(fees[i], gross[i]), feeBps, BPS);
            assertEq(_tok(i).balanceOf(treasury), cut, "cut = floor(min(fees, gross) * bps)");
            assertLe(cut, gross[i], "cut <= adapter slices");
            assertEq(sent[i], idleSlice[i] + gross[i] - cut, "net = idle + slices - cut");
            assertGe(sent[i], idleSlice[i], "own idle slice never skimmed");
        }
    }

    /// @dev {pullFrom}, any principal / accrued fees / fraction / split (honest or up to 10x) / fee bps: the cut is
    ///      floor(min(fees, slice) × bps) <= the slice, and the vault's prior idle is never skimmed.
    function testFuzz_FeeBound_PullFrom(
        uint256 u,
        uint256 w,
        uint256 accrued,
        uint256 sharesBps,
        uint256 split,
        uint16 feeBps
    ) public {
        u = bound(u, 1, SEED_USDG);
        w = bound(w, 1, SEED_WETH);
        accrued = bound(accrued, 0, 1e30);
        sharesBps = bound(sharesBps, 1, BPS);
        split = bound(split, 0, 10 * BPS);
        feeBps = uint16(bound(feeBps, 0, 3000));
        vm.prank(owner);
        vault.setPerformanceFeeBps(feeBps);
        _deploy(a1, u, w);
        a1.simulateFees(_amts(accrued, 0));
        a1.setReportedFeeBps(split);
        uint256[2] memory idleBefore = _bal(address(vault));

        vm.prank(keeper);
        (, uint256[] memory gross) = vault.pullFrom(IPositionAdapter(address(a1)), sharesBps);

        for (uint256 i; i < 2; ++i) {
            uint256 fees = Math.mulDiv(gross[i], split, BPS);
            uint256 cut = Math.mulDiv(split <= BPS ? fees : gross[i], feeBps, BPS);
            assertEq(_tok(i).balanceOf(treasury), cut, "honest: floor(fees * bps); over-report: floor(slice * bps)");
            assertLe(cut, gross[i], "cut <= slice");
            assertEq(_tok(i).balanceOf(address(vault)), idleBefore[i] + gross[i] - cut, "prior idle never skimmed");
        }
    }

    /// @dev {emergencyUnwind}, any principal / accrued fees / split / fee bps: cut <= what came back, prior idle kept.
    function testFuzz_FeeBound_EmergencyUnwind(uint256 u, uint256 accrued, uint256 split, uint16 feeBps) public {
        u = bound(u, 1, SEED_USDG);
        accrued = bound(accrued, 0, 1e30);
        split = bound(split, 0, 10 * BPS);
        feeBps = uint16(bound(feeBps, 0, 3000));
        vm.prank(owner);
        vault.setPerformanceFeeBps(feeBps);
        _deploy(a1, u, 0);
        a1.simulateFees(_amts(accrued, 0));
        a1.setReportedFeeBps(split);

        vm.prank(owner);
        (, uint256[] memory gross) = vault.emergencyUnwind();

        uint256 cut = Math.mulDiv(Math.min(Math.mulDiv(gross[0], split, BPS), gross[0]), feeBps, BPS);
        assertEq(gross[0], u + accrued);
        assertEq(usdg.balanceOf(treasury), cut);
        assertLe(cut, gross[0], "cut <= what came back");
        assertEq(usdg.balanceOf(address(vault)), SEED_USDG + accrued - cut, "prior idle never skimmed");
    }

    /// @dev {rebalance}: harvested amounts ARE the fees, so the bound holds by construction — cut = floor(h × bps) <= h.
    function testFuzz_FeeBound_Rebalance(uint256 fu, uint256 fw, uint16 feeBps) public {
        fu = bound(fu, 0, 1e30);
        fw = bound(fw, 0, 1e30);
        feeBps = uint16(bound(feeBps, 0, 3000));
        vm.prank(owner);
        vault.setPerformanceFeeBps(feeBps);
        a1.simulateFees(_amts(fu, fw));

        vm.prank(keeper);
        (, uint256[] memory harvested, uint256[] memory cut) = vault.rebalance();

        for (uint256 i; i < 2; ++i) {
            assertEq(harvested[i], i == 0 ? fu : fw);
            assertEq(cut[i], Math.mulDiv(harvested[i], feeBps, BPS));
            assertLe(cut[i], harvested[i], "cut <= harvest");
            assertEq(_tok(i).balanceOf(treasury), cut[i]);
        }
    }

    /// @dev {removeLiquidity}: the collected fees are the base, so cut = floor(fees × bps) <= fees for any fee bps and
    ///      the vault keeps principal + fees − cut (the mock delivers fixed 11 / 12 principal and 13 / 14 fees).
    function testFuzz_FeeBound_RemoveLiquidity(uint16 feeBps) public {
        feeBps = uint16(bound(feeBps, 0, 3000));
        vm.prank(owner);
        vault.setPerformanceFeeBps(feeBps);
        la.setRemoveDelivers(true);
        uint256[2] memory idleBefore = _bal(address(vault));

        vm.prank(keeper);
        vault.removeLiquidity(IPositionAdapter(address(la)), ILiquidityAdapter.RemoveLiquidityParams(1, 0, 0));

        uint256[2] memory cut = [Math.mulDiv(13, feeBps, BPS), Math.mulDiv(14, feeBps, BPS)];
        assertLe(cut[0], 13);
        assertLe(cut[1], 14);
        assertEq(usdg.balanceOf(treasury), cut[0]);
        assertEq(weth.balanceOf(treasury), cut[1]);
        assertEq(usdg.balanceOf(address(vault)), idleBefore[0] + 11 + 13 - cut[0]);
        assertEq(weth.balanceOf(address(vault)), idleBefore[1] + 12 + 14 - cut[1]);
    }

    /*//////////////////////////////////////////////////////////////
          FEE ORDER (issue #3): HARVEST-FIRST == EXIT-FIRST
    //////////////////////////////////////////////////////////////*/

    // Each scenario runs on fresh twin vaults over {ProRataFeeAdapter}, whose fee slice is the production adapters'
    // `floor(feeBalance * sharesWad / 1e18)`, so harvest and exit report the same fees.

    /// @dev Issue example: 100 principal + 100 fees, 15% fee, the attacker holds half. Harvest first pays the treasury
    ///      15 (7.5 attributable to the half); redeem first pays 7.5. The attacker receives 92.5 either way.
    function test_FeeOrder_IssueExample_RedeemVsHarvestAttributableFeeMatches() public {
        World memory a = _world(ORDER_FEE_BPS);
        World memory b = _world(ORDER_FEE_BPS);
        _seedPosition(a, 100e18, 100e18, 100e18, 100e18);
        _seedPosition(b, 100e18, 100e18, 100e18, 100e18);
        _giveHalf(a);
        _giveHalf(b);

        vm.prank(keeper);
        a.vault.rebalance();
        uint256 harvestCut0 = a.t0.balanceOf(treasury);
        vm.prank(attacker);
        a.vault.redeem(GENESIS / 2, attacker);
        vm.prank(attacker);
        b.vault.redeem(GENESIS / 2, attacker);

        assertEq(harvestCut0, 15e18, "harvest charges the whole fee");
        assertEq(b.t0.balanceOf(treasury), 7.5e18, "redeem-first charges the exiting slice");
        assertEq(b.t1.balanceOf(treasury), a.t1.balanceOf(treasury) / 2);
        assertEq(a.t0.balanceOf(attacker), b.t0.balanceOf(attacker), "receiver token0");
        assertEq(a.t1.balanceOf(attacker), b.t1.balanceOf(attacker), "receiver token1");
        assertEq(a.t0.balanceOf(attacker), 92.5e18);
    }

    /// @dev A 100% redemption charges the same treasury amount in either order (15% of 80e18 / 40e18).
    function test_FeeOrder_FullRedeemTreasuryIdenticalEitherOrder() public {
        World memory a = _world(ORDER_FEE_BPS);
        World memory b = _world(ORDER_FEE_BPS);
        _seedPosition(a, 100e18, 80e18, 100e18, 40e18);
        _seedPosition(b, 100e18, 80e18, 100e18, 40e18);

        vm.prank(keeper);
        a.vault.rebalance();
        vm.prank(owner);
        a.vault.redeem(GENESIS, owner);
        vm.prank(owner);
        b.vault.redeem(GENESIS, owner);

        assertEq(a.t0.balanceOf(treasury), 12e18);
        assertEq(a.t1.balanceOf(treasury), 6e18);
        assertEq(b.t0.balanceOf(treasury), a.t0.balanceOf(treasury), "full exit token0");
        assertEq(b.t1.balanceOf(treasury), a.t1.balanceOf(treasury), "full exit token1");
        assertEq(a.t0.balanceOf(owner), b.t0.balanceOf(owner));
        assertEq(a.t1.balanceOf(owner), b.t1.balanceOf(owner));
    }

    /// @dev `pullFrom(10_000)` and a positive `removeLiquidity` realize the whole fee balance, like a harvest;
    ///      `pullFrom(5_000)` half of it.
    function test_FeeOrder_PullFromAndRemoveLiquidityMatchHarvest() public {
        World memory harvested = _world(ORDER_FEE_BPS);
        World memory pulledAll = _world(ORDER_FEE_BPS);
        World memory pulledHalf = _world(ORDER_FEE_BPS);
        World memory removed = _world(ORDER_FEE_BPS);
        _seedPosition(harvested, 100e18, 100e18, 100e18, 70e18);
        _seedPosition(pulledAll, 100e18, 100e18, 100e18, 70e18);
        _seedPosition(pulledHalf, 100e18, 100e18, 100e18, 70e18);
        _seedPosition(removed, 100e18, 100e18, 100e18, 70e18);

        vm.startPrank(keeper);
        harvested.vault.rebalance();
        pulledAll.vault.pullFrom(IPositionAdapter(address(pulledAll.adapter)), 10_000);
        pulledHalf.vault.pullFrom(IPositionAdapter(address(pulledHalf.adapter)), 5_000);
        removed.vault
            .removeLiquidity(
                IPositionAdapter(address(removed.adapter)),
                ILiquidityAdapter.RemoveLiquidityParams({liquidity: 1, minPrincipal0: 0, minPrincipal1: 0})
            );
        vm.stopPrank();

        for (uint256 i; i < 2; ++i) {
            uint256 h = (i == 0 ? harvested.t0 : harvested.t1).balanceOf(treasury);
            assertEq((i == 0 ? pulledAll.t0 : pulledAll.t1).balanceOf(treasury), h, "pullFrom(10_000) == harvest");
            assertEq((i == 0 ? pulledHalf.t0 : pulledHalf.t1).balanceOf(treasury), h / 2, "pullFrom(5_000) == half");
            assertEq((i == 0 ? removed.t0 : removed.t1).balanceOf(treasury), h, "removeLiquidity == harvest");
        }
        assertEq(removed.t0.balanceOf(address(removed.vault)), 200e18 - harvested.t0.balanceOf(treasury));
    }

    /// @dev Any principal / fees / fee bps / redeemed fraction: the redeem-first cut is within 1 wei of the share of a
    ///      harvest-first cut attributable to the redeemed shares, `floor(harvestCut * shares / supply)`.
    function testFuzz_FeeOrder_PartialRedeemAttributableFeeWithinOneWei(
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
        shareBps = bound(shareBps, 1, BPS);
        uint256 shares = GENESIS * shareBps / BPS;

        World memory harvested = _world(bps);
        World memory redeemed = _world(bps);
        _seedPosition(harvested, principal0, fee0, principal1, fee1);
        _seedPosition(redeemed, principal0, fee0, principal1, fee1);

        vm.prank(keeper);
        harvested.vault.rebalance();
        vm.prank(owner);
        redeemed.vault.redeem(shares, owner);

        uint256 h0 = harvested.t0.balanceOf(treasury);
        uint256 h1 = harvested.t1.balanceOf(treasury);
        assertApproxEqAbs(redeemed.t0.balanceOf(treasury), h0 * shares / GENESIS, 1, "token0 attributable");
        assertApproxEqAbs(redeemed.t1.balanceOf(treasury), h1 * shares / GENESIS, 1, "token1 attributable");
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    /// @dev A fresh vault over one {ProRataFeeAdapter} (fee-order scenarios).
    function _world(uint16 bps) internal returns (World memory w) {
        w.t0 = new MockToken("T0", "T0", 18);
        w.t1 = new MockToken("T1", "T1", 18);
        address[] memory b = new address[](2);
        b[0] = address(w.t0);
        b[1] = address(w.t1);
        MySunVaultUpgradeable impl = new MySunVaultUpgradeable(VaultImplArgs.depositSplit());
        w.vault = MySunVaultUpgradeable(
            address(
                new ERC1967Proxy(
                    address(impl),
                    abi.encodeCall(
                        MySunVaultUpgradeable(address(0)).initialize,
                        (owner, "sunLP", "sunLP", b, treasury, bps, GENESIS, uint256(0))
                    )
                )
            )
        );
        w.adapter = new ProRataFeeAdapter(address(w.vault), w.t0, w.t1);
        vm.startPrank(owner);
        w.vault.addAdapter(IPositionAdapter(address(w.adapter)));
        w.vault.setKeeper(keeper, true);
        vm.stopPrank();
    }

    /// @dev Genesis deposit of the principal (a zero principal is seeded as 1 wei so genesis pulls a non-zero basket),
    ///      all of it deployed to the adapter, then `f0/f1` fees accrued there.
    function _seedPosition(World memory w, uint256 p0, uint256 f0, uint256 p1, uint256 f1) internal {
        uint256[] memory dep = _amts(p0 == 0 ? 1 : p0, p1 == 0 ? 1 : p1);
        w.t0.mint(owner, dep[0]);
        w.t1.mint(owner, dep[1]);
        address[] memory b = new address[](2);
        b[0] = address(w.t0);
        b[1] = address(w.t1);
        vm.startPrank(owner);
        w.t0.approve(address(w.vault), dep[0]);
        w.t1.approve(address(w.vault), dep[1]);
        w.vault.deposit(b, dep, GENESIS, owner);
        vm.stopPrank();
        vm.prank(keeper);
        w.vault.deployTo(IPositionAdapter(address(w.adapter)), dep);
        w.adapter.accrue(f0, f1);
    }

    function _giveHalf(World memory w) internal {
        vm.prank(owner);
        w.vault.transfer(attacker, GENESIS / 2);
    }

    function _deploy(MockPositionAdapter a, uint256 u, uint256 w) internal {
        vm.prank(keeper);
        vault.deployTo(IPositionAdapter(address(a)), _amts(u, w));
    }

    /// @dev Mock slice of token `i`: floor(holding × sharesWad / 1e18), fees = floor(slice × split / 10_000).
    function _slice(MockPositionAdapter a, uint256 i, uint256 sharesWad, uint256 split)
        internal
        view
        returns (uint256 gross, uint256 fee)
    {
        (, uint256[] memory pos) = a.position();
        gross = Math.mulDiv(pos[i], sharesWad, 1e18);
        fee = Math.mulDiv(gross, split, BPS);
    }

    /// @dev Vault + adapters (everything that can pay a redeemer), per token.
    function _system() internal view returns (uint256[2] memory s) {
        for (uint256 i; i < 2; ++i) {
            s[i] = _tok(i).balanceOf(address(vault)) + _tok(i).balanceOf(address(a1)) + _tok(i).balanceOf(address(a2));
        }
    }

    function _bal(address who) internal view returns (uint256[2] memory b) {
        b[0] = usdg.balanceOf(who);
        b[1] = weth.balanceOf(who);
    }

    function _tok(uint256 i) internal view returns (MockToken) {
        return i == 0 ? usdg : weth;
    }

    function _feeEvents(Vm.Log[] memory logs) internal view returns (uint256 count) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(vault) && logs[i].topics[0] == IPoolmigoVault.PerformanceFeeAccrued.selector)
            {
                ++count;
            }
        }
    }

    function _amts(uint256 a, uint256 b) internal pure returns (uint256[] memory arr) {
        arr = new uint256[](2);
        arr[0] = a;
        arr[1] = b;
    }
}
