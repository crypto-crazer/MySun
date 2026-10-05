// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.34;

import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {
    ReentrancyGuardTransientUpgradeable
} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardTransientUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IPoolmigoVault} from "contracts/interfaces/IPoolmigoVault.sol";
import {IPositionAdapter} from "contracts/interfaces/IPositionAdapter.sol";
import {ILiquidityAdapter} from "contracts/interfaces/ILiquidityAdapter.sol";
import {ISwapAdapter} from "contracts/interfaces/ISwapAdapter.sol";
import {ERC165Checker} from "@openzeppelin/contracts/utils/introspection/ERC165Checker.sol";

/**
 * @title PoolmigoVaultUpgradeable
 * @author MySun
 * @notice Multi-DEX, multi-pool LP auto-rebalance vault for EVM chains (first deployment target:
 *         Robinhood Chain, chainId 4663).
 *         UUPS-upgradeable, ERC-7201 namespaced storage.
 *
 *         In-kind, multi-asset BASKET model:
 *         - The receipt token (per vault, e.g. sunEthLP) is a pro-rata claim on a basket of tokens (e.g. USDG + WETH), NOT a USD-denominated claim.
 *         - Deposits are in kind and strictly same-proportion: the user offers basket tokens, the vault
 *           computes shares from the BINDING token (min ratio) and pulls only what that share count
 *           requires. Excess is never pulled. No swaps.
 *         - Redemptions are in kind: the user receives their pro-rata slice of EVERY basket token,
 *           straight from idle balances and from each adapter. No swaps. Frozen while paused (full freeze — only the owner unpauses).
 *         - Adapters speak token vectors, never USD scalars. Token balances ARE the ground truth for
 *           share accounting; no oracle is load-bearing here. TWAP guards live inside adapters only.
 *         - Performance fee is charged in kind, per token, on accrued position fees/rewards WHENEVER they leave a
 *           position — {rebalance} harvests, {redeem} / {pullFrom} slices, {removeLiquidity}, {emergencyUnwind}
 *           (owner ruling 2026-10-03) — skimmed to `treasury` first; never on principal or idle.
 *         - Upgrade authority is `owner` (MUST be a multisig behind a timelock on mainnet).
 *
 * @dev Get an audit before mainnet. Adapters are trusted, owner-registered venue wrappers.
 * @custom:security-contact security@mysun.example
 */
contract PoolmigoVaultUpgradeable is
    IPoolmigoVault,
    Initializable,
    ERC20Upgradeable,
    Ownable2StepUpgradeable,
    ReentrancyGuardTransientUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;
    using Math for uint256;

    /*//////////////////////////////////////////////////////////////
                               CONSTANTS
    //////////////////////////////////////////////////////////////*/

    /// @notice Hard ceiling on the performance fee; owner can never exceed this.
    uint16 public constant MAX_PERFORMANCE_FEE_BPS = 3000; // 30%
    uint16 public constant BPS_DENOMINATOR = 10_000;
    /// @dev Scale of the fraction handed to {IPositionAdapter-withdrawProportional} (`sharesWad` / 1e18).
    uint256 private constant WAD = 1e18;
    /// @dev 1 bp expressed in `sharesWad` units: WAD / BPS_DENOMINATOR = 1e14, exact ({pullFrom} converts with it).
    uint256 private constant WAD_PER_BPS = 1e14;
    /// @notice Bound on registered positions — keeps rebalance/redeem loops gas-safe.
    uint256 public constant MAX_ADAPTERS = 32;
    /// @notice Bound on basket tokens — keeps per-token loops gas-safe.
    uint256 public constant MAX_TOKENS = 8;
    /// @dev Sentinel for "token not found in registry" during in-memory scans.
    uint256 private constant NOT_FOUND = type(uint256).max;
    /// @dev {_exitAll} sentinels (never a valid `sharesWad`, which is <= 1e18): unwind every adapter instead of a slice.
    uint256 private constant UNWIND_ALL = type(uint256).max;
    /// @dev {_exitAll} sentinel: harvest every adapter (its amounts are all fees).
    uint256 private constant HARVEST_ALL = type(uint256).max - 1;
    /// @dev Virtual shares / virtual assets (donation / inflation guard) — applied to the DEPOSIT
    ///      conversion only: shares = floor(amount * (S + VIRTUAL_SHARES) / (T + VIRTUAL_ASSETS)).
    ///      Redemption stays REAL pro-rata. VIRTUAL_ASSETS is per basket token (1 raw unit each).
    ///
    ///      Final values VS = VA = 1 (OZ ERC-4626's default offset-0 ratio), tuned DOWN from the 1e6/1
    ///      starting point because the deposit side is virtual but redeem is real: a deposit→redeem
    ///      round trip on token i returns <= what was pulled iff VS/VA <= S/T_i (shares per raw unit).
    ///      At the ≈$1/share genesis scale, S/T_i ≈ price_i * 1e18 / 10^dec_i — ~1e3 for an 18-dp WETH
    ///      leg — so VS = 1e6 let the WETH leg round-trip up to +997 wei (fuzz counterexample; the
    ///      demo-scale sweep also gained). VS = 1 holds for every token priced >= 1 display unit per
    ///      whole token; below that (18-dp micro-price tokens) the residual is < 1 share-wei of value.
    ///      The donation / inflation defence does not rest on the virtual size: genesis is owner-gated
    ///      with a large K, and deposits pull only ceil(shares * (T + VA) / (S + VS)), so a depositor
    ///      pays for exactly the shares it receives. At a degenerate 1-share-wei supply, VS = 1 still
    ///      makes a donating sole holder strictly lose (tests: test_DonationInflation_*).
    uint256 private constant VIRTUAL_SHARES = 1;
    uint256 private constant VIRTUAL_ASSETS = 1;
    /// @notice Capability bits (per-adapter mask, P3): {ILiquidityAdapter} ops / {ISwapAdapter} swaps.
    uint8 public constant CAP_LIQUIDITY = 1;
    uint8 public constant CAP_SWAP = 2;

    /*//////////////////////////////////////////////////////////////
                        ERC-7201 NAMESPACED STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @custom:storage-location erc7201:poolmigo.vault.storage
    struct PoolmigoVaultStorage {
        address treasury; // performance-fee recipient (multisig)
        uint16 performanceFeeBps; // fee on accrued position fees/rewards leaving a position, charged in kind
        bool paused; // full safety freeze: blocks deposit + redeem + deploy + rebalance (owner unpauses)
        address[] tokens; // basket registry, owner-managed, <= MAX_TOKENS
        mapping(address token => bool registered) isToken;
        IPositionAdapter[] adapters; // registry of live positions (multi-DEX / multi-pool)
        mapping(address adapter => bool registered) isAdapter;
        mapping(address keeper => bool allowed) isKeeper;
        uint256 genesisShares; // K: shares minted by the (owner-gated) genesis deposit; fixes the display scale
        uint256 maxTotalSupply; // receipt-token supply cap (PRD F1.2); 0 = uncapped
        mapping(address manager => bool allowed) isRiskManager; // fast-reaction layer: pause + emergencyUnwind only
        mapping(address adapter => uint8 mask) capabilities; // CAP_* bits: ERC-165-derived at addAdapter, owner-toggled
    }

    // keccak256(abi.encode(uint256(keccak256("poolmigo.vault.storage")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant POOLMIGO_VAULT_STORAGE_LOCATION =
        0xac5b1d856d96bdb992e4d284c4f305568246dd601ded20a127e04a49bd0b7b00;

    function _s() private pure returns (PoolmigoVaultStorage storage $) {
        assembly {
            $.slot := POOLMIGO_VAULT_STORAGE_LOCATION
        }
    }

    /*//////////////////////////////////////////////////////////////
                                MODIFIERS
    //////////////////////////////////////////////////////////////*/

    modifier onlyKeeper() {
        _checkKeeper();
        _;
    }

    modifier onlyOwnerOrRiskManager() {
        _checkOwnerOrRiskManager();
        _;
    }

    /*//////////////////////////////////////////////////////////////
                             INITIALIZATION
    //////////////////////////////////////////////////////////////*/

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers(); // lock the implementation; only proxies get initialized
    }

    /**
     * @notice Initialize the proxy. Replaces the constructor for upgradeable deployment.
     * @param owner_ Vault owner + upgrade authority — MUST be a multisig (behind timelock) on mainnet.
     * @param name_ Receipt-token ERC-20 name, per vault (e.g. "sunEthLP", "sun5StocksLP" — notes/NAMING.md).
     *        Rejected if empty or ASCII-whitespace-only (`PoolmigoVault__EmptyReceiptName`).
     * @param symbol_ Receipt-token ERC-20 symbol, per vault; same blank rule (`PoolmigoVault__EmptyReceiptSymbol`).
     *        Name/symbol live in the ERC20 base's storage and are immutable after initialize (no setter).
     * @param tokens_ Initial basket registry (non-empty, no zero addresses, no duplicates, <= MAX_TOKENS).
     * @param treasury_ Performance-fee recipient (multisig).
     * @param performanceFeeBps_ Initial performance fee (bps), <= MAX_PERFORMANCE_FEE_BPS.
     * @param genesisShares_ K — shares minted by the owner-gated genesis deposit (non-zero). Chosen
     *        against a manual, one-time, off-chain valuation of the seed basket so the display scale
     *        starts at ≈$1/share; the contract never prices anything.
     * @param maxTotalSupply_ Receipt-token supply cap (0 = uncapped); if set, must be >= `genesisShares_`.
     */
    function initialize(
        address owner_,
        string memory name_,
        string memory symbol_,
        address[] calldata tokens_,
        address treasury_,
        uint16 performanceFeeBps_,
        uint256 genesisShares_,
        uint256 maxTotalSupply_
    ) external initializer {
        if (owner_ == address(0) || treasury_ == address(0)) {
            revert PoolmigoVault__ZeroAddress();
        }
        if (_isBlank(name_)) {
            revert PoolmigoVault__EmptyReceiptName();
        }
        if (_isBlank(symbol_)) {
            revert PoolmigoVault__EmptyReceiptSymbol();
        }
        if (performanceFeeBps_ > MAX_PERFORMANCE_FEE_BPS) {
            revert PoolmigoVault__FeeTooHigh(performanceFeeBps_, MAX_PERFORMANCE_FEE_BPS);
        }
        if (genesisShares_ == 0) {
            revert PoolmigoVault__ZeroGenesisShares();
        }
        if (maxTotalSupply_ != 0 && maxTotalSupply_ < genesisShares_) {
            revert PoolmigoVault__InvalidSupplyCap(maxTotalSupply_, genesisShares_);
        }
        uint256 n = tokens_.length;
        if (n == 0) {
            revert PoolmigoVault__LengthMismatch();
        }
        if (n > MAX_TOKENS) {
            revert PoolmigoVault__MaxTokensReached(MAX_TOKENS);
        }

        __ERC20_init(name_, symbol_);
        __Ownable_init(owner_);
        __Ownable2Step_init();
        __ReentrancyGuardTransient_init();
        __UUPSUpgradeable_init();

        PoolmigoVaultStorage storage $ = _s();
        $.treasury = treasury_;
        $.performanceFeeBps = performanceFeeBps_;
        $.genesisShares = genesisShares_;
        $.maxTotalSupply = maxTotalSupply_;
        emit MaxTotalSupplySet(0, maxTotalSupply_);
        for (uint256 i; i < n; ++i) {
            _addToken($, tokens_[i]);
        }
    }

    /*//////////////////////////////////////////////////////////////
                    USER-FACING STATE-CHANGING FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Deposit basket tokens in kind and mint receipt-token shares to `receiver`.
     * @dev STRICT same-proportion rule, no swaps:
     *      - Genesis (totalSupply == 0): OWNER ONLY (`PoolmigoVault__GenesisNotOwner` otherwise) — the
     *        team's ONE controlled seed. `tokens_` must cover the FULL registry, every amount > 0, every
     *        amount is pulled in full, and `shares = genesisShares` (K, fixed at initialize). The team's
     *        manual (off-chain, one-time, no oracle) valuation of the seed basket versus K fixes the
     *        display scale (≈$1/share); afterwards the scale never changes — every later deposit and
     *        redemption is a pure ratio. If supply ever returns to 0 (full redemption) this branch
     *        re-arms with the same stored K, owner-gated again.
     *      - Normal: the PARTICIPATING tokens are those the vault holds (T_i > 0) and that are offered
     *        with amount > 0. shares = min over them of floor(amount_i * (S + VS) / (T_i + VA));
     *        required_i = ceil(shares * (T_i + VA) / (S + VS)) is pulled per participating token (VS/VA =
     *        virtual shares/assets, the donation guard — see the constants). Any offer above `required_i`
     *        is simply never pulled (no refund transfer needed). EVERY held token (T_i > 0) must be
     *        offered non-zero — strict participation (fix round): an omitted or zero-offered held token
     *        is rejected (`PoolmigoVault__MissingBasketToken` / `PoolmigoVault__ZeroAmount`), including a
     *        1-wei dust donation. The former dust exemption (optional iff the draw rounds to 0 wei) was
     *        removed: k merged deposits composed sub-wei roundings into >= 1 wei at redeem (K-14 reread,
     *        issue #2). Tokens with T_i == 0 are optional and pull 0.
     *      Reverts `PoolmigoVault__SupplyCapExceeded` if a non-zero `maxTotalSupply` would be exceeded
     *      (genesis included).
     *      Reverts with `PoolmigoVault__InsufficientSharesOut` when the computable `shares` is below
     *      `minShares` — depositor slippage protection; nothing is pulled on that revert.
     *      `minShares == 0` reverts `PoolmigoVault__ZeroMinShares` (enforced non-zero; at genesis the
     *      owner knows `shares == genesisShares` upfront).
     * @param tokens_ Tokens offered (any order, no duplicates, all registered).
     * @param amounts_ Max amount offered per token, aligned to `tokens_`.
     * @param minShares Minimum acceptable shares minted — MANDATORY, must be non-zero. The
     *        deposit-pricing read can only over-price (research/spot-read/findings.md), so this
     *        bound is the depositor's protection.
     * @param receiver Recipient of the minted shares.
     * @return shares Shares minted.
     */
    function deposit(address[] calldata tokens_, uint256[] calldata amounts_, uint256 minShares, address receiver)
        external
        nonReentrant
        returns (uint256 shares)
    {
        if (receiver == address(0)) {
            revert PoolmigoVault__ZeroAddress();
        }
        if (minShares == 0) {
            revert PoolmigoVault__ZeroMinShares();
        }
        _requireNotPaused();

        uint256[] memory required;
        (shares, required) = _previewDeposit(tokens_, amounts_);
        if (shares < minShares) {
            revert PoolmigoVault__InsufficientSharesOut(minShares, shares);
        }

        // Pull only what the share count requires; excess offered stays with the sender.
        uint256 n = tokens_.length;
        for (uint256 i; i < n; ++i) {
            if (required[i] != 0) {
                _pullExact(tokens_[i], required[i]);
            }
        }
        _mint(receiver, shares);

        emit Deposited(msg.sender, receiver, tokens_, required, shares);
    }

    /**
     * @notice Burn `shares` and send the pro-rata slice of EVERY basket token, in kind, to `receiver`.
     * @dev Frozen while paused (a full safety freeze: deposits, redemptions, deploys and rebalances all
     *      stop until the owner unpauses); no oracle, no swaps, and NO adapter reports needed (no `position()`
     *      read) — an adapter whose `position()` reverts cannot block a redemption (one whose
     *      `withdrawProportional` reverts can: see {forceRemoveAdapter}). Each adapter delivers floor(sharesWad /
     *      1e18) of everything it holds INTO the vault, with sharesWad = floor(shares * 1e18 / totalSupply), and
     *      reports the accrued fees inside that slice (the withdrawal call's own return value); the vault takes
     *      floor(shares * idle / totalSupply) of its own balances, snapshotted before any interaction. The
     *      performance fee is skimmed to `treasury` on the combined fee slices (floor per token, plain ERC-20
     *      transfers only); `receiver` gets idle slice + adapter slices − that cut. Rounding on the adapter side
     *      (the 1e18-scaled fraction plus the adapter's own flooring, e.g. of liquidity) leaves a few raw units
     *      per adapter holding in place for the remaining holders (dust convention; the vault never
     *      over-delivers). Adapters are skipped only when sharesWad == 0, i.e. shares * 1e18 < totalSupply.
     * @return tokens_ Registry tokens.
     * @return amounts Amount of each token actually delivered to `receiver` (net of the performance-fee cut).
     */
    function redeem(uint256 shares, address receiver)
        external
        nonReentrant
        returns (address[] memory tokens_, uint256[] memory amounts)
    {
        if (shares == 0) {
            revert PoolmigoVault__ZeroShares();
        }
        if (receiver == address(0)) {
            revert PoolmigoVault__ZeroAddress();
        }
        _requireNotPaused();
        uint256 held = balanceOf(msg.sender);
        if (held < shares) {
            revert PoolmigoVault__InsufficientShares(held, shares);
        }

        uint256 supplyBefore = totalSupply();
        uint256 sharesWad = shares.mulDiv(WAD, supplyBefore, Math.Rounding.Floor);

        tokens_ = _s().tokens;
        uint256 n = tokens_.length;

        // Snapshot the exact idle slice BEFORE any interaction (pro-rata of the vault's own balances).
        uint256[] memory idleOut = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            idleOut[i] = shares.mulDiv(_idle(tokens_[i]), supplyBefore, Math.Rounding.Floor);
        }

        // Effects before interactions.
        _burn(msg.sender, shares);

        // Adapter slices land in the vault; the perf fee is skimmed on the fees inside them, then all goes out.
        uint256[] memory fees;
        (amounts, fees) = _exitAll(tokens_, sharesWad);
        uint256[] memory cut = _skimPerformanceFee(tokens_, fees);
        for (uint256 i; i < n; ++i) {
            uint256 out = idleOut[i] + amounts[i] - cut[i];
            amounts[i] = out;
            if (out != 0) {
                IERC20(tokens_[i]).safeTransfer(receiver, out);
            }
        }

        emit Redeemed(msg.sender, receiver, shares, tokens_, amounts);
    }

    /*//////////////////////////////////////////////////////////////
                        KEEPER (STRATEGY) FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Keeper deploys idle vault tokens into a specific registered position.
     * @dev Which pool, how much, and when are off-chain strategy decisions; this just moves funds into a
     *      venue the owner has whitelisted. Approves exactly `amounts`, lets the adapter pull, then zeroes
     *      every approval. `amounts` is aligned to the adapter's current `position()` token order.
     */
    function deployTo(IPositionAdapter adapter, uint256[] memory amounts) external nonReentrant onlyKeeper {
        _requireOpenAdapter(adapter);

        (address[] memory t,) = _positionOf(adapter);
        uint256 n = t.length;
        if (amounts.length != n) {
            revert PoolmigoVault__LengthMismatch();
        }
        _approveFunded(adapter, t, amounts);
        adapter.deploy(amounts);
        _approveAll(adapter, t, new uint256[](n));

        emit Deployed(msg.sender, address(adapter), t, amounts);
    }

    /**
     * @notice Keeper pulls `sharesBps / 10_000` of a registered position back into the vault, in kind.
     * @dev `pullFrom` + {deployTo} together express "pull from venue A, deploy to venue B" re-shaping
     *      (range / venue moves) entirely on-chain, with no owner step. The destination is HARD-WIRED to
     *      the vault — it is never a parameter, so this can never become a fund-egress path. Accrued fees
     *      inside the pulled slice leave the position here, so the performance fee is skimmed to `treasury`
     *      on the fees the adapter reports (floor per token); everything else (principal, adapter idle, the
     *      fees net of the cut) stays as vault idle — `totalTokens()` drops by exactly the cut (modulo the
     *      adapter's flooring). Blocked while paused, like every keeper action. The adapter is asked for
     *      sharesWad = sharesBps * 1e14 (exact: 1 bp = 1e14 / 1e18).
     * @param adapter Registered position to pull from.
     * @param sharesBps Fraction of the position to pull, in bps (1..10_000; 10_000 = everything).
     * @return tokens_ Tokens the adapter delivered (adapter order).
     * @return amounts GROSS amounts the adapter delivered to the vault, aligned to `tokens_` (the cut is in
     *         `PerformanceFeeAccrued`).
     */
    function pullFrom(IPositionAdapter adapter, uint256 sharesBps)
        external
        nonReentrant
        onlyKeeper
        returns (address[] memory tokens_, uint256[] memory amounts)
    {
        _requireOpenAdapter(adapter);
        if (sharesBps == 0 || sharesBps > BPS_DENOMINATOR) {
            revert PoolmigoVault__InvalidSharesBps(sharesBps);
        }

        uint256[] memory fees;
        (tokens_, amounts, fees) = _withdrawFrom(adapter, sharesBps * WAD_PER_BPS);
        _skimPerformanceFee(tokens_, fees);

        emit PulledFrom(msg.sender, address(adapter), sharesBps, tokens_, amounts);
    }

    /**
     * @notice Keeper adds an exact raw liquidity to a registered position at absolute bounds (strategy layer P1).
     * @dev Mirrors {deployTo}: registered adapter, not paused, both adapter tokens registered, and each cap
     *      (`p.maxAmount0/1`, adapter token order) within the vault's idle (`PoolmigoVault__InsufficientIdle`).
     *      Approves exactly the caps, lets the adapter pull what the op needs (<= caps) and refund its leftover
     *      here, then zeroes both approvals. Range constraints, price guards and the `minLiquidity` / `minSwapOut`
     *      floors are enforced by the adapter ({ILiquidityAdapter-addLiquidity}). Needs CAP_LIQUIDITY
     *      (`PoolmigoVault__CapabilityMissing`). No storage change.
     * @param adapter Registered position implementing {ILiquidityAdapter}.
     * @param p Bounds, target / min liquidity, pull caps, swap floor.
     */
    function addLiquidity(IPositionAdapter adapter, ILiquidityAdapter.AddLiquidityParams calldata p)
        external
        nonReentrant
        onlyKeeper
    {
        address[] memory t = _liquidityTokens(adapter);
        uint256[] memory caps = new uint256[](2);
        (caps[0], caps[1]) = (p.maxAmount0, p.maxAmount1);
        _approveFunded(adapter, t, caps);
        (uint256 id, uint128 added, uint256 spent0, uint256 spent1, uint256 refunded0, uint256 refunded1) =
            ILiquidityAdapter(address(adapter)).addLiquidity(p);
        _approveAll(adapter, t, new uint256[](2));

        emit LiquidityAdded(msg.sender, address(adapter), id, added, spent0, spent1, refunded0, refunded1);
    }

    /**
     * @notice Keeper removes an exact raw liquidity from a registered position — or, with `p.liquidity == 0`, has
     *         it refund its free idle — back into the vault (strategy layer P1).
     * @dev Registered adapter, not paused, CAP_LIQUIDITY. The destination is HARD-WIRED to the vault inside the
     *      adapter (never a parameter). Principal floors, fee collection and the principal / fee / idle split are the
     *      adapter's ({ILiquidityAdapter-removeLiquidity}). No approvals, no storage change. Like {pullFrom}, the
     *      collected fees land in the vault and the performance fee is skimmed to `treasury` on the adapter-reported
     *      `fees0/fees1` (floor per token); principal and idle refunds are never skimmed. The event still carries the
     *      adapter's gross split (the cut is in `PerformanceFeeAccrued`). Gates and tokens as {addLiquidity}.
     * @param adapter Registered position implementing {ILiquidityAdapter}.
     * @param p Raw liquidity (0 = idle-refund mode) and principal floors.
     */
    function removeLiquidity(IPositionAdapter adapter, ILiquidityAdapter.RemoveLiquidityParams calldata p)
        external
        nonReentrant
        onlyKeeper
    {
        address[] memory t = _liquidityTokens(adapter);
        ILiquidityAdapter la = ILiquidityAdapter(address(adapter));
        uint256 id = la.tokenId(); // remove never burns: the id is the same after the call
        (uint256 principal0, uint256 principal1, uint256 fees0, uint256 fees1, uint256 idle0, uint256 idle1) =
            la.removeLiquidity(p);
        uint256[] memory fees = new uint256[](2);
        (fees[0], fees[1]) = (fees0, fees1);
        _skimPerformanceFee(t, fees);
        emit LiquidityRemoved(
            msg.sender, address(adapter), id, p.liquidity, principal0, principal1, fees0, fees1, idle0, idle1
        );
    }

    /**
     * @notice Keeper swaps `p.amountIn` of the vault's idle `p.tokenIn` into `p.tokenOut` through a registered
     *         {ISwapAdapter} (strategy layer P3); the output lands back in the vault.
     * @dev Registered adapter, not paused, CAP_SWAP (`PoolmigoVault__CapabilityMissing`); both tokens in the
     *      basket (`PoolmigoVault__AdapterTokenNotRegistered`) and `amountIn` within the idle
     *      (`PoolmigoVault__InsufficientIdle`); `amountIn > 0` (`PoolmigoVault__ZeroAmount`); `tokenIn != tokenOut`
     *      (`PoolmigoVault__DuplicateToken`). Approves exactly `amountIn`, lets the adapter pull it, resets the
     *      approval to 0. The adapter swaps through its own guarded venue path (its TWAP floor or `p.minAmountOut`,
     *      whichever is stricter) and returns the whole output here; the returned amount is re-checked against
     *      `p.minAmountOut` (`PoolmigoVault__InsufficientAmountOut`). Value moves between basket tokens only; no fee,
     *      no storage change.
     * @param adapter Registered position implementing {ISwapAdapter}.
     * @param p Token pair (the adapter's), exact input, output floor.
     */
    function swapExactIn(IPositionAdapter adapter, ISwapAdapter.SwapParams calldata p)
        external
        nonReentrant
        onlyKeeper
    {
        _requireCapability(adapter, CAP_SWAP);
        address tokenIn = p.tokenIn;
        address tokenOut = p.tokenOut;
        uint256 amountIn = p.amountIn;
        _requireFundable(adapter, tokenIn, amountIn);
        _requireFundable(adapter, tokenOut, 0);
        if (amountIn == 0) {
            revert PoolmigoVault__ZeroAmount();
        }
        if (tokenIn == tokenOut) {
            revert PoolmigoVault__DuplicateToken(tokenIn);
        }

        IERC20(tokenIn).forceApprove(address(adapter), amountIn);
        uint256 amountOut = ISwapAdapter(address(adapter)).swapExactIn(p);
        IERC20(tokenIn).forceApprove(address(adapter), 0);
        if (amountOut < p.minAmountOut) {
            revert PoolmigoVault__InsufficientAmountOut(p.minAmountOut, amountOut);
        }

        emit SwapSettled(address(adapter), tokenIn, tokenOut, amountIn, amountOut);
    }

    /**
     * @notice Keeper-triggered rebalance tick: harvest ALL positions, skim the perf fee in kind per token.
     * @dev Adapters send harvested tokens straight to the vault; the fee is charged on the COMBINED
     *      harvest across all adapters. Position re-shaping lives off-chain / in adapters.
     * @return tokens_ Registry tokens.
     * @return harvested Total harvested per token across all positions.
     * @return fees Fee sent to treasury per token.
     */
    function rebalance()
        external
        nonReentrant
        onlyKeeper
        returns (address[] memory tokens_, uint256[] memory harvested, uint256[] memory fees)
    {
        _requireNotPaused();
        PoolmigoVaultStorage storage $ = _s();
        uint256 len = $.adapters.length;
        if (len == 0) {
            revert PoolmigoVault__NoAdapters();
        }

        tokens_ = $.tokens;
        (harvested,) = _exitAll(tokens_, HARVEST_ALL);
        fees = _skimPerformanceFee(tokens_, harvested);

        emit Rebalanced(msg.sender, tokens_, harvested, fees);
    }

    /*//////////////////////////////////////////////////////////////
                        OWNER / GOVERNANCE FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice Register a new basket token. No removal in this phase.
    function addToken(address token) external onlyOwner {
        _addToken(_s(), token);
    }

    /// @notice Register a new position (a DEX+pool adapter). Every token it reports must be in the basket.
    function addAdapter(IPositionAdapter adapter) external onlyOwner {
        if (address(adapter) == address(0)) {
            revert PoolmigoVault__ZeroAddress();
        }
        PoolmigoVaultStorage storage $ = _s();
        if ($.isAdapter[address(adapter)]) {
            revert PoolmigoVault__AdapterAlreadyRegistered(address(adapter));
        }
        if ($.adapters.length >= MAX_ADAPTERS) {
            revert PoolmigoVault__MaxAdaptersReached(MAX_ADAPTERS);
        }
        (address[] memory t,) = _positionOf(adapter);
        uint256 n = t.length;
        if (n == 0) {
            revert PoolmigoVault__AdapterNoTokens(address(adapter));
        }
        for (uint256 i; i < n; ++i) {
            if (t[i] == address(0)) {
                revert PoolmigoVault__ZeroAddress();
            }
            if (!$.isToken[t[i]]) {
                revert PoolmigoVault__AdapterTokenNotRegistered(address(adapter), t[i]);
            }
        }
        $.isAdapter[address(adapter)] = true;
        $.adapters.push(adapter);
        emit AdapterAdded(address(adapter), adapter.dex(), adapter.poolId());
        // Capabilities are DERIVED from the adapter's own ERC-165 answers (the owner cannot grant unsupported ones);
        // a non-ERC-165 adapter gets 0 — never a revert.
        uint8 caps = _supportedCapabilities(adapter);
        $.capabilities[address(adapter)] = caps;
        emit AdapterCapabilitySet(address(adapter), caps);
    }

    /**
     * @notice Enable / disable one capability bit of a registered adapter (P3).
     * @dev `capBit` must be exactly CAP_LIQUIDITY or CAP_SWAP (`PoolmigoVault__InvalidCapability`). Disabling is always
     *      allowed (a kill switch for that op family, paused or not); enabling re-checks the adapter's ERC-165 answer
     *      (`PoolmigoVault__CapabilityUnsupported`) — the owner can narrow, never fake, a capability.
     */
    function setAdapterCapability(IPositionAdapter adapter, uint8 capBit, bool enabled) external onlyOwner {
        PoolmigoVaultStorage storage $ = _s();
        _requireRegistered(adapter);
        if (capBit != CAP_LIQUIDITY && capBit != CAP_SWAP) {
            revert PoolmigoVault__InvalidCapability(capBit);
        }
        uint8 caps = $.capabilities[address(adapter)];
        if (enabled) {
            if (_supportedCapabilities(adapter) & capBit == 0) {
                revert PoolmigoVault__CapabilityUnsupported(address(adapter), capBit);
            }
            caps |= capBit;
        } else {
            caps &= ~capBit;
        }
        $.capabilities[address(adapter)] = caps;
        emit AdapterCapabilitySet(address(adapter), caps);
    }

    /// @notice Remove a position. Must be emptied first (unwound) so no value is orphaned.
    function removeAdapter(IPositionAdapter adapter) external onlyOwner {
        PoolmigoVaultStorage storage $ = _s();
        _requireRegistered(adapter);
        (address[] memory t, uint256[] memory a) = _positionOf(adapter);
        uint256 n = t.length;
        for (uint256 i; i < n; ++i) {
            if (a[i] != 0) {
                revert PoolmigoVault__AdapterStillFunded(address(adapter), t[i], a[i]);
            }
        }
        _dropAdapter($, adapter);
        emit AdapterRemoved(address(adapter));
    }

    /**
     * @notice Recovery path: unregister a BROKEN adapter without calling it and without requiring it to be empty.
     * @dev Every vault-wide loop calls every registered adapter with no per-adapter isolation: an adapter whose
     *      `withdrawProportional` reverts blocks EVERY redemption, and one whose `position()` reverts blocks every
     *      deposit (`totalTokens`) and cannot leave through {removeAdapter} (which needs `position()` to report
     *      zeros). Without this function both states last until a UUPS upgrade. This is a plain swap-and-pop —
     *      it never calls the adapter (no `position()`, no withdrawal), so it cannot be blocked by it.
     *      Assets still held by the removed adapter STAY THERE: they leave `totalTokens()` (share accounting
     *      continues over what the vault can still reach) and are recoverable later — by re-registering the
     *      adapter with {addAdapter} once it works again (its holdings then count again — credited to whoever
     *      holds shares at that moment), or via an upgrade.
     *      Prefer {removeAdapter} (or `pullFrom(adapter, 10_000)` first) whenever the adapter still responds.
     *      Owner only; not paused-gated (it is an emergency lever).
     * @param adapter Registered adapter to drop.
     */
    function forceRemoveAdapter(IPositionAdapter adapter) external onlyOwner {
        PoolmigoVaultStorage storage $ = _s();
        _requireRegistered(adapter);
        _dropAdapter($, adapter);
        emit AdapterForceRemoved(address(adapter));
    }

    /// @notice Pause/unpause the vault — a full safety freeze: deposits, redemptions, deploys and rebalances.
    function setPaused(bool paused) external onlyOwner {
        _setPausedFlag(paused);
    }

    /**
     * @notice One-way safety switch: pause every flow (deposits, redemptions, deploys, rebalances). Owner or any risk manager.
     * @dev Idempotent (alerting services may race): already paused = silent no-op, no event. Unpausing is
     *      the owner's call only ({setPaused}).
     */
    function pause() external onlyOwnerOrRiskManager {
        if (!_s().paused) {
            _setPausedFlag(true);
        }
    }

    /**
     * @notice Emergency: unwind ALL positions in kind back to the vault, then pause. Owner (multisig) or any
     *         risk manager.
     * @dev No exemption: the accrued fees the positions release are skimmed to `treasury` like on every other
     *      exit path (combined across adapters, floor per token); principal and idle are never skimmed.
     * @return tokens_ Registry tokens.
     * @return amounts GROSS amount of each token pulled back into the vault (the cut is in `PerformanceFeeAccrued`).
     */
    function emergencyUnwind()
        external
        nonReentrant
        onlyOwnerOrRiskManager
        returns (address[] memory tokens_, uint256[] memory amounts)
    {
        _setPausedFlag(true);

        tokens_ = _s().tokens;
        uint256[] memory fees;
        (amounts, fees) = _exitAll(tokens_, UNWIND_ALL);
        _skimPerformanceFee(tokens_, fees);
        emit EmergencyUnwound(msg.sender, tokens_, amounts);
    }

    /// @notice Set performance fee (bps). Hard-capped by MAX_PERFORMANCE_FEE_BPS.
    function setPerformanceFeeBps(uint16 newBps) external onlyOwner {
        if (newBps > MAX_PERFORMANCE_FEE_BPS) {
            revert PoolmigoVault__FeeTooHigh(newBps, MAX_PERFORMANCE_FEE_BPS);
        }
        PoolmigoVaultStorage storage $ = _s();
        emit PerformanceFeeSet($.performanceFeeBps, newBps);
        $.performanceFeeBps = newBps;
    }

    /// @notice Add/remove a keeper (main + backup hot keys).
    function setKeeper(address keeper, bool allowed) external onlyOwner {
        _setFlag(_s().isKeeper, keeper, allowed);
        emit KeeperSet(keeper, allowed);
    }

    /// @notice Add/remove a risk manager (alerting service / risk operator): may only {pause} + {emergencyUnwind}.
    function setRiskManager(address manager, bool allowed) external onlyOwner {
        _setFlag(_s().isRiskManager, manager, allowed);
        emit RiskManagerSet(manager, allowed);
    }

    /**
     * @notice Set the receipt-token supply cap (PRD F1.2 — staged opening, oracle-free). `0` = uncapped.
     * @dev A non-zero cap must be >= the current `totalSupply()`: a cap below supply would brick every
     *      deposit until enough holders redeem, so it is rejected (`PoolmigoVault__InvalidSupplyCap`).
     *      To stop deposits outright, use {setPaused}. Redemptions are never affected.
     */
    function setMaxTotalSupply(uint256 newCap) external onlyOwner {
        uint256 supply = totalSupply();
        if (newCap != 0 && newCap < supply) {
            revert PoolmigoVault__InvalidSupplyCap(newCap, supply);
        }
        PoolmigoVaultStorage storage $ = _s();
        emit MaxTotalSupplySet($.maxTotalSupply, newCap);
        $.maxTotalSupply = newCap;
    }

    /// @notice Update the performance-fee treasury (multisig).
    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) {
            revert PoolmigoVault__ZeroAddress();
        }
        PoolmigoVaultStorage storage $ = _s();
        emit TreasurySet($.treasury, newTreasury);
        $.treasury = newTreasury;
    }

    /*//////////////////////////////////////////////////////////////
                     USER-FACING READ-ONLY FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice Performance-fee recipient.
    function treasury() external view returns (address) {
        return _s().treasury;
    }

    /// @notice Performance fee in bps, charged in kind on accrued position fees whenever they leave a position.
    function performanceFeeBps() external view returns (uint16) {
        return _s().performanceFeeBps;
    }

    /// @notice True while deposits / redeems / deploys / rebalances are paused (a full freeze; only the owner unpauses).
    function paused() external view returns (bool) {
        return _s().paused;
    }

    /// @notice K — shares minted by the owner-gated genesis deposit (fixes the display scale, ≈$1/share).
    function genesisShares() external view returns (uint256) {
        return _s().genesisShares;
    }

    /// @notice Receipt-token supply cap; `0` = uncapped.
    function maxTotalSupply() external view returns (uint256) {
        return _s().maxTotalSupply;
    }

    /// @notice Whether `account` may call keeper functions.
    function isKeeper(address account) external view returns (bool) {
        return _s().isKeeper[account];
    }

    /// @notice Whether `account` may call {pause} + {emergencyUnwind} (besides the owner).
    function isRiskManager(address account) external view returns (bool) {
        return _s().isRiskManager[account];
    }

    /// @notice Whether `account` is a registered position adapter.
    function isAdapter(address account) external view returns (bool) {
        return _s().isAdapter[account];
    }

    /// @notice Capability mask of `adapter` (CAP_* bits; 0 when unregistered — cleared on removal, re-derived on add).
    function adapterCapabilities(IPositionAdapter adapter) external view returns (uint8) {
        return _s().capabilities[address(adapter)];
    }

    /// @notice Whether `token` is in the basket registry.
    function isToken(address token) external view returns (bool) {
        return _s().isToken[token];
    }

    /// @notice Basket registry (stable order; new tokens append).
    function tokens() external view returns (address[] memory) {
        return _s().tokens;
    }

    /// @notice Number of registered positions (across all DEXs/pools).
    function adapterCount() external view returns (uint256) {
        return _s().adapters.length;
    }

    /// @notice Registered position by index.
    function adapterAt(uint256 index) external view returns (IPositionAdapter) {
        return _adapterAt(index);
    }

    /// @notice All registered positions.
    function adapters() external view returns (IPositionAdapter[] memory) {
        return _s().adapters;
    }

    /**
     * @notice Total basket holdings: per registry token = idle balance + Σ over adapters of `position()`.
     * @dev Calls each adapter's `position()` once and scans in memory. Amounts an adapter reports for a
     *      token that is NOT registered are ignored (cannot be accounted); addAdapter prevents this.
     * @return tokens_ Registry tokens.
     * @return amounts Total amount held per token (idle + positions, incl. uncollected fees net of the perf fee).
     */
    function totalTokens() public view returns (address[] memory tokens_, uint256[] memory amounts) {
        PoolmigoVaultStorage storage $ = _s();
        tokens_ = $.tokens;
        uint256 n = tokens_.length;
        amounts = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            amounts[i] = _idle(tokens_[i]);
        }
        uint256 len = $.adapters.length;
        for (uint256 i; i < len; ++i) {
            (address[] memory t, uint256[] memory a) = _positionOf(_adapterAt(i));
            _accumulate(tokens_, amounts, t, a);
        }
    }

    /**
     * @notice Preview a deposit: shares minted and the exact amount pulled per offered token.
     * @dev Pure math per the {deposit} rules; reverts exactly as {deposit} would on bad input — including
     *      `PoolmigoVault__SupplyCapExceeded`, and `PoolmigoVault__GenesisNotOwner` at genesis (supply 0)
     *      unless called from the owner (e.g. an `eth_call` with `from = owner`).
     * @return shares Shares that would be minted.
     * @return requiredAmounts Amount that would be pulled per token, aligned to `tokens_`.
     */
    function previewDeposit(address[] calldata tokens_, uint256[] calldata amounts_)
        external
        view
        returns (uint256 shares, uint256[] memory requiredAmounts)
    {
        (shares, requiredAmounts) = _previewDeposit(tokens_, amounts_);
    }

    /**
     * @notice Preview a redemption: an UPPER BOUND (up to fee rounding, below) on what {redeem} would deliver now.
     * @dev Mirrors {redeem}: per adapter floor(position_i * sharesWad / 1e18) of its reported holdings, with
     *      sharesWad = floor(shares * 1e18 / totalSupply), + the vault's exact idle slice. Exact for the idle
     *      slice and for adapters whose withdrawal is linear in their reported holdings (e.g. the mocks); a
     *      concentrated-liquidity adapter burns floor(L * sharesWad / 1e18) liquidity and the venue rounds
     *      the released amounts down, so its delivery can fall a few raw units short. Adapters report their fee
     *      part already net of {redeem}'s performance-fee cut (fee-at-exit); {redeem} floors the cut on its own
     *      fee slice, which can leave the delivered fee part ≤1 raw unit per token above the preview's share.
     *      Reads each adapter's `position()` for display only — {redeem} itself never depends on these
     *      reports, so a non-reporting adapter cannot block redemptions.
     * @return tokens_ Registry tokens.
     * @return owedAmounts Upper bound on the amount delivered per token.
     */
    function previewRedeem(uint256 shares)
        external
        view
        returns (address[] memory tokens_, uint256[] memory owedAmounts)
    {
        tokens_ = _s().tokens;
        uint256 n = tokens_.length;
        owedAmounts = new uint256[](n);
        uint256 supply = totalSupply();
        if (supply == 0 || shares == 0) {
            return (tokens_, owedAmounts);
        }
        uint256 sharesWad = shares.mulDiv(WAD, supply, Math.Rounding.Floor);
        uint256[] memory slices = _adapterSlices(tokens_, sharesWad);
        for (uint256 i; i < n; ++i) {
            owedAmounts[i] = slices[i] + shares.mulDiv(_idle(tokens_[i]), supply, Math.Rounding.Floor);
        }
    }

    /*//////////////////////////////////////////////////////////////
                       INTERNAL STATE-CHANGING FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice UUPS upgrade authorization — owner only (multisig behind timelock on mainnet).
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    /// @dev Unregister `adapter` (swap-and-pop; the registry order of the others may change). Never calls it.
    function _dropAdapter(PoolmigoVaultStorage storage $, IPositionAdapter adapter) private {
        $.isAdapter[address(adapter)] = false;
        delete $.capabilities[address(adapter)];

        IPositionAdapter[] storage arr = $.adapters;
        uint256 len = arr.length;
        for (uint256 i; i < len; ++i) {
            if (address(arr[i]) == address(adapter)) {
                arr[i] = arr[len - 1];
                arr.pop();
                break;
            }
        }
    }

    /// @dev Shared role write ({setKeeper} / {setRiskManager}): non-zero account.
    function _setFlag(mapping(address => bool) storage flags, address account, bool allowed) private {
        if (account == address(0)) {
            revert PoolmigoVault__ZeroAddress();
        }
        flags[account] = allowed;
    }

    /// @dev The full-freeze gate (deposit / redeem / every keeper op).
    function _requireNotPaused() private view {
        if (_s().paused) {
            revert PoolmigoVault__Paused();
        }
    }

    /// @dev Shared pause write ({setPaused} / {pause} / {emergencyUnwind}).
    function _setPausedFlag(bool paused_) private {
        _s().paused = paused_;
        emit PausedSet(paused_);
    }

    /// @dev {onlyKeeper}'s check, out of line (one copy instead of one per keeper function).
    function _checkKeeper() private view {
        if (!_s().isKeeper[msg.sender]) {
            revert PoolmigoVault__NotKeeper();
        }
    }

    /// @dev {onlyOwnerOrRiskManager}'s check, out of line.
    function _checkOwnerOrRiskManager() private view {
        if (msg.sender != owner() && !_s().isRiskManager[msg.sender]) {
            revert PoolmigoVault__NotRiskManager();
        }
    }

    /// @dev Keeper-op gate (deployTo / pullFrom / precise liquidity): registered adapter first, then not paused.
    function _requireOpenAdapter(IPositionAdapter adapter) private view {
        _requireRegistered(adapter);
        _requireNotPaused();
    }

    function _requireRegistered(IPositionAdapter adapter) private view {
        if (!_s().isAdapter[address(adapter)]) {
            revert PoolmigoVault__AdapterNotRegistered(address(adapter));
        }
    }

    /// @dev {_requireOpenAdapter} + the op family's capability bit is enabled.
    function _requireCapability(IPositionAdapter adapter, uint8 capBit) private view {
        _requireOpenAdapter(adapter);
        if (_s().capabilities[address(adapter)] & capBit == 0) {
            revert PoolmigoVault__CapabilityMissing(address(adapter), capBit);
        }
    }

    /// @dev The capability mask the adapter itself supports: its own ERC-165 answers for {ILiquidityAdapter}
    ///      (CAP_LIQUIDITY) and {ISwapAdapter} (CAP_SWAP), via OZ `ERC165Checker`'s unchecked variant (a plain
    ///      `supportsInterface(id)` staticcall) — a non-ERC-165 adapter (no such function / short return data) reads
    ///      as 0 instead of reverting.
    function _supportedCapabilities(IPositionAdapter adapter) private view returns (uint8 caps) {
        if (ERC165Checker.supportsERC165InterfaceUnchecked(address(adapter), type(ILiquidityAdapter).interfaceId)) {
            caps = CAP_LIQUIDITY;
        }
        if (ERC165Checker.supportsERC165InterfaceUnchecked(address(adapter), type(ISwapAdapter).interfaceId)) {
            caps |= CAP_SWAP;
        }
    }

    /// @dev Funding check (deployTo / addLiquidity): `token` is in the basket and `amount` fits the vault's idle.
    function _requireFundable(IPositionAdapter adapter, address token, uint256 amount) private view {
        if (!_s().isToken[token]) {
            revert PoolmigoVault__AdapterTokenNotRegistered(address(adapter), token);
        }
        uint256 idle = _idle(token);
        if (amount > idle) {
            revert PoolmigoVault__InsufficientIdle(token, idle, amount);
        }
    }

    /// @dev Funding gate + exact approvals ({deployTo} / {addLiquidity}): every amount passes {_requireFundable} first,
    ///      then each token is force-approved to `adapter` for exactly its amount. `t` / `amounts` are aligned.
    function _approveFunded(IPositionAdapter adapter, address[] memory t, uint256[] memory amounts) private {
        uint256 n = t.length;
        for (uint256 i; i < n; ++i) {
            _requireFundable(adapter, t[i], amounts[i]);
        }
        _approveAll(adapter, t, amounts);
    }

    /// @dev Force-approve `amounts[i]` of `t[i]` to `adapter` (all-zero `amounts` = revoke every approval).
    function _approveAll(IPositionAdapter adapter, address[] memory t, uint256[] memory amounts) private {
        uint256 n = t.length;
        for (uint256 i; i < n; ++i) {
            IERC20(t[i]).forceApprove(address(adapter), amounts[i]);
        }
    }

    /// @dev Shared gate of the precise-liquidity wrappers: registered adapter, not paused (same order as {deployTo}),
    ///      CAP_LIQUIDITY enabled, exactly two tokens (`[token0, token1]`, the order of the params' amounts).
    function _liquidityTokens(IPositionAdapter adapter) private view returns (address[] memory t) {
        _requireCapability(adapter, CAP_LIQUIDITY);
        (t,) = _positionOf(adapter);
        if (t.length != 2) {
            revert PoolmigoVault__LengthMismatch();
        }
    }

    /// @dev `adapter.withdrawProportional(sharesWad, vault)` — one call site ({redeem} + {pullFrom}); the slice always
    ///      lands in the vault (the fee skim needs it here first). Returns (tokens, amounts, fees).
    function _withdrawFrom(IPositionAdapter adapter, uint256 sharesWad)
        private
        returns (address[] memory, uint256[] memory, uint256[] memory)
    {
        return adapter.withdrawProportional(sharesWad, address(this));
    }

    /// @dev Every registered adapter sends value out of its position into the vault — its `sharesWad` slice ({redeem};
    ///      none when sharesWad == 0), or with a sentinel: `UNWIND_ALL` = everything via `unwindAll` ({emergencyUnwind}),
    ///      `HARVEST_ALL` = its fees via `harvest` ({rebalance}). Returns the registry-aligned gross amounts delivered
    ///      and the accrued fees the adapters report inside them.
    function _exitAll(address[] memory tokens_, uint256 sharesWad)
        private
        returns (uint256[] memory amounts, uint256[] memory fees)
    {
        uint256 n = tokens_.length;
        amounts = new uint256[](n);
        fees = new uint256[](n);
        uint256 len = sharesWad == 0 ? 0 : _s().adapters.length;
        for (uint256 i; i < len; ++i) {
            IPositionAdapter adapter = _adapterAt(i);
            address[] memory t;
            uint256[] memory a;
            uint256[] memory f;
            if (sharesWad == UNWIND_ALL) {
                (t, a, f) = adapter.unwindAll(address(this));
            } else if (sharesWad == HARVEST_ALL) {
                (t, a) = adapter.harvest();
                f = a; // harvested amounts ARE fees
            } else {
                (t, a, f) = _withdrawFrom(adapter, sharesWad);
            }
            _accumulate(tokens_, amounts, t, a);
            _accumulate(tokens_, fees, t, f);
        }
    }

    /// @dev The performance-fee skim — the ONE fee policy for every path accrued fees leave a position ({rebalance},
    ///      {redeem}, {pullFrom}, {removeLiquidity}, {emergencyUnwind}): cut_i = floor(fees_i * performanceFeeBps /
    ///      10_000), sent in kind to `treasury` (zero cuts skipped); one `PerformanceFeeAccrued` if any cut != 0.
    ///      `amounts_` are fee amounts already held by the vault, aligned to `tokens_`.
    function _skimPerformanceFee(address[] memory tokens_, uint256[] memory amounts_)
        private
        returns (uint256[] memory cut)
    {
        uint256 n = tokens_.length;
        if (amounts_.length != n) {
            revert PoolmigoVault__LengthMismatch();
        }
        PoolmigoVaultStorage storage $ = _s();
        uint16 feeBps = $.performanceFeeBps;
        address treasury_ = $.treasury;
        cut = new uint256[](n);
        bool anyFee;
        for (uint256 i; i < n; ++i) {
            uint256 fee = amounts_[i].mulDiv(feeBps, BPS_DENOMINATOR, Math.Rounding.Floor);
            if (fee != 0) {
                cut[i] = fee;
                anyFee = true;
                IERC20(tokens_[i]).safeTransfer(treasury_, fee);
            }
        }
        if (anyFee) {
            emit PerformanceFeeAccrued(treasury_, tokens_, cut);
        }
    }

    /// @dev The vault's own balance of `token` (its idle) — one call site.
    function _idle(address token) private view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }

    /// @dev Registered position by index (bounds-checked) — one copy of the storage read for every loop.
    function _adapterAt(uint256 index) private view returns (IPositionAdapter) {
        return _s().adapters[index];
    }

    /// @dev `adapter.position()` — one call site for every report read (EIP-170 budget).
    function _positionOf(IPositionAdapter adapter) private view returns (address[] memory, uint256[] memory) {
        return adapter.position();
    }

    /// @dev Shared registry insert for `initialize` and `addToken`.
    function _addToken(PoolmigoVaultStorage storage $, address token) private {
        if (token == address(0)) {
            revert PoolmigoVault__ZeroAddress();
        }
        if ($.isToken[token]) {
            revert PoolmigoVault__TokenAlreadyRegistered(token);
        }
        if ($.tokens.length >= MAX_TOKENS) {
            revert PoolmigoVault__MaxTokensReached(MAX_TOKENS);
        }
        $.isToken[token] = true;
        $.tokens.push(token);
        emit TokenAdded(token);
    }

    /*//////////////////////////////////////////////////////////////
                       INTERNAL READ-ONLY FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @dev Deposit math + input validation. See {deposit} for the rules.
    function _previewDeposit(address[] calldata tokens_, uint256[] calldata amounts_)
        internal
        view
        returns (uint256 shares, uint256[] memory required)
    {
        uint256 n = tokens_.length;
        if (n == 0 || n != amounts_.length) {
            revert PoolmigoVault__LengthMismatch();
        }

        (address[] memory registry, uint256[] memory totals) = totalTokens();
        uint256 m = registry.length;

        // Map registry index -> offered index (NOT_FOUND if not offered); rejects unknowns + duplicates.
        (uint256[] memory offeredAt, uint256[] memory registryIdx) = _mapOffered(registry, tokens_, n, m);

        uint256 supply = totalSupply();
        required = new uint256[](n);

        if (supply == 0) {
            // Genesis: owner only, strict full basket, every amount > 0, pulled in full; shares = K.
            // No virtuals here — K is the deliberate scale.
            if (msg.sender != owner()) {
                revert PoolmigoVault__GenesisNotOwner();
            }
            for (uint256 r; r < m; ++r) {
                if (offeredAt[r] == NOT_FOUND) {
                    revert PoolmigoVault__MissingBasketToken(registry[r]);
                }
            }
            for (uint256 i; i < n; ++i) {
                if (amounts_[i] == 0) {
                    revert PoolmigoVault__ZeroAmount();
                }
                required[i] = amounts_[i];
            }
            shares = _s().genesisShares;
        } else {
            // Normal: the binding (min-ratio) participating token sets the share count; every held
            // token (T_i > 0) must be offered non-zero — strict participation (see _bindingShares).
            shares = _bindingShares(registry, totals, offeredAt, amounts_, supply);
            if (shares == 0) {
                revert PoolmigoVault__ZeroShares();
            }
            // required_i = ceil(shares * (T_i + VA) / (S + VS)) <= amounts_[i] by construction;
            // tokens with T_i == 0 pull 0 (a zero offer for a held token reverts in _bindingShares).
            _fillRequired(required, registryIdx, totals, amounts_, shares, supply);
        }

        // Supply cap (PRD F1.2) — shared by {deposit} and {previewDeposit}, genesis included.
        uint256 cap = _s().maxTotalSupply;
        if (cap != 0 && supply + shares > cap) {
            revert PoolmigoVault__SupplyCapExceeded(supply + shares, cap);
        }
    }

    /// @dev Builds (registry index -> offered index) and (offered index -> registry index) maps.
    ///      Reverts on unknown or duplicate offered tokens.
    function _mapOffered(address[] memory registry, address[] calldata tokens_, uint256 n, uint256 m)
        private
        pure
        returns (uint256[] memory offeredAt, uint256[] memory registryIdx)
    {
        offeredAt = new uint256[](m);
        for (uint256 r; r < m; ++r) {
            offeredAt[r] = NOT_FOUND;
        }
        registryIdx = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            uint256 r = _indexOf(registry, tokens_[i]);
            if (r == NOT_FOUND) {
                revert PoolmigoVault__TokenNotRegistered(tokens_[i]);
            }
            if (offeredAt[r] != NOT_FOUND) {
                revert PoolmigoVault__DuplicateToken(tokens_[i]);
            }
            offeredAt[r] = i;
            registryIdx[i] = r;
        }
    }

    /// @dev Min-ratio share count over the PARTICIPATING tokens (T_i > 0, offered with amount_i > 0):
    ///      min_i floor(amount_i * (S + VS) / (T_i + VA)). STRICT PARTICIPATION (fix round): every held
    ///      token (T_i > 0) must be offered non-zero — an omitted or zero-offered held token reverts
    ///      (`MissingBasketToken` / `PoolmigoVault__ZeroAmount`, registry-order; if nothing participates,
    ///      the first omitted held token reverts, as before). The former dust exemption — optional iff
    ///      floor(shares * T_i / S) == 0 — is removed: it let k merged deposits whose sub-wei "zero" draws
    ///      each round down compose into >= 1 wei payable at the merged redeem (K-14 reread; issue #2).
    ///      T_i == 0 is optional by construction (nothing pulled, nothing claimable). Accepted cost:
    ///      a registered token held as dust must be offered (and held) by every depositor — fine for
    ///      owner-curated baskets; see 05-known-issues K-14. The second loop only runs when a held token
    ///      was omitted (normal path unchanged).
    function _bindingShares(
        address[] memory registry,
        uint256[] memory totals,
        uint256[] memory offeredAt,
        uint256[] calldata amounts_,
        uint256 supply
    ) private pure returns (uint256 shares) {
        bool bound;
        bool omitted;
        uint256 m = registry.length;
        for (uint256 r; r < m; ++r) {
            if (totals[r] == 0) {
                continue;
            }
            uint256 i = offeredAt[r];
            if (i == NOT_FOUND || amounts_[i] == 0) {
                omitted = true;
                continue;
            }
            uint256 candidate =
                amounts_[i].mulDiv(supply + VIRTUAL_SHARES, totals[r] + VIRTUAL_ASSETS, Math.Rounding.Floor);
            if (!bound || candidate < shares) {
                shares = candidate;
                bound = true;
            }
        }
        if (omitted) {
            for (uint256 r; r < m; ++r) {
                uint256 total = totals[r];
                if (total == 0) {
                    continue;
                }
                uint256 i = offeredAt[r];
                if (i != NOT_FOUND && amounts_[i] != 0) {
                    continue;
                }
                // Strict participation: a held token (T > 0) may not be omitted or offered 0 —
                // the former dust exemption is removed (K-14 reread: merged sub-wei roundings
                // composed into >= 1 wei at redeem, issue #2). Same errors, registry order:
                if (i == NOT_FOUND) {
                    revert PoolmigoVault__MissingBasketToken(registry[r]);
                }
                revert PoolmigoVault__ZeroAmount();
            }
        }
    }

    /// @dev required_i = ceil(shares * (T_i + VA) / (S + VS)) for participating tokens; tokens with T_i == 0 pull 0
    ///      (a zero offer for a held token is inadmissible — strict participation, see {_bindingShares}).
    function _fillRequired(
        uint256[] memory required,
        uint256[] memory registryIdx,
        uint256[] memory totals,
        uint256[] calldata amounts_,
        uint256 shares,
        uint256 supply
    ) private pure {
        uint256 n = required.length;
        for (uint256 i; i < n; ++i) {
            uint256 total = totals[registryIdx[i]];
            if (total != 0 && amounts_[i] != 0) {
                required[i] = shares.mulDiv(total + VIRTUAL_ASSETS, supply + VIRTUAL_SHARES, Math.Rounding.Ceil);
            }
        }
    }

    /// @dev Per-token sum of floor(holding * sharesWad / 1e18) across adapters (registry-aligned).
    ///      Mirrors the fraction each adapter is asked for in {IPositionAdapter-withdrawProportional}.
    function _adapterSlices(address[] memory registry, uint256 sharesWad)
        private
        view
        returns (uint256[] memory slices)
    {
        uint256 n = registry.length;
        slices = new uint256[](n);
        if (sharesWad == 0) {
            return slices;
        }
        PoolmigoVaultStorage storage $ = _s();
        uint256 len = $.adapters.length;
        for (uint256 i; i < len; ++i) {
            (address[] memory t, uint256[] memory a) = _positionOf(_adapterAt(i));
            uint256 m = t.length;
            for (uint256 j; j < m; ++j) {
                uint256 idx = _indexOf(registry, t[j]);
                if (idx != NOT_FOUND) {
                    slices[idx] += a[j].mulDiv(sharesWad, WAD, Math.Rounding.Floor);
                }
            }
        }
    }

    /// @dev Add an adapter-reported (tokens, amounts) vector into registry-aligned `totals`.
    ///      Unregistered tokens are skipped (see {totalTokens}).
    function _accumulate(address[] memory registry, uint256[] memory totals, address[] memory t, uint256[] memory a)
        private
        pure
    {
        uint256 n = t.length;
        if (a.length != n) {
            revert PoolmigoVault__LengthMismatch();
        }
        for (uint256 i; i < n; ++i) {
            if (a[i] == 0) {
                continue;
            }
            uint256 idx = _indexOf(registry, t[i]);
            if (idx != NOT_FOUND) {
                totals[idx] += a[i];
            }
        }
    }

    /// @dev True if `s` is empty or consists only of ASCII whitespace (space, \t, \n, \v, \f, \r).
    ///      Byte-wise: Unicode whitespace (e.g. U+00A0, U+3000) is NOT treated as blank.
    function _isBlank(string memory s) private pure returns (bool) {
        bytes memory b = bytes(s);
        uint256 n = b.length;
        for (uint256 i; i < n; ++i) {
            bytes1 c = b[i];
            if (c != 0x20 && (c < 0x09 || c > 0x0d)) {
                return false;
            }
        }
        return true;
    }

    /// @dev Linear scan (registry is <= MAX_TOKENS entries).
    function _indexOf(address[] memory registry, address token) private pure returns (uint256 idx) {
        uint256 n = registry.length;
        for (uint256 i; i < n; ++i) {
            if (registry[i] == token) {
                return i;
            }
        }
        return NOT_FOUND;
    }

    /// @dev Exact-delivery pull (K-31): snapshots the vault's balance around the transfer and rejects any
    ///      short (fee-on-transfer) or excess (rebase-up) delivery — share math prices nominal amounts, so
    ///      the vault must receive exactly `amount`. Deposits admit exact-delivery ERC-20s only.
    function _pullExact(address token, uint256 amount) private {
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - before;
        if (received != amount) revert PoolmigoVault__InexactDelivery(token, amount, received);
    }
}
