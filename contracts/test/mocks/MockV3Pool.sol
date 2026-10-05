// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TickMath} from "contracts/adapters/uniswap/TickMath.sol";

/**
 * @notice Minimal Uniswap v3 factory stand-in: canonical pool lookup (`getPool`, both token orders) for the zap's
 *         route check and the mock router's pool derivation. `factory()` returns itself so the same contract can
 *         also be the router's `V3_POSITION_MANAGER()` anchor (the zap reads FACTORY = NFPM.factory()).
 */
contract MockV3Factory {
    mapping(address => mapping(address => mapping(uint24 => address))) public getPool;

    function register(MockV3Pool pool) external {
        address t0 = pool.token0();
        address t1 = pool.token1();
        uint24 fee_ = pool.fee();
        getPool[t0][t1][fee_] = address(pool);
        getPool[t1][t0][fee_] = address(pool);
    }

    function factory() external view returns (address) {
        return address(this);
    }
}

/**
 * @notice Minimal Uniswap v3 pool for the zap's quote path: `token0/token1/fee/factory/slot0/liquidity/observe`.
 *         - `observe` serves a CONFIGURABLE arithmetic-mean tick (`meanTick`) for any window (or reverts "OLD"):
 *           like the real oracle, a swap in this block does not move it.
 *         - `slot0` reports the live sqrt price (moved by {swapExactIn}) and a configurable observation cardinality.
 *         - {swapExactIn}: exact-input swap at CONSTANT in-range liquidity (v3 SwapMath / SqrtPriceMath rounding, no
 *           tick crossing, fee on input) paid out of this pool's own token balances — the execution venue the mock
 *           router calls after moving the input here. Not a full pool: no ticks, no fee growth, no callbacks.
 */
contract MockV3Pool {
    uint256 internal constant Q96 = 1 << 96;
    uint256 internal constant FEE_DENOMINATOR = 1_000_000;

    address public immutable factory;
    address public immutable token0;
    address public immutable token1;
    uint24 public immutable fee;

    uint160 public sqrtPriceX96;
    uint128 public liquidity;
    int24 public meanTick;
    uint16 public observationCardinality = 10_000;
    uint16 public observationCardinalityNext = 10_000;
    bool public observeReverts;
    int24 public tickSpacing = 1;

    constructor(
        address factory_,
        address tokenA,
        address tokenB,
        uint24 fee_,
        uint160 sqrtPriceX96_,
        uint128 liquidity_
    ) {
        factory = factory_;
        (token0, token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        fee = fee_;
        sqrtPriceX96 = sqrtPriceX96_;
        liquidity = liquidity_;
        meanTick = TickMath.getTickAtSqrtRatio(sqrtPriceX96_);
    }

    /*//////////////////////////////////////////////////////////////
                              TEST CONTROLS
    //////////////////////////////////////////////////////////////*/

    function setMeanTick(int24 tick_) external {
        meanTick = tick_;
    }

    /// @dev TWAP := current spot tick (as after a long quiet period).
    function syncTwapToSpot() external {
        meanTick = tick();
    }

    function setSqrtPriceX96(uint160 sqrtPriceX96_) external {
        sqrtPriceX96 = sqrtPriceX96_;
    }

    function setLiquidity(uint128 liquidity_) external {
        liquidity = liquidity_;
    }

    function setObservationCardinality(uint16 cardinality) external {
        observationCardinality = cardinality;
        observationCardinalityNext = cardinality;
    }

    function setObserveReverts(bool reverts) external {
        observeReverts = reverts;
    }

    /// @dev Set BEFORE building an adapter on this pool (adapters read the spacing once, at construction).
    function setTickSpacing(int24 spacing) external {
        tickSpacing = spacing;
    }

    /*//////////////////////////////////////////////////////////////
                               POOL SURFACE
    //////////////////////////////////////////////////////////////*/

    function tick() public view returns (int24) {
        return TickMath.getTickAtSqrtRatio(sqrtPriceX96);
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (sqrtPriceX96, tick(), 0, observationCardinality, observationCardinalityNext, 0, true);
    }

    /// @dev tickCumulative(t − a) = −meanTick·a (a constant origin cancels in every difference), so any window's
    ///      arithmetic mean is exactly `meanTick`.
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s)
    {
        require(!observeReverts, "OLD");
        uint256 n = secondsAgos.length;
        tickCumulatives = new int56[](n);
        secondsPerLiquidityCumulativeX128s = new uint160[](n);
        for (uint256 i; i < n; ++i) {
            tickCumulatives[i] = -int56(meanTick) * int56(uint56(secondsAgos[i]));
        }
    }

    function increaseObservationCardinalityNext(uint16 next) external {
        if (next > observationCardinalityNext) {
            observationCardinalityNext = next;
        }
    }

    /// @notice Exact-input swap at constant in-range liquidity. The caller must have transferred `amountIn` of the
    ///         input token to this pool already; the output is paid to `recipient` from this pool's balance.
    function swapExactIn(bool zeroForOne, uint256 amountIn, address recipient) external returns (uint256 amountOut) {
        uint256 sp = sqrtPriceX96;
        uint256 L = liquidity;
        uint256 net = Math.mulDiv(amountIn, FEE_DENOMINATOR - fee, FEE_DENOMINATOR);
        uint256 numerator1 = L << 96;
        if (net == 0) {
            return 0;
        }
        uint256 spNext;
        if (zeroForOne) {
            // SqrtPriceMath.getNextSqrtPriceFromAmount0RoundingUp(add = true)
            uint256 product;
            bool fits;
            unchecked {
                product = net * sp;
                fits = product / net == sp && numerator1 + product >= numerator1;
            }
            if (fits) {
                spNext = Math.mulDiv(numerator1, sp, numerator1 + product, Math.Rounding.Ceil);
            } else {
                spNext = Math.ceilDiv(numerator1, numerator1 / sp + net);
            }
            // SqrtPriceMath.getAmount1Delta(roundUp = false)
            amountOut = Math.mulDiv(L, sp - spNext, Q96);
        } else {
            // SqrtPriceMath.getNextSqrtPriceFromAmount1RoundingDown(add = true)
            spNext = sp + Math.mulDiv(net, Q96, L);
            // SqrtPriceMath.getAmount0Delta(roundUp = false)
            amountOut = Math.mulDiv(numerator1, spNext - sp, spNext) / sp;
        }
        require(spNext > TickMath.MIN_SQRT_RATIO && spNext < TickMath.MAX_SQRT_RATIO, "SPL");
        sqrtPriceX96 = uint160(spNext);
        IERC20(zeroForOne ? token1 : token0).transfer(recipient, amountOut);
    }
}
