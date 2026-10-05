// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import {Test} from "forge-std/Test.sol";
import {Upgrades} from "openzeppelin-foundry-upgrades/Upgrades.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {MySunVaultUpgradeable} from "contracts/MySunVaultUpgradeable.sol";
import {IPoolmigoVault} from "contracts/interfaces/IPoolmigoVault.sol";
import {IPositionAdapter} from "contracts/interfaces/IPositionAdapter.sol";
import {ILiquidityAdapter} from "contracts/interfaces/ILiquidityAdapter.sol";
import {UniswapV3Adapter} from "contracts/adapters/UniswapV3Adapter.sol";
import {TickMath} from "contracts/adapters/uniswap/TickMath.sol";
import {LiquidityAmounts} from "contracts/adapters/uniswap/LiquidityAmounts.sol";
import {MockToken} from "test/mocks/MockToken.sol";
import {MockPositionAdapter} from "test/mocks/MockPositionAdapter.sol";
import {MockLiquidityAdapter} from "test/mocks/MockLiquidityAdapter.sol";
import {MockV3Factory, MockV3Pool} from "test/mocks/MockV3Pool.sol";
import {MockPermit2Router} from "test/mocks/MockPermit2Router.sol";
import {UniversalRouterSwapExecutor} from "contracts/swap/UniversalRouterSwapExecutor.sol";

/**
 * @notice Strategy layer P1 — unit coverage of the precise-liquidity surface (`notes/EXECUTION-PLANS.md` §P1).
 *         - The REAL {UniswapV3Adapter} on the mock venue (MockV3Pool / MockV3Factory as NFPM anchor /
 *           MockPermit2Router): range-constraint defaults + validation, every {addLiquidity} check that runs before
 *           the position manager (params, alignment, constraint box, price guards, the swap-floor rule), the sizing
 *           plan ({previewAddLiquidity}), and {removeLiquidity}'s idle-refund mode (no position-manager call at all).
 *         - The vault wrappers against {MockLiquidityAdapter}: gating, exact-cap approvals reset to 0, forwarding,
 *           events. The real position-manager paths live in `test/fork/UniswapV3Adapter.fork.t.sol`.
 */
contract LiquidityOpsTest is Test {
    MySunVaultUpgradeable internal vault;
    MockToken internal tA;
    MockToken internal tB;
    MockV3Factory internal factory;
    MockPermit2Router internal router;
    UniversalRouterSwapExecutor internal executor; // real executor over the mock router (Permit2 + router)
    MockV3Pool internal pool;
    UniswapV3Adapter internal v3; // real adapter, mock venue, tick spacing 60
    MockLiquidityAdapter internal mla;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal keeper = makeAddr("keeper");
    address internal alice = makeAddr("alice");

    uint256 internal constant GENESIS = 1_000e18;
    uint256 internal constant SEED = 1_000e18; // per token, 1:1 price
    int24 internal constant SPACING = 60;
    uint32 internal constant TWAP_WINDOW = 1800;
    uint16 internal constant MAX_SLIPPAGE_BPS = 100;
    uint256 internal constant BPS = 10_000;
    uint128 internal constant L = 1e18;
    int24 internal constant LOWER = -600;
    int24 internal constant UPPER = 600;

    address[] internal basket;
    IERC20 internal token0; // v3's pool order
    IERC20 internal token1;

    function setUp() public {
        tA = new MockToken("Token A", "TKA", 18);
        tB = new MockToken("Token B", "TKB", 18);
        basket.push(address(tA));
        basket.push(address(tB));
        vault = MySunVaultUpgradeable(
            Upgrades.deployUUPSProxy(
                "MySunVaultUpgradeable.sol",
                abi.encodeCall(
                    MySunVaultUpgradeable(address(0)).initialize,
                    (owner, "sunEthLP", "sunEthLP", basket, treasury, uint16(1500), GENESIS, uint256(0))
                )
            )
        );

        factory = new MockV3Factory();
        router = new MockPermit2Router(factory);
        executor = new UniversalRouterSwapExecutor(address(router), address(router));
        pool = new MockV3Pool(address(factory), address(tA), address(tB), 3000, uint160(1 << 96), 1e24); // tick 0
        pool.setTickSpacing(SPACING);
        factory.register(pool);
        v3 = _newAdapter(pool);
        token0 = v3.TOKEN0();
        token1 = v3.TOKEN1();
        mla = new MockLiquidityAdapter(basket, address(vault), keccak256("MOCK_LIQ"), bytes32(uint256(7)));

        vm.startPrank(owner);
        vault.addAdapter(IPositionAdapter(address(v3)));
        vault.addAdapter(IPositionAdapter(address(mla)));
        vault.setKeeper(keeper, true);
        tA.mint(owner, SEED);
        tB.mint(owner, SEED);
        tA.approve(address(vault), SEED);
        tB.approve(address(vault), SEED);
        vault.deposit(basket, _pair(SEED, SEED), GENESIS, owner);
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                    ADAPTER: RANGE CONSTRAINTS (OWNER)
    //////////////////////////////////////////////////////////////*/

    function test_ConstraintDefaults_WidestAlignedBox() public {
        assertEq(v3.minTick(), -887_220, "MIN_TICK aligned up to 60");
        assertEq(v3.maxTick(), 887_220, "MAX_TICK aligned down to 60");
        assertEq(v3.minRangeTicks(), SPACING, "min width = one spacing");
        assertEq(v3.maxRangeTicks(), 1_774_440, "max width = the whole box");

        // Spacing 1: the global tick domain itself.
        MockV3Pool p1 = new MockV3Pool(address(factory), address(tA), address(tB), 100, uint160(1 << 96), 1e24);
        factory.register(p1);
        UniswapV3Adapter a1 = _newAdapter(p1);
        assertEq(a1.minTick(), TickMath.MIN_TICK);
        assertEq(a1.maxTick(), TickMath.MAX_TICK);
        assertEq(a1.minRangeTicks(), 1);
        assertEq(a1.maxRangeTicks(), TickMath.MAX_TICK - TickMath.MIN_TICK);

        _assertRangeConstraintsView(v3);
        _assertRangeConstraintsView(a1);
    }

    function test_SetRangeConstraints_OwnerOnlyAndEmits() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        v3.setRangeConstraints(-6000, 6000, 120, 1200);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, keeper));
        v3.setRangeConstraints(-6000, 6000, 120, 1200);

        vm.prank(owner);
        vm.expectEmit(address(v3));
        emit UniswapV3Adapter.RangeConstraintsSet(-6000, 6000, 120, 1200);
        v3.setRangeConstraints(-6000, 6000, 120, 1200);
        assertEq(v3.minTick(), -6000);
        assertEq(v3.maxTick(), 6000);
        assertEq(v3.minRangeTicks(), 120);
        assertEq(v3.maxRangeTicks(), 1200);
        _assertRangeConstraintsView(v3);
    }

    function test_SetRangeConstraints_RejectsInvalid() public {
        vm.startPrank(owner);
        _expectInvalidConstraints(-6001, 6000, 120, 1200); // unaligned min
        _expectInvalidConstraints(-6000, 6001, 120, 1200); // unaligned max
        _expectInvalidConstraints(6000, -6000, 120, 1200); // inverted
        _expectInvalidConstraints(600, 600, 60, 60); // empty box
        _expectInvalidConstraints(-887_280, 6000, 120, 1200); // aligned but below MIN_TICK
        _expectInvalidConstraints(-6000, 887_280, 120, 1200); // aligned but above MAX_TICK
        _expectInvalidConstraints(-6000, 6000, 0, 1200); // zero min width
        _expectInvalidConstraints(-6000, 6000, -60, 1200); // negative min width
        _expectInvalidConstraints(-6000, 6000, 1260, 1200); // min width > max width
        vm.stopPrank();
        // Nothing changed.
        assertEq(v3.minTick(), -887_220);
        assertEq(v3.maxRangeTicks(), 1_774_440);
    }

    /// @dev P1b2: a box narrower than `minRangeTicks_` admits no range — rejected (exact args); the full-box width
    ///      (`minRangeTicks_ == maxTick_ - minTick_`) stays legal, and `maxRangeTicks_` above the box width is fine.
    function test_SetRangeConstraints_RejectsUnsatisfiableWidthBox() public {
        vm.startPrank(owner);
        _expectInvalidConstraints(-600, 600, 1201, 2400); // min width = box width + 1
        _expectInvalidConstraints(-600, 600, 1260, 1260); // min width = box width + one spacing
        vm.stopPrank();
        assertEq(v3.minTick(), -887_220, "rejected: nothing changed");
        assertEq(v3.maxRangeTicks(), 1_774_440);

        vm.prank(owner);
        vm.expectEmit(address(v3));
        emit UniswapV3Adapter.RangeConstraintsSet(-600, 600, 1200, 2400);
        v3.setRangeConstraints(-600, 600, 1200, 2400); // boundary: the full-box range is the only legal width
        assertEq(v3.minTick(), -600);
        assertEq(v3.maxTick(), 600);
        assertEq(v3.minRangeTicks(), 1200);
        assertEq(v3.maxRangeTicks(), 2400);
        _assertRangeConstraintsView(v3);
        (int24 lo, int24 hi, int24 minW, int24 maxW) = v3.rangeConstraints();
        assertEq(lo, -600);
        assertEq(hi, 600);
        assertEq(minW, 1200);
        assertEq(maxW, 2400);
    }

    /// @dev P3 (§3b): every width is a spacing multiple, so a width window holding NO multiple of the spacing is just
    ///      as unsatisfiable as a too-narrow box — rejected (exact args) iff alignUp(minRangeTicks_, spacing) >
    ///      maxRangeTicks_. Boundaries accepted; spacing 1 has no such gap.
    function test_SetRangeConstraints_RejectsWidthWindowWithoutSpacingMultiple() public {
        vm.startPrank(owner);
        _expectInvalidConstraints(-6000, 6000, 61, 119); // (60, 120): no multiple of 60
        _expectInvalidConstraints(-6000, 6000, 121, 179); // (120, 180)
        _expectInvalidConstraints(-6000, 6000, 1, 59); // below one spacing
        vm.stopPrank();
        assertEq(v3.minRangeTicks(), SPACING, "rejected: nothing changed");
        assertEq(v3.maxRangeTicks(), 1_774_440);

        vm.startPrank(owner);
        vm.expectEmit(address(v3));
        emit UniswapV3Adapter.RangeConstraintsSet(-6000, 6000, 61, 120);
        v3.setRangeConstraints(-6000, 6000, 61, 120); // alignUp(61, 60) == 120 == max: exactly one legal width
        v3.setRangeConstraints(-6000, 6000, 1, 60); // alignUp(1, 60) == 60
        v3.setRangeConstraints(-6000, 6000, 120, 120); // aligned min == max
        vm.stopPrank();
        _assertRangeConstraintsView(v3);
        assertEq(v3.minRangeTicks(), 120);
        assertEq(v3.maxRangeTicks(), 120);

        // The one legal width is usable: a 120-wide range passes the constraint checks (dry run sizes it).
        (uint256 pull0, uint256 pull1,,,) = v3.previewAddLiquidity(_add(-60, 60, L, 0, 1e30, 1e30, 0));
        assertGt(pull0 + pull1, 0);

        // Spacing 1: every width is legal, so any 0 < min <= max window is satisfiable.
        MockV3Pool p1 = new MockV3Pool(address(factory), address(tA), address(tB), 100, uint160(1 << 96), 1e24);
        factory.register(p1);
        UniswapV3Adapter a1 = _newAdapter(p1);
        vm.prank(owner);
        a1.setRangeConstraints(-600, 600, 11, 19);
        assertEq(a1.minRangeTicks(), 11);
        assertEq(a1.maxRangeTicks(), 19);
    }

    /*//////////////////////////////////////////////////////////////
                ADAPTER: addLiquidity CHECKS (BEFORE THE NFPM)
    //////////////////////////////////////////////////////////////*/

    function test_LiquidityOps_OnlyVault() public {
        ILiquidityAdapter.AddLiquidityParams memory p = _add(LOWER, UPPER, L, 0, 1e18, 1e18, 0);
        ILiquidityAdapter.RemoveLiquidityParams memory r;
        address[2] memory callers = [alice, keeper];
        for (uint256 i; i < 2; ++i) {
            vm.startPrank(callers[i]);
            vm.expectRevert(UniswapV3Adapter.UniswapV3Adapter__OnlyVault.selector);
            v3.addLiquidity(p);
            vm.expectRevert(UniswapV3Adapter.UniswapV3Adapter__OnlyVault.selector);
            v3.removeLiquidity(r);
            vm.stopPrank();
        }
    }

    function test_AddLiquidity_RejectsBadParams() public {
        vm.startPrank(address(vault));
        vm.expectRevert(UniswapV3Adapter.UniswapV3Adapter__ZeroLiquidity.selector);
        v3.addLiquidity(_add(LOWER, UPPER, 0, 0, 1e18, 1e18, 0));
        vm.expectRevert(
            abi.encodeWithSelector(UniswapV3Adapter.UniswapV3Adapter__InvalidMinLiquidity.selector, L + 1, L)
        );
        v3.addLiquidity(_add(LOWER, UPPER, L, L + 1, 1e18, 1e18, 0));
        vm.expectRevert(abi.encodeWithSelector(UniswapV3Adapter.UniswapV3Adapter__InvalidRange.selector, UPPER, LOWER));
        v3.addLiquidity(_add(UPPER, LOWER, L, 0, 1e18, 1e18, 0));
        vm.expectRevert(abi.encodeWithSelector(UniswapV3Adapter.UniswapV3Adapter__InvalidRange.selector, LOWER, LOWER));
        v3.addLiquidity(_add(LOWER, LOWER, L, 0, 1e18, 1e18, 0));
        vm.expectRevert(
            abi.encodeWithSelector(
                UniswapV3Adapter.UniswapV3Adapter__UnalignedRange.selector, int24(-610), UPPER, SPACING
            )
        );
        v3.addLiquidity(_add(-610, UPPER, L, 0, 1e18, 1e18, 0));
        vm.expectRevert(
            abi.encodeWithSelector(
                UniswapV3Adapter.UniswapV3Adapter__UnalignedRange.selector, LOWER, int24(601), SPACING
            )
        );
        v3.addLiquidity(_add(LOWER, 601, L, 0, 1e18, 1e18, 0));
        // Extreme int24 inputs are caught by the bounds before the width is ever computed (no overflow panic).
        vm.expectRevert(
            abi.encodeWithSelector(
                UniswapV3Adapter.UniswapV3Adapter__RangeOutsideConstraints.selector, int24(-8_388_600), int24(8_388_600)
            )
        );
        v3.addLiquidity(_add(-8_388_600, 8_388_600, L, 0, 1e18, 1e18, 0));
        vm.stopPrank();
    }

    function test_AddLiquidity_EnforcesConstraintBox() public {
        vm.prank(owner);
        v3.setRangeConstraints(-6000, 6000, 120, 1200);

        vm.startPrank(address(vault));
        _expectOutside(-6060, -5400); // lower below minTick
        _expectOutside(5400, 6060); // upper above maxTick
        _expectOutside(-60, 0); // width 60 < 120
        _expectOutside(-660, 600); // width 1260 > 1200
        vm.stopPrank();

        // The box edges themselves are legal (checks pass; the dry run sizes the op).
        (uint256 pull0, uint256 pull1,,,) = v3.previewAddLiquidity(_add(-6000, -4800, L, 0, 1e30, 1e30, 0));
        assertEq(pull0, 0, "range entirely below spot: token1 only");
        assertGt(pull1, 0);
        (pull0, pull1,,,) = v3.previewAddLiquidity(_add(-600, 600, L, 0, 1e30, 1e30, 0));
        assertGt(pull0, 0);
        assertGt(pull1, 0);
    }

    function test_AddLiquidity_PriceGuardsRunBeforeSizing() public {
        ILiquidityAdapter.AddLiquidityParams memory p = _add(LOWER, UPPER, L, 0, 1e18, 1e18, 0);
        pool.setMeanTick(-101); // spot (tick 0) sits 101 ticks above the TWAP; the bound is 100
        vm.expectRevert(
            abi.encodeWithSelector(
                UniswapV3Adapter.UniswapV3Adapter__SpotDeviatesFromTwap.selector,
                int24(0),
                int24(-101),
                MAX_SLIPPAGE_BPS
            )
        );
        v3.previewAddLiquidity(p);

        pool.setMeanTick(0);
        pool.setObserveReverts(true);
        vm.expectRevert(
            abi.encodeWithSelector(UniswapV3Adapter.UniswapV3Adapter__TwapUnavailable.selector, TWAP_WINDOW)
        );
        vm.prank(address(vault));
        v3.addLiquidity(p);
    }

    /// @dev Sizing plan: needs at spot rounded up; pull only what is needed (<= caps); a one-sided shortfall is
    ///      bought with the other side (grossed up by maxSlippageBps, bounded by that side's room).
    function test_PreviewAddLiquidity_AmpleCapsPullExactNeedsNoSwap() public view {
        (uint256 need0, uint256 need1) = _needs(LOWER, UPPER, L);
        assertGt(need0, 0);
        assertGt(need1, 0);
        Plan memory pl = _preview(_add(LOWER, UPPER, L, 0, 1e30, 1e30, 0));
        assertEq(pl.pull0, need0);
        assertEq(pl.pull1, need1);
        assertEq(pl.swapIn, 0);
        assertEq(pl.minOut, 0);
    }

    function test_PreviewAddLiquidity_Token0ShortBuysWithToken1() public view {
        (uint256 need0, uint256 need1) = _needs(LOWER, UPPER, L);
        uint256 cap0 = need0 / 2;
        Plan memory pl = _preview(_add(LOWER, UPPER, L, 0, cap0, 1e30, 0));
        assertFalse(pl.zeroForOne, "buy token0 with token1");
        assertEq(pl.pull0, cap0, "all of the short side's cap");
        assertEq(pl.swapIn, Math.mulDiv(need0 - cap0, BPS, BPS - MAX_SLIPPAGE_BPS, Math.Rounding.Ceil), "1:1 TWAP");
        assertEq(pl.pull1, need1 + pl.swapIn);
        assertApproxEqAbs(pl.minOut, need0 - cap0, 1, "the adapter's own floor covers the shortfall");
    }

    function test_PreviewAddLiquidity_Token1ShortBuysWithToken0() public view {
        (uint256 need0, uint256 need1) = _needs(LOWER, UPPER, L);
        uint256 cap1 = need1 / 4;
        Plan memory pl = _preview(_add(LOWER, UPPER, L, 0, 1e30, cap1, 0));
        assertTrue(pl.zeroForOne, "buy token1 with token0");
        assertEq(pl.pull1, cap1);
        assertEq(pl.pull0, need0 + pl.swapIn);
        assertApproxEqAbs(pl.minOut, need1 - cap1, 1);
    }

    function test_PreviewAddLiquidity_SwapBoundedByRoom() public view {
        (uint256 need0, uint256 need1) = _needs(LOWER, UPPER, L);
        Plan memory pl = _preview(_add(LOWER, UPPER, L, 0, need0 / 2, need1 + 1e9, 0));
        assertEq(pl.swapIn, 1e9, "only the room beyond token1's own need is sold");
        assertEq(pl.pull1, need1 + 1e9, "never above the cap");
    }

    function test_PreviewAddLiquidity_BothShortPullCapsNoSwap() public view {
        (uint256 need0, uint256 need1) = _needs(LOWER, UPPER, L);
        Plan memory pl = _preview(_add(LOWER, UPPER, L, 0, need0 / 2, need1 / 2, 0));
        assertEq(pl.pull0, need0 / 2);
        assertEq(pl.pull1, need1 / 2);
        assertEq(pl.swapIn, 0, "nothing to sell: actual liquidity binds below target");
    }

    /// @dev A needed swap with `minSwapOut == 0` reverts before anything moves.
    function test_AddLiquidity_ZeroMinSwapOutRevertsWhenSwapNeeded() public {
        (uint256 need0,) = _needs(LOWER, UPPER, L);
        ILiquidityAdapter.AddLiquidityParams memory p = _add(LOWER, UPPER, L, 0, need0 / 2, 1e18, 0);
        (,,, uint256 swapIn,) = v3.previewAddLiquidity(p);
        assertGt(swapIn, 0);

        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(UniswapV3Adapter.UniswapV3Adapter__ZeroMinSwapOut.selector, address(token1), swapIn)
        );
        vault.addLiquidity(IPositionAdapter(address(v3)), p);
        assertEq(tA.balanceOf(address(vault)), SEED);
        assertEq(tB.balanceOf(address(vault)), SEED);
        assertEq(tA.allowance(address(vault), address(v3)), 0);
        assertEq(tB.allowance(address(vault), address(v3)), 0);
    }

    /*//////////////////////////////////////////////////////////////
                    ADAPTER: removeLiquidity WITHOUT THE NFPM
    //////////////////////////////////////////////////////////////*/

    function test_RemoveLiquidity_IdleRefundMode() public {
        MockToken(address(token0)).mint(address(v3), 3e18);
        MockToken(address(token1)).mint(address(v3), 5e18);
        uint256 vault0 = token0.balanceOf(address(vault));
        uint256 vault1 = token1.balanceOf(address(vault));

        vm.prank(address(vault));
        vm.expectEmit(address(v3));
        emit UniswapV3Adapter.IdleRefunded(3e18, 5e18);
        (uint256 p0, uint256 p1, uint256 f0, uint256 f1, uint256 i0, uint256 i1) =
            v3.removeLiquidity(ILiquidityAdapter.RemoveLiquidityParams(0, 0, 0));
        assertEq(p0 + p1 + f0 + f1, 0, "no principal, no fees");
        assertEq(i0, 3e18);
        assertEq(i1, 5e18);
        assertEq(token0.balanceOf(address(vault)), vault0 + 3e18, "to the vault");
        assertEq(token1.balanceOf(address(vault)), vault1 + 5e18);
        assertEq(token0.balanceOf(address(v3)) + token1.balanceOf(address(v3)), 0);
        assertEq(v3.tokenId(), 0, "no position touched");

        // Nothing idle: a no-op that still reports (and emits) zeros.
        vm.prank(address(vault));
        (,,,, i0, i1) = v3.removeLiquidity(ILiquidityAdapter.RemoveLiquidityParams(0, 0, 0));
        assertEq(i0 + i1, 0);
    }

    function test_RemoveLiquidity_IdleModeRejectsPrincipalFloors() public {
        MockToken(address(token0)).mint(address(v3), 3e18);
        vm.startPrank(address(vault));
        vm.expectRevert(
            abi.encodeWithSelector(UniswapV3Adapter.UniswapV3Adapter__PrincipalFloorInIdleMode.selector, 1, 0)
        );
        v3.removeLiquidity(ILiquidityAdapter.RemoveLiquidityParams(0, 1, 0));
        vm.expectRevert(
            abi.encodeWithSelector(UniswapV3Adapter.UniswapV3Adapter__PrincipalFloorInIdleMode.selector, 0, 1)
        );
        v3.removeLiquidity(ILiquidityAdapter.RemoveLiquidityParams(0, 0, 1));
        vm.stopPrank();
        assertEq(token0.balanceOf(address(v3)), 3e18, "idle never satisfies a principal floor");
    }

    function test_RemoveLiquidity_NoPositionReverts() public {
        vm.prank(address(vault));
        vm.expectRevert(
            abi.encodeWithSelector(UniswapV3Adapter.UniswapV3Adapter__InsufficientLiquidity.selector, uint128(1), 0)
        );
        v3.removeLiquidity(ILiquidityAdapter.RemoveLiquidityParams(1, 0, 0));
    }

    /*//////////////////////////////////////////////////////////////
                         VAULT: addLiquidity WRAPPER
    //////////////////////////////////////////////////////////////*/

    function test_VaultAddLiquidity_ExactCapsApprovedThenReset() public {
        ILiquidityAdapter.AddLiquidityParams memory p = _add(-120, 240, 5e17, 4e17, 300e18, 700e18, 9);
        vm.prank(keeper);
        vm.expectEmit(true, true, true, true, address(vault));
        emit IPoolmigoVault.LiquidityAdded(keeper, address(mla), 42, 5e17, 150e18, 350e18, 1, 2);
        vault.addLiquidity(IPositionAdapter(address(mla)), p);

        assertEq(mla.addCalls(), 1);
        assertEq(mla.allowanceSeenOnAdd(0), 300e18, "cap0 approved exactly");
        assertEq(mla.allowanceSeenOnAdd(1), 700e18, "cap1 approved exactly");
        assertEq(tA.allowance(address(vault), address(mla)), 0, "reset");
        assertEq(tB.allowance(address(vault), address(mla)), 0, "reset");
        ILiquidityAdapter.AddLiquidityParams memory got = mla.lastAdd();
        assertEq(abi.encode(got), abi.encode(p), "params forwarded verbatim");

        // Caps equal to the whole idle are fine.
        vm.prank(keeper);
        vault.addLiquidity(IPositionAdapter(address(mla)), _add(-120, 240, 1, 0, SEED, SEED, 0));
        assertEq(mla.allowanceSeenOnAdd(0), SEED);
    }

    function test_VaultAddLiquidity_Gating() public {
        ILiquidityAdapter.AddLiquidityParams memory p = _add(-120, 240, 1, 0, 1e18, 1e18, 0);
        IPositionAdapter a = IPositionAdapter(address(mla));

        vm.prank(alice);
        vm.expectRevert(IPoolmigoVault.PoolmigoVault__NotKeeper.selector);
        vault.addLiquidity(a, p);

        MockLiquidityAdapter rogue = new MockLiquidityAdapter(basket, address(vault), "R", bytes32(0));
        vm.startPrank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(IPoolmigoVault.PoolmigoVault__AdapterNotRegistered.selector, address(rogue))
        );
        vault.addLiquidity(IPositionAdapter(address(rogue)), p);
        vm.expectRevert(
            abi.encodeWithSelector(IPoolmigoVault.PoolmigoVault__InsufficientIdle.selector, address(tA), SEED, SEED + 1)
        );
        vault.addLiquidity(a, _add(-120, 240, 1, 0, SEED + 1, 0, 0));
        vm.expectRevert(
            abi.encodeWithSelector(IPoolmigoVault.PoolmigoVault__InsufficientIdle.selector, address(tB), SEED, SEED + 1)
        );
        vault.addLiquidity(a, _add(-120, 240, 1, 0, 0, SEED + 1, 0));
        vm.stopPrank();

        // A registered adapter without the capability (non-ERC-165 → mask 0): typed, before any adapter call (P3).
        MockPositionAdapter plain = new MockPositionAdapter(basket, address(vault), "P", bytes32(0));
        vm.prank(owner);
        vault.addAdapter(IPositionAdapter(address(plain)));
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(IPoolmigoVault.PoolmigoVault__CapabilityMissing.selector, address(plain), uint8(1))
        );
        vault.addLiquidity(IPositionAdapter(address(plain)), p);

        // Not a two-token position.
        MockToken tC = new MockToken("Token C", "TKC", 18);
        address[] memory three = new address[](3);
        (three[0], three[1], three[2]) = (address(tA), address(tB), address(tC));
        MockLiquidityAdapter tri = new MockLiquidityAdapter(three, address(vault), "T", bytes32(0));
        vm.startPrank(owner);
        vault.addToken(address(tC));
        vault.addAdapter(IPositionAdapter(address(tri)));
        vm.stopPrank();
        vm.prank(keeper);
        vm.expectRevert(IPoolmigoVault.PoolmigoVault__LengthMismatch.selector);
        vault.addLiquidity(IPositionAdapter(address(tri)), p);

        vm.prank(owner);
        vault.setPaused(true);
        vm.prank(keeper);
        vm.expectRevert(IPoolmigoVault.PoolmigoVault__Paused.selector);
        vault.addLiquidity(a, p);
        assertEq(mla.addCalls(), 0);
    }

    /// @dev Adapter-side checks bubble through the wrapper with their own typed errors.
    function test_VaultAddLiquidity_AdapterErrorsBubble() public {
        vm.prank(owner);
        v3.setRangeConstraints(-6000, 6000, 120, 1200);
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                UniswapV3Adapter.UniswapV3Adapter__RangeOutsideConstraints.selector, int24(-60), int24(0)
            )
        );
        vault.addLiquidity(IPositionAdapter(address(v3)), _add(-60, 0, L, 0, 1e18, 1e18, 0));
    }

    /*//////////////////////////////////////////////////////////////
                        VAULT: removeLiquidity WRAPPER
    //////////////////////////////////////////////////////////////*/

    function test_VaultRemoveLiquidity_ForwardsAndEmits() public {
        vm.prank(keeper);
        vm.expectEmit(true, true, true, true, address(vault));
        emit IPoolmigoVault.LiquidityRemoved(keeper, address(mla), 42, 7e17, 11, 12, 13, 14, 0, 0);
        vault.removeLiquidity(IPositionAdapter(address(mla)), ILiquidityAdapter.RemoveLiquidityParams(7e17, 5, 6));
        ILiquidityAdapter.RemoveLiquidityParams memory got = mla.lastRemove();
        assertEq(got.liquidity, 7e17);
        assertEq(got.minPrincipal0, 5);
        assertEq(got.minPrincipal1, 6);

        vm.prank(keeper);
        vm.expectEmit(true, true, true, true, address(vault));
        emit IPoolmigoVault.LiquidityRemoved(keeper, address(mla), 42, 0, 0, 0, 0, 0, 15, 16);
        vault.removeLiquidity(IPositionAdapter(address(mla)), ILiquidityAdapter.RemoveLiquidityParams(0, 0, 0));
        assertEq(mla.removeCalls(), 2);
    }

    function test_VaultRemoveLiquidity_Gating() public {
        ILiquidityAdapter.RemoveLiquidityParams memory r;
        vm.prank(alice);
        vm.expectRevert(IPoolmigoVault.PoolmigoVault__NotKeeper.selector);
        vault.removeLiquidity(IPositionAdapter(address(mla)), r);

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IPoolmigoVault.PoolmigoVault__AdapterNotRegistered.selector, alice));
        vault.removeLiquidity(IPositionAdapter(alice), r);

        MockPositionAdapter plain = new MockPositionAdapter(basket, address(vault), "P", bytes32(0));
        vm.prank(owner);
        vault.addAdapter(IPositionAdapter(address(plain)));
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(IPoolmigoVault.PoolmigoVault__CapabilityMissing.selector, address(plain), uint8(1))
        );
        vault.removeLiquidity(IPositionAdapter(address(plain)), r);

        vm.prank(owner);
        vault.setPaused(true);
        vm.prank(keeper);
        vm.expectRevert(IPoolmigoVault.PoolmigoVault__Paused.selector);
        vault.removeLiquidity(IPositionAdapter(address(mla)), r);
        assertEq(mla.removeCalls(), 0);
    }

    /// @dev Zero-liquidity plumbing end to end through the REAL adapter: its idle lands in the vault, the basket
    ///      total is unchanged (idle moved adapter → vault), and the vault event carries the split.
    function test_VaultRemoveLiquidity_IdleRefundThroughRealAdapter() public {
        MockToken(address(token0)).mint(address(v3), 2e18);
        MockToken(address(token1)).mint(address(v3), 1e18);
        (, uint256[] memory totalsBefore) = vault.totalTokens();

        vm.prank(keeper);
        vm.expectEmit(true, true, true, true, address(vault));
        emit IPoolmigoVault.LiquidityRemoved(keeper, address(v3), 0, 0, 0, 0, 0, 0, 2e18, 1e18);
        vault.removeLiquidity(IPositionAdapter(address(v3)), ILiquidityAdapter.RemoveLiquidityParams(0, 0, 0));

        (, uint256[] memory totalsAfter) = vault.totalTokens();
        assertEq(totalsAfter[0], totalsBefore[0]);
        assertEq(totalsAfter[1], totalsBefore[1]);
        assertEq(token0.balanceOf(address(v3)) + token1.balanceOf(address(v3)), 0);
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    function _newAdapter(MockV3Pool pool_) internal returns (UniswapV3Adapter) {
        return new UniswapV3Adapter(
            UniswapV3Adapter.Config({
                vault: address(vault),
                pool: address(pool_),
                positionManager: address(factory), // MockV3Factory.factory() == itself: the NFPM anchor
                swapRouter: address(router),
                permit2: address(router),
                swapExecutor: address(executor),
                owner: owner,
                rangeTicksBelow: 600,
                rangeTicksAbove: 600,
                twapWindow: TWAP_WINDOW,
                maxSlippageBps: MAX_SLIPPAGE_BPS
            })
        );
    }

    struct Plan {
        uint256 pull0;
        uint256 pull1;
        bool zeroForOne;
        uint256 swapIn;
        uint256 minOut;
    }

    function _preview(ILiquidityAdapter.AddLiquidityParams memory p) internal view returns (Plan memory pl) {
        (pl.pull0, pl.pull1, pl.zeroForOne, pl.swapIn, pl.minOut) = v3.previewAddLiquidity(p);
    }

    function _add(
        int24 lower,
        int24 upper,
        uint128 liquidity,
        uint128 minLiquidity,
        uint256 max0,
        uint256 max1,
        uint256 minSwapOut
    ) internal pure returns (ILiquidityAdapter.AddLiquidityParams memory) {
        return ILiquidityAdapter.AddLiquidityParams(lower, upper, liquidity, minLiquidity, max0, max1, minSwapOut);
    }

    /// @dev Independent restatement of the adapter's sizing: amounts for `liquidity` at spot, +1 per non-zero side.
    function _needs(int24 lower, int24 upper, uint128 liquidity) internal view returns (uint256 n0, uint256 n1) {
        (n0, n1) = LiquidityAmounts.getAmountsForLiquidity(
            pool.sqrtPriceX96(), TickMath.getSqrtRatioAtTick(lower), TickMath.getSqrtRatioAtTick(upper), liquidity
        );
        if (n0 != 0) ++n0;
        if (n1 != 0) ++n1;
    }

    /// @dev `rangeConstraints()` == the four individual getters.
    function _assertRangeConstraintsView(UniswapV3Adapter a) internal view {
        (int24 lo, int24 hi, int24 minW, int24 maxW) = a.rangeConstraints();
        assertEq(lo, a.minTick(), "rangeConstraints().minTick");
        assertEq(hi, a.maxTick(), "rangeConstraints().maxTick");
        assertEq(minW, a.minRangeTicks(), "rangeConstraints().minRangeTicks");
        assertEq(maxW, a.maxRangeTicks(), "rangeConstraints().maxRangeTicks");
    }

    function _expectInvalidConstraints(int24 a, int24 b, int24 c, int24 d) internal {
        vm.expectRevert(
            abi.encodeWithSelector(UniswapV3Adapter.UniswapV3Adapter__InvalidConstraints.selector, a, b, c, d)
        );
        v3.setRangeConstraints(a, b, c, d);
    }

    function _expectOutside(int24 lower, int24 upper) internal {
        vm.expectRevert(
            abi.encodeWithSelector(UniswapV3Adapter.UniswapV3Adapter__RangeOutsideConstraints.selector, lower, upper)
        );
        v3.addLiquidity(_add(lower, upper, L, 0, 1e18, 1e18, 0));
    }

    function _pair(uint256 a, uint256 b) internal pure returns (uint256[] memory out) {
        out = new uint256[](2);
        out[0] = a;
        out[1] = b;
    }
}
