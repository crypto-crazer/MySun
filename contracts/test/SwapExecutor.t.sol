// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {ISwapExecutor} from "contracts/interfaces/ISwapExecutor.sol";
import {UniversalRouterSwapExecutor} from "contracts/swap/UniversalRouterSwapExecutor.sol";
import {UniswapV3Adapter} from "contracts/adapters/UniswapV3Adapter.sol";
import {PoolKey} from "contracts/adapters/uniswap/v4/IPoolManagerMinimal.sol";
import {MockToken} from "test/mocks/MockToken.sol";
import {MockV3Factory, MockV3Pool} from "test/mocks/MockV3Pool.sol";
import {MockPermit2Router} from "test/mocks/MockPermit2Router.sol";

/// @dev ERC-20 whose `transferFrom` re-enters the executor once (armed by the test) — the nonReentrant probe.
contract ReentrantToken is ERC20 {
    ISwapExecutor public target;
    address public otherToken;
    bool public armed;

    constructor() ERC20("Reentrant", "REE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(ISwapExecutor target_, address otherToken_) external {
        target = target_;
        otherToken = otherToken_;
        armed = true;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (armed) {
            armed = false;
            target.swapV3ExactIn(address(this), 3000, otherToken, 1, 1);
        }
        return super.transferFrom(from, to, amount);
    }
}

/**
 * @notice Strategy layer P1c — unit coverage of {UniversalRouterSwapExecutor} on the mock venue (`MockPermit2Router`
 *         doubles as Permit2 AND UniversalRouter; it now also speaks the codec's V4_SWAP shape), plus the adapters'
 *         executor wiring checks (v3 on mocks; v4 needs a PoolManager — fork suite). End-to-end proof against the real
 *         UniversalRouter / Permit2 lives in the fork suites.
 */
contract SwapExecutorTest is Test {
    MockToken internal tA;
    MockToken internal tB;
    MockV3Factory internal factory;
    MockPermit2Router internal router;
    MockV3Pool internal pool;
    UniversalRouterSwapExecutor internal exec;

    address internal alice = makeAddr("alice");
    address internal victim = makeAddr("victim");
    address internal rogue = makeAddr("rogue");

    uint24 internal constant FEE = 3000;
    uint256 internal constant RATE = 2e18; // tA -> tB at 2:1 (linear, from router inventory)
    uint256 internal constant AMOUNT = 10e18;

    function setUp() public {
        tA = new MockToken("Token A", "TKA", 18);
        tB = new MockToken("Token B", "TKB", 18);
        factory = new MockV3Factory();
        router = new MockPermit2Router(factory);
        pool = new MockV3Pool(address(factory), address(tA), address(tB), FEE, uint160(1 << 96), 1e24);
        factory.register(pool);
        exec = new UniversalRouterSwapExecutor(address(router), address(router));

        router.setLinearRate(address(tA), address(tB), RATE);
        router.setLinearRate(address(tB), address(tA), RATE);
        tA.mint(address(router), 1_000_000e18);
        tB.mint(address(router), 1_000_000e18);
        tA.mint(alice, 1_000e18);
        tA.mint(victim, 1_000e18);
        tB.mint(victim, 1_000e18);
        tA.mint(rogue, 1_000e18);
    }

    /*//////////////////////////////////////////////////////////////
                               CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    function test_Constructor_WiresImmutables() public view {
        assertEq(exec.UNIVERSAL_ROUTER(), address(router));
        assertEq(exec.PERMIT2(), address(router));
    }

    function test_Constructor_RejectsZeroAndCodeless() public {
        address eoa = makeAddr("eoa");
        vm.expectRevert(ISwapExecutor.SwapExecutor__ZeroAddress.selector);
        new UniversalRouterSwapExecutor(address(0), address(router));
        vm.expectRevert(ISwapExecutor.SwapExecutor__ZeroAddress.selector);
        new UniversalRouterSwapExecutor(address(router), address(0));
        vm.expectRevert(abi.encodeWithSelector(ISwapExecutor.SwapExecutor__NoCode.selector, eoa));
        new UniversalRouterSwapExecutor(eoa, address(router));
        vm.expectRevert(abi.encodeWithSelector(ISwapExecutor.SwapExecutor__NoCode.selector, eoa));
        new UniversalRouterSwapExecutor(address(router), eoa);
    }

    /*//////////////////////////////////////////////////////////////
                                 GUARDS
    //////////////////////////////////////////////////////////////*/

    function test_Guards_ZeroAmountAndZeroMinOut() public {
        vm.startPrank(alice);
        vm.expectRevert(ISwapExecutor.SwapExecutor__ZeroAmount.selector);
        exec.swapV3ExactIn(address(tA), FEE, address(tB), 0, 1);
        vm.expectRevert(ISwapExecutor.SwapExecutor__ZeroMinOut.selector);
        exec.swapV3ExactIn(address(tA), FEE, address(tB), AMOUNT, 0);
        vm.expectRevert(ISwapExecutor.SwapExecutor__ZeroAmount.selector);
        exec.swapV4ExactIn(_key(), _zeroForOne(address(tA)), 0, 1);
        vm.expectRevert(ISwapExecutor.SwapExecutor__ZeroMinOut.selector);
        exec.swapV4ExactIn(_key(), _zeroForOne(address(tA)), AMOUNT, 0);
        vm.stopPrank();
    }

    function test_Guards_PullsOnlyTheApprovedCallerAmount() public {
        vm.startPrank(alice);
        tA.approve(address(exec), AMOUNT - 1);
        vm.expectRevert(); // ERC20InsufficientAllowance: never more than the caller approved
        exec.swapV3ExactIn(address(tA), FEE, address(tB), AMOUNT, 1);
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                               HAPPY PATHS
    //////////////////////////////////////////////////////////////*/

    function test_SwapV3_PullsCallerOutputToCallerAllowancesZeroed() public {
        uint256 a0 = tA.balanceOf(alice);
        uint256 expected = AMOUNT * RATE / 1e18;

        vm.startPrank(alice);
        tA.approve(address(exec), AMOUNT);
        vm.expectEmit(true, true, true, true, address(exec));
        emit ISwapExecutor.SwapExecuted(alice, address(tA), address(tB), AMOUNT, expected);
        uint256 out = exec.swapV3ExactIn(address(tA), FEE, address(tB), AMOUNT, expected);
        vm.stopPrank();

        assertEq(out, expected, "return = delta");
        assertEq(tA.balanceOf(alice), a0 - AMOUNT, "exactly amountIn pulled from the caller");
        assertEq(tB.balanceOf(alice), expected, "output delivered to the caller");
        _assertExecutorClean();
        assertEq(tA.allowance(alice, address(exec)), 0, "caller's exact approval consumed");

        MockPermit2Router.SwapCall memory c = router.callAt(0);
        assertEq(c.payer, address(exec), "router pulled from the executor (Permit2)");
        assertEq(c.recipient, alice, "recipient = caller");
        assertEq(c.fee, FEE);
        assertEq(c.amountOutMin, expected);
        assertEq(c.innerAllowanceSeen, AMOUNT, "Permit2 -> router == amountIn");
        assertEq(c.outerAllowanceSeen, AMOUNT, "ERC20 -> Permit2 == amountIn");
    }

    function test_SwapV4_PullsCallerOutputToCallerAllowancesZeroed() public {
        uint256 expected = AMOUNT * RATE / 1e18;
        PoolKey memory key = _key();

        vm.startPrank(alice);
        tA.approve(address(exec), AMOUNT);
        vm.expectEmit(true, true, true, true, address(exec));
        emit ISwapExecutor.SwapExecuted(alice, address(tA), address(tB), AMOUNT, expected);
        uint256 out = exec.swapV4ExactIn(key, _zeroForOne(address(tA)), AMOUNT, expected);
        vm.stopPrank();

        assertEq(out, expected);
        assertEq(tB.balanceOf(alice), expected);
        _assertExecutorClean();
        MockPermit2Router.SwapCall memory c = router.callAt(0);
        assertEq(c.payer, address(exec));
        assertEq(c.recipient, alice);
        assertEq(c.fee, key.fee, "traded on the key's pool");
        assertEq(c.innerAllowanceSeen, AMOUNT);
    }

    /// @dev Through the mock pool (rate 0) — the output is whatever the venue delivered, measured as a delta.
    function testFuzz_SwapV3_ReturnIsCallerDelta(uint256 amountIn, uint256 preB) public {
        amountIn = bound(amountIn, 1e6, 100e18);
        preB = bound(preB, 0, 1e24);
        router.setLinearRate(address(tA), address(tB), 0);
        tA.mint(address(pool), 1_000_000e18);
        tB.mint(address(pool), 1_000_000e18);
        tB.mint(alice, preB);

        vm.startPrank(alice);
        tA.approve(address(exec), amountIn);
        uint256 out = exec.swapV3ExactIn(address(tA), FEE, address(tB), amountIn, 1);
        vm.stopPrank();

        assertGt(out, 0);
        assertEq(tB.balanceOf(alice), preB + out, "return == caller's balance delta");
        _assertExecutorClean();
    }

    /*//////////////////////////////////////////////////////////////
                                SLIPPAGE
    //////////////////////////////////////////////////////////////*/

    function test_SwapV3_MinOutUnreachable_TypedRevert() public {
        uint256 minOut = AMOUNT * RATE / 1e18 + 1;
        vm.startPrank(alice);
        tA.approve(address(exec), AMOUNT);
        vm.expectRevert(
            abi.encodeWithSelector(ISwapExecutor.SwapExecutor__SlippageExceeded.selector, address(tA), AMOUNT, minOut)
        );
        exec.swapV3ExactIn(address(tA), FEE, address(tB), AMOUNT, minOut);
        vm.stopPrank();
    }

    function test_SwapV4_MinOutUnreachable_TypedRevert() public {
        uint256 minOut = AMOUNT * RATE / 1e18 + 1;
        bool zfo = _zeroForOne(address(tA));
        PoolKey memory key = _key();
        vm.startPrank(alice);
        tA.approve(address(exec), AMOUNT);
        vm.expectRevert(
            abi.encodeWithSelector(ISwapExecutor.SwapExecutor__SlippageExceeded.selector, address(tA), AMOUNT, minOut)
        );
        exec.swapV4ExactIn(key, zfo, AMOUNT, minOut);
        vm.stopPrank();
    }

    /// @dev A non-conforming router that skips its own min check and under-delivers: the executor's balance-delta
    ///      re-check catches it with the same typed error.
    function test_Swap_ShortDeliveryCaughtByDeltaRecheck() public {
        uint256 full = AMOUNT * RATE / 1e18;
        router.setShortPay(1);
        vm.startPrank(alice);
        tA.approve(address(exec), AMOUNT);
        vm.expectRevert(
            abi.encodeWithSelector(ISwapExecutor.SwapExecutor__SlippageExceeded.selector, address(tA), AMOUNT, full)
        );
        exec.swapV3ExactIn(address(tA), FEE, address(tB), AMOUNT, full);
        vm.stopPrank();
    }

    /// @dev Router errors other than min-out bubble raw (here: no v3 pool for that fee tier).
    function test_Swap_OtherRouterErrorsBubbleRaw() public {
        router.setLinearRate(address(tA), address(tB), 0);
        vm.startPrank(alice);
        tA.approve(address(exec), AMOUNT);
        vm.expectRevert(bytes("NO_POOL"));
        exec.swapV3ExactIn(address(tA), 500, address(tB), AMOUNT, 1);
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                        PERMISSIONLESS SAFETY
    //////////////////////////////////////////////////////////////*/

    /// @dev Even with a victim's standing (mistaken) max approval to the executor, a third party can only swap its OWN
    ///      tokens to ITSELF: the victim's balances and allowance are untouched, the executor holds nothing after.
    function test_RogueCaller_MovesOnlyItsOwnTokens() public {
        vm.prank(victim);
        tA.approve(address(exec), type(uint256).max);
        uint256 vA = tA.balanceOf(victim);
        uint256 vB = tB.balanceOf(victim);
        uint256 rA = tA.balanceOf(rogue);
        uint256 expected = AMOUNT * RATE / 1e18;

        vm.startPrank(rogue);
        tA.approve(address(exec), AMOUNT);
        uint256 out = exec.swapV3ExactIn(address(tA), FEE, address(tB), AMOUNT, 1);
        out += _swapV4As(AMOUNT, 0); // the v4 path too (its own approval)
        vm.stopPrank();

        assertEq(out, 2 * expected);
        assertEq(tA.balanceOf(rogue), rA - 2 * AMOUNT, "rogue paid with its own tokens");
        assertEq(tB.balanceOf(rogue), 2 * expected, "output to the rogue caller only");
        assertEq(tA.balanceOf(victim), vA, "victim tokenIn untouched");
        assertEq(tB.balanceOf(victim), vB, "victim tokenOut untouched");
        assertEq(tA.allowance(victim, address(exec)), type(uint256).max, "victim allowance untouched");
        _assertExecutorClean();
    }

    /// @dev A rogue caller without tokens of its own cannot source the input from anyone else.
    function test_RogueCaller_CannotSpendOthersAllowance() public {
        vm.prank(victim);
        tA.approve(address(exec), type(uint256).max);
        address broke = makeAddr("broke");
        vm.prank(broke);
        vm.expectRevert(); // ERC20InsufficientAllowance(exec, 0, AMOUNT): only msg.sender is ever pulled
        exec.swapV3ExactIn(address(tA), FEE, address(tB), AMOUNT, 1);
        assertEq(tA.balanceOf(victim), 1_000e18);
    }

    function test_Reentrancy_Blocked() public {
        ReentrantToken ree = new ReentrantToken();
        ree.mint(alice, AMOUNT);
        ree.arm(exec, address(tB));
        vm.startPrank(alice);
        ree.approve(address(exec), AMOUNT);
        vm.expectRevert(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
        exec.swapV3ExactIn(address(ree), FEE, address(tB), AMOUNT, 1);
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                    ADAPTER WIRING (v3 on the mock venue)
    //////////////////////////////////////////////////////////////*/

    function test_V3Adapter_WiresExecutor() public {
        UniswapV3Adapter a = _newV3(address(exec));
        assertEq(address(a.SWAP_EXECUTOR()), address(exec));
    }

    function test_V3Adapter_RejectsBadExecutor() public {
        address eoa = makeAddr("eoa");
        vm.expectRevert(UniswapV3Adapter.UniswapV3Adapter__ZeroAddress.selector);
        _newV3(address(0));
        vm.expectRevert(abi.encodeWithSelector(UniswapV3Adapter.UniswapV3Adapter__NoCode.selector, eoa));
        _newV3(eoa);

        // An executor on another router (same Permit2), and one on another Permit2 (same router).
        MockPermit2Router otherRouter = new MockPermit2Router(factory);
        UniversalRouterSwapExecutor wrongRouter = new UniversalRouterSwapExecutor(address(otherRouter), address(router));
        UniversalRouterSwapExecutor wrongPermit2 =
            new UniversalRouterSwapExecutor(address(router), address(otherRouter));
        vm.expectRevert(
            abi.encodeWithSelector(UniswapV3Adapter.UniswapV3Adapter__ExecutorMismatch.selector, address(wrongRouter))
        );
        _newV3(address(wrongRouter));
        vm.expectRevert(
            abi.encodeWithSelector(UniswapV3Adapter.UniswapV3Adapter__ExecutorMismatch.selector, address(wrongPermit2))
        );
        _newV3(address(wrongPermit2));
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    function _assertExecutorClean() internal view {
        assertEq(tA.balanceOf(address(exec)), 0, "executor holds no tokenIn");
        assertEq(tB.balanceOf(address(exec)), 0, "executor holds no tokenOut");
        assertEq(tA.allowance(address(exec), address(router)), 0, "ERC20 -> Permit2 reset");
        assertEq(tB.allowance(address(exec), address(router)), 0, "ERC20 -> Permit2 reset");
        (uint160 innerA,,) = router.allowance(address(exec), address(tA), address(router));
        (uint160 innerB,,) = router.allowance(address(exec), address(tB), address(router));
        assertEq(innerA, 0, "Permit2 -> router reset");
        assertEq(innerB, 0, "Permit2 -> router reset");
    }

    function _swapV4As(uint256 amountIn, uint256 minOut) internal returns (uint256) {
        tA.approve(address(exec), amountIn);
        return exec.swapV4ExactIn(_key(), _zeroForOne(address(tA)), amountIn, minOut == 0 ? 1 : minOut);
    }

    function _key() internal view returns (PoolKey memory) {
        (address c0, address c1) = address(tA) < address(tB) ? (address(tA), address(tB)) : (address(tB), address(tA));
        return PoolKey({currency0: c0, currency1: c1, fee: FEE, tickSpacing: 60, hooks: address(0)});
    }

    function _zeroForOne(address tokenIn) internal view returns (bool) {
        return tokenIn == _key().currency0;
    }

    function _newV3(address executor) internal returns (UniswapV3Adapter) {
        return new UniswapV3Adapter(
            UniswapV3Adapter.Config({
                vault: makeAddr("vault"),
                pool: address(pool),
                positionManager: address(factory), // MockV3Factory.factory() == itself: the NFPM anchor
                swapRouter: address(router),
                permit2: address(router),
                swapExecutor: executor,
                owner: address(this),
                rangeTicksBelow: 600,
                rangeTicksAbove: 600,
                twapWindow: 1800,
                maxSlippageBps: 100
            })
        );
    }
}
