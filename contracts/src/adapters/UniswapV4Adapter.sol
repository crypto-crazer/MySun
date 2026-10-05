// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {ERC165} from "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

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
import {PoolKey, IPoolManagerMinimal} from "contracts/adapters/uniswap/v4/IPoolManagerMinimal.sol";
import {IPositionManagerMinimal} from "contracts/adapters/uniswap/v4/IPositionManagerMinimal.sol";
import {IPermit2Minimal} from "contracts/adapters/uniswap/v4/IPermit2Minimal.sol";
import {V4Actions} from "contracts/adapters/uniswap/v4/V4Actions.sol";
import {V4StateReader} from "contracts/adapters/uniswap/v4/V4StateReader.sol";

/**
 * @title UniswapV4Adapter
 * @author MySun
 * @notice ONE Uniswap v4 concentrated-liquidity position on ONE plain (hookless) v4 pool, operated by the
 *         MySun vault through {IPositionAdapter}. Speaks token vectors only — `[currency0, currency1]` in
 *         POOL order, stable for the adapter's lifetime. No USD, no NAV, no valuation scalar anywhere.
 *
 *         - {position}: idle balances (incl. banked fees) + position principal at the v4 pool's SPOT + fees
 *           accrued in the PoolManager. Spot is the accepted read (IPositionAdapter NatSpec): a manipulated
 *           read can only over-price a depositor, and the vault enforces a non-zero `minShares`.
 *         - {deploy}: pulls the vault's amounts, then — the ONLY swap path — swaps the surplus token into the
 *           deficit token so holdings match the range's ratio, and adds all free holdings as liquidity through
 *           the v4 PositionManager (`modifyLiquidities`, token flows via Permit2).
 *         - {withdrawProportional} / {harvest} / {unwindAll}: in kind, NEVER swap, never read the TWAP (an
 *           oracle outage can never block a redemption).
 *
 *         Price reference: the v4 PoolManager exposes no TWAP, so the reference is a DEEP v3 pool of the same pair
 *         (`REF_POOL`, `observe()` over `twapWindow` >= 300s) — in BOTH swap venues.
 *         Swap venue (owner switch {setSwapVenue}, default `V3_REF_POOL`): swaps execute through the shared,
 *         stateless `SWAP_EXECUTOR` (UniversalRouterSwapExecutor, strategy layer P1c) on the official Uniswap
 *         UniversalRouter (2.1.x) either on REF_POOL (`V3_SWAP_EXACT_IN` — reference and traded venue coincide;
 *         on RHC the fee-100 USDG/WETH v3 pool is the chain's deepest liquidity for the pair) or on this adapter's
 *         own hookless v4 pool (`V4_SWAP`: SWAP_EXACT_IN_SINGLE + SETTLE + TAKE — for pairs whose deepest venue is
 *         v4). Only these two constructor-validated venues exist; nothing is caller-supplied.
 *         Swap guards (deploy only, identical in both venues):
 *         - Sizing AND bounds use the REF_POOL TWAP tick. Never raw spot. Too-short history →
 *           `UniswapV4Adapter__TwapUnavailable`, no spot fallback.
 *         - The v4 pool's spot (the mint price) must sit within `maxSlippageBps` ticks of the TWAP (1 tick ≈ 1bp),
 *           else `UniswapV4Adapter__SpotDeviatesFromTwap` — no swapping or minting into a moved/manipulated pool.
 *           The budget must also cover the normal cross-venue basis (fee-tier arbitrage band).
 *         - Every swap is exact-input, sized to at most the surplus held, and carries
 *           `amountOutMinimum = TWAP quote × (1 − maxSlippageBps)`; a breach reverts
 *           `ISwapExecutor.SwapExecutor__SlippageExceeded` (router min-out error mapped; the balance delta
 *           re-checked by the executor). The adapter approves the executor exactly amountIn and resets it to 0
 *           after; the executor runs the Permit2 layers (exact, zeroed per call); recipient / TAKE target is always
 *           this adapter. The executor's router must be `swapRouter` (checked at construction).
 *         - On the v4 venue the swap moves the v4 spot (the mint price); liquidity is sized at the post-swap spot,
 *           and the swap's own min-out bounds how far it can move it.
 *
 *         Fees (v4 has no `tokensOwed`: every liquidity modification settles the position's accrued fees into the
 *         caller's delta): before any principal flow the adapter collects fees only (`DECREASE_LIQUIDITY` with
 *         liquidity 0 + `TAKE_PAIR`) into a BANK (`bankedFees0/1`). Banked fees are never re-deployed as
 *         principal; {harvest} sends the bank to the vault; a redemption takes only its pro-rata slice of the bank,
 *         exactly like the v3 adapter's fee slice — redemptions cannot sweep the remaining fees. Every exit path
 *         reports the fee part it delivers (harvest = all fees; withdraw / unwind / remove return the split) and the
 *         vault skims its perf fee on it.
 *
 *         Range (quant-owned, owner-settable, nothing hardcoded): a fresh position spans
 *         [twapTick − rangeTicksBelow, twapTick + rangeTicksAbove], snapped outward to the pool's tickSpacing.
 *         Later deploys add to the SAME range. Re-range = keeper `pullFrom(adapter, 10_000)` (burns the NFT) →
 *         `deployTo` (mints at the then-current TWAP with the then-current params).
 *
 *         Precise liquidity ({ILiquidityAdapter}, strategy layer P1b — the v4 mirror of the v3 adapter's P1 surface,
 *         same external semantics): the keeper (through the vault) adds an exact raw liquidity at absolute bounds
 *         ({addLiquidity}) or removes an exact raw liquidity ({removeLiquidity}), inside the owner's range constraints
 *         ({setRangeConstraints}). Both run on this adapter's own v4 pool; raw liquidity is the PositionManager's
 *         native unit and every amount is sized at the v4 pool's own spot (the price the PoolManager settles at).
 *         {addLiquidity} runs the {deploy} guards (REF_POOL TWAP, v4 spot near it) and its ratio swap goes through
 *         the same venue logic + the caller's own floor; {removeLiquidity} is in kind (no swap, no TWAP read) and,
 *         as v4 has no `amount0Min/amount1Min` of its own on the PoolManager, enforces the caller's principal floors
 *         itself on the settled principal. Fees are banked before every modification, so banked fees never become
 *         principal on these paths either.
 *
 *         Swap capability ({ISwapAdapter}, strategy layer P3): {swapExactIn} swaps vault idle handed over for the call
 *         through the same guarded path as {deploy} (REF_POOL TWAP + v4 spot guard, TWAP floor, SWAP_EXECUTOR on the
 *         `swapVenue`), the caller's floor applying when stricter, and returns the full output to the vault. ERC-165
 *         advertises both capabilities; {positionState} is the plan pin (live position + `configVersion`, bumped by
 *         every owner setter, the venue switch included).
 *
 * @dev The adapter owns the v4 position NFT (the PositionManager mints with `_mint`, no receiver hook). Only
 *      hookless pools are accepted (PRD §8 #12: plain pool). Not audited. Owner must be a multisig.
 * @custom:security-contact security@mysun.example
 */
contract UniswapV4Adapter is
    IPositionAdapter,
    ILiquidityAdapter,
    ISwapAdapter,
    ERC165,
    Ownable2Step,
    ReentrancyGuardTransient
{
    using SafeERC20 for IERC20;
    using SafeCast for uint256;
    using Math for uint256;

    /*//////////////////////////////////////////////////////////////
                                 TYPES
    //////////////////////////////////////////////////////////////*/

    struct Config {
        address vault; // sole caller of deploy / withdrawProportional / harvest / unwindAll
        address positionManager; // v4 PositionManager — its PoolManager and Permit2 are read from it
        PoolKey poolKey; // the v4 pool (hooks must be 0) — its fee tier is the §8 #1 / quant choice
        address refPool; // v3 pool of the same pair: TWAP reference AND the default swap venue
        address swapRouter; // Uniswap UniversalRouter 2.1.x (V3_SWAP_EXACT_IN / V4_SWAP) — venue-checked here
        address swapExecutor; // UniversalRouterSwapExecutor on exactly (swapRouter, POSM's Permit2) — runs swaps
        address owner; // parameter admin (multisig)
        int24 rangeTicksBelow; // fresh range: ticks below the TWAP tick
        int24 rangeTicksAbove; // fresh range: ticks above the TWAP tick
        uint32 twapWindow; // seconds, [MIN_TWAP_WINDOW, MAX_TWAP_WINDOW]
        uint16 maxSlippageBps; // [MIN_SLIPPAGE_BPS, MAX_SLIPPAGE_BPS]
    }

    /// @notice Where {deploy}'s ratio swap executes (both through the UniversalRouter; REF_POOL stays the TWAP
    ///         reference either way).
    enum SwapVenue {
        V3_REF_POOL, // REF_POOL (v3) — default
        V4_POOL // this adapter's own v4 pool (poolKey)
    }

    /// @dev Working state of one {addLiquidity} call (memory — keeps the stack shallow).
    struct AddOp {
        int24 tickLower;
        int24 tickUpper;
        uint160 sqrtLowerX96;
        uint160 sqrtUpperX96;
        uint256 pull0; // pulled from the vault (<= cap)
        uint256 pull1;
        bool zeroForOne; // swap direction (token0 -> token1) when swapIn != 0
        uint256 swapIn; // 0 = no swap
        uint256 twapMinOut; // TWAP quote of swapIn x (1 - maxSlippageBps)
        uint256 avail0; // this op's holdings (pulled ± swap) — the settle cap and refund base; idle + bank excluded
        uint256 avail1;
    }

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error UniswapV4Adapter__OnlyVault();
    error UniswapV4Adapter__ZeroAddress();
    error UniswapV4Adapter__LengthMismatch();
    error UniswapV4Adapter__InvalidSharesWad(uint256 sharesWad);
    error UniswapV4Adapter__HooksNotSupported(address hooks);
    error UniswapV4Adapter__PoolNotInitialized(bytes32 poolId);
    error UniswapV4Adapter__VenueMismatch(address refPool);
    error UniswapV4Adapter__RouterMismatch(address router);
    error UniswapV4Adapter__NoCode(address account);
    /// @dev The swap executor is not wired to this adapter's (swapRouter, Permit2).
    error UniswapV4Adapter__ExecutorMismatch(address executor);
    error UniswapV4Adapter__InvalidRange(int24 ticksBelow, int24 ticksAbove);
    error UniswapV4Adapter__TwapWindowOutOfRange(uint32 window, uint32 min, uint32 max);
    error UniswapV4Adapter__SlippageOutOfRange(uint16 bps, uint16 min, uint16 max);
    error UniswapV4Adapter__TwapUnavailable(uint32 window);
    error UniswapV4Adapter__SpotDeviatesFromTwap(int24 spotTick, int24 twapTick, uint16 maxSlippageBps);
    error UniswapV4Adapter__ZeroLiquidity();
    /// @dev {setRangeConstraints}: need MIN_TICK <= minTick < maxTick <= MAX_TICK, both spacing-aligned, and
    ///      0 < minRangeTicks <= maxRangeTicks, minRangeTicks <= maxTick - minTick and minRangeTicks aligned up to
    ///      the tick spacing <= maxRangeTicks (some legal width fits — exactly the satisfiable boxes).
    error UniswapV4Adapter__InvalidConstraints(int24 minTick, int24 maxTick, int24 minRangeTicks, int24 maxRangeTicks);
    /// @dev {addLiquidity}: a bound is not a multiple of the pool key's tick spacing.
    error UniswapV4Adapter__UnalignedRange(int24 tickLower, int24 tickUpper, int24 tickSpacing);
    /// @dev {addLiquidity}: bounds outside [minTick, maxTick] or width outside [minRangeTicks, maxRangeTicks].
    error UniswapV4Adapter__RangeOutsideConstraints(int24 tickLower, int24 tickUpper);
    /// @dev {addLiquidity}: a live position exists with other bounds — close the position first
    ///      (vault `pullFrom(adapter, 10_000)` burns it), then add at the new bounds.
    error UniswapV4Adapter__RangeMismatch(int24 liveLower, int24 liveUpper, int24 tickLower, int24 tickUpper);
    /// @dev {addLiquidity}: `minLiquidity` above the target `liquidity`.
    error UniswapV4Adapter__InvalidMinLiquidity(uint128 minLiquidity, uint128 liquidity);
    /// @dev {addLiquidity}: the op needs a ratio swap but the caller gave no explicit floor (`minSwapOut == 0`).
    error UniswapV4Adapter__ZeroMinSwapOut(address tokenIn, uint256 amountIn);
    /// @dev {addLiquidity}: the liquidity actually added is below `minLiquidity`.
    error UniswapV4Adapter__LiquidityBelowMin(uint128 actual, uint128 minLiquidity);
    /// @dev {removeLiquidity}: more liquidity requested than the live position holds (0 when there is none).
    error UniswapV4Adapter__InsufficientLiquidity(uint128 requested, uint128 available);
    /// @dev {removeLiquidity} idle-refund mode (`liquidity == 0`) releases no principal, so a non-zero principal
    ///      floor can never be met — idle must never satisfy it.
    error UniswapV4Adapter__PrincipalFloorInIdleMode(uint256 minPrincipal0, uint256 minPrincipal1);
    /// @dev {removeLiquidity}: the principal the removal settled is below a caller floor (fees never count toward
    ///      it). The v4 PoolManager has no amount mins of its own, so the adapter enforces them.
    error UniswapV4Adapter__PrincipalBelowFloor(
        uint256 principal0, uint256 principal1, uint256 minPrincipal0, uint256 minPrincipal1
    );
    /// @dev {swapExactIn}: `amountIn == 0`, or (tokenIn, tokenOut) is not (token0, token1) / (token1, token0).
    error UniswapV4Adapter__InvalidSwap(address tokenIn, address tokenOut, uint256 amountIn);

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    event RangeSet(int24 ticksBelow, int24 ticksAbove);
    event TwapWindowSet(uint32 oldWindow, uint32 newWindow);
    event MaxSlippageSet(uint16 oldBps, uint16 newBps);
    event PositionMinted(uint256 indexed tokenId, int24 tickLower, int24 tickUpper);
    event PositionBurned(uint256 indexed tokenId);
    event FeesBanked(uint256 amount0, uint256 amount1);
    event SwapVenueSet(SwapVenue oldVenue, SwapVenue newVenue);
    event Swapped(address indexed tokenIn, uint256 amountIn, uint256 amountOut, uint256 minAmountOut, SwapVenue venue);
    event LiquidityDeployed(uint256 pulled0, uint256 pulled1, uint256 used0, uint256 used1, uint128 liquidity);
    event Withdrawn(address indexed to, uint256 sharesWad, uint256 amount0, uint256 amount1);
    event Harvested(uint256 amount0, uint256 amount1);
    event Unwound(address indexed to, uint256 amount0, uint256 amount1);
    event RangeConstraintsSet(int24 minTick, int24 maxTick, int24 minRangeTicks, int24 maxRangeTicks);
    /// @dev spent = added into the position (post-swap); refunded = this op's leftover returned to the vault.
    event LiquidityAdded(
        uint256 indexed tokenId, uint128 liquidity, uint256 spent0, uint256 spent1, uint256 refunded0, uint256 refunded1
    );
    /// @dev fees = the whole bank (earlier banked fees + those this removal settled) — never part of principal.
    event LiquidityRemoved(
        uint256 indexed tokenId, uint128 liquidity, uint256 principal0, uint256 principal1, uint256 fees0, uint256 fees1
    );
    event IdleRefunded(uint256 amount0, uint256 amount1);

    /*//////////////////////////////////////////////////////////////
                               CONSTANTS
    //////////////////////////////////////////////////////////////*/

    bytes32 public constant DEX_ID = keccak256("UNISWAP_V4");
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
    IPositionManagerMinimal public immutable POSITION_MANAGER;
    IPoolManagerMinimal public immutable POOL_MANAGER;
    IPermit2Minimal public immutable PERMIT2;
    IUniswapV3PoolMinimal public immutable REF_POOL;
    ISwapExecutor public immutable SWAP_EXECUTOR;
    IERC20 public immutable TOKEN0;
    IERC20 public immutable TOKEN1;
    uint24 public immutable POOL_FEE;
    int24 public immutable TICK_SPACING;
    uint24 public immutable REF_POOL_FEE;
    bytes32 public immutable POOL_ID;

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

    /// @notice Fees already collected out of the PoolManager into this adapter's balance, owed to the next
    ///         {harvest}. Part of the idle balance; never deployed as principal.
    uint256 public bankedFees0;
    uint256 public bankedFees1;

    /// @notice Where the next {deploy}'s ratio swap executes (owner switch; default V3_REF_POOL).
    SwapVenue public swapVenue;

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

    /// @dev Checks the venues are coherent: a hookless, initialized v4 pool on the PositionManager's PoolManager;
    ///      a v3 reference pool of the SAME ordered pair that is its factory's canonical pool; and a router wired to
    ///      BOTH: its `poolManager()` is that PoolManager and its `V3_POSITION_MANAGER()` sits on the reference
    ///      pool's factory (2.1.x has no `factory()`) — a router wired to another chain's deployment (e.g. the
    ///      mainnet copy on RHC) fails. Router, Permit2 and the swap executor must have code, and the executor must
    ///      run on exactly that router and Permit2 (`__ExecutorMismatch`) — the venues validated here are the ones
    ///      every swap uses.
    constructor(Config memory cfg) Ownable(cfg.owner) {
        PoolKey memory key = cfg.poolKey;
        if (
            cfg.vault == address(0) || cfg.positionManager == address(0) || cfg.refPool == address(0)
                || cfg.swapRouter == address(0) || cfg.swapExecutor == address(0) || key.currency0 == address(0)
        ) {
            revert UniswapV4Adapter__ZeroAddress();
        }
        if (key.hooks != address(0)) {
            revert UniswapV4Adapter__HooksNotSupported(key.hooks);
        }

        IPositionManagerMinimal posm = IPositionManagerMinimal(cfg.positionManager);
        IPoolManagerMinimal manager = IPoolManagerMinimal(posm.poolManager());
        bytes32 id = keccak256(abi.encode(key));
        (uint160 sqrtPriceX96,) = V4StateReader.getSlot0(manager, id);
        // Also catches a mis-ordered key: the PoolManager only ever initializes currency0 < currency1.
        if (sqrtPriceX96 == 0) {
            revert UniswapV4Adapter__PoolNotInitialized(id);
        }
        address refFactory = _checkReferenceVenue(cfg.refPool, key.currency0, key.currency1);
        _checkRouter(cfg.swapRouter, address(manager), refFactory);
        address permit2 = posm.permit2();
        if (permit2.code.length == 0) {
            revert UniswapV4Adapter__NoCode(permit2);
        }
        if (cfg.swapExecutor.code.length == 0) {
            revert UniswapV4Adapter__NoCode(cfg.swapExecutor);
        }
        ISwapExecutor executor = ISwapExecutor(cfg.swapExecutor);
        if (executor.UNIVERSAL_ROUTER() != cfg.swapRouter || executor.PERMIT2() != permit2) {
            revert UniswapV4Adapter__ExecutorMismatch(cfg.swapExecutor);
        }

        VAULT = cfg.vault;
        POSITION_MANAGER = posm;
        POOL_MANAGER = manager;
        PERMIT2 = IPermit2Minimal(permit2);
        REF_POOL = IUniswapV3PoolMinimal(cfg.refPool);
        SWAP_EXECUTOR = executor;
        TOKEN0 = IERC20(key.currency0);
        TOKEN1 = IERC20(key.currency1);
        POOL_FEE = key.fee;
        TICK_SPACING = key.tickSpacing;
        REF_POOL_FEE = IUniswapV3PoolMinimal(cfg.refPool).fee();
        POOL_ID = id;

        _setRange(cfg.rangeTicksBelow, cfg.rangeTicksAbove);
        _setTwapWindow(cfg.twapWindow);
        _setMaxSlippageBps(cfg.maxSlippageBps);
        emit SwapVenueSet(SwapVenue.V3_REF_POOL, SwapVenue.V3_REF_POOL); // default venue, stated for indexers

        int24 spacing = key.tickSpacing;
        int24 lowest = _ceilToSpacing(TickMath.MIN_TICK, spacing);
        int24 highest = _floorToSpacing(TickMath.MAX_TICK, spacing);
        _setRangeConstraints(lowest, highest, spacing, highest - lowest);
        configVersion = 1;
    }

    /*//////////////////////////////////////////////////////////////
                         VAULT-ONLY POSITION OPS
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IPositionAdapter
    /// @dev Guards first (TWAP available, v4 spot near TWAP), then pull, then bank the live position's fees (v4
    ///      would otherwise net them into the increase), then swap the free surplus toward the range ratio at the
    ///      TWAP price (TWAP-bounded), then add ALL free holdings (incl. earlier dust, excl. banked fees) as
    ///      liquidity at the v4 spot. Leftovers from rounding / the cross-venue basis stay idle and keep being
    ///      reported by {position}.
    /// @return tokens `[token0, token1]`.
    /// @return deployed Amounts actually added to the position this call (post-swap, so they can differ per
    ///         token from what was pulled).
    function deploy(uint256[] calldata amounts)
        external
        nonReentrant
        onlyVault
        returns (address[] memory tokens, uint256[] memory deployed)
    {
        if (amounts.length != 2) {
            revert UniswapV4Adapter__LengthMismatch();
        }
        (int24 twapTick_,) = _guardedTwapTick();

        // msg.sender == VAULT (onlyVault), which force-approved exactly `amounts`.
        _pullFromVault(amounts[0], amounts[1]);

        uint256 id = tokenId;
        _bankFees(id);
        (int24 lower, int24 upper) = id == 0 ? _computeRange(twapTick_) : (tickLower, tickUpper);
        uint160 sqrtLowerX96 = TickMath.getSqrtRatioAtTick(lower);
        uint160 sqrtUpperX96 = TickMath.getSqrtRatioAtTick(upper);

        _swapToRangeRatio(TickMath.getSqrtRatioAtTick(twapTick_), sqrtLowerX96, sqrtUpperX96);

        (tokens, deployed) = _vectors();
        uint128 liquidityAdded;
        (liquidityAdded, deployed[0], deployed[1]) = _addLiquidity(id, lower, upper, sqrtLowerX96, sqrtUpperX96);
        emit LiquidityDeployed(amounts[0], amounts[1], deployed[0], deployed[1], liquidityAdded);
    }

    /// @inheritdoc IPositionAdapter
    /// @dev Delivers floor(sharesWad/1e18) of: idle balances (incl. every fee — the live position's fees are banked
    ///      first) and the position's liquidity (principal released at the current price). No swap, no TWAP read,
    ///      `DECREASE_LIQUIDITY` mins are 0 (in kind: the position returns what it holds; a redemption must never
    ///      be blocked). The fee slice goes to `to` with the principal and the bank keeps the rest for {harvest};
    ///      `fees_i` = the bank slice floor(bankedFees_i * sharesWad / 1e18) (the exact bank decrement), reported so
    ///      the vault skims its perf fee on it. The idle slice covers it (bank <= balance). At 1e18 (= `pullFrom`
    ///      10_000 bps) the NFT is burned (re-range path; the fees were banked first, so the burn is principal only).
    function withdrawProportional(uint256 sharesWad, address to)
        external
        nonReentrant
        onlyVault
        returns (address[] memory tokens, uint256[] memory amounts, uint256[] memory fees)
    {
        if (sharesWad == 0 || sharesWad > WAD) {
            revert UniswapV4Adapter__InvalidSharesWad(sharesWad);
        }
        if (to == address(0)) {
            revert UniswapV4Adapter__ZeroAddress();
        }
        uint256 id = tokenId;
        _bankFees(id);

        // Idle slice (banked fees included), snapshotted before any principal flows in. The bank shrinks by its
        // own floor(sharesWad/1e18) slice, so it always stays <= the idle balance left behind.
        (tokens, amounts) = _vectors();
        amounts[0] = _token0().balanceOf(address(this)).mulDiv(sharesWad, WAD);
        amounts[1] = _token1().balanceOf(address(this)).mulDiv(sharesWad, WAD);
        fees = new uint256[](2);
        fees[0] = bankedFees0.mulDiv(sharesWad, WAD);
        fees[1] = bankedFees1.mulDiv(sharesWad, WAD);
        bankedFees0 -= fees[0];
        bankedFees1 -= fees[1];

        if (id != 0) {
            bool closing = sharesWad == WAD;
            uint128 liquidityOut = closing ? 0 : uint128(uint256(_liquidityOf(id)).mulDiv(sharesWad, WAD));
            if (closing) {
                _clearPosition();
            }
            if (closing || liquidityOut != 0) {
                (uint256 principal0, uint256 principal1) = _removeLiquidity(id, liquidityOut, closing);
                amounts[0] += principal0;
                amounts[1] += principal1;
            }
            if (closing) {
                emit PositionBurned(id);
            }
        }

        _send(to, amounts[0], amounts[1]);
        emit Withdrawn(to, sharesWad, amounts[0], amounts[1]);
    }

    /// @inheritdoc IPositionAdapter
    /// @dev Fees only: collect the live position's accrued fees into the bank (`DECREASE_LIQUIDITY` 0 +
    ///      `TAKE_PAIR`), then send the whole bank to the vault. Principal is never touched.
    function harvest() external nonReentrant onlyVault returns (address[] memory tokens, uint256[] memory amounts) {
        _bankFees(tokenId);
        (tokens, amounts) = _vectors();
        (amounts[0], amounts[1]) = _takeBank();
        _sendToVault(amounts[0], amounts[1]);
        emit Harvested(amounts[0], amounts[1]);
    }

    /// @inheritdoc IPositionAdapter
    /// @dev Emergency: all liquidity, all fees (banked + accrued) and all idle, in kind, to `to`. Burns the NFT so the
    ///      next {deploy} mints a fresh range. The live position's accrued fees are banked first (as on the
    ///      `withdrawProportional(1e18)` close), so `fees` = the whole bank (earlier banked + the closing remove's fee
    ///      part) and the burn releases principal only; the vault skims its perf fee on it (no emergency exemption).
    function unwindAll(address to)
        external
        nonReentrant
        onlyVault
        returns (address[] memory tokens, uint256[] memory amounts, uint256[] memory fees)
    {
        if (to == address(0)) {
            revert UniswapV4Adapter__ZeroAddress();
        }
        uint256 id = tokenId;
        _bankFees(id);
        fees = new uint256[](2);
        (fees[0], fees[1]) = _takeBank();
        if (id != 0) {
            _clearPosition();
            _removeLiquidity(id, 0, true); // BURN_POSITION: the fees were just banked, so this is principal only
            emit PositionBurned(id);
        }

        (tokens, amounts) = _vectors();
        amounts[0] = _token0().balanceOf(address(this));
        amounts[1] = _token1().balanceOf(address(this));
        _send(to, amounts[0], amounts[1]);
        emit Unwound(to, amounts[0], amounts[1]);
    }

    /// @inheritdoc ILiquidityAdapter
    /// @dev Checks, in order: `liquidity > 0` (`UniswapV4Adapter__ZeroLiquidity`), `minLiquidity <= liquidity`
    ///      (`__InvalidMinLiquidity`), `tickLower < tickUpper` (`__InvalidRange`), both bounds aligned to the pool
    ///      key's tick spacing (`__UnalignedRange`), bounds inside [minTick, maxTick] and width inside
    ///      [minRangeTicks, maxRangeTicks] (`__RangeOutsideConstraints`), and — with a live position — bounds equal to
    ///      the live ones (`__RangeMismatch`: close first). Then the {deploy} guards: REF_POOL TWAP available, v4 spot
    ///      within maxSlippageBps ticks of it.
    ///
    ///      Sizing at the V4 POOL's spot (the PoolManager settles at its own price): `need` = the amounts `liquidity`
    ///      requires, rounded up (+1 wei per non-zero side — an upper bound of what the PoolManager charges).
    ///      - both needs within the caps: pull exactly `need`, no swap;
    ///      - one side short, the other with room: pull the short side's cap, and on the other side `need` plus a
    ///        swap input = the shortfall's TWAP value grossed up by maxSlippageBps (bounded by the room); swap it
    ///        (SWAP_EXECUTOR on the `swapVenue`, as {deploy}) with min-out = max(TWAP quote x (1 − maxSlippageBps),
    ///        `minSwapOut`). `minSwapOut == 0` with a swap to run reverts `__ZeroMinSwapOut`. A dust swap whose TWAP
    ///        min-out rounds to 0 is skipped (as in {deploy});
    ///      - both short: pull both caps, no swap — actual liquidity binds below target.
    ///      The live position's accrued fees are banked first (v4 would otherwise net them into the settle and they
    ///      would become principal). The add is sized again at the post-swap v4 spot (a V4_POOL-venue swap moves it):
    ///      exactly `liquidity` when the op's holdings cover its rounded-up need, else the most the holdings buy (each
    ///      less 1 wei), never above `liquidity`. The settle maxes are the op's holdings, so pre-existing idle and the
    ///      bank can never be spent; `minLiquidity` is the binding floor (`__LiquidityBelowMin`).
    ///      Refund: this op's leftover (pulled ± swapped − spent) goes back to the vault; idle the adapter held before
    ///      the call (bank included) stays put.
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
            revert UniswapV4Adapter__ZeroMinSwapOut(address(op.zeroForOne ? _token0() : _token1()), op.swapIn);
        }

        // msg.sender == VAULT (onlyVault), which force-approved exactly the caps; pulls stay <= caps.
        _pullFromVault(op.pull0, op.pull1);
        id = tokenId;
        _bankFees(id);
        op.avail0 = op.pull0;
        op.avail1 = op.pull1;
        if (op.swapIn != 0) {
            uint256 out = _executeSwap(op.zeroForOne, op.swapIn, Math.max(op.twapMinOut, p.minSwapOut));
            if (op.zeroForOne) {
                op.avail0 -= op.swapIn;
                op.avail1 += out;
            } else {
                op.avail1 -= op.swapIn;
                op.avail0 += out;
            }
        }

        (uint160 sqrtSpotX96,) = _spot();
        (uint256 need0, uint256 need1) =
            _amountsForLiquidityUp(sqrtSpotX96, op.sqrtLowerX96, op.sqrtUpperX96, p.liquidity);
        liquidityAdded = p.liquidity;
        if (need0 > op.avail0 || need1 > op.avail1) {
            uint128 affordable = _liquidityFor(sqrtSpotX96, op.sqrtLowerX96, op.sqrtUpperX96, op.avail0, op.avail1);
            if (affordable < liquidityAdded) {
                liquidityAdded = affordable;
            }
        }
        if (liquidityAdded == 0) {
            revert UniswapV4Adapter__ZeroLiquidity();
        }
        if (liquidityAdded < p.minLiquidity) {
            revert UniswapV4Adapter__LiquidityBelowMin(liquidityAdded, p.minLiquidity);
        }
        (amount0Spent, amount1Spent) =
            _mintOrIncrease(id, op.tickLower, op.tickUpper, liquidityAdded, op.avail0, op.avail1);

        amount0Refunded = op.avail0 - amount0Spent;
        amount1Refunded = op.avail1 - amount1Spent;
        _sendToVault(amount0Refunded, amount1Refunded);
        id = tokenId;
        emit LiquidityAdded(id, liquidityAdded, amount0Spent, amount1Spent, amount0Refunded, amount1Refunded);
    }

    /// @inheritdoc ILiquidityAdapter
    /// @dev Idle-refund mode (`liquidity == 0`): the FREE balances (balance − bank) to the vault; NO PositionManager
    ///      call, so the NFT, its liquidity, its fee checkpoints and the bank are untouched (banked fees are not idle).
    ///      Non-zero principal floors revert `UniswapV4Adapter__PrincipalFloorInIdleMode` (idle never counts as
    ///      principal).
    ///      Removal mode: `liquidity <= live` (`__InsufficientLiquidity`); bank the accrued fees (`DECREASE_LIQUIDITY`
    ///      0 + `TAKE_PAIR`) so the next modification settles principal only; `DECREASE_LIQUIDITY` `liquidity` +
    ///      `TAKE_PAIR` — the settled credit (the BalanceDelta, taken in full) is the principal, checked against the
    ///      caller's floors (`__PrincipalBelowFloor`; fees never count toward them). Then principal + the WHOLE bank
    ///      (earlier banked fees + those just settled — v3's `collect(max, max)` equivalent) go to the VAULT, the bank
    ///      is emptied, and fees are reported apart from principal. The NFT is kept even at zero liquidity (burning
    ///      stays with the close path, `withdrawProportional(1e18)`). No performance fee here: adapters report the
    ///      split, fee policy is the vault's (it skims on `fees0/fees1`).
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
                revert UniswapV4Adapter__PrincipalFloorInIdleMode(p.minPrincipal0, p.minPrincipal1);
            }
            (idleRefunded0, idleRefunded1) = _freeBalances();
            _sendToVault(idleRefunded0, idleRefunded1);
            emit IdleRefunded(idleRefunded0, idleRefunded1);
            return (0, 0, 0, 0, idleRefunded0, idleRefunded1);
        }

        uint256 id = tokenId;
        uint128 live = id == 0 ? 0 : _liquidityOf(id);
        if (p.liquidity > live) {
            revert UniswapV4Adapter__InsufficientLiquidity(p.liquidity, live);
        }
        _bankFees(id);
        (principal0, principal1) = _removeLiquidity(id, p.liquidity, false);
        if (principal0 < p.minPrincipal0 || principal1 < p.minPrincipal1) {
            revert UniswapV4Adapter__PrincipalBelowFloor(principal0, principal1, p.minPrincipal0, p.minPrincipal1);
        }
        (fees0, fees1) = _takeBank();
        _sendToVault(principal0 + fees0, principal1 + fees1);
        emit LiquidityRemoved(id, p.liquidity, principal0, principal1, fees0, fees1);
    }

    /// @inheritdoc ISwapAdapter
    /// @dev `(tokenIn, tokenOut)` must be the pool key's pair in either direction and `amountIn > 0`
    ///      (`UniswapV4Adapter__InvalidSwap`). Then the {deploy} guards (REF_POOL TWAP available, v4 spot within
    ///      maxSlippageBps ticks of it), pull exactly `amountIn` from the vault, swap it (SWAP_EXECUTOR on the
    ///      `swapVenue`) with min-out = max(TWAP quote x (1 − maxSlippageBps), `minAmountOut`) and send the whole
    ///      output (the executor's balance delta) to the vault. Idle and the fee bank are never touched.
    function swapExactIn(SwapParams calldata p) external nonReentrant onlyVault returns (uint256 amountOut) {
        address t0 = address(_token0());
        address t1 = address(_token1());
        bool zeroForOne = p.tokenIn == t0;
        uint256 amountIn = p.amountIn;
        if (amountIn == 0 || (zeroForOne ? p.tokenOut != t1 : p.tokenIn != t1 || p.tokenOut != t0)) {
            revert UniswapV4Adapter__InvalidSwap(p.tokenIn, p.tokenOut, amountIn);
        }
        (int24 twapTick_,) = _guardedTwapTick();
        // msg.sender == VAULT (onlyVault), which force-approved exactly `amountIn`.
        IERC20(p.tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        uint256 twapMinOut = _twapMinOut(amountIn, TickMath.getSqrtRatioAtTick(twapTick_), zeroForOne);
        amountOut = _executeSwap(zeroForOne, amountIn, Math.max(twapMinOut, p.minAmountOut));
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

    /// @notice Max deviation vs the TWAP reference on deploy (v4 spot gap + swap output), in bps.
    function setMaxSlippageBps(uint16 bps) external onlyOwner {
        _setMaxSlippageBps(bps);
    }

    /// @notice Where the ratio swap of the next {deploy} executes: REF_POOL (v3) or this adapter's own v4 pool. Both
    ///         targets were validated at construction (same ordered pair; router wired to both); an out-of-range
    ///         value fails ABI decoding. The TWAP reference and every guard are unchanged by the switch.
    function setSwapVenue(SwapVenue venue) external onlyOwner {
        emit SwapVenueSet(swapVenue, venue);
        swapVenue = venue;
        _bumpConfig();
    }

    /// @notice Range constraints for {addLiquidity}: every new/increased range must satisfy
    ///         `minTick_ <= tickLower < tickUpper <= maxTick_` and `minRangeTicks_ <= width <= maxRangeTicks_`.
    /// @dev Reverts `UniswapV4Adapter__InvalidConstraints` unless MIN_TICK <= minTick_ < maxTick_ <= MAX_TICK, both
    ///      multiples of the pool key's tick spacing, 0 < minRangeTicks_ <= maxRangeTicks_ and
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
            (lower, upper, liquidity) = (tickLower, tickUpper, _liquidityOf(id));
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
    /// @dev The real v4 poolId: keccak256(abi.encode(PoolKey)).
    function poolId() external view returns (bytes32) {
        return POOL_ID;
    }

    /// @inheritdoc IPositionAdapter
    /// @dev `[token0, token1]` = idle (incl. banked fees) + principal at the v4 spot + fees accrued in the
    ///      PoolManager since the position's last modification (feeGrowthInside accounting — no price involved).
    ///      The fee part (bank + accrual) is NET of the vault's perf fee (fee-at-exit: skimmed whenever fees
    ///      leave) — what holders can extract; free idle and principal stay gross.
    function position() external view returns (address[] memory tokens, uint256[] memory amounts) {
        (tokens, amounts) = _vectors();
        amounts[0] = _token0().balanceOf(address(this));
        amounts[1] = _token1().balanceOf(address(this));
        uint256 fees0 = bankedFees0;
        uint256 fees1 = bankedFees1;
        uint256 id = tokenId;
        if (id != 0) {
            (uint256 principal0, uint256 principal1, uint256 accrued0, uint256 accrued1) = _positionAmounts(id);
            amounts[0] += principal0 + accrued0;
            amounts[1] += principal1 + accrued1;
            fees0 += accrued0;
            fees1 += accrued1;
        }
        // ONE cut per token on the SUM of its fee parts (bank + accrual): gross − floor(fees * bps / 10_000) =
        // free idle + principal + (fees − cut). A whole-fee exit (harvest / full pull / unwind: accrual settled into
        // the bank, the bank reported as `fees`) gets the vault's identical `cut`; a partial redeem floors its bank
        // slice separately (≤1 wei per token apart).
        uint256 bps = IPoolmigoVault(VAULT).performanceFeeBps();
        amounts[0] -= fees0.mulDiv(bps, BPS_DENOMINATOR);
        amounts[1] -= fees1.mulDiv(bps, BPS_DENOMINATOR);
    }

    /// @notice Arithmetic-mean tick of REF_POOL over `twapWindow` (reverts `UniswapV4Adapter__TwapUnavailable` if
    ///         the pool cannot serve it). Exposed so keepers can pre-check the deploy guards off-chain.
    function twapTick() external view returns (int24) {
        return _twapTick();
    }

    /// @notice The v4 pool's spot price and tick (the mint price; the spot-vs-TWAP guard reads this).
    function spot() external view returns (uint160 sqrtPriceX96, int24 tick) {
        return _spot();
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

    /// @dev Swap the free surplus token into the deficit token so free holdings match the range's token ratio at
    ///      the TWAP price. Pool fee, impact and the v4-spot/TWAP basis are not modelled: the residual stays idle
    ///      (reported). amountIn never exceeds the surplus held: target0In1 lies in [0, held0In1 + free1].
    function _swapToRangeRatio(uint160 sqrtTwapX96, uint160 sqrtLowerX96, uint160 sqrtUpperX96) internal {
        (uint256 free0, uint256 free1) = _freeBalances();
        (uint256 ref0, uint256 ref1) =
            LiquidityAmounts.getAmountsForLiquidity(sqrtTwapX96, sqrtLowerX96, sqrtUpperX96, REF_LIQUIDITY);
        // Everything in token1 units at the TWAP price (a ratio for sizing — never reported anywhere).
        uint256 ref0In1 = _quote(ref0, sqrtTwapX96, true);
        uint256 held0In1 = _quote(free0, sqrtTwapX96, true);
        uint256 refTotal = ref0In1 + ref1;
        if (refTotal == 0) {
            return;
        }
        uint256 target0In1 = (held0In1 + free1).mulDiv(ref0In1, refTotal);
        if (held0In1 > target0In1) {
            _swapExactIn(true, free0.mulDiv(held0In1 - target0In1, held0In1), sqrtTwapX96);
        } else if (target0In1 > held0In1) {
            _swapExactIn(false, target0In1 - held0In1, sqrtTwapX96);
        }
    }

    /// @dev Single-hop exact-input swap through SWAP_EXECUTOR on the selected venue — REF_POOL (`swapV3ExactIn`,
    ///      V3_SWAP_EXACT_IN) or this adapter's v4 pool (`swapV4ExactIn`, V4_SWAP) — output to this adapter, allowance
    ///      exactly `amountIn` then reset to 0. `minOut` = TWAP quote haircut by maxSlippageBps; if it rounds to 0 the
    ///      (dust) swap is skipped — never an unbounded swap. The executor owns the Permit2 layers, the router's
    ///      min-out mapping and the balance-delta re-check (`SwapExecutor__SlippageExceeded`).
    function _swapExactIn(bool zeroForOne, uint256 amountIn, uint160 sqrtTwapX96) internal {
        uint256 minOut = _twapMinOut(amountIn, sqrtTwapX96, zeroForOne);
        if (minOut == 0) {
            return;
        }
        _executeSwap(zeroForOne, amountIn, minOut);
    }

    /// @dev The swap itself (shared by {deploy} and {addLiquidity}): SWAP_EXECUTOR on the selected venue, allowance
    ///      exactly `amountIn` then reset to 0 (see {_swapExactIn}); `minOut` is non-zero by every caller.
    function _executeSwap(bool zeroForOne, uint256 amountIn, uint256 minOut) internal returns (uint256 amountOut) {
        (IERC20 tokenIn, IERC20 tokenOut) = zeroForOne ? (_token0(), _token1()) : (_token1(), _token0());
        SwapVenue venue = swapVenue;
        ISwapExecutor executor = SWAP_EXECUTOR;
        tokenIn.forceApprove(address(executor), amountIn);
        amountOut = venue == SwapVenue.V3_REF_POOL
            ? executor.swapV3ExactIn(address(tokenIn), REF_POOL_FEE, address(tokenOut), amountIn, minOut)
            : executor.swapV4ExactIn(_poolKey(), zeroForOne, amountIn, minOut);
        tokenIn.forceApprove(address(executor), 0);
        emit Swapped(address(tokenIn), amountIn, amountOut, minOut, venue);
    }

    /// @dev Mint (id == 0) or increase the position with all free holdings. v4 mints take a LIQUIDITY amount:
    ///      it is computed at the v4 spot from free − 1 wei per side (the pool rounds required amounts up), and
    ///      the settle maxes are the free balances, so nothing beyond free holdings can ever be pulled. The
    ///      deploy-time spot/TWAP guard already ran; the spot is re-read here because a V4_POOL-venue ratio swap
    ///      just moved it (a V3_REF_POOL swap does not).
    function _addLiquidity(uint256 id, int24 lower, int24 upper, uint160 sqrtLowerX96, uint160 sqrtUpperX96)
        internal
        returns (uint128 liquidity, uint256 used0, uint256 used1)
    {
        (uint256 max0, uint256 max1) = _freeBalances();
        (uint160 sqrtSpotX96,) = _spot();
        liquidity = _liquidityFor(sqrtSpotX96, sqrtLowerX96, sqrtUpperX96, max0, max1);
        if (liquidity == 0) {
            revert UniswapV4Adapter__ZeroLiquidity();
        }
        (used0, used1) = _mintOrIncrease(id, lower, upper, liquidity, max0, max1);
    }

    /// @dev Mint (id == 0: records the new id + bounds) or increase the live position by exactly `liquidity`, settling
    ///      through Permit2 with `max0/max1` as the settle caps (the PositionManager reverts above them); both Permit2
    ///      layers exact, then zeroed. Returns what actually left this adapter.
    function _mintOrIncrease(uint256 id, int24 lower, int24 upper, uint128 liquidity, uint256 max0, uint256 max1)
        internal
        returns (uint256 used0, uint256 used1)
    {
        bytes[] memory params = new bytes[](2);
        bytes memory actions;
        if (id == 0) {
            id = _positionManager().nextTokenId();
            tokenId = id;
            tickLower = lower;
            tickUpper = upper;
            actions = abi.encodePacked(V4Actions.MINT_POSITION, V4Actions.SETTLE_PAIR);
            params[0] = abi.encode(
                _poolKey(),
                lower,
                upper,
                uint256(liquidity),
                max0.toUint128(),
                max1.toUint128(),
                address(this),
                bytes("")
            );
            emit PositionMinted(id, lower, upper);
        } else {
            actions = abi.encodePacked(V4Actions.INCREASE_LIQUIDITY, V4Actions.SETTLE_PAIR);
            params[0] = abi.encode(id, uint256(liquidity), max0.toUint128(), max1.toUint128(), bytes(""));
        }
        params[1] = abi.encode(address(_token0()), address(_token1()));

        uint256 before0 = _token0().balanceOf(address(this));
        uint256 before1 = _token1().balanceOf(address(this));
        _approvePermit2(_token0(), address(_positionManager()), max0);
        _approvePermit2(_token1(), address(_positionManager()), max1);
        _modifyLiquidities(actions, params);
        // Never leave a standing allowance on Permit2 or the PositionManager.
        _revokePermit2(_token0(), address(_positionManager()));
        _revokePermit2(_token1(), address(_positionManager()));
        used0 = before0 - _token0().balanceOf(address(this));
        used1 = before1 - _token1().balanceOf(address(this));
    }

    /// @dev Collect the live position's accrued fees ONLY (`DECREASE_LIQUIDITY` 0 + `TAKE_PAIR` to this adapter)
    ///      into the bank. No-op without a position or at zero liquidity: {removeLiquidity} keeps the NFT at zero
    ///      liquidity (v3 parity), and v4-core rejects a zero-delta poke of an empty position
    ///      (`CannotUpdateEmptyPosition`) — an empty position has no fees to settle anyway.
    function _bankFees(uint256 id) internal {
        if (id == 0 || _liquidityOf(id) == 0) {
            return;
        }
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(id, uint256(0), uint128(0), uint128(0), bytes(""));
        params[1] = abi.encode(address(_token0()), address(_token1()), address(this));
        (uint256 fee0, uint256 fee1) =
            _modifyAndMeasure(abi.encodePacked(V4Actions.DECREASE_LIQUIDITY, V4Actions.TAKE_PAIR), params);
        if (fee0 != 0 || fee1 != 0) {
            bankedFees0 += fee0;
            bankedFees1 += fee1;
            emit FeesBanked(fee0, fee1);
        }
    }

    /// @dev Remove `liquidity` (or burn the whole position) and take the released tokens to this adapter. Mins
    ///      are 0: in kind on {withdrawProportional} / {unwindAll}; {removeLiquidity} checks its floors on the
    ///      measured release. After {_bankFees} the release is principal only.
    function _removeLiquidity(uint256 id, uint128 liquidity, bool burn)
        internal
        returns (uint256 amount0, uint256 amount1)
    {
        bytes[] memory params = new bytes[](2);
        bytes memory actions;
        if (burn) {
            actions = abi.encodePacked(V4Actions.BURN_POSITION, V4Actions.TAKE_PAIR);
            params[0] = abi.encode(id, uint128(0), uint128(0), bytes(""));
        } else {
            actions = abi.encodePacked(V4Actions.DECREASE_LIQUIDITY, V4Actions.TAKE_PAIR);
            params[0] = abi.encode(id, uint256(liquidity), uint128(0), uint128(0), bytes(""));
        }
        params[1] = abi.encode(address(_token0()), address(_token1()), address(this));
        (amount0, amount1) = _modifyAndMeasure(actions, params);
    }

    /// @dev Run a take-only action batch and return what landed in this adapter: `TAKE_PAIR` takes the batch's whole
    ///      credit, so this is exactly the settled BalanceDelta (the PositionManager does not return it).
    function _modifyAndMeasure(bytes memory actions, bytes[] memory params)
        internal
        returns (uint256 received0, uint256 received1)
    {
        uint256 before0 = _token0().balanceOf(address(this));
        uint256 before1 = _token1().balanceOf(address(this));
        _modifyLiquidities(actions, params);
        received0 = _token0().balanceOf(address(this)) - before0;
        received1 = _token1().balanceOf(address(this)) - before1;
    }

    function _modifyLiquidities(bytes memory actions, bytes[] memory params) internal {
        _positionManager().modifyLiquidities(abi.encode(actions, params), block.timestamp);
    }

    /// @dev ERC20 allowance to Permit2 + a Permit2 allowance to `spender` (the PositionManager for SETTLE_PAIR, the
    ///      router for a swap), both exactly `amount` and the latter expiring this block.
    function _approvePermit2(IERC20 token, address spender, uint256 amount) internal {
        IPermit2Minimal permit2 = PERMIT2;
        token.forceApprove(address(permit2), amount);
        permit2.approve(address(token), spender, amount.toUint160(), uint48(block.timestamp));
    }

    /// @dev Never leave a standing allowance: both layers back to 0.
    function _revokePermit2(IERC20 token, address spender) internal {
        IPermit2Minimal permit2 = PERMIT2;
        permit2.approve(address(token), spender, 0, 0);
        token.forceApprove(address(permit2), 0);
    }

    /// @dev Empty the bank, returning what it held (the caller sends it on).
    function _takeBank() internal returns (uint256 fee0, uint256 fee1) {
        (fee0, fee1) = (bankedFees0, bankedFees1);
        bankedFees0 = 0;
        bankedFees1 = 0;
    }

    /// @dev Pull from the vault (msg.sender under onlyVault — it force-approved at least these). Zeros skipped.
    function _pullFromVault(uint256 amount0, uint256 amount1) internal {
        if (amount0 != 0) {
            _token0().safeTransferFrom(msg.sender, address(this), amount0);
        }
        if (amount1 != 0) {
            _token1().safeTransferFrom(msg.sender, address(this), amount1);
        }
    }

    /// @dev Pay out in kind. `to` is the vault on harvest and the precise ops (hard-wired, never a parameter there),
    ///      the vault-chosen recipient on {withdrawProportional} / {unwindAll}. Zero amounts are skipped.
    function _send(address to, uint256 amount0, uint256 amount1) internal {
        if (amount0 != 0) {
            _token0().safeTransfer(to, amount0);
        }
        if (amount1 != 0) {
            _token1().safeTransfer(to, amount1);
        }
    }

    /// @dev Precise ops' and {harvest}'s only destination: the vault (hard-wired).
    function _sendToVault(uint256 amount0, uint256 amount1) private {
        _send(VAULT, amount0, amount1);
    }

    /// @dev Effects before the burn interactions: forget the live position.
    function _clearPosition() internal {
        tokenId = 0;
        tickLower = 0;
        tickUpper = 0;
    }

    function _setRange(int24 ticksBelow, int24 ticksAbove) internal {
        if (ticksBelow <= 0 || ticksAbove <= 0 || ticksBelow > TickMath.MAX_TICK || ticksAbove > TickMath.MAX_TICK) {
            revert UniswapV4Adapter__InvalidRange(ticksBelow, ticksAbove);
        }
        rangeTicksBelow = ticksBelow;
        rangeTicksAbove = ticksAbove;
        emit RangeSet(ticksBelow, ticksAbove);
        _bumpConfig();
    }

    function _setTwapWindow(uint32 window) internal {
        if (window < MIN_TWAP_WINDOW || window > MAX_TWAP_WINDOW) {
            revert UniswapV4Adapter__TwapWindowOutOfRange(window, MIN_TWAP_WINDOW, MAX_TWAP_WINDOW);
        }
        emit TwapWindowSet(twapWindow, window);
        twapWindow = window;
        _bumpConfig();
    }

    function _setMaxSlippageBps(uint16 bps) internal {
        if (bps < MIN_SLIPPAGE_BPS || bps > MAX_SLIPPAGE_BPS) {
            revert UniswapV4Adapter__SlippageOutOfRange(bps, MIN_SLIPPAGE_BPS, MAX_SLIPPAGE_BPS);
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
            revert UniswapV4Adapter__InvalidConstraints(minTick_, maxTick_, minRangeTicks_, maxRangeTicks_);
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

    /// @dev The v3 reference pool must trade the SAME ordered pair and be its factory's canonical pool for its fee
    ///      (so a router on that factory lands its `fee` hop on exactly this pool). Returns that factory.
    function _checkReferenceVenue(address refPool, address currency0, address currency1)
        internal
        view
        returns (address factory)
    {
        IUniswapV3PoolMinimal ref = IUniswapV3PoolMinimal(refPool);
        factory = ref.factory();
        if (
            ref.token0() != currency0 || ref.token1() != currency1
                || IUniswapV3FactoryMinimal(factory).getPool(currency0, currency1, ref.fee()) != refPool
        ) {
            revert UniswapV4Adapter__VenueMismatch(refPool);
        }
    }

    /// @dev The router must serve both venues: v4 swaps on `manager`, v3 swaps on `refFactory` (anchored through
    ///      its V3_POSITION_MANAGER's factory — the router's own v3 factory is not exposed).
    function _checkRouter(address router, address manager, address refFactory) internal view {
        if (router.code.length == 0) {
            revert UniswapV4Adapter__NoCode(router);
        }
        IUniversalRouter ur = IUniversalRouter(router);
        if (ur.poolManager() != manager) {
            revert UniswapV4Adapter__RouterMismatch(router);
        }
        if (_factoryOf(ur.V3_POSITION_MANAGER()) != refFactory) {
            revert UniswapV4Adapter__RouterMismatch(router);
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

    function _poolKey() internal view returns (PoolKey memory) {
        return PoolKey({
            currency0: address(_token0()),
            currency1: address(_token1()),
            fee: POOL_FEE,
            tickSpacing: TICK_SPACING,
            hooks: address(0)
        });
    }

    /// @dev {onlyVault}'s check, out of line (one copy instead of one per vault-only function — EIP-170 budget).
    function _checkVault() private view {
        if (msg.sender != VAULT) {
            revert UniswapV4Adapter__OnlyVault();
        }
    }

    /// @dev Immutable reads routed through private getters: each inline immutable costs a 32-byte PUSH per use
    ///      site, a getter a jump (EIP-170 budget).
    function _token0() private view returns (IERC20) {
        return TOKEN0;
    }

    function _token1() private view returns (IERC20) {
        return TOKEN1;
    }

    function _positionManager() private view returns (IPositionManagerMinimal) {
        return POSITION_MANAGER;
    }

    function _poolManager() private view returns (IPoolManagerMinimal) {
        return POOL_MANAGER;
    }

    function _poolId() private view returns (bytes32) {
        return POOL_ID;
    }

    /// @dev The v4 pool's spot (sqrtPriceX96, tick) — the price the PoolManager settles liquidity at.
    function _spot() private view returns (uint160 sqrtPriceX96, int24 tick) {
        return V4StateReader.getSlot0(_poolManager(), _poolId());
    }

    function _liquidityOf(uint256 id) private view returns (uint128) {
        return _positionManager().getPositionLiquidity(id);
    }

    /// @dev `[token0, token1]` and a zeroed amounts vector of the same length.
    function _vectors() internal view returns (address[] memory tokens, uint256[] memory amounts) {
        tokens = new address[](2);
        tokens[0] = address(_token0());
        tokens[1] = address(_token1());
        amounts = new uint256[](2);
    }

    /// @dev Balances minus banked fees: what deploy may swap / add as principal, and the idle-refund amount.
    function _freeBalances() internal view returns (uint256 free0, uint256 free1) {
        free0 = _token0().balanceOf(address(this)) - bankedFees0;
        free1 = _token1().balanceOf(address(this)) - bankedFees1;
    }

    function _lessOneWei(uint256 amount) internal pure returns (uint256) {
        return amount == 0 ? 0 : amount - 1;
    }

    /// @dev Most liquidity `max0/max1` buy at `sqrtSpotX96`, each less 1 wei: the PoolManager rounds what it charges
    ///      up, so the settle for the result always fits inside `max0/max1`.
    function _liquidityFor(uint160 sqrtSpotX96, uint160 sqrtLowerX96, uint160 sqrtUpperX96, uint256 max0, uint256 max1)
        internal
        pure
        returns (uint128)
    {
        return LiquidityAmounts.getLiquidityForAmounts(
            sqrtSpotX96, sqrtLowerX96, sqrtUpperX96, _lessOneWei(max0), _lessOneWei(max1)
        );
    }

    /// @dev {addLiquidity} / {previewAddLiquidity}: parameter + constraint checks, the {deploy} price guards, then
    ///      the pull / swap sizing at the v4 spot (see {addLiquidity}). Reverts exactly as {addLiquidity} would before
    ///      any transfer.
    function _planAdd(AddLiquidityParams memory p) internal view returns (AddOp memory op) {
        _checkAdd(p);
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
            revert UniswapV4Adapter__ZeroLiquidity();
        }
        if (p.minLiquidity > p.liquidity) {
            revert UniswapV4Adapter__InvalidMinLiquidity(p.minLiquidity, p.liquidity);
        }
        int24 lower = p.tickLower;
        int24 upper = p.tickUpper;
        if (lower >= upper) {
            revert UniswapV4Adapter__InvalidRange(lower, upper);
        }
        int24 spacing = TICK_SPACING;
        if (lower % spacing != 0 || upper % spacing != 0) {
            revert UniswapV4Adapter__UnalignedRange(lower, upper, spacing);
        }
        // Short-circuit: the width is only computed once both bounds sit inside the box (no int24 overflow).
        if (lower < minTick || upper > maxTick || upper - lower < minRangeTicks || upper - lower > maxRangeTicks) {
            revert UniswapV4Adapter__RangeOutsideConstraints(lower, upper);
        }
        if (tokenId != 0 && (lower != tickLower || upper != tickUpper)) {
            revert UniswapV4Adapter__RangeMismatch(tickLower, tickUpper, lower, upper);
        }
    }

    /// @dev Amounts `liquidity` needs at `sqrtSpotX96`, +1 wei per non-zero side: the PoolManager rounds what it
    ///      charges up (at most +1 over the floored LiquidityAmounts value), so this bounds the settle from above.
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

    /// @dev Principal at the v4 spot, and the fees accrued in the PoolManager since the position's last modification.
    function _positionAmounts(uint256 id)
        internal
        view
        returns (uint256 amount0, uint256 amount1, uint256 fee0, uint256 fee1)
    {
        int24 lower = tickLower;
        int24 upper = tickUpper;
        // Key first, out of the nested call (stack depth with the four return slots).
        bytes32 key = V4StateReader.positionKey(address(_positionManager()), lower, upper, bytes32(id));
        (uint128 liquidity, uint256 last0X128, uint256 last1X128) =
            V4StateReader.getPositionState(_poolManager(), _poolId(), key);
        (uint160 sqrtSpotX96, int24 spotTick) = _spot();
        (amount0, amount1) = LiquidityAmounts.getAmountsForLiquidity(
            sqrtSpotX96, TickMath.getSqrtRatioAtTick(lower), TickMath.getSqrtRatioAtTick(upper), liquidity
        );
        if (liquidity != 0) {
            (uint256 inside0X128, uint256 inside1X128) = _feeGrowthInside(lower, upper, spotTick);
            // Fee growth is a counter that intentionally wraps (Uniswap semantics).
            unchecked {
                fee0 = Math.mulDiv(inside0X128 - last0X128, liquidity, 1 << 128);
                fee1 = Math.mulDiv(inside1X128 - last1X128, liquidity, 1 << 128);
            }
        }
    }

    /// @dev Arithmetic-mean tick of REF_POOL over `twapWindow`, rounded toward negative infinity (Uniswap
    ///      convention). The pool reverts ("OLD") when its history is shorter than the window — surfaced as a
    ///      typed error, never a spot fallback.
    function _twapTick() internal view returns (int24 meanTick) {
        uint32 window = twapWindow;
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = window;
        try REF_POOL.observe(secondsAgos) returns (int56[] memory tickCumulatives, uint160[] memory) {
            int56 delta = tickCumulatives[1] - tickCumulatives[0];
            int56 windowI56 = int56(uint56(window));
            meanTick = int24(delta / windowI56);
            if (delta < 0 && delta % windowI56 != 0) {
                meanTick--;
            }
        } catch {
            revert UniswapV4Adapter__TwapUnavailable(window);
        }
    }

    /// @dev The {deploy} / {addLiquidity} / {swapExactIn} price guards: REF_POOL TWAP available and the v4 spot within
    ///      maxSlippageBps ticks of it. Returns the TWAP tick and the v4 spot price.
    function _guardedTwapTick() internal view returns (int24 twapTick_, uint160 sqrtSpotX96) {
        twapTick_ = _twapTick();
        int24 spotTick;
        (sqrtSpotX96, spotTick) = _spot();
        _requireSpotNearTwap(spotTick, twapTick_);
    }

    /// @dev One tick ≈ one basis point of price, so the tick gap doubles as a bps deviation bound.
    function _requireSpotNearTwap(int24 spotTick, int24 twapTick_) internal view {
        int256 gap = int256(spotTick) - int256(twapTick_);
        if (gap < 0) {
            gap = -gap;
        }
        if (gap > int256(uint256(maxSlippageBps))) {
            revert UniswapV4Adapter__SpotDeviatesFromTwap(spotTick, twapTick_, maxSlippageBps);
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

    /// @dev feeGrowthInside of [lower, upper) at `currentTick` from the PoolManager's own accounting (a counter,
    ///      not a price). Same below/above decomposition as the v3 adapter.
    function _feeGrowthInside(int24 lower, int24 upper, int24 currentTick)
        internal
        view
        returns (uint256 inside0X128, uint256 inside1X128)
    {
        bool aboveLower = currentTick >= lower;
        bool belowUpper = currentTick < upper;
        IPoolManagerMinimal manager = _poolManager();
        bytes32 id = _poolId();
        (uint256 lowerOutside0X128, uint256 lowerOutside1X128) =
            V4StateReader.getTickFeeGrowthOutside(manager, id, lower);
        (uint256 upperOutside0X128, uint256 upperOutside1X128) =
            V4StateReader.getTickFeeGrowthOutside(manager, id, upper);
        (uint256 global0X128, uint256 global1X128) = V4StateReader.getFeeGrowthGlobals(manager, id);
        inside0X128 = _feeGrowthInsideOne(global0X128, lowerOutside0X128, upperOutside0X128, aboveLower, belowUpper);
        inside1X128 = _feeGrowthInsideOne(global1X128, lowerOutside1X128, upperOutside1X128, aboveLower, belowUpper);
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
