// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {ERC165} from "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IPositionAdapter} from "contracts/interfaces/IPositionAdapter.sol";
import {IPoolmigoVault} from "contracts/interfaces/IPoolmigoVault.sol";
import {ILiquidityAdapter} from "contracts/interfaces/ILiquidityAdapter.sol";
import {ISwapAdapter} from "contracts/interfaces/ISwapAdapter.sol";
import {IUniswapV3PoolMinimal} from "contracts/adapters/uniswap/IUniswapV3PoolMinimal.sol";
import {IUniswapV3FactoryMinimal} from "contracts/adapters/uniswap/IUniswapV3FactoryMinimal.sol";
import {INonfungiblePositionManager} from "contracts/adapters/uniswap/INonfungiblePositionManager.sol";
import {IUniversalRouter} from "contracts/adapters/uniswap/IUniversalRouter.sol";
import {ISwapExecutor} from "contracts/interfaces/ISwapExecutor.sol";
import {TickMath} from "contracts/adapters/uniswap/TickMath.sol";
import {LiquidityAmounts} from "contracts/adapters/uniswap/LiquidityAmounts.sol";

/**
 * @title UniswapV3Adapter
 * @author MySun
 * @notice ONE Uniswap v3 concentrated-liquidity position on ONE pool, operated by the MySun vault
 *         through {IPositionAdapter}. Speaks token vectors only — `[token0, token1]` in POOL order,
 *         stable for the adapter's lifetime. No USD, no NAV, no valuation scalar anywhere.
 *
 *         - {position}: idle balances + position principal at venue SPOT + settled and accrued
 *           (uncollected) fees. Spot is the accepted read (IPositionAdapter NatSpec): a manipulated read
 *           can only over-price a depositor, and the vault enforces a non-zero `minShares`.
 *         - {deploy}: pulls the vault's amounts, then — the ONLY swap path — swaps the surplus token into
 *           the deficit token so holdings match the range's ratio, and adds ALL holdings as liquidity.
 *           This is how the keeper adjusts the basket ratio (passive + active market making).
 *         - {withdrawProportional} / {harvest} / {unwindAll}: in kind, NEVER swap, never read the TWAP
 *           (so an oracle outage can never block a redemption).
 *
 *         Swap guards (deploy only):
 *         - Sizing AND bounds use the pool's TWAP tick (`observe`) over `twapWindow` (>= 300s). Never
 *           raw `slot0`. Too-short history → `UniswapV3Adapter__TwapUnavailable`, no spot fallback.
 *         - Spot must sit within `maxSlippageBps` ticks of the TWAP (1 tick ≈ 1bp), else
 *           `UniswapV3Adapter__SpotDeviatesFromTwap` — no swapping or minting into a moved/manipulated
 *           price.
 *         - Every swap carries `amountOutMinimum = TWAP quote × (1 − maxSlippageBps)`; a breach reverts
 *           `ISwapExecutor.SwapExecutor__SlippageExceeded`. The budget must cover the pool fee + price impact.
 *         - Execution: the shared, stateless `SWAP_EXECUTOR` (UniversalRouterSwapExecutor, strategy layer P1c) —
 *           the official Uniswap UniversalRouter (2.1.x) `V3_SWAP_EXACT_IN`, single hop through THIS adapter's own
 *           pool, so the TWAP reference and the pool actually traded are the same venue (on RHC the target
 *           fee-100 USDG/WETH pool is also the deepest). The adapter approves the executor exactly `amountIn` and
 *           resets it to 0 after; the executor runs the Permit2 layers (exact, zeroed per call), sends the output
 *           back to this adapter and re-checks this adapter's balance delta against `minOut`. Its router must be
 *           `swapRouter` (checked at construction).
 *
 *         Range (quant-owned, owner-settable, nothing hardcoded): a fresh position spans
 *         [twapTick − rangeTicksBelow, twapTick + rangeTicksAbove], snapped outward to tickSpacing. Later
 *         deploys add to the SAME range. Re-range = keeper `pullFrom(adapter, 10_000)` (burns the NFT)
 *         → `deployTo` (mints at the then-current TWAP with the then-current params).
 *
 *         Precise liquidity ({ILiquidityAdapter}, strategy layer P1): the keeper (through the vault) adds an exact
 *         raw liquidity at absolute bounds ({addLiquidity}) or removes an exact raw liquidity ({removeLiquidity}),
 *         inside the owner's range constraints (`minTick` / `maxTick` / `minRangeTicks` / `maxRangeTicks`,
 *         {setRangeConstraints}). The constraints gate these ops only — the TWAP-anchored {deploy} / {setRange}
 *         flow above is unchanged. {addLiquidity} runs the same TWAP/spot guard and swap guards as {deploy}, plus
 *         the caller's own swap floor; {removeLiquidity} is in kind (no swap, no TWAP read).
 *
 *         Swap capability ({ISwapAdapter}, strategy layer P3): {swapExactIn} swaps vault idle handed over for the call
 *         through the same guarded path as {deploy} (TWAP + spot guard, TWAP floor, SWAP_EXECUTOR on this pool), the
 *         caller's floor applying when stricter, and returns the full output to the vault. ERC-165 advertises both
 *         capabilities; {positionState} is the plan pin (live position + `configVersion`, bumped by every owner setter).
 *
 * @dev The adapter owns the v3 NFT (NFPM `mint` uses `_mint`, no receiver hook). Fee accounting: principal
 *      is always collected in full when liquidity is decreased, so the NFPM's `tokensOwed` only ever holds
 *      fees — {harvest} is `collect(max, max)`. Not audited. Owner must be a multisig.
 * @custom:security-contact security@mysun.example
 */
contract UniswapV3Adapter is
    IPositionAdapter,
    ILiquidityAdapter,
    ISwapAdapter,
    ERC165,
    Ownable2Step,
    ReentrancyGuardTransient
{
    using SafeERC20 for IERC20;
    using Math for uint256;

    /*//////////////////////////////////////////////////////////////
                                 TYPES
    //////////////////////////////////////////////////////////////*/

    struct Config {
        address vault; // sole caller of deploy / withdrawProportional / harvest / unwindAll
        address pool; // IUniswapV3Pool — its fee tier is the §8 #1 / quant choice
        address positionManager; // v3 NonfungiblePositionManager
        address swapRouter; // Uniswap UniversalRouter 2.1.x (V3_SWAP_EXACT_IN) — venue-checked here
        address permit2; // canonical Permit2 — the router pulls swap input through it
        address swapExecutor; // UniversalRouterSwapExecutor on exactly (swapRouter, permit2) — runs every swap
        address owner; // parameter admin (multisig)
        int24 rangeTicksBelow; // fresh range: ticks below the TWAP tick
        int24 rangeTicksAbove; // fresh range: ticks above the TWAP tick
        uint32 twapWindow; // seconds, [MIN_TWAP_WINDOW, MAX_TWAP_WINDOW]
        uint16 maxSlippageBps; // [MIN_SLIPPAGE_BPS, MAX_SLIPPAGE_BPS]
    }

    /// @dev NFPM position fields the adapter reads.
    struct PositionInfo {
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint256 feeGrowthInside0LastX128;
        uint256 feeGrowthInside1LastX128;
        uint128 tokensOwed0;
        uint128 tokensOwed1;
    }

    /// @dev Working state of one {addLiquidity} call (memory — keeps the stack shallow).
    struct AddOp {
        bool fresh; // no live position: mint at the given bounds
        int24 tickLower;
        int24 tickUpper;
        uint160 sqrtLowerX96;
        uint160 sqrtUpperX96;
        uint256 pull0; // pulled from the vault (<= cap)
        uint256 pull1;
        bool zeroForOne; // swap direction (token0 -> token1) when swapIn != 0
        uint256 swapIn; // 0 = no swap
        uint256 twapMinOut; // TWAP quote of swapIn x (1 - maxSlippageBps)
        uint256 avail0; // this op's holdings (pulled ± swap) — the refund base; pre-existing idle excluded
        uint256 avail1;
    }

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error UniswapV3Adapter__OnlyVault();
    error UniswapV3Adapter__ZeroAddress();
    error UniswapV3Adapter__LengthMismatch();
    error UniswapV3Adapter__InvalidSharesWad(uint256 sharesWad);
    error UniswapV3Adapter__VenueMismatch(address pool);
    error UniswapV3Adapter__RouterMismatch(address router);
    error UniswapV3Adapter__NoCode(address account);
    /// @dev The swap executor is not wired to this adapter's (swapRouter, permit2).
    error UniswapV3Adapter__ExecutorMismatch(address executor);
    error UniswapV3Adapter__InvalidRange(int24 ticksBelow, int24 ticksAbove);
    error UniswapV3Adapter__TwapWindowOutOfRange(uint32 window, uint32 min, uint32 max);
    error UniswapV3Adapter__SlippageOutOfRange(uint16 bps, uint16 min, uint16 max);
    error UniswapV3Adapter__TwapUnavailable(uint32 window);
    error UniswapV3Adapter__SpotDeviatesFromTwap(int24 spotTick, int24 twapTick, uint16 maxSlippageBps);
    error UniswapV3Adapter__ZeroLiquidity();
    /// @dev {setRangeConstraints}: need MIN_TICK <= minTick < maxTick <= MAX_TICK, both spacing-aligned, and
    ///      0 < minRangeTicks <= maxRangeTicks, minRangeTicks <= maxTick - minTick and minRangeTicks aligned up to
    ///      the tick spacing <= maxRangeTicks (some legal width fits — exactly the satisfiable boxes).
    error UniswapV3Adapter__InvalidConstraints(int24 minTick, int24 maxTick, int24 minRangeTicks, int24 maxRangeTicks);
    /// @dev {addLiquidity}: a bound is not a multiple of the pool's tick spacing.
    error UniswapV3Adapter__UnalignedRange(int24 tickLower, int24 tickUpper, int24 tickSpacing);
    /// @dev {addLiquidity}: bounds outside [minTick, maxTick] or width outside [minRangeTicks, maxRangeTicks].
    error UniswapV3Adapter__RangeOutsideConstraints(int24 tickLower, int24 tickUpper);
    /// @dev {addLiquidity}: a live position exists with other bounds — close the position first
    ///      (vault `pullFrom(adapter, 10_000)` burns it), then add at the new bounds.
    error UniswapV3Adapter__RangeMismatch(int24 liveLower, int24 liveUpper, int24 tickLower, int24 tickUpper);
    /// @dev {addLiquidity}: `minLiquidity` above the target `liquidity`.
    error UniswapV3Adapter__InvalidMinLiquidity(uint128 minLiquidity, uint128 liquidity);
    /// @dev {addLiquidity}: the op needs a ratio swap but the caller gave no explicit floor (`minSwapOut == 0`).
    error UniswapV3Adapter__ZeroMinSwapOut(address tokenIn, uint256 amountIn);
    /// @dev {addLiquidity}: the liquidity actually added is below `minLiquidity`.
    error UniswapV3Adapter__LiquidityBelowMin(uint128 actual, uint128 minLiquidity);
    /// @dev {removeLiquidity}: more liquidity requested than the live position holds (0 when there is none).
    error UniswapV3Adapter__InsufficientLiquidity(uint128 requested, uint128 available);
    /// @dev {removeLiquidity} idle-refund mode (`liquidity == 0`) releases no principal, so a non-zero principal
    ///      floor can never be met — idle must never satisfy it.
    error UniswapV3Adapter__PrincipalFloorInIdleMode(uint256 minPrincipal0, uint256 minPrincipal1);
    /// @dev {swapExactIn}: `amountIn == 0`, or (tokenIn, tokenOut) is not (token0, token1) / (token1, token0).
    error UniswapV3Adapter__InvalidSwap(address tokenIn, address tokenOut, uint256 amountIn);

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    event RangeSet(int24 ticksBelow, int24 ticksAbove);
    event TwapWindowSet(uint32 oldWindow, uint32 newWindow);
    event MaxSlippageSet(uint16 oldBps, uint16 newBps);
    event PositionMinted(uint256 indexed tokenId, int24 tickLower, int24 tickUpper);
    event PositionBurned(uint256 indexed tokenId);
    event Swapped(address indexed tokenIn, uint256 amountIn, uint256 amountOut, uint256 minAmountOut);
    event LiquidityDeployed(uint256 pulled0, uint256 pulled1, uint256 used0, uint256 used1, uint128 liquidity);
    event Withdrawn(address indexed to, uint256 sharesWad, uint256 amount0, uint256 amount1);
    event Harvested(uint256 amount0, uint256 amount1);
    event Unwound(address indexed to, uint256 amount0, uint256 amount1);
    event RangeConstraintsSet(int24 minTick, int24 maxTick, int24 minRangeTicks, int24 maxRangeTicks);
    /// @dev spent = added into the position (post-swap); refunded = this op's leftover returned to the vault.
    event LiquidityAdded(
        uint256 indexed tokenId, uint128 liquidity, uint256 spent0, uint256 spent1, uint256 refunded0, uint256 refunded1
    );
    event LiquidityRemoved(
        uint256 indexed tokenId, uint128 liquidity, uint256 principal0, uint256 principal1, uint256 fees0, uint256 fees1
    );
    event IdleRefunded(uint256 amount0, uint256 amount1);

    /*//////////////////////////////////////////////////////////////
                               CONSTANTS
    //////////////////////////////////////////////////////////////*/

    bytes32 public constant DEX_ID = keccak256("UNISWAP_V3");
    uint256 public constant BPS_DENOMINATOR = 10_000;
    /// @dev Scale of the {withdrawProportional} fraction (`sharesWad` / 1e18).
    uint256 private constant WAD = 1e18;
    uint32 public constant MIN_TWAP_WINDOW = 300; // 5 min floor: shorter windows are cheap to move
    uint32 public constant MAX_TWAP_WINDOW = 7 days;
    uint16 public constant MIN_SLIPPAGE_BPS = 1;
    uint16 public constant MAX_SLIPPAGE_BPS = 1_000; // 10%
    /// @dev Reference liquidity for reading the range's token ratio (large for precision; fits uint128).
    uint128 private constant REF_LIQUIDITY = 1e30;

    /*//////////////////////////////////////////////////////////////
                               IMMUTABLES
    //////////////////////////////////////////////////////////////*/

    address public immutable VAULT;
    IUniswapV3PoolMinimal public immutable POOL;
    INonfungiblePositionManager public immutable POSITION_MANAGER;
    ISwapExecutor public immutable SWAP_EXECUTOR;
    IERC20 public immutable TOKEN0;
    IERC20 public immutable TOKEN1;
    uint24 public immutable POOL_FEE;
    int24 public immutable TICK_SPACING;

    /*//////////////////////////////////////////////////////////////
                                 STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @notice NFT id of the live position (0 = none; the next deploy mints a fresh range).
    uint256 public tokenId;
    /// @notice Tick bounds of the live position (0 while tokenId == 0).
    int24 public tickLower;
    int24 public tickUpper;

    /// @notice Fresh-range offsets from the TWAP tick, applied on the NEXT mint (never moves a live range).
    int24 public rangeTicksBelow;
    int24 public rangeTicksAbove;
    /// @notice TWAP lookback (seconds) for swap sizing and every deploy-time price guard.
    uint32 public twapWindow;
    /// @notice Max tolerated deviation vs the TWAP reference, in bps: spot gap (ticks) and swap output.
    uint16 public maxSlippageBps;

    /// @notice Owner range constraints for {addLiquidity}: absolute tick box (spacing-aligned) and width bounds.
    ///         Default = the widest legal box. They gate the precise ops only, never {deploy}.
    int24 public minTick;
    int24 public maxTick;
    int24 public minRangeTicks;
    int24 public maxRangeTicks;
    /// @dev Owner-config version for plan pins ({positionState}): 1 after construction, +1 per owner setter call.
    uint32 internal configVersion;

    /*//////////////////////////////////////////////////////////////
                                MODIFIERS
    //////////////////////////////////////////////////////////////*/

    modifier onlyVault() {
        _checkVault();
        _;
    }

    /*//////////////////////////////////////////////////////////////
                               CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /// @dev Checks the venue is coherent: pool and NFPM share one v3 factory, and `pool` is that factory's
    ///      canonical pool for its (token0, token1, fee) — the pool the NFPM will actually mint on. The router
    ///      (2.1.x has no `factory()`) is anchored through its own `V3_POSITION_MANAGER()`, whose factory must be
    ///      that same factory — a router wired to another chain's deployment (e.g. the mainnet copy on RHC) fails.
    ///      Router, Permit2 and the swap executor must have code, and the executor must run on exactly that router
    ///      and Permit2 (`__ExecutorMismatch`) — so the venue validated here is the one every swap uses.
    constructor(Config memory cfg) Ownable(cfg.owner) {
        if (
            cfg.vault == address(0) || cfg.pool == address(0) || cfg.positionManager == address(0)
                || cfg.swapRouter == address(0) || cfg.permit2 == address(0) || cfg.swapExecutor == address(0)
        ) {
            revert UniswapV3Adapter__ZeroAddress();
        }
        if (cfg.swapRouter.code.length == 0) {
            revert UniswapV3Adapter__NoCode(cfg.swapRouter);
        }
        if (cfg.permit2.code.length == 0) {
            revert UniswapV3Adapter__NoCode(cfg.permit2);
        }
        if (cfg.swapExecutor.code.length == 0) {
            revert UniswapV3Adapter__NoCode(cfg.swapExecutor);
        }

        IUniswapV3PoolMinimal pool = IUniswapV3PoolMinimal(cfg.pool);
        INonfungiblePositionManager nfpm = INonfungiblePositionManager(cfg.positionManager);
        IUniversalRouter router = IUniversalRouter(cfg.swapRouter);
        address token0 = pool.token0();
        address token1 = pool.token1();
        uint24 fee = pool.fee();
        address factory = nfpm.factory();
        if (pool.factory() != factory || IUniswapV3FactoryMinimal(factory).getPool(token0, token1, fee) != cfg.pool) {
            revert UniswapV3Adapter__VenueMismatch(cfg.pool);
        }
        if (_factoryOf(router.V3_POSITION_MANAGER()) != factory) {
            revert UniswapV3Adapter__RouterMismatch(cfg.swapRouter);
        }
        ISwapExecutor executor = ISwapExecutor(cfg.swapExecutor);
        if (executor.UNIVERSAL_ROUTER() != cfg.swapRouter || executor.PERMIT2() != cfg.permit2) {
            revert UniswapV3Adapter__ExecutorMismatch(cfg.swapExecutor);
        }

        VAULT = cfg.vault;
        POOL = pool;
        POSITION_MANAGER = nfpm;
        SWAP_EXECUTOR = executor;
        TOKEN0 = IERC20(token0);
        TOKEN1 = IERC20(token1);
        POOL_FEE = fee;
        TICK_SPACING = pool.tickSpacing();

        _setRange(cfg.rangeTicksBelow, cfg.rangeTicksAbove);
        _setTwapWindow(cfg.twapWindow);
        _setMaxSlippageBps(cfg.maxSlippageBps);

        int24 spacing = TICK_SPACING;
        int24 lowest = _ceilToSpacing(TickMath.MIN_TICK, spacing);
        int24 highest = _floorToSpacing(TickMath.MAX_TICK, spacing);
        _setRangeConstraints(lowest, highest, spacing, highest - lowest);
        configVersion = 1;
    }

    /*//////////////////////////////////////////////////////////////
                         VAULT-ONLY POSITION OPS
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IPositionAdapter
    /// @dev Guards first (TWAP available, spot near TWAP), then pull, then swap the surplus toward the
    ///      range ratio at the TWAP price (TWAP-bounded), then add EVERYTHING held (incl. earlier dust) as
    ///      liquidity at the NFPM's spot execution. Leftovers from rounding / our own price impact stay idle
    ///      and keep being reported by {position}.
    /// @return tokens `[token0, token1]`.
    /// @return deployed Amounts actually added to the position this call (post-swap, so they can differ
    ///         per token from what was pulled).
    function deploy(uint256[] calldata amounts)
        external
        nonReentrant
        onlyVault
        returns (address[] memory tokens, uint256[] memory deployed)
    {
        if (amounts.length != 2) {
            revert UniswapV3Adapter__LengthMismatch();
        }
        (int24 twapTick_,) = _guardedTwapTick();

        // msg.sender == VAULT (onlyVault), which force-approved exactly `amounts`.
        if (amounts[0] != 0) {
            TOKEN0.safeTransferFrom(msg.sender, address(this), amounts[0]);
        }
        if (amounts[1] != 0) {
            TOKEN1.safeTransferFrom(msg.sender, address(this), amounts[1]);
        }

        bool fresh = tokenId == 0;
        (int24 lower, int24 upper) = fresh ? _computeRange(twapTick_) : (tickLower, tickUpper);
        uint160 sqrtLowerX96 = TickMath.getSqrtRatioAtTick(lower);
        uint160 sqrtUpperX96 = TickMath.getSqrtRatioAtTick(upper);

        _swapToRangeRatio(TickMath.getSqrtRatioAtTick(twapTick_), sqrtLowerX96, sqrtUpperX96);

        tokens = _tokens();
        deployed = new uint256[](2);
        uint128 liquidityAdded;
        (liquidityAdded, deployed[0], deployed[1]) = _addLiquidity(fresh, lower, upper, sqrtLowerX96, sqrtUpperX96);
        emit LiquidityDeployed(amounts[0], amounts[1], deployed[0], deployed[1], liquidityAdded);
    }

    /// @inheritdoc IPositionAdapter
    /// @dev Delivers floor(sharesWad/1e18) of: idle balances, the position's liquidity (principal released at
    ///      the current price) and its fees (settled + accrued). No swap, no TWAP read, `decreaseLiquidity`
    ///      mins are 0 (in kind: the position returns what it holds; a redemption must never be blocked).
    ///      The fee slice goes to `to` with the principal and is reported apart: `fees_i` = collected − principal
    ///      released (= take_i − principal_i, see {_withdrawFromPosition}); the vault skims its perf fee on it.
    ///      Idle is never reported as fees. At 1e18 (= `pullFrom` 10_000 bps) the position is emptied and the NFT
    ///      burned (re-range path).
    function withdrawProportional(uint256 sharesWad, address to)
        external
        nonReentrant
        onlyVault
        returns (address[] memory tokens, uint256[] memory amounts, uint256[] memory fees)
    {
        if (sharesWad == 0 || sharesWad > WAD) {
            revert UniswapV3Adapter__InvalidSharesWad(sharesWad);
        }
        if (to == address(0)) {
            revert UniswapV3Adapter__ZeroAddress();
        }
        tokens = _tokens();
        amounts = new uint256[](2);
        fees = new uint256[](2);
        // Idle slice, snapshotted before any position flow.
        uint256 idle0 = TOKEN0.balanceOf(address(this)).mulDiv(sharesWad, WAD);
        uint256 idle1 = TOKEN1.balanceOf(address(this)).mulDiv(sharesWad, WAD);

        uint256 id = tokenId;
        if (id != 0) {
            bool closing = sharesWad == WAD;
            if (closing) {
                _clearPosition();
            }
            (amounts[0], amounts[1], fees[0], fees[1]) = _withdrawFromPosition(id, sharesWad, to);
            if (closing) {
                POSITION_MANAGER.burn(id);
                emit PositionBurned(id);
            }
        }

        if (idle0 != 0) {
            TOKEN0.safeTransfer(to, idle0);
            amounts[0] += idle0;
        }
        if (idle1 != 0) {
            TOKEN1.safeTransfer(to, idle1);
            amounts[1] += idle1;
        }
        emit Withdrawn(to, sharesWad, amounts[0], amounts[1]);
    }

    /// @inheritdoc IPositionAdapter
    /// @dev `collect(max, max)` straight to the vault: `tokensOwed` holds fees only (principal is always
    ///      collected in full on decrease), and the NFPM pokes the pool first so accrued fees are included.
    function harvest() external nonReentrant onlyVault returns (address[] memory tokens, uint256[] memory amounts) {
        tokens = _tokens();
        amounts = new uint256[](2);
        uint256 id = tokenId;
        if (id == 0) {
            return (tokens, amounts);
        }
        (amounts[0], amounts[1]) = _collect(id, VAULT, type(uint128).max, type(uint128).max);
        emit Harvested(amounts[0], amounts[1]);
    }

    /// @inheritdoc IPositionAdapter
    /// @dev Emergency: all liquidity, all fees and all idle, in kind, to `to`. Burns the NFT so the next {deploy}
    ///      mints a fresh range. `fees_i` = collected − principal released by the decrease-all (the
    ///      {removeLiquidity} split); the vault skims its perf fee on it (no emergency exemption).
    function unwindAll(address to)
        external
        nonReentrant
        onlyVault
        returns (address[] memory tokens, uint256[] memory amounts, uint256[] memory fees)
    {
        if (to == address(0)) {
            revert UniswapV3Adapter__ZeroAddress();
        }
        fees = new uint256[](2);
        uint256 id = tokenId;
        if (id != 0) {
            _clearPosition();
            uint128 liquidity = _readPosition(id).liquidity;
            uint256 principal0;
            uint256 principal1;
            if (liquidity != 0) {
                (principal0, principal1) = _decreaseLiquidity(id, liquidity, 0, 0);
            }
            (uint256 out0, uint256 out1) = _collect(id, address(this), type(uint128).max, type(uint128).max);
            fees[0] = out0 - principal0;
            fees[1] = out1 - principal1;
            POSITION_MANAGER.burn(id);
            emit PositionBurned(id);
        }

        tokens = _tokens();
        amounts = new uint256[](2);
        amounts[0] = TOKEN0.balanceOf(address(this));
        amounts[1] = TOKEN1.balanceOf(address(this));
        if (amounts[0] != 0) {
            TOKEN0.safeTransfer(to, amounts[0]);
        }
        if (amounts[1] != 0) {
            TOKEN1.safeTransfer(to, amounts[1]);
        }
        emit Unwound(to, amounts[0], amounts[1]);
    }

    /// @inheritdoc ILiquidityAdapter
    /// @dev Checks, in order: `liquidity > 0` (`UniswapV3Adapter__ZeroLiquidity`), `minLiquidity <= liquidity`
    ///      (`__InvalidMinLiquidity`), `tickLower < tickUpper` (`__InvalidRange`), both bounds spacing-aligned
    ///      (`__UnalignedRange`), bounds inside [minTick, maxTick] and width inside [minRangeTicks, maxRangeTicks]
    ///      (`__RangeOutsideConstraints`), and — with a live position — bounds equal to the live ones
    ///      (`__RangeMismatch`: close first). Then the {deploy} guards: TWAP available, spot within maxSlippageBps
    ///      ticks of it.
    ///
    ///      Sizing at spot: `need` = the amounts `liquidity` requires, rounded up (+1 wei per non-zero side).
    ///      - both needs within the caps: pull exactly `need`, no swap;
    ///      - one side short, the other with room: pull the short side's cap, and on the other side `need` plus
    ///        a swap input = the shortfall's TWAP value grossed up by maxSlippageBps (bounded by the room); swap it
    ///        (SWAP_EXECUTOR → UniversalRouter, this pool) with min-out = max(TWAP quote x (1 − maxSlippageBps),
    ///        `minSwapOut`).
    ///        `minSwapOut == 0` with a swap to run reverts `__ZeroMinSwapOut`. A dust swap whose TWAP min-out
    ///        rounds to 0 is skipped (as in {deploy});
    ///      - both short: pull both caps, no swap — actual liquidity binds below target.
    ///      The add is sized again at the post-swap spot (our own swap moves it against the surplus side, so actual
    ///      can land slightly below target) and capped at this op's holdings: liquidity never exceeds what the op
    ///      holds and, up to the venue's rounding, the target. NFPM mins are 0 — spot cannot move between sizing and
    ///      execution inside this call; `minLiquidity` is the binding floor (`__LiquidityBelowMin`).
    ///      Refund: this op's leftover (pulled ± swapped − spent) goes back to the vault; idle the adapter held
    ///      before the call stays put. No harvest, no fee collection.
    function addLiquidity(AddLiquidityParams calldata params)
        external
        nonReentrant
        onlyVault
        returns (
            uint256 id,
            uint128 liquidityAdded,
            uint256 amount0Spent,
            uint256 amount1Spent,
            uint256 amount0Refunded,
            uint256 amount1Refunded
        )
    {
        AddLiquidityParams memory p = params; // decoded once
        AddOp memory op = _planAdd(p);
        if (op.swapIn != 0 && p.minSwapOut == 0) {
            revert UniswapV3Adapter__ZeroMinSwapOut(address(op.zeroForOne ? TOKEN0 : TOKEN1), op.swapIn);
        }

        // msg.sender == VAULT (onlyVault), which force-approved exactly the caps; pulls stay <= caps.
        if (op.pull0 != 0) {
            TOKEN0.safeTransferFrom(msg.sender, address(this), op.pull0);
        }
        if (op.pull1 != 0) {
            TOKEN1.safeTransferFrom(msg.sender, address(this), op.pull1);
        }
        op.avail0 = op.pull0;
        op.avail1 = op.pull1;
        if (op.swapIn != 0) {
            uint256 minOut = Math.max(op.twapMinOut, p.minSwapOut);
            uint256 out = _executeSwap(op.zeroForOne, op.swapIn, minOut);
            if (op.zeroForOne) {
                op.avail0 -= op.swapIn;
                op.avail1 += out;
            } else {
                op.avail1 -= op.swapIn;
                op.avail0 += out;
            }
        }

        (liquidityAdded, amount0Spent, amount1Spent) = _addExact(op, p.liquidity);
        if (liquidityAdded < p.minLiquidity) {
            revert UniswapV3Adapter__LiquidityBelowMin(liquidityAdded, p.minLiquidity);
        }

        amount0Refunded = op.avail0 - amount0Spent;
        amount1Refunded = op.avail1 - amount1Spent;
        _sendToVault(amount0Refunded, amount1Refunded);
        id = tokenId;
        emit LiquidityAdded(id, liquidityAdded, amount0Spent, amount1Spent, amount0Refunded, amount1Refunded);
    }

    /// @inheritdoc ILiquidityAdapter
    /// @dev Idle-refund mode (`liquidity == 0`): both token balances to the vault; NO position-manager call, so the
    ///      NFT, its liquidity and its fee checkpoints are untouched. Non-zero principal floors revert
    ///      `UniswapV3Adapter__PrincipalFloorInIdleMode` (idle never counts as principal).
    ///      Removal mode: `liquidity <= live` (`__InsufficientLiquidity`), then NFPM `decreaseLiquidity` with the
    ///      principal floors as its `amount0Min/amount1Min` (principal-only: the NFPM reverts "Price slippage
    ///      check" below them), then `collect(max, max)` to the VAULT — the released principal plus ALL the
    ///      position's fees (settled + those the decrease just settled). fees = collected − principal. The NFT is
    ///      kept even at zero liquidity (burning stays with the close path, `withdrawProportional(1e18)`). No
    ///      performance fee here: adapters report the split, fee policy is the vault's (it skims on `fees0/fees1`).
    function removeLiquidity(RemoveLiquidityParams calldata p)
        external
        nonReentrant
        onlyVault
        returns (
            uint256 principal0,
            uint256 principal1,
            uint256 fees0,
            uint256 fees1,
            uint256 idleRefunded0,
            uint256 idleRefunded1
        )
    {
        if (p.liquidity == 0) {
            if (p.minPrincipal0 != 0 || p.minPrincipal1 != 0) {
                revert UniswapV3Adapter__PrincipalFloorInIdleMode(p.minPrincipal0, p.minPrincipal1);
            }
            idleRefunded0 = TOKEN0.balanceOf(address(this));
            idleRefunded1 = TOKEN1.balanceOf(address(this));
            _sendToVault(idleRefunded0, idleRefunded1);
            emit IdleRefunded(idleRefunded0, idleRefunded1);
            return (0, 0, 0, 0, idleRefunded0, idleRefunded1);
        }

        uint256 id = tokenId;
        uint128 live = id == 0 ? 0 : _readPosition(id).liquidity;
        if (p.liquidity > live) {
            revert UniswapV3Adapter__InsufficientLiquidity(p.liquidity, live);
        }
        (principal0, principal1) = _decreaseLiquidity(id, p.liquidity, p.minPrincipal0, p.minPrincipal1);
        // tokensOwed = earlier fees + fees the decrease just settled + the principal it released: take all.
        (uint256 out0, uint256 out1) = _collect(id, VAULT, type(uint128).max, type(uint128).max);
        fees0 = out0 - principal0;
        fees1 = out1 - principal1;
        emit LiquidityRemoved(id, p.liquidity, principal0, principal1, fees0, fees1);
    }

    /// @inheritdoc ISwapAdapter
    /// @dev `(tokenIn, tokenOut)` must be this pool's pair in either direction and `amountIn > 0`
    ///      (`UniswapV3Adapter__InvalidSwap`). Then the {deploy} guards (TWAP available, spot within maxSlippageBps
    ///      ticks of it), pull exactly `amountIn` from the vault, swap it (SWAP_EXECUTOR → this pool) with min-out =
    ///      max(TWAP quote x (1 − maxSlippageBps), `minAmountOut`) and send the whole output (the executor's balance
    ///      delta) to the vault. Idle the adapter already held is never touched.
    function swapExactIn(SwapParams calldata p) external nonReentrant onlyVault returns (uint256 amountOut) {
        bool zeroForOne = p.tokenIn == address(TOKEN0);
        if (
            p.amountIn == 0
                || (zeroForOne
                        ? p.tokenOut != address(TOKEN1)
                        : p.tokenIn != address(TOKEN1) || p.tokenOut != address(TOKEN0))
        ) {
            revert UniswapV3Adapter__InvalidSwap(p.tokenIn, p.tokenOut, p.amountIn);
        }
        (int24 twapTick_,) = _guardedTwapTick();
        // msg.sender == VAULT (onlyVault), which force-approved exactly `amountIn`.
        IERC20(p.tokenIn).safeTransferFrom(msg.sender, address(this), p.amountIn);
        uint256 twapMinOut = _twapMinOut(p.amountIn, TickMath.getSqrtRatioAtTick(twapTick_), zeroForOne);
        amountOut = _executeSwap(zeroForOne, p.amountIn, Math.max(twapMinOut, p.minAmountOut));
        IERC20(p.tokenOut).safeTransfer(msg.sender, amountOut);
    }

    /*//////////////////////////////////////////////////////////////
                           OWNER PARAMETERS
    //////////////////////////////////////////////////////////////*/

    /// @notice Fresh-range offsets (ticks) from the TWAP tick. Applies to the next mint only.
    function setRange(int24 ticksBelow, int24 ticksAbove) external onlyOwner {
        _setRange(ticksBelow, ticksAbove);
    }

    /// @notice TWAP lookback in seconds, floored at MIN_TWAP_WINDOW so it cannot be made cheap to move.
    function setTwapWindow(uint32 window) external onlyOwner {
        _setTwapWindow(window);
    }

    /// @notice Max deviation vs the TWAP reference on deploy (spot gap + swap output), in bps.
    function setMaxSlippageBps(uint16 bps) external onlyOwner {
        _setMaxSlippageBps(bps);
    }

    /// @notice Range constraints for {addLiquidity}: every new/increased range must satisfy
    ///         `minTick_ <= tickLower < tickUpper <= maxTick_` and `minRangeTicks_ <= width <= maxRangeTicks_`.
    /// @dev Reverts `UniswapV3Adapter__InvalidConstraints` unless MIN_TICK <= minTick_ < maxTick_ <= MAX_TICK, both
    ///      multiples of the tick spacing, 0 < minRangeTicks_ <= maxRangeTicks_ and
    ///      minRangeTicks_ <= maxTick_ - minTick_ and alignUp(minRangeTicks_, spacing) <= maxRangeTicks_ (otherwise no
    ///      range could ever fit: every width is a spacing multiple). Never moves a live
    ///      position; {deploy} / {setRange} are not gated.
    function setRangeConstraints(int24 minTick_, int24 maxTick_, int24 minRangeTicks_, int24 maxRangeTicks_)
        external
        onlyOwner
    {
        _setRangeConstraints(minTick_, maxTick_, minRangeTicks_, maxRangeTicks_);
    }

    /*//////////////////////////////////////////////////////////////
                              VIEW FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc ILiquidityAdapter
    function rangeConstraints() external view returns (int24, int24, int24, int24) {
        return (minTick, maxTick, minRangeTicks, maxRangeTicks);
    }

    /// @inheritdoc ILiquidityAdapter
    function positionState() external view returns (uint256 id, int24 lower, int24 upper, uint128 liquidity, uint32) {
        id = tokenId;
        if (id != 0) {
            (lower, upper, liquidity) = (tickLower, tickUpper, _readPosition(id).liquidity);
        }
        return (id, lower, upper, liquidity, configVersion);
    }

    /// @notice ERC-165: {ILiquidityAdapter} and {ISwapAdapter} (the vault derives its capability bits from these).
    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return interfaceId == type(ILiquidityAdapter).interfaceId || interfaceId == type(ISwapAdapter).interfaceId
            || super.supportsInterface(interfaceId);
    }

    /// @inheritdoc IPositionAdapter
    function dex() external pure returns (bytes32) {
        return DEX_ID;
    }

    /// @inheritdoc IPositionAdapter
    function poolId() external view returns (bytes32) {
        return bytes32(uint256(uint160(address(POOL))));
    }

    /// @inheritdoc IPositionAdapter
    /// @dev `[token0, token1]` = idle + principal at spot `slot0` + tokensOwed + fees accrued since the last
    ///      poke (the pool's feeGrowthInside accounting — no price involved). The fee part is NET of the vault's
    ///      perf fee (fee-at-exit: skimmed whenever fees leave) — what holders can extract; idle and principal
    ///      stay gross.
    function position() external view returns (address[] memory tokens, uint256[] memory amounts) {
        tokens = _tokens();
        amounts = new uint256[](2);
        amounts[0] = TOKEN0.balanceOf(address(this));
        amounts[1] = TOKEN1.balanceOf(address(this));
        uint256 id = tokenId;
        if (id != 0) {
            (uint256 held0, uint256 held1) = _positionAmounts(id);
            amounts[0] += held0;
            amounts[1] += held1;
        }
    }

    /// @notice Arithmetic-mean tick over `twapWindow` (reverts `UniswapV3Adapter__TwapUnavailable` if the pool
    ///         cannot serve it). Exposed so keepers can pre-check the deploy guards off-chain.
    function twapTick() external view returns (int24) {
        return _twapTick();
    }

    /// @notice Dry run of {addLiquidity}'s checks and sizing in the current state (same code path; reverts as it
    ///         would). Lets the keeper see whether a ratio swap will run and size `minSwapOut` before sending.
    /// @return pull0 Token0 that would be pulled from the vault.
    /// @return pull1 Token1 that would be pulled from the vault.
    /// @return zeroForOne Swap direction (token0 → token1) when `swapIn != 0`.
    /// @return swapIn Swap input (0 = no swap; then `minSwapOut` may be 0).
    /// @return twapMinOut The adapter's own floor for that swap (TWAP quote × (1 − maxSlippageBps)).
    function previewAddLiquidity(AddLiquidityParams calldata p)
        external
        view
        returns (uint256 pull0, uint256 pull1, bool zeroForOne, uint256 swapIn, uint256 twapMinOut)
    {
        AddOp memory op = _planAdd(p);
        return (op.pull0, op.pull1, op.zeroForOne, op.swapIn, op.twapMinOut);
    }

    /*//////////////////////////////////////////////////////////////
                       INTERNAL STATE-CHANGING FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @dev Swap the surplus token into the deficit token so holdings match the range's token ratio at the
    ///      TWAP price. Pool fee and our own impact are not modelled: the residual stays idle (reported).
    function _swapToRangeRatio(uint160 sqrtTwapX96, uint160 sqrtLowerX96, uint160 sqrtUpperX96) internal {
        uint256 bal0 = TOKEN0.balanceOf(address(this));
        uint256 bal1 = TOKEN1.balanceOf(address(this));
        (uint256 ref0, uint256 ref1) =
            LiquidityAmounts.getAmountsForLiquidity(sqrtTwapX96, sqrtLowerX96, sqrtUpperX96, REF_LIQUIDITY);
        // Everything in token1 units at the TWAP price (a ratio for sizing — never reported anywhere).
        uint256 ref0In1 = _quote(ref0, sqrtTwapX96, true);
        uint256 held0In1 = _quote(bal0, sqrtTwapX96, true);
        uint256 refTotal = ref0In1 + ref1;
        if (refTotal == 0) {
            return;
        }
        uint256 target0In1 = (held0In1 + bal1).mulDiv(ref0In1, refTotal);
        if (held0In1 > target0In1) {
            _swapExactIn(true, bal0.mulDiv(held0In1 - target0In1, held0In1), sqrtTwapX96);
        } else if (target0In1 > held0In1) {
            _swapExactIn(false, target0In1 - held0In1, sqrtTwapX96);
        }
    }

    /// @dev Single-hop exact-input swap through this adapter's own pool (see {_executeSwap}), output to this adapter.
    ///      `minOut` = TWAP quote haircut by maxSlippageBps; if it rounds to 0 the (dust) swap is skipped — never an
    ///      unbounded swap.
    function _swapExactIn(bool zeroForOne, uint256 amountIn, uint160 sqrtTwapX96) internal {
        uint256 minOut = _twapMinOut(amountIn, sqrtTwapX96, zeroForOne);
        if (minOut == 0) {
            return;
        }
        _executeSwap(zeroForOne, amountIn, minOut);
    }

    /// @dev The swap itself (shared by {deploy} and {addLiquidity}): SWAP_EXECUTOR `swapV3ExactIn` through this pool,
    ///      allowance exactly `amountIn` then reset to 0. The executor delivers to this adapter and owns the Permit2
    ///      layers, the router's min-out mapping and the balance-delta re-check (`SwapExecutor__SlippageExceeded`);
    ///      `minOut` is non-zero by every caller.
    function _executeSwap(bool zeroForOne, uint256 amountIn, uint256 minOut) internal returns (uint256 amountOut) {
        (IERC20 tokenIn, IERC20 tokenOut) = zeroForOne ? (TOKEN0, TOKEN1) : (TOKEN1, TOKEN0);
        tokenIn.forceApprove(address(SWAP_EXECUTOR), amountIn);
        amountOut = SWAP_EXECUTOR.swapV3ExactIn(address(tokenIn), POOL_FEE, address(tokenOut), amountIn, minOut);
        tokenIn.forceApprove(address(SWAP_EXECUTOR), 0);
        emit Swapped(address(tokenIn), amountIn, amountOut, minOut);
    }

    /// @dev Mint (fresh) or increase the position with everything held. Desired = balance − 1 wei per side
    ///      (the pool rounds required amounts up, so an exact balance can come up a wei short). Mins = the
    ///      amounts for the expected liquidity at the current spot, haircut by maxSlippageBps. Spot is
    ///      re-read here because our own swap just moved it; the deploy-time TWAP guard already ran.
    function _addLiquidity(bool fresh, int24 lower, int24 upper, uint160 sqrtLowerX96, uint160 sqrtUpperX96)
        internal
        returns (uint128 liquidity, uint256 used0, uint256 used1)
    {
        uint256 desired0 = _spendable(TOKEN0);
        uint256 desired1 = _spendable(TOKEN1);
        (uint256 min0, uint256 min1) = _liquidityMins(sqrtLowerX96, sqrtUpperX96, desired0, desired1);
        (liquidity, used0, used1) = _mintOrIncrease(fresh, lower, upper, desired0, desired1, min0, min1);
    }

    /// @dev {addLiquidity}'s add: size `liquidity` again at the CURRENT spot (post-swap), cap each side at the op's
    ///      holdings, mint (fresh, at the op's absolute bounds) or increase. NFPM mins 0 (same-call sizing; the
    ///      caller enforces `minLiquidity`).
    function _addExact(AddOp memory op, uint128 liquidity)
        internal
        returns (uint128 added, uint256 used0, uint256 used1)
    {
        (uint160 sqrtSpotX96,,,,,,) = POOL.slot0();
        (uint256 need0, uint256 need1) =
            _amountsForLiquidityUp(sqrtSpotX96, op.sqrtLowerX96, op.sqrtUpperX96, liquidity);
        uint256 desired0 = Math.min(op.avail0, need0);
        uint256 desired1 = Math.min(op.avail1, need1);
        if (
            LiquidityAmounts.getLiquidityForAmounts(sqrtSpotX96, op.sqrtLowerX96, op.sqrtUpperX96, desired0, desired1)
                == 0
        ) {
            revert UniswapV3Adapter__ZeroLiquidity();
        }
        (added, used0, used1) = _mintOrIncrease(op.fresh, op.tickLower, op.tickUpper, desired0, desired1, 0, 0);
    }

    /// @dev Mint (fresh: records the new id + bounds) or increase the live position with exactly `desired` (the NFPM
    ///      adds the max liquidity those amounts buy and takes only what it needs); allowances exact, then zeroed.
    function _mintOrIncrease(
        bool fresh,
        int24 lower,
        int24 upper,
        uint256 desired0,
        uint256 desired1,
        uint256 min0,
        uint256 min1
    ) internal returns (uint128 liquidity, uint256 used0, uint256 used1) {
        TOKEN0.forceApprove(address(POSITION_MANAGER), desired0);
        TOKEN1.forceApprove(address(POSITION_MANAGER), desired1);
        if (fresh) {
            uint256 id;
            (id, liquidity, used0, used1) = POSITION_MANAGER.mint(
                INonfungiblePositionManager.MintParams({
                    token0: address(TOKEN0),
                    token1: address(TOKEN1),
                    fee: POOL_FEE,
                    tickLower: lower,
                    tickUpper: upper,
                    amount0Desired: desired0,
                    amount1Desired: desired1,
                    amount0Min: min0,
                    amount1Min: min1,
                    recipient: address(this),
                    deadline: block.timestamp
                })
            );
            tokenId = id;
            tickLower = lower;
            tickUpper = upper;
            emit PositionMinted(id, lower, upper);
        } else {
            (liquidity, used0, used1) = POSITION_MANAGER.increaseLiquidity(
                INonfungiblePositionManager.IncreaseLiquidityParams({
                    tokenId: tokenId,
                    amount0Desired: desired0,
                    amount1Desired: desired1,
                    amount0Min: min0,
                    amount1Min: min1,
                    deadline: block.timestamp
                })
            );
        }
        // Never leave a standing allowance on the position manager.
        TOKEN0.forceApprove(address(POSITION_MANAGER), 0);
        TOKEN1.forceApprove(address(POSITION_MANAGER), 0);
    }

    /// @dev Burn floor(L * sharesWad / 1e18) liquidity, then collect ALL the principal just released plus
    ///      floor(sharesWad/1e18) of the fees (settled + those the decrease just settled) straight to `to`. The
    ///      rest of the fees stay owed to the position for {harvest}. `fee_i` = collected − principal_i: the collect
    ///      caps are take_i <= tokensOwed_i, so collected == take_i and fee_i is exactly the fee slice.
    function _withdrawFromPosition(uint256 id, uint256 sharesWad, address to)
        internal
        returns (uint256 out0, uint256 out1, uint256 fee0, uint256 fee1)
    {
        uint128 liquidityOut = uint128(uint256(_readPosition(id).liquidity).mulDiv(sharesWad, WAD));
        uint256 principal0;
        uint256 principal1;
        if (liquidityOut != 0) {
            (principal0, principal1) = _decreaseLiquidity(id, liquidityOut, 0, 0);
        }
        // After a decrease, tokensOwed = fees + the principal just released.
        PositionInfo memory p = _readPosition(id);
        uint256 take0 = principal0 + (p.tokensOwed0 - principal0).mulDiv(sharesWad, WAD);
        uint256 take1 = principal1 + (p.tokensOwed1 - principal1).mulDiv(sharesWad, WAD);
        if (take0 != 0 || take1 != 0) {
            // take_i <= tokensOwed_i (a uint128), so the casts are lossless.
            (out0, out1) = _collect(id, to, uint128(take0), uint128(take1));
            fee0 = out0 - principal0;
            fee1 = out1 - principal1;
        }
    }

    /// @dev `min0/min1` are the NFPM's principal floors: 0 on the in-kind paths (a redemption must never be blocked),
    ///      the caller's floors on {removeLiquidity}.
    function _decreaseLiquidity(uint256 id, uint128 liquidity, uint256 min0, uint256 min1)
        internal
        returns (uint256 amount0, uint256 amount1)
    {
        (amount0, amount1) = POSITION_MANAGER.decreaseLiquidity(
            INonfungiblePositionManager.DecreaseLiquidityParams({
                tokenId: id, liquidity: liquidity, amount0Min: min0, amount1Min: min1, deadline: block.timestamp
            })
        );
    }

    /// @dev Precise ops' only destination: the vault (hard-wired). Zero amounts are skipped.
    function _sendToVault(uint256 amount0, uint256 amount1) internal {
        if (amount0 != 0) {
            TOKEN0.safeTransfer(VAULT, amount0);
        }
        if (amount1 != 0) {
            TOKEN1.safeTransfer(VAULT, amount1);
        }
    }

    function _collect(uint256 id, address recipient, uint128 max0, uint128 max1)
        internal
        returns (uint256 amount0, uint256 amount1)
    {
        (amount0, amount1) = POSITION_MANAGER.collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: id, recipient: recipient, amount0Max: max0, amount1Max: max1
            })
        );
    }

    /// @dev Effects before the burn interactions: forget the live position.
    function _clearPosition() internal {
        tokenId = 0;
        tickLower = 0;
        tickUpper = 0;
    }

    function _setRange(int24 ticksBelow, int24 ticksAbove) internal {
        if (ticksBelow <= 0 || ticksAbove <= 0 || ticksBelow > TickMath.MAX_TICK || ticksAbove > TickMath.MAX_TICK) {
            revert UniswapV3Adapter__InvalidRange(ticksBelow, ticksAbove);
        }
        rangeTicksBelow = ticksBelow;
        rangeTicksAbove = ticksAbove;
        emit RangeSet(ticksBelow, ticksAbove);
        _bumpConfig();
    }

    function _setTwapWindow(uint32 window) internal {
        if (window < MIN_TWAP_WINDOW || window > MAX_TWAP_WINDOW) {
            revert UniswapV3Adapter__TwapWindowOutOfRange(window, MIN_TWAP_WINDOW, MAX_TWAP_WINDOW);
        }
        emit TwapWindowSet(twapWindow, window);
        twapWindow = window;
        _bumpConfig();
    }

    function _setMaxSlippageBps(uint16 bps) internal {
        if (bps < MIN_SLIPPAGE_BPS || bps > MAX_SLIPPAGE_BPS) {
            revert UniswapV3Adapter__SlippageOutOfRange(bps, MIN_SLIPPAGE_BPS, MAX_SLIPPAGE_BPS);
        }
        emit MaxSlippageSet(maxSlippageBps, bps);
        maxSlippageBps = bps;
        _bumpConfig();
    }

    function _setRangeConstraints(int24 minTick_, int24 maxTick_, int24 minRangeTicks_, int24 maxRangeTicks_) internal {
        int24 spacing = TICK_SPACING;
        if (
            minTick_ < TickMath.MIN_TICK || maxTick_ > TickMath.MAX_TICK || minTick_ >= maxTick_
                || minTick_ % spacing != 0 || maxTick_ % spacing != 0 || minRangeTicks_ <= 0
                || minRangeTicks_ > maxRangeTicks_
                // Satisfiable iff the narrowest legal width (minRangeTicks_ aligned up to the spacing — every width
                // is a spacing multiple) fits both the box (itself a spacing multiple, so comparing minRangeTicks_
                // is exact) and maxRangeTicks_. No int24 overflow: by now 0 < minRangeTicks_ <= 1,774,544.
                || minRangeTicks_ > maxTick_ - minTick_ || _ceilToSpacing(minRangeTicks_, spacing) > maxRangeTicks_
        ) {
            revert UniswapV3Adapter__InvalidConstraints(minTick_, maxTick_, minRangeTicks_, maxRangeTicks_);
        }
        minTick = minTick_;
        maxTick = maxTick_;
        minRangeTicks = minRangeTicks_;
        maxRangeTicks = maxRangeTicks_;
        emit RangeConstraintsSet(minTick_, maxTick_, minRangeTicks_, maxRangeTicks_);
        _bumpConfig();
    }

    /// @dev Every owner config change moves the plan pin ({positionState}). Cannot realistically wrap (uint32).
    function _bumpConfig() private {
        unchecked {
            ++configVersion;
        }
    }

    /*//////////////////////////////////////////////////////////////
                         INTERNAL READ-ONLY FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @dev {onlyVault}'s check, out of line (one copy instead of one per vault-only function — EIP-170 budget).
    function _checkVault() private view {
        if (msg.sender != VAULT) {
            revert UniswapV3Adapter__OnlyVault();
        }
    }

    /// @dev `nfpm.factory()`, or address(0) unless it answers with exactly one word. A router wired to another
    ///      chain reports that chain's NFPM address, which here may be empty OR hold unrelated code (on RHC the
    ///      mainnet NFPM address is a proxy whose fallback returns nothing) — both must fail typed, not bubble.
    function _factoryOf(address nfpm) internal view returns (address) {
        (bool ok, bytes memory ret) = nfpm.staticcall(abi.encodeCall(INonfungiblePositionManager.factory, ()));
        if (!ok || ret.length != 32) {
            return address(0);
        }
        return abi.decode(ret, (address));
    }

    function _tokens() internal view returns (address[] memory tokens) {
        tokens = new address[](2);
        tokens[0] = address(TOKEN0);
        tokens[1] = address(TOKEN1);
    }

    function _spendable(IERC20 token) internal view returns (uint256) {
        uint256 bal = token.balanceOf(address(this));
        return bal == 0 ? 0 : bal - 1;
    }

    function _readPosition(uint256 id) internal view returns (PositionInfo memory p) {
        (
            ,,,,,
            p.tickLower,
            p.tickUpper,
            p.liquidity,
            p.feeGrowthInside0LastX128,
            p.feeGrowthInside1LastX128,
            p.tokensOwed0,
            p.tokensOwed1
        ) = POSITION_MANAGER.positions(id);
    }

    /// @dev Principal at spot + fees (tokensOwed + accrued since the position's last poke) NET of the vault's
    ///      live perf fee: fees − floor(fees * bps / 10_000), the same floor as the vault's exit-path `cut`.
    function _positionAmounts(uint256 id) internal view returns (uint256 amount0, uint256 amount1) {
        PositionInfo memory p = _readPosition(id);
        (uint160 sqrtSpotX96, int24 spotTick,,,,,) = POOL.slot0();
        (amount0, amount1) = LiquidityAmounts.getAmountsForLiquidity(
            sqrtSpotX96, TickMath.getSqrtRatioAtTick(p.tickLower), TickMath.getSqrtRatioAtTick(p.tickUpper), p.liquidity
        );
        (uint256 fee0, uint256 fee1) = _pendingFees(p, spotTick);
        uint256 bps = IPoolmigoVault(VAULT).performanceFeeBps();
        fee0 += p.tokensOwed0;
        fee1 += p.tokensOwed1;
        amount0 += fee0 - fee0.mulDiv(bps, BPS_DENOMINATOR);
        amount1 += fee1 - fee1.mulDiv(bps, BPS_DENOMINATOR);
    }

    /// @dev Mins for adding `desired` at the current spot: the amounts the expected liquidity needs,
    ///      haircut by maxSlippageBps (rounding headroom). Reverts if the holdings buy no liquidity.
    function _liquidityMins(uint160 sqrtLowerX96, uint160 sqrtUpperX96, uint256 desired0, uint256 desired1)
        internal
        view
        returns (uint256 min0, uint256 min1)
    {
        (uint160 sqrtSpotX96,,,,,,) = POOL.slot0();
        uint128 expected =
            LiquidityAmounts.getLiquidityForAmounts(sqrtSpotX96, sqrtLowerX96, sqrtUpperX96, desired0, desired1);
        if (expected == 0) {
            revert UniswapV3Adapter__ZeroLiquidity();
        }
        (min0, min1) = LiquidityAmounts.getAmountsForLiquidity(sqrtSpotX96, sqrtLowerX96, sqrtUpperX96, expected);
        uint256 keep = BPS_DENOMINATOR - maxSlippageBps;
        min0 = min0.mulDiv(keep, BPS_DENOMINATOR);
        min1 = min1.mulDiv(keep, BPS_DENOMINATOR);
    }

    /// @dev {addLiquidity} / {previewAddLiquidity}: parameter + constraint checks, the {deploy} price guards, then
    ///      the pull / swap sizing (see {addLiquidity}). Reverts exactly as {addLiquidity} would before any transfer.
    function _planAdd(AddLiquidityParams memory p) internal view returns (AddOp memory op) {
        _checkAdd(p);
        op.fresh = tokenId == 0;
        op.tickLower = p.tickLower;
        op.tickUpper = p.tickUpper;
        op.sqrtLowerX96 = TickMath.getSqrtRatioAtTick(p.tickLower);
        op.sqrtUpperX96 = TickMath.getSqrtRatioAtTick(p.tickUpper);

        (int24 twapTick_, uint160 sqrtSpotX96) = _guardedTwapTick();
        uint160 sqrtTwapX96 = TickMath.getSqrtRatioAtTick(twapTick_);

        (uint256 need0, uint256 need1) =
            _amountsForLiquidityUp(sqrtSpotX96, op.sqrtLowerX96, op.sqrtUpperX96, p.liquidity);
        (uint256 cap0, uint256 cap1) = (p.maxAmount0, p.maxAmount1);
        if (need0 > cap0 && need1 < cap1) {
            // token0 short, token1 has room: buy the shortfall with token1.
            op.swapIn = Math.min(_grossUp(_quote(need0 - cap0, sqrtTwapX96, true)), cap1 - need1);
        } else if (need1 > cap1 && need0 < cap0) {
            // token1 short, token0 has room: buy the shortfall with token0.
            op.zeroForOne = true;
            op.swapIn = Math.min(_grossUp(_quote(need1 - cap1, sqrtTwapX96, false)), cap0 - need0);
        }
        if (op.swapIn != 0) {
            op.twapMinOut = _twapMinOut(op.swapIn, sqrtTwapX96, op.zeroForOne);
            if (op.twapMinOut == 0) {
                op.swapIn = 0; // dust: skipped, as in {deploy} — never an unbounded swap
            }
        }
        op.pull0 = Math.min(need0, cap0);
        op.pull1 = Math.min(need1, cap1);
        if (op.swapIn != 0) {
            if (op.zeroForOne) {
                op.pull0 += op.swapIn;
            } else {
                op.pull1 += op.swapIn;
            }
        }
    }

    /// @dev Parameter + constraint checks for {addLiquidity} (error order documented there). The bound checks run
    ///      before the width is computed, so `tickUpper - tickLower` cannot overflow int24.
    function _checkAdd(AddLiquidityParams memory p) internal view {
        if (p.liquidity == 0) {
            revert UniswapV3Adapter__ZeroLiquidity();
        }
        if (p.minLiquidity > p.liquidity) {
            revert UniswapV3Adapter__InvalidMinLiquidity(p.minLiquidity, p.liquidity);
        }
        int24 lower = p.tickLower;
        int24 upper = p.tickUpper;
        if (lower >= upper) {
            revert UniswapV3Adapter__InvalidRange(lower, upper);
        }
        int24 spacing = TICK_SPACING;
        if (lower % spacing != 0 || upper % spacing != 0) {
            revert UniswapV3Adapter__UnalignedRange(lower, upper, spacing);
        }
        // Short-circuit: the width is only computed once both bounds sit inside the box (no int24 overflow).
        if (lower < minTick || upper > maxTick || upper - lower < minRangeTicks || upper - lower > maxRangeTicks) {
            revert UniswapV3Adapter__RangeOutsideConstraints(lower, upper);
        }
        if (tokenId != 0 && (lower != tickLower || upper != tickUpper)) {
            revert UniswapV3Adapter__RangeMismatch(tickLower, tickUpper, lower, upper);
        }
    }

    /// @dev Amounts `liquidity` needs at `sqrtSpotX96`, +1 wei per non-zero side: the pool rounds what it charges
    ///      up (at most +1 over the floored LiquidityAmounts value), and the NFPM must re-derive >= `liquidity`.
    function _amountsForLiquidityUp(uint160 sqrtSpotX96, uint160 sqrtLowerX96, uint160 sqrtUpperX96, uint128 liquidity)
        internal
        pure
        returns (uint256 amount0, uint256 amount1)
    {
        (amount0, amount1) = LiquidityAmounts.getAmountsForLiquidity(sqrtSpotX96, sqrtLowerX96, sqrtUpperX96, liquidity);
        if (amount0 != 0) {
            ++amount0;
        }
        if (amount1 != 0) {
            ++amount1;
        }
    }

    /// @dev TWAP quote of `amountIn` haircut by maxSlippageBps — the adapter's own swap floor (deploy + addLiquidity).
    function _twapMinOut(uint256 amountIn, uint160 sqrtTwapX96, bool zeroForOne) internal view returns (uint256) {
        return _quote(amountIn, sqrtTwapX96, zeroForOne).mulDiv(BPS_DENOMINATOR - maxSlippageBps, BPS_DENOMINATOR);
    }

    /// @dev Swap input whose TWAP min-out covers `amountOutAtTwap`: amount / (1 − maxSlippageBps), rounded up.
    function _grossUp(uint256 amountOutAtTwap) internal view returns (uint256) {
        return amountOutAtTwap.mulDiv(BPS_DENOMINATOR, BPS_DENOMINATOR - maxSlippageBps, Math.Rounding.Ceil);
    }

    /// @dev Arithmetic-mean tick over `twapWindow`, rounded toward negative infinity (Uniswap convention).
    ///      The pool reverts ("OLD") when its history is shorter than the window — surfaced as a typed error,
    ///      never a spot fallback.
    function _twapTick() internal view returns (int24 meanTick) {
        uint32 window = twapWindow;
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = window;
        try POOL.observe(secondsAgos) returns (int56[] memory tickCumulatives, uint160[] memory) {
            int56 delta = tickCumulatives[1] - tickCumulatives[0];
            int56 windowI56 = int56(uint56(window));
            meanTick = int24(delta / windowI56);
            if (delta < 0 && delta % windowI56 != 0) {
                meanTick--;
            }
        } catch {
            revert UniswapV3Adapter__TwapUnavailable(window);
        }
    }

    /// @dev The {deploy} / {addLiquidity} / {swapExactIn} price guards: TWAP available and spot within maxSlippageBps
    ///      ticks of it. Returns the TWAP tick and the spot price.
    function _guardedTwapTick() internal view returns (int24 twapTick_, uint160 sqrtSpotX96) {
        twapTick_ = _twapTick();
        int24 spotTick;
        (sqrtSpotX96, spotTick,,,,,) = POOL.slot0();
        _requireSpotNearTwap(spotTick, twapTick_);
    }

    /// @dev One tick ≈ one basis point of price, so the tick gap doubles as a bps deviation bound.
    function _requireSpotNearTwap(int24 spotTick, int24 twapTick_) internal view {
        int256 gap = int256(spotTick) - int256(twapTick_);
        if (gap < 0) {
            gap = -gap;
        }
        if (gap > int256(uint256(maxSlippageBps))) {
            revert UniswapV3Adapter__SpotDeviatesFromTwap(spotTick, twapTick_, maxSlippageBps);
        }
    }

    /// @dev [center − rangeTicksBelow, center + rangeTicksAbove], snapped OUTWARD to tickSpacing and clamped
    ///      to the usable tick domain. int24 cannot overflow: |center| and each offset are <= MAX_TICK < 2^22.
    function _computeRange(int24 centerTick) internal view returns (int24 lower, int24 upper) {
        int24 spacing = TICK_SPACING;
        lower = _floorToSpacing(centerTick - rangeTicksBelow, spacing);
        upper = _ceilToSpacing(centerTick + rangeTicksAbove, spacing);
        int24 minUsable = _ceilToSpacing(TickMath.MIN_TICK, spacing);
        int24 maxUsable = _floorToSpacing(TickMath.MAX_TICK, spacing);
        if (lower < minUsable) {
            lower = minUsable;
        }
        if (upper > maxUsable) {
            upper = maxUsable;
        }
    }

    function _floorToSpacing(int24 tick, int24 spacing) internal pure returns (int24) {
        int24 compressed = tick / spacing;
        if (tick < 0 && tick % spacing != 0) {
            compressed--;
        }
        return compressed * spacing;
    }

    function _ceilToSpacing(int24 tick, int24 spacing) internal pure returns (int24) {
        int24 compressed = tick / spacing;
        if (tick > 0 && tick % spacing != 0) {
            compressed++;
        }
        return compressed * spacing;
    }

    /// @dev Fees accrued to the position but not yet settled into tokensOwed (mirrors Tick.getFeeGrowthInside +
    ///      Position.update in v3-core). The pool's own accounting, not a price.
    function _pendingFees(PositionInfo memory p, int24 currentTick) internal view returns (uint256 fee0, uint256 fee1) {
        if (p.liquidity == 0) {
            return (0, 0);
        }
        (uint256 inside0X128, uint256 inside1X128) = _feeGrowthInside(p.tickLower, p.tickUpper, currentTick);
        // Fee growth is a counter that intentionally wraps (v3-core semantics).
        unchecked {
            fee0 = Math.mulDiv(inside0X128 - p.feeGrowthInside0LastX128, p.liquidity, 1 << 128);
            fee1 = Math.mulDiv(inside1X128 - p.feeGrowthInside1LastX128, p.liquidity, 1 << 128);
        }
    }

    function _feeGrowthInside(int24 lower, int24 upper, int24 currentTick)
        internal
        view
        returns (uint256 inside0X128, uint256 inside1X128)
    {
        bool aboveLower = currentTick >= lower;
        bool belowUpper = currentTick < upper;
        (,, uint256 lowerOutside0X128, uint256 lowerOutside1X128,,,,) = POOL.ticks(lower);
        (,, uint256 upperOutside0X128, uint256 upperOutside1X128,,,,) = POOL.ticks(upper);
        inside0X128 = _feeGrowthInsideOne(
            POOL.feeGrowthGlobal0X128(), lowerOutside0X128, upperOutside0X128, aboveLower, belowUpper
        );
        inside1X128 = _feeGrowthInsideOne(
            POOL.feeGrowthGlobal1X128(), lowerOutside1X128, upperOutside1X128, aboveLower, belowUpper
        );
    }

    function _feeGrowthInsideOne(
        uint256 globalX128,
        uint256 lowerOutsideX128,
        uint256 upperOutsideX128,
        bool aboveLower,
        bool belowUpper
    ) internal pure returns (uint256 insideX128) {
        unchecked {
            uint256 below = aboveLower ? lowerOutsideX128 : globalX128 - lowerOutsideX128;
            uint256 above = belowUpper ? upperOutsideX128 : globalX128 - upperOutsideX128;
            insideX128 = globalX128 - below - above;
        }
    }

    /// @dev Convert `amountIn` of one pool token into the other at `sqrtPriceX96` (no fee). Mirrors
    ///      OracleLibrary.getQuoteAtTick: Q192 ratio when it fits, else Q128. zeroForOne = token0 → token1.
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
}
