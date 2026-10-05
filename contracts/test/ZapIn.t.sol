// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import {Test, Vm} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {MySunVaultUpgradeable} from "contracts/MySunVaultUpgradeable.sol";
import {IPoolmigoVault} from "contracts/interfaces/IPoolmigoVault.sol";
import {IPositionAdapter} from "contracts/interfaces/IPositionAdapter.sol";
import {MySunZapIn} from "contracts/periphery/MySunZapIn.sol";
import {PoolmigoZapIn} from "contracts/periphery/PoolmigoZapIn.sol";
import {TickMath} from "contracts/adapters/uniswap/TickMath.sol";
import {LiquidityAmounts} from "contracts/adapters/uniswap/LiquidityAmounts.sol";
import {MockToken} from "test/mocks/MockToken.sol";
import {MockPositionAdapter} from "test/mocks/MockPositionAdapter.sol";
import {MockPermit2Router} from "test/mocks/MockPermit2Router.sol";
import {MockV3Factory, MockV3Pool} from "test/mocks/MockV3Pool.sol";

/// @dev A concentrated-liquidity position IN the mock pool the zap swaps through (the "coupled vault" of findings
///      T1/T5): `position()` reports its liquidity's amounts at the pool's LIVE price, and its liquidity is part of
///      the pool's in-range liquidity (its tokens sit in the pool's reserves). Only `deploy` is supported.
contract CoupledV3Adapter is IPositionAdapter {
    MockV3Pool public immutable POOL;
    address public immutable VAULT;
    uint160 public immutable SQRT_LOWER;
    uint160 public immutable SQRT_UPPER;
    uint128 public liquidity;

    constructor(MockV3Pool pool_, address vault_, int24 lower, int24 upper) {
        POOL = pool_;
        VAULT = vault_;
        SQRT_LOWER = TickMath.getSqrtRatioAtTick(lower);
        SQRT_UPPER = TickMath.getSqrtRatioAtTick(upper);
    }

    function dex() external pure returns (bytes32) {
        return keccak256("MOCK_COUPLED_V3");
    }

    function poolId() external view returns (bytes32) {
        return bytes32(uint256(uint160(address(POOL))));
    }

    function position() public view returns (address[] memory tokens, uint256[] memory amounts) {
        tokens = _tokens();
        amounts = new uint256[](2);
        (amounts[0], amounts[1]) =
            LiquidityAmounts.getAmountsForLiquidity(POOL.sqrtPriceX96(), SQRT_LOWER, SQRT_UPPER, liquidity);
    }

    /// @dev Adds the liquidity `amounts` buy at the live price; the used tokens move into the pool's reserves.
    function deploy(uint256[] calldata amounts) external returns (address[] memory tokens, uint256[] memory deployed) {
        require(msg.sender == VAULT, "only vault");
        tokens = _tokens();
        uint128 l = LiquidityAmounts.getLiquidityForAmounts(
            POOL.sqrtPriceX96(), SQRT_LOWER, SQRT_UPPER, amounts[0], amounts[1]
        );
        deployed = new uint256[](2);
        (deployed[0], deployed[1]) =
            LiquidityAmounts.getAmountsForLiquidity(POOL.sqrtPriceX96(), SQRT_LOWER, SQRT_UPPER, l);
        IERC20(tokens[0]).transferFrom(VAULT, address(POOL), deployed[0]);
        IERC20(tokens[1]).transferFrom(VAULT, address(POOL), deployed[1]);
        liquidity += l;
        POOL.setLiquidity(POOL.liquidity() + l);
    }

    function withdrawProportional(uint256, address)
        external
        pure
        returns (address[] memory, uint256[] memory, uint256[] memory)
    {
        revert("unsupported");
    }

    function harvest() external pure returns (address[] memory, uint256[] memory) {
        revert("unsupported");
    }

    function unwindAll(address) external pure returns (address[] memory, uint256[] memory, uint256[] memory) {
        revert("unsupported");
    }

    function _tokens() internal view returns (address[] memory tokens) {
        tokens = new address[](2);
        tokens[0] = POOL.token0();
        tokens[1] = POOL.token1();
    }
}

/// @dev Answers `tokens()` with an empty basket.
contract EmptyBasketVault {
    function tokens() external pure returns (address[] memory) {
        return new address[](0);
    }
}

/**
 * @notice Unit suite for {MySunZapIn}: the REAL vault core (ERC1967 proxy) + the dual-role Permit2/UniversalRouter
 *         mock + constant-liquidity mock v3 pools. Every swap target / minOut is re-derived independently here: the
 *         sizing equations are checked against the mock pool's own execution (not the zap's math), and the minOut
 *         values against OracleLibrary's quote formula.
 */
contract ZapInTest is Test {
    uint256 internal constant BPS = 10_000;
    uint256 internal constant GENESIS = 200_000e18;
    /// @dev Live RHC fee-100 USDG/WETH in-range liquidity (findings T0, block 76526524).
    uint128 internal constant LIVE_L = 5_086e15;
    uint24 internal constant FEE100 = 100;
    /// @dev ETH ≈ 2,727 USDG (findings T0): 1e18 wei ↔ 2_727e6 USDG raw.
    uint256 internal constant ETH_USDG = 2_727e6;
    bytes32 internal constant DEPOSITED_SIG = keccak256("Deposited(address,address,address[],uint256[],uint256)");

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal keeper = makeAddr("keeper");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    MockV3Factory internal factory;
    MockPermit2Router internal router;
    MySunZapIn internal zap;
    MockToken internal usdg;
    MockToken internal weth;
    MockV3Pool internal wethPool;
    MySunVaultUpgradeable internal vault;
    MockPositionAdapter internal mockAdapter;

    struct Leg {
        MockV3Pool pool;
        address token;
        uint256 idx; // registry index
    }

    function setUp() public {
        usdg = new MockToken("Mock USDG", "USDG", 6);
        // Live orientation: WETH (0x0Bd7…) < USDG (0x5fc5…) → WETH is token0 of the USDG/WETH pool.
        weth = _orderedToken("Mock WETH", 18, true);
        factory = new MockV3Factory();
        router = new MockPermit2Router(factory);
        zap = new MySunZapIn(address(router), address(router), owner);

        wethPool = _newPool(weth, 1e18, ETH_USDG, LIVE_L);

        // 100k USDG + 100k worth of WETH; half of each deployed to a (decoupled) mock position.
        vault = _newVault(_pair(address(usdg), address(weth)), _pairAmt(100_000e6, _wethFor(100_000e6)));
        mockAdapter = new MockPositionAdapter(_pair(address(usdg), address(weth)), address(vault), "MOCK", bytes32(0));
        vm.startPrank(owner);
        vault.addAdapter(IPositionAdapter(address(mockAdapter)));
        vault.setKeeper(keeper, true);
        vm.stopPrank();
        vm.prank(keeper);
        vault.deployTo(IPositionAdapter(address(mockAdapter)), _pairAmt(50_000e6, _wethFor(50_000e6)));

        vm.startPrank(owner);
        zap.registerVault(address(vault));
        zap.setRoute(address(usdg), address(weth), FEE100, address(wethPool), 600, 50, 50);
        vm.stopPrank();

        usdg.mint(alice, 100_000_000e6);
        vm.prank(alice);
        usdg.approve(address(zap), type(uint256).max);
    }

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    function test_Constructor_Wiring() public view {
        assertEq(address(zap.UNIVERSAL_ROUTER()), address(router));
        assertEq(address(zap.PERMIT2()), address(router));
        assertEq(zap.FACTORY(), address(factory), "FACTORY = UR.V3_POSITION_MANAGER().factory()");
        assertEq(zap.owner(), owner);
    }

    function test_Constructor_Rejects() public {
        vm.expectRevert(PoolmigoZapIn.ZapIn__ZeroAddress.selector);
        new MySunZapIn(address(0), address(router), owner);
        vm.expectRevert(PoolmigoZapIn.ZapIn__ZeroAddress.selector);
        new MySunZapIn(address(router), address(0), owner);
        address eoa = makeAddr("eoa");
        vm.expectRevert(abi.encodeWithSelector(PoolmigoZapIn.ZapIn__NoCode.selector, eoa));
        new MySunZapIn(eoa, address(router), owner);
        vm.expectRevert(abi.encodeWithSelector(PoolmigoZapIn.ZapIn__NoCode.selector, eoa));
        new MySunZapIn(address(router), eoa, owner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new MySunZapIn(address(router), address(router), address(0));

        // Router wired to an NFPM that is empty / has no factory() (e.g. a mainnet-wired copy): typed.
        MockPermit2Router bad = new MockPermit2Router(factory);
        bad.setPositionManager(eoa);
        vm.expectRevert(abi.encodeWithSelector(PoolmigoZapIn.ZapIn__RouterMismatch.selector, address(bad)));
        new MySunZapIn(address(bad), address(router), owner);
        bad.setPositionManager(address(usdg));
        vm.expectRevert(abi.encodeWithSelector(PoolmigoZapIn.ZapIn__RouterMismatch.selector, address(bad)));
        new MySunZapIn(address(bad), address(router), owner);
        // A router that is not a UniversalRouter at all.
        vm.expectRevert(abi.encodeWithSelector(PoolmigoZapIn.ZapIn__RouterMismatch.selector, address(usdg)));
        new MySunZapIn(address(usdg), address(router), owner);
    }

    /*//////////////////////////////////////////////////////////////
                             VAULT REGISTRY
    //////////////////////////////////////////////////////////////*/

    function test_RegisterVault_Rules() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        zap.registerVault(address(vault));

        vm.startPrank(owner);
        vm.expectRevert(PoolmigoZapIn.ZapIn__ZeroAddress.selector);
        zap.registerVault(address(0));
        vm.expectRevert(abi.encodeWithSelector(PoolmigoZapIn.ZapIn__NoCode.selector, alice));
        zap.registerVault(alice);
        vm.expectRevert(abi.encodeWithSelector(PoolmigoZapIn.ZapIn__VaultAlreadyRegistered.selector, address(vault)));
        zap.registerVault(address(vault));
        address empty = address(new EmptyBasketVault());
        vm.expectRevert(abi.encodeWithSelector(PoolmigoZapIn.ZapIn__EmptyBasket.selector, empty));
        zap.registerVault(empty);
        // No tokens() at all.
        vm.expectRevert(abi.encodeWithSelector(PoolmigoZapIn.ZapIn__EmptyBasket.selector, address(usdg)));
        zap.registerVault(address(usdg));

        vm.expectEmit(true, false, false, false, address(zap));
        emit PoolmigoZapIn.VaultDisabled(address(vault));
        zap.disableVault(address(vault));
        assertFalse(zap.isVaultRegistered(address(vault)));
        vm.expectRevert(abi.encodeWithSelector(PoolmigoZapIn.ZapIn__VaultNotRegistered.selector, address(vault)));
        zap.disableVault(address(vault));
        vm.stopPrank();

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PoolmigoZapIn.ZapIn__VaultNotRegistered.selector, address(vault)));
        zap.zapDeposit(address(vault), address(usdg), 1_000e6, 1, 0, alice);

        vm.prank(owner);
        vm.expectEmit(true, false, false, false, address(zap));
        emit PoolmigoZapIn.VaultRegistered(address(vault));
        zap.registerVault(address(vault));
        _zap(alice, 1_000e6, 0, alice);
    }

    /*//////////////////////////////////////////////////////////////
                                 ROUTES
    //////////////////////////////////////////////////////////////*/

    function test_SetRoute_DefaultsAndEvent() public {
        vm.prank(owner);
        vm.expectEmit(true, true, true, true, address(zap));
        emit PoolmigoZapIn.RouteSet(address(usdg), address(weth), address(wethPool), FEE100, 600, 50, 50);
        zap.setRoute(address(usdg), address(weth), FEE100, address(wethPool), 0, 0, 0);
        (address refPool, uint24 fee, uint16 window, uint16 slip, uint16 dev) = zap.routes(address(usdg), address(weth));
        assertEq(refPool, address(wethPool));
        assertEq(fee, FEE100);
        assertEq(window, zap.DEFAULT_TWAP_WINDOW());
        assertEq(slip, zap.DEFAULT_MAX_SLIPPAGE_BPS());
        assertEq(dev, zap.DEFAULT_MAX_DEVIATION_BPS());
        assertEq(window, 600);
        assertEq(slip, 50);
        assertEq(dev, 50);
    }

    function test_SetRoute_ParamBounds() public {
        address u = address(usdg);
        address w = address(weth);
        address p = address(wethPool);
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(PoolmigoZapIn.ZapIn__TwapWindowOutOfRange.selector, 299, 300, 1800));
        zap.setRoute(u, w, FEE100, p, 299, 50, 50);
        vm.expectRevert(abi.encodeWithSelector(PoolmigoZapIn.ZapIn__TwapWindowOutOfRange.selector, 1801, 300, 1800));
        zap.setRoute(u, w, FEE100, p, 1801, 50, 50);
        vm.expectRevert(abi.encodeWithSelector(PoolmigoZapIn.ZapIn__SlippageOutOfRange.selector, 9, 10, 300));
        zap.setRoute(u, w, FEE100, p, 600, 9, 50);
        vm.expectRevert(abi.encodeWithSelector(PoolmigoZapIn.ZapIn__SlippageOutOfRange.selector, 301, 10, 300));
        zap.setRoute(u, w, FEE100, p, 600, 301, 50);
        vm.expectRevert(abi.encodeWithSelector(PoolmigoZapIn.ZapIn__DeviationOutOfRange.selector, 9, 10, 300));
        zap.setRoute(u, w, FEE100, p, 600, 50, 9);
        vm.expectRevert(abi.encodeWithSelector(PoolmigoZapIn.ZapIn__DeviationOutOfRange.selector, 301, 10, 300));
        zap.setRoute(u, w, FEE100, p, 600, 50, 301);
        // Bounds are inclusive.
        zap.setRoute(u, w, FEE100, p, 300, 10, 10);
        zap.setRoute(u, w, FEE100, p, 1800, 300, 300);
        vm.stopPrank();
    }

    function test_SetRoute_CardinalityMustExceedWindow() public {
        wethPool.setObservationCardinality(600);
        vm.startPrank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(PoolmigoZapIn.ZapIn__CardinalityTooLow.selector, address(wethPool), 600, 600)
        );
        zap.setRoute(address(usdg), address(weth), FEE100, address(wethPool), 600, 50, 50);
        // A shorter window fits.
        zap.setRoute(address(usdg), address(weth), FEE100, address(wethPool), 599, 50, 50);
        vm.stopPrank();
        wethPool.setObservationCardinality(601);
        vm.prank(owner);
        zap.setRoute(address(usdg), address(weth), FEE100, address(wethPool), 600, 50, 50);
    }

    function test_SetRoute_PoolIdentity() public {
        MockToken other = new MockToken("Other", "OTH", 18);
        MockV3Pool unregistered =
            new MockV3Pool(address(factory), address(usdg), address(weth), FEE100, wethPool.sqrtPriceX96(), LIVE_L);
        MockV3Pool foreign = new MockV3Pool(
            makeAddr("otherFactory"), address(usdg), address(weth), 500, wethPool.sqrtPriceX96(), LIVE_L
        );
        address u = address(usdg);
        address w = address(weth);
        vm.startPrank(owner);
        // fee tier does not match the pool
        vm.expectRevert(abi.encodeWithSelector(PoolmigoZapIn.ZapIn__PoolMismatch.selector, address(wethPool)));
        zap.setRoute(u, w, 500, address(wethPool), 600, 50, 50);
        // tokens do not match the pool
        vm.expectRevert(abi.encodeWithSelector(PoolmigoZapIn.ZapIn__PoolMismatch.selector, address(wethPool)));
        zap.setRoute(u, address(other), FEE100, address(wethPool), 600, 50, 50);
        // not the factory's canonical pool (the router would trade elsewhere)
        vm.expectRevert(abi.encodeWithSelector(PoolmigoZapIn.ZapIn__PoolMismatch.selector, address(unregistered)));
        zap.setRoute(u, w, FEE100, address(unregistered), 600, 50, 50);
        // another factory
        vm.expectRevert(abi.encodeWithSelector(PoolmigoZapIn.ZapIn__PoolMismatch.selector, address(foreign)));
        zap.setRoute(u, w, 500, address(foreign), 600, 50, 50);
        vm.expectRevert(abi.encodeWithSelector(PoolmigoZapIn.ZapIn__InvalidRoute.selector, u, u));
        zap.setRoute(u, u, FEE100, address(wethPool), 600, 50, 50);
        vm.expectRevert(PoolmigoZapIn.ZapIn__ZeroAddress.selector);
        zap.setRoute(address(0), w, FEE100, address(wethPool), 600, 50, 50);
        vm.expectRevert(PoolmigoZapIn.ZapIn__ZeroAddress.selector);
        zap.setRoute(u, w, FEE100, address(0), 600, 50, 50);
        vm.expectRevert(abi.encodeWithSelector(PoolmigoZapIn.ZapIn__NoCode.selector, alice));
        zap.setRoute(u, w, FEE100, alice, 600, 50, 50);
        vm.stopPrank();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        zap.setRoute(u, w, FEE100, address(wethPool), 600, 50, 50);
    }

    /*//////////////////////////////////////////////////////////////
                               VALIDATION
    //////////////////////////////////////////////////////////////*/

    function test_Validation_Reverts() public {
        address v = address(vault);
        address u = address(usdg);
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(PoolmigoZapIn.ZapIn__VaultNotRegistered.selector, bob));
        zap.zapDeposit(bob, u, 1_000e6, 1, 0, alice);
        MockToken stranger = new MockToken("Stranger", "STR", 6);
        vm.expectRevert(abi.encodeWithSelector(PoolmigoZapIn.ZapIn__TokenNotInBasket.selector, v, address(stranger)));
        zap.zapDeposit(v, address(stranger), 1_000e6, 1, 0, alice);
        vm.expectRevert(PoolmigoZapIn.ZapIn__ZeroAmount.selector);
        zap.zapDeposit(v, u, 0, 1, 0, alice);
        vm.expectRevert(PoolmigoZapIn.ZapIn__ZeroAddress.selector);
        zap.zapDeposit(v, u, 1_000e6, 1, 0, address(0));
        vm.expectRevert(PoolmigoZapIn.ZapIn__ZeroMinShares.selector);
        zap.zapDeposit(v, u, 1_000e6, 0, 0, alice);
        vm.expectRevert(abi.encodeWithSelector(PoolmigoZapIn.ZapIn__SlippageTooLoose.selector, 51, 50));
        zap.zapDeposit(v, u, 1_000e6, 1, 51, alice);
        vm.stopPrank();
        vm.expectRevert(abi.encodeWithSelector(PoolmigoZapIn.ZapIn__SlippageTooLoose.selector, 51, 50));
        zap.previewZap(v, u, 1_000e6, 51);
    }

    function test_Validation_EmptyVaultAndVaultMinShares() public {
        MySunVaultUpgradeable fresh = _deployVault(_pair(address(usdg), address(weth)));
        vm.prank(owner);
        zap.registerVault(address(fresh));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PoolmigoZapIn.ZapIn__VaultEmpty.selector, address(fresh)));
        zap.zapDeposit(address(fresh), address(usdg), 1_000e6, 1, 0, alice);

        // The vault re-enforces the caller's minShares (typed, from the vault).
        (,, uint256 expected,) = zap.previewZap(address(vault), address(usdg), 1_000e6, 0);
        vm.prank(alice);
        vm.expectPartialRevert(IPoolmigoVault.PoolmigoVault__InsufficientSharesOut.selector);
        zap.zapDeposit(address(vault), address(usdg), 1_000e6, expected * 2, 0, alice);
    }

    /*//////////////////////////////////////////////////////////////
                          SIZING + SWAP BOUNDS
    //////////////////////////////////////////////////////////////*/

    /// @dev 2-token basket: phase-1 = half of the pre-state solve (checked against the pool's own execution),
    ///      phase-2 = the re-solved top-up; phase-1 minOut = TWAP quote × haircut EXACT; phase-2 minOut = the
    ///      AGGREGATE remainder EXACT; exact refunds; no residue.
    function test_Sizing_TwoToken_TwoPhase() public {
        _checkTwoPhase(vault, 100_000e6, 0);
    }

    function test_Sizing_TwoToken_SmallZap() public {
        _checkTwoPhase(vault, 1_000e6, 0);
    }

    function test_Sizing_SkewedVault() public {
        // 20k USDG vs 80k worth of WETH — the zap swaps ~80 %.
        MySunVaultUpgradeable skewed =
            _newVault(_pair(address(usdg), address(weth)), _pairAmt(20_000e6, _wethFor(80_000e6)));
        vm.prank(owner);
        zap.registerVault(address(skewed));
        _checkTwoPhase(skewed, 50_000e6, 0);
        // and the opposite skew
        MySunVaultUpgradeable usdHeavy =
            _newVault(_pair(address(usdg), address(weth)), _pairAmt(90_000e6, _wethFor(10_000e6)));
        vm.prank(owner);
        zap.registerVault(address(usdHeavy));
        _checkTwoPhase(usdHeavy, 50_000e6, 0);
    }

    function test_Tightening_UsedExactly() public {
        // slippageBps 20 < route 50: used exactly in both bounds (checked inside).
        _checkTwoPhase(vault, 10_000e6, 20);
        // == route max is allowed
        _zap(alice, 10_000e6, 50, alice);
    }

    function test_Swap_TooLittleReceived_Typed() public {
        router.setForceTooLittle(true);
        vm.prank(alice);
        vm.expectPartialRevert(PoolmigoZapIn.ZapIn__SlippageExceeded.selector);
        zap.zapDeposit(address(vault), address(usdg), 10_000e6, 1, 0, alice);
    }

    function test_Swap_TightSlippage_RealBoundReverts() public {
        // TWAP 40 ticks below spot (inside maxDeviation 50): the TWAP says WETH is ~0.4 % cheaper than spot, so a
        // 10 bps haircut asks for more WETH than the pool gives → router V3TooLittleReceived → typed.
        (, int24 spot,,,,,) = wethPool.slot0();
        wethPool.setMeanTick(spot - 40);
        uint256 x1 = _phase1Amount(vault, 10_000e6);
        uint256 minOut = Math.mulDiv(
            _quote(x1, TickMath.getSqrtRatioAtTick(spot - 40), address(usdg) < address(weth)), BPS - 10, BPS
        );
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(PoolmigoZapIn.ZapIn__SlippageExceeded.selector, address(weth), x1, minOut)
        );
        zap.zapDeposit(address(vault), address(usdg), 10_000e6, 1, 10, alice);
    }

    function test_Swap_NonConformingRouter_BalanceDeltaRecheck() public {
        // The router ignores amountOutMin and short-pays: the zap's own balance-delta check catches it.
        wethPool.setMeanTick(wethPool.tick() - 40);
        router.setShortPay(1e17);
        vm.prank(alice);
        vm.expectPartialRevert(PoolmigoZapIn.ZapIn__SlippageExceeded.selector);
        zap.zapDeposit(address(vault), address(usdg), 10_000e6, 1, 0, alice);
    }

    function test_Twap_Unavailable_Typed() public {
        wethPool.setObserveReverts(true);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(PoolmigoZapIn.ZapIn__TwapUnavailable.selector, address(wethPool), uint16(600))
        );
        zap.zapDeposit(address(vault), address(usdg), 10_000e6, 1, 0, alice);
    }

    /*//////////////////////////////////////////////////////////////
                           DEVIATION CHECK
    //////////////////////////////////////////////////////////////*/

    function test_Deviation_AdverseRevertsBeforeFirstSwap() public {
        // WETH is token0: buying it is adverse when spot tick > TWAP tick.
        int24 spot = wethPool.tick();
        wethPool.setMeanTick(spot - 51);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                PoolmigoZapIn.ZapIn__SpotDeviatesFromTwap.selector, address(wethPool), spot, spot - 51, uint16(50)
            )
        );
        zap.zapDeposit(address(vault), address(usdg), 10_000e6, 1, 0, alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                PoolmigoZapIn.ZapIn__SpotDeviatesFromTwap.selector, address(wethPool), spot, spot - 51, uint16(50)
            )
        );
        zap.previewZap(address(vault), address(usdg), 10_000e6, 0);
        assertEq(router.callCount(), 0, "no swap attempted");

        // Bound is the ROUTE parameter, not the caller's slip: a 100-tick allowance admits the same state.
        vm.prank(owner);
        zap.setRoute(address(usdg), address(weth), FEE100, address(wethPool), 600, 100, 100);
        wethPool.setMeanTick(spot + 1); // back to (nearly) spot so the swap bound itself passes
        _zap(alice, 10_000e6, 0, alice);
    }

    function test_Deviation_OneSided_FavourableSideAllowed() public {
        // TWAP 200 ticks ABOVE spot: WETH is cheaper than its TWAP (favourable) → no deviation revert.
        wethPool.setMeanTick(wethPool.tick() + 200);
        (uint256 shares,) = _zap(alice, 10_000e6, 0, alice);
        assertGt(shares, 0);
    }

    function test_Deviation_Token1Out() public {
        // A route where the bought token is token1: adverse = spot tick BELOW the TWAP tick.
        MockToken tkb = _orderedToken("TKB", 18, false);
        MockV3Pool p = _newPool(tkb, 1e18, 300e6, _depthL(tkb, 1e18, 300e6, 5_000_000e6));
        MySunVaultUpgradeable v2 = _newVault(_pair(address(usdg), address(tkb)), _pairAmt(50_000e6, 166e18));
        vm.startPrank(owner);
        zap.registerVault(address(v2));
        zap.setRoute(address(usdg), address(tkb), FEE100, address(p), 600, 50, 50);
        vm.stopPrank();
        int24 spot = p.tick();
        p.setMeanTick(spot + 51);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                PoolmigoZapIn.ZapIn__SpotDeviatesFromTwap.selector, address(p), spot, spot + 51, uint16(50)
            )
        );
        zap.zapDeposit(address(v2), address(usdg), 10_000e6, 1, 0, alice);
        p.setMeanTick(spot - 200); // favourable
        vm.prank(alice);
        zap.zapDeposit(address(v2), address(usdg), 10_000e6, 1, 0, alice);
        _assertClean(v2);
    }

    /*//////////////////////////////////////////////////////////////
                       REFUNDS / SWEEP / APPROVALS
    //////////////////////////////////////////////////////////////*/

    function test_Refunds_ToCallerEvenWhenReceiverDiffers() public {
        uint256 aliceUsdgBefore = usdg.balanceOf(alice);
        vm.recordLogs();
        vm.prank(alice);
        (uint256 shares, uint256[] memory refunded) = zap.zapDeposit(address(vault), address(usdg), 25_000e6, 1, 0, bob);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(vault.balanceOf(bob), shares, "shares to receiver");
        assertEq(vault.balanceOf(alice), 0);
        assertEq(usdg.balanceOf(bob) + weth.balanceOf(bob), 0, "no refund to receiver");
        assertEq(usdg.balanceOf(alice), aliceUsdgBefore - 25_000e6 + refunded[0], "USDG refund to caller");
        assertEq(weth.balanceOf(alice), refunded[1], "WETH refund to caller");

        // refund == offer − required (the vault's own Deposited event), per token, exactly.
        (address[] memory dTokens, uint256[] memory required) = _depositedEvent(logs);
        uint256[] memory offers = _offersFromCalls(25_000e6);
        for (uint256 i; i < dTokens.length; ++i) {
            uint256 j = dTokens[i] == address(usdg) ? 0 : 1;
            assertEq(refunded[j], offers[j] - required[i], "refund = offer - required");
        }
        _assertClean(vault);
    }

    function test_Approvals_AllZero_AndExactPerSwap() public {
        _zap(alice, 40_000e6, 0, alice);
        _assertClean(vault);
        for (uint256 i; i < router.callCount(); ++i) {
            MockPermit2Router.SwapCall memory c = router.callAt(i);
            assertEq(c.innerAllowanceSeen, c.amountIn, "Permit2 inner allowance == amountIn");
            assertEq(c.outerAllowanceSeen, c.amountIn, "ERC20 -> Permit2 allowance == amountIn");
            assertEq(c.recipient, address(zap), "swap output hard-wired to the zap");
            assertEq(c.payer, address(zap));
        }
        // second zap works from a clean slate
        _zap(alice, 5_000e6, 0, alice);
        _assertClean(vault);
    }

    function test_Events() public {
        vm.expectEmit(true, true, true, false, address(zap));
        emit PoolmigoZapIn.ZapDeposited(alice, address(vault), address(usdg), 10_000e6, 0, alice);
        vm.prank(alice);
        zap.zapDeposit(address(vault), address(usdg), 10_000e6, 1, 0, alice);
    }

    /*//////////////////////////////////////////////////////////////
                               PREVIEW
    //////////////////////////////////////////////////////////////*/

    function test_Preview_MatchesActual() public {
        uint256[3] memory sizes = [uint256(1_000e6), 50_000e6, 500_000e6];
        for (uint256 i; i < sizes.length; ++i) {
            (address[] memory t, uint256[] memory offers, uint256 expected, uint256[] memory expRefunds) =
                zap.previewZap(address(vault), address(usdg), sizes[i], 0);
            assertEq(t[0], address(usdg));
            assertEq(t[1], address(weth));
            assertLt(offers[0], sizes[i], "part of A is swapped");
            (uint256 shares, uint256[] memory refunded) = _zap(alice, sizes[i], 0, alice);
            _assertWithinBps(shares, expected, 1e13, "previewZap shares within 0.1 bps");
            // refunds: USDG residual within 0.1 bps of A, WETH refund ~0 on both sides
            assertApproxEqAbs(refunded[0], expRefunds[0], sizes[i] / 100_000 + 2, "USDG refund ~ preview");
            _assertBoughtRefundDust(refunded[1], expRefunds[1], sizes[i]);
            _assertClean(vault);
        }
    }

    /*//////////////////////////////////////////////////////////////
                          SIX-TOKEN BASKET
    //////////////////////////////////////////////////////////////*/

    function test_Sizing_SixToken_GenericPath() public {
        (MySunVaultUpgradeable v6, Leg[] memory legs) = _sixTokenWorld();
        uint256 A = 100_000e6;
        (, uint256[] memory t0) = v6.totalTokens();
        (,, uint256 expected,) = zap.previewZap(address(v6), address(usdg), A, 0);

        uint256 pre = vm.snapshotState();
        router.clearCalls();
        (uint256 shares, uint256[] memory refunded) = _zapInto(v6, A, 0);
        assertEq(router.callCount(), 2 * legs.length, "5 legs x 2 phases");
        _assertWithinBps(shares, expected, 1e13, "preview within 0.1 bps");
        _assertClean(v6);
        // Bought-token refunds are dust; the residual sits in USDG (lossless) and is small.
        for (uint256 l; l < legs.length; ++l) {
            MockPermit2Router.SwapCall memory c = router.callAt(legs.length + l);
            assertLe(refunded[legs[l].idx] * 1e6, c.amountOut + router.callAt(l).amountOut, "bought refund <= 1 ppm");
        }
        assertLe(refunded[0] * BPS, A, "USDG residual <= 1 bp of A");

        MockPermit2Router.SwapCall[] memory calls = _copyCalls();
        vm.revertToState(pre);
        _checkPhaseEquations(t0, 0, A, legs, calls);
    }

    function test_Sizing_SixToken_MixedOrientation() public {
        (, Leg[] memory legs) = _sixTokenWorld();
        uint256 below;
        for (uint256 l; l < legs.length; ++l) {
            if (legs[l].token < address(usdg)) {
                ++below;
            }
        }
        assertGt(below, 0, "some legs buy token0");
        assertLt(below, legs.length, "some legs buy token1");
    }

    /*//////////////////////////////////////////////////////////////
                    EXCLUSIONS / NO ROUTE / DUST
    //////////////////////////////////////////////////////////////*/

    function test_Exclusion_ZeroHeldTokenNotBought() public {
        MockToken tkz = _orderedToken("TKZ", 18, false);
        MockV3Pool p = _newPool(tkz, 1e18, 1e6, _depthL(tkz, 1e18, 1e6, 1_000_000e6));
        vm.startPrank(owner);
        vault.addToken(address(tkz)); // T == 0
        zap.setRoute(address(usdg), address(tkz), FEE100, address(p), 600, 50, 50);
        vm.stopPrank();
        router.clearCalls();
        (, uint256[] memory refunded) = _zap(alice, 10_000e6, 0, alice);
        assertEq(refunded.length, 3);
        for (uint256 i; i < router.callCount(); ++i) {
            assertEq(router.callAt(i).tokenOut, address(weth), "only WETH bought");
        }
        assertEq(refunded[2], 0);
        _assertClean(vault);
    }

    function test_NoRoute_VaultDecides_MissingBasketToken() public {
        MockToken tkz = _orderedToken("TKZ", 18, false);
        address[] memory t = new address[](3);
        t[0] = address(usdg);
        t[1] = address(weth);
        t[2] = address(tkz);
        uint256[] memory a = new uint256[](3);
        a[0] = 50_000e6;
        a[1] = _wethFor(50_000e6);
        a[2] = 50_000e18;
        MySunVaultUpgradeable v3 = _newVault(t, a);
        vm.prank(owner);
        zap.registerVault(address(v3));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IPoolmigoVault.PoolmigoVault__MissingBasketToken.selector, address(tkz)));
        zap.zapDeposit(address(v3), address(usdg), 10_000e6, 1, 0, alice);
    }

    /// @dev findings T11b: an 8-dp, 1e3-USDG-raw-per-raw token. A = 3,000 raw USDG: the leg (≈1,001 raw) quotes
    ///      1 raw × (1 − 0.5 %) → minOut floors to 0 → skipped, while the vault's pro-rata draw of it is 3 raw →
    ///      typed `ZapIn__AmountTooSmall` (never the vault's generic error), in the view too.
    function test_Dust_AmountTooSmall_T11b() public {
        MockToken xbtc = _orderedToken("XBTC", 8, false);
        MockV3Pool p = _newPool(xbtc, 1, 1_000, _depthL(xbtc, 1, 1_000, 10_000_000e6));
        MySunVaultUpgradeable vx = _newVault(_pair(address(usdg), address(xbtc)), _pairAmt(100_000e6, 1e8));
        vm.startPrank(owner);
        zap.registerVault(address(vx));
        zap.setRoute(address(usdg), address(xbtc), FEE100, address(p), 600, 50, 50);
        vm.stopPrank();

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PoolmigoZapIn.ZapIn__AmountTooSmall.selector, address(xbtc)));
        zap.zapDeposit(address(vx), address(usdg), 3_000, 1, 0, alice);
        vm.expectRevert(abi.encodeWithSelector(PoolmigoZapIn.ZapIn__AmountTooSmall.selector, address(xbtc)));
        zap.previewZap(address(vx), address(usdg), 3_000, 0);

        // Above the corner the leg executes normally.
        vm.prank(alice);
        zap.zapDeposit(address(vx), address(usdg), 1_000e6, 1, 0, alice);
        _assertClean(vx);
    }

    /// @dev A leg whose minOut floors to 0 is skipped (no swap); under strict participation (fix round) a
    ///      held token can no longer ride along as dust — the zap raises the typed `ZapIn__AmountTooSmall`
    ///      (deposit path and view alike) instead of reaching the vault. (Was "…DepositProceeds".)
    function test_Dust_SkippedLeg_TypedError() public {
        MockToken xbtc = _orderedToken("XBTC", 8, false);
        MockV3Pool p = _newPool(xbtc, 1, 1_000, _depthL(xbtc, 1, 1_000, 10_000_000e6));
        address[] memory t = new address[](3);
        t[0] = address(usdg);
        t[1] = address(weth);
        t[2] = address(xbtc);
        uint256[] memory a = new uint256[](3);
        a[0] = 100_000e6;
        a[1] = _wethFor(100_000e6);
        a[2] = 3;
        MySunVaultUpgradeable vd = _newVault(t, a);
        vm.startPrank(owner);
        zap.registerVault(address(vd));
        zap.setRoute(address(usdg), address(weth), FEE100, address(wethPool), 600, 50, 50);
        zap.setRoute(address(usdg), address(xbtc), FEE100, address(p), 600, 50, 50);
        vm.stopPrank();

        // k/T_usdg ≈ 0.3 → the solve wants floor(k·4/T) = 1 raw XBTC (≈1,000 raw USDG), whose TWAP quote ×
        // 0.995 floors to 0 → leg skipped; the vault holds 3 raw XBTC → omission inadmissible → typed error.
        router.clearCalls();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PoolmigoZapIn.ZapIn__AmountTooSmall.selector, address(xbtc)));
        zap.zapDeposit(address(vd), address(usdg), 60_000e6, 1, 0, alice);
        vm.expectRevert(abi.encodeWithSelector(PoolmigoZapIn.ZapIn__AmountTooSmall.selector, address(xbtc)));
        zap.previewZap(address(vd), address(usdg), 60_000e6, 0);
        assertEq(router.callCount(), 0, "no net swap survived the revert");
        _assertClean(vd);
    }

    /*//////////////////////////////////////////////////////////////
                    COUPLED VAULT (findings T1 / T5)
    //////////////////////////////////////////////////////////////*/

    /// @dev The vault's whole TVL (1M) sits in a ±60-tick position IN the pool the zap swaps through. The zap's own
    ///      buy converts that position WETH → USDG before `deposit` reads it, so the vault needs less WETH. Sens sizing
    ///      measures that shift and keeps the WETH refund ≈ 0; the one-shot counterfactual (same pre-state, the full
    ///      pre-state target in one swap) overshoots into WETH by a large margin — the refund channel the study
    ///      showed can bypass minShares.
    function test_Coupled_SensKeepsBoughtRefundNearZero() public {
        (MySunVaultUpgradeable vc, MockV3Pool pool) = _coupledWorld();
        uint256 A = 237_000e6;
        (,, uint256 expected,) = zap.previewZap(address(vc), address(usdg), A, 0);

        uint256 pre = vm.snapshotState();
        router.clearCalls();
        (uint256 shares, uint256[] memory refunded) = _zapInto(vc, A, 0);
        _assertClean(vc);
        uint256 x1 = router.callAt(0).amountIn;
        uint256 sensWethRefundInUsdg = _toUsdg(pool, refunded[1]);
        emit log_named_uint("sens: WETH refund, USDG raw", sensWethRefundInUsdg);
        emit log_named_uint("sens: USDG refund, USDG raw", refunded[0]);
        assertLe(sensWethRefundInUsdg * BPS, 2 * A, "sens: bought-token refund <= 2 bps of A");
        // The view is one-shot at the PRE-state composition; the coupled shift puts the actual a hair above it
        // (measured ≈ 0.10 bps here; the study's model: ≤ 0.06 bps). Never below by more than rounding.
        _assertWithinBps(shares, expected, 2e13, "coupled: preview within 0.2 bps");
        assertGe(shares + shares / 1e8, expected, "coupled: actual not below the preview");

        // One-shot counterfactual at the SAME pre-state: swap the whole pre-state target 2·x1 at once.
        vm.revertToState(pre);
        uint256 s = 2 * x1;
        usdg.mint(address(pool), s);
        uint256 out = pool.swapExactIn(address(usdg) < address(weth), s, address(this));
        address[] memory t = _pair(address(usdg), address(weth));
        (, uint256[] memory req) = vc.previewDeposit(t, _pairAmt(A - s, out));
        uint256 oneShotRefundInUsdg = _toUsdg(pool, out - req[1]);
        emit log_named_uint("one-shot: WETH refund, USDG raw", oneShotRefundInUsdg);
        assertGt(oneShotRefundInUsdg * BPS, 100 * A, "one-shot would refund > 100 bps of A in WETH");
    }

    /*//////////////////////////////////////////////////////////////
                               HELPERS
    //////////////////////////////////////////////////////////////*/

    /// @dev Runs a 2-token zap and checks: two calls (phase 1 + top-up), EXACT minOuts (phase 1 = TWAP quote ×
    ///      haircut; phase 2 = aggregate remainder), the sizing equations against the pool's own execution, and
    ///      a clean zap afterwards.
    function _checkTwoPhase(MySunVaultUpgradeable v, uint256 A, uint16 slip) internal {
        (, uint256[] memory t0) = v.totalTokens();
        uint256 pre = vm.snapshotState();
        router.clearCalls();
        vm.prank(alice);
        zap.zapDeposit(address(v), address(usdg), A, 1, slip, alice);
        assertEq(router.callCount(), 2, "phase 1 + top-up");
        _assertClean(v);

        MockPermit2Router.SwapCall memory c1 = router.callAt(0);
        MockPermit2Router.SwapCall memory c2 = router.callAt(1);
        uint256 keep = BPS - (slip == 0 ? 50 : slip);
        uint160 sqrtTwap = TickMath.getSqrtRatioAtTick(wethPool.meanTick());
        bool zfo = address(usdg) < address(weth);
        assertEq(c1.amountOutMin, Math.mulDiv(_quote(c1.amountIn, sqrtTwap, zfo), keep, BPS), "phase-1 minOut exact");
        uint256 agg = Math.mulDiv(_quote(c1.amountIn + c2.amountIn, sqrtTwap, zfo), keep, BPS);
        assertEq(c2.amountOutMin, agg > c1.amountOut + 1 ? agg - c1.amountOut : 1, "phase-2 aggregate minOut exact");
        assertGe(c1.amountOut + c2.amountOut, agg, "aggregate TWAP bound holds");

        Leg[] memory legs = new Leg[](1);
        legs[0] = Leg(wethPool, address(weth), 1);
        MockPermit2Router.SwapCall[] memory calls = _copyCalls();
        vm.revertToState(pre);
        _checkPhaseEquations(t0, 0, A, legs, calls);
    }

    /// @dev Independent re-derivation of both sizing phases (decoupled vault: T¹ = T⁰, so λ-extrapolation is the
    ///      identity). Phase 1: with s_l = 2·x1_l and w_l = the POOL's output for s_l at the pre-state,
    ///      w_l ≈ k·(T_l+1)/(T_in+1) with k = A − Σ s_l. Phase 2: with have_l = phase-1 output, y_l the top-up and
    ///      w2_l its actual output, have_l + w2_l ≈ k2·(T_l+1)/(T_in+1) with k2 = A − Σ x1 − Σ y. Must be called at
    ///      the pre-state.
    function _checkPhaseEquations(
        uint256[] memory t0,
        uint256 inIdx,
        uint256 A,
        Leg[] memory legs,
        MockPermit2Router.SwapCall[] memory calls
    ) internal {
        uint256 n = legs.length;
        uint256 k = A;
        uint256 k2 = A;
        uint256[] memory w = new uint256[](n);
        for (uint256 l; l < n; ++l) {
            uint256 s = 2 * calls[l].amountIn;
            k -= s;
            k2 -= calls[l].amountIn + calls[n + l].amountIn;
            w[l] = _poolOut(legs[l].pool, s);
        }
        uint256 wIn = t0[inIdx] + 1;
        for (uint256 l; l < n; ++l) {
            uint256 wt = t0[legs[l].idx] + 1;
            uint256 want1 = Math.mulDiv(k, wt, wIn);
            // s_l may be 2·x1 or 2·x1 + 1 (floor half): allow one raw tokenIn of output plus 1e-8 relative.
            uint256 tol1 = want1 / 1e8 + _poolOut(legs[l].pool, 1) + 2;
            assertApproxEqAbs(w[l], want1, tol1, "phase-1: target = half of the pre-state solve");
            uint256 want2 = Math.mulDiv(k2, wt, wIn);
            assertApproxEqAbs(
                calls[l].amountOut + calls[n + l].amountOut, want2, want2 / 1e8 + 2, "phase-2: re-solved top-up"
            );
        }
    }

    /// @dev Output of an exact-in swap of `s` USDG on `pool` at the CURRENT state (executed, then rolled back).
    function _poolOut(MockV3Pool pool, uint256 s) internal returns (uint256 out) {
        uint256 snap = vm.snapshotState();
        usdg.mint(address(pool), s);
        out = pool.swapExactIn(address(usdg) == pool.token0(), s, address(0xdead));
        vm.revertToState(snap);
    }

    function _phase1Amount(MySunVaultUpgradeable v, uint256 A) internal returns (uint256 x1) {
        uint256 snap = vm.snapshotState();
        router.clearCalls();
        wethPool.syncTwapToSpot();
        vm.prank(alice);
        zap.zapDeposit(address(v), address(usdg), A, 1, 10, alice);
        x1 = router.callAt(0).amountIn;
        vm.revertToState(snap);
    }

    function _copyCalls() internal view returns (MockPermit2Router.SwapCall[] memory calls) {
        calls = new MockPermit2Router.SwapCall[](router.callCount());
        for (uint256 i; i < calls.length; ++i) {
            calls[i] = router.callAt(i);
        }
    }

    /// @dev 2-token offers reconstructed from the recorded swaps: USDG = A − Σ in; WETH = Σ out.
    function _offersFromCalls(uint256 A) internal view returns (uint256[] memory offers) {
        offers = new uint256[](2);
        offers[0] = A;
        for (uint256 i; i < router.callCount(); ++i) {
            MockPermit2Router.SwapCall memory c = router.callAt(i);
            offers[0] -= c.amountIn;
            offers[1] += c.amountOut;
        }
    }

    function _depositedEvent(Vm.Log[] memory logs)
        internal
        view
        returns (address[] memory tokens, uint256[] memory amounts)
    {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(vault) && logs[i].topics[0] == DEPOSITED_SIG) {
                (tokens, amounts,) = abi.decode(logs[i].data, (address[], uint256[], uint256));
                return (tokens, amounts);
            }
        }
        revert("no Deposited event");
    }

    function _zap(address who, uint256 A, uint16 slip, address receiver)
        internal
        returns (uint256 shares, uint256[] memory refunded)
    {
        vm.prank(who);
        (shares, refunded) = zap.zapDeposit(address(vault), address(usdg), A, 1, slip, receiver);
        _assertClean(vault);
    }

    function _zapInto(MySunVaultUpgradeable v, uint256 A, uint16 slip)
        internal
        returns (uint256 shares, uint256[] memory refunded)
    {
        vm.prank(alice);
        (shares, refunded) = zap.zapDeposit(address(v), address(usdg), A, 1, slip, alice);
    }

    /// @dev Post-condition of every successful call: zero balance of every basket token in the zap, and every
    ///      allowance layer zero — ERC20 → Permit2, Permit2 → router, ERC20 → vault.
    function _assertClean(MySunVaultUpgradeable v) internal view {
        address[] memory t = v.tokens();
        for (uint256 i; i < t.length; ++i) {
            IERC20 tok = IERC20(t[i]);
            assertEq(tok.balanceOf(address(zap)), 0, "zap holds no residue");
            assertEq(tok.allowance(address(zap), address(router)), 0, "ERC20 -> Permit2 allowance zero");
            (uint160 inner,,) = router.allowance(address(zap), t[i], address(router));
            assertEq(inner, 0, "Permit2 -> router allowance zero");
            assertEq(tok.allowance(address(zap), address(v)), 0, "ERC20 -> vault allowance zero");
        }
    }

    function _assertWithinBps(uint256 a, uint256 b, uint256 relWad, string memory err) internal pure {
        assertApproxEqRel(a, b, relWad, err);
    }

    /// @dev A bought-token refund must be dust: <= 1e-6 of the zap in USDG-equivalent at the pool price.
    function _assertBoughtRefundDust(uint256 actual, uint256 previewed, uint256 A) internal view {
        assertLe(_toUsdg(wethPool, actual) * 1e6, A, "bought refund dust");
        assertLe(_toUsdg(wethPool, previewed) * 1e6, A, "previewed bought refund dust");
    }

    /// @dev WETH raw → USDG raw at the pool's spot (test-side conversion between pool units, display only).
    function _toUsdg(MockV3Pool pool, uint256 wethAmount) internal view returns (uint256) {
        return _quote(wethAmount, pool.sqrtPriceX96(), address(weth) == pool.token0());
    }

    /// @dev OracleLibrary.getQuoteAtTick formula (zeroForOne = token0 → token1).
    function _quote(uint256 amountIn, uint160 sqrtPriceX96, bool zeroForOne) internal pure returns (uint256) {
        if (sqrtPriceX96 <= type(uint128).max) {
            uint256 ratioX192 = uint256(sqrtPriceX96) * sqrtPriceX96;
            return zeroForOne ? Math.mulDiv(amountIn, ratioX192, 1 << 192) : Math.mulDiv(amountIn, 1 << 192, ratioX192);
        }
        uint256 ratioX128 = Math.mulDiv(sqrtPriceX96, sqrtPriceX96, 1 << 64);
        return zeroForOne ? Math.mulDiv(amountIn, ratioX128, 1 << 128) : Math.mulDiv(amountIn, 1 << 128, ratioX128);
    }

    /*//////////////////////////////////////////////////////////////
                             WORLD BUILDERS
    //////////////////////////////////////////////////////////////*/

    /// @dev USDG + WETH + XBTC(8dp) + TKA(18dp, $1) + TKB(18dp, $300) + TKC(6dp, $1), mixed pool orientations,
    ///      one route per non-USDG token, $20k-ish of each in the vault (TKB skewed to $40k).
    function _sixTokenWorld() internal returns (MySunVaultUpgradeable v6, Leg[] memory legs) {
        MockToken[5] memory tk;
        tk[0] = weth;
        tk[1] = _orderedToken("XBTC", 8, false);
        tk[2] = _orderedToken("TKA", 18, true);
        tk[3] = _orderedToken("TKB", 18, false);
        tk[4] = _orderedToken("TKC", 6, true);
        // (token raw, USDG raw) of equal value
        uint256[5] memory unitTok = [uint256(1e18), 1e8, 1e18, 1e18, 1e6];
        uint256[5] memory unitUsd = [ETH_USDG, 100_000e6, 1e6, 300e6, 1e6];
        uint256[5] memory valueUsd = [uint256(20_000e6), 20_000e6, 20_000e6, 40_000e6, 20_000e6];

        address[] memory t = new address[](6);
        uint256[] memory a = new uint256[](6);
        t[0] = address(usdg);
        a[0] = 20_000e6;
        legs = new Leg[](5);
        MockV3Pool[5] memory pools;
        for (uint256 i; i < 5; ++i) {
            t[i + 1] = address(tk[i]);
            a[i + 1] = Math.mulDiv(valueUsd[i], unitTok[i], unitUsd[i]);
            pools[i] = i == 0
                ? wethPool
                : _newPool(tk[i], unitTok[i], unitUsd[i], _depthL(tk[i], unitTok[i], unitUsd[i], 10_000_000e6));
            legs[i] = Leg(pools[i], address(tk[i]), i + 1);
        }
        v6 = _newVault(t, a);
        vm.startPrank(owner);
        zap.registerVault(address(v6));
        for (uint256 i = 1; i < 5; ++i) {
            zap.setRoute(address(usdg), address(tk[i]), FEE100, address(pools[i]), 600, 50, 50);
        }
        vm.stopPrank();
    }

    /// @dev 1M TVL (500k USDG + 500k of WETH) entirely in a ±60-tick position inside a fresh USDG/WETH pool with the
    ///      live background liquidity.
    function _coupledWorld() internal returns (MySunVaultUpgradeable vc, MockV3Pool pool) {
        MockV3Factory f2 = new MockV3Factory();
        MockPermit2Router r2 = new MockPermit2Router(f2);
        pool = new MockV3Pool(address(f2), address(usdg), address(weth), FEE100, wethPool.sqrtPriceX96(), LIVE_L);
        f2.register(pool);
        usdg.mint(address(pool), 1e30);
        weth.mint(address(pool), 1e40);
        router = r2;
        zap = new MySunZapIn(address(r2), address(r2), owner);
        vm.prank(alice);
        usdg.approve(address(zap), type(uint256).max);

        vc = _newVault(_pair(address(usdg), address(weth)), _pairAmt(500_000e6, _wethFor(500_000e6)));
        int24 spot = pool.tick();
        CoupledV3Adapter ad = new CoupledV3Adapter(pool, address(vc), spot - 60, spot + 60);
        vm.startPrank(owner);
        vc.addAdapter(IPositionAdapter(address(ad)));
        vc.setKeeper(keeper, true);
        zap.registerVault(address(vc));
        zap.setRoute(address(usdg), address(weth), FEE100, address(pool), 600, 50, 50);
        vm.stopPrank();
        (address[] memory at,) = ad.position();
        uint256[] memory amts = new uint256[](2);
        amts[0] = IERC20(at[0]).balanceOf(address(vc));
        amts[1] = IERC20(at[1]).balanceOf(address(vc));
        vm.prank(keeper);
        vc.deployTo(IPositionAdapter(address(ad)), amts);
        emit log_named_uint("coupled: position liquidity", ad.liquidity());
        emit log_named_uint("coupled: pool liquidity", pool.liquidity());
    }

    function _newVault(address[] memory tokens_, uint256[] memory amounts) internal returns (MySunVaultUpgradeable v) {
        v = _deployVault(tokens_);
        vm.startPrank(owner);
        for (uint256 i; i < tokens_.length; ++i) {
            MockToken(tokens_[i]).mint(owner, amounts[i]);
            IERC20(tokens_[i]).approve(address(v), amounts[i]);
        }
        v.deposit(tokens_, amounts, GENESIS, owner);
        vm.stopPrank();
    }

    function _deployVault(address[] memory tokens_) internal returns (MySunVaultUpgradeable) {
        bytes memory init = abi.encodeCall(
            MySunVaultUpgradeable(address(0)).initialize,
            (owner, "sunEthLP", "sunEthLP", tokens_, treasury, 1500, GENESIS, 0)
        );
        return MySunVaultUpgradeable(address(new ERC1967Proxy(address(new MySunVaultUpgradeable()), init)));
    }

    /// @dev USDG/`tok` fee-100 pool priced so that `unitTok` of tok = `unitUsd` USDG raw, with liquidity `L`; deep
    ///      reserves minted to it; registered with the factory; TWAP = spot.
    function _newPool(MockToken tok, uint256 unitTok, uint256 unitUsd, uint128 L) internal returns (MockV3Pool p) {
        uint160 sqrtP = address(tok) < address(usdg)
            ? uint160(Math.sqrt(Math.mulDiv(unitUsd, 1 << 192, unitTok)))  // token0 = tok: P = usd per tok
            : uint160(Math.sqrt(Math.mulDiv(unitTok, 1 << 192, unitUsd))); // token0 = usdg: P = tok per usd
        p = new MockV3Pool(address(factory), address(usdg), address(tok), FEE100, sqrtP, L);
        factory.register(p);
        usdg.mint(address(p), 1e30);
        tok.mint(address(p), 1e40);
    }

    /// @dev L = √(x·y) for a virtual reserve of `depthUsd` USDG raw per side.
    function _depthL(MockToken, uint256 unitTok, uint256 unitUsd, uint256 depthUsd) internal pure returns (uint128) {
        uint256 resTok = Math.mulDiv(depthUsd, unitTok, unitUsd);
        return uint128(Math.sqrt(depthUsd * resTok));
    }

    /// @dev Deploys a MockToken whose address sorts below (or above) USDG — pool orientation control.
    function _orderedToken(string memory name, uint8 dec, bool belowUsdg) internal returns (MockToken t) {
        for (uint256 salt;; ++salt) {
            t = new MockToken{salt: keccak256(abi.encode(name, salt))}(name, name, dec);
            if ((address(t) < address(usdg)) == belowUsdg) {
                return t;
            }
        }
    }

    function _wethFor(uint256 usdAmount) internal pure returns (uint256) {
        return Math.mulDiv(usdAmount, 1e18, ETH_USDG);
    }

    function _pair(address a, address b) internal pure returns (address[] memory t) {
        t = new address[](2);
        t[0] = a;
        t[1] = b;
    }

    function _pairAmt(uint256 a, uint256 b) internal pure returns (uint256[] memory x) {
        x = new uint256[](2);
        x[0] = a;
        x[1] = b;
    }
}
