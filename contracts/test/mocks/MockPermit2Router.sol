// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {
    IUniversalRouter,
    URCommands,
    UniversalRouterCodec,
    V4ExactInputSingleParams
} from "contracts/adapters/uniswap/IUniversalRouter.sol";
import {MockV3Factory, MockV3Pool} from "test/mocks/MockV3Pool.sol";

/**
 * @notice Dual-role test double: a minimal Permit2 (AllowanceTransfer subset) AND a UniversalRouter that only
 *         understands `V3_SWAP_EXACT_IN` (single hop, payerIsUser). The two roles live at ONE address, so the
 *         allowance model is exactly the real pair's:
 *         - outer layer: ERC-20 allowance payer → Permit2 (this contract), consumed by the ERC-20 `transferFrom`;
 *         - inner layer: Permit2 allowance (payer, token, spender = router = this contract), checked for amount AND
 *           expiration, decremented per pull (Permit2 semantics; `type(uint160).max` is never decremented).
 *         Also accepts `V4_SWAP` in the exact shape `UniversalRouterCodec.v4ExactInSingle` emits
 *         ([SWAP_EXACT_IN_SINGLE, SETTLE(payerIsUser), TAKE(OPEN_DELTA)]) and executes it like a v3 hop (the pool is
 *         looked up by the key's fee; `V4TooLittleReceived` below the min). Execution: at a configurable LINEAR
 *         rate from this contract's own inventory, or (default) through the pair's MockV3Pool (factory `getPool`) at constant liquidity. Reverts the router's `V3TooLittleReceived`
 *         when the output is below `amountOutMin`, or unconditionally when `forceTooLittle` is set. `shortPay`
 *         simulates a non-conforming router (skips the min check, delivers less) so the caller's own balance-delta
 *         re-check can be exercised. Every swap is recorded.
 */
contract MockPermit2Router {
    struct PackedAllowance {
        uint160 amount;
        uint48 expiration;
        uint48 nonce;
    }

    struct SwapCall {
        address payer;
        address recipient;
        address tokenIn;
        address tokenOut;
        uint24 fee;
        uint256 amountIn;
        uint256 amountOutMin;
        uint256 amountOut;
        // inner-layer (Permit2) allowance seen by the router at pull time — the zap sets exactly `amountIn`
        uint160 innerAllowanceSeen;
        // outer-layer (ERC-20 payer → Permit2) allowance seen at pull time
        uint256 outerAllowanceSeen;
    }

    error AllowanceExpired(uint256 deadline);
    error InsufficientAllowance(uint256 amount);
    error TransactionDeadlinePassed();
    error UnsupportedCommand(bytes1 command);
    error InvalidPath();

    MockV3Factory public immutable FACTORY;
    address public positionManager;

    mapping(address owner => mapping(address token => mapping(address spender => PackedAllowance))) internal _allowance;
    mapping(address tokenIn => mapping(address tokenOut => uint256 rateWad)) public linearRateWad;

    bool public forceTooLittle;
    uint256 public shortPay;
    SwapCall[] internal _calls;

    constructor(MockV3Factory factory_) {
        FACTORY = factory_;
        positionManager = address(factory_);
    }

    /*//////////////////////////////////////////////////////////////
                              TEST CONTROLS
    //////////////////////////////////////////////////////////////*/

    /// @dev out = amountIn × rateWad / 1e18, paid from this contract's inventory (0 = route through the pool).
    function setLinearRate(address tokenIn, address tokenOut, uint256 rateWad) external {
        linearRateWad[tokenIn][tokenOut] = rateWad;
    }

    function setForceTooLittle(bool on) external {
        forceTooLittle = on;
    }

    /// @dev Non-conforming router: ignore `amountOutMin` and deliver `shortPay` less than the swap produced.
    function setShortPay(uint256 amount) external {
        shortPay = amount;
    }

    function setPositionManager(address pm) external {
        positionManager = pm;
    }

    function callCount() external view returns (uint256) {
        return _calls.length;
    }

    function callAt(uint256 i) external view returns (SwapCall memory) {
        return _calls[i];
    }

    function clearCalls() external {
        delete _calls;
    }

    /*//////////////////////////////////////////////////////////////
                         PERMIT2 (AllowanceTransfer)
    //////////////////////////////////////////////////////////////*/

    /// @dev Permit2: expiration 0 means "this block".
    function approve(address token, address spender, uint160 amount, uint48 expiration) external {
        PackedAllowance storage a = _allowance[msg.sender][token][spender];
        a.amount = amount;
        a.expiration = expiration == 0 ? uint48(block.timestamp) : expiration;
    }

    function allowance(address user, address token, address spender)
        external
        view
        returns (uint160 amount, uint48 expiration, uint48 nonce)
    {
        PackedAllowance storage a = _allowance[user][token][spender];
        return (a.amount, a.expiration, a.nonce);
    }

    /// @dev Permit2 `transferFrom` for an external spender (not used by the zap; kept for completeness).
    function transferFrom(address from, address to, uint160 amount, address token) external {
        _permit2Pull(from, to, amount, token, msg.sender);
    }

    function _permit2Pull(address from, address to, uint160 amount, address token, address spender) internal {
        PackedAllowance storage a = _allowance[from][token][spender];
        if (block.timestamp > a.expiration) {
            revert AllowanceExpired(a.expiration);
        }
        if (a.amount != type(uint160).max) {
            if (amount > a.amount) {
                revert InsufficientAllowance(a.amount);
            }
            unchecked {
                a.amount -= amount;
            }
        }
        // outer layer: the ERC-20 allowance from → Permit2 (this contract)
        require(IERC20(token).transferFrom(from, to, amount), "TRANSFER_FROM_FAILED");
    }

    /*//////////////////////////////////////////////////////////////
                         UNIVERSAL ROUTER (subset)
    //////////////////////////////////////////////////////////////*/

    function V3_POSITION_MANAGER() external view returns (address) {
        return positionManager;
    }

    function poolManager() external pure returns (address) {
        return address(0);
    }

    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable {
        if (block.timestamp > deadline) {
            revert TransactionDeadlinePassed();
        }
        for (uint256 i; i < commands.length; ++i) {
            if (commands[i] == URCommands.V3_SWAP_EXACT_IN) {
                _v3SwapExactIn(inputs[i]);
            } else if (commands[i] == URCommands.V4_SWAP) {
                _v4SwapExactInSingle(inputs[i]);
            } else {
                revert UnsupportedCommand(commands[i]);
            }
        }
    }

    function _v3SwapExactIn(bytes calldata input) internal {
        (address recipient, uint256 amountIn, uint256 amountOutMin, bytes memory path, bool payerIsUser,) =
            abi.decode(input, (address, uint256, uint256, bytes, bool, uint256[]));
        if (!payerIsUser || path.length != 43) {
            revert InvalidPath();
        }
        (address tokenIn, uint24 fee_, address tokenOut) = _decodePath(path);
        if (forceTooLittle) {
            revert IUniversalRouter.V3TooLittleReceived();
        }
        uint256 produced = _execute(_newCall(recipient, tokenIn, tokenOut, fee_, amountIn, amountOutMin));
        if (shortPay == 0 && produced < amountOutMin) {
            revert IUniversalRouter.V3TooLittleReceived();
        }
    }

    /// @dev V4_SWAP = abi.encode(actions, params) with actions == [SWAP_EXACT_IN_SINGLE, SETTLE, TAKE] (strict).
    function _v4SwapExactInSingle(bytes calldata input) internal {
        (bytes memory actions, bytes[] memory params) = abi.decode(input, (bytes, bytes[]));
        if (
            keccak256(actions)
                    != keccak256(
                        abi.encodePacked(
                            UniversalRouterCodec.SWAP_EXACT_IN_SINGLE,
                            UniversalRouterCodec.SETTLE,
                            UniversalRouterCodec.TAKE
                        )
                    ) || params.length != 3
        ) {
            revert UnsupportedCommand(URCommands.V4_SWAP);
        }
        V4ExactInputSingleParams memory sp = abi.decode(params[0], (V4ExactInputSingleParams));
        (address tokenIn, address tokenOut) =
            sp.zeroForOne ? (sp.poolKey.currency0, sp.poolKey.currency1) : (sp.poolKey.currency1, sp.poolKey.currency0);
        address recipient = _checkSettleTake(params, tokenIn, tokenOut, sp.amountIn);
        if (forceTooLittle) {
            revert IUniversalRouter.V4TooLittleReceived(sp.amountOutMinimum, 0);
        }
        uint256 produced =
            _execute(_newCall(recipient, tokenIn, tokenOut, sp.poolKey.fee, sp.amountIn, sp.amountOutMinimum));
        if (shortPay == 0 && produced < sp.amountOutMinimum) {
            revert IUniversalRouter.V4TooLittleReceived(sp.amountOutMinimum, produced);
        }
    }

    /// @dev SETTLE(tokenIn, amountIn, payerIsUser) + TAKE(tokenOut, recipient, OPEN_DELTA); returns the recipient.
    function _checkSettleTake(bytes[] memory params, address tokenIn, address tokenOut, uint256 amountIn)
        internal
        pure
        returns (address recipient)
    {
        (address settleCurrency, uint256 settleAmount, bool payerIsUser) =
            abi.decode(params[1], (address, uint256, bool));
        address takeCurrency;
        uint256 takeAmount;
        (takeCurrency, recipient, takeAmount) = abi.decode(params[2], (address, address, uint256));
        if (
            settleCurrency != tokenIn || settleAmount != amountIn || !payerIsUser || takeCurrency != tokenOut
                || takeAmount != UniversalRouterCodec.OPEN_DELTA
        ) {
            revert InvalidPath();
        }
    }

    function _newCall(
        address recipient,
        address tokenIn,
        address tokenOut,
        uint24 fee_,
        uint256 amountIn,
        uint256 amountOutMin
    ) internal view returns (SwapCall memory c) {
        c.payer = msg.sender;
        c.recipient = recipient;
        c.tokenIn = tokenIn;
        c.tokenOut = tokenOut;
        c.fee = fee_;
        c.amountIn = amountIn;
        c.amountOutMin = amountOutMin;
        c.innerAllowanceSeen = _allowance[msg.sender][tokenIn][address(this)].amount;
        c.outerAllowanceSeen = IERC20(tokenIn).allowance(msg.sender, address(this));
    }

    /// @dev Pull via Permit2, produce (linear rate or the pool), deliver (minus `shortPay`), record. Returns what was
    ///      produced; the min-out check is the caller's (each swap kind has its own error).
    function _execute(SwapCall memory c) internal returns (uint256 produced) {
        uint256 rate = linearRateWad[c.tokenIn][c.tokenOut];
        if (rate != 0) {
            _permit2Pull(msg.sender, address(this), uint160(c.amountIn), c.tokenIn, address(this));
            produced = Math.mulDiv(c.amountIn, rate, 1e18);
        } else {
            address pool = FACTORY.getPool(c.tokenIn, c.tokenOut, c.fee);
            require(pool != address(0), "NO_POOL");
            _permit2Pull(msg.sender, pool, uint160(c.amountIn), c.tokenIn, address(this));
            produced = MockV3Pool(pool).swapExactIn(c.tokenIn < c.tokenOut, c.amountIn, address(this));
        }
        uint256 delivered = produced;
        if (shortPay != 0) {
            delivered = produced > shortPay ? produced - shortPay : 0;
        } else if (produced < c.amountOutMin) {
            return produced; // the caller reverts with its swap kind's min-out error
        }
        if (delivered != 0) {
            require(IERC20(c.tokenOut).transfer(c.recipient, delivered), "TRANSFER_FAILED");
        }
        c.amountOut = delivered;
        _calls.push(c);
    }

    function _decodePath(bytes memory path) internal pure returns (address tokenIn, uint24 fee_, address tokenOut) {
        assembly ("memory-safe") {
            let p := add(path, 0x20)
            tokenIn := shr(96, mload(p))
            fee_ := shr(232, mload(add(p, 20)))
            tokenOut := shr(96, mload(add(p, 23)))
        }
    }
}
