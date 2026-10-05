// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import {Test, Vm} from "forge-std/Test.sol";
import {Upgrades} from "openzeppelin-foundry-upgrades/Upgrades.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

import {MySunVaultUpgradeable} from "contracts/MySunVaultUpgradeable.sol";
import {IPoolmigoVault} from "contracts/interfaces/IPoolmigoVault.sol";
import {IPositionAdapter} from "contracts/interfaces/IPositionAdapter.sol";
import {ILiquidityAdapter} from "contracts/interfaces/ILiquidityAdapter.sol";
import {ISwapAdapter} from "contracts/interfaces/ISwapAdapter.sol";
import {ISwapExecutor} from "contracts/interfaces/ISwapExecutor.sol";
import {UniswapV3Adapter} from "contracts/adapters/UniswapV3Adapter.sol";
import {UniversalRouterSwapExecutor} from "contracts/swap/UniversalRouterSwapExecutor.sol";
import {MockToken} from "test/mocks/MockToken.sol";
import {MockPositionAdapter} from "test/mocks/MockPositionAdapter.sol";
import {MockLiquidityAdapter} from "test/mocks/MockLiquidityAdapter.sol";
import {MockSwapAdapter} from "test/mocks/MockSwapAdapter.sol";
import {MockV3Factory, MockV3Pool} from "test/mocks/MockV3Pool.sol";
import {MockPermit2Router} from "test/mocks/MockPermit2Router.sol";

/// @dev A position adapter whose `supportsInterface` exists but REVERTS — must derive to mask 0, never block addAdapter.
contract RevertingErc165Adapter is MockPositionAdapter {
    constructor(address[] memory tokens_, address vault_) MockPositionAdapter(tokens_, vault_, "RV", bytes32(0)) {}

    function supportsInterface(bytes4) external pure returns (bool) {
        revert("nope");
    }
}

/// @dev A position adapter whose `supportsInterface` answers `false` for everything (ERC-165 present, no capability).
contract NoCapsErc165Adapter is MockPositionAdapter {
    constructor(address[] memory tokens_, address vault_) MockPositionAdapter(tokens_, vault_, "NC", bytes32(0)) {}

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == type(IERC165).interfaceId;
    }
}

/**
 * @notice Strategy layer P3 — unit coverage of the vault side and of the REAL v3 adapter's new surface on the mock venue
 *         (MockV3Pool / MockPermit2Router / the real UniversalRouterSwapExecutor):
 *         - capability bits: ERC-165 derivation at `addAdapter` (ERC-165 and non-ERC-165 adapters), owner toggle
 *           (bad bit, cannot enable unsupported, disable path), wrapper enforcement (`__CapabilityMissing`);
 *         - the vault `swapExactIn` wrapper against {MockSwapAdapter} (exact approval, reset to 0, gating, min-out
 *           belt) and end to end through the real v3 adapter (output in the vault, both floors, guards);
 *         - `positionState()` (zeros + `configVersion` bumps on every owner setter) and ERC-165 on the v3 adapter.
 *         The v4 adapter has no unit venue: its P3 surface is covered in `test/fork/UniswapV4Adapter.fork.t.sol`.
 */
contract StrategyP3Test is Test {
    MySunVaultUpgradeable internal vault;
    MockToken internal tA;
    MockToken internal tB;
    MockV3Factory internal factory;
    MockPermit2Router internal router;
    UniversalRouterSwapExecutor internal executor;
    MockV3Pool internal pool;
    UniswapV3Adapter internal v3; // real adapter, mock venue, tick spacing 60, spot = TWAP = tick 0 (price 1)
    MockLiquidityAdapter internal mla; // CAP_LIQUIDITY only
    MockSwapAdapter internal msa; // CAP_LIQUIDITY | CAP_SWAP

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal keeper = makeAddr("keeper");
    address internal alice = makeAddr("alice");

    uint256 internal constant GENESIS = 1_000e18;
    uint256 internal constant SEED = 1_000e18;
    int24 internal constant SPACING = 60;
    uint32 internal constant TWAP_WINDOW = 1800;
    uint16 internal constant MAX_SLIPPAGE_BPS = 100;
    uint256 internal constant BPS = 10_000;
    uint8 internal constant CAP_LIQUIDITY = 1;
    uint8 internal constant CAP_SWAP = 2;

    address[] internal basket;
    IERC20 internal token0; // v3's pool order
    IERC20 internal token1;

    function setUp() public {
        tA = new MockToken("Token A", "TKA", 18);
        tB = new MockToken("Token B", "TKB", 18);
        basket.push(address(tA));
        basket.push(address(tB));
        vault = MySunVaultUpgradeable(
            Upgrades.deployUUPSProxy(
                "MySunVaultUpgradeable.sol",
                abi.encodeCall(
                    MySunVaultUpgradeable(address(0)).initialize,
                    (owner, "sunEthLP", "sunEthLP", basket, treasury, uint16(1500), GENESIS, uint256(0))
                )
            )
        );

        factory = new MockV3Factory();
        router = new MockPermit2Router(factory);
        executor = new UniversalRouterSwapExecutor(address(router), address(router));
        pool = new MockV3Pool(address(factory), address(tA), address(tB), 3000, uint160(1 << 96), 1e24); // tick 0
        pool.setTickSpacing(SPACING);
        factory.register(pool);
        v3 = _newAdapter(pool);
        token0 = v3.TOKEN0();
        token1 = v3.TOKEN1();
        mla = new MockLiquidityAdapter(basket, address(vault), keccak256("MOCK_LIQ"), bytes32(uint256(7)));
        msa = new MockSwapAdapter(basket, address(vault), keccak256("MOCK_SWAP"), bytes32(uint256(8)));

        vm.startPrank(owner);
        vault.addAdapter(IPositionAdapter(address(v3)));
        vault.addAdapter(IPositionAdapter(address(mla)));
        vault.addAdapter(IPositionAdapter(address(msa)));
        vault.setKeeper(keeper, true);
        tA.mint(owner, SEED);
        tB.mint(owner, SEED);
        tA.approve(address(vault), SEED);
        tB.approve(address(vault), SEED);
        vault.deposit(basket, _pair(SEED, SEED), GENESIS, owner);
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                  VAULT: CAPABILITY BITS (DERIVED, TOGGLED)
    //////////////////////////////////////////////////////////////*/

    function test_Capabilities_Constants() public view {
        assertEq(vault.CAP_LIQUIDITY(), CAP_LIQUIDITY);
        assertEq(vault.CAP_SWAP(), CAP_SWAP);
    }

    /// @dev The mask comes from the adapter's own ERC-165 answers: both real-adapter interfaces → 3, liquidity-only
    ///      mock → 1, a plain (non-ERC-165) adapter → 0, a reverting or all-false `supportsInterface` → 0 — and none
    ///      of them blocks registration. Each derivation is announced.
    function test_Capabilities_DerivedAtAddAdapter() public {
        assertEq(vault.adapterCapabilities(IPositionAdapter(address(v3))), CAP_LIQUIDITY | CAP_SWAP, "v3: both");
        assertEq(vault.adapterCapabilities(IPositionAdapter(address(mla))), CAP_LIQUIDITY, "liquidity mock");
        assertEq(vault.adapterCapabilities(IPositionAdapter(address(msa))), CAP_LIQUIDITY | CAP_SWAP, "swap mock");

        MockPositionAdapter plain = new MockPositionAdapter(basket, address(vault), "P", bytes32(0));
        RevertingErc165Adapter reverting = new RevertingErc165Adapter(basket, address(vault));
        NoCapsErc165Adapter noCaps = new NoCapsErc165Adapter(basket, address(vault));
        MockSwapAdapter second = new MockSwapAdapter(basket, address(vault), "S2", bytes32(0));
        address[4] memory adapters = [address(plain), address(reverting), address(noCaps), address(second)];
        uint8[4] memory expected = [0, 0, 0, CAP_LIQUIDITY | CAP_SWAP];
        for (uint256 i; i < 4; ++i) {
            vm.prank(owner);
            vm.expectEmit(true, true, true, true, address(vault));
            emit IPoolmigoVault.AdapterCapabilitySet(adapters[i], expected[i]);
            vault.addAdapter(IPositionAdapter(adapters[i]));
            assertEq(vault.adapterCapabilities(IPositionAdapter(adapters[i])), expected[i]);
            assertTrue(vault.isAdapter(adapters[i]), "registered regardless of the mask");
        }
        assertEq(vault.adapterCapabilities(IPositionAdapter(alice)), 0, "unregistered: 0");
    }

    function test_SetAdapterCapability_OwnerOnlyAndValidation() public {
        IPositionAdapter a = IPositionAdapter(address(msa));
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, keeper));
        vault.setAdapterCapability(a, CAP_SWAP, false);

        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(IPoolmigoVault.PoolmigoVault__AdapterNotRegistered.selector, alice));
        vault.setAdapterCapability(IPositionAdapter(alice), CAP_SWAP, false);
        uint8[5] memory bad = [0, 3, 4, 8, 255];
        for (uint256 i; i < bad.length; ++i) {
            vm.expectRevert(abi.encodeWithSelector(IPoolmigoVault.PoolmigoVault__InvalidCapability.selector, bad[i]));
            vault.setAdapterCapability(a, bad[i], true);
            vm.expectRevert(abi.encodeWithSelector(IPoolmigoVault.PoolmigoVault__InvalidCapability.selector, bad[i]));
            vault.setAdapterCapability(a, bad[i], false);
        }
        vm.stopPrank();
        assertEq(vault.adapterCapabilities(a), CAP_LIQUIDITY | CAP_SWAP, "nothing changed");
    }

    /// @dev Enabling re-checks ERC-165: the owner can never grant a capability the adapter does not advertise.
    function test_SetAdapterCapability_CannotEnableUnsupported() public {
        MockPositionAdapter plain = new MockPositionAdapter(basket, address(vault), "P", bytes32(0));
        vm.startPrank(owner);
        vault.addAdapter(IPositionAdapter(address(plain)));
        vm.expectRevert(
            abi.encodeWithSelector(IPoolmigoVault.PoolmigoVault__CapabilityUnsupported.selector, address(mla), CAP_SWAP)
        );
        vault.setAdapterCapability(IPositionAdapter(address(mla)), CAP_SWAP, true);
        vm.expectRevert(
            abi.encodeWithSelector(
                IPoolmigoVault.PoolmigoVault__CapabilityUnsupported.selector, address(plain), CAP_LIQUIDITY
            )
        );
        vault.setAdapterCapability(IPositionAdapter(address(plain)), CAP_LIQUIDITY, true);
        vm.stopPrank();
        assertEq(vault.adapterCapabilities(IPositionAdapter(address(mla))), CAP_LIQUIDITY);
        assertEq(vault.adapterCapabilities(IPositionAdapter(address(plain))), 0);
    }

    /// @dev Disable is free (even while paused — a kill switch); the wrappers then refuse with `__CapabilityMissing`;
    ///      re-enabling a supported bit restores the op. Each change is announced with the new mask.
    function test_SetAdapterCapability_DisableBlocksWrappersReEnableRestores() public {
        IPositionAdapter a = IPositionAdapter(address(msa));
        vm.startPrank(owner);
        vault.setPaused(true);
        vm.expectEmit(true, true, true, true, address(vault));
        emit IPoolmigoVault.AdapterCapabilitySet(address(msa), CAP_SWAP);
        vault.setAdapterCapability(a, CAP_LIQUIDITY, false);
        vm.expectEmit(true, true, true, true, address(vault));
        emit IPoolmigoVault.AdapterCapabilitySet(address(msa), 0);
        vault.setAdapterCapability(a, CAP_SWAP, false);
        vault.setAdapterCapability(a, CAP_SWAP, false); // idempotent
        vault.setPaused(false);
        vm.stopPrank();
        assertEq(vault.adapterCapabilities(a), 0);

        vm.startPrank(keeper);
        _expectCapMissing(address(msa), CAP_LIQUIDITY);
        vault.addLiquidity(a, _add(-120, 240, 1, 0, 1, 1, 0));
        _expectCapMissing(address(msa), CAP_LIQUIDITY);
        vault.removeLiquidity(a, ILiquidityAdapter.RemoveLiquidityParams(0, 0, 0));
        _expectCapMissing(address(msa), CAP_SWAP);
        vault.swapExactIn(a, _swapP(address(tA), address(tB), 1e18, 0));
        vm.stopPrank();
        assertEq(msa.addCalls() + msa.removeCalls() + msa.swapCalls(), 0, "the adapter was never called");

        vm.startPrank(owner);
        vm.expectEmit(true, true, true, true, address(vault));
        emit IPoolmigoVault.AdapterCapabilitySet(address(msa), CAP_SWAP);
        vault.setAdapterCapability(a, CAP_SWAP, true);
        vault.setAdapterCapability(a, CAP_LIQUIDITY, true);
        vm.stopPrank();
        assertEq(vault.adapterCapabilities(a), CAP_LIQUIDITY | CAP_SWAP);
        vm.startPrank(keeper);
        vault.swapExactIn(a, _swapP(address(tA), address(tB), 1e18, 0));
        vault.removeLiquidity(a, ILiquidityAdapter.RemoveLiquidityParams(0, 0, 0));
        vm.stopPrank();
        assertEq(msa.swapCalls(), 1);
        assertEq(msa.removeCalls(), 1);
    }

    /// @dev Per-bit enforcement: a liquidity-only adapter cannot swap; a plain adapter can do neither (typed, before
    ///      any call); re-registration re-derives the mask (an owner toggle does not survive remove → add).
    function test_Capabilities_WrapperEnforcementAndReDerivation() public {
        MockPositionAdapter plain = new MockPositionAdapter(basket, address(vault), "P", bytes32(0));
        vm.prank(owner);
        vault.addAdapter(IPositionAdapter(address(plain)));

        vm.startPrank(keeper);
        _expectCapMissing(address(mla), CAP_SWAP);
        vault.swapExactIn(IPositionAdapter(address(mla)), _swapP(address(tA), address(tB), 1e18, 0));
        _expectCapMissing(address(plain), CAP_LIQUIDITY);
        vault.addLiquidity(IPositionAdapter(address(plain)), _add(-120, 240, 1, 0, 1, 1, 0));
        _expectCapMissing(address(plain), CAP_LIQUIDITY);
        vault.removeLiquidity(IPositionAdapter(address(plain)), ILiquidityAdapter.RemoveLiquidityParams(0, 0, 0));
        _expectCapMissing(address(plain), CAP_SWAP);
        vault.swapExactIn(IPositionAdapter(address(plain)), _swapP(address(tA), address(tB), 1e18, 0));
        vm.stopPrank();

        vm.startPrank(owner);
        vault.setAdapterCapability(IPositionAdapter(address(msa)), CAP_SWAP, false);
        vault.removeAdapter(IPositionAdapter(address(msa)));
        assertEq(vault.adapterCapabilities(IPositionAdapter(address(msa))), 0, "cleared on removal");
        vault.addAdapter(IPositionAdapter(address(msa)));
        assertEq(vault.adapterCapabilities(IPositionAdapter(address(msa))), CAP_LIQUIDITY | CAP_SWAP, "re-derived");
        vault.forceRemoveAdapter(IPositionAdapter(address(msa)));
        assertEq(vault.adapterCapabilities(IPositionAdapter(address(msa))), 0, "cleared on force-removal");
        vm.expectRevert(
            abi.encodeWithSelector(IPoolmigoVault.PoolmigoVault__AdapterNotRegistered.selector, address(msa))
        );
        vault.setAdapterCapability(IPositionAdapter(address(msa)), CAP_SWAP, true);
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                  VAULT: swapExactIn WRAPPER (MOCK ADAPTER)
    //////////////////////////////////////////////////////////////*/

    /// @dev Exactly `amountIn` approved, pulled, reset to 0; params forwarded verbatim; the output lands in the vault;
    ///      `SwapSettled` carries the pair and both amounts.
    function test_VaultSwapExactIn_HappyPathExactApprovalReset() public {
        msa.setRateWad(0.98e18);
        ISwapAdapter.SwapParams memory p = _swapP(address(tA), address(tB), 100e18, 97e18);
        vm.prank(keeper);
        vm.expectEmit(true, true, true, true, address(vault));
        emit IPoolmigoVault.SwapSettled(address(msa), address(tA), address(tB), 100e18, 98e18);
        vault.swapExactIn(IPositionAdapter(address(msa)), p);

        assertEq(msa.swapCalls(), 1);
        assertEq(msa.allowanceSeenOnSwap(), 100e18, "amountIn approved exactly");
        assertEq(tA.allowance(address(vault), address(msa)), 0, "reset to 0");
        assertEq(tB.allowance(address(vault), address(msa)), 0, "tokenOut never approved");
        assertEq(abi.encode(msa.lastSwap()), abi.encode(p), "params forwarded verbatim");
        assertEq(tA.balanceOf(address(vault)), SEED - 100e18, "amountIn left the vault");
        assertEq(tB.balanceOf(address(vault)), SEED + 98e18, "output landed in the vault");
        assertEq(tA.balanceOf(msa.VENUE()), 100e18);

        // The whole idle is spendable; the other direction works too.
        vm.prank(keeper);
        vault.swapExactIn(IPositionAdapter(address(msa)), _swapP(address(tB), address(tA), SEED + 98e18, 1));
        assertEq(tB.balanceOf(address(vault)), 0);
        assertEq(tB.allowance(address(vault), address(msa)), 0);
    }

    /// @dev The vault re-checks the RETURNED amount against `minAmountOut` (belt) — an adapter that under-delivers its
    ///      own floor is caught here and the whole call rolls back.
    function test_VaultSwapExactIn_MinOutBelt() public {
        msa.setRateWad(0.5e18);
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(IPoolmigoVault.PoolmigoVault__InsufficientAmountOut.selector, 50e18 + 1, 50e18)
        );
        vault.swapExactIn(IPositionAdapter(address(msa)), _swapP(address(tA), address(tB), 100e18, 50e18 + 1));
        assertEq(tA.balanceOf(address(vault)), SEED, "rolled back");
        assertEq(tB.balanceOf(address(vault)), SEED);

        vm.prank(keeper);
        vault.swapExactIn(IPositionAdapter(address(msa)), _swapP(address(tA), address(tB), 100e18, 50e18)); // equal ok
        assertEq(tB.balanceOf(address(vault)), SEED + 50e18);
    }

    function test_VaultSwapExactIn_Gating() public {
        IPositionAdapter a = IPositionAdapter(address(msa));
        ISwapAdapter.SwapParams memory ok = _swapP(address(tA), address(tB), 1e18, 0);

        vm.prank(alice);
        vm.expectRevert(IPoolmigoVault.PoolmigoVault__NotKeeper.selector);
        vault.swapExactIn(a, ok);

        MockToken stray = new MockToken("Stray", "STR", 18);
        vm.startPrank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IPoolmigoVault.PoolmigoVault__AdapterNotRegistered.selector, alice));
        vault.swapExactIn(IPositionAdapter(alice), ok);
        vm.expectRevert(
            abi.encodeWithSelector(
                IPoolmigoVault.PoolmigoVault__AdapterTokenNotRegistered.selector, address(msa), address(stray)
            )
        );
        vault.swapExactIn(a, _swapP(address(stray), address(tB), 1e18, 0));
        vm.expectRevert(
            abi.encodeWithSelector(
                IPoolmigoVault.PoolmigoVault__AdapterTokenNotRegistered.selector, address(msa), address(stray)
            )
        );
        vault.swapExactIn(a, _swapP(address(tA), address(stray), 1e18, 0));
        vm.expectRevert(
            abi.encodeWithSelector(IPoolmigoVault.PoolmigoVault__InsufficientIdle.selector, address(tA), SEED, SEED + 1)
        );
        vault.swapExactIn(a, _swapP(address(tA), address(tB), SEED + 1, 0));
        vm.expectRevert(IPoolmigoVault.PoolmigoVault__ZeroAmount.selector);
        vault.swapExactIn(a, _swapP(address(tA), address(tB), 0, 0));
        vm.expectRevert(abi.encodeWithSelector(IPoolmigoVault.PoolmigoVault__DuplicateToken.selector, address(tA)));
        vault.swapExactIn(a, _swapP(address(tA), address(tA), 1e18, 0));
        vm.stopPrank();

        vm.prank(owner);
        vault.setPaused(true);
        vm.prank(keeper);
        vm.expectRevert(IPoolmigoVault.PoolmigoVault__Paused.selector);
        vault.swapExactIn(a, ok);
        assertEq(msa.swapCalls(), 0);
    }

    /*//////////////////////////////////////////////////////////////
          REAL v3 ADAPTER: swapExactIn THROUGH THE VAULT (MOCK VENUE)
    //////////////////////////////////////////////////////////////*/

    /// @dev Vault → real adapter → real executor → (mock) UniversalRouter at a linear 0.995 rate. At spot = TWAP =
    ///      tick 0 the adapter's own floor is 99% of `amountIn`; a keeper floor below it leaves the adapter's floor in
    ///      force. The output lands in the vault, nothing stays in the adapter or the executor, every allowance in the
    ///      chain is back to 0, and the adapter's own `Swapped` records the enforced floor.
    function test_V3SwapExactIn_EndToEndOutputInVault() public {
        router.setLinearRate(address(token0), address(token1), 0.995e18);
        MockToken(address(token1)).mint(address(router), 1_000e18);
        uint256 amountIn = 100e18;
        uint256 vault0 = token0.balanceOf(address(vault));
        uint256 vault1 = token1.balanceOf(address(vault));

        vm.recordLogs();
        vm.prank(keeper);
        vm.expectEmit(true, true, true, true, address(vault));
        emit IPoolmigoVault.SwapSettled(address(v3), address(token0), address(token1), amountIn, 99.5e18);
        vault.swapExactIn(IPositionAdapter(address(v3)), _swapP(address(token0), address(token1), amountIn, 1));
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(token0.balanceOf(address(vault)), vault0 - amountIn);
        assertEq(token1.balanceOf(address(vault)), vault1 + 99.5e18, "full output to the vault");
        assertEq(token0.balanceOf(address(v3)) + token1.balanceOf(address(v3)), 0, "adapter keeps nothing");
        assertEq(token0.balanceOf(address(executor)) + token1.balanceOf(address(executor)), 0, "executor keeps nothing");
        assertEq(token0.allowance(address(vault), address(v3)), 0, "vault -> adapter reset");
        assertEq(token0.allowance(address(v3), address(executor)), 0, "adapter -> executor reset");
        assertEq(token0.allowance(address(executor), address(router)), 0, "executor -> Permit2 reset");
        (uint160 inner,,) = router.allowance(address(executor), address(token0), address(router));
        assertEq(inner, 0, "Permit2 -> router reset");
        assertEq(router.callCount(), 1);
        assertEq(router.callAt(0).innerAllowanceSeen, amountIn, "exact amountIn through Permit2");

        (uint256 swappedMin, bool found) = _v3SwappedMin(logs);
        assertTrue(found, "adapter Swapped event");
        assertEq(swappedMin, (amountIn * (BPS - MAX_SLIPPAGE_BPS)) / BPS, "the adapter's TWAP floor (stricter)");
    }

    /// @dev Both floor sources breach as `SwapExecutor__SlippageExceeded` with the ENFORCED floor as the arg: the
    ///      keeper's floor when stricter, the adapter's TWAP floor when the venue under-delivers it. Nothing moves.
    function test_V3SwapExactIn_FloorBreaches() public {
        MockToken(address(token1)).mint(address(router), 1_000e18);
        uint256 amountIn = 100e18;
        uint256 twapFloor = (amountIn * (BPS - MAX_SLIPPAGE_BPS)) / BPS; // 99e18 at tick 0

        // Keeper floor stricter than the adapter's and above the venue output (0.995).
        router.setLinearRate(address(token0), address(token1), 0.995e18);
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                ISwapExecutor.SwapExecutor__SlippageExceeded.selector, address(token0), amountIn, 99.6e18
            )
        );
        vault.swapExactIn(IPositionAdapter(address(v3)), _swapP(address(token0), address(token1), amountIn, 99.6e18));

        // Venue under-delivers the adapter's own floor (0.98 < 0.99) while the keeper's floor is lax.
        router.setLinearRate(address(token0), address(token1), 0.98e18);
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                ISwapExecutor.SwapExecutor__SlippageExceeded.selector, address(token0), amountIn, twapFloor
            )
        );
        vault.swapExactIn(IPositionAdapter(address(v3)), _swapP(address(token0), address(token1), amountIn, 1));

        assertEq(token0.balanceOf(address(vault)), SEED, "nothing moved");
        assertEq(token1.balanceOf(address(vault)), SEED);
        assertEq(router.callCount(), 0);
    }

    /// @dev The {deploy} price guards run first: TWAP unavailable / spot away from the TWAP.
    function test_V3SwapExactIn_PriceGuards() public {
        ISwapAdapter.SwapParams memory p = _swapP(address(token1), address(token0), 1e18, 1);
        pool.setMeanTick(-101);
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                UniswapV3Adapter.UniswapV3Adapter__SpotDeviatesFromTwap.selector,
                int24(0),
                int24(-101),
                MAX_SLIPPAGE_BPS
            )
        );
        vault.swapExactIn(IPositionAdapter(address(v3)), p);

        pool.setMeanTick(0);
        pool.setObserveReverts(true);
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(UniswapV3Adapter.UniswapV3Adapter__TwapUnavailable.selector, TWAP_WINDOW)
        );
        vault.swapExactIn(IPositionAdapter(address(v3)), p);
    }

    /// @dev Adapter-side validation (called as the vault): the pair must be the pool's, either direction, amount > 0;
    ///      only the vault may call. Pre-existing adapter idle is never part of a swap.
    function test_V3SwapExactIn_AdapterValidation() public {
        address t0 = address(token0);
        address t1 = address(token1);
        address stray = address(new MockToken("Stray", "STR", 18));
        vm.prank(alice);
        vm.expectRevert(UniswapV3Adapter.UniswapV3Adapter__OnlyVault.selector);
        v3.swapExactIn(_swapP(t0, t1, 1e18, 1));

        vm.startPrank(address(vault));
        _expectInvalidSwap(t0, t1, 0);
        _expectInvalidSwap(t0, t0, 1e18);
        _expectInvalidSwap(t1, t1, 1e18);
        _expectInvalidSwap(stray, t1, 1e18);
        _expectInvalidSwap(t0, stray, 1e18);
        _expectInvalidSwap(stray, t0, 1e18);
        _expectInvalidSwap(t1, stray, 1e18);
        vm.stopPrank();

        // token1 -> token0 works, and idle the adapter already held stays put.
        router.setLinearRate(t1, t0, 1e18);
        MockToken(t0).mint(address(router), 10e18);
        MockToken(t0).mint(address(v3), 3e18);
        MockToken(t1).mint(address(v3), 4e18);
        vm.prank(keeper);
        vault.swapExactIn(IPositionAdapter(address(v3)), _swapP(t1, t0, 5e18, 1));
        assertEq(token0.balanceOf(address(v3)), 3e18, "pre-existing idle untouched");
        assertEq(token1.balanceOf(address(v3)), 4e18);
        assertEq(token0.balanceOf(address(vault)), SEED + 5e18);
    }

    /*//////////////////////////////////////////////////////////////
              REAL v3 ADAPTER: positionState / configVersion / ERC-165
    //////////////////////////////////////////////////////////////*/

    /// @dev No position: the four position fields are 0 and `configVersion` is 1 after construction; every owner setter
    ///      bumps it by exactly one; a rejected or unauthorized call does not.
    function test_V3PositionState_ZerosAndConfigVersionBumps() public {
        _assertState(v3, 0, 0, 0, 0, 1);

        vm.startPrank(owner);
        v3.setRange(300, 900);
        _assertState(v3, 0, 0, 0, 0, 2);
        v3.setTwapWindow(3600);
        _assertState(v3, 0, 0, 0, 0, 3);
        v3.setMaxSlippageBps(50);
        _assertState(v3, 0, 0, 0, 0, 4);
        v3.setRangeConstraints(-6000, 6000, 120, 1200);
        _assertState(v3, 0, 0, 0, 0, 5);
        v3.setRange(300, 900); // same values: still an owner config write
        _assertState(v3, 0, 0, 0, 0, 6);

        vm.expectRevert();
        v3.setTwapWindow(1);
        vm.expectRevert();
        v3.setMaxSlippageBps(0);
        vm.expectRevert();
        v3.setRange(0, 1);
        vm.expectRevert();
        v3.setRangeConstraints(-6000, 6000, 61, 119);
        vm.stopPrank();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        v3.setTwapWindow(3600);
        _assertState(v3, 0, 0, 0, 0, 6);
    }

    /// @dev Idle in the adapter is not a position: positionState stays all-zero apart from the version.
    function test_V3PositionState_IdleIsNotAPosition() public {
        MockToken(address(token0)).mint(address(v3), 1e18);
        _assertState(v3, 0, 0, 0, 0, 1);
    }

    function test_V3SupportsInterface() public view {
        assertTrue(v3.supportsInterface(type(ILiquidityAdapter).interfaceId));
        assertTrue(v3.supportsInterface(type(ISwapAdapter).interfaceId));
        assertTrue(v3.supportsInterface(type(IERC165).interfaceId));
        assertFalse(v3.supportsInterface(type(IPositionAdapter).interfaceId));
        assertFalse(v3.supportsInterface(0xffffffff));
        assertFalse(v3.supportsInterface(bytes4(0)));
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    function _newAdapter(MockV3Pool pool_) internal returns (UniswapV3Adapter) {
        return new UniswapV3Adapter(
            UniswapV3Adapter.Config({
                vault: address(vault),
                pool: address(pool_),
                positionManager: address(factory), // MockV3Factory.factory() == itself: the NFPM anchor
                swapRouter: address(router),
                permit2: address(router),
                swapExecutor: address(executor),
                owner: owner,
                rangeTicksBelow: 600,
                rangeTicksAbove: 600,
                twapWindow: TWAP_WINDOW,
                maxSlippageBps: MAX_SLIPPAGE_BPS
            })
        );
    }

    function _assertState(UniswapV3Adapter a, uint256 id, int24 lower, int24 upper, uint128 liq, uint32 version)
        internal
        view
    {
        (uint256 id_, int24 lower_, int24 upper_, uint128 liq_, uint32 version_) = a.positionState();
        assertEq(id_, id, "tokenId");
        assertEq(lower_, lower, "tickLower");
        assertEq(upper_, upper, "tickUpper");
        assertEq(liq_, liq, "liquidity");
        assertEq(version_, version, "configVersion");
    }

    function _expectCapMissing(address adapter, uint8 capBit) internal {
        vm.expectRevert(
            abi.encodeWithSelector(IPoolmigoVault.PoolmigoVault__CapabilityMissing.selector, adapter, capBit)
        );
    }

    function _expectInvalidSwap(address tokenIn, address tokenOut, uint256 amountIn) internal {
        vm.expectRevert(
            abi.encodeWithSelector(UniswapV3Adapter.UniswapV3Adapter__InvalidSwap.selector, tokenIn, tokenOut, amountIn)
        );
        v3.swapExactIn(_swapP(tokenIn, tokenOut, amountIn, 1));
    }

    /// @dev `minAmountOut` of the v3 adapter's `Swapped` event (the floor it actually enforced).
    function _v3SwappedMin(Vm.Log[] memory logs) internal view returns (uint256 minOut, bool found) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(v3) && logs[i].topics[0] == UniswapV3Adapter.Swapped.selector) {
                (,, minOut) = abi.decode(logs[i].data, (uint256, uint256, uint256));
                found = true;
            }
        }
    }

    function _swapP(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut)
        internal
        pure
        returns (ISwapAdapter.SwapParams memory)
    {
        return ISwapAdapter.SwapParams(tokenIn, tokenOut, amountIn, minOut);
    }

    function _add(
        int24 lower,
        int24 upper,
        uint128 liquidity,
        uint128 minLiquidity,
        uint256 max0,
        uint256 max1,
        uint256 minSwapOut
    ) internal pure returns (ILiquidityAdapter.AddLiquidityParams memory) {
        return ILiquidityAdapter.AddLiquidityParams(lower, upper, liquidity, minLiquidity, max0, max1, minSwapOut);
    }

    function _pair(uint256 a, uint256 b) internal pure returns (uint256[] memory out) {
        out = new uint256[](2);
        out[0] = a;
        out[1] = b;
    }
}
