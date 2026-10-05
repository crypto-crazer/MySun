// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import {Test} from "forge-std/Test.sol";
import {Upgrades} from "openzeppelin-foundry-upgrades/Upgrades.sol";

import {MySunVaultUpgradeable} from "contracts/MySunVaultUpgradeable.sol";
import {IPositionAdapter} from "contracts/interfaces/IPositionAdapter.sol";
import {UniswapV3Adapter} from "contracts/adapters/UniswapV3Adapter.sol";
import {UniswapV4Adapter} from "contracts/adapters/UniswapV4Adapter.sol";
import {IUniversalRouter} from "contracts/adapters/uniswap/IUniversalRouter.sol";
import {UniversalRouterSwapExecutor} from "contracts/swap/UniversalRouterSwapExecutor.sol";
import {MockToken} from "test/mocks/MockToken.sol";
import {MockV3Factory, MockV3Pool} from "test/mocks/MockV3Pool.sol";
import {MockPermit2Router} from "test/mocks/MockPermit2Router.sol";
import {DeployAdapters} from "../script/DeployAdapters.s.sol";

/// @dev Minimal v4 venue for the v4 adapter's constructor checks: it is its own PoolManager (`poolManager()` = this),
///      reports `permit2`, and answers every `extsload` with sqrtPriceX96 = 2^96 (every pool initialized at price 1).
contract MockV4Venue {
    address public immutable permit2;

    constructor(address permit2_) {
        permit2 = permit2_;
    }

    function poolManager() external view returns (address) {
        return address(this);
    }

    function extsload(bytes32) external pure returns (bytes32) {
        return bytes32(uint256(1 << 96));
    }
}

/**
 * @notice `script/DeployAdapters.s.sol` on the local mock venue (MockV3Pool / MockPermit2Router as UR + Permit2 /
 *         {MockV4Venue}): the default run deploys + registers v3 AND v4; `DEPLOY_V4=false` deploys + registers v3
 *         only (no v4 construction — the v4 wiring is deliberately unusable there), returns `address(0)` for v4,
 *         and keeps the executor deploy/reuse and the keeper setup. Broadcast tx counts = deployer nonce deltas.
 *         The suite IS the script: it calls `_deploy` internally, so msg.sender = tx.origin = the broadcaster (the
 *         test's caller), exactly as `forge script --sender` (a prank cannot be combined with `startBroadcast`).
 *         Deploys take explicit {Params}; only {test_Env_DeployV4_DefaultTrue_V3OnlyIgnoresV4Fields} touches process
 *         env (tests run in parallel) — run the suite under `env -u DEPLOY_V4`.
 */
contract DeployAdaptersScriptTest is Test, DeployAdapters {
    MySunVaultUpgradeable internal vault;
    MockToken internal tA;
    MockToken internal tB;
    MockV3Factory internal factory;
    MockPermit2Router internal router;
    MockV3Pool internal pool;
    MockV4Venue internal v4Venue;

    address internal deployer;
    address internal keeper = makeAddr("keeper");
    address internal treasury = makeAddr("treasury");

    function setUp() public {
        deployer = msg.sender;
        assertEq(tx.origin, deployer, "broadcaster = caller");
        tA = new MockToken("Token A", "TKA", 18);
        tB = new MockToken("Token B", "TKB", 18);
        address[] memory basket = new address[](2);
        basket[0] = address(tA);
        basket[1] = address(tB);
        vault = MySunVaultUpgradeable(
            Upgrades.deployUUPSProxy(
                "MySunVaultUpgradeable.sol",
                abi.encodeCall(
                    MySunVaultUpgradeable(address(0)).initialize,
                    (deployer, "sunEthLP", "sunEthLP", basket, treasury, uint16(1000), 1_000e18, uint256(0))
                )
            )
        );

        factory = new MockV3Factory();
        router = new MockPermit2Router(factory);
        pool = new MockV3Pool(address(factory), address(tA), address(tB), 100, uint160(1 << 96), 1e24);
        factory.register(pool);
        v4Venue = new MockV4Venue(address(router));
    }

    /*//////////////////////////////////////////////////////////////
                          DEFAULT: v3 + v4 (unchanged)
    //////////////////////////////////////////////////////////////*/

    function test_Default_DeploysAndRegistersBoth() public {
        _wireV4Router();
        uint256 nonce0 = vm.getNonce(deployer);

        (address a3, address a4) = _deploy(_params(true, address(0), keeper));

        assertTrue(a3 != address(0) && a3.code.length > 0, "v3 deployed");
        assertTrue(a4 != address(0) && a4.code.length > 0, "v4 deployed");
        IPositionAdapter[] memory list = vault.adapters();
        assertEq(list.length, 2, "two adapters registered");
        assertEq(address(list[0]), a3, "v3 first");
        assertEq(address(list[1]), a4, "v4 second");
        assertTrue(vault.isKeeper(keeper), "keeper enabled");
        // executor + v3 + v4 + addAdapter x2 + setKeeper
        assertEq(vm.getNonce(deployer) - nonce0, 6, "broadcast txs");

        UniswapV3Adapter v3 = UniswapV3Adapter(a3);
        UniswapV4Adapter v4 = UniswapV4Adapter(a4);
        assertEq(v3.VAULT(), address(vault));
        assertEq(v4.VAULT(), address(vault));
        assertEq(address(v4.POSITION_MANAGER()), address(v4Venue));
        assertEq(address(v4.REF_POOL()), address(pool));
        assertEq(address(v3.SWAP_EXECUTOR()), address(v4.SWAP_EXECUTOR()), "one shared executor");
        assertEq(v3.owner(), deployer);
        assertEq(v4.owner(), deployer);
    }

    /*//////////////////////////////////////////////////////////////
                           DEPLOY_V4=false: v3 only
    //////////////////////////////////////////////////////////////*/

    /// @dev The v4 wiring is unusable here (POSM has no code, the router reports no PoolManager): any v4 construction
    ///      would revert, so a green run proves none was attempted.
    function test_V3Only_DeploysAndRegistersOnlyV3() public {
        uint256 nonce0 = vm.getNonce(deployer);
        Params memory p = _params(false, address(0), keeper);
        p.posm = makeAddr("noV4PositionManager");

        (address a3, address a4) = _deploy(p);

        assertTrue(a3 != address(0) && a3.code.length > 0, "v3 deployed");
        assertEq(a4, address(0), "no v4 adapter");
        IPositionAdapter[] memory list = vault.adapters();
        assertEq(list.length, 1, "only v3 registered");
        assertEq(address(list[0]), a3);
        assertTrue(vault.isAdapter(a3));
        assertTrue(vault.isKeeper(keeper), "keeper enabled");
        // executor + v3 + addAdapter + setKeeper
        assertEq(vm.getNonce(deployer) - nonce0, 4, "broadcast txs");

        UniswapV3Adapter v3 = UniswapV3Adapter(a3);
        assertEq(v3.VAULT(), address(vault));
        assertEq(address(v3.POOL()), address(pool));
        assertEq(v3.owner(), deployer);
        UniversalRouterSwapExecutor exec = UniversalRouterSwapExecutor(address(v3.SWAP_EXECUTOR()));
        assertEq(exec.UNIVERSAL_ROUTER(), address(router));
        assertEq(exec.PERMIT2(), address(router));
    }

    function test_V3Only_ReusesExecutor_NoKeeper() public {
        UniversalRouterSwapExecutor exec = new UniversalRouterSwapExecutor(address(router), address(router));
        uint256 nonce0 = vm.getNonce(deployer);

        (address a3, address a4) = _deploy(_params(false, address(exec), address(0)));

        assertEq(a4, address(0));
        assertEq(address(UniswapV3Adapter(a3).SWAP_EXECUTOR()), address(exec), "executor reused");
        assertEq(vault.adapters().length, 1);
        assertFalse(vault.isKeeper(keeper));
        // v3 + addAdapter
        assertEq(vm.getNonce(deployer) - nonce0, 2, "broadcast txs");
    }

    /// @dev Broadcaster does not own the vault: v3 is deployed, nothing is registered (the calls are printed instead).
    function test_V3Only_VaultNotOwned_DeploysWithoutRegistering() public {
        address multisig = makeAddr("multisig");
        vm.prank(deployer);
        vault.transferOwnership(multisig);
        vm.prank(multisig);
        vault.acceptOwnership(); // Ownable2Step
        uint256 nonce0 = vm.getNonce(deployer);

        (address a3, address a4) = _deploy(_params(false, address(0), keeper));

        assertTrue(a3.code.length > 0, "v3 deployed");
        assertEq(a4, address(0));
        assertEq(vault.adapters().length, 0, "nothing registered");
        assertFalse(vault.isKeeper(keeper));
        // executor + v3
        assertEq(vm.getNonce(deployer) - nonce0, 2, "broadcast txs");
    }

    /*//////////////////////////////////////////////////////////////
                                ENV PARSING
    //////////////////////////////////////////////////////////////*/

    /// @dev The ONLY test that touches process env (tests run in parallel), so every step runs in sequence here. Every
    ///      variable the script reads is pinned first (host values never leak in) — except DEPLOY_V4, which cannot be
    ///      unset from inside a test: run under `env -u DEPLOY_V4`. Steps: unset → true (default unchanged, v4-only
    ///      fields read); "false" + MALFORMED WETH / USDG / POSM → parses, v4-only fields stay zero (never read), v3
    ///      settings still parsed; "true" + the same malformed values → read again (`envOr` → the defaults); "true" +
    ///      valid overrides → read.
    function test_Env_DeployV4_DefaultTrue_V3OnlyIgnoresV4Fields() public {
        address owner_ = makeAddr("envOwner");
        address ur_ = makeAddr("envUr");
        address permit2_ = makeAddr("envPermit2");
        address pool_ = makeAddr("envPool");
        address nfpm_ = makeAddr("envNfpm");
        address executor_ = makeAddr("envExecutor");
        vm.setEnv("VAULT", vm.toString(address(vault)));
        vm.setEnv("OWNER", vm.toString(owner_));
        vm.setEnv("KEEPER", vm.toString(keeper));
        vm.setEnv("UR", vm.toString(ur_));
        vm.setEnv("PERMIT2", vm.toString(permit2_));
        vm.setEnv("POOL", vm.toString(pool_));
        vm.setEnv("NFPM", vm.toString(nfpm_));
        vm.setEnv("SWAP_EXECUTOR", vm.toString(executor_));
        vm.setEnv("WETH", vm.toString(address(tA)));
        vm.setEnv("USDG", vm.toString(address(tB)));
        vm.setEnv("POSM", vm.toString(address(v4Venue)));

        // unset → default true
        assertFalse(vm.envExists("DEPLOY_V4"), "DEPLOY_V4 must be unset for this test: run under `env -u DEPLOY_V4`");
        Params memory p = _paramsFromEnv();
        assertTrue(p.deployV4, "unset: v4 deployed (default)");
        _assertV3Settings(p, owner_, ur_, permit2_, pool_, nfpm_, executor_);
        assertEq(p.weth, address(tA), "unset: WETH read");
        assertEq(p.usdg, address(tB), "unset: USDG read");
        assertEq(p.posm, address(v4Venue), "unset: POSM read");

        // false → v4-only fields never read (malformed values cannot block a v3-only run)
        vm.setEnv("WETH", "not-an-address");
        vm.setEnv("USDG", "0x1234");
        vm.setEnv("POSM", "0xZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ");
        vm.setEnv("DEPLOY_V4", "false");
        p = _paramsFromEnv();
        assertFalse(p.deployV4, "DEPLOY_V4=false");
        _assertV3Settings(p, owner_, ur_, permit2_, pool_, nfpm_, executor_);
        assertEq(p.weth, address(0), "false: WETH unread");
        assertEq(p.usdg, address(0), "false: USDG unread");
        assertEq(p.posm, address(0), "false: POSM unread");

        // true → the v4-only fields ARE read again (`envOr` falls back to the RHC defaults on unparseable values)
        vm.setEnv("DEPLOY_V4", "true");
        p = _paramsFromEnv();
        assertTrue(p.deployV4, "DEPLOY_V4=true");
        assertEq(p.weth, DEFAULT_WETH, "true + malformed: WETH read (default)");
        assertEq(p.usdg, DEFAULT_USDG, "true + malformed: USDG read (default)");
        assertEq(p.posm, DEFAULT_POSM, "true + malformed: POSM read (default)");

        vm.setEnv("WETH", vm.toString(address(tB)));
        vm.setEnv("USDG", vm.toString(address(tA)));
        vm.setEnv("POSM", vm.toString(address(router)));
        p = _paramsFromEnv();
        assertTrue(p.deployV4, "DEPLOY_V4=true");
        _assertV3Settings(p, owner_, ur_, permit2_, pool_, nfpm_, executor_);
        assertEq(p.weth, address(tB), "true: WETH read");
        assertEq(p.usdg, address(tA), "true: USDG read");
        assertEq(p.posm, address(router), "true: POSM read");
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    function _params(bool deployV4, address executor, address keeper_) internal view returns (Params memory p) {
        p.vault = address(vault);
        p.owner = deployer;
        p.keeper = keeper_;
        p.ur = address(router);
        p.permit2 = address(router);
        p.weth = pool.token0(); // v4 key order: currency0 < currency1, matching the ref pool
        p.usdg = pool.token1();
        p.pool = address(pool);
        p.nfpm = address(factory); // MockV3Factory.factory() == itself: the NFPM anchor
        p.posm = address(v4Venue);
        p.executor = executor;
        p.deployV4 = deployV4;
    }

    function _assertV3Settings(
        Params memory p,
        address owner_,
        address ur_,
        address permit2_,
        address pool_,
        address nfpm_,
        address executor_
    ) internal view {
        assertEq(p.vault, address(vault), "VAULT");
        assertEq(p.owner, owner_, "OWNER");
        assertEq(p.keeper, keeper, "KEEPER");
        assertEq(p.ur, ur_, "UR");
        assertEq(p.permit2, permit2_, "PERMIT2");
        assertEq(p.pool, pool_, "POOL");
        assertEq(p.nfpm, nfpm_, "NFPM");
        assertEq(p.executor, executor_, "SWAP_EXECUTOR");
    }

    /// @dev The v4 adapter requires its router to serve the PoolManager; the mock router reports none by default.
    function _wireV4Router() internal {
        vm.mockCall(address(router), abi.encodeCall(IUniversalRouter.poolManager, ()), abi.encode(address(v4Venue)));
    }
}
