// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import {Script, console2} from "forge-std/Script.sol";
import {PoolKey, IPoolManagerMinimal} from "contracts/adapters/uniswap/v4/IPoolManagerMinimal.sol";
import {IPositionManagerMinimal} from "contracts/adapters/uniswap/v4/IPositionManagerMinimal.sol";
import {IUniswapV3PoolMinimal} from "contracts/adapters/uniswap/IUniswapV3PoolMinimal.sol";
import {UniswapV4HookedAdapter} from "contracts/adapters/UniswapV4HookedAdapter.sol";

/// @notice Zero-broadcast probe: the 12 Fables stock markets on RHC 4663 (contracts/REPORT-STOCK-MARKETS-RECON.md).
///         For EVERY market (none is skipped): recompute poolId = keccak256(abi.encode(PoolKey)) and require it equals
///         the poolId discovered from the PoolManager's Initialize log; require the pool initialized (sqrtPrice != 0)
///         with in-range liquidity > 0 (PoolManager extsload, V4StateReader layout); require the v3 TWAP reference
///         to carry liquidity > 0; construct a `UniswapV4HookedAdapter` with the proposed Config (the constructor runs
///         every sanity check: hook bits vs HOOK_FORBIDDEN_FLAGS, pool initialized, ref venue = factory-canonical pool
///         of the same ordered pair, router/executor wiring, range/TWAP/slippage bounds); then read `twapTick()`
///         (observe over the window must succeed) and require the v4 spot within `maxSlippageBps` ticks of it (the
///         guard `deployTo` would apply right now). Failures are collected per market and the run REVERTS at the end
///         if any market failed — nothing is skipped silently.
///         The simulated adapters use placeholder vault/owner 0xdead; nothing is broadcast.
///   cd contracts && forge script script/ProbeStockMarkets.s.sol --rpc-url rhc     # NO --broadcast
contract ProbeStockMarkets is Script {
    address internal constant PLACEHOLDER = address(0xdead); // vault + owner of the simulated adapters
    address internal constant POSM = 0x58daec3116aae6D93017bAAea7749052E8a04fA7; // v4 PositionManager
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant UNIVERSAL_ROUTER = 0x204FAca1764B154221e35c0d20aBb3c525710498; // UR 2.1.2
    address internal constant SWAP_EXECUTOR = 0x413a67ca4E83A4782F7745858979fE059ccbB431; // shared ERC-20 executor
    uint24 internal constant DYNAMIC_FEE = 0x800000;
    int24 internal constant RANGE_TICKS = 600; // the live 6-adapter pattern: ±600, snapped outward to the spacing
    uint32 internal constant TWAP_WINDOW = 1800;
    uint16 internal constant MAX_SLIPPAGE_BPS = 200;

    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant SPY = 0x117cc2133c37B721F49dE2A7a74833232B3B4C0C;
    address internal constant GLD = 0xC9a981FEE1F9DEc688bb123ccDeCc63D0deBFC4e;
    address internal constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address internal constant SPCX = 0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa;
    address internal constant CRCL = 0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5;
    address internal constant TSLA = 0x322F0929c4625eD5bAd873c95208D54E1c003b2d;
    address internal constant AAPL = 0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9;
    address internal constant AMZN = 0x12f190a9F9d7D37a250758b26824B97CE941bF54;
    address internal constant INTC = 0xc72b96e0E48ecd4DC75E1e45396e26300BC39681;
    address internal constant MU = 0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD;
    address internal constant MSTR = 0xec262a75e413fAfD0dF80480274532C79D42da09;

    struct Market {
        string slug;
        address currency0;
        address currency1;
        int24 tickSpacing;
        address hooks;
        bytes32 poolId; // from the PoolManager Initialize log
        address refPool; // v3 TWAP reference (deepest live tier with a working observe(1800))
    }

    function markets() internal pure returns (Market[] memory m) {
        m = new Market[](12);
        m[0] = Market(
            "spy",
            SPY,
            USDG,
            10,
            0xA0E8fBFf13E24Af2b5e61A72800E08a161bDe080,
            0x8674c1c5544f3c9563565b5d4bd5916701d90b3559b072acf7cef5b4fc5b8dcd,
            0xa7Bb1AC63BBaB0C44316E6c8C455213441689167
        );
        m[1] = Market(
            "gld",
            USDG,
            GLD,
            10,
            0xB608a78761f179f7C56f15E7D13921B92F00a080,
            0xfe281bbfa9aa658c1aa9c2ad1b0c62c4286f96c7cb1074296b54e869935a7a3a,
            0x7A6A053eCCf1446A2633E05aA6D40D09381997ec
        );
        m[2] = Market(
            "nvda",
            USDG,
            NVDA,
            10,
            0x66622f77B797D506e5376F7798b67ab288966080,
            0x7990aad9e8fb048f49a155a7df5603db0366f0657035b78eb4196395cccb3dcd,
            0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3
        );
        m[3] = Market(
            "spcx",
            SPCX,
            USDG,
            10,
            0x5Eb87F69bE00Df39981622Fd60A8De4b7837e080,
            0xb81d873dfb2bb1aaf08804053f8940fd06bb30a2b5a0fafcdbcc7325544452b9,
            0xc61284332117c3FB23A2A56cceFFD07F7aF60029
        );
        m[4] = Market(
            "crcl",
            USDG,
            CRCL,
            60,
            0x5Eb87F69bE00Df39981622Fd60A8De4b7837e080,
            0xdb9c34002d173981250969293af6f43f42a26f2110f19893bbe2ad373375e9e6,
            0x654E4143e82a5824445Ade0824351C2A9ACD95a8
        );
        m[5] = Market(
            "tsla",
            TSLA,
            USDG,
            10,
            0x67D86050d22D574Df046F3D90F722045F714e080,
            0xd5effce87036cd858146c0c15fa825c231a9de1843200ca108e431e431331e8e,
            0xf4ACdAEEB7022862A763C9B1B885e11191c889E3
        );
        m[6] = Market(
            "aapl",
            USDG,
            AAPL,
            10,
            0x70a9A88402989226847Ec122043CE5e7FF462080,
            0xa2347ba69167e5602f74640ffbf737ee7cdd825e4726d3462564fc6533070147,
            0xAae0d815EE56e4092a5E5C2911E676Fea50B2d6D
        );
        m[7] = Market(
            "amzn",
            AMZN,
            USDG,
            60,
            0x5Eb87F69bE00Df39981622Fd60A8De4b7837e080,
            0x5619cb8420678b47997f20925eb01be8750c907d6226a0df5d7eafeff966346f,
            0x8AC92DA74AB5F3b1d024Dc1943Ad7e15Dc4179Ef
        );
        m[8] = Market(
            "intc",
            USDG,
            INTC,
            60,
            0x5Eb87F69bE00Df39981622Fd60A8De4b7837e080,
            0x5e4c353496e4c82a406a38ca1eaad6d2d4cdb8d405d422faff84bcb6f548d97e,
            0x2e5a92f5013a64661A49312111be2e8aBd33F56a
        );
        m[9] = Market(
            "mu",
            USDG,
            MU,
            60,
            0x5Eb87F69bE00Df39981622Fd60A8De4b7837e080,
            0x8e36bc9877b9383ae306dd937d40ab0e9df65811e7fdfb6bad25e7102bc398b2,
            0xd057B1Bc54917855BBee58eAd58647f47caB35E5
        );
        m[10] = Market(
            "mstr",
            USDG,
            MSTR,
            60,
            0x5Eb87F69bE00Df39981622Fd60A8De4b7837e080,
            0xe1c3e133c917674bd51704e47c7dfe7f0d66375c89ceb30b083de95f9a1dc5ea,
            0x17578C0e0D15da44f31677263114F71aE76653EA
        );
        m[11] = Market(
            "nvda-spy",
            SPY,
            NVDA,
            10,
            0x79576FBAD6e83915630BBB5D5658483F05532080,
            0x988f3b6ceec4795e0d6d28a054af87ffbcbdeee2566f72ae391da5f109bd485f,
            0x55942b9B4c2f034062c13eEB40F5Bb503B7a6c30
        );
    }

    function run() external {
        require(block.chainid == 4663, "ProbeStockMarkets: not RHC 4663");
        require(
            IPositionManagerMinimal(POSM).poolManager() == POOL_MANAGER, "ProbeStockMarkets: POSM.poolManager mismatch"
        );
        Market[] memory m = markets();
        uint256 failures;
        for (uint256 i; i < m.length; ++i) {
            string memory err = _probe(m[i]);
            if (bytes(err).length == 0) {
                console2.log("[READY]", m[i].slug);
            } else {
                ++failures;
                console2.log(string.concat("[FAIL]  ", m[i].slug, ": ", err));
            }
        }
        console2.log("markets probed:", m.length, "| failed:", failures);
        require(failures == 0, "ProbeStockMarkets: at least one market FAILED (see [FAIL] lines)");
    }

    function _probe(Market memory mk) internal returns (string memory) {
        PoolKey memory key = PoolKey({
            currency0: mk.currency0,
            currency1: mk.currency1,
            fee: DYNAMIC_FEE,
            tickSpacing: mk.tickSpacing,
            hooks: mk.hooks
        });
        bytes32 id = keccak256(abi.encode(key));
        if (id != mk.poolId) {
            return string.concat("poolId mismatch: recomputed ", vm.toString(id));
        }
        (uint160 sqrtP, int24 tick, uint128 liquidity) = _v4State(id);
        if (sqrtP == 0) return "pool not initialized";
        if (liquidity == 0) return "v4 in-range liquidity == 0";
        if (IUniswapV3PoolMinimal(mk.refPool).liquidity() == 0) return "v3 reference has no active liquidity";

        UniswapV4HookedAdapter a;
        try new UniswapV4HookedAdapter(
            UniswapV4HookedAdapter.Config({
                vault: PLACEHOLDER,
                positionManager: POSM,
                poolKey: key,
                refPool: mk.refPool,
                swapRouter: UNIVERSAL_ROUTER,
                swapExecutor: SWAP_EXECUTOR,
                owner: PLACEHOLDER,
                rangeTicksBelow: RANGE_TICKS,
                rangeTicksAbove: RANGE_TICKS,
                twapWindow: TWAP_WINDOW,
                maxSlippageBps: MAX_SLIPPAGE_BPS
            })
        ) returns (
            UniswapV4HookedAdapter deployed
        ) {
            a = deployed;
        } catch (bytes memory reason) {
            return string.concat("adapter constructor reverted: ", vm.toString(reason));
        }
        if (a.poolId() != id) return "adapter.poolId() != discovered poolId";

        int24 twap;
        try a.twapTick() returns (int24 t) {
            twap = t;
        } catch (bytes memory reason) {
            return string.concat("v3 TWAP unavailable over the window: ", vm.toString(reason));
        }
        int24 drift = tick > twap ? tick - twap : twap - tick;
        console2.log(
            string.concat(
                "  ",
                mk.slug,
                " spacing ",
                vm.toString(int256(mk.tickSpacing)),
                " | v4 tick ",
                vm.toString(int256(tick)),
                " | v4 L ",
                vm.toString(uint256(liquidity)),
                " | ref TWAP ",
                vm.toString(int256(twap)),
                " | drift ",
                vm.toString(int256(drift))
            )
        );
        if (uint24(drift) > MAX_SLIPPAGE_BPS) {
            return string.concat("v4 spot deviates from the ref TWAP by ", vm.toString(int256(drift)), " ticks");
        }
        return "";
    }

    /// @dev slot0 + liquidity straight from PoolManager storage (layout: V4StateReader, notes/RHC_ADDRESSES.md).
    function _v4State(bytes32 id) internal view returns (uint160 sqrtP, int24 tick, uint128 liquidity) {
        bytes32 base = keccak256(abi.encodePacked(id, uint256(6)));
        bytes32[] memory w = IPoolManagerMinimal(POOL_MANAGER).extsload(base, 4);
        sqrtP = uint160(uint256(w[0]));
        tick = int24(uint24(uint256(w[0]) >> 160));
        liquidity = uint128(uint256(w[3]));
    }
}
