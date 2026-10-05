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

/// @notice The subset of the MySun vault surface the exit-zap calls (`src/interfaces/IPoolmigoVault.sol` declares
///         events and errors only). Signatures match `PoolmigoVaultUpgradeable`; the shares token is the vault itself.
interface IPoolmigoZapOutVault {
    function tokens() external view returns (address[] memory);
    function totalSupply() external view returns (uint256);
    function previewRedeem(uint256 shares) external view returns (address[] memory tokens_, uint256[] memory owed);
    function redeem(uint256 shares, address receiver)
        external
        returns (address[] memory tokens_, uint256[] memory amounts);
}

/**
 * @title PoolmigoZapOut
 * @author MySun
 * @notice Single-output redemption periphery: a wallet holding the vault's receipt token redeems to ONE basket token
 *         (USDG in practice) in one transaction. The zap redeems the shares in kind through the vault's normal
 *         {redeem} (the vault stays zero-swap), sells every other basket token it received into `tokenOut` through
 *         the UniversalRouter, and delivers everything to `receiver`.
 *
 *         - Redeem first, swap after: the in-kind slice is fixed before any swap, so there is no vault-ratio
 *           feedback and no sizing problem — each non-output token is sold in ONE exact-input swap of the whole
 *           amount received (research/zap-sandwich/findings.md §7–§9 still apply to the swap leg).
 *         - Swap guards per route (same machinery as `PoolmigoZapIn`): a one-sided spot-vs-TWAP check (the token
 *           bought — `tokenOut` — no dearer than its TWAP + `maxDeviationBps` ticks) before the swap, and
 *           `minOut = TWAP quote × (1 − slip)` (the adapters' formula).
 *         - Liveness over purity: a basket token with NO route to `tokenOut`, or whose sale would carry a zero
 *           `minOut` (dust), is passed through in kind to `receiver` — a missing route never blocks an exit.
 *         - The caller's `minAmountOut` (computed off-chain from {previewRedeem}) bounds the TOTAL `tokenOut`
 *           delivered — the zap never derives it (an in-transaction quote would re-read a manipulated state).
 *
 *         Oracle-free: no USD, no NAV, no `decimals()` / `symbol()` reads. The only price-like reads are each route
 *         pool's own `slot0` / `observe` (guards) and `liquidity` (view estimate) — raw pool units.
 *
 *         Custody: shares and tokens only ever sit in this contract for the duration of {zapRedeem}. Shares are
 *         burned through the vault's {redeem}; the in-kind slice and every swap output go to this contract
 *         (hard-wired); the proceeds go to `receiver` (hard-wired). There is no rescue / sweep / withdraw function:
 *         the owner can register vaults and routes, never move funds.
 *
 * @dev Not upgradeable. Not audited. Owner must be a multisig. Sibling of `PoolmigoZapIn` (the registry, guard and
 *      Permit2 helpers are ported from it unchanged; the two contracts share no code).
 * @custom:security-contact security@mysun.example
 */
contract PoolmigoZapOut is Ownable2Step, ReentrancyGuardTransient {
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

    /// @dev One sale of a zap: a basket token sold into `tokenOut` on its route.
    struct Leg {
        address tokenIn; // basket token sold
        IUniswapV3PoolMinimal pool;
        uint24 fee;
        bool zeroForOne; // tokenIn is the pool's token0
        uint16 twapWindow;
        uint16 maxDeviationBps;
        uint16 slip; // effective slippage bps for this leg
        uint160 sqrtTwapX96; // 0 until the route's guard ran
    }

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error ZapOut__ZeroAddress();
    error ZapOut__NoCode(address account);
    error ZapOut__RouterMismatch(address router);
    error ZapOut__VaultNotRegistered(address vault);
    error ZapOut__VaultAlreadyRegistered(address vault);
    error ZapOut__EmptyBasket(address vault);
    error ZapOut__TokenNotInBasket(address vault, address token);
    error ZapOut__ZeroShares();
    error ZapOut__ZeroMinAmountOut();
    error ZapOut__InvalidReceiver(address receiver);
    error ZapOut__SharesExceedSupply(uint256 shares, uint256 supply);
    error ZapOut__SlippageTooLoose(uint16 requestedBps, uint16 maxBps);
    error ZapOut__InvalidRoute(address tokenIn, address tokenOut);
    error ZapOut__PoolMismatch(address pool);
    error ZapOut__CardinalityTooLow(address pool, uint16 cardinality, uint16 twapWindow);
    error ZapOut__TwapWindowOutOfRange(uint16 window, uint16 min, uint16 max);
    error ZapOut__SlippageOutOfRange(uint16 bps, uint16 min, uint16 max);
    error ZapOut__DeviationOutOfRange(uint16 bps, uint16 min, uint16 max);
    error ZapOut__TwapUnavailable(address pool, uint16 window);
    error ZapOut__SpotDeviatesFromTwap(address pool, int24 spotTick, int24 twapTick, uint16 maxDeviationBps);
    error ZapOut__SlippageExceeded(address tokenIn, uint256 amountIn, uint256 minAmountOut);
    error ZapOut__MinAmountOut(uint256 minAmountOut, uint256 amountOut);

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
    /// @param redeemed The in-kind amounts the vault's {redeem} reported (registry order; reporting only — the
    ///        sales are sized on the zap's measured balance deltas).
    event ZapRedeemed(
        address indexed caller,
        address indexed vault,
        address indexed tokenOut,
        uint256 shares,
        uint256 amountOut,
        address receiver,
        uint256[] redeemed
    );
    event ZapSold(
        address indexed caller, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut
    );
    /// @notice `amount` of `token` is delivered in kind (no route to the output token, or a dust sale).
    event ZapPassThrough(address indexed caller, address indexed token, uint256 amount);

    /*//////////////////////////////////////////////////////////////
                               CONSTANTS
    //////////////////////////////////////////////////////////////*/

    uint256 public constant BPS_DENOMINATOR = 10_000;
    /// @dev Uniswap fee unit (hundredths of a bip).
    uint256 private constant FEE_DENOMINATOR = 1_000_000;

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

    /// @notice Owner allowlist of vaults {zapRedeem} may redeem from.
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
            revert ZapOut__ZeroAddress();
        }
        if (ur.code.length == 0) {
            revert ZapOut__NoCode(ur);
        }
        if (permit2.code.length == 0) {
            revert ZapOut__NoCode(permit2);
        }
        address factory = _factoryOf(_positionManagerOf(ur));
        if (factory == address(0) || factory.code.length == 0) {
            revert ZapOut__RouterMismatch(ur);
        }
        UNIVERSAL_ROUTER = IUniversalRouter(ur);
        PERMIT2 = IPermit2Minimal(permit2);
        FACTORY = factory;
    }

    /*//////////////////////////////////////////////////////////////
                              USER ENTRY POINT
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Redeem `shares` of `vault` and deliver the proceeds as `tokenOut` (plus any pass-through token) to
     *         `receiver`: the zap redeems in kind, sells every other basket token it received into `tokenOut` and
     *         sends everything on.
     * @dev Flow: validate → pull the shares → `vault.redeem(shares, this)` → per basket token ≠ `tokenOut` with a
     *      non-zero received amount: no route → pass-through; else route guard, `minOut` = TWAP quote × (1 − slip)
     *      (0 → dust pass-through), one exact-input swap of the whole amount with exact Permit2 approvals (zeroed
     *      after) → aggregate `minAmountOut` check on the `tokenOut` balance → sweep every basket token to
     *      `receiver`. Sale amounts are the zap's measured balance deltas across {redeem}, never the reported ones.
     * @param vault Registered MySun vault (its shares are pulled from `msg.sender`: approve the zap once).
     * @param tokenOut A CURRENT basket token of `vault`; every other basket token with a route is sold into it.
     * @param shares Shares to redeem (non-zero).
     * @param minAmountOut Caller's bound on the TOTAL `tokenOut` delivered (non-zero; set off-chain from
     *        {previewRedeem} × (1 − τ)).
     * @param slippageBps 0 = each route's `maxSlippageBps`; else it must be <= the `maxSlippageBps` of every route
     *        from a basket token into `tokenOut` (it can only tighten).
     * @param receiver Proceeds recipient (the shares always come from `msg.sender`).
     * @return amountOut `tokenOut` delivered to `receiver` (redeemed slice + every sale's output).
     * @return delivered Amount delivered to `receiver` per registry token (aligned to `vault.tokens()`; the
     *         `tokenOut` entry equals `amountOut`, non-zero other entries are pass-throughs).
     */
    function zapRedeem(
        address vault,
        address tokenOut,
        uint256 shares,
        uint256 minAmountOut,
        uint16 slippageBps,
        address receiver
    ) external nonReentrant returns (uint256 amountOut, uint256[] memory delivered) {
        // 1. validate
        if (receiver == address(0)) {
            revert ZapOut__ZeroAddress();
        }
        if (receiver == address(this)) {
            revert ZapOut__InvalidReceiver(receiver);
        }
        if (minAmountOut == 0) {
            revert ZapOut__ZeroMinAmountOut();
        }
        (address[] memory registry, uint256 outIdx) = _validate(vault, tokenOut, shares, slippageBps);

        // 2 + 3 + 4. pull, redeem in kind, sell (or pass through)
        (uint256 pulled, uint256[] memory redeemed) =
            _redeemAndSell(vault, tokenOut, registry, outIdx, shares, slippageBps);

        // 5. aggregate bound
        amountOut = IERC20(tokenOut).balanceOf(address(this));
        if (amountOut < minAmountOut) {
            revert ZapOut__MinAmountOut(minAmountOut, amountOut);
        }

        // 6. sweep
        delivered = _sweep(registry, receiver);
        emit ZapRedeemed(msg.sender, vault, tokenOut, pulled, amountOut, receiver, redeemed);
    }

    /*//////////////////////////////////////////////////////////////
                               VIEW (FE QUOTE)
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Quote a zap-out at the current state: what would be sold, the `tokenOut` expected and what would be
     *         passed through. Pure view — the vault's own {previewRedeem} slice (an UPPER bound on delivery) and a
     *         constant-liquidity output per sale at the route pool's current price and in-range liquidity.
     * @dev Reverts where {zapRedeem} would for pre-state reasons (registry, basket, zero shares, slippage bound,
     *      TWAP unavailable, spot deviation), and `ZapOut__SharesExceedSupply` for more shares than exist. An
     *      estimate, not a promise: delivery rounds down (vault rule), and a real pool may cross ticks or lose the
     *      vault's own liquidity to the redeem. The FE sets `minAmountOut = expectedAmountOut × (1 − τ)` and
     *      re-quotes immediately before signing.
     * @return tokens Vault registry order.
     * @return expectedSold Amount of each token the zap would sell (0 for `tokenOut` and pass-throughs).
     * @return expectedAmountOut `tokenOut` expected: its redeemed slice + every sale's estimated output.
     * @return expectedPassThrough Amount of each token delivered in kind (no route, or a dust sale).
     */
    function previewRedeem(address vault, address tokenOut, uint256 shares, uint16 slippageBps)
        external
        view
        returns (
            address[] memory tokens,
            uint256[] memory expectedSold,
            uint256 expectedAmountOut,
            uint256[] memory expectedPassThrough
        )
    {
        uint256 outIdx;
        (tokens, outIdx) = _validate(vault, tokenOut, shares, slippageBps);
        uint256 supply = IPoolmigoZapOutVault(vault).totalSupply();
        if (shares > supply) {
            revert ZapOut__SharesExceedSupply(shares, supply);
        }
        (, uint256[] memory owed) = IPoolmigoZapOutVault(vault).previewRedeem(shares);

        uint256 m = tokens.length;
        expectedSold = new uint256[](m);
        expectedPassThrough = new uint256[](m);
        expectedAmountOut = owed[outIdx];
        for (uint256 j; j < m; ++j) {
            if (j == outIdx || owed[j] == 0) {
                continue;
            }
            uint256 out = _previewSale(tokens[j], tokenOut, owed[j], slippageBps);
            if (out == type(uint256).max) {
                expectedPassThrough[j] = owed[j];
            } else {
                expectedSold[j] = owed[j];
                expectedAmountOut += out;
            }
        }
    }

    /*//////////////////////////////////////////////////////////////
                           OWNER REGISTRY
    //////////////////////////////////////////////////////////////*/

    /// @notice Allow {zapRedeem} from `vault`. Its `tokens()` must answer a non-empty basket.
    function registerVault(address vault) external onlyOwner {
        if (vault == address(0)) {
            revert ZapOut__ZeroAddress();
        }
        if (vault.code.length == 0) {
            revert ZapOut__NoCode(vault);
        }
        if (isVaultRegistered[vault]) {
            revert ZapOut__VaultAlreadyRegistered(vault);
        }
        (bool ok, bytes memory ret) = vault.staticcall(abi.encodeCall(IPoolmigoZapOutVault.tokens, ()));
        if (!ok || ret.length < 64 || abi.decode(ret, (address[])).length == 0) {
            revert ZapOut__EmptyBasket(vault);
        }
        isVaultRegistered[vault] = true;
        emit VaultRegistered(vault);
    }

    /// @notice Remove `vault` from the allowlist (no funds are ever held for it).
    function disableVault(address vault) external onlyOwner {
        if (!isVaultRegistered[vault]) {
            revert ZapOut__VaultNotRegistered(vault);
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
     * @param tokenIn Basket token sold (e.g. WETH).
     * @param tokenOut Output token bought (e.g. USDG).
     * @param swapFee v3 fee tier of `refPool`.
     * @param refPool Execution + TWAP reference pool.
     * @param twapWindow Seconds, [MIN_TWAP_WINDOW, MAX_TWAP_WINDOW] (0 = default).
     * @param maxSlippageBps Max output haircut vs the TWAP quote, [MIN_SLIPPAGE_BPS, MAX_SLIPPAGE_BPS] (0 = default).
     * @param maxDeviationBps Max adverse spot-vs-TWAP gap in ticks before the swap,
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

    /// @dev Steps 2–4: pull `shares` from `msg.sender` (the balance delta is what gets redeemed), redeem in kind to
    ///      this contract, then sell every non-output token received — or pass it through.
    function _redeemAndSell(
        address vault,
        address tokenOut,
        address[] memory registry,
        uint256 outIdx,
        uint256 shares,
        uint16 slippageBps
    ) internal returns (uint256 pulled, uint256[] memory redeemed) {
        IERC20 shareToken = IERC20(vault);
        uint256 sharesBefore = shareToken.balanceOf(address(this));
        shareToken.safeTransferFrom(msg.sender, address(this), shares);
        pulled = shareToken.balanceOf(address(this)) - sharesBefore;

        uint256[] memory received;
        (received, redeemed) = _redeem(vault, registry, pulled);

        for (uint256 j; j < registry.length; ++j) {
            if (j != outIdx && received[j] != 0) {
                _sellOrPass(registry[j], tokenOut, received[j], slippageBps);
            }
        }
    }

    /// @dev `vault.redeem(shares, this)`; returns the measured balance delta per registry token (what the sales are
    ///      sized on — delivery is floor-rounded and the zap trusts only its own balances) and the vault's reported
    ///      amounts (for the event).
    function _redeem(address vault, address[] memory registry, uint256 shares)
        internal
        returns (uint256[] memory received, uint256[] memory redeemed)
    {
        uint256 m = registry.length;
        received = new uint256[](m);
        for (uint256 j; j < m; ++j) {
            received[j] = IERC20(registry[j]).balanceOf(address(this));
        }
        (, redeemed) = IPoolmigoZapOutVault(vault).redeem(shares, address(this));
        for (uint256 j; j < m; ++j) {
            received[j] = IERC20(registry[j]).balanceOf(address(this)) - received[j];
        }
    }

    /**
     * @dev Sell `amount` of `tokenIn` into `tokenOut`, or leave it for the sweep (pass-through):
     *      - no route `tokenIn → tokenOut` → pass-through (a missing route never blocks an exit);
     *      - route → guard ({_guardRoute}: TWAP read + one-sided deviation check), then
     *        minOut = TWAP quote(amount) × (1 − slip); minOut == 0 → dust pass-through (never an unbounded swap);
     *      - else one exact-input swap of `amount` through the router, output to this contract, with exact
     *        two-layer Permit2 approvals zeroed right after; router min-out failure → `ZapOut__SlippageExceeded`,
     *        and the balance delta is re-checked here.
     */
    function _sellOrPass(address tokenIn, address tokenOut, uint256 amount, uint16 slippageBps) internal {
        Route memory r = routes[tokenIn][tokenOut];
        if (r.refPool == address(0)) {
            emit ZapPassThrough(msg.sender, tokenIn, amount);
            return;
        }
        Leg memory leg = _leg(tokenIn, tokenOut, r, slippageBps);
        _guardRoute(leg);
        uint256 minOut =
            _quote(amount, leg.sqrtTwapX96, leg.zeroForOne).mulDiv(BPS_DENOMINATOR - leg.slip, BPS_DENOMINATOR);
        if (minOut == 0) {
            emit ZapPassThrough(msg.sender, tokenIn, amount);
            return;
        }

        IERC20 tIn = IERC20(tokenIn);
        IERC20 tOut = IERC20(tokenOut);
        (bytes memory commands, bytes[] memory inputs) =
            UniversalRouterCodec.v3ExactInSingle(address(this), amount, minOut, tokenIn, leg.fee, tokenOut);
        uint256 outBefore = tOut.balanceOf(address(this));
        _approvePermit2(tIn, amount);
        try UNIVERSAL_ROUTER.execute(commands, inputs, block.timestamp) {}
        catch (bytes memory reason) {
            if (UniversalRouterCodec.isTooLittleReceived(reason)) {
                revert ZapOut__SlippageExceeded(tokenIn, amount, minOut);
            }
            assembly ("memory-safe") {
                revert(add(reason, 0x20), mload(reason))
            }
        }
        _revokePermit2(tIn);
        uint256 amountOut = tOut.balanceOf(address(this)) - outBefore;
        if (amountOut < minOut) {
            revert ZapOut__SlippageExceeded(tokenIn, amount, minOut);
        }
        emit ZapSold(msg.sender, tokenIn, tokenOut, amount, amountOut);
    }

    /// @dev The zap's WHOLE balance of every registry token goes to `receiver`: `tokenOut` (redeemed slice + sale
    ///      outputs) and every pass-through — so the post-condition is zero residue (a token sent here outside a
    ///      zap would leave with the next zap's receiver; the sales themselves only ever use the redeem deltas).
    function _sweep(address[] memory registry, address receiver) internal returns (uint256[] memory delivered) {
        uint256 m = registry.length;
        delivered = new uint256[](m);
        for (uint256 j; j < m; ++j) {
            uint256 amount = IERC20(registry[j]).balanceOf(address(this));
            if (amount != 0) {
                IERC20(registry[j]).safeTransfer(receiver, amount);
                delivered[j] = amount;
            }
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

    /// @dev Step-1 checks shared by {zapRedeem} and {previewRedeem}: registered vault, non-zero shares, `tokenOut`
    ///      in the CURRENT basket, and `slippageBps` no looser than any route from a basket token into `tokenOut`.
    ///      Returns the registry and `tokenOut`'s index in it.
    function _validate(address vault, address tokenOut, uint256 shares, uint16 slippageBps)
        internal
        view
        returns (address[] memory registry, uint256 outIdx)
    {
        if (!isVaultRegistered[vault]) {
            revert ZapOut__VaultNotRegistered(vault);
        }
        if (shares == 0) {
            revert ZapOut__ZeroShares();
        }
        registry = IPoolmigoZapOutVault(vault).tokens();
        bool found;
        for (uint256 j; j < registry.length; ++j) {
            if (registry[j] == tokenOut) {
                found = true;
                outIdx = j;
                continue;
            }
            Route storage r = routes[registry[j]][tokenOut];
            if (r.refPool != address(0) && slippageBps > r.maxSlippageBps) {
                revert ZapOut__SlippageTooLoose(slippageBps, r.maxSlippageBps);
            }
        }
        if (!found) {
            revert ZapOut__TokenNotInBasket(vault, tokenOut);
        }
    }

    /// @dev The sale leg `tokenIn → tokenOut` on route `r` with the effective slippage.
    function _leg(address tokenIn, address tokenOut, Route memory r, uint16 slippageBps)
        internal
        pure
        returns (Leg memory leg)
    {
        leg.tokenIn = tokenIn;
        leg.pool = IUniswapV3PoolMinimal(r.refPool);
        leg.fee = r.swapFee;
        leg.zeroForOne = tokenIn < tokenOut;
        leg.twapWindow = r.twapWindow;
        leg.maxDeviationBps = r.maxDeviationBps;
        leg.slip = slippageBps == 0 ? r.maxSlippageBps : slippageBps;
    }

    /// @dev {previewRedeem}'s mirror of {_sellOrPass}: the estimated output of selling `amount`, or
    ///      `type(uint256).max` for a pass-through (no route, or a dust sale). Runs the route guard, so the view
    ///      reverts wherever the zap would.
    function _previewSale(address tokenIn, address tokenOut, uint256 amount, uint16 slippageBps)
        internal
        view
        returns (uint256)
    {
        Route memory r = routes[tokenIn][tokenOut];
        if (r.refPool == address(0)) {
            return type(uint256).max;
        }
        Leg memory leg = _leg(tokenIn, tokenOut, r, slippageBps);
        _guardRoute(leg);
        if (_quote(amount, leg.sqrtTwapX96, leg.zeroForOne).mulDiv(BPS_DENOMINATOR - leg.slip, BPS_DENOMINATOR) == 0) {
            return type(uint256).max;
        }
        (uint160 sqrtPriceX96,,,,,,) = leg.pool.slot0();
        return _outForIn(sqrtPriceX96, leg.pool.liquidity(), leg.fee, leg.zeroForOne, amount);
    }

    /// @dev Route guard, once per route before its swap: TWAP tick (typed revert if the oracle cannot serve the
    ///      window) and the ONE-SIDED deviation check — revert if the bought token's spot is dearer than its TWAP
    ///      by more than `maxDeviationBps` ticks (buying token0 is adverse when spot tick > TWAP tick; buying token1
    ///      when spot tick < TWAP tick). The favourable side adds no security. Caches the TWAP sqrt price.
    ///      Ported unchanged from `PoolmigoZapIn`: the adverse side is a property of the pair direction — here the
    ///      bought token is `tokenOut` and the sold token is the basket token.
    function _guardRoute(Leg memory leg) internal view {
        int24 twapTick_ = _twapTick(leg.pool, leg.twapWindow);
        (, int24 spotTick,,,,,) = leg.pool.slot0();
        int256 adverse = leg.zeroForOne
            ? int256(twapTick_) - int256(spotTick)  // buying token1
            : int256(spotTick) - int256(twapTick_); // buying token0
        if (adverse > int256(uint256(leg.maxDeviationBps))) {
            revert ZapOut__SpotDeviatesFromTwap(address(leg.pool), spotTick, twapTick_, leg.maxDeviationBps);
        }
        leg.sqrtTwapX96 = TickMath.getSqrtRatioAtTick(twapTick_);
    }

    /**
     * @dev Forward constant-liquidity exact-input output within the current range — the v3 swap-step math with the
     *      pool's own rounding (SqrtPriceMath: token0 in → `getNextSqrtPriceFromAmount0RoundingUp` incl. its
     *      overflow fallback, then `getAmount1Delta` rounded down; token1 in → `getNextSqrtPriceFromAmount1-
     *      RoundingDown`, then `getAmount0Delta` rounded down; fee on input, floored). The {previewRedeem} estimate
     *      of what `amountIn` sells for at the current price (exact on a single-range pool).
     */
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
            uint256 spNext;
            unchecked {
                uint256 product = net * sp;
                if (product / net == sp && numerator1 + product >= numerator1) {
                    spNext = numerator1.mulDiv(sp, numerator1 + product, Math.Rounding.Ceil);
                }
            }
            if (spNext == 0) {
                spNext = Math.ceilDiv(numerator1, numerator1 / sp + net);
            }
            return uint256(liquidity).mulDiv(sp - spNext, FixedPoint96.Q96);
        }
        uint256 spUp = sp + net.mulDiv(FixedPoint96.Q96, liquidity);
        return numerator1.mulDiv(spUp - sp, spUp) / sp;
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
            revert ZapOut__TwapUnavailable(address(pool), window);
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
            revert ZapOut__TwapWindowOutOfRange(r.twapWindow, MIN_TWAP_WINDOW, MAX_TWAP_WINDOW);
        }
        if (r.maxSlippageBps < MIN_SLIPPAGE_BPS || r.maxSlippageBps > MAX_SLIPPAGE_BPS) {
            revert ZapOut__SlippageOutOfRange(r.maxSlippageBps, MIN_SLIPPAGE_BPS, MAX_SLIPPAGE_BPS);
        }
        if (r.maxDeviationBps < MIN_DEVIATION_BPS || r.maxDeviationBps > MAX_DEVIATION_BPS) {
            revert ZapOut__DeviationOutOfRange(r.maxDeviationBps, MIN_DEVIATION_BPS, MAX_DEVIATION_BPS);
        }
    }

    /// @dev `refPool` is FACTORY's canonical pool for the pair + fee (so it is the pool the router derives and
    ///      trades on), and its oracle ring is longer than the window.
    function _checkRoutePool(address tokenIn, address tokenOut, Route memory r) internal view {
        if (tokenIn == address(0) || tokenOut == address(0) || r.refPool == address(0)) {
            revert ZapOut__ZeroAddress();
        }
        if (tokenIn == tokenOut) {
            revert ZapOut__InvalidRoute(tokenIn, tokenOut);
        }
        if (r.refPool.code.length == 0) {
            revert ZapOut__NoCode(r.refPool);
        }
        IUniswapV3PoolMinimal pool = IUniswapV3PoolMinimal(r.refPool);
        (address token0, address token1) = tokenIn < tokenOut ? (tokenIn, tokenOut) : (tokenOut, tokenIn);
        if (
            pool.factory() != FACTORY || pool.token0() != token0 || pool.token1() != token1 || pool.fee() != r.swapFee
                || IUniswapV3FactoryMinimal(FACTORY).getPool(token0, token1, r.swapFee) != r.refPool
        ) {
            revert ZapOut__PoolMismatch(r.refPool);
        }
        (,,, uint16 cardinality,,,) = pool.slot0();
        if (cardinality <= r.twapWindow) {
            revert ZapOut__CardinalityTooLow(r.refPool, cardinality, r.twapWindow);
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
