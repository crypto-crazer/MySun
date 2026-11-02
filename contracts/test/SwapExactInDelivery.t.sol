// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {stdStorage, StdStorage} from "forge-std/StdStorage.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {
    ReentrancyGuardTransientUpgradeable
} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardTransientUpgradeable.sol";

import {MySunVaultUpgradeable} from "contracts/MySunVaultUpgradeable.sol";
import {IPoolmigoVault} from "contracts/interfaces/IPoolmigoVault.sol";
import {IPositionAdapter} from "contracts/interfaces/IPositionAdapter.sol";
import {ISwapAdapter} from "contracts/interfaces/ISwapAdapter.sol";
import {UniswapV3Adapter} from "contracts/adapters/UniswapV3Adapter.sol";
import {UniswapV4Adapter} from "contracts/adapters/UniswapV4Adapter.sol";
import {IUniversalRouter} from "contracts/adapters/uniswap/IUniversalRouter.sol";
import {PoolKey} from "contracts/adapters/uniswap/v4/IPoolManagerMinimal.sol";
import {V4StateReader} from "contracts/adapters/uniswap/v4/V4StateReader.sol";
import {UniversalRouterSwapExecutor} from "contracts/swap/UniversalRouterSwapExecutor.sol";
import {MockToken} from "test/mocks/MockToken.sol";
import {MockDeliveryToken} from "test/mocks/MockDeliveryToken.sol";
import {MockSwapAdapter} from "test/mocks/MockSwapAdapter.sol";
import {MockV3Factory, MockV3Pool} from "test/mocks/MockV3Pool.sol";
import {MockPermit2Router} from "test/mocks/MockPermit2Router.sol";
import {MockV4FeeVenue} from "test/AdapterFees.t.sol";
import {VaultImplArgs} from "test/utils/VaultImplArgs.sol";

/// @notice Vault-side `swapExactIn` delivery checks, exercised through the real V3 adapter and executor: the adapter's
///         balance of both tokens must not fall (its pre-funded balance stands for idle and v4 banked fees), the
///         output is measured at the vault, and 1-2 wei rounding is topped up rather than rejected.
contract SwapExactInDeliveryTest is Test {
    uint256 internal constant GENESIS = 1_000e18;
    uint256 internal constant SEED = 1_000e18;
    uint256 internal constant RESERVED = 250e18; // adapter idle / v4 bank, pre-funded on both tokens
    uint256 internal constant AMOUNT_IN = 100e18;
    uint256 internal constant FEE_BPS = 500; // 5%
    uint32 internal constant TWAP_WINDOW = 1800;
    uint16 internal constant MAX_SLIPPAGE_BPS = 100;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal keeper = makeAddr("keeper");

    MockDeliveryToken internal feeToken;
    MockToken internal other;
    MySunVaultUpgradeable internal vault;
    UniswapV3Adapter internal v3;

    function setUp() public {
        feeToken = new MockDeliveryToken("Fee token", "FEE");
        other = new MockToken("Other", "OTH", 18);

        address[] memory basket = new address[](2);
        basket[0] = address(feeToken);
        basket[1] = address(other);

        MySunVaultUpgradeable impl = new MySunVaultUpgradeable(VaultImplArgs.depositSplit());
        vault = MySunVaultUpgradeable(
            address(
                new ERC1967Proxy(
                    address(impl),
                    abi.encodeCall(
                        MySunVaultUpgradeable(address(0)).initialize,
                        (owner, "sunLP", "sunLP", basket, treasury, uint16(1000), GENESIS, uint256(0))
                    )
                )
            )
        );

        MockV3Factory factory = new MockV3Factory();
        MockPermit2Router router = new MockPermit2Router(factory);
        UniversalRouterSwapExecutor executor = new UniversalRouterSwapExecutor(address(router), address(router));
        MockV3Pool pool =
            new MockV3Pool(address(factory), address(feeToken), address(other), 3000, uint160(1 << 96), 1e24);
        pool.setTickSpacing(60);
        factory.register(pool);
        v3 = new UniswapV3Adapter(
            UniswapV3Adapter.Config({
                vault: address(vault),
                pool: address(pool),
                positionManager: address(factory),
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

        vm.startPrank(owner);
        vault.addAdapter(IPositionAdapter(address(v3)));
        vault.setKeeper(keeper, true);
        feeToken.mint(owner, SEED);
        other.mint(owner, SEED);
        feeToken.approve(address(vault), SEED);
        other.approve(address(vault), SEED);
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = SEED;
        amounts[1] = SEED;
        vault.deposit(basket, amounts, GENESIS, owner);
        vm.stopPrank();

        // Reserved balance sits on the adapter before the swap. Deposit above was exact (every knob still off).
        feeToken.mint(address(v3), RESERVED);
        other.mint(address(v3), RESERVED);
        // Venue inventory for either direction. Mints are always exact.
        feeToken.mint(address(router), 1_000e18);
        other.mint(address(router), 1_000e18);
        router.setLinearRate(address(feeToken), address(other), 1e18);
        router.setLinearRate(address(other), address(feeToken), 1e18);
    }

    /// @dev Fee on the vault-to-adapter leg of `tokenIn`. The swap would otherwise finish with the adapter short by the
    ///      fee. The vault reverts `AdapterReserveSpent`; both the reserve and the vault idle stay put.
    function test_ShortDelivery_Reverts_ReservedBalanceUntouched() public {
        feeToken.setFee(address(vault), FEE_BPS);
        uint256 fee = AMOUNT_IN * FEE_BPS / 10_000;

        uint256 vaultFee = feeToken.balanceOf(address(vault));
        uint256 vaultOther = other.balanceOf(address(vault));

        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                IPoolmigoVault.PoolmigoVault__AdapterReserveSpent.selector,
                address(v3),
                address(feeToken),
                RESERVED,
                RESERVED - fee
            )
        );
        vault.swapExactIn(IPositionAdapter(address(v3)), _swap(address(feeToken), address(other), 1));

        assertEq(feeToken.balanceOf(address(v3)), RESERVED, "fee-token idle/bank untouched");
        assertEq(other.balanceOf(address(v3)), RESERVED, "other-token idle/bank untouched");
        assertEq(feeToken.balanceOf(address(vault)), vaultFee, "vault idle untouched");
        assertEq(other.balanceOf(address(vault)), vaultOther, "vault other untouched");
    }

    /// @dev Same adapter, same reserve, every knob off: the swap moves the nominal amount and the adapter ends where it
    ///      started; `SwapSettled` carries the measured output.
    function test_ExactDelivery_ReservedBalanceUntouched_VaultMovesNominal() public {
        vm.prank(keeper);
        vm.expectEmit(true, true, true, true, address(vault));
        emit IPoolmigoVault.SwapSettled(address(v3), address(feeToken), address(other), AMOUNT_IN, AMOUNT_IN);
        vault.swapExactIn(IPositionAdapter(address(v3)), _swap(address(feeToken), address(other), 1));

        assertEq(feeToken.balanceOf(address(v3)), RESERVED, "fee-token reserved untouched");
        assertEq(other.balanceOf(address(v3)), RESERVED, "other-token reserved untouched");
        assertEq(feeToken.balanceOf(address(vault)), SEED - AMOUNT_IN);
        assertEq(other.balanceOf(address(vault)), SEED + AMOUNT_IN);
        assertEq(feeToken.allowance(address(vault), address(v3)), 0);
    }

    /// @dev The fee is armed on the vault's transfers, but this direction never sends the fee token from the vault.
    function test_ExactDelivery_OtherDirection_ReservedBalanceUntouched() public {
        feeToken.setFee(address(vault), FEE_BPS);

        vm.prank(keeper);
        vault.swapExactIn(IPositionAdapter(address(v3)), _swap(address(other), address(feeToken), 1));

        assertEq(other.balanceOf(address(v3)), RESERVED, "input reserved untouched");
        assertEq(feeToken.balanceOf(address(v3)), RESERVED, "output reserved untouched");
        assertEq(other.balanceOf(address(vault)), SEED - AMOUNT_IN);
        assertEq(feeToken.balanceOf(address(vault)), SEED + AMOUNT_IN);
    }

    /// @dev Fee on the adapter-to-vault leg of `tokenOut`: the adapter reports (and its executor measured) AMOUNT_IN,
    ///      but the vault receives 95%. The floor is enforced on the vault's measured receipt.
    function test_FoTTokenOut_MinOutEnforcedOnMeasuredReceipt() public {
        feeToken.setFee(address(v3), FEE_BPS);
        uint256 received = AMOUNT_IN - AMOUNT_IN * FEE_BPS / 10_000;

        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(IPoolmigoVault.PoolmigoVault__InsufficientAmountOut.selector, AMOUNT_IN, received)
        );
        vault.swapExactIn(IPositionAdapter(address(v3)), _swap(address(other), address(feeToken), AMOUNT_IN));

        // A floor the measured receipt meets settles, and `SwapSettled` reports what actually arrived.
        vm.prank(keeper);
        vm.expectEmit(true, true, true, true, address(vault));
        emit IPoolmigoVault.SwapSettled(address(v3), address(other), address(feeToken), AMOUNT_IN, received);
        vault.swapExactIn(IPositionAdapter(address(v3)), _swap(address(other), address(feeToken), received));
        assertEq(feeToken.balanceOf(address(vault)), SEED + received);
    }

    /// @dev `tokenIn` re-enters the vault from its transfer hook with a second keeper swap through another adapter, which
    ///      would move the vault's `tokenOut` balance between the outer swap's snapshots. The inner call never touches
    ///      the V3 adapter (whose own lock would hide the vault's), so only the vault's lock can reject it.
    function test_ReentrantTokenIn_Rejected() public {
        address[] memory basket = vault.tokens();
        MockSwapAdapter second = new MockSwapAdapter(basket, address(vault), keccak256("SECOND"), bytes32(uint256(2)));
        vm.startPrank(owner);
        vault.addAdapter(IPositionAdapter(address(second)));
        vault.setKeeper(address(feeToken), true);
        vm.stopPrank();
        feeToken.setReenter(
            address(vault),
            address(vault),
            abi.encodeCall(
                vault.swapExactIn, (IPositionAdapter(address(second)), _swap(address(other), address(feeToken), 1))
            )
        );

        vm.prank(keeper);
        vm.expectRevert(ReentrancyGuardTransientUpgradeable.ReentrancyGuardReentrantCall.selector);
        vault.swapExactIn(IPositionAdapter(address(v3)), _swap(address(feeToken), address(other), AMOUNT_IN));

        assertEq(second.swapCalls(), 0, "inner swap never ran");
        assertEq(other.balanceOf(address(vault)), SEED);
        assertEq(feeToken.balanceOf(address(v3)), RESERVED);
    }

    /// @dev 1-wei rounding token: the vault-to-adapter leg credits 1 wei less, so the adapter pays the router 1 wei more
    ///      than it got. The vault tops the adapter up (1 + 2 wei, credited 2) instead of reverting: the swap settles,
    ///      the reserve stays whole, and the vault pays AMOUNT_IN + 3 wei.
    function test_RoundingTokenIn_ToppedUpNotReverted() public {
        feeToken.setRoundingLoss(address(vault), 1);

        vm.prank(keeper);
        vault.swapExactIn(IPositionAdapter(address(v3)), _swap(address(feeToken), address(other), 1));

        uint256 reserve = feeToken.balanceOf(address(v3));
        assertGe(reserve, RESERVED, "reserve whole");
        assertLe(reserve, RESERVED + 2, "surplus <= tolerance");
        assertEq(feeToken.balanceOf(address(vault)), SEED - AMOUNT_IN - 3, "vault pays the op's rounding");
        assertEq(other.balanceOf(address(vault)), SEED + AMOUNT_IN);
    }

    function _swap(address tokenIn, address tokenOut, uint256 minOut)
        internal
        pure
        returns (ISwapAdapter.SwapParams memory)
    {
        return
            ISwapAdapter.SwapParams({tokenIn: tokenIn, tokenOut: tokenOut, amountIn: AMOUNT_IN, minAmountOut: minOut});
    }
}

/// @notice The v4 fee bank is not spendable by a vault swap: a real {UniswapV4Adapter} registered on the real vault,
///         its bank written into storage and backed by tokens, swapping through REF_POOL (its default venue) on the
///         mock router. A short vault-to-adapter delivery of `tokenIn` would make the executor's pull eat the bank.
contract SwapExactInV4BankTest is Test {
    using stdStorage for StdStorage;

    uint256 internal constant GENESIS = 1_000e18;
    uint256 internal constant SEED = 1_000e18;
    uint256 internal constant BANK = 40e18;
    uint256 internal constant AMOUNT_IN = 100e18;
    uint256 internal constant FEE_BPS = 500;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal keeper = makeAddr("keeper");

    MockDeliveryToken internal token0;
    MockDeliveryToken internal token1;
    MySunVaultUpgradeable internal vault;
    UniswapV4Adapter internal v4;

    function setUp() public {
        MockDeliveryToken a = new MockDeliveryToken("Token A", "TKA");
        MockDeliveryToken b = new MockDeliveryToken("Token B", "TKB");
        (token0, token1) = address(a) < address(b) ? (a, b) : (b, a);
        address[] memory basket = new address[](2);
        basket[0] = address(token0);
        basket[1] = address(token1);

        MySunVaultUpgradeable impl = new MySunVaultUpgradeable(VaultImplArgs.depositSplit());
        vault = MySunVaultUpgradeable(
            address(
                new ERC1967Proxy(
                    address(impl),
                    abi.encodeCall(
                        MySunVaultUpgradeable(address(0)).initialize,
                        (owner, "sunLP", "sunLP", basket, treasury, uint16(1000), GENESIS, uint256(0))
                    )
                )
            )
        );

        MockV3Factory factory = new MockV3Factory();
        MockPermit2Router router = new MockPermit2Router(factory);
        MockV3Pool refPool =
            new MockV3Pool(address(factory), address(token0), address(token1), 100, uint160(1 << 96), 1e24);
        factory.register(refPool);
        MockV4FeeVenue venue = new MockV4FeeVenue(address(router));
        vm.mockCall(address(router), abi.encodeCall(IUniversalRouter.poolManager, ()), abi.encode(address(venue)));
        PoolKey memory key = PoolKey({
            currency0: address(token0), currency1: address(token1), fee: 500, tickSpacing: 60, hooks: address(0)
        });
        venue.setSlot(keccak256(abi.encodePacked(keccak256(abi.encode(key)), V4StateReader.POOLS_SLOT)), 1 << 96);
        v4 = new UniswapV4Adapter(
            UniswapV4Adapter.Config({
                vault: address(vault),
                positionManager: address(venue),
                poolKey: key,
                refPool: address(refPool),
                swapRouter: address(router),
                swapExecutor: address(new UniversalRouterSwapExecutor(address(router), address(router))),
                owner: owner,
                rangeTicksBelow: 600,
                rangeTicksAbove: 600,
                twapWindow: 1800,
                maxSlippageBps: 200
            })
        );

        vm.startPrank(owner);
        vault.addAdapter(IPositionAdapter(address(v4)));
        vault.setKeeper(keeper, true);
        token0.mint(owner, SEED);
        token1.mint(owner, SEED);
        token0.approve(address(vault), SEED);
        token1.approve(address(vault), SEED);
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = SEED;
        amounts[1] = SEED;
        vault.deposit(basket, amounts, GENESIS, owner);
        vm.stopPrank();

        // A backed fee bank and no free idle: every token the adapter holds is banked fees.
        stdstore.target(address(v4)).sig("bankedFees0()").checked_write(BANK);
        stdstore.target(address(v4)).sig("bankedFees1()").checked_write(BANK);
        token0.mint(address(v4), BANK);
        token1.mint(address(v4), BANK);

        token0.mint(address(router), 1_000e18);
        token1.mint(address(router), 1_000e18);
        router.setLinearRate(address(token0), address(token1), 1e18);
        router.setLinearRate(address(token1), address(token0), 1e18);
    }

    function test_V4FeeBank_NotSpendableByShortSwap() public {
        token0.setFee(address(vault), FEE_BPS);
        uint256 fee = AMOUNT_IN * FEE_BPS / 10_000;

        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                IPoolmigoVault.PoolmigoVault__AdapterReserveSpent.selector, address(v4), address(token0), BANK, BANK - fee
            )
        );
        vault.swapExactIn(
            IPositionAdapter(address(v4)),
            ISwapAdapter.SwapParams({
                tokenIn: address(token0), tokenOut: address(token1), amountIn: AMOUNT_IN, minAmountOut: 1
            })
        );

        assertEq(v4.bankedFees0(), BANK, "bank0 untouched");
        assertEq(v4.bankedFees1(), BANK, "bank1 untouched");
        assertEq(token0.balanceOf(address(v4)), BANK, "bank0 still backed");
        assertEq(token1.balanceOf(address(v4)), BANK, "bank1 still backed");
    }

    /// @dev Exact delivery through the same adapter: the swap settles and the bank is still fully backed.
    function test_V4FeeBank_ExactSwapLeavesBankBacked() public {
        vm.prank(keeper);
        vault.swapExactIn(
            IPositionAdapter(address(v4)),
            ISwapAdapter.SwapParams({
                tokenIn: address(token0), tokenOut: address(token1), amountIn: AMOUNT_IN, minAmountOut: 1
            })
        );

        assertEq(token0.balanceOf(address(v4)), BANK);
        assertEq(token1.balanceOf(address(v4)), BANK);
        assertEq(token1.balanceOf(address(vault)), SEED + AMOUNT_IN);
    }
}
