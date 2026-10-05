// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {IUniswapV3PoolMinimal} from "contracts/adapters/uniswap/IUniswapV3PoolMinimal.sol";
import {IUniswapV3FactoryMinimal} from "contracts/adapters/uniswap/IUniswapV3FactoryMinimal.sol";
import {INonfungiblePositionManager} from "contracts/adapters/uniswap/INonfungiblePositionManager.sol";
import {IUniversalRouter, UniversalRouterCodec} from "contracts/adapters/uniswap/IUniversalRouter.sol";
import {IPermit2Minimal} from "contracts/adapters/uniswap/v4/IPermit2Minimal.sol";
import {TickMath} from "contracts/adapters/uniswap/TickMath.sol";
import {FixedPoint96} from "contracts/adapters/uniswap/FixedPoint96.sol";

/// @notice The subset of the MySun vault surface the zap calls (`src/interfaces/IPoolmigoVault.sol` declares
///         events and errors only). Signatures match `PoolmigoVaultUpgradeable`.
interface IPoolmigoZapVault {
    function tokens() external view returns (address[] memory);
    function totalTokens() external view returns (address[] memory tokens_, uint256[] memory amounts);
    function totalSupply() external view returns (uint256);
    function previewDeposit(address[] calldata tokens_, uint256[] calldata amounts_)
        external
        view
        returns (uint256 shares, uint256[] memory requiredAmounts);
    function deposit(address[] calldata tokens_, uint256[] calldata amounts_, uint256 minShares, address receiver)
        external
        returns (uint256 shares);
}

/**
 * @title PoolmigoZapIn
 * @author MySun
 * @notice Single-asset deposit periphery: a wallet holding ONE basket token (the quote token, USDG) reaches the
 *         vault's receipt token in one transaction. The zap swaps part of the input into the other basket tokens
 *         in the vault's CURRENT ratio, deposits the resulting vector in kind through the vault's normal
 *         {deposit} (the vault stays zero-swap), and returns every leftover to the caller.
 *
 *         - Sizing — two-phase "sens" (research/zap-sandwich/findings.md §4, §13): (1) solve the swap targets
 *           at the pre-state `totalTokens()` with the exact constant-liquidity swap inverse on each route's pool
 *           and swap HALF of each; (2) re-read `totalTokens()`, extrapolate the measured shift linearly over
 *           the remaining swap size, re-solve the top-ups on the post-swap pools (fixed point) and swap them.
 *           One-shot sizing is deliberately absent: in a vault whose positions sit in the swap pool it
 *           overshoots into the bought token, and that refund channel lets value bypass `minShares`.
 *         - Residual always lands in the INPUT token (a lossless refund at face value), never in a bought one.
 *         - Swap guards per route: a one-sided spot-vs-TWAP check (bought token no dearer than its TWAP +
 *           `maxDeviationBps` ticks) once before the route's first swap; first-leg `minOut` = TWAP quote ×
 *           (1 − slip) (the adapters' formula); the top-up leg enforces the same bound on the AGGREGATE
 *           (Σout ≥ TWAP quote(Σin) × (1 − slip)), so the two phases share one slippage budget.
 *         - The caller's `minShares` (computed off-chain from {previewZap}) is the user's bound — the zap never
 *           derives it: an in-transaction quote would re-read the state an attacker moved (findings §5).
 *
 *         Oracle-free: no USD, no NAV, no `decimals()` / `symbol()` reads. The only price-like reads are each
 *         route pool's own `slot0` / `liquidity` (sizing) and `observe` (guards) — raw pool units.
 *
 *         Custody: tokens only ever sit in this contract for the duration of {zapDeposit}. Swap outputs go to
 *         this contract (hard-wired), shares go to `receiver`, leftovers go to `msg.sender` (hard-wired). There
 *         is no rescue / sweep / withdraw function: the owner can register vaults and routes, never move funds.
 *
 * @dev Not upgradeable. Not audited. Owner must be a multisig.
 * @custom:security-contact security@mysun.example
 */
contract PoolmigoZapIn is Ownable2Step, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;
    using Math for uint256;

    /*//////////////////////////////////////////////////////////////
                                 TYPES
    //////////////////////////////////////////////////////////////*/

    /// @notice Owner-registered swap route for one ORDERED pair (tokenIn → tokenOut).
    /// @dev `refPool` is both the TWAP reference and the execution pool (it is checked to be the factory's
    ///      canonical pool for (tokenIn, tokenOut, swapFee) — exactly the pool the router derives). `refPool == 0`
    ///      means "no route".
    struct Route {
        address refPool;
        uint24 swapFee;
        uint16 twapWindow;
        uint16 maxSlippageBps;
        uint16 maxDeviationBps;
    }

    /// @dev One output token of a zap: its route, a pool snapshot for sizing, and the running swap totals.
    struct Leg {
        address tokenOut;
        uint256 idx; // index in the vault registry
        IUniswapV3PoolMinimal pool;
        uint24 fee;
        bool zeroForOne; // tokenIn is the pool's token0
        uint16 twapWindow;
        uint16 maxDeviationBps;
        uint16 slip; // effective slippage bps for this leg
        uint160 sqrtPriceX96; // sizing snapshot (slot0)
        uint128 liquidity; // sizing snapshot (in-range liquidity)
        uint160 sqrtTwapX96; // 0 until the route's guard ran (first swap attempt)
        uint256 target; // tokenIn to swap in the current phase
        uint256 phase1; // tokenIn intended for phase 1 (half the pre-state target)
        uint256 cumIn; // tokenIn swapped so far
        uint256 cumOut; // tokenOut received so far (= this leg's offer)
        bool dustSkipped; // a swap was skipped because its minOut floored to 0
    }

    /// @dev Per-call context.
    struct Ctx {
        IPoolmigoZapVault vault;
        address tokenIn;
        uint256 inIdx;
        uint256 budget; // tokenIn received from the caller
        uint256 supply;
        address[] registry;
        uint256[] totals; // T⁰: pre-state totalTokens()
        Leg[] legs;
    }

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error ZapIn__ZeroAddress();
    error ZapIn__NoCode(address account);
    error ZapIn__RouterMismatch(address router);
    error ZapIn__VaultNotRegistered(address vault);
    error ZapIn__VaultAlreadyRegistered(address vault);
    error ZapIn__EmptyBasket(address vault);
    error ZapIn__VaultEmpty(address vault);
    error ZapIn__TokenNotInBasket(address vault, address token);
    error ZapIn__ZeroAmount();
    error ZapIn__ZeroMinShares();
    error ZapIn__SlippageTooLoose(uint16 requestedBps, uint16 maxBps);
    error ZapIn__InvalidRoute(address tokenIn, address tokenOut);
    error ZapIn__PoolMismatch(address pool);
    error ZapIn__CardinalityTooLow(address pool, uint16 cardinality, uint16 twapWindow);
    error ZapIn__TwapWindowOutOfRange(uint16 window, uint16 min, uint16 max);
    error ZapIn__SlippageOutOfRange(uint16 bps, uint16 min, uint16 max);
    error ZapIn__DeviationOutOfRange(uint16 bps, uint16 min, uint16 max);
    error ZapIn__TwapUnavailable(address pool, uint16 window);
    error ZapIn__SpotDeviatesFromTwap(address pool, int24 spotTick, int24 twapTick, uint16 maxDeviationBps);
    error ZapIn__SlippageExceeded(address tokenOut, uint256 amountIn, uint256 minAmountOut);
    error ZapIn__AmountTooSmall(address token);

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    event VaultRegistered(address indexed vault);
    event VaultDisabled(address indexed vault);
    event RouteSet(
        address indexed tokenIn,
        address indexed tokenOut,
        address indexed refPool,
        uint24 swapFee,
        uint16 twapWindow,
        uint16 maxSlippageBps,
        uint16 maxDeviationBps
    );
    event ZapDeposited(
        address indexed caller,
        address indexed vault,
        address indexed tokenIn,
        uint256 amountIn,
        uint256 shares,
        address receiver
    );
    event ZapRefunded(address indexed caller, address indexed token, uint256 amount);

    /*//////////////////////////////////////////////////////////////
                               CONSTANTS
    //////////////////////////////////////////////////////////////*/

    uint256 public constant BPS_DENOMINATOR = 10_000;
    /// @dev Uniswap fee unit (hundredths of a bip).
    uint256 private constant FEE_DENOMINATOR = 1_000_000;
    /// @dev Mirror of the vault's private deposit-side virtual asset offset (VA = 1): the sizing matches `T_i + VA`.
    ///      (The share-side offset VS = 1 left the zap's math with the fix-round dust-rule removal.)
    uint256 private constant VIRTUAL_ASSETS = 1;

    /// @notice TWAP window bounds (seconds). Longer windows lag honest moves (liveness), shorter ones are cheaper
    ///         to lean on (findings §7).
    uint16 public constant MIN_TWAP_WINDOW = 300;
    uint16 public constant MAX_TWAP_WINDOW = 1800;
    uint16 public constant DEFAULT_TWAP_WINDOW = 600;
    /// @notice Route slippage bounds (bps). Below 25 honest reverts are frequent; 10 is the hard floor (T8).
    uint16 public constant MIN_SLIPPAGE_BPS = 10;
    uint16 public constant MAX_SLIPPAGE_BPS = 300;
    uint16 public constant DEFAULT_MAX_SLIPPAGE_BPS = 50;
    /// @notice Pre-swap spot-vs-TWAP deviation bounds (ticks ≈ bps). Same range as the slippage bound.
    uint16 public constant MIN_DEVIATION_BPS = 10;
    uint16 public constant MAX_DEVIATION_BPS = 300;
    uint16 public constant DEFAULT_MAX_DEVIATION_BPS = 50;

    /// @notice Fixed-point passes of the phase-2 sensitivity re-solve (after the plain post-phase-1 solve) — the
    ///         reference's count (research/zap-sandwich/sim.py `range(6)`). The iteration alternates around the
    ///         fixed point (contraction ≈ 0.1/pass on a coupled ±60-tick vault): an EVEN low count can stop on the
    ///         overshoot side (a bought-token refund); 6 lands within rounding of convergence, on the tokenIn side.
    uint256 public constant SENS_PASSES = 6;
    /// @dev Bisection stops once the bracket is <= budget / 2^32 (≈ 2e-6 bps of the budget; at least 1 raw).
    uint256 private constant SOLVE_PRECISION_BITS = 32;
    /// @dev Sentinel for "the pool's in-range liquidity cannot deliver this output".
    uint256 private constant INFEASIBLE = type(uint256).max;

    /*//////////////////////////////////////////////////////////////
                               IMMUTABLES
    //////////////////////////////////////////////////////////////*/

    /// @notice Uniswap UniversalRouter 2.1.x — the only swap venue entry point.
    IUniversalRouter public immutable UNIVERSAL_ROUTER;
    /// @notice Canonical Permit2 — the router pulls swap input through it.
    IPermit2Minimal public immutable PERMIT2;
    /// @notice Uniswap v3 factory the router is wired to (read from `UNIVERSAL_ROUTER.V3_POSITION_MANAGER()`).
    address public immutable FACTORY;

    /*//////////////////////////////////////////////////////////////
                                 STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @notice Owner allowlist of vaults {zapDeposit} may deposit into.
    mapping(address vault => bool) public isVaultRegistered;
    /// @notice One route per ordered pair (tokenIn → tokenOut). `refPool == 0` = no route.
    mapping(address tokenIn => mapping(address tokenOut => Route)) public routes;

    /*//////////////////////////////////////////////////////////////
                               CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /// @dev Wiring checks mirror the adapters': router and Permit2 have code, and the router's own
    ///      `V3_POSITION_MANAGER()` answers a `factory()` that has code — that factory is the anchor every route
    ///      pool is checked against. A router wired to another chain (e.g. the mainnet copy on RHC) fails typed.
    /// @param ur UniversalRouter 2.1.x.
    /// @param permit2 Canonical Permit2.
    /// @param owner_ Registry admin (multisig).
    constructor(address ur, address permit2, address owner_) Ownable(owner_) {
        if (ur == address(0) || permit2 == address(0)) {
            revert ZapIn__ZeroAddress();
        }
        if (ur.code.length == 0) {
            revert ZapIn__NoCode(ur);
        }
        if (permit2.code.length == 0) {
            revert ZapIn__NoCode(permit2);
        }
        address factory = _factoryOf(_positionManagerOf(ur));
        if (factory == address(0) || factory.code.length == 0) {
            revert ZapIn__RouterMismatch(ur);
        }
        UNIVERSAL_ROUTER = IUniversalRouter(ur);
        PERMIT2 = IPermit2Minimal(permit2);
        FACTORY = factory;
    }

    /*//////////////////////////////////////////////////////////////
                              USER ENTRY POINT
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Deposit `amountIn` of ONE basket token into `vault`; the zap buys the other basket tokens in the
     *         vault's current ratio, deposits in kind and refunds every leftover to the caller.
     * @dev Flow: validate → pull → read `totalTokens()` → sens sizing (phase 1: half of the pre-state targets;
     *      re-read; phase 2: extrapolated top-ups) with the route guards → `vault.deposit` with exact approvals
     *      (zeroed after) → sweep every involved token to `msg.sender`. Excluded from the buy: basket tokens the
     *      vault holds none of (it would pull 0); tokens without a route are offered 0 and the vault admits that
     *      only for T_i == 0 (strict participation — a held token must be offered non-zero). Reverts
     *      `ZapIn__AmountTooSmall` if a leg is skipped as dust (minOut floors to 0) while the vault still holds
     *      that token.
     * @param vault Registered MySun vault.
     * @param tokenIn A CURRENT basket token of `vault`; pulled from `msg.sender` (approve the zap once).
     * @param amountIn Amount of `tokenIn` to zap (non-zero).
     * @param minShares Caller's bound on shares minted (non-zero; set off-chain from {previewZap} × (1 − τ)).
     * @param slippageBps 0 = each route's `maxSlippageBps`; else it must be <= every basket route's
     *        `maxSlippageBps` from `tokenIn` (it can only tighten).
     * @param receiver Shares recipient. Refunds always go to `msg.sender`.
     * @return shares Shares minted to `receiver`.
     * @return refunded Amount returned to `msg.sender` per registry token (aligned to `vault.tokens()`).
     */
    function zapDeposit(
        address vault,
        address tokenIn,
        uint256 amountIn,
        uint256 minShares,
        uint16 slippageBps,
        address receiver
    ) external nonReentrant returns (uint256 shares, uint256[] memory refunded) {
        // 1. validate
        if (receiver == address(0)) {
            revert ZapIn__ZeroAddress();
        }
        if (minShares == 0) {
            revert ZapIn__ZeroMinShares();
        }
        _validate(vault, tokenIn, amountIn, slippageBps);

        // 2. pull (balance delta: sizing never counts anything but what the caller sent)
        uint256 balBefore = IERC20(tokenIn).balanceOf(address(this));
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        uint256 received = IERC20(tokenIn).balanceOf(address(this)) - balBefore;

        // 3. read the pre-state
        Ctx memory c = _load(vault, tokenIn, received, slippageBps);

        // 4 + 5. sens sizing, guarded swaps
        _swapPhase1(c);
        _swapPhase2(c);

        // 6. deposit
        shares = _deposit(c, minShares, receiver);

        // 7. sweep
        refunded = _sweep(c);
        emit ZapDeposited(msg.sender, vault, tokenIn, amountIn, shares, receiver);
    }

    /*//////////////////////////////////////////////////////////////
                               VIEW (FE QUOTE)
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Quote a zap at the current state: the offer vector, the shares the vault would mint for it and the
     *         expected refunds. Pure view — one-shot constant-liquidity outputs at the PRE-state composition
     *         (the sens flow lands within ~0.1 bps of this; findings T1 "view err").
     * @dev Reverts where {zapDeposit} would for pre-state reasons (registry, basket, slippage bound, TWAP
     *      unavailable, spot deviation, dust leg, vault rules). The FE sets `minShares = expectedShares × (1 − τ)`
     *      (τ default 25 bps) and re-quotes immediately before signing.
     * @return tokens Vault registry order.
     * @return offers Expected offer per token (tokenIn kept + bought outputs), aligned to `tokens`.
     * @return expectedShares Shares `vault.previewDeposit` returns for `offers`.
     * @return expectedRefunds `offers − required` per token, aligned to `tokens`.
     */
    function previewZap(address vault, address tokenIn, uint256 amountIn, uint16 slippageBps)
        external
        view
        returns (
            address[] memory tokens,
            uint256[] memory offers,
            uint256 expectedShares,
            uint256[] memory expectedRefunds
        )
    {
        _validate(vault, tokenIn, amountIn, slippageBps);
        Ctx memory c = _load(vault, tokenIn, amountIn, slippageBps);
        _solve(c.legs, amountIn, c.totals, c.inIdx);

        tokens = c.registry;
        offers = new uint256[](tokens.length);
        uint256 spent;
        for (uint256 l; l < c.legs.length; ++l) {
            Leg memory leg = c.legs[l];
            uint256 s = leg.target;
            if (s == 0) {
                continue;
            }
            _guardRoute(leg);
            if (_quote(s, leg.sqrtTwapX96, leg.zeroForOne).mulDiv(BPS_DENOMINATOR - leg.slip, BPS_DENOMINATOR) == 0) {
                leg.dustSkipped = true;
                continue;
            }
            leg.cumOut = _outForIn(leg.sqrtPriceX96, leg.liquidity, leg.fee, leg.zeroForOne, s);
            offers[leg.idx] = leg.cumOut;
            spent += s;
        }
        offers[c.inIdx] = amountIn - spent;
        _requireDustOptional(c, offers, c.totals);

        (address[] memory dTokens, uint256[] memory dOffers) = _compact(tokens, offers);
        uint256[] memory required;
        (expectedShares, required) = c.vault.previewDeposit(dTokens, dOffers);
        expectedRefunds = new uint256[](tokens.length);
        uint256 k;
        for (uint256 j; j < tokens.length; ++j) {
            if (offers[j] != 0) {
                expectedRefunds[j] = offers[j] - required[k++];
            }
        }
    }

    /*//////////////////////////////////////////////////////////////
                           OWNER REGISTRY
    //////////////////////////////////////////////////////////////*/

    /// @notice Allow {zapDeposit} into `vault`. Its `tokens()` must answer a non-empty basket.
    function registerVault(address vault) external onlyOwner {
        if (vault == address(0)) {
            revert ZapIn__ZeroAddress();
        }
        if (vault.code.length == 0) {
            revert ZapIn__NoCode(vault);
        }
        if (isVaultRegistered[vault]) {
            revert ZapIn__VaultAlreadyRegistered(vault);
        }
        (bool ok, bytes memory ret) = vault.staticcall(abi.encodeCall(IPoolmigoZapVault.tokens, ()));
        if (!ok || ret.length < 64 || abi.decode(ret, (address[])).length == 0) {
            revert ZapIn__EmptyBasket(vault);
        }
        isVaultRegistered[vault] = true;
        emit VaultRegistered(vault);
    }

    /// @notice Remove `vault` from the allowlist (no funds are ever held for it).
    function disableVault(address vault) external onlyOwner {
        if (!isVaultRegistered[vault]) {
            revert ZapIn__VaultNotRegistered(vault);
        }
        isVaultRegistered[vault] = false;
        emit VaultDisabled(vault);
    }

    /**
     * @notice Set (or overwrite) the route for the ordered pair `tokenIn → tokenOut`.
     * @dev `refPool` must be the factory's canonical pool for (tokenIn, tokenOut, swapFee) — checked through the
     *      pool's own `factory()` / `token0()` / `token1()` / `fee()` and `FACTORY.getPool` — so the TWAP reference
     *      IS the pool the router trades on. Pick the deepest venue for the pair. Its oracle ring must be longer
     *      than the window (`observationCardinality > twapWindow`): v3 writes at most one observation per
     *      second, so a shorter ring lets dust tick-flips make `observe` revert every zap (findings T7d).
     *      A zero parameter selects its default (600 s / 50 bps / 50 bps).
     * @param tokenIn Input token of the swap (the zap's `tokenIn`).
     * @param tokenOut Basket token bought.
     * @param swapFee v3 fee tier of `refPool`.
     * @param refPool Execution + TWAP reference pool.
     * @param twapWindow Seconds, [MIN_TWAP_WINDOW, MAX_TWAP_WINDOW] (0 = default).
     * @param maxSlippageBps Max output haircut vs the TWAP quote, [MIN_SLIPPAGE_BPS, MAX_SLIPPAGE_BPS] (0 = default).
     * @param maxDeviationBps Max adverse spot-vs-TWAP gap in ticks before the first swap,
     *        [MIN_DEVIATION_BPS, MAX_DEVIATION_BPS] (0 = default).
     */
    function setRoute(
        address tokenIn,
        address tokenOut,
        uint24 swapFee,
        address refPool,
        uint16 twapWindow,
        uint16 maxSlippageBps,
        uint16 maxDeviationBps
    ) external onlyOwner {
        Route memory r = Route({
            refPool: refPool,
            swapFee: swapFee,
            twapWindow: twapWindow == 0 ? DEFAULT_TWAP_WINDOW : twapWindow,
            maxSlippageBps: maxSlippageBps == 0 ? DEFAULT_MAX_SLIPPAGE_BPS : maxSlippageBps,
            maxDeviationBps: maxDeviationBps == 0 ? DEFAULT_MAX_DEVIATION_BPS : maxDeviationBps
        });
        _checkRouteParams(r);
        _checkRoutePool(tokenIn, tokenOut, r);
        routes[tokenIn][tokenOut] = r;
        emit RouteSet(tokenIn, tokenOut, refPool, swapFee, r.twapWindow, r.maxSlippageBps, r.maxDeviationBps);
    }

    /*//////////////////////////////////////////////////////////////
                       INTERNAL STATE-CHANGING FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @dev Phase 1: solve at the pre-state (T⁰, pre-swap pools) and swap HALF of each target.
    function _swapPhase1(Ctx memory c) internal {
        _solve(c.legs, c.budget, c.totals, c.inIdx);
        uint256 n = c.legs.length;
        for (uint256 l; l < n; ++l) {
            c.legs[l].phase1 = c.legs[l].target / 2;
        }
        for (uint256 l; l < n; ++l) {
            _swapLeg(c, c.legs[l], c.legs[l].phase1);
        }
    }

    /// @dev Phase 2: re-read `totalTokens()` (T¹), re-snapshot the pools, solve the top-ups against the remaining
    ///      tokenIn with the phase-1 outputs already held, then SENS_PASSES fixed-point passes extrapolating
    ///      T(λ) = T¹ + (T¹ − T⁰)·λ with λ = Σ top-up / Σ phase-1 (the measured sensitivity of the vault's read to
    ///      the zap's own swaps — non-zero when its positions sit in the swap pools). Then swap the top-ups.
    function _swapPhase2(Ctx memory c) internal {
        uint256 n = c.legs.length;
        if (n == 0) {
            return;
        }
        (, uint256[] memory t1) = c.vault.totalTokens();
        uint256 phase1Total;
        uint256 remaining = c.budget;
        for (uint256 l; l < n; ++l) {
            phase1Total += c.legs[l].phase1;
            remaining -= c.legs[l].cumIn;
        }
        if (phase1Total == 0) {
            phase1Total = 1;
        }
        _snapshotPools(c.legs);
        _solve(c.legs, remaining, t1, c.inIdx);
        for (uint256 p; p < SENS_PASSES; ++p) {
            uint256 topTotal;
            for (uint256 l; l < n; ++l) {
                topTotal += c.legs[l].target;
            }
            _solve(c.legs, remaining, _extrapolate(c.totals, t1, topTotal, phase1Total), c.inIdx);
        }
        for (uint256 l; l < n; ++l) {
            _swapLeg(c, c.legs[l], c.legs[l].target);
        }
    }

    /**
     * @dev One guarded exact-input swap of `amount` tokenIn on `leg`'s route, output to this contract.
     *      - Before the route's FIRST swap attempt: TWAP read + one-sided deviation check ({_guardRoute}).
     *      - Bound: aggMin = TWAP quote(cumIn + amount) × (1 − slip). First leg: minOut = aggMin (the adapters'
     *        per-swap formula); later leg: minOut = aggMin − cumOut, floored at 1 wei (the aggregate bound —
     *        never re-charging the budget, never an unbounded swap).
     *      - aggMin == 0 → dust: skipped (never an unbounded swap); {_deposit} decides if that is acceptable.
     *      - Router min-out failure → `ZapIn__SlippageExceeded`; the balance delta is re-checked here.
     */
    function _swapLeg(Ctx memory c, Leg memory leg, uint256 amount) internal {
        uint256 available = c.budget - _spentIn(c.legs);
        if (amount > available) {
            amount = available;
        }
        if (amount == 0) {
            return;
        }
        if (leg.sqrtTwapX96 == 0) {
            _guardRoute(leg);
        }
        uint256 aggMin = _quote(leg.cumIn + amount, leg.sqrtTwapX96, leg.zeroForOne)
            .mulDiv(BPS_DENOMINATOR - leg.slip, BPS_DENOMINATOR);
        if (aggMin == 0) {
            leg.dustSkipped = true;
            return;
        }
        uint256 minOut = leg.cumIn == 0 ? aggMin : (aggMin > leg.cumOut + 1 ? aggMin - leg.cumOut : 1);

        IERC20 tokenIn = IERC20(c.tokenIn);
        IERC20 tokenOut = IERC20(leg.tokenOut);
        (bytes memory commands, bytes[] memory inputs) = UniversalRouterCodec.v3ExactInSingle(
            address(this), amount, minOut, address(tokenIn), leg.fee, address(tokenOut)
        );
        uint256 outBefore = tokenOut.balanceOf(address(this));
        _approvePermit2(tokenIn, amount);
        try UNIVERSAL_ROUTER.execute(commands, inputs, block.timestamp) {}
        catch (bytes memory reason) {
            if (UniversalRouterCodec.isTooLittleReceived(reason)) {
                revert ZapIn__SlippageExceeded(address(tokenOut), amount, minOut);
            }
            assembly ("memory-safe") {
                revert(add(reason, 0x20), mload(reason))
            }
        }
        _revokePermit2(tokenIn);
        uint256 amountOut = tokenOut.balanceOf(address(this)) - outBefore;
        if (amountOut < minOut) {
            revert ZapIn__SlippageExceeded(address(tokenOut), amount, minOut);
        }
        leg.cumIn += amount;
        leg.cumOut += amountOut;
    }

    /// @dev Offer = tokenIn left + each leg's output; exact approvals to the vault, `deposit`, approvals zeroed.
    ///      The vault pulls only `required_i <= offer_i`; the rest stays here for {_sweep}.
    function _deposit(Ctx memory c, uint256 minShares, address receiver) internal returns (uint256 shares) {
        uint256 m = c.registry.length;
        uint256[] memory offers = new uint256[](m);
        offers[c.inIdx] = c.budget - _spentIn(c.legs);
        bool anySkipped;
        for (uint256 l; l < c.legs.length; ++l) {
            Leg memory leg = c.legs[l];
            offers[leg.idx] = leg.cumOut;
            if (leg.dustSkipped && leg.cumOut == 0) {
                anySkipped = true;
            }
        }
        if (anySkipped) {
            (, uint256[] memory totalsNow) = c.vault.totalTokens();
            _requireDustOptional(c, offers, totalsNow);
        }

        (address[] memory dTokens, uint256[] memory dOffers) = _compact(c.registry, offers);
        address vault = address(c.vault);
        for (uint256 i; i < dTokens.length; ++i) {
            IERC20(dTokens[i]).forceApprove(vault, dOffers[i]);
        }
        shares = c.vault.deposit(dTokens, dOffers, minShares, receiver);
        for (uint256 i; i < dTokens.length; ++i) {
            IERC20(dTokens[i]).forceApprove(vault, 0);
        }
    }

    /// @dev Everything this contract holds of tokenIn and every leg's token goes to `msg.sender` — the whole
    ///      balance, so the post-condition is zero residue (a token sent here outside a zap would leave with the
    ///      next zap's caller; sizing itself only ever uses the amount the caller sent).
    function _sweep(Ctx memory c) internal returns (uint256[] memory refunded) {
        refunded = new uint256[](c.registry.length);
        refunded[c.inIdx] = _refund(c.tokenIn);
        for (uint256 l; l < c.legs.length; ++l) {
            refunded[c.legs[l].idx] = _refund(c.legs[l].tokenOut);
        }
    }

    function _refund(address token) internal returns (uint256 amount) {
        amount = IERC20(token).balanceOf(address(this));
        if (amount != 0) {
            IERC20(token).safeTransfer(msg.sender, amount);
            emit ZapRefunded(msg.sender, token, amount);
        }
    }

    /// @dev ERC20 allowance to Permit2 + a Permit2 allowance to the router, both exactly `amount` and the latter
    ///      expiring this block — the router's Permit2 `transferFrom` pulls the swap input through them.
    function _approvePermit2(IERC20 token, uint256 amount) internal {
        token.forceApprove(address(PERMIT2), amount);
        PERMIT2.approve(address(token), address(UNIVERSAL_ROUTER), SafeCast.toUint160(amount), uint48(block.timestamp));
    }

    /// @dev Never leave a standing allowance: both layers back to 0.
    function _revokePermit2(IERC20 token) internal {
        PERMIT2.approve(address(token), address(UNIVERSAL_ROUTER), 0, 0);
        token.forceApprove(address(PERMIT2), 0);
    }

    /*//////////////////////////////////////////////////////////////
                         INTERNAL READ-ONLY FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @dev Step-1 checks shared by {zapDeposit} and {previewZap}: registered vault, non-zero amount, `tokenIn` in
    ///      the CURRENT basket, and `slippageBps` no looser than any of the basket's routes from `tokenIn`.
    function _validate(address vault, address tokenIn, uint256 amountIn, uint16 slippageBps) internal view {
        if (!isVaultRegistered[vault]) {
            revert ZapIn__VaultNotRegistered(vault);
        }
        if (amountIn == 0) {
            revert ZapIn__ZeroAmount();
        }
        address[] memory basket = IPoolmigoZapVault(vault).tokens();
        bool found;
        for (uint256 j; j < basket.length; ++j) {
            if (basket[j] == tokenIn) {
                found = true;
                continue;
            }
            Route storage r = routes[tokenIn][basket[j]];
            if (r.refPool != address(0) && slippageBps > r.maxSlippageBps) {
                revert ZapIn__SlippageTooLoose(slippageBps, r.maxSlippageBps);
            }
        }
        if (!found) {
            revert ZapIn__TokenNotInBasket(vault, tokenIn);
        }
    }

    /// @dev Pre-state read (step 3) + the legs: every basket token other than `tokenIn` with T⁰ > 0 AND a route.
    ///      T⁰ == 0 tokens are excluded (the vault pulls 0 of them); route-less tokens are offered 0.
    function _load(address vault, address tokenIn, uint256 budget, uint16 slippageBps)
        internal
        view
        returns (Ctx memory c)
    {
        c.vault = IPoolmigoZapVault(vault);
        c.tokenIn = tokenIn;
        c.budget = budget;
        (c.registry, c.totals) = c.vault.totalTokens();
        c.supply = c.vault.totalSupply();
        if (c.supply == 0) {
            revert ZapIn__VaultEmpty(vault);
        }
        uint256 m = c.registry.length;
        uint256 count;
        for (uint256 j; j < m; ++j) {
            address t = c.registry[j];
            if (t == tokenIn) {
                c.inIdx = j;
            } else if (c.totals[j] != 0 && routes[tokenIn][t].refPool != address(0)) {
                ++count;
            }
        }
        c.legs = new Leg[](count);
        uint256 l;
        for (uint256 j; j < m; ++j) {
            address t = c.registry[j];
            if (t == tokenIn || c.totals[j] == 0) {
                continue;
            }
            Route memory r = routes[tokenIn][t];
            if (r.refPool == address(0)) {
                continue;
            }
            Leg memory leg = c.legs[l++];
            leg.tokenOut = t;
            leg.idx = j;
            leg.pool = IUniswapV3PoolMinimal(r.refPool);
            leg.fee = r.swapFee;
            leg.zeroForOne = tokenIn < t;
            leg.twapWindow = r.twapWindow;
            leg.maxDeviationBps = r.maxDeviationBps;
            leg.slip = slippageBps == 0 ? r.maxSlippageBps : slippageBps;
        }
        _snapshotPools(c.legs);
    }

    /// @dev Sizing snapshot: each route pool's spot sqrt price and in-range liquidity.
    function _snapshotPools(Leg[] memory legs) internal view {
        for (uint256 l; l < legs.length; ++l) {
            (uint160 sqrtPriceX96,,,,,,) = legs[l].pool.slot0();
            legs[l].sqrtPriceX96 = sqrtPriceX96;
            legs[l].liquidity = legs[l].pool.liquidity();
        }
    }

    /// @dev Route guard, once per route before its first swap: TWAP tick (typed revert if the oracle cannot serve
    ///      the window) and the ONE-SIDED deviation check — revert if the bought token's spot is dearer than its
    ///      TWAP by more than `maxDeviationBps` ticks (buying token0 is adverse when spot tick > TWAP tick; buying
    ///      token1 when spot tick < TWAP tick). The favourable side adds no security. Caches the TWAP sqrt price.
    function _guardRoute(Leg memory leg) internal view {
        int24 twapTick_ = _twapTick(leg.pool, leg.twapWindow);
        (, int24 spotTick,,,,,) = leg.pool.slot0();
        int256 adverse = leg.zeroForOne
            ? int256(twapTick_) - int256(spotTick)  // buying token1
            : int256(spotTick) - int256(twapTick_); // buying token0
        if (adverse > int256(uint256(leg.maxDeviationBps))) {
            revert ZapIn__SpotDeviatesFromTwap(address(leg.pool), spotTick, twapTick_, leg.maxDeviationBps);
        }
        leg.sqrtTwapX96 = TickMath.getSqrtRatioAtTick(twapTick_);
    }

    /**
     * @dev Sizing solve (findings §4 "impact" inverse). Finds the largest tokenIn keep `k` in [0, budget] with
     *      k + Σ_l s_l(k) <= budget, where s_l(k) is the exact constant-L input for the output
     *      w_l(k) = k·(T_l + VA)/(T_in + VA) − have_l (have = output already held) — i.e. the offer vector in the
     *      ratio (T_i + VA) that spends the budget. Bisection on k (spend is monotone in k), stopping at a bracket
     *      of budget / 2^32; taking the LOWER end means any slack stays in tokenIn (never an overshoot into a
     *      bought token). Writes each leg's `target` = s_l(k). Tokens with T_l == 0 get target 0.
     */
    function _solve(Leg[] memory legs, uint256 budget, uint256[] memory totals, uint256 inIdx) internal pure {
        uint256 wIn = totals[inIdx] + VIRTUAL_ASSETS;
        uint256 lo;
        uint256 hi = budget;
        if (_spendAt(legs, hi, wIn, totals, false) <= budget) {
            lo = hi;
        } else {
            uint256 tol = budget >> SOLVE_PRECISION_BITS;
            if (tol == 0) {
                tol = 1;
            }
            while (hi - lo > tol) {
                uint256 mid = lo + (hi - lo) / 2;
                if (_spendAt(legs, mid, wIn, totals, false) <= budget) {
                    lo = mid;
                } else {
                    hi = mid;
                }
            }
        }
        _spendAt(legs, lo, wIn, totals, true);
    }

    /// @dev k + Σ s_l(k) (INFEASIBLE if a pool cannot deliver). With `write`, stores s_l(k) in `target`.
    function _spendAt(Leg[] memory legs, uint256 k, uint256 wIn, uint256[] memory totals, bool write)
        internal
        pure
        returns (uint256 total)
    {
        total = k;
        for (uint256 l; l < legs.length; ++l) {
            Leg memory leg = legs[l];
            uint256 t = totals[leg.idx];
            uint256 s;
            if (t != 0) {
                uint256 want = k.mulDiv(t + VIRTUAL_ASSETS, wIn);
                if (want > leg.cumOut) {
                    s = _inForOut(leg.sqrtPriceX96, leg.liquidity, leg.fee, leg.zeroForOne, want - leg.cumOut);
                }
            }
            if (write) {
                leg.target = s;
            }
            if (s == INFEASIBLE || s > INFEASIBLE - total) {
                return INFEASIBLE;
            }
            total += s;
        }
    }

    /**
     * @dev Exact inverse of a constant-liquidity (current tick range) exact-input swap: the gross input for `w`
     *      output, fee on input, rounded up. With √P = sqrtP / 2^96:
     *      - token1 → token0 (price up):   s = L·(1/(1/√P − w/L) − √P) / (1 − fee)
     *      - token0 → token1 (price down): s = L·(1/(√P − w/L) − 1/√P) / (1 − fee)
     *      INFEASIBLE if the range's liquidity cannot deliver `w` (or the price would leave the tick domain).
     */
    function _inForOut(uint160 sqrtPriceX96, uint128 liquidity, uint24 fee, bool zeroForOne, uint256 w)
        internal
        pure
        returns (uint256)
    {
        if (w == 0) {
            return 0;
        }
        if (liquidity == 0 || sqrtPriceX96 == 0) {
            return INFEASIBLE;
        }
        uint256 sp = sqrtPriceX96;
        uint256 numerator1 = uint256(liquidity) << FixedPoint96.RESOLUTION;
        uint256 net;
        if (zeroForOne) {
            // √P falls by ⌈w·2^96/L⌉; token0 in = L·2^96·(√P − √P')/(√P·√P').
            if (w >= sp.mulDiv(liquidity, FixedPoint96.Q96)) {
                return INFEASIBLE;
            }
            uint256 delta = w.mulDiv(FixedPoint96.Q96, liquidity, Math.Rounding.Ceil);
            if (delta >= sp || sp - delta < TickMath.MIN_SQRT_RATIO) {
                return INFEASIBLE;
            }
            uint256 spNext = sp - delta;
            net = Math.ceilDiv(numerator1.mulDiv(delta, spNext, Math.Rounding.Ceil), sp);
        } else {
            // √P' = L·2^96·√P / (L·2^96 − w·√P); token1 in = L·(√P' − √P)/2^96.
            if (w >= numerator1 / sp) {
                return INFEASIBLE;
            }
            uint256 spNext = numerator1.mulDiv(sp, numerator1 - w * sp, Math.Rounding.Ceil);
            if (spNext >= TickMath.MAX_SQRT_RATIO) {
                return INFEASIBLE;
            }
            net = uint256(liquidity).mulDiv(spNext - sp, FixedPoint96.Q96, Math.Rounding.Ceil);
        }
        return net.mulDiv(FEE_DENOMINATOR, FEE_DENOMINATOR - fee, Math.Rounding.Ceil);
    }

    /// @dev Forward constant-liquidity exact-input output (v3 swap-step math within the current range, rounded
    ///      down) — the {previewZap} estimate of what `amountIn` buys at the pre-state.
    function _outForIn(uint160 sqrtPriceX96, uint128 liquidity, uint24 fee, bool zeroForOne, uint256 amountIn)
        internal
        pure
        returns (uint256)
    {
        uint256 net = amountIn.mulDiv(FEE_DENOMINATOR - fee, FEE_DENOMINATOR);
        if (net == 0 || liquidity == 0 || sqrtPriceX96 == 0) {
            return 0;
        }
        uint256 sp = sqrtPriceX96;
        uint256 numerator1 = uint256(liquidity) << FixedPoint96.RESOLUTION;
        if (zeroForOne) {
            uint256 spNext = Math.ceilDiv(numerator1, numerator1 / sp + net);
            return uint256(liquidity).mulDiv(sp - spNext, FixedPoint96.Q96);
        }
        uint256 spUp = sp + net.mulDiv(FixedPoint96.Q96, liquidity);
        return numerator1.mulDiv(spUp - sp, spUp) / sp;
    }

    /// @dev T(λ) = T¹ + (T¹ − T⁰)·λ per token, λ = num/den, the shift truncated toward zero, floored at 0.
    function _extrapolate(uint256[] memory t0, uint256[] memory t1, uint256 num, uint256 den)
        internal
        pure
        returns (uint256[] memory tl)
    {
        uint256 m = t1.length;
        tl = new uint256[](m);
        for (uint256 j; j < m; ++j) {
            if (t1[j] >= t0[j]) {
                tl[j] = t1[j] + (t1[j] - t0[j]).mulDiv(num, den);
            } else {
                uint256 drop = (t0[j] - t1[j]).mulDiv(num, den);
                tl[j] = drop >= t1[j] ? 0 : t1[j] - drop;
            }
        }
    }

    /**
     * @dev Skipped-leg admissibility (findings T11b; strict participation, fix round): a leg skipped because
     *      its minOut floored to 0 leaves that token un-offered. The vault admits that only when it holds
     *      none of the token (T_i == 0 pulls 0 — K-14); a held token must be offered non-zero, so revert
     *      `ZapIn__AmountTooSmall` here instead of the vault's generic error.
     */
    function _requireDustOptional(Ctx memory c, uint256[] memory offers, uint256[] memory totals) internal pure {
        for (uint256 l; l < c.legs.length; ++l) {
            Leg memory leg = c.legs[l];
            if (!leg.dustSkipped || offers[leg.idx] != 0 || totals[leg.idx] == 0) {
                continue;
            }
            // A held token (T_i > 0) can no longer ride on the floor-draw exemption: the vault's deposit
            // would revert MissingBasketToken; fail early with the typed error instead.
            revert ZapIn__AmountTooSmall(leg.tokenOut);
        }
    }

    /// @dev Registry-aligned offers → the non-zero (tokens, amounts) the vault is offered.
    function _compact(address[] memory registry, uint256[] memory offers)
        internal
        pure
        returns (address[] memory t, uint256[] memory a)
    {
        uint256 n;
        for (uint256 j; j < offers.length; ++j) {
            if (offers[j] != 0) {
                ++n;
            }
        }
        t = new address[](n);
        a = new uint256[](n);
        uint256 k;
        for (uint256 j; j < offers.length; ++j) {
            if (offers[j] != 0) {
                t[k] = registry[j];
                a[k++] = offers[j];
            }
        }
    }

    function _spentIn(Leg[] memory legs) internal pure returns (uint256 spent) {
        for (uint256 l; l < legs.length; ++l) {
            spent += legs[l].cumIn;
        }
    }

    /// @dev Arithmetic-mean tick over `window`, rounded toward negative infinity (Uniswap convention). The pool
    ///      reverts ("OLD") when its history is shorter than the window — surfaced typed, never a spot fallback.
    function _twapTick(IUniswapV3PoolMinimal pool, uint16 window) internal view returns (int24 meanTick) {
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = window;
        try pool.observe(secondsAgos) returns (int56[] memory tickCumulatives, uint160[] memory) {
            int56 delta = tickCumulatives[1] - tickCumulatives[0];
            int56 windowI56 = int56(uint56(window));
            meanTick = int24(delta / windowI56);
            if (delta < 0 && delta % windowI56 != 0) {
                meanTick--;
            }
        } catch {
            revert ZapIn__TwapUnavailable(address(pool), window);
        }
    }

    /// @dev Convert `amountIn` of one pool token into the other at `sqrtPriceX96` (no fee). Mirrors
    ///      OracleLibrary.getQuoteAtTick (and the adapters' `_quote`): Q192 ratio when it fits, else Q128.
    function _quote(uint256 amountIn, uint160 sqrtPriceX96, bool zeroForOne) internal pure returns (uint256) {
        if (amountIn == 0) {
            return 0;
        }
        if (sqrtPriceX96 <= type(uint128).max) {
            uint256 ratioX192 = uint256(sqrtPriceX96) * sqrtPriceX96;
            return zeroForOne ? amountIn.mulDiv(ratioX192, 1 << 192) : amountIn.mulDiv(1 << 192, ratioX192);
        }
        uint256 ratioX128 = Math.mulDiv(sqrtPriceX96, sqrtPriceX96, 1 << 64);
        return zeroForOne ? amountIn.mulDiv(ratioX128, 1 << 128) : amountIn.mulDiv(1 << 128, ratioX128);
    }

    function _checkRouteParams(Route memory r) internal pure {
        if (r.twapWindow < MIN_TWAP_WINDOW || r.twapWindow > MAX_TWAP_WINDOW) {
            revert ZapIn__TwapWindowOutOfRange(r.twapWindow, MIN_TWAP_WINDOW, MAX_TWAP_WINDOW);
        }
        if (r.maxSlippageBps < MIN_SLIPPAGE_BPS || r.maxSlippageBps > MAX_SLIPPAGE_BPS) {
            revert ZapIn__SlippageOutOfRange(r.maxSlippageBps, MIN_SLIPPAGE_BPS, MAX_SLIPPAGE_BPS);
        }
        if (r.maxDeviationBps < MIN_DEVIATION_BPS || r.maxDeviationBps > MAX_DEVIATION_BPS) {
            revert ZapIn__DeviationOutOfRange(r.maxDeviationBps, MIN_DEVIATION_BPS, MAX_DEVIATION_BPS);
        }
    }

    /// @dev `refPool` is FACTORY's canonical pool for the pair + fee (so it is the pool the router derives and
    ///      trades on), and its oracle ring is longer than the window.
    function _checkRoutePool(address tokenIn, address tokenOut, Route memory r) internal view {
        if (tokenIn == address(0) || tokenOut == address(0) || r.refPool == address(0)) {
            revert ZapIn__ZeroAddress();
        }
        if (tokenIn == tokenOut) {
            revert ZapIn__InvalidRoute(tokenIn, tokenOut);
        }
        if (r.refPool.code.length == 0) {
            revert ZapIn__NoCode(r.refPool);
        }
        IUniswapV3PoolMinimal pool = IUniswapV3PoolMinimal(r.refPool);
        (address token0, address token1) = tokenIn < tokenOut ? (tokenIn, tokenOut) : (tokenOut, tokenIn);
        if (
            pool.factory() != FACTORY || pool.token0() != token0 || pool.token1() != token1 || pool.fee() != r.swapFee
                || IUniswapV3FactoryMinimal(FACTORY).getPool(token0, token1, r.swapFee) != r.refPool
        ) {
            revert ZapIn__PoolMismatch(r.refPool);
        }
        (,,, uint16 cardinality,,,) = pool.slot0();
        if (cardinality <= r.twapWindow) {
            revert ZapIn__CardinalityTooLow(r.refPool, cardinality, r.twapWindow);
        }
    }

    /// @dev `router.V3_POSITION_MANAGER()`, or address(0) unless it answers exactly one word.
    function _positionManagerOf(address router) internal view returns (address) {
        (bool ok, bytes memory ret) = router.staticcall(abi.encodeCall(IUniversalRouter.V3_POSITION_MANAGER, ()));
        if (!ok || ret.length != 32) {
            return address(0);
        }
        return abi.decode(ret, (address));
    }

    /// @dev `nfpm.factory()`, or address(0) unless it answers exactly one word (a router wired to another chain
    ///      may report an address that is empty or holds unrelated code — both fail typed, not bubble).
    function _factoryOf(address nfpm) internal view returns (address) {
        if (nfpm == address(0)) {
            return address(0);
        }
        (bool ok, bytes memory ret) = nfpm.staticcall(abi.encodeCall(INonfungiblePositionManager.factory, ()));
        if (!ok || ret.length != 32) {
            return address(0);
        }
        return abi.decode(ret, (address));
    }
}
