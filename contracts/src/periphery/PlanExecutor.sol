// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {IPoolmigoVault} from "contracts/interfaces/IPoolmigoVault.sol";
import {IPositionAdapter} from "contracts/interfaces/IPositionAdapter.sol";
import {ILiquidityAdapter} from "contracts/interfaces/ILiquidityAdapter.sol";
import {ISwapAdapter} from "contracts/interfaces/ISwapAdapter.sol";

/**
 * @title PlanExecutor
 * @author MySun
 * @notice Strategy layer P3 periphery (`notes/EXECUTION-PLANS.md`): runs a keeper-composed PLAN — an ordered list of
 *         typed vault keeper calls — in ONE transaction, all-or-nothing. The vault stays the only place funds move:
 *         every component is a plain call to the vault's own keeper surface ({IPoolmigoVault-rebalance},
 *         `swapExactIn`, `addLiquidity`, `removeLiquidity`, `pullFrom(adapter, 10_000)`), so every vault gate (paused
 *         = full freeze, registration, capability bits, idle checks, destinations hard-wired to the vault) and every
 *         adapter guard (range constraints, TWAP / spot guards, floors) applies per call. This contract holds nothing,
 *         approves nothing and has no receive/fallback.
 *
 *         Staleness protection, checked UPFRONT against the state at plan start, before any component runs:
 *         - `expectedTotalSupply` == the vault's live `totalSupply()` (no deposit / redeem since the plan was sized);
 *         - every pin == the adapter's live {ILiquidityAdapter-positionState} (token id, bounds, liquidity and the
 *           owner-config version — exact equality, no tolerance), and every component that names an adapter is
 *           covered by a pin (Harvest is adapter-less);
 *         - `deadline` not passed; `nonce` == the caller's next nonce (per keeper, strictly sequential; consumed only
 *           when every component succeeded — any revert rolls the whole plan back, counter included).
 *         Payloads decode into the TYPED vault parameter structs, with exact-length checks — never raw call data.
 *
 *         Wiring: this contract must be a vault keeper (`vault.setKeeper(planExecutor, true)`, owner action) — the
 *         vault sees IT as `msg.sender` (vault keeper events carry the executor's address). Who may call
 *         {executePlan} is governed here, by this contract's own owner ({setKeeper}).
 * @dev Not audited. Owner must be a multisig.
 * @custom:security-contact security@mysun.example
 */
contract PlanExecutor is Ownable2Step, ReentrancyGuardTransient {
    /*//////////////////////////////////////////////////////////////
                                 TYPES
    //////////////////////////////////////////////////////////////*/

    /// @notice Expected {ILiquidityAdapter-positionState} of `adapter` at plan start.
    struct Pin {
        address adapter;
        uint256 tokenId;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint32 configVersion;
    }

    /// @notice One vault keeper call: `kind` selects it, `payload` is the ABI-encoded typed parameter struct.
    struct Component {
        uint8 kind;
        address adapter; // ignored for KIND_HARVEST
        bytes payload;
    }

    struct Plan {
        uint256 nonce;
        uint64 deadline; // unix seconds, inclusive
        uint256 expectedTotalSupply;
        Pin[] pins;
        Component[] components;
    }

    /*//////////////////////////////////////////////////////////////
                               CONSTANTS
    //////////////////////////////////////////////////////////////*/

    /// @notice `vault.rebalance()` — payload empty, adapter ignored.
    uint8 public constant KIND_HARVEST = 0;
    /// @notice `vault.swapExactIn(adapter, abi.decode(payload, (ISwapAdapter.SwapParams)))`.
    uint8 public constant KIND_SWAP = 1;
    /// @notice `vault.addLiquidity(adapter, abi.decode(payload, (ILiquidityAdapter.AddLiquidityParams)))`.
    uint8 public constant KIND_ADD_LIQUIDITY = 2;
    /// @notice `vault.removeLiquidity(adapter, abi.decode(payload, (ILiquidityAdapter.RemoveLiquidityParams)))`.
    uint8 public constant KIND_REMOVE_LIQUIDITY = 3;
    /// @notice `vault.pullFrom(adapter, 10_000)` (burns the position — the re-range path) — payload empty.
    uint8 public constant KIND_CLOSE_POSITION = 4;

    /// @dev Exact ABI sizes of the static payload structs (one 32-byte word per field).
    uint256 private constant SWAP_PAYLOAD_SIZE = 4 * 32;
    uint256 private constant ADD_PAYLOAD_SIZE = 7 * 32;
    uint256 private constant REMOVE_PAYLOAD_SIZE = 3 * 32;
    uint256 private constant FULL_BPS = 10_000;

    /*//////////////////////////////////////////////////////////////
                           IMMUTABLES / STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @notice The vault every component calls (this contract must be one of its keepers).
    IPoolmigoVault public immutable VAULT;

    /// @notice Who may call {executePlan} (this contract's own keeper set — independent of the vault's).
    mapping(address keeper => bool allowed) public isKeeper;
    /// @notice Next plan nonce per keeper (strictly sequential).
    mapping(address keeper => uint256 nonce) public nonces;

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    event KeeperSet(address indexed keeper, bool allowed);
    /// @notice `planId = keccak256(abi.encode(plan))`; `nonce` = the nonce the plan consumed.
    event PlanExecuted(bytes32 indexed planId, address indexed keeper, uint256 nonce);

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error PlanExecutor__ZeroAddress();
    error PlanExecutor__NotKeeper(address caller);
    error PlanExecutor__Expired(uint64 deadline, uint256 timestamp);
    error PlanExecutor__InvalidNonce(uint256 expected, uint256 provided);
    error PlanExecutor__SupplyMismatch(uint256 expected, uint256 actual);
    /// @dev Pin `index` differs from its adapter's live `positionState()` in at least one field.
    error PlanExecutor__PinMismatch(uint256 index, address adapter);
    /// @dev Component `index` names an adapter no pin covers.
    error PlanExecutor__UnpinnedAdapter(uint256 index, address adapter);
    error PlanExecutor__UnsupportedComponent(uint256 index, uint8 kind);
    /// @dev Component `index`'s payload length is not the exact ABI size of its kind's struct (0 for Harvest / Close).
    error PlanExecutor__InvalidPayload(uint256 index, uint256 length);

    /*//////////////////////////////////////////////////////////////
                               CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    constructor(IPoolmigoVault vault_, address owner_) Ownable(owner_) {
        if (address(vault_) == address(0)) {
            revert PlanExecutor__ZeroAddress();
        }
        VAULT = vault_;
    }

    /*//////////////////////////////////////////////////////////////
                                 KEEPER
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Run `plan`: the upfront checks (caller, deadline, nonce, supply pin, adapter pins, component kinds /
     *         payload sizes / pin coverage), then every component IN ARRAY ORDER, then consume the nonce.
     * @dev Any failing check or component reverts the whole plan (vault and adapter errors bubble unchanged).
     */
    function executePlan(Plan calldata plan) external nonReentrant {
        if (!isKeeper[msg.sender]) {
            revert PlanExecutor__NotKeeper(msg.sender);
        }
        if (block.timestamp > plan.deadline) {
            revert PlanExecutor__Expired(plan.deadline, block.timestamp);
        }
        uint256 nonce = nonces[msg.sender];
        if (plan.nonce != nonce) {
            revert PlanExecutor__InvalidNonce(nonce, plan.nonce);
        }
        uint256 supply = IERC20(address(VAULT)).totalSupply();
        if (supply != plan.expectedTotalSupply) {
            revert PlanExecutor__SupplyMismatch(plan.expectedTotalSupply, supply);
        }

        Pin[] calldata pins = plan.pins;
        uint256 nPins = pins.length;
        for (uint256 i; i < nPins; ++i) {
            _checkPin(i, pins[i]);
        }

        Component[] calldata components = plan.components;
        uint256 n = components.length;
        for (uint256 i; i < n; ++i) {
            Component calldata c = components[i];
            uint256 size = _payloadSize(i, c.kind);
            if (c.payload.length != size) {
                revert PlanExecutor__InvalidPayload(i, c.payload.length);
            }
            if (c.kind != KIND_HARVEST && !_pinned(pins, c.adapter)) {
                revert PlanExecutor__UnpinnedAdapter(i, c.adapter);
            }
        }

        for (uint256 i; i < n; ++i) {
            _execute(components[i]);
        }

        nonces[msg.sender] = nonce + 1;
        emit PlanExecuted(keccak256(abi.encode(plan)), msg.sender, nonce);
    }

    /*//////////////////////////////////////////////////////////////
                                 OWNER
    //////////////////////////////////////////////////////////////*/

    /// @notice Add/remove a keeper allowed to call {executePlan}.
    function setKeeper(address keeper, bool allowed) external onlyOwner {
        if (keeper == address(0)) {
            revert PlanExecutor__ZeroAddress();
        }
        isKeeper[keeper] = allowed;
        emit KeeperSet(keeper, allowed);
    }

    /*//////////////////////////////////////////////////////////////
                                INTERNAL
    //////////////////////////////////////////////////////////////*/

    /// @dev One component → one typed vault keeper call (kind and payload size were validated upfront).
    function _execute(Component calldata c) private {
        IPositionAdapter adapter = IPositionAdapter(c.adapter);
        uint8 kind = c.kind;
        if (kind == KIND_HARVEST) {
            VAULT.rebalance();
        } else if (kind == KIND_SWAP) {
            VAULT.swapExactIn(adapter, abi.decode(c.payload, (ISwapAdapter.SwapParams)));
        } else if (kind == KIND_ADD_LIQUIDITY) {
            VAULT.addLiquidity(adapter, abi.decode(c.payload, (ILiquidityAdapter.AddLiquidityParams)));
        } else if (kind == KIND_REMOVE_LIQUIDITY) {
            VAULT.removeLiquidity(adapter, abi.decode(c.payload, (ILiquidityAdapter.RemoveLiquidityParams)));
        } else {
            VAULT.pullFrom(adapter, FULL_BPS); // KIND_CLOSE_POSITION
        }
    }

    /// @dev Pin `index` must equal the adapter's live `positionState()` field for field.
    function _checkPin(uint256 index, Pin calldata pin) private view {
        (uint256 id, int24 lower, int24 upper, uint128 liquidity, uint32 version) =
            ILiquidityAdapter(pin.adapter).positionState();
        if (
            id != pin.tokenId || lower != pin.tickLower || upper != pin.tickUpper || liquidity != pin.liquidity
                || version != pin.configVersion
        ) {
            revert PlanExecutor__PinMismatch(index, pin.adapter);
        }
    }

    /// @dev Whether some pin covers `adapter`.
    function _pinned(Pin[] calldata pins, address adapter) private pure returns (bool) {
        uint256 n = pins.length;
        for (uint256 i; i < n; ++i) {
            if (pins[i].adapter == adapter) {
                return true;
            }
        }
        return false;
    }

    /// @dev Exact payload length of `kind` (reverts on an unknown kind).
    function _payloadSize(uint256 index, uint8 kind) private pure returns (uint256) {
        if (kind == KIND_HARVEST || kind == KIND_CLOSE_POSITION) {
            return 0;
        }
        if (kind == KIND_SWAP) {
            return SWAP_PAYLOAD_SIZE;
        }
        if (kind == KIND_ADD_LIQUIDITY) {
            return ADD_PAYLOAD_SIZE;
        }
        if (kind == KIND_REMOVE_LIQUIDITY) {
            return REMOVE_PAYLOAD_SIZE;
        }
        revert PlanExecutor__UnsupportedComponent(index, kind);
    }
}
