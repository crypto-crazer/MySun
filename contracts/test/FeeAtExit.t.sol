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

    uint16 internal constant FEE_BPS = 1000; // the ruling's 10%
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

        MySunVaultUpgradeable impl = new MySunVaultUpgradeable();
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
                                HELPERS
    //////////////////////////////////////////////////////////////*/

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
