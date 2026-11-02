// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import {Script, console2} from "forge-std/Script.sol";
import {Upgrades, Options} from "openzeppelin-foundry-upgrades/Upgrades.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {MySunVaultUpgradeable} from "contracts/MySunVaultUpgradeable.sol";
import {DepositSplit} from "contracts/periphery/DepositSplit.sol";
import {IPositionAdapter} from "contracts/interfaces/IPositionAdapter.sol";
import {UniswapV4Adapter} from "contracts/adapters/UniswapV4Adapter.sol"; // the shared SwapVenue enum / views
import {UniswapV4HookedAdapter} from "contracts/adapters/UniswapV4HookedAdapter.sol";
import {UniswapV4NativeEthAdapter} from "contracts/adapters/UniswapV4NativeEthAdapter.sol";
import {INativeWrapperMinimal} from "contracts/adapters/uniswap/IWETH9Minimal.sol";
import {IUniswapV3PoolMinimal} from "contracts/adapters/uniswap/IUniswapV3PoolMinimal.sol";
import {INonfungiblePositionManager} from "contracts/adapters/uniswap/INonfungiblePositionManager.sol";
import {LiquidityAmounts} from "contracts/adapters/uniswap/LiquidityAmounts.sol";
import {TickMath} from "contracts/adapters/uniswap/TickMath.sol";
import {PoolKey, IPoolManagerMinimal, IUnlockCallback} from "contracts/adapters/uniswap/v4/IPoolManagerMinimal.sol";
import {IPositionManagerMinimal} from "contracts/adapters/uniswap/v4/IPositionManagerMinimal.sol";
import {V4StateReader} from "contracts/adapters/uniswap/v4/V4StateReader.sol";
import {UniversalRouterSwapExecutor} from "contracts/swap/UniversalRouterSwapExecutor.sol";
import {UniversalRouterNativeSwapExecutor} from "contracts/swap/UniversalRouterNativeSwapExecutor.sol";
import {VaultColdLink} from "./VaultColdLink.sol";

/// @dev The PoolManager surface the provisioner needs beyond the adapters' minimal ABI (v4-core public ABI).
interface IPoolManagerProvision is IPoolManagerMinimal {
    struct ModifyLiquidityParams {
        int24 tickLower;
        int24 tickUpper;
        int256 liquidityDelta;
        bytes32 salt;
    }

    /// @dev selector 0x6276cbbe — permissionless; a hooked key runs the hook's `beforeInitialize` (Fables: the pool
    ///      must be configured in the hook first — tri-pool-up.sh copies that config on a frozen chain).
    function initialize(PoolKey memory key, uint160 sqrtPriceX96) external returns (int24 tick);

    /// @dev selector 0x5a6bcfda. Returns packed `BalanceDelta`s (amount0 high 128 bits, amount1 low).
    function modifyLiquidity(PoolKey memory key, ModifyLiquidityParams memory params, bytes calldata hookData)
        external
        returns (int256 callerDelta, int256 feesAccrued);
}

/// @dev v3 factory / pool calls the provisioner needs beyond the adapters' minimal ABI (v3-core public ABI).
interface IUniswapV3FactoryProvision {
    function feeAmountTickSpacing(uint24 fee) external view returns (int24);
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address);
    function createPool(address tokenA, address tokenB, uint24 fee) external returns (address pool);
}

interface IUniswapV3PoolInit {
    function initialize(uint160 sqrtPriceX96) external;
}

/**
 * @notice Demo-side v4 liquidity seed for the local chain ONLY (owned by nobody, holds nothing at rest): adds a plain
 *         position to a pool that a frozen state recreated EMPTY (the position stays with this contract — demo depth,
 *         never part of any vault). The `V4Trader` pattern of test/fork/UniswapV4Adapter.fork.t.sol (unlock → modify →
 *         settle what is owed); a native currency0 (address 0) is paid from `msg.value`, an ERC-20 from the caller's
 *         allowance; whatever is unspent goes back to the caller.
 */
contract DemoV4PoolTool is IUnlockCallback {
    using SafeERC20 for IERC20;

    IPoolManagerProvision internal immutable MANAGER;

    constructor(address manager) {
        MANAGER = IPoolManagerProvision(manager);
    }

    /// @notice Add `liquidity` on [lower, upper], paid from at most `max0` / `max1` (native: `msg.value` == `max0`).
    function seed(PoolKey memory key, int24 lower, int24 upper, uint128 liquidity, uint256 max0, uint256 max1)
        external
        payable
    {
        if (key.currency0 == address(0)) {
            require(msg.value == max0, "native max0 != msg.value");
        } else {
            IERC20(key.currency0).safeTransferFrom(msg.sender, address(this), max0);
        }
        IERC20(key.currency1).safeTransferFrom(msg.sender, address(this), max1);
        MANAGER.unlock(abi.encode(key, lower, upper, liquidity));
        _refund(key.currency0);
        _refund(key.currency1);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(MANAGER), "only manager");
        (PoolKey memory k, int24 lower, int24 upper, uint128 liquidity) =
            abi.decode(data, (PoolKey, int24, int24, uint128));
        (int256 callerDelta,) = MANAGER.modifyLiquidity(
            k,
            IPoolManagerProvision.ModifyLiquidityParams({
                tickLower: lower, tickUpper: upper, liquidityDelta: int256(uint256(liquidity)), salt: bytes32(0)
            }),
            ""
        );
        _settle(k.currency0, uint256(uint128(-int128(callerDelta >> 128))));
        _settle(k.currency1, uint256(uint128(-int128(callerDelta))));
        return "";
    }

    function _settle(address currency, uint256 amount) internal {
        if (amount == 0) return;
        if (currency == address(0)) {
            MANAGER.settle{value: amount}();
        } else {
            MANAGER.sync(currency);
            IERC20(currency).safeTransfer(address(MANAGER), amount);
            MANAGER.settle();
        }
    }

    function _refund(address currency) internal {
        if (currency == address(0)) {
            if (address(this).balance != 0) {
                (bool ok,) = msg.sender.call{value: address(this).balance}("");
                require(ok, "ETH refund failed");
            }
            return;
        }
        uint256 left = IERC20(currency).balanceOf(address(this));
        if (left != 0) {
            IERC20(currency).safeTransfer(msg.sender, left);
        }
    }
}

/// @dev Shared constants + helpers of the two `sunTriLP` scripts below (verified RHC addresses — notes/RHC_ADDRESSES.md
///      and the 3-pool research probe, notes/3POOL-VAULT-RESEARCH.md; never invent one).
abstract contract TriPoolBase is Script {
    /* ================ Anvil dev accounts (public, well-known — LOCAL ONLY) ================ */
    string internal constant TEST_MNEMONIC = "test test test test test test test test test test test junk";
    address internal constant OWNER = 0x9B63F0Cef479924E5d2C4E22DBE31E6d0353B448; // #201 — the demo stack's owner
    address internal constant TRI_DEPLOYER = 0xaAda98978453263132587D0805C4A17376Af9F13; // #202 — CREATEs only
    address internal constant KEEPER = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8; // #1
    address internal constant DEMO_USER = 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC; // #2
    uint256 internal constant ANVIL_KEY_1 = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d; // #1 — LOCAL ONLY
    uint256 internal constant EXPECTED_CHAIN_ID = 46630; // the local demo chain — never RHC mainnet (4663)

    /* ============================ RHC venues (real contracts on the fork) ============================ */
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168; // 6 dp
    address internal constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73; // 18 dp
    address internal constant PONS = 0x39dBED3a2bd333467115dE45665cC57F813C4571; // 18 dp
    address internal constant POOL_FEE100 = 0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca; // v3 USDG/WETH 0.01% (ETH ref)
    address internal constant REF_POOL_PONS = 0x7A192E71564ec66eE0763e328a3Ac274942dE4e1; // v3 PONS/USDG 1% (PONS ref)
    /// @dev v3 WETH/PONS fee-10000 — the deepest PONS/WETH v3 pool (fee-100 is EMPTY: never a reference); the TWAP
    ///      reference of the native ETH/PONS adapters (WETH stands in for ETH; same token order as the v4 key).
    address internal constant REF_POOL_WETH_PONS = 0x10CC6BD38112cAc182db90B6a71d8Bb5939526bA;
    uint24 internal constant REF_WETH_PONS_FEE = 10_000;
    int24 internal constant REF_WETH_PONS_SPACING = 200;
    address internal constant V3_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address internal constant NFPM = 0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3;
    address internal constant POSM = 0x58daec3116aae6D93017bAAea7749052E8a04fA7;
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant UNIVERSAL_ROUTER = 0x204FAca1764B154221e35c0d20aBb3c525710498; // UR 2.1.2
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant FABLES_RAMP_ETH = 0x06a889870C8f83640D6816319f72e2aA579b6080;
    address internal constant FABLES_RAMP = 0x08E52564Bad99E05a694b4809F397edcA417A080;
    /// @dev The Fables ETH/PONS market's OWN hook (Fables deploys one per market; bits 0x2080 = beforeInitialize +
    ///      beforeSwap, flat 3000 ppm) — script/ProbeFablesEthPons.s.sol, notes/3POOL-VAULT-RESEARCH.md.
    address internal constant FABLES_ETH_PONS = 0x594e8e6281eDf2d363a0293a50004Cf868E7a080;

    uint256 internal constant TRI_PER_POOL = 6; // adapters per pool of the "tri" vault (3 pools)
    bytes32 internal constant ETH_POOL_ID = 0xbac3aa3b91584a53a579b3c999a56756e954e59247e497bad1d25a4334bde551;
    bytes32 internal constant PONS_POOL_ID = 0x486435a1f76cd58193f854c6e6213cd05fd58d637865d02065ff558b387fa6ea;
    bytes32 internal constant ETH_PONS_POOL_ID = 0xb59001413cb070e28433826f927b7265a0813213ba21f454d86896cee3cce674;

    function _ethKey() internal pure returns (PoolKey memory) {
        return PoolKey({currency0: address(0), currency1: USDG, fee: 0x800000, tickSpacing: 10, hooks: FABLES_RAMP_ETH});
    }

    function _ponsKey() internal pure returns (PoolKey memory) {
        return PoolKey({currency0: PONS, currency1: USDG, fee: 0x800000, tickSpacing: 60, hooks: FABLES_RAMP});
    }

    /// @dev The Fables ETH/PONS market: NATIVE ETH as currency0, dynamic fee, its per-market hook.
    function _ethPonsKey() internal pure returns (PoolKey memory) {
        return PoolKey({currency0: address(0), currency1: PONS, fee: 0x800000, tickSpacing: 60, hooks: FABLES_ETH_PONS});
    }

    function _v3Tick(address pool) internal view returns (int24 tick) {
        (, tick,,,,,) = IUniswapV3PoolMinimal(pool).slot0();
    }

    function _v3Sqrt(address pool) internal view returns (uint160 sqrtP) {
        (sqrtP,,,,,,) = IUniswapV3PoolMinimal(pool).slot0();
    }

    /// @dev Active liquidity of a v4 pool (StateLibrary layout: `_pools[id]` slot + 3, low 128 bits).
    function _v4Liquidity(bytes32 poolId) internal view returns (uint128) {
        bytes32 state = keccak256(abi.encode(poolId, uint256(6)));
        return uint128(uint256(IPoolManagerMinimal(POOL_MANAGER).extsload(bytes32(uint256(state) + 3))));
    }

    /// @dev token1 worth `amount0` of token0 at `sqrtP` (raw units) — sizing only, never reported.
    function _quote0to1(uint256 amount0, uint160 sqrtP) internal pure returns (uint256) {
        return Math.mulDiv(Math.mulDiv(amount0, sqrtP, 1 << 96), sqrtP, 1 << 96);
    }

    /// @dev token0 worth `amount1` of token1 at `sqrtP` (raw units) — sizing only, never reported.
    function _quote1to0(uint256 amount1, uint160 sqrtP) internal pure returns (uint256) {
        return Math.mulDiv(Math.mulDiv(amount1, 1 << 96, sqrtP), 1 << 96, sqrtP);
    }

    function _floorTo(int24 tick, int24 spacing) internal pure returns (int24) {
        int24 q = tick / spacing;
        if (tick < 0 && tick % spacing != 0) q--;
        return q * spacing;
    }

    function _abs(int256 x) internal pure returns (uint256) {
        return uint256(x < 0 ? -x : x);
    }

    /// @dev The vault's whole idle back in equal slices: each token over the adapters that hold it (2 pools × 6).
    function _deployIdle(MySunVaultUpgradeable vault, IPositionAdapter[] memory all, address[] memory reg) internal {
        uint256[] memory slice = new uint256[](reg.length);
        for (uint256 j; j < reg.length; ++j) {
            slice[j] = IERC20(reg[j]).balanceOf(address(vault)) / (2 * TRI_PER_POOL);
        }
        for (uint256 i; i < all.length; ++i) {
            (address[] memory pt,) = all[i].position();
            uint256[] memory amounts = new uint256[](2);
            for (uint256 k; k < 2; ++k) {
                for (uint256 j; j < reg.length; ++j) {
                    if (pt[k] == reg[j]) amounts[k] = slice[j];
                }
            }
            vault.deployTo(all[i], amounts);
        }
    }

    /// @dev USDG (6 dp) worth of a [USDG, WETH, PONS] vector at the v3 reference spots — display yardstick only.
    function _value(uint256[] memory a) internal view returns (uint256) {
        return a[0] + _quote0to1(a[1], _v3Sqrt(POOL_FEE100)) + _quote0to1(a[2], _v3Sqrt(REF_POOL_PONS));
    }

    /// @dev The "tri" vault of ../shared/deployment.local.json (DemoTriPool writes it).
    function _triVault() internal view returns (address) {
        string memory json = vm.readFile("../shared/deployment.local.json");
        for (uint256 i; vm.keyExistsJson(json, string.concat(".vaults[", vm.toString(i), "]")); ++i) {
            string memory p = string.concat(".vaults[", vm.toString(i), "]");
            if (keccak256(bytes(vm.parseJsonString(json, string.concat(p, ".key")))) == keccak256("tri")) {
                return vm.parseJsonAddress(json, string.concat(p, ".vault"));
            }
        }
        revert("no \"tri\" vault in ../shared/deployment.local.json - run script/tri-pool-up.sh");
    }
}

/**
 * @notice Step 1 of `sunTriLP` (script/tri-pool-up.sh runs it): make the third leg's venues usable on the LOCAL chain —
 *         IDEMPOTENT, signed by OWNER (anvil #201), so it never touches the tri deployer's (#202) nonce:
 *   - v3 WETH/PONS fee-10000 reference (the ETH/PONS adapters' TWAP + factory-canonical venue check): present on a
 *     live fork; ABSENT from a frozen state that never read it. If absent: the real factory `createPool`s it (CREATE2
 *     → the same canonical address), it is initialized at the cross price of the two other references
 *     (tick = fee-100 WETH→USDG tick − fee-10000 PONS→USDG tick) and seeded with a wide position. (A frozen factory
 *     answers fee tier 10000 as disabled — its config slot was never read; tri-pool-up.sh restores it first.)
 *   - Fables ETH/PONS v4 pool (native ETH, per-market hook): live and correctly priced on RHC (no move — it must sit
 *     within MAX_REF_GAP_TICKS of the reference, else the run fails). Absent from a frozen state, where tri-pool-up.sh
 *     first installs the hook's code + this market's config (anvil_setCode / anvil_setStorageAt, copied from RHC) →
 *     `PoolManager.initialize` at the reference's spot, then a wide demo seed (native ETH + PONS) gives the adapters'
 *     ratio swaps depth — only if the active liquidity is thin (a live pool keeps its real liquidity).
 * Nothing here is ever broadcast to Robinhood Chain: the chain id must be the local 46630.
 */
contract DemoTriPoolProvision is TriPoolBase {
    using SafeERC20 for IERC20;

    int24 internal constant REF_SEED_HALF_WIDTH = 20_000; // ticks around the cross price (snapped to spacing 200)
    uint256 internal constant REF_SEED_WETH = 0.5e18;
    int24 internal constant V4_SEED_HALF_WIDTH = 3_000; // ticks around the reference spot (snapped to spacing 60)
    uint256 internal constant V4_SEED_ETH = 1e18;
    /// @dev Seed when the active liquidity is below this (1 ETH over ±3,000 ticks at ≈7.6k PONS/ETH ≈ 6e20; the live
    ///      RHC pool carries ≈ 3.9e22, read 2026-10-17).
    uint128 internal constant V4_MIN_LIQUIDITY = 1e20;
    /// @dev v4 spot vs reference spot (the adapters' deploy guard is spot vs 1800 s TWAP ≤ 200; live gap ≈ 10).
    uint256 internal constant MAX_REF_GAP_TICKS = 100;

    function run() external {
        require(block.chainid == EXPECTED_CHAIN_ID, "DemoTriPoolProvision: not the local demo chain (chain id)");
        require(POOL_MANAGER.code.length > 0 && V3_FACTORY.code.length > 0, "DemoTriPoolProvision: RHC venues missing");
        require(
            FABLES_ETH_PONS.code.length > 0,
            "DemoTriPoolProvision: no Fables ETH/PONS hook code - run script/tri-pool-up.sh (hook materialization)"
        );

        vm.startBroadcast(OWNER);
        _provisionRef();
        _provisionV4();
        vm.stopBroadcast();

        (uint160 sqrtP, int24 tick) = V4StateReader.getSlot0(IPoolManagerMinimal(POOL_MANAGER), ETH_PONS_POOL_ID);
        int24 refTick = _v3Tick(REF_POOL_WETH_PONS);
        require(sqrtP != 0, "Fables ETH/PONS pool not initialized");
        require(_abs(int256(tick) - int256(refTick)) <= MAX_REF_GAP_TICKS, "Fables ETH/PONS spot off its reference");
        require(_v4Liquidity(ETH_PONS_POOL_ID) >= V4_MIN_LIQUIDITY, "Fables ETH/PONS pool too thin");
        console2.log("v3 WETH/PONS ref  :", REF_POOL_WETH_PONS);
        console2.log(
            string.concat(
                "  tick ",
                vm.toString(refTick),
                " / liquidity ",
                vm.toString(IUniswapV3PoolMinimal(REF_POOL_WETH_PONS).liquidity())
            )
        );
        console2.log(string.concat("Fables ETH/PONS pool : tick ", vm.toString(tick)));
        console2.log("  active liquidity:", _v4Liquidity(ETH_PONS_POOL_ID));
    }

    function _provisionRef() internal {
        if (REF_POOL_WETH_PONS.code.length == 0) {
            _createRef();
        } else {
            console2.log("v3 WETH/PONS ref present");
        }
        // Seed only a reference this chain left EMPTY (a recreated one) — a live one keeps its real liquidity.
        if (IUniswapV3PoolMinimal(REF_POOL_WETH_PONS).liquidity() != 0) {
            return;
        }
        (uint160 sqrtP, int24 tick,,,,,) = IUniswapV3PoolMinimal(REF_POOL_WETH_PONS).slot0();
        uint256 ponsMax = _quote0to1(REF_SEED_WETH, sqrtP) * 2;
        IERC20(WETH).forceApprove(NFPM, REF_SEED_WETH);
        IERC20(PONS).forceApprove(NFPM, ponsMax);
        int24 center = _floorTo(tick, REF_WETH_PONS_SPACING);
        INonfungiblePositionManager(NFPM)
            .mint(
                INonfungiblePositionManager.MintParams({
                    token0: WETH,
                    token1: PONS,
                    fee: REF_WETH_PONS_FEE,
                    tickLower: center - REF_SEED_HALF_WIDTH,
                    tickUpper: center + REF_SEED_HALF_WIDTH,
                    amount0Desired: REF_SEED_WETH,
                    amount1Desired: ponsMax,
                    amount0Min: 0,
                    amount1Min: 0,
                    recipient: OWNER,
                    // Unbounded: the script simulates at the latest block's time, but a frozen chain mines its next
                    // block at wall-clock time — any `block.timestamp + x` can already be past ("Transaction too old").
                    deadline: type(uint256).max
                })
            );
        IERC20(WETH).forceApprove(NFPM, 0);
        IERC20(PONS).forceApprove(NFPM, 0);
        console2.log("v3 WETH/PONS ref SEEDED");
    }

    function _createRef() internal {
        IUniswapV3FactoryProvision f = IUniswapV3FactoryProvision(V3_FACTORY);
        require(
            f.feeAmountTickSpacing(REF_WETH_PONS_FEE) == REF_WETH_PONS_SPACING,
            "v3 factory: fee tier 10000 disabled in this state - run script/tri-pool-up.sh (fee-tier restore)"
        );
        require(f.getPool(WETH, PONS, REF_WETH_PONS_FEE) == address(0), "v3 factory already lists another ref");
        address pool = f.createPool(WETH, PONS, REF_WETH_PONS_FEE);
        require(pool == REF_POOL_WETH_PONS, "createPool landed off the canonical address");

        int24 cross = _v3Tick(POOL_FEE100) - _v3Tick(REF_POOL_PONS); // PONS per WETH (token0 WETH, token1 PONS)
        uint160 sqrtP = TickMath.getSqrtRatioAtTick(cross);
        IUniswapV3PoolInit(pool).initialize(sqrtP);
        console2.log(string.concat("v3 WETH/PONS ref CREATED + initialized at cross tick ", vm.toString(cross)));
    }

    function _provisionV4() internal {
        PoolKey memory key = _ethPonsKey();
        int24 target = _v3Tick(REF_POOL_WETH_PONS);
        (uint160 sqrtP, int24 tick) = V4StateReader.getSlot0(IPoolManagerMinimal(POOL_MANAGER), ETH_PONS_POOL_ID);
        if (sqrtP == 0) {
            IPoolManagerProvision(POOL_MANAGER).initialize(key, TickMath.getSqrtRatioAtTick(target));
            console2.log(string.concat("Fables ETH/PONS pool INITIALIZED at the reference tick ", vm.toString(target)));
        } else {
            console2.log(string.concat("Fables ETH/PONS pool live at tick ", vm.toString(tick)));
        }

        if (_v4Liquidity(ETH_PONS_POOL_ID) >= V4_MIN_LIQUIDITY) {
            console2.log("Fables ETH/PONS pool deep enough - no seed");
            return;
        }
        DemoV4PoolTool tool = new DemoV4PoolTool(POOL_MANAGER);
        (uint160 spot,) = V4StateReader.getSlot0(IPoolManagerMinimal(POOL_MANAGER), ETH_PONS_POOL_ID);
        int24 center = _floorTo(target, 60);
        int24 lower = center - V4_SEED_HALF_WIDTH;
        int24 upper = center + V4_SEED_HALF_WIDTH;
        uint256 ponsMax = _quote0to1(V4_SEED_ETH, spot) * 2;
        uint128 liquidity = LiquidityAmounts.getLiquidityForAmounts(
            spot, TickMath.getSqrtRatioAtTick(lower), TickMath.getSqrtRatioAtTick(upper), V4_SEED_ETH, ponsMax
        );
        IERC20(PONS).forceApprove(address(tool), ponsMax);
        tool.seed{value: V4_SEED_ETH}(key, lower, upper, liquidity, V4_SEED_ETH, ponsMax);
        IERC20(PONS).forceApprove(address(tool), 0);
        console2.log("Fables ETH/PONS pool SEEDED, liquidity", liquidity);
    }
}

/**
 * @notice Step 2 of `sunTriLP` (script/tri-pool-up.sh runs it after DemoTriPoolProvision): the THIRD local demo vault —
 *         basket [USDG, WETH, PONS] (3 tokens), receipt `sunTriLP`, 18 REAL v4 adapters, two per token pair:
 *   - 6 × UniswapV4NativeEthAdapter on the native ETH/USDG FablesRampETH pool (ref v3 USDG/WETH fee-100; own native
 *     executor — the WETH⇄ETH bridge),
 *   - 6 × UniswapV4HookedAdapter on the PONS/USDG FablesRamp pool (ref v3 PONS/USDG fee-10000),
 *   - 6 × UniswapV4NativeEthAdapter on the native ETH/PONS Fables market pool (per-market hook; ref v3 WETH/PONS
 *     fee-10000; the same native executor),
 *   all ±600 ticks, TWAP 1800 s, max slippage 200 bps, swap venue = their own v4 pool. Fee profile as "demo"/"pons"
 *   (10% performance fee to OWNER). Genesis sizing (contracts/AGENTS.md → Basket model): K = TRI_GENESIS_SHARES
 *   (default 10e18) on ≈ K/3 USDG of each token at the reference spots — a ≈ $10 basket, ≈ $1 per sunTriLP; the cap
 *   (1,000 shares ≈ $1k) keeps the vault at demo scale.
 *
 * Deterministic addresses: every CREATE (DepositSplit, the implementation + proxy, both executors, the 18 adapters)
 * comes from anvil #202, which must be at nonce 0 — on a rebuild AND on a running chain the stack lands on the same
 * addresses (the "demo"/"pons" stack's deployer #201 has a run-dependent nonce by now). Owner calls (venue switch,
 * addAdapter — capability masks derive there —, keeper, genesis) are signed by #201 = OWNER (the `--private-key`),
 * keeper `deployTo` by #1. Appends (or replaces) the `"tri"` entry of ../shared/deployment.local.json, last.
 */
contract DemoTriPool is TriPoolBase, VaultColdLink {
    using SafeERC20 for IERC20;

    uint16 internal constant FEE_BPS = 1000; // 10% performance fee (as "demo" / "pons")
    uint256 internal constant MAX_TOTAL_SUPPLY = 1_000e18; // demo scale: never > ≈ $1k
    uint256 internal constant DEFAULT_GENESIS_SHARES = 10e18; // ≈ $10 basket → ≈ $1 / share
    uint256 internal constant N_PER_POOL = TRI_PER_POOL;
    int24 internal constant RANGE = 600;
    uint32 internal constant TWAP_WINDOW = 1800;
    uint16 internal constant MAX_SLIPPAGE_BPS = 200;
    string internal constant LABEL = "USDG / WETH / PONS basket (RHC fork - 3 real Uniswap v4 pools)";

    struct Tri {
        address vault;
        address depositSplit;
        address swapExecutor;
        address nativeExecutor;
        address[] basket; // [USDG, WETH, PONS] — vault registry order
        address[] adapters; // ETH/USDG natives, PONS/USDG hooked, ETH/PONS natives — N_PER_POOL each, addAdapter order
    }

    function run() external {
        require(block.chainid == EXPECTED_CHAIN_ID, "DemoTriPool: not the local demo chain (chain id)");
        require(vm.getNonce(TRI_DEPLOYER) == 0, "DemoTriPool: anvil #202 nonce != 0 - addresses would drift");
        require(REF_POOL_WETH_PONS.code.length > 0, "DemoTriPool: run DemoTriPoolProvision first");
        uint256 genesisShares = vm.envOr("TRI_GENESIS_SHARES", DEFAULT_GENESIS_SHARES);
        uint256[] memory gen = _genesisAmounts(genesisShares);

        Tri memory t;
        t.basket = new address[](3);
        t.basket[0] = USDG;
        t.basket[1] = WETH;
        t.basket[2] = PONS;

        /* ------------- phase 1: every CREATE, from anvil #202 (nonce 0 → deterministic addresses) ------------- */
        vm.startBroadcast(vm.deriveKey(TEST_MNEMONIC, 202));
        _deployContracts(t, genesisShares);
        vm.stopBroadcast();

        /* ------------- phase 2: owner wiring + genesis (anvil #201 == OWNER) ------------- */
        vm.startBroadcast(OWNER);
        MySunVaultUpgradeable vaultC = MySunVaultUpgradeable(t.vault);
        for (uint256 i; i < t.adapters.length; ++i) {
            // The three v4 pools are their pairs' venues (two v3 refs are thin): every adapter swaps on its own pool.
            // The three adapter types share the enum's layout (V3_REF_POOL = 0, V4_POOL = 1).
            UniswapV4Adapter(t.adapters[i]).setSwapVenue(UniswapV4Adapter.SwapVenue.V4_POOL);
            vaultC.addAdapter(IPositionAdapter(t.adapters[i]));
        }
        vaultC.setKeeper(KEEPER, true);
        for (uint256 i; i < 3; ++i) {
            IERC20(t.basket[i]).forceApprove(t.vault, gen[i]);
        }
        // Owner-only genesis, in kind; no adapter holds anything yet, so the whole genesis stays idle.
        vaultC.deposit(t.basket, gen, genesisShares, OWNER);
        vm.stopBroadcast();

        /* ------------- phase 3: keeper seeds all 18 adapters from the vault's own idle (anvil #1) ------------- */
        vm.startBroadcast(ANVIL_KEY_1);
        _keeperDeployIdle(vaultC);
        vm.stopBroadcast();

        _assertTri(t);
        _log(t);
        _writeRegistry(t.vault);
    }

    function _deployContracts(Tri memory t, uint256 genesisShares) internal {
        t.depositSplit = address(new DepositSplit());
        Options memory opts;
        opts.constructorData = abi.encode(t.depositSplit);
        t.vault = Upgrades.deployUUPSProxy(
            "MySunVaultUpgradeable.sol",
            abi.encodeCall(
                MySunVaultUpgradeable(address(0)).initialize,
                (OWNER, "sunTriLP", "sunTriLP", t.basket, OWNER, FEE_BPS, genesisShares, MAX_TOTAL_SUPPLY)
            ),
            opts
        );
        t.swapExecutor = address(new UniversalRouterSwapExecutor(UNIVERSAL_ROUTER, PERMIT2));
        t.nativeExecutor = address(
            new UniversalRouterNativeSwapExecutor(
                UNIVERSAL_ROUTER, IPositionManagerMinimal(POSM).permit2(), INativeWrapperMinimal(POSM).WETH9()
            )
        );
        t.adapters = new address[](3 * N_PER_POOL);
        for (uint256 i; i < N_PER_POOL; ++i) {
            t.adapters[i] = _native(t, _ethKey(), POOL_FEE100);
        }
        for (uint256 i; i < N_PER_POOL; ++i) {
            t.adapters[N_PER_POOL + i] = _hooked(t);
        }
        for (uint256 i; i < N_PER_POOL; ++i) {
            t.adapters[2 * N_PER_POOL + i] = _native(t, _ethPonsKey(), REF_POOL_WETH_PONS);
        }
    }

    function _native(Tri memory t, PoolKey memory key, address refPool) internal returns (address) {
        return address(
            new UniswapV4NativeEthAdapter(
                UniswapV4NativeEthAdapter.Config({
                    vault: t.vault,
                    positionManager: POSM,
                    poolKey: key,
                    refPool: refPool,
                    swapRouter: UNIVERSAL_ROUTER,
                    swapExecutor: t.nativeExecutor,
                    owner: OWNER,
                    rangeTicksBelow: RANGE,
                    rangeTicksAbove: RANGE,
                    twapWindow: TWAP_WINDOW,
                    maxSlippageBps: MAX_SLIPPAGE_BPS
                })
            )
        );
    }

    function _hooked(Tri memory t) internal returns (address) {
        return address(
            new UniswapV4HookedAdapter(
                UniswapV4HookedAdapter.Config({
                    vault: t.vault,
                    positionManager: POSM,
                    poolKey: _ponsKey(),
                    refPool: REF_POOL_PONS,
                    swapRouter: UNIVERSAL_ROUTER,
                    swapExecutor: t.swapExecutor,
                    owner: OWNER,
                    rangeTicksBelow: RANGE,
                    rangeTicksAbove: RANGE,
                    twapWindow: TWAP_WINDOW,
                    maxSlippageBps: MAX_SLIPPAGE_BPS
                })
            )
        );
    }

    /// @dev [USDG, WETH, PONS] worth ≈ K/3 USDG each at the v3 reference spots (USDG/WETH fee-100, PONS/USDG
    ///      fee-10000) — the demo's stand-in for the one-time off-chain valuation behind K.
    function _genesisAmounts(uint256 genesisShares) internal view returns (uint256[] memory gen) {
        gen = new uint256[](3);
        gen[0] = genesisShares / 3 / 1e12; // 18-dp shares at 1 USDG each → 6-dp USDG
        gen[1] = _quote1to0(gen[0], _v3Sqrt(POOL_FEE100)); // fee-100: token0 WETH, token1 USDG
        gen[2] = _quote1to0(gen[0], _v3Sqrt(REF_POOL_PONS)); // fee-10000: token0 PONS, token1 USDG
        require(
            IERC20(USDG).balanceOf(OWNER) >= gen[0] && IERC20(WETH).balanceOf(OWNER) >= gen[1]
                && IERC20(PONS).balanceOf(OWNER) >= gen[2],
            "DemoTriPool: OWNER (#201) cannot fund the genesis"
        );
    }

    /// @dev Slices of the vault's idle into EVERY adapter: each token sits in two pools × 6 adapters, so each adapter
    ///      gets ≈ idle_i / 12 of each of its two tokens (≈ equal value per adapter for a 1/3-each basket), TILTED so no
    ///      adapter is left a USDG-in dust swap: an adapter swaps any imbalance at a TWAP min-out, and at the ≈ $10
    ///      genesis an exact-ratio slice leaves an imbalance of a few raw USDG (6 dp) — one raw unit of pool rounding is
    ///      then > the 200 bps guard (`SwapExecutor__SlippageExceeded`). So the USDG-pair adapters get +10% of their
    ///      18-dp token (their ratio swap runs 18 dp → USDG, a few % of the slice) and the ETH/PONS adapters −10% of
    ///      both (18 dp on both sides — dust swaps there round harmlessly): 6 × 1.1 + 6 × 0.9 = 12 slices, nothing
    ///      beyond the idle. Amounts are in each adapter's own `position()` token order (native [WETH, USDG] /
    ///      [WETH, PONS] — WETH stands in for the native leg —, hooked [PONS, USDG]); the rounding dust stays idle.
    function _keeperDeployIdle(MySunVaultUpgradeable vaultC) internal {
        IPositionAdapter[] memory all = vaultC.adapters();
        address[] memory reg = vaultC.tokens();
        uint256[] memory slice = new uint256[](reg.length);
        for (uint256 j; j < reg.length; ++j) {
            uint256 holders;
            for (uint256 i; i < all.length; ++i) {
                (address[] memory pt,) = all[i].position();
                if (pt[0] == reg[j] || pt[1] == reg[j]) holders++;
            }
            slice[j] = IERC20(reg[j]).balanceOf(address(vaultC)) / holders;
        }
        for (uint256 i; i < all.length; ++i) {
            (address[] memory pt,) = all[i].position();
            bool usdgPair = pt[0] == USDG || pt[1] == USDG;
            uint256[] memory amounts = new uint256[](2);
            for (uint256 k; k < 2; ++k) {
                uint256 tilt = !usdgPair ? 9 : pt[k] == USDG ? 10 : 11; // tenths of a slice
                for (uint256 j; j < reg.length; ++j) {
                    if (pt[k] == reg[j]) amounts[k] = slice[j] * tilt / 10;
                }
            }
            vaultC.deployTo(all[i], amounts);
        }
    }

    /// @dev Each adapter owns one live NFT on ITS pool and carries a non-zero capability mask; the vault's basket view
    ///      = idle + every adapter's report; no ETH rests in a native adapter or the native executor.
    function _assertTri(Tri memory t) internal view {
        MySunVaultUpgradeable vaultC = MySunVaultUpgradeable(t.vault);
        IPositionManagerMinimal posm = IPositionManagerMinimal(POSM);
        require(vaultC.adapters().length == 3 * N_PER_POOL, "tri vault adapter count");
        uint256[] memory sum = new uint256[](3);
        for (uint256 j; j < 3; ++j) {
            sum[j] = IERC20(t.basket[j]).balanceOf(t.vault);
        }
        for (uint256 i; i < t.adapters.length; ++i) {
            address ad = t.adapters[i];
            uint256 id = UniswapV4Adapter(ad).tokenId();
            require(id != 0 && posm.ownerOf(id) == ad && posm.balanceOf(ad) == 1, "tri adapter: no own live NFT");
            require(posm.getPositionLiquidity(id) > 0, "tri adapter: position has no liquidity");
            (PoolKey memory key,) = posm.getPoolAndPositionInfo(id);
            bytes32 want = i < N_PER_POOL ? ETH_POOL_ID : i < 2 * N_PER_POOL ? PONS_POOL_ID : ETH_PONS_POOL_ID;
            require(keccak256(abi.encode(key)) == want, "tri adapter NFT on the wrong pool");
            require(vaultC.adapterCapabilities(IPositionAdapter(ad)) != 0, "tri adapter: zero capability mask");
            require(ad.balance == 0, "tri adapter holds ETH");
            (address[] memory pt, uint256[] memory held) = IPositionAdapter(ad).position();
            for (uint256 k; k < 2; ++k) {
                for (uint256 j; j < 3; ++j) {
                    if (pt[k] == t.basket[j]) sum[j] += held[k];
                }
            }
        }
        (address[] memory tt, uint256[] memory totals) = vaultC.totalTokens();
        for (uint256 j; j < 3; ++j) {
            require(tt[j] == t.basket[j], "tri vault registry order");
            require(totals[j] == sum[j], "tri vault totals != idle + adapter positions");
        }
        require(t.nativeExecutor.balance == 0, "native executor holds ETH");
    }

    function _log(Tri memory t) internal view {
        MySunVaultUpgradeable vaultC = MySunVaultUpgradeable(t.vault);
        console2.log("== sunTriLP (local demo chain) ==");
        console2.log("vault (proxy)    :", t.vault);
        console2.log("implementation   :", Upgrades.getImplementationAddress(t.vault));
        console2.log("deposit splitter :", t.depositSplit);
        console2.log("swap executor    :", t.swapExecutor);
        console2.log("native executor  :", t.nativeExecutor);
        console2.log("totalSupply      :", vaultC.totalSupply());
        (address[] memory tt, uint256[] memory totals) = vaultC.totalTokens();
        for (uint256 j; j < tt.length; ++j) {
            console2.log("total / idle     :", totals[j], IERC20(tt[j]).balanceOf(t.vault));
        }
        for (uint256 i; i < t.adapters.length; ++i) {
            (, uint256[] memory held) = IPositionAdapter(t.adapters[i]).position();
            console2.log(t.adapters[i], UniswapV4Adapter(t.adapters[i]).tokenId(), held[0], held[1]);
        }
    }

    /* ------------------------------ shared/deployment.local.json ------------------------------ */

    /// @dev Re-serializes the existing registry (every vault but a previous "tri", the periphery, the root fields)
    ///      and appends the "tri" entry LAST — the frontend tests treat `vaults[0]` as the default vault.
    function _writeRegistry(address vault) internal {
        string memory path = "../shared/deployment.local.json";
        string memory old = vm.readFile(path);
        string memory vaults = "[";
        uint256 n;
        for (uint256 i; vm.keyExistsJson(old, string.concat(".vaults[", vm.toString(i), "]")); ++i) {
            string memory p = string.concat(".vaults[", vm.toString(i), "]");
            string memory key = vm.parseJsonString(old, string.concat(p, ".key"));
            if (keccak256(bytes(key)) == keccak256("tri")) continue;
            vaults = string.concat(vaults, n++ == 0 ? "" : ",", _copyVault(old, p, i));
        }
        vaults = string.concat(vaults, n == 0 ? "" : ",", _triJson(vault), "]");

        string memory periphObj = "tri_periphery";
        vm.serializeAddress(periphObj, "zapIn", vm.parseJsonAddress(old, ".periphery.zapIn"));
        vm.serializeAddress(periphObj, "zapOut", vm.parseJsonAddress(old, ".periphery.zapOut"));
        string memory periph =
            vm.serializeAddress(periphObj, "planExecutor", vm.parseJsonAddress(old, ".periphery.planExecutor"));
        string memory root = "tri_deployment";
        vm.serializeJson(root, string.concat("{\"vaults\":", vaults, ",\"periphery\":", periph, "}"));
        vm.serializeUint(root, "version", vm.parseJsonUint(old, ".version"));
        vm.serializeUint(root, "chainId", vm.parseJsonUint(old, ".chainId"));
        vm.serializeBool(root, "fork", vm.parseJsonBool(old, ".fork"));
        vm.serializeBool(root, "mintable", vm.parseJsonBool(old, ".mintable"));
        string memory json = vm.serializeString(root, "rpcUrl", vm.parseJsonString(old, ".rpcUrl"));
        vm.writeJson(json, path);
        console2.log("wrote ../shared/deployment.local.json (+ vault \"tri\", last)");
    }

    function _copyVault(string memory old, string memory p, uint256 i) internal returns (string memory) {
        string memory receiptObj = string.concat("tri_copy_receipt_", vm.toString(i));
        vm.serializeString(receiptObj, "name", vm.parseJsonString(old, string.concat(p, ".receipt.name")));
        string memory receipt =
            vm.serializeString(receiptObj, "symbol", vm.parseJsonString(old, string.concat(p, ".receipt.symbol")));
        string memory obj = string.concat("tri_copy_vault_", vm.toString(i));
        vm.serializeString(obj, "key", vm.parseJsonString(old, string.concat(p, ".key")));
        vm.serializeString(obj, "label", vm.parseJsonString(old, string.concat(p, ".label")));
        vm.serializeString(obj, "receipt", receipt);
        vm.serializeAddress(obj, "vault", vm.parseJsonAddress(old, string.concat(p, ".vault")));
        vm.serializeAddress(obj, "implementation", vm.parseJsonAddress(old, string.concat(p, ".implementation")));
        vm.serializeAddress(obj, "keeper", vm.parseJsonAddress(old, string.concat(p, ".keeper")));
        return vm.serializeAddress(obj, "demoUser", vm.parseJsonAddress(old, string.concat(p, ".demoUser")));
    }

    function _triJson(address vault) internal returns (string memory) {
        MySunVaultUpgradeable vaultC = MySunVaultUpgradeable(vault);
        vm.serializeString("tri_receipt", "name", vaultC.name());
        string memory receipt = vm.serializeString("tri_receipt", "symbol", vaultC.symbol());
        string memory obj = "tri_vault";
        vm.serializeString(obj, "key", "tri");
        vm.serializeString(obj, "label", LABEL);
        vm.serializeString(obj, "receipt", receipt);
        vm.serializeAddress(obj, "vault", vault);
        vm.serializeAddress(obj, "implementation", Upgrades.getImplementationAddress(vault));
        vm.serializeAddress(obj, "keeper", KEEPER);
        return vm.serializeAddress(obj, "demoUser", DEMO_USER);
    }
}
