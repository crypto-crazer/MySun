// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {Upgrades, Options} from "openzeppelin-foundry-upgrades/Upgrades.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {MySunVaultUpgradeable} from "contracts/MySunVaultUpgradeable.sol";
import {DepositSplit} from "contracts/periphery/DepositSplit.sol";
import {PlanExecutor} from "contracts/periphery/PlanExecutor.sol";
import {PoolmigoZapIn} from "contracts/periphery/PoolmigoZapIn.sol";
import {PoolmigoZapOut} from "contracts/periphery/PoolmigoZapOut.sol";
import {IPoolmigoVault} from "contracts/interfaces/IPoolmigoVault.sol";
import {IPositionAdapter} from "contracts/interfaces/IPositionAdapter.sol";
import {ISwapExecutor} from "contracts/interfaces/ISwapExecutor.sol";
import {UniswapV4HookedAdapter} from "contracts/adapters/UniswapV4HookedAdapter.sol";
import {IUniswapV3PoolMinimal} from "contracts/adapters/uniswap/IUniswapV3PoolMinimal.sol";
import {PoolKey, IPoolManagerMinimal} from "contracts/adapters/uniswap/v4/IPoolManagerMinimal.sol";

interface IUniswapV3FactoryMinimal {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address);
}

/// @notice RHC 4663 batch: one `MySunVaultUpgradeable` per Fables stock market (12 vaults), each with 6 EMPTY
///         `UniswapV4HookedAdapter` shells, its own `PlanExecutor`, the shared zaps registered, and a ≈ $1-per-leg
///         genesis left IDLE in the vault. Market data = `REPORT-STOCK-MARKETS-RECON.md` (§2.1 keys, §2.2 refs, §4
///         Config) — re-checked live before every mutating phase; a contradiction reverts (STOP and report).
///         Deployment method mirrors `DeployTriVaultMainnet.s.sol` (the newest 4663 deploy): per vault a fresh
///         `DepositSplit` + `Upgrades.deployUUPSProxy("MySunVaultUpgradeable.sol")` — plain CREATE from the signer,
///         NOT the CREATE3 path. PlanExecutor wiring mirrors the live stacks (`DeployPeriphery.s.sol`): executor owned
///         by OWNER with KEEPER whitelisted, `vault.setKeeper(executor)` + `vault.setKeeper(KEEPER)`.
///
///   Env:  PHASE (required)   plan | vaults | adapters | executors | genesis | verify | all
///           plan       read-only: live recon re-check per market, state-file status, the signer's USDG/ETH vs the
///                      genesis funding requirement. No tx.
///           vaults     OWNER: DepositSplit + vault proxy, initialize(OWNER, sym, sym, basket, OWNER, 1000, K, 0).
///           adapters   OWNER: up to 6 hooked adapters per vault (§4 Config) → setSwapVenue(V4_POOL) → addAdapter.
///                      Shells only: nothing is deployed into them.
///           executors  OWNER: PlanExecutor(vault, OWNER) → executor.setKeeper(KEEPER) → vault.setKeeper(executor)
///                      → vault.setKeeper(KEEPER) → zapIn/zapOut.registerVault(vault) (registration only, no routes).
///           genesis    OWNER: refuses to start unless the signer holds the WHOLE batch's USDG requirement; per
///                      unseeded vault buys each non-USDG leg (≈ $1 at the USDG v3 ref spot, only the shortfall
///                      vs the signer's balance) through the shared swap executor, then the owner-gated genesis
///                      deposit mints exactly K. Never deployTo — the basket stays idle.
///           verify     read-only: every invariant below per vault; reverts if any fails.
///           all        vaults + adapters + executors + genesis + verify in one run.
///         OWNER (default the rehearsal burner 0x2744…2eaa) — must equal the broadcasting sender; vault owner,
///                     treasury, adapter owner, executor owner. It must also own the shared zaps.
///         STOCK_LABEL (default "mainnet")  state file: broadcast/stock-vaults/<label>-<chainid>-<slug>.json.
///         STOCK_ONLY  (optional)           restrict to one slug (e.g. "spy").
///   Every phase resumes from ON-CHAIN state (code at the recorded address? registered? keeper? seeded?) — the file
///   only remembers addresses. A run WITHOUT --broadcast writes `<label>-dryrun-…` instead of the real file.
///
///   Run it through `script/stock-vaults.sh` (PHASE=vaults needs one forge run per slug: the OZ plugin's build-info
///   reads accumulate in script-EVM memory and a 12-vault run dies with MemoryOOG after 7). Runbook + rehearsal:
///   REPORT-STOCK-VAULTS-BATCH.md.
///   forge clean && forge build      (immediately before; never compile in between — OZ-plugin pitfall)
///   PHASE=plan bash script/stock-vaults.sh --rpc-url rhc --sender <owner>                      (read-only)
///   PHASE=vaults bash script/stock-vaults.sh --rpc-url rhc --sender <owner> \
///     --account <keystore> --password-file <pw> --broadcast --slow
contract DeployStockVaults is Script {
    using SafeERC20 for IERC20;

    /* ---------------- roles (shared/deployments.json + notes/DEPLOY-RHC.md, verified live 2026-10-27) ---------------- */
    address internal constant DEFAULT_OWNER = 0x27447D6F3eCAA5f0c6b89a5b3D2FA03ff3392eaa; // rehearsal burner
    address internal constant KEEPER = 0x8d8167913Df18396B00cBAEC347414d6a0F7c27d; // rotated keeper (2026-10-23)

    /* ---------------- venue + periphery (REPORT-STOCK-MARKETS-RECON.md §1–§4, shared/deployments.json) ---------------- */
    address internal constant POSM = 0x58daec3116aae6D93017bAAea7749052E8a04fA7;
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant V3_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address internal constant UNIVERSAL_ROUTER = 0x204FAca1764B154221e35c0d20aBb3c525710498; // UR 2.1.2
    address internal constant SWAP_EXECUTOR = 0x413a67ca4E83A4782F7745858979fE059ccbB431; // shared ERC-20 executor
    address internal constant ZAP_IN = 0x8187691738907dCCBB34f6Aa82059CCF1Ae3870f;
    address internal constant ZAP_OUT = 0xd9151216e2Ab52b446aAb0207Ab34652b44D228C;

    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168; // 6 dp
    address internal constant SPY = 0x117cc2133c37B721F49dE2A7a74833232B3B4C0C; // stocks: 18 dp
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

    /* ---------------- per-vault parameters ---------------- */
    uint24 internal constant DYNAMIC_FEE = 0x800000;
    uint160 internal constant HOOK_PERMISSION_MASK = 0x3FFF;
    uint160 internal constant HOOK_FABLES_BITS = 0x2080; // beforeInitialize + beforeSwap (recon §2)
    uint160 internal constant HOOK_FORBIDDEN_FLAGS = 0x0F0F;
    uint256 internal constant N_ADAPTERS = 6;
    int24 internal constant RANGE = 600;
    uint32 internal constant TWAP_WINDOW = 1800;
    uint16 internal constant MAX_SLIPPAGE_BPS = 200;
    uint16 internal constant FEE_BPS = 1000; // 10% performance fee (mirror sunEthLP / sunPonsLP / sunTriLP)
    uint256 internal constant MAX_TOTAL_SUPPLY = 0; // uncapped (mirror sunTriLP)
    /// @dev Genesis: ≈ $1 per leg × 2 legs = ≈ $2 basket → K = round(2) × 1e18 (contracts/AGENTS.md sizing rule).
    uint256 internal constant LEG_USDG = 1e6; // $1 of USDG (6 dp) — the USD anchor of every leg
    uint256 internal constant GENESIS_K = 2e18;
    uint256 internal constant BUY_BUFFER_BPS = 300; // overpay per buy: covers the ≤ 1% ref fee + impact on $1
    uint256 internal constant LEG_TOLERANCE_BPS = 500; // verify: each leg within $1 ± 5% at the ref spot
    uint8 internal constant CAPS_ALL = 3; // CAP_LIQUIDITY | CAP_SWAP
    uint256 internal constant Q96 = 1 << 96;

    struct Market {
        string slug;
        string symbol; // receipt name = symbol
        address currency0;
        address currency1;
        int24 tickSpacing;
        address hooks;
        bytes32 poolId; // PoolManager Initialize log (recon §2.1)
        address refPool; // v3 TWAP reference (recon §2.2)
        uint24 refFee;
    }

    /// @dev One state file per vault. adapters: N_ADAPTERS slots, address(0) = not deployed yet.
    struct VaultState {
        address vault;
        address depositSplit;
        address implementation;
        address[] adapters;
        address planExecutor;
        address[] basket;
        uint256[] genesis; // deposited amounts, basket order (0s until seeded)
    }

    string internal constant OBJ = "stockVault";

    address internal owner;

    /*//////////////////////////////////////////////////////////////
                                 MARKETS
    //////////////////////////////////////////////////////////////*/

    /// @dev Copied verbatim from REPORT-STOCK-MARKETS-RECON.md (== script/ProbeStockMarkets.s.sol) + the §2.2 ref fee.
    function markets() internal pure returns (Market[] memory m) {
        m = new Market[](12);
        m[0] = Market(
            "spy",
            "sunSpyLP",
            SPY,
            USDG,
            10,
            0xA0E8fBFf13E24Af2b5e61A72800E08a161bDe080,
            0x8674c1c5544f3c9563565b5d4bd5916701d90b3559b072acf7cef5b4fc5b8dcd,
            0xa7Bb1AC63BBaB0C44316E6c8C455213441689167,
            500
        );
        m[1] = Market(
            "gld",
            "sunGldLP",
            USDG,
            GLD,
            10,
            0xB608a78761f179f7C56f15E7D13921B92F00a080,
            0xfe281bbfa9aa658c1aa9c2ad1b0c62c4286f96c7cb1074296b54e869935a7a3a,
            0x7A6A053eCCf1446A2633E05aA6D40D09381997ec,
            3000
        );
        m[2] = Market(
            "nvda",
            "sunNvdaLP",
            USDG,
            NVDA,
            10,
            0x66622f77B797D506e5376F7798b67ab288966080,
            0x7990aad9e8fb048f49a155a7df5603db0366f0657035b78eb4196395cccb3dcd,
            0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3,
            500
        );
        m[3] = Market(
            "spcx",
            "sunSpcxLP",
            SPCX,
            USDG,
            10,
            0x5Eb87F69bE00Df39981622Fd60A8De4b7837e080,
            0xb81d873dfb2bb1aaf08804053f8940fd06bb30a2b5a0fafcdbcc7325544452b9,
            0xc61284332117c3FB23A2A56cceFFD07F7aF60029,
            500
        );
        m[4] = Market(
            "crcl",
            "sunCrclLP",
            USDG,
            CRCL,
            60,
            0x5Eb87F69bE00Df39981622Fd60A8De4b7837e080,
            0xdb9c34002d173981250969293af6f43f42a26f2110f19893bbe2ad373375e9e6,
            0x654E4143e82a5824445Ade0824351C2A9ACD95a8,
            3000
        );
        m[5] = Market(
            "tsla",
            "sunTslaLP",
            TSLA,
            USDG,
            10,
            0x67D86050d22D574Df046F3D90F722045F714e080,
            0xd5effce87036cd858146c0c15fa825c231a9de1843200ca108e431e431331e8e,
            0xf4ACdAEEB7022862A763C9B1B885e11191c889E3,
            3000
        );
        m[6] = Market(
            "aapl",
            "sunAaplLP",
            USDG,
            AAPL,
            10,
            0x70a9A88402989226847Ec122043CE5e7FF462080,
            0xa2347ba69167e5602f74640ffbf737ee7cdd825e4726d3462564fc6533070147,
            0xAae0d815EE56e4092a5E5C2911E676Fea50B2d6D,
            500
        );
        m[7] = Market(
            "amzn",
            "sunAmznLP",
            AMZN,
            USDG,
            60,
            0x5Eb87F69bE00Df39981622Fd60A8De4b7837e080,
            0x5619cb8420678b47997f20925eb01be8750c907d6226a0df5d7eafeff966346f,
            0x8AC92DA74AB5F3b1d024Dc1943Ad7e15Dc4179Ef,
            3000
        );
        m[8] = Market(
            "intc",
            "sunIntcLP",
            USDG,
            INTC,
            60,
            0x5Eb87F69bE00Df39981622Fd60A8De4b7837e080,
            0x5e4c353496e4c82a406a38ca1eaad6d2d4cdb8d405d422faff84bcb6f548d97e,
            0x2e5a92f5013a64661A49312111be2e8aBd33F56a,
            3000
        );
        m[9] = Market(
            "mu",
            "sunMuLP",
            USDG,
            MU,
            60,
            0x5Eb87F69bE00Df39981622Fd60A8De4b7837e080,
            0x8e36bc9877b9383ae306dd937d40ab0e9df65811e7fdfb6bad25e7102bc398b2,
            0xd057B1Bc54917855BBee58eAd58647f47caB35E5,
            3000
        );
        m[10] = Market(
            "mstr",
            "sunMstrLP",
            USDG,
            MSTR,
            60,
            0x5Eb87F69bE00Df39981622Fd60A8De4b7837e080,
            0xe1c3e133c917674bd51704e47c7dfe7f0d66375c89ceb30b083de95f9a1dc5ea,
            0x17578C0e0D15da44f31677263114F71aE76653EA,
            10_000
        );
        m[11] = Market(
            "nvda-spy",
            "sunNvdaSpyLP",
            SPY,
            NVDA,
            10,
            0x79576FBAD6e83915630BBB5D5658483F05532080,
            0x988f3b6ceec4795e0d6d28a054af87ffbcbdeee2566f72ae391da5f109bd485f,
            0x55942b9B4c2f034062c13eEB40F5Bb503B7a6c30,
            500
        );
    }

    function _key(Market memory mk) internal pure returns (PoolKey memory) {
        return PoolKey({
            currency0: mk.currency0,
            currency1: mk.currency1,
            fee: DYNAMIC_FEE,
            tickSpacing: mk.tickSpacing,
            hooks: mk.hooks
        });
    }

    /// @dev USDG first for the 11 USDG markets ("USDG + SPY"); nvda-spy keeps pool order [SPY, NVDA].
    function _basket(Market memory mk) internal pure returns (address[] memory b) {
        b = new address[](2);
        if (mk.currency0 == USDG || mk.currency1 == USDG) {
            b[0] = USDG;
            b[1] = mk.currency0 == USDG ? mk.currency1 : mk.currency0;
        } else {
            b[0] = mk.currency0;
            b[1] = mk.currency1;
        }
    }

    /// @dev The USDG v3 ref (and its fee) of a stock token — the pricing + buy venue for its genesis leg.
    function _usdgRef(address token) internal pure returns (address pool, uint24 fee) {
        Market[] memory m = markets();
        for (uint256 i; i < m.length; ++i) {
            if (
                (m[i].currency0 == USDG && m[i].currency1 == token)
                    || (m[i].currency1 == USDG && m[i].currency0 == token)
            ) {
                return (m[i].refPool, m[i].refFee);
            }
        }
        revert("DeployStockVaults: no USDG reference for token");
    }

    /*//////////////////////////////////////////////////////////////
                                   RUN
    //////////////////////////////////////////////////////////////*/

    function run() external {
        require(block.chainid == 4663, "DeployStockVaults: not RHC 4663 (or a 4663 fork)");
        owner = vm.envOr("OWNER", DEFAULT_OWNER);
        bytes32 phase = keccak256(bytes(vm.envString("PHASE")));
        console2.log("chainId :", block.chainid);
        console2.log("block   :", block.number, "(Orbit: parent-chain block number)");
        console2.log("owner   :", owner);
        console2.log("signer  :", msg.sender);
        console2.log("keeper  :", KEEPER);

        Market[] memory m = _selected();
        _checkMarkets(m); // live re-check of every recon value; reverts on a contradiction

        if (phase == keccak256("plan")) {
            _plan(m);
            return;
        }
        if (phase == keccak256("verify")) {
            _verify(m);
            return;
        }
        require(msg.sender == owner, "DeployStockVaults: signer != OWNER (pass --sender <owner>)");
        if (phase == keccak256("vaults")) {
            _vaults(m);
        } else if (phase == keccak256("adapters")) {
            _adapters(m);
        } else if (phase == keccak256("executors")) {
            _executors(m);
        } else if (phase == keccak256("genesis")) {
            _genesis(m);
        } else if (phase == keccak256("all")) {
            _vaults(m);
            _adapters(m);
            _executors(m);
            _genesis(m);
            _verify(m);
        } else {
            revert("DeployStockVaults: PHASE must be plan | vaults | adapters | executors | genesis | verify | all");
        }
    }

    function _selected() internal view returns (Market[] memory sel) {
        Market[] memory m = markets();
        string memory only = vm.envOr("STOCK_ONLY", string(""));
        if (bytes(only).length == 0) return m;
        for (uint256 i; i < m.length; ++i) {
            if (keccak256(bytes(m[i].slug)) == keccak256(bytes(only))) {
                sel = new Market[](1);
                sel[0] = m[i];
                return sel;
            }
        }
        revert(string.concat("DeployStockVaults: unknown STOCK_ONLY slug ", only));
    }

    /*//////////////////////////////////////////////////////////////
                         LIVE RECON RE-CHECK (STOP rule)
    //////////////////////////////////////////////////////////////*/

    function _checkMarkets(Market[] memory m) internal view {
        for (uint256 i; i < m.length; ++i) {
            Market memory mk = m[i];
            string memory s = mk.slug;
            require(keccak256(abi.encode(_key(mk))) == mk.poolId, string.concat("RECON CONTRADICTION ", s, ": poolId"));
            uint160 h = uint160(mk.hooks);
            require(
                h & HOOK_PERMISSION_MASK == HOOK_FABLES_BITS && h & HOOK_FORBIDDEN_FLAGS == 0
                    && mk.hooks.code.length > 0,
                string.concat("RECON CONTRADICTION ", s, ": hook class")
            );
            (uint160 sqrtP,) = _v4Slot0(mk.poolId);
            require(sqrtP != 0, string.concat("RECON CONTRADICTION ", s, ": v4 pool not initialized"));
            IUniswapV3PoolMinimal ref = IUniswapV3PoolMinimal(mk.refPool);
            require(
                ref.token0() == mk.currency0 && ref.token1() == mk.currency1 && ref.fee() == mk.refFee
                    && IUniswapV3FactoryMinimal(V3_FACTORY).getPool(mk.currency0, mk.currency1, mk.refFee)
                        == mk.refPool,
                string.concat("RECON CONTRADICTION ", s, ": v3 reference")
            );
        }
        console2.log("recon re-check: OK for", m.length, "markets");
    }

    /// @dev slot0 straight from PoolManager storage (V4StateReader layout, as the recon probe).
    function _v4Slot0(bytes32 id) internal view returns (uint160 sqrtP, int24 tick) {
        bytes32 w = IPoolManagerMinimal(POOL_MANAGER).extsload(keccak256(abi.encodePacked(id, uint256(6))));
        sqrtP = uint160(uint256(w));
        tick = int24(uint24(uint256(w) >> 160));
    }

    /*//////////////////////////////////////////////////////////////
                                 PHASES
    //////////////////////////////////////////////////////////////*/

    function _plan(Market[] memory m) internal view {
        for (uint256 i; i < m.length; ++i) {
            VaultState memory st = _load(m[i]);
            bool live = st.vault.code.length > 0;
            uint256 adapters = live ? MySunVaultUpgradeable(st.vault).adapterCount() : 0;
            console2.log(
                string.concat(
                    m[i].slug,
                    " ",
                    m[i].symbol,
                    " vault ",
                    live ? vm.toString(st.vault) : "-",
                    " adapters ",
                    vm.toString(adapters),
                    " executor ",
                    st.planExecutor.code.length > 0 ? vm.toString(st.planExecutor) : "-",
                    " seeded ",
                    live && MySunVaultUpgradeable(st.vault).totalSupply() > 0 ? "yes" : "no"
                )
            );
        }
        _fundingReport(m);
    }

    function _vaults(Market[] memory m) internal {
        for (uint256 i; i < m.length; ++i) {
            Market memory mk = m[i];
            VaultState memory st = _load(mk);
            if (st.vault.code.length > 0) {
                _requireVaultIdentity(mk, st.vault);
                console2.log(string.concat("[vaults] ", mk.slug, " exists ", vm.toString(st.vault)));
                continue;
            }
            vm.startBroadcast(owner);
            if (st.depositSplit.code.length == 0) st.depositSplit = address(new DepositSplit());
            Options memory opts;
            opts.constructorData = abi.encode(st.depositSplit);
            st.vault = Upgrades.deployUUPSProxy(
                "MySunVaultUpgradeable.sol",
                abi.encodeCall(
                    MySunVaultUpgradeable(address(0)).initialize,
                    (owner, mk.symbol, mk.symbol, st.basket, owner, FEE_BPS, GENESIS_K, MAX_TOTAL_SUPPLY)
                ),
                opts
            );
            vm.stopBroadcast();
            st.implementation = Upgrades.getImplementationAddress(st.vault);
            _requireVaultIdentity(mk, st.vault);
            _save(mk, st);
            console2.log(string.concat("[vaults] ", mk.slug, " deployed ", vm.toString(st.vault)));
        }
    }

    function _adapters(Market[] memory m) internal {
        for (uint256 i; i < m.length; ++i) {
            Market memory mk = m[i];
            VaultState memory st = _load(mk);
            require(
                st.vault.code.length > 0, string.concat("DeployStockVaults: ", mk.slug, " vault missing - run vaults")
            );
            MySunVaultUpgradeable vault = MySunVaultUpgradeable(st.vault);
            st.adapters = _adapterSlots(mk, st);
            for (uint256 k; k < N_ADAPTERS; ++k) {
                address a = st.adapters[k];
                bool registered = a != address(0) && vault.isAdapter(a);
                if (registered) continue;
                vm.startBroadcast(owner);
                if (a.code.length == 0) a = _newAdapter(mk, st.vault);
                if (UniswapV4HookedAdapter(a).swapVenue() != UniswapV4HookedAdapter.SwapVenue.V4_POOL) {
                    UniswapV4HookedAdapter(a).setSwapVenue(UniswapV4HookedAdapter.SwapVenue.V4_POOL);
                }
                vault.addAdapter(IPositionAdapter(a));
                vm.stopBroadcast();
                st.adapters[k] = a;
                _requireAdapterConfig(mk, st.vault, a);
                _save(mk, st);
            }
            require(vault.adapterCount() == N_ADAPTERS, string.concat("DeployStockVaults: ", mk.slug, " adapterCount"));
            console2.log(string.concat("[adapters] ", mk.slug, " 6/6 registered"));
        }
    }

    /// @dev Slots = the vault's registered adapters (each must pass the config check), then any recorded-but-
    ///      unregistered adapter that has code (a broadcast that died between deploy and addAdapter), then empties.
    function _adapterSlots(Market memory mk, VaultState memory st) internal view returns (address[] memory slots) {
        slots = new address[](N_ADAPTERS);
        IPositionAdapter[] memory reg = MySunVaultUpgradeable(st.vault).adapters();
        require(reg.length <= N_ADAPTERS, string.concat("DeployStockVaults: ", mk.slug, " has > 6 adapters"));
        uint256 n;
        for (uint256 k; k < reg.length; ++k) {
            _requireAdapterConfig(mk, st.vault, address(reg[k]));
            slots[n++] = address(reg[k]);
        }
        for (uint256 k; k < st.adapters.length && n < N_ADAPTERS; ++k) {
            address a = st.adapters[k];
            if (a.code.length == 0 || MySunVaultUpgradeable(st.vault).isAdapter(a)) continue;
            _requireAdapterConfig(mk, st.vault, a);
            slots[n++] = a;
        }
    }

    function _newAdapter(Market memory mk, address vault) internal returns (address) {
        return address(
            new UniswapV4HookedAdapter(
                UniswapV4HookedAdapter.Config({
                    vault: vault,
                    positionManager: POSM,
                    poolKey: _key(mk),
                    refPool: mk.refPool,
                    swapRouter: UNIVERSAL_ROUTER,
                    swapExecutor: SWAP_EXECUTOR,
                    owner: owner,
                    rangeTicksBelow: RANGE,
                    rangeTicksAbove: RANGE,
                    twapWindow: TWAP_WINDOW,
                    maxSlippageBps: MAX_SLIPPAGE_BPS
                })
            )
        );
    }

    function _executors(Market[] memory m) internal {
        for (uint256 i; i < m.length; ++i) {
            Market memory mk = m[i];
            VaultState memory st = _load(mk);
            require(
                st.vault.code.length > 0, string.concat("DeployStockVaults: ", mk.slug, " vault missing - run vaults")
            );
            MySunVaultUpgradeable vault = MySunVaultUpgradeable(st.vault);
            vm.startBroadcast(owner);
            if (st.planExecutor.code.length == 0) {
                st.planExecutor = address(new PlanExecutor(IPoolmigoVault(st.vault), owner));
            }
            PlanExecutor pe = PlanExecutor(st.planExecutor);
            if (!pe.isKeeper(KEEPER)) pe.setKeeper(KEEPER, true);
            if (!vault.isKeeper(st.planExecutor)) vault.setKeeper(st.planExecutor, true);
            if (!vault.isKeeper(KEEPER)) vault.setKeeper(KEEPER, true);
            if (!PoolmigoZapIn(ZAP_IN).isVaultRegistered(st.vault)) PoolmigoZapIn(ZAP_IN).registerVault(st.vault);
            if (!PoolmigoZapOut(ZAP_OUT).isVaultRegistered(st.vault)) PoolmigoZapOut(ZAP_OUT).registerVault(st.vault);
            vm.stopBroadcast();
            require(
                address(pe.VAULT()) == st.vault && pe.owner() == owner,
                string.concat("DeployStockVaults: ", mk.slug, " executor binding")
            );
            _save(mk, st);
            console2.log(string.concat("[executors] ", mk.slug, " ", vm.toString(st.planExecutor), " wired + zaps"));
        }
    }

    function _genesis(Market[] memory m) internal {
        uint256 required = _fundingReport(m);
        uint256 held = IERC20(USDG).balanceOf(owner);
        require(
            held >= required,
            string.concat(
                "DeployStockVaults: signer USDG ",
                vm.toString(held),
                " < batch requirement ",
                vm.toString(required),
                " - fund it first (nothing spent)"
            )
        );
        for (uint256 i; i < m.length; ++i) {
            Market memory mk = m[i];
            VaultState memory st = _load(mk);
            require(
                st.vault.code.length > 0, string.concat("DeployStockVaults: ", mk.slug, " vault missing - run vaults")
            );
            MySunVaultUpgradeable vault = MySunVaultUpgradeable(st.vault);
            if (vault.totalSupply() > 0) {
                console2.log(string.concat("[genesis] ", mk.slug, " already seeded"));
                continue;
            }
            require(
                vault.owner() == owner && vault.genesisShares() == GENESIS_K, "DeployStockVaults: genesis preconditions"
            );
            uint256[] memory amounts = _legAmounts(st.basket);
            vm.startBroadcast(owner);
            for (uint256 j; j < amounts.length; ++j) {
                _buyShortfall(st.basket[j], amounts[j]);
                IERC20(st.basket[j]).forceApprove(st.vault, amounts[j]);
            }
            vault.deposit(st.basket, amounts, GENESIS_K, owner); // owner-gated genesis: mints exactly K
            vm.stopBroadcast();
            require(vault.totalSupply() == GENESIS_K, "DeployStockVaults: supply != K");
            st.genesis = amounts;
            _save(mk, st);
            console2.log(string.concat("[genesis] ", mk.slug, " seeded, idle legs:"));
            for (uint256 j; j < amounts.length; ++j) {
                console2.log("   ", st.basket[j], amounts[j]);
            }
        }
    }

    /// @dev ≈ $1 of each leg at the leg's USDG v3 ref spot (USDG itself: exactly 1e6).
    function _legAmounts(address[] memory basket) internal view returns (uint256[] memory a) {
        a = new uint256[](basket.length);
        for (uint256 j; j < basket.length; ++j) {
            a[j] = basket[j] == USDG ? LEG_USDG : _usdgToToken(basket[j], LEG_USDG);
        }
    }

    /// @dev Buy only what the signer lacks: (need's USDG value) × (1 + buffer) in, `need` as the exact min-out.
    function _buyShortfall(address token, uint256 amount) internal {
        if (token == USDG) return;
        uint256 bal = IERC20(token).balanceOf(owner);
        if (bal >= amount) return;
        uint256 need = amount - bal;
        uint256 usdgIn = _buyCost(token, need);
        (, uint24 fee) = _usdgRef(token);
        IERC20(USDG).forceApprove(SWAP_EXECUTOR, usdgIn);
        ISwapExecutor(SWAP_EXECUTOR).swapV3ExactIn(USDG, fee, token, usdgIn, need);
    }

    function _buyCost(address token, uint256 need) internal view returns (uint256) {
        return Math.mulDiv(_tokenToUsdg(token, need), 10_000 + BUY_BUFFER_BPS, 10_000) + 1;
    }

    /// @dev USDG the signer needs for every UNSEEDED selected vault: USDG legs + the buy cost of each stock token's
    ///      aggregate shortfall vs the signer's current balance (SPY / NVDA serve two vaults). Logs the breakdown.
    function _fundingReport(Market[] memory m) internal view returns (uint256 required) {
        address[] memory toks = new address[](2 * m.length);
        uint256[] memory need = new uint256[](2 * m.length);
        uint256 n;
        uint256 usdgLegs;
        uint256 unseeded;
        for (uint256 i; i < m.length; ++i) {
            VaultState memory st = _load(m[i]);
            if (st.vault.code.length > 0 && MySunVaultUpgradeable(st.vault).totalSupply() > 0) continue;
            ++unseeded;
            uint256[] memory a = _legAmounts(st.basket);
            for (uint256 j; j < a.length; ++j) {
                if (st.basket[j] == USDG) {
                    usdgLegs += a[j];
                    continue;
                }
                uint256 k;
                while (k < n && toks[k] != st.basket[j]) ++k;
                if (k == n) toks[n++] = st.basket[j];
                need[k] += a[j];
            }
        }
        uint256 buys;
        for (uint256 k; k < n; ++k) {
            uint256 bal = IERC20(toks[k]).balanceOf(owner);
            uint256 cost = bal >= need[k] ? 0 : _buyCost(toks[k], need[k] - bal);
            buys += cost;
            console2.log(
                string.concat(
                    "  leg token ",
                    vm.toString(toks[k]),
                    " need ",
                    vm.toString(need[k]),
                    " held ",
                    vm.toString(bal),
                    " buy cost (USDG raw) ",
                    vm.toString(cost)
                )
            );
        }
        required = usdgLegs + buys;
        console2.log("== genesis funding (unseeded vaults):", unseeded);
        console2.log("  USDG legs (raw)      :", usdgLegs);
        console2.log("  USDG for buys (raw)  :", buys);
        console2.log("  USDG required (raw)  :", required);
        console2.log("  signer USDG (raw)    :", IERC20(USDG).balanceOf(owner));
        console2.log("  signer ETH (wei)     :", owner.balance);
    }

    /*//////////////////////////////////////////////////////////////
                                  VERIFY
    //////////////////////////////////////////////////////////////*/

    function _verify(Market[] memory m) internal view {
        uint256 failed;
        console2.log("== verify ==");
        for (uint256 i; i < m.length; ++i) {
            string memory err = _verifyVault(m[i]);
            if (bytes(err).length == 0) {
                console2.log(string.concat("[OK]   ", m[i].slug));
            } else {
                ++failed;
                console2.log(string.concat("[FAIL] ", m[i].slug, ": ", err));
            }
        }
        console2.log("vaults verified:", m.length, "| failed:", failed);
        require(failed == 0, "DeployStockVaults: verify FAILED (see [FAIL] lines)");
    }

    function _verifyVault(Market memory mk) internal view returns (string memory) {
        VaultState memory st = _load(mk);
        if (st.vault.code.length == 0) return "vault not deployed";
        MySunVaultUpgradeable vault = MySunVaultUpgradeable(st.vault);
        // identity
        if (keccak256(bytes(vault.name())) != keccak256(bytes(mk.symbol))) return "receipt name";
        if (keccak256(bytes(vault.symbol())) != keccak256(bytes(mk.symbol))) return "receipt symbol";
        if (keccak256(abi.encode(vault.tokens())) != keccak256(abi.encode(st.basket))) return "basket";
        if (vault.owner() != owner || vault.treasury() != owner) return "owner / treasury";
        if (vault.performanceFeeBps() != FEE_BPS || vault.maxTotalSupply() != MAX_TOTAL_SUPPLY) return "fee / cap";
        if (vault.genesisShares() != GENESIS_K || vault.paused()) return "K / paused";
        if (Upgrades.getImplementationAddress(st.vault) != st.implementation) return "implementation slot";
        console2.log(
            string.concat(
                "  ",
                mk.slug,
                " vault ",
                vm.toString(st.vault),
                " name=symbol=",
                vault.symbol(),
                " impl ",
                vm.toString(st.implementation)
            )
        );
        // adapters: 6 registered, config, caps derived, EMPTY
        IPositionAdapter[] memory reg = vault.adapters();
        if (reg.length != N_ADAPTERS) return "adapterCount != 6";
        for (uint256 k; k < reg.length; ++k) {
            address a = address(reg[k]);
            if (!_adapterConfigOk(mk, st.vault, a)) return string.concat("adapter config ", vm.toString(a));
            if (vault.adapterCapabilities(reg[k]) != CAPS_ALL) return string.concat("adapter caps ", vm.toString(a));
            (, uint256[] memory pos) = reg[k].position();
            for (uint256 j; j < pos.length; ++j) {
                if (pos[j] != 0) return string.concat("adapter NOT empty ", vm.toString(a));
            }
            if (IERC20(mk.currency0).balanceOf(a) != 0 || IERC20(mk.currency1).balanceOf(a) != 0) {
                return string.concat("adapter holds tokens ", vm.toString(a));
            }
            console2.log(string.concat("    adapter ", vm.toString(k), " ", vm.toString(a), " caps 3, position 0/0"));
        }
        // keepers + executor + zaps
        PlanExecutor pe = PlanExecutor(st.planExecutor);
        if (st.planExecutor.code.length == 0) return "plan executor missing";
        if (address(pe.VAULT()) != st.vault || pe.owner() != owner) return "plan executor binding";
        if (!pe.isKeeper(KEEPER)) return "keeper not whitelisted on the executor";
        if (!vault.isKeeper(st.planExecutor)) return "executor is not a vault keeper";
        if (!vault.isKeeper(KEEPER)) return "keeper is not a vault keeper";
        if (vault.isKeeper(owner) && owner != KEEPER) return "owner unexpectedly a vault keeper";
        if (!PoolmigoZapIn(ZAP_IN).isVaultRegistered(st.vault)) return "zapIn not registered";
        if (!PoolmigoZapOut(ZAP_OUT).isVaultRegistered(st.vault)) return "zapOut not registered";
        console2.log(
            string.concat(
                "    executor ",
                vm.toString(st.planExecutor),
                " keeper ",
                vm.toString(KEEPER),
                " | zapIn+zapOut registered"
            )
        );
        // genesis: supply K, idle == total == recorded legs, each leg ≈ $1
        if (vault.totalSupply() != GENESIS_K || vault.balanceOf(owner) != GENESIS_K) {
            return "supply / owner shares != K";
        }
        (address[] memory t, uint256[] memory totals) = vault.totalTokens();
        for (uint256 j; j < t.length; ++j) {
            uint256 idle = IERC20(t[j]).balanceOf(st.vault);
            if (idle != totals[j]) return "idle != totalTokens (something left the vault)";
            if (st.genesis.length != t.length || idle != st.genesis[j]) return "idle != recorded genesis";
            uint256 usd = t[j] == USDG ? idle : _tokenToUsdg(t[j], idle);
            uint256 tol = LEG_USDG * LEG_TOLERANCE_BPS / 10_000;
            if (usd + tol < LEG_USDG || usd > LEG_USDG + tol) return string.concat("leg not ~$1: ", vm.toString(t[j]));
            console2.log(
                string.concat(
                    "    leg ", vm.toString(t[j]), " idle ", vm.toString(idle), " ~USDG(raw) ", vm.toString(usd)
                )
            );
        }
        console2.log(string.concat("    supply ", vm.toString(vault.totalSupply()), " (K) held by owner"));
        return "";
    }

    function _requireVaultIdentity(Market memory mk, address vault) internal view {
        MySunVaultUpgradeable v = MySunVaultUpgradeable(vault);
        require(
            keccak256(bytes(v.symbol())) == keccak256(bytes(mk.symbol))
                && keccak256(bytes(v.name())) == keccak256(bytes(mk.symbol))
                && keccak256(abi.encode(v.tokens())) == keccak256(abi.encode(_basket(mk))) && v.owner() == owner,
            string.concat("DeployStockVaults: ", mk.slug, " vault identity mismatch")
        );
    }

    function _requireAdapterConfig(Market memory mk, address vault, address a) internal view {
        require(
            _adapterConfigOk(mk, vault, a),
            string.concat("DeployStockVaults: ", mk.slug, " adapter config ", vm.toString(a))
        );
    }

    function _adapterConfigOk(Market memory mk, address vault, address a) internal view returns (bool) {
        UniswapV4HookedAdapter x = UniswapV4HookedAdapter(a);
        return x.VAULT() == vault && x.owner() == owner && x.poolId() == mk.poolId && x.HOOKS() == mk.hooks
            && address(x.REF_POOL()) == mk.refPool && address(x.SWAP_EXECUTOR()) == SWAP_EXECUTOR
            && address(x.POSITION_MANAGER()) == POSM && x.rangeTicksBelow() == RANGE && x.rangeTicksAbove() == RANGE
            && x.twapWindow() == TWAP_WINDOW && x.maxSlippageBps() == MAX_SLIPPAGE_BPS
            && x.swapVenue() == UniswapV4HookedAdapter.SwapVenue.V4_POOL;
    }

    /*//////////////////////////////////////////////////////////////
                         PRICING (script-side display only)
    //////////////////////////////////////////////////////////////*/

    function _refSqrt(address token) internal view returns (address pool, uint160 sqrtP) {
        (pool,) = _usdgRef(token);
        (sqrtP,,,,,,) = IUniswapV3PoolMinimal(pool).slot0();
    }

    function _usdgToToken(address token, uint256 usdg) internal view returns (uint256) {
        (address pool, uint160 sqrtP) = _refSqrt(token);
        if (IUniswapV3PoolMinimal(pool).token0() == USDG) {
            return Math.mulDiv(Math.mulDiv(usdg, sqrtP, Q96), sqrtP, Q96);
        }
        return Math.mulDiv(Math.mulDiv(usdg, Q96, sqrtP), Q96, sqrtP);
    }

    function _tokenToUsdg(address token, uint256 amount) internal view returns (uint256) {
        (address pool, uint160 sqrtP) = _refSqrt(token);
        if (IUniswapV3PoolMinimal(pool).token0() == USDG) {
            return Math.mulDiv(Math.mulDiv(amount, Q96, sqrtP), Q96, sqrtP);
        }
        return Math.mulDiv(Math.mulDiv(amount, sqrtP, Q96), sqrtP, Q96);
    }

    /*//////////////////////////////////////////////////////////////
                               STATE FILE
    //////////////////////////////////////////////////////////////*/

    function _isDryRun() internal view returns (bool) {
        return vm.isContext(VmSafe.ForgeContext.ScriptDryRun);
    }

    function _statePath(Market memory mk, bool dry) internal view returns (string memory) {
        string memory label = vm.envOr("STOCK_LABEL", string("mainnet"));
        if (dry) label = string.concat(label, "-dryrun");
        return string.concat(
            vm.projectRoot(), "/broadcast/stock-vaults/", label, "-", vm.toString(block.chainid), "-", mk.slug, ".json"
        );
    }

    /// @dev A dry run prefers its own `-dryrun` file and falls back to the real one; no file = a fresh state.
    function _load(Market memory mk) internal view returns (VaultState memory st) {
        st.basket = _basket(mk);
        st.adapters = new address[](N_ADAPTERS);
        string memory path = _statePath(mk, false);
        if (_isDryRun() && vm.exists(_statePath(mk, true))) path = _statePath(mk, true);
        if (!vm.exists(path)) return st;
        string memory json = vm.readFile(path);
        require(vm.parseJsonUint(json, ".chainId") == block.chainid, "DeployStockVaults: state file chainId");
        require(vm.parseJsonAddress(json, ".owner") == owner, "DeployStockVaults: state file owner != OWNER");
        st.vault = vm.parseJsonAddress(json, ".vault");
        st.depositSplit = vm.parseJsonAddress(json, ".depositSplit");
        st.implementation = vm.parseJsonAddress(json, ".implementation");
        st.planExecutor = vm.parseJsonAddress(json, ".planExecutor");
        address[] memory a = vm.parseJsonAddressArray(json, ".adapters");
        for (uint256 k; k < a.length && k < N_ADAPTERS; ++k) {
            st.adapters[k] = a[k];
        }
        st.genesis = vm.parseJsonUintArray(json, ".genesis");
    }

    function _save(Market memory mk, VaultState memory st) internal {
        vm.createDir(string.concat(vm.projectRoot(), "/broadcast/stock-vaults"), true);
        string memory obj = string.concat(OBJ, mk.slug);
        vm.serializeString(obj, "slug", mk.slug);
        vm.serializeString(obj, "symbol", mk.symbol);
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeAddress(obj, "owner", owner);
        vm.serializeAddress(obj, "keeper", KEEPER);
        vm.serializeAddress(obj, "vault", st.vault);
        vm.serializeAddress(obj, "depositSplit", st.depositSplit);
        vm.serializeAddress(obj, "implementation", st.implementation);
        vm.serializeAddress(obj, "planExecutor", st.planExecutor);
        vm.serializeAddress(obj, "adapters", st.adapters);
        vm.serializeAddress(obj, "basket", st.basket);
        vm.serializeBytes32(obj, "poolId", mk.poolId);
        vm.serializeAddress(obj, "hooks", mk.hooks);
        vm.serializeAddress(obj, "refPool", mk.refPool);
        vm.serializeUint(obj, "genesisShares", GENESIS_K);
        string memory json = vm.serializeUint(obj, "genesis", st.genesis);
        vm.writeJson(json, _statePath(mk, _isDryRun()));
    }
}
