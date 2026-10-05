// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import {IPositionAdapter} from "contracts/interfaces/IPositionAdapter.sol";
import {ILiquidityAdapter} from "contracts/interfaces/ILiquidityAdapter.sol";
import {ISwapAdapter} from "contracts/interfaces/ISwapAdapter.sol";

/**
 * @title IPoolmigoVault
 * @notice External surface of the MySun LP auto-rebalance vault. Multi-DEX, multi-pool, upgradeable.
 *         In-kind, multi-asset basket model: the receipt token is a pro-rata claim on a basket of tokens.
 * @dev Declaring interface (legacy name) of every vault event and custom error; new code imports {IMySunVault}, which
 *      inherits it unchanged. The `Poolmigo` prefix here, on the custom errors (`PoolmigoVault__*`) and on the shared
 *      implementation, and the ERC-7201 namespace `poolmigo.vault.storage` predate the MySun rebrand and are kept on
 *      purpose: error selectors hash the name, and deployed proxies depend on the namespace (notes/NAMING.md).
 * @custom:security-contact security@mysun.example
 */
interface IPoolmigoVault {
    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    // Basket registry
    event TokenAdded(address indexed token);

    // User flows (in kind — parallel token/amount vectors)
    event Deposited(
        address indexed sender, address indexed receiver, address[] tokens, uint256[] amounts, uint256 shares
    );
    event Redeemed(
        address indexed sender, address indexed receiver, uint256 shares, address[] tokens, uint256[] amounts
    );

    // Keeper / strategy flows
    event Deployed(address indexed keeper, address indexed adapter, address[] tokens, uint256[] amounts);
    event PulledFrom(
        address indexed keeper, address indexed adapter, uint256 sharesBps, address[] tokens, uint256[] amounts
    );
    event Rebalanced(address indexed keeper, address[] tokens, uint256[] harvested, uint256[] fees);
    // Precise liquidity (strategy layer P1) — amounts in the adapter's token order [token0, token1].
    event LiquidityAdded(
        address indexed keeper,
        address indexed adapter,
        uint256 indexed tokenId,
        uint128 liquidityAdded,
        uint256 spent0,
        uint256 spent1,
        uint256 refunded0,
        uint256 refunded1
    );
    event LiquidityRemoved(
        address indexed keeper,
        address indexed adapter,
        uint256 indexed tokenId,
        uint128 liquidity,
        uint256 principal0,
        uint256 principal1,
        uint256 fees0,
        uint256 fees1,
        uint256 idleRefunded0,
        uint256 idleRefunded1
    );
    // Swap capability (strategy layer P3): `amountIn` of the vault's idle swapped by `adapter`, `amountOut` back here.
    event SwapSettled(
        address indexed adapter, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut
    );
    event PerformanceFeeAccrued(address indexed treasury, address[] tokens, uint256[] fees);
    event EmergencyUnwound(address indexed caller, address[] tokens, uint256[] amounts);

    // Registry (multi-DEX / multi-pool) events
    event AdapterAdded(address indexed adapter, bytes32 indexed dex, bytes32 indexed poolId);
    event AdapterRemoved(address indexed adapter);
    event AdapterForceRemoved(address indexed adapter);
    /// @notice The adapter's capability mask after a change (derived at {addAdapter}, or owner-toggled).
    event AdapterCapabilitySet(address indexed adapter, uint8 capabilities);

    // Governance / parameter events
    event KeeperSet(address indexed keeper, bool allowed);
    event RiskManagerSet(address indexed manager, bool allowed);
    event TreasurySet(address indexed oldTreasury, address indexed newTreasury);
    event PerformanceFeeSet(uint16 oldBps, uint16 newBps);
    event PausedSet(bool paused);
    event MaxTotalSupplySet(uint256 oldCap, uint256 newCap);

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error PoolmigoVault__ZeroAddress();
    error PoolmigoVault__ZeroAmount();
    error PoolmigoVault__ZeroShares();
    error PoolmigoVault__FeeTooHigh(uint16 bps, uint16 maxBps);
    error PoolmigoVault__NotKeeper();
    error PoolmigoVault__NotRiskManager();
    error PoolmigoVault__Paused();
    error PoolmigoVault__NoAdapters();
    error PoolmigoVault__LengthMismatch();
    error PoolmigoVault__InsufficientShares(uint256 held, uint256 shares);
    error PoolmigoVault__InsufficientSharesOut(uint256 minShares, uint256 actualShares);
    error PoolmigoVault__ZeroMinShares();
    error PoolmigoVault__InsufficientIdle(address token, uint256 available, uint256 requested);
    error PoolmigoVault__InvalidSharesBps(uint256 sharesBps);

    // Genesis + supply cap
    error PoolmigoVault__ZeroGenesisShares();
    error PoolmigoVault__GenesisNotOwner();
    error PoolmigoVault__SupplyCapExceeded(uint256 newSupply, uint256 cap);
    error PoolmigoVault__InvalidSupplyCap(uint256 cap, uint256 minimum);

    // Receipt token (per-vault name/symbol, set once at initialize)
    error PoolmigoVault__EmptyReceiptName();
    error PoolmigoVault__EmptyReceiptSymbol();

    // Basket registry
    error PoolmigoVault__TokenNotRegistered(address token);
    error PoolmigoVault__TokenAlreadyRegistered(address token);
    error PoolmigoVault__MaxTokensReached(uint256 max);
    error PoolmigoVault__DuplicateToken(address token);
    error PoolmigoVault__MissingBasketToken(address token);

    // Adapter registry
    error PoolmigoVault__AdapterNotRegistered(address adapter);
    error PoolmigoVault__AdapterAlreadyRegistered(address adapter);
    error PoolmigoVault__MaxAdaptersReached(uint256 max);
    error PoolmigoVault__AdapterNoTokens(address adapter);
    error PoolmigoVault__AdapterTokenNotRegistered(address adapter, address token);
    error PoolmigoVault__AdapterStillFunded(address adapter, address token, uint256 amount);

    // Adapter capabilities (P3)
    error PoolmigoVault__CapabilityMissing(address adapter, uint8 capBit);
    error PoolmigoVault__CapabilityUnsupported(address adapter, uint8 capBit);
    error PoolmigoVault__InvalidCapability(uint8 capBit);
    error PoolmigoVault__InsufficientAmountOut(uint256 minAmountOut, uint256 amountOut);
    error PoolmigoVault__InexactDelivery(address token, uint256 required, uint256 received);

    /*//////////////////////////////////////////////////////////////
                                 VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @notice Performance fee (bps) skimmed in kind whenever accrued position fees leave a position; the real
    ///         adapters read it live to report their fee part net of it.
    function performanceFeeBps() external view returns (uint16);

    /*//////////////////////////////////////////////////////////////
                    KEEPER: STRATEGY OPS (P0 / P1 / P3)
    //////////////////////////////////////////////////////////////*/

    /// @notice Keeper: pull `sharesBps / 10_000` of a registered position back into the vault, in kind.
    function pullFrom(IPositionAdapter adapter, uint256 sharesBps)
        external
        returns (address[] memory tokens_, uint256[] memory amounts);

    /// @notice Keeper: harvest ALL positions, perf fee skimmed in kind (as on every path accrued fees leave a position).
    function rebalance() external returns (address[] memory tokens_, uint256[] memory harvested, uint256[] memory fees);

    /// @notice Keeper: swap `p.amountIn` of the vault's idle through a registered {ISwapAdapter} (`CAP_SWAP`); the
    ///         output lands back in the vault (approval reset to 0, `amountOut >= p.minAmountOut` re-checked here).
    function swapExactIn(IPositionAdapter adapter, ISwapAdapter.SwapParams calldata p) external;

    /// @notice Keeper: exact add on a registered {ILiquidityAdapter} (caps approved, then reset to 0).
    function addLiquidity(IPositionAdapter adapter, ILiquidityAdapter.AddLiquidityParams calldata p) external;

    /// @notice Keeper: exact remove (or idle refund) on a registered {ILiquidityAdapter}; everything to the vault.
    function removeLiquidity(IPositionAdapter adapter, ILiquidityAdapter.RemoveLiquidityParams calldata p) external;
}
