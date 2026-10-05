// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import {Test, Vm} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {MySunVaultUpgradeable} from "contracts/MySunVaultUpgradeable.sol";
import {IPositionAdapter} from "contracts/interfaces/IPositionAdapter.sol";
import {MySunZapOut} from "contracts/periphery/MySunZapOut.sol";
import {PoolmigoZapOut} from "contracts/periphery/PoolmigoZapOut.sol";
import {TickMath} from "contracts/adapters/uniswap/TickMath.sol";
import {MockToken} from "test/mocks/MockToken.sol";
import {MockPositionAdapter} from "test/mocks/MockPositionAdapter.sol";
import {MockPermit2Router} from "test/mocks/MockPermit2Router.sol";
import {MockV3Factory, MockV3Pool} from "test/mocks/MockV3Pool.sol";

/// @dev A position that DELIVERS one raw unit less than its pro-rata slice of each token (like a concentrated-
///      liquidity adapter whose venue rounds the released amounts down) but REPORTS the full slice back to the
///      vault. `position()` reports its real holdings. Exercises the vault's `previewRedeem` upper-bound rule and the
///      zap's balance-delta sizing (the zap must sell what arrived, not what was reported).
contract ShortDeliveryAdapter is IPositionAdapter {
    address public immutable VAULT;
    address[] internal _tokens;

    constructor(address[] memory tokens_, address vault_) {
        _tokens = tokens_;
        VAULT = vault_;
    }

    function dex() external pure returns (bytes32) {
        return keccak256("MOCK_SHORT_DELIVERY");
    }

    function poolId() external pure returns (bytes32) {
        return bytes32(0);
    }

    function position() public view returns (address[] memory tokens, uint256[] memory amounts) {
        tokens = _tokens;
        amounts = new uint256[](tokens.length);
        for (uint256 i; i < tokens.length; ++i) {
            amounts[i] = IERC20(tokens[i]).balanceOf(address(this));
        }
    }

    function deploy(uint256[] calldata amounts) external returns (address[] memory tokens, uint256[] memory deployed) {
        require(msg.sender == VAULT, "only vault");
        tokens = _tokens;
        deployed = amounts;
        for (uint256 i; i < tokens.length; ++i) {
            IERC20(tokens[i]).transferFrom(VAULT, address(this), amounts[i]);
        }
    }

    function withdrawProportional(uint256 sharesWad, address to)
        external
        returns (address[] memory tokens, uint256[] memory amounts, uint256[] memory fees)
    {
        require(msg.sender == VAULT, "only vault");
        tokens = _tokens;
        amounts = new uint256[](tokens.length);
        fees = new uint256[](tokens.length); // no fees
        for (uint256 i; i < tokens.length; ++i) {
            uint256 slice = Math.mulDiv(IERC20(tokens[i]).balanceOf(address(this)), sharesWad, 1e18);
            if (slice > 1) {
                IERC20(tokens[i]).transfer(to, slice - 1);
            }
            amounts[i] = slice; // over-reports by one raw unit
        }
    }

    function harvest() external pure returns (address[] memory, uint256[] memory) {
        revert("unsupported");
    }

    function unwindAll(address) external pure returns (address[] memory, uint256[] memory, uint256[] memory) {
        revert("unsupported");
    }
}

/// @dev Answers `tokens()` with an empty basket.
contract EmptyBasketVaultOut {
    function tokens() external pure returns (address[] memory) {
        return new address[](0);
    }
}

/**
 * @notice Unit suite for {MySunZapOut}: the REAL vault core (ERC1967 proxy) + the existing dual-role
 *         Permit2/UniversalRouter mock + constant-liquidity mock v3 pools (sell direction). Every sale amount is
 *         re-derived from the vault's own previewRedeem / balances, every minOut from OracleLibrary's quote formula,
 *         and every output from the mock pool's own execution.
 */
contract ZapOutTest is Test {
    uint256 internal constant BPS = 10_000;
    uint256 internal constant GENESIS = 200_000e18;
    /// @dev Live RHC fee-100 USDG/WETH in-range liquidity (findings T0, block 76526524).
    uint128 internal constant LIVE_L = 5_086e15;
    uint24 internal constant FEE100 = 100;
    /// @dev ETH ≈ 2,727 USDG (findings T0): 1e18 wei ↔ 2_727e6 USDG raw.
    uint256 internal constant ETH_USDG = 2_727e6;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal keeper = makeAddr("keeper");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    MockV3Factory internal factory;
    MockPermit2Router internal router;
    MySunZapOut internal zap;
    MockToken internal usdg;
    MockToken internal weth;
    MockV3Pool internal wethPool;
    MySunVaultUpgradeable internal vault;
    MockPositionAdapter internal mockAdapter;
    uint256 internal aliceShares;

    function setUp() public {
        usdg = new MockToken("Mock USDG", "USDG", 6);
        // Live orientation: WETH (0x0Bd7…) < USDG (0x5fc5…) → WETH is token0; selling it is zeroForOne.
        weth = _orderedToken("Mock WETH", 18, true);
        factory = new MockV3Factory();
        router = new MockPermit2Router(factory);
        zap = new MySunZapOut(address(router), address(router), owner);

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
        zap.setRoute(address(weth), address(usdg), FEE100, address(wethPool), 600, 50, 50);
        vm.stopPrank();

        // Alice holds sunEthLP from a normal in-kind deposit (50k + 50k worth) and approves the zap for exactly it.
        aliceShares = _fund(alice, vault, _pairAmt(50_000e6, _wethFor(50_000e6)));
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
        vm.expectRevert(PoolmigoZapOut.ZapOut__ZeroAddress.selector);
        new MySunZapOut(address(0), address(router), owner);
        vm.expectRevert(PoolmigoZapOut.ZapOut__ZeroAddress.selector);
        new MySunZapOut(address(router), address(0), owner);
        address eoa = makeAddr("eoa");
        vm.expectRevert(abi.encodeWithSelector(PoolmigoZapOut.ZapOut__NoCode.selector, eoa));
        new MySunZapOut(eoa, address(router), owner);
        vm.expectRevert(abi.encodeWithSelector(PoolmigoZapOut.ZapOut__NoCode.selector, eoa));
        new MySunZapOut(address(router), eoa, owner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new MySunZapOut(address(router), address(router), address(0));

        MockPermit2Router bad = new MockPermit2Router(factory);
        bad.setPositionManager(eoa);
        vm.expectRevert(abi.encodeWithSelector(PoolmigoZapOut.ZapOut__RouterMismatch.selector, address(bad)));
        new MySunZapOut(address(bad), address(router), owner);
        bad.setPositionManager(address(usdg));
        vm.expectRevert(abi.encodeWithSelector(PoolmigoZapOut.ZapOut__RouterMismatch.selector, address(bad)));
        new MySunZapOut(address(bad), address(router), owner);
        vm.expectRevert(abi.encodeWithSelector(PoolmigoZapOut.ZapOut__RouterMismatch.selector, address(usdg)));
        new MySunZapOut(address(usdg), address(router), owner);
    }

    /*//////////////////////////////////////////////////////////////
                         VAULT REGISTRY + ROUTES
    //////////////////////////////////////////////////////////////*/

    function test_RegisterVault_Rules() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        zap.registerVault(address(vault));

        vm.startPrank(owner);
        vm.expectRevert(PoolmigoZapOut.ZapOut__ZeroAddress.selector);
        zap.registerVault(address(0));
        vm.expectRevert(abi.encodeWithSelector(PoolmigoZapOut.ZapOut__NoCode.selector, alice));
        zap.registerVault(alice);
        vm.expectRevert(abi.encodeWithSelector(PoolmigoZapOut.ZapOut__VaultAlreadyRegistered.selector, address(vault)));
        zap.registerVault(address(vault));
        address empty = address(new EmptyBasketVaultOut());
        vm.expectRevert(abi.encodeWithSelector(PoolmigoZapOut.ZapOut__EmptyBasket.selector, empty));
        zap.registerVault(empty);
        vm.expectRevert(abi.encodeWithSelector(PoolmigoZapOut.ZapOut__EmptyBasket.selector, address(usdg)));
        zap.registerVault(address(usdg));

        vm.expectEmit(true, false, false, false, address(zap));
        emit PoolmigoZapOut.VaultDisabled(address(vault));
        zap.disableVault(address(vault));
        assertFalse(zap.isVaultRegistered(address(vault)));
        vm.expectRevert(abi.encodeWithSelector(PoolmigoZapOut.ZapOut__VaultNotRegistered.selector, address(vault)));
        zap.disableVault(address(vault));
        vm.stopPrank();

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PoolmigoZapOut.ZapOut__VaultNotRegistered.selector, address(vault)));
        zap.zapRedeem(address(vault), address(usdg), aliceShares, 1, 0, alice);

        vm.prank(owner);
        vm.expectEmit(true, false, false, false, address(zap));
        emit PoolmigoZapOut.VaultRegistered(address(vault));
        zap.registerVault(address(vault));
        vm.prank(alice);
        zap.zapRedeem(address(vault), address(usdg), aliceShares, 1, 0, alice);
        _assertClean(vault);
    }

    /// @dev The registry is PORTED unchanged: same defaults, bounds, canonical-pool and cardinality checks — here
    ///      registered in the exit direction (WETH → USDG).
    function test_SetRoute_DefaultsBoundsAndEvent() public {
        address w = address(weth);
        address u = address(usdg);
        address p = address(wethPool);
        vm.startPrank(owner);
        vm.expectEmit(true, true, true, true, address(zap));
        emit PoolmigoZapOut.RouteSet(w, u, p, FEE100, 600, 50, 50);
        zap.setRoute(w, u, FEE100, p, 0, 0, 0);
        (address refPool, uint24 fee, uint16 window, uint16 slip, uint16 dev) = zap.routes(w, u);
        assertEq(refPool, p);
        assertEq(fee, FEE100);
        assertEq(window, zap.DEFAULT_TWAP_WINDOW());
        assertEq(slip, zap.DEFAULT_MAX_SLIPPAGE_BPS());
        assertEq(dev, zap.DEFAULT_MAX_DEVIATION_BPS());
        assertEq(window, 600);
        assertEq(slip, 50);
        assertEq(dev, 50);

        vm.expectRevert(abi.encodeWithSelector(PoolmigoZapOut.ZapOut__TwapWindowOutOfRange.selector, 299, 300, 1800));
        zap.setRoute(w, u, FEE100, p, 299, 50, 50);
        vm.expectRevert(abi.encodeWithSelector(PoolmigoZapOut.ZapOut__TwapWindowOutOfRange.selector, 1801, 300, 1800));
        zap.setRoute(w, u, FEE100, p, 1801, 50, 50);
        vm.expectRevert(abi.encodeWithSelector(PoolmigoZapOut.ZapOut__SlippageOutOfRange.selector, 9, 10, 300));
        zap.setRoute(w, u, FEE100, p, 600, 9, 50);
        vm.expectRevert(abi.encodeWithSelector(PoolmigoZapOut.ZapOut__SlippageOutOfRange.selector, 301, 10, 300));
        zap.setRoute(w, u, FEE100, p, 600, 301, 50);
        vm.expectRevert(abi.encodeWithSelector(PoolmigoZapOut.ZapOut__DeviationOutOfRange.selector, 9, 10, 300));
        zap.setRoute(w, u, FEE100, p, 600, 50, 9);
        vm.expectRevert(abi.encodeWithSelector(PoolmigoZapOut.ZapOut__DeviationOutOfRange.selector, 301, 10, 300));
        zap.setRoute(w, u, FEE100, p, 600, 50, 301);
        zap.setRoute(w, u, FEE100, p, 300, 10, 10);
        zap.setRoute(w, u, FEE100, p, 1800, 300, 300);
        vm.stopPrank();
    }

    function test_SetRoute_PoolIdentityAndCardinality() public {
        MockToken other = new MockToken("Other", "OTH", 18);
        MockV3Pool unregistered =
            new MockV3Pool(address(factory), address(usdg), address(weth), FEE100, wethPool.sqrtPriceX96(), LIVE_L);
        MockV3Pool foreign = new MockV3Pool(
            makeAddr("otherFactory"), address(usdg), address(weth), 500, wethPool.sqrtPriceX96(), LIVE_L
        );
        address u = address(usdg);
        address w = address(weth);
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(PoolmigoZapOut.ZapOut__PoolMismatch.selector, address(wethPool)));
        zap.setRoute(w, u, 500, address(wethPool), 600, 50, 50);
        vm.expectRevert(abi.encodeWithSelector(PoolmigoZapOut.ZapOut__PoolMismatch.selector, address(wethPool)));
        zap.setRoute(address(other), u, FEE100, address(wethPool), 600, 50, 50);
        vm.expectRevert(abi.encodeWithSelector(PoolmigoZapOut.ZapOut__PoolMismatch.selector, address(unregistered)));
        zap.setRoute(w, u, FEE100, address(unregistered), 600, 50, 50);
        vm.expectRevert(abi.encodeWithSelector(PoolmigoZapOut.ZapOut__PoolMismatch.selector, address(foreign)));
        zap.setRoute(w, u, 500, address(foreign), 600, 50, 50);
        vm.expectRevert(abi.encodeWithSelector(PoolmigoZapOut.ZapOut__InvalidRoute.selector, w, w));
        zap.setRoute(w, w, FEE100, address(wethPool), 600, 50, 50);
        vm.expectRevert(PoolmigoZapOut.ZapOut__ZeroAddress.selector);
        zap.setRoute(w, address(0), FEE100, address(wethPool), 600, 50, 50);
        vm.expectRevert(PoolmigoZapOut.ZapOut__ZeroAddress.selector);
        zap.setRoute(w, u, FEE100, address(0), 600, 50, 50);
        vm.expectRevert(abi.encodeWithSelector(PoolmigoZapOut.ZapOut__NoCode.selector, alice));
        zap.setRoute(w, u, FEE100, alice, 600, 50, 50);
        vm.stopPrank();

        wethPool.setObservationCardinality(600);
        vm.startPrank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(PoolmigoZapOut.ZapOut__CardinalityTooLow.selector, address(wethPool), 600, 600)
        );
        zap.setRoute(w, u, FEE100, address(wethPool), 600, 50, 50);
        zap.setRoute(w, u, FEE100, address(wethPool), 599, 50, 50);
        vm.stopPrank();

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        zap.setRoute(w, u, FEE100, address(wethPool), 599, 50, 50);
    }

    /*//////////////////////////////////////////////////////////////
                               VALIDATION
    //////////////////////////////////////////////////////////////*/

    function test_Validation_Reverts() public {
        address v = address(vault);
        address u = address(usdg);
        uint256 s = aliceShares;
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(PoolmigoZapOut.ZapOut__VaultNotRegistered.selector, bob));
        zap.zapRedeem(bob, u, s, 1, 0, alice);
        MockToken stranger = new MockToken("Stranger", "STR", 6);
        vm.expectRevert(abi.encodeWithSelector(PoolmigoZapOut.ZapOut__TokenNotInBasket.selector, v, address(stranger)));
        zap.zapRedeem(v, address(stranger), s, 1, 0, alice);
        vm.expectRevert(PoolmigoZapOut.ZapOut__ZeroShares.selector);
        zap.zapRedeem(v, u, 0, 1, 0, alice);
        vm.expectRevert(PoolmigoZapOut.ZapOut__ZeroMinAmountOut.selector);
        zap.zapRedeem(v, u, s, 0, 0, alice);
        vm.expectRevert(PoolmigoZapOut.ZapOut__ZeroAddress.selector);
        zap.zapRedeem(v, u, s, 1, 0, address(0));
        vm.expectRevert(abi.encodeWithSelector(PoolmigoZapOut.ZapOut__InvalidReceiver.selector, address(zap)));
        zap.zapRedeem(v, u, s, 1, 0, address(zap));
        vm.expectRevert(abi.encodeWithSelector(PoolmigoZapOut.ZapOut__SlippageTooLoose.selector, 51, 50));
        zap.zapRedeem(v, u, s, 1, 51, alice);
        vm.stopPrank();
        // The same pre-state reasons revert the view.
        vm.expectRevert(abi.encodeWithSelector(PoolmigoZapOut.ZapOut__VaultNotRegistered.selector, bob));
        zap.previewRedeem(bob, u, s, 0);
        vm.expectRevert(abi.encodeWithSelector(PoolmigoZapOut.ZapOut__TokenNotInBasket.selector, v, address(stranger)));
        zap.previewRedeem(v, address(stranger), s, 0);
        vm.expectRevert(PoolmigoZapOut.ZapOut__ZeroShares.selector);
        zap.previewRedeem(v, u, 0, 0);
        vm.expectRevert(abi.encodeWithSelector(PoolmigoZapOut.ZapOut__SlippageTooLoose.selector, 51, 50));
        zap.previewRedeem(v, u, s, 51);
        uint256 supply = vault.totalSupply();
        vm.expectRevert(abi.encodeWithSelector(PoolmigoZapOut.ZapOut__SharesExceedSupply.selector, supply + 1, supply));
        zap.previewRedeem(v, u, supply + 1, 0);
        // Nothing moved.
        assertEq(vault.balanceOf(alice), s);
    }

    function test_Validation_SlippageOnlyForRoutesIntoTokenOut() public {
        // tokenOut = WETH: the relevant route is USDG → WETH (none) — slip 51 is not "looser than a route"; the
        // WETH → USDG route (max 50) is the reverse pair and does not count. USDG passes through.
        vm.prank(alice);
        (uint256 amountOut, uint256[] memory delivered) =
            zap.zapRedeem(address(vault), address(weth), aliceShares, 1, 51, alice);
        assertEq(router.callCount(), 0, "no route USDG -> WETH: nothing sold");
        assertEq(delivered[1], amountOut);
        assertGt(delivered[0], 0, "USDG passed through");
        _assertClean(vault);
    }

    function test_Tightening_UsedExactly() public {
        // slippageBps 20 < route 50: minOut = TWAP quote × (1 − 20 bps) exactly.
        _checkTwoToken(bob, aliceShares / 3, 20);
        // == route max is allowed (and 0 = route max)
        _checkTwoToken(bob, aliceShares / 3, 50);
        _checkTwoToken(bob, vault.balanceOf(alice), 0);
    }

    /*//////////////////////////////////////////////////////////////
                               HAPPY PATH
    //////////////////////////////////////////////////////////////*/

    /// @dev 2-token (USDG + WETH): redeem in kind → one WETH sale → everything to `receiver` (≠ caller). Exact
    ///      sale amount, exact minOut, delivered sums, shares burned, zap clean, every allowance layer zero.
    function test_HappyPath_TwoToken_ReceiverDiffers() public {
        uint256 supplyBefore = vault.totalSupply();
        uint256 aliceUsdg = usdg.balanceOf(alice);
        uint256 aliceWeth = weth.balanceOf(alice);
        (uint256 amountOut,) = _checkTwoToken(bob, aliceShares, 0);
        assertEq(vault.balanceOf(alice), 0, "all of alice's shares burned");
        assertEq(vault.totalSupply(), supplyBefore - aliceShares, "burned via the vault's redeem");
        assertEq(vault.allowance(alice, address(zap)), 0, "shares -> zap allowance consumed");
        assertEq(usdg.balanceOf(bob), amountOut, "receiver got the USDG");
        assertEq(weth.balanceOf(bob), 0, "no WETH left to deliver");
        assertEq(usdg.balanceOf(alice), aliceUsdg, "nothing to the caller (USDG)");
        assertEq(weth.balanceOf(alice), aliceWeth, "nothing to the caller (WETH)");

        // A second wallet works from the same clean state.
        uint256 bobShares = _fund(bob, vault, _pairAmt(10_000e6, _wethFor(10_000e6)));
        vm.prank(bob);
        (uint256 out2,) = zap.zapRedeem(address(vault), address(usdg), bobShares, 1, 0, bob);
        assertGt(out2, 0);
        assertEq(vault.balanceOf(bob), 0);
        _assertClean(vault);
    }

    function test_Events() public {
        (, uint256[] memory owed) = vault.previewRedeem(aliceShares);
        vm.expectEmit(true, true, true, false, address(zap));
        emit PoolmigoZapOut.ZapSold(alice, address(weth), address(usdg), owed[1], 0);
        vm.expectEmit(true, true, true, false, address(zap));
        emit PoolmigoZapOut.ZapRedeemed(alice, address(vault), address(usdg), aliceShares, 0, bob, new uint256[](0));
        vm.prank(alice);
        zap.zapRedeem(address(vault), address(usdg), aliceShares, 1, 0, bob);
    }

    /*//////////////////////////////////////////////////////////////
                              MULTI-LEG
    //////////////////////////////////////////////////////////////*/

    /// @dev 6-token basket (USDG + WETH + XBTC 8dp + TKA + TKB + TKC, mixed pool orientations), part of it in a
    ///      6-token mock position: one zap sells FIVE legs, each with the exact minOut and the pool's own output;
    ///      the preview equals the flow.
    function test_MultiLeg_SixToken_GenericLoop() public {
        (MySunVaultUpgradeable v6, MockV3Pool[] memory pools) = _sixTokenWorld();
        address[] memory t = v6.tokens();
        uint256 shares = _fund(alice, v6, _sixAmounts(20_000e6));

        (, uint256[] memory expSold, uint256 expOut, uint256[] memory expPass) =
            zap.previewRedeem(address(v6), address(usdg), shares, 0);
        (, uint256[] memory owed) = v6.previewRedeem(shares);
        uint256 recvBefore = usdg.balanceOf(bob);

        router.clearCalls();
        vm.prank(alice);
        (uint256 amountOut, uint256[] memory delivered) = zap.zapRedeem(address(v6), address(usdg), shares, 1, 0, bob);
        assertEq(router.callCount(), 5, "five sales in one call");

        uint256 sumOut;
        for (uint256 i; i < 5; ++i) {
            MockPermit2Router.SwapCall memory c = router.callAt(i);
            assertEq(c.tokenIn, t[i + 1], "registry order");
            assertEq(c.tokenOut, address(usdg));
            assertEq(c.amountIn, owed[i + 1], "sells the whole slice");
            assertEq(c.amountIn, expSold[i + 1], "preview sold");
            assertEq(c.amountOutMin, _minOut(pools[i], c.amountIn, c.tokenIn, 50), "minOut exact");
            assertEq(c.recipient, address(zap));
            assertEq(c.innerAllowanceSeen, c.amountIn);
            assertEq(c.outerAllowanceSeen, c.amountIn);
            assertEq(expPass[i + 1], 0);
            assertEq(delivered[i + 1], 0);
            sumOut += c.amountOut;
        }
        assertEq(amountOut, owed[0] + sumOut, "tokenOut = redeemed slice + every sale");
        assertEq(delivered[0], amountOut);
        assertEq(usdg.balanceOf(bob) - recvBefore, amountOut);
        assertEq(expOut, amountOut, "preview == flow on the constant-L mock");
        assertEq(v6.balanceOf(alice), 0);
        _assertClean(v6);
    }

    /*//////////////////////////////////////////////////////////////
                         PASS-THROUGH / DUST
    //////////////////////////////////////////////////////////////*/

    /// @dev A basket token with NO route into tokenOut is delivered as-is (+ event); the view reports it.
    function test_PassThrough_NoRoute() public {
        MockToken tkz = _orderedToken("TKZ", 18, false);
        address[] memory t = new address[](3);
        t[0] = address(usdg);
        t[1] = address(weth);
        t[2] = address(tkz);
        MySunVaultUpgradeable v3 = _newVault(t, _triple(50_000e6, _wethFor(50_000e6), 50_000e18));
        vm.prank(owner);
        zap.registerVault(address(v3));
        uint256 shares = _fund(alice, v3, _triple(10_000e6, _wethFor(10_000e6), 10_000e18));

        (, uint256[] memory expSold, uint256 expOut, uint256[] memory expPass) =
            zap.previewRedeem(address(v3), address(usdg), shares, 0);
        (, uint256[] memory owed) = v3.previewRedeem(shares);
        assertEq(expPass[2], owed[2], "view: TKZ passes through");
        assertEq(expSold[2], 0);
        assertEq(expSold[1], owed[1], "view: WETH sold");

        vm.expectEmit(true, true, false, true, address(zap));
        emit PoolmigoZapOut.ZapPassThrough(alice, address(tkz), owed[2]);
        vm.prank(alice);
        (uint256 amountOut, uint256[] memory delivered) = zap.zapRedeem(address(v3), address(usdg), shares, 1, 0, bob);
        assertEq(delivered[2], owed[2], "TKZ delivered in kind");
        assertEq(tkz.balanceOf(bob), owed[2]);
        assertEq(delivered[1], 0, "WETH sold");
        assertEq(amountOut, expOut, "preview == flow");
        assertEq(router.callCount(), 1, "only WETH sold");
        _assertClean(v3);
    }

    /// @dev A sale whose minOut floors to 0 (an 18-dp $1 token: 1 raw = 1e-12 raw USDG) is a dust pass-through —
    ///      no swap, no revert, same event; the view agrees.
    function test_Dust_SaleFloorsToZero_PassThrough() public {
        MockToken tka = _orderedToken("TKA", 18, true);
        MockV3Pool p = _newPool(tka, 1e18, 1e6, _depthL(tka, 1e18, 1e6, 10_000_000e6));
        address[] memory t = new address[](3);
        t[0] = address(usdg);
        t[1] = address(weth);
        t[2] = address(tka);
        // The vault holds 5e11 raw TKA (half a raw USDG's worth).
        MySunVaultUpgradeable vd = _newVault(t, _triple(100_000e6, _wethFor(100_000e6), 5e11));
        vm.startPrank(owner);
        zap.registerVault(address(vd));
        zap.setRoute(address(tka), address(usdg), FEE100, address(p), 600, 50, 50);
        vm.stopPrank();
        uint256 shares = _fund(alice, vd, _triple(50_000e6, _wethFor(50_000e6), 1e18));

        (, uint256[] memory owed) = vd.previewRedeem(shares);
        assertGt(owed[2], 0, "a non-zero TKA slice");
        assertEq(_minOut(p, owed[2], address(tka), 50), 0, "its minOut floors to 0");
        (,,, uint256[] memory expPass) = zap.previewRedeem(address(vd), address(usdg), shares, 0);
        assertEq(expPass[2], owed[2], "view: dust pass-through");

        router.clearCalls();
        vm.expectEmit(true, true, false, true, address(zap));
        emit PoolmigoZapOut.ZapPassThrough(alice, address(tka), owed[2]);
        vm.prank(alice);
        (, uint256[] memory delivered) = zap.zapRedeem(address(vd), address(usdg), shares, 1, 0, bob);
        assertEq(delivered[2], owed[2]);
        assertEq(router.callCount(), 1, "TKA not swapped");
        assertEq(router.callAt(0).tokenIn, address(weth));
        _assertClean(vd);
    }

    /*//////////////////////////////////////////////////////////////
                             MIN AMOUNT OUT
    //////////////////////////////////////////////////////////////*/

    function test_MinAmountOut_JustAboveAchievable_RevertsAtomically() public {
        uint256 snap = vm.snapshotState();
        vm.prank(alice);
        (uint256 achievable,) = zap.zapRedeem(address(vault), address(usdg), aliceShares, 1, 0, bob);
        vm.revertToState(snap);

        uint256 usdgBob = usdg.balanceOf(bob);
        uint160 poolPrice = wethPool.sqrtPriceX96();
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(PoolmigoZapOut.ZapOut__MinAmountOut.selector, achievable + 1, achievable)
        );
        zap.zapRedeem(address(vault), address(usdg), aliceShares, achievable + 1, 0, bob);
        // Nothing moved: shares, allowance, receiver, pool.
        assertEq(vault.balanceOf(alice), aliceShares);
        assertEq(vault.allowance(alice, address(zap)), aliceShares);
        assertEq(usdg.balanceOf(bob), usdgBob);
        assertEq(wethPool.sqrtPriceX96(), poolPrice);
        _assertClean(vault);

        // Exactly achievable passes.
        vm.prank(alice);
        (uint256 out,) = zap.zapRedeem(address(vault), address(usdg), aliceShares, achievable, 0, bob);
        assertEq(out, achievable);
    }

    /*//////////////////////////////////////////////////////////////
                           DEVIATION CHECK
    //////////////////////////////////////////////////////////////*/

    /// @dev Selling token0 (WETH) for token1 (USDG): the bought token is token1 → adverse when spot tick < TWAP.
    function test_Deviation_Token0Sold_AdverseRevertsBeforeSwap() public {
        int24 spot = wethPool.tick();
        wethPool.setMeanTick(spot + 51);
        bytes memory err = abi.encodeWithSelector(
            PoolmigoZapOut.ZapOut__SpotDeviatesFromTwap.selector, address(wethPool), spot, spot + 51, uint16(50)
        );
        vm.prank(alice);
        vm.expectRevert(err);
        zap.zapRedeem(address(vault), address(usdg), aliceShares, 1, 0, alice);
        vm.expectRevert(err);
        zap.previewRedeem(address(vault), address(usdg), aliceShares, 0);
        assertEq(router.callCount(), 0, "no swap attempted");
        assertEq(vault.balanceOf(alice), aliceShares, "atomic");

        // 50 ticks is inside the bound (and the swap bound itself still passes at slip 100).
        wethPool.setMeanTick(spot + 50);
        vm.prank(owner);
        zap.setRoute(address(weth), address(usdg), FEE100, address(wethPool), 600, 100, 50);
        vm.prank(alice);
        zap.zapRedeem(address(vault), address(usdg), aliceShares / 10, 1, 0, alice);
        _assertClean(vault);
    }

    function test_Deviation_Token0Sold_FavourableSideAllowed() public {
        // TWAP 200 ticks BELOW spot: USDG is cheaper than its TWAP in WETH terms (favourable) → no deviation revert.
        wethPool.setMeanTick(wethPool.tick() - 200);
        vm.prank(alice);
        (uint256 amountOut,) = zap.zapRedeem(address(vault), address(usdg), aliceShares, 1, 0, alice);
        assertGt(amountOut, 0);
        _assertClean(vault);
    }

    /// @dev Selling token1 (TKB, sorted above USDG) for token0 (USDG): bought token0 → adverse when spot > TWAP.
    function test_Deviation_Token1Sold_BothSides() public {
        MockToken tkb = _orderedToken("TKB", 18, false);
        MockV3Pool p = _newPool(tkb, 1e18, 300e6, _depthL(tkb, 1e18, 300e6, 5_000_000e6));
        MySunVaultUpgradeable v2 = _newVault(_pair(address(usdg), address(tkb)), _pairAmt(50_000e6, 166e18));
        vm.startPrank(owner);
        zap.registerVault(address(v2));
        zap.setRoute(address(tkb), address(usdg), FEE100, address(p), 600, 50, 50);
        vm.stopPrank();
        uint256 shares = _fund(alice, v2, _pairAmt(10_000e6, 34e18));
        assertEq(p.token1(), address(tkb), "TKB is token1");

        int24 spot = p.tick();
        p.setMeanTick(spot - 51);
        bytes memory err = abi.encodeWithSelector(
            PoolmigoZapOut.ZapOut__SpotDeviatesFromTwap.selector, address(p), spot, spot - 51, uint16(50)
        );
        vm.prank(alice);
        vm.expectRevert(err);
        zap.zapRedeem(address(v2), address(usdg), shares, 1, 0, alice);
        vm.expectRevert(err);
        zap.previewRedeem(address(v2), address(usdg), shares, 0);
        assertEq(router.callCount(), 0, "no swap attempted");

        p.setMeanTick(spot + 200); // favourable
        (,, uint256 expOut,) = zap.previewRedeem(address(v2), address(usdg), shares, 0);
        vm.prank(alice);
        (uint256 amountOut,) = zap.zapRedeem(address(v2), address(usdg), shares, 1, 0, alice);
        assertEq(router.callAt(0).amountOutMin, _minOut(p, router.callAt(0).amountIn, address(tkb), 50));
        assertEq(amountOut, expOut, "preview == flow (token1 -> token0)");
        _assertClean(v2);
    }

    /*//////////////////////////////////////////////////////////////
                            SWAP FAILURES
    //////////////////////////////////////////////////////////////*/

    function test_Swap_TooLittleReceived_Typed() public {
        router.setForceTooLittle(true);
        (, uint256[] memory owed) = vault.previewRedeem(aliceShares);
        uint256 minOut = _minOut(wethPool, owed[1], address(weth), 50);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(PoolmigoZapOut.ZapOut__SlippageExceeded.selector, address(weth), owed[1], minOut)
        );
        zap.zapRedeem(address(vault), address(usdg), aliceShares, 1, 0, alice);
    }

    function test_Swap_TightSlippage_RealBoundReverts() public {
        // TWAP 40 ticks ABOVE spot (adverse, inside maxDeviation 50): the TWAP values WETH ~0.4 % dearer than spot,
        // so a 10 bps haircut asks for more USDG than the pool gives → router V3TooLittleReceived → typed.
        int24 spot = wethPool.tick();
        wethPool.setMeanTick(spot + 40);
        (, uint256[] memory owed) = vault.previewRedeem(aliceShares);
        uint256 minOut = _minOut(wethPool, owed[1], address(weth), 10);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(PoolmigoZapOut.ZapOut__SlippageExceeded.selector, address(weth), owed[1], minOut)
        );
        zap.zapRedeem(address(vault), address(usdg), aliceShares, 1, 10, alice);
    }

    function test_Swap_NonConformingRouter_BalanceDeltaRecheck() public {
        // The router ignores amountOutMin and short-pays: the zap's own balance-delta check catches it.
        router.setShortPay(1_000e6);
        vm.prank(alice);
        vm.expectPartialRevert(PoolmigoZapOut.ZapOut__SlippageExceeded.selector);
        zap.zapRedeem(address(vault), address(usdg), aliceShares, 1, 0, alice);
    }

    function test_Twap_Unavailable_Typed() public {
        wethPool.setObserveReverts(true);
        bytes memory err =
            abi.encodeWithSelector(PoolmigoZapOut.ZapOut__TwapUnavailable.selector, address(wethPool), uint16(600));
        vm.prank(alice);
        vm.expectRevert(err);
        zap.zapRedeem(address(vault), address(usdg), aliceShares, 1, 0, alice);
        vm.expectRevert(err);
        zap.previewRedeem(address(vault), address(usdg), aliceShares, 0);
    }

    /*//////////////////////////////////////////////////////////////
                               PREVIEW
    //////////////////////////////////////////////////////////////*/

    function test_Preview_MatchesActual() public {
        uint256[3] memory parts = [uint256(1_000), 100, 1];
        for (uint256 i; i < parts.length; ++i) {
            uint256 shares = vault.balanceOf(alice) / parts[i];
            (address[] memory t, uint256[] memory expSold, uint256 expOut, uint256[] memory expPass) =
                zap.previewRedeem(address(vault), address(usdg), shares, 0);
            assertEq(t[0], address(usdg));
            assertEq(t[1], address(weth));
            router.clearCalls();
            vm.prank(alice);
            (uint256 amountOut, uint256[] memory delivered) =
                zap.zapRedeem(address(vault), address(usdg), shares, 1, 0, bob);
            assertGe(expOut, amountOut, "preview is an upper bound");
            assertEq(expOut, amountOut, "exact on the constant-L mock with linear adapters");
            assertEq(expSold[1], router.callAt(0).amountIn);
            assertEq(expPass[1], 0);
            assertEq(delivered[1], 0);
            _assertClean(vault);
        }
    }

    /// @dev The vault's `previewRedeem` is documented as an UPPER bound (delivery rounds down, never up). With a
    ///      position that delivers one raw unit short (and over-reports): since fee-at-exit (2026-10-03) adapter
    ///      slices land IN THE VAULT and the vault pays idle slice + REPORTED slice − perf cut, so the receiver gets
    ///      the full reported slice and the vault's idle absorbs the adapter's 1-unit shortfall. The vault preview
    ///      stays an upper bound, the zap sells what ARRIVED (balance delta) and its own preview stays an upper bound.
    function test_Preview_UpperBound_ShortDeliveryAdapter() public {
        ShortDeliveryAdapter sd = new ShortDeliveryAdapter(_pair(address(usdg), address(weth)), address(vault));
        vm.prank(owner);
        vault.addAdapter(IPositionAdapter(address(sd)));
        vm.prank(keeper);
        vault.deployTo(IPositionAdapter(address(sd)), _pairAmt(20_000e6, _wethFor(20_000e6)));

        uint256 shares = aliceShares / 3;
        (, uint256[] memory owed) = vault.previewRedeem(shares);
        (,, uint256 expOut,) = zap.previewRedeem(address(vault), address(usdg), shares, 0);

        router.clearCalls();
        uint256 zapWethBefore = weth.balanceOf(address(zap));
        uint256 vaultWethBefore = weth.balanceOf(address(vault));
        uint256 idleSliceWeth = Math.mulDiv(shares, vaultWethBefore, vault.totalSupply());
        vm.recordLogs();
        vm.prank(alice);
        (uint256 amountOut,) = zap.zapRedeem(address(vault), address(usdg), shares, 1, 0, bob);
        uint256[] memory reported = _redeemedFromEvent(vm.getRecordedLogs());

        uint256 sold = router.callAt(0).amountIn;
        assertEq(zapWethBefore, 0);
        assertEq(sold, owed[1], "WETH arrives as the vault pays it: idle slice + the adapter's REPORTED slice");
        assertEq(reported[1], owed[1], "the vault reported the full slice");
        assertEq(
            weth.balanceOf(address(vault)),
            vaultWethBefore - idleSliceWeth - 1,
            "the vault's idle absorbed the adapter's 1-unit short delivery"
        );
        assertLe(sold, owed[1], "vault preview is an upper bound (WETH)");
        assertLe(amountOut, expOut, "zap preview is an upper bound");
        assertApproxEqAbs(amountOut, expOut, 10, "within dust");
        _assertClean(vault);
    }

    /*//////////////////////////////////////////////////////////////
                          SWEEP / CUSTODY
    //////////////////////////////////////////////////////////////*/

    /// @dev Tokens sent to the zap outside a zap leave with the next zap's receiver (whole-balance sweep); the sale
    ///      itself is sized on the redeem delta only.
    function test_Sweep_WholeBalance_SaleSizedOnDelta() public {
        weth.mint(address(zap), 1e15);
        usdg.mint(address(zap), 7);
        (, uint256[] memory owed) = vault.previewRedeem(aliceShares);
        vm.prank(alice);
        (uint256 amountOut, uint256[] memory delivered) =
            zap.zapRedeem(address(vault), address(usdg), aliceShares, 1, 0, bob);
        assertEq(router.callAt(0).amountIn, owed[1], "sale = redeem delta, not the stray balance");
        assertEq(delivered[1], 1e15, "stray WETH swept to the receiver");
        assertEq(amountOut, owed[0] + router.callAt(0).amountOut + 7);
        _assertClean(vault);
    }

    /*//////////////////////////////////////////////////////////////
                               HELPERS
    //////////////////////////////////////////////////////////////*/

    /// @dev Zap `shares` of alice's into USDG for `receiver` and check the sale: one call selling exactly the
    ///      vault's (exact, linear-mock) WETH slice with the EXACT TWAP minOut, output to the zap, exact two-layer
    ///      allowances; amountOut = USDG slice + sale output; clean afterwards.
    function _checkTwoToken(address receiver, uint256 shares, uint16 slip)
        internal
        returns (uint256 amountOut, uint256[] memory delivered)
    {
        (, uint256[] memory owed) = vault.previewRedeem(shares);
        router.clearCalls();
        vm.prank(alice);
        (amountOut, delivered) = zap.zapRedeem(address(vault), address(usdg), shares, 1, slip, receiver);
        assertEq(router.callCount(), 1, "one sale");
        MockPermit2Router.SwapCall memory c = router.callAt(0);
        assertEq(c.tokenIn, address(weth));
        assertEq(c.tokenOut, address(usdg));
        assertEq(c.fee, FEE100);
        assertEq(c.amountIn, owed[1], "sells the whole WETH slice");
        assertEq(c.amountOutMin, _minOut(wethPool, c.amountIn, address(weth), slip == 0 ? 50 : slip), "minOut exact");
        assertEq(c.recipient, address(zap), "swap output hard-wired to the zap");
        assertEq(c.payer, address(zap));
        assertEq(c.innerAllowanceSeen, c.amountIn, "Permit2 inner allowance == amountIn");
        assertEq(c.outerAllowanceSeen, c.amountIn, "ERC20 -> Permit2 allowance == amountIn");
        assertEq(amountOut, owed[0] + c.amountOut, "USDG slice + sale output");
        assertEq(delivered[0], amountOut);
        assertEq(delivered[1], 0);
        _assertClean(vault);
    }

    /// @dev TWAP-quoted minOut the zap must pass: quote at the pool's mean tick × (1 − slip).
    function _minOut(MockV3Pool pool, uint256 amountIn, address tokenIn, uint256 slip) internal view returns (uint256) {
        uint160 sqrtTwap = TickMath.getSqrtRatioAtTick(pool.meanTick());
        return Math.mulDiv(_quote(amountIn, sqrtTwap, tokenIn == pool.token0()), BPS - slip, BPS);
    }

    /// @dev Post-condition of every successful call: zero balance of every basket token and of shares in the zap,
    ///      and every allowance layer zero — ERC20 → Permit2, Permit2 → router, ERC20 → vault.
    function _assertClean(MySunVaultUpgradeable v) internal view {
        assertEq(v.balanceOf(address(zap)), 0, "zap holds no shares");
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

    function _redeemedFromEvent(Vm.Log[] memory logs) internal view returns (uint256[] memory redeemed) {
        bytes32 sig = keccak256("ZapRedeemed(address,address,address,uint256,uint256,address,uint256[])");
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(zap) && logs[i].topics[0] == sig) {
                (,,, redeemed) = abi.decode(logs[i].data, (uint256, uint256, address, uint256[]));
                return redeemed;
            }
        }
        revert("no ZapRedeemed event");
    }

    /// @dev Mint `amounts` of `v`'s basket to `who`, deposit them in kind (direct vault call), and approve the zap
    ///      for exactly the shares minted.
    function _fund(address who, MySunVaultUpgradeable v, uint256[] memory amounts) internal returns (uint256 shares) {
        address[] memory t = v.tokens();
        vm.startPrank(who);
        for (uint256 i; i < t.length; ++i) {
            MockToken(t[i]).mint(who, amounts[i]);
            IERC20(t[i]).approve(address(v), amounts[i]);
        }
        shares = v.deposit(t, amounts, 1, who);
        for (uint256 i; i < t.length; ++i) {
            IERC20(t[i]).approve(address(v), 0);
        }
        v.approve(address(zap), shares);
        vm.stopPrank();
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

    /// @dev (token raw, USDG raw) of equal value for WETH, XBTC(8dp), TKA(18dp $1), TKB(18dp $300), TKC(6dp $1).
    function _units() internal pure returns (uint256[5] memory unitTok, uint256[5] memory unitUsd) {
        unitTok = [uint256(1e18), 1e8, 1e18, 1e18, 1e6];
        unitUsd = [ETH_USDG, 100_000e6, 1e6, 300e6, 1e6];
    }

    /// @dev Six-token amounts: `usd` of USDG and `usd` worth of each other token.
    function _sixAmounts(uint256 usd) internal pure returns (uint256[] memory a) {
        (uint256[5] memory unitTok, uint256[5] memory unitUsd) = _units();
        a = new uint256[](6);
        a[0] = usd;
        for (uint256 i; i < 5; ++i) {
            a[i + 1] = Math.mulDiv(usd, unitTok[i], unitUsd[i]);
        }
    }

    /// @dev USDG + WETH + XBTC + TKA + TKB + TKC, mixed pool orientations, one route per non-USDG token INTO USDG,
    ///      $40k of each in the vault, a quarter of everything in a 6-token mock position.
    function _sixTokenWorld() internal returns (MySunVaultUpgradeable v6, MockV3Pool[] memory pools) {
        (uint256[5] memory unitTok, uint256[5] memory unitUsd) = _units();
        MockToken[5] memory tk;
        tk[0] = weth;
        tk[1] = _orderedToken("XBTC", 8, false);
        tk[2] = _orderedToken("TKA", 18, true);
        tk[3] = _orderedToken("TKB", 18, false);
        tk[4] = _orderedToken("TKC", 6, true);

        address[] memory t = new address[](6);
        t[0] = address(usdg);
        pools = new MockV3Pool[](5);
        for (uint256 i; i < 5; ++i) {
            t[i + 1] = address(tk[i]);
            pools[i] = i == 0
                ? wethPool
                : _newPool(tk[i], unitTok[i], unitUsd[i], _depthL(tk[i], unitTok[i], unitUsd[i], 10_000_000e6));
        }
        v6 = _newVault(t, _sixAmounts(40_000e6));
        MockPositionAdapter ad = new MockPositionAdapter(t, address(v6), "MOCK6", bytes32(0));
        vm.startPrank(owner);
        v6.addAdapter(IPositionAdapter(address(ad)));
        v6.setKeeper(keeper, true);
        zap.registerVault(address(v6));
        for (uint256 i = 1; i < 5; ++i) {
            zap.setRoute(address(tk[i]), address(usdg), FEE100, address(pools[i]), 600, 50, 50);
        }
        vm.stopPrank();
        vm.prank(keeper);
        v6.deployTo(IPositionAdapter(address(ad)), _sixAmounts(10_000e6));
    }

    function _newVault(address[] memory tokens_, uint256[] memory amounts) internal returns (MySunVaultUpgradeable v) {
        bytes memory init = abi.encodeCall(
            MySunVaultUpgradeable(address(0)).initialize,
            (owner, "sunEthLP", "sunEthLP", tokens_, treasury, 1500, GENESIS, 0)
        );
        v = MySunVaultUpgradeable(address(new ERC1967Proxy(address(new MySunVaultUpgradeable()), init)));
        vm.startPrank(owner);
        for (uint256 i; i < tokens_.length; ++i) {
            MockToken(tokens_[i]).mint(owner, amounts[i]);
            IERC20(tokens_[i]).approve(address(v), amounts[i]);
        }
        v.deposit(tokens_, amounts, GENESIS, owner);
        vm.stopPrank();
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

    function _triple(uint256 a, uint256 b, uint256 c) internal pure returns (uint256[] memory x) {
        x = new uint256[](3);
        x[0] = a;
        x[1] = b;
        x[2] = c;
    }
}
