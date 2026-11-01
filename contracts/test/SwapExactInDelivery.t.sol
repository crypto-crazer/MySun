// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {MySunVaultUpgradeable} from "contracts/MySunVaultUpgradeable.sol";
import {IPoolmigoVault} from "contracts/interfaces/IPoolmigoVault.sol";
import {IPositionAdapter} from "contracts/interfaces/IPositionAdapter.sol";
import {ISwapAdapter} from "contracts/interfaces/ISwapAdapter.sol";
import {UniswapV3Adapter} from "contracts/adapters/UniswapV3Adapter.sol";
import {UniversalRouterSwapExecutor} from "contracts/swap/UniversalRouterSwapExecutor.sol";
import {MockToken} from "test/mocks/MockToken.sol";
import {MockV3Factory, MockV3Pool} from "test/mocks/MockV3Pool.sol";
import {MockPermit2Router} from "test/mocks/MockPermit2Router.sol";
import {VaultImplArgs} from "test/utils/VaultImplArgs.sol";

/// @notice Exact ERC-20 until `feeFrom` is set. A transfer whose sender is `feeFrom` delivers `value - fee` and
///         burns the fee from the sender. Later hops (adapter to executor, executor to router) stay exact, so a
///         swap can complete while the adapter's balance has fallen by the fee — the case the vault must reject.
contract FeeOnVaultTransferToken is MockToken {
    address public feeFrom;
    uint256 public feeBps;

    constructor() MockToken("Fee token", "FEE", 18) {}

    function setFeeFrom(address feeFrom_, uint256 feeBps_) external {
        feeFrom = feeFrom_;
        feeBps = feeBps_;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != feeFrom || feeFrom == address(0) || feeBps == 0 || to == address(0)) {
            super._update(from, to, value);
            return;
        }
        uint256 fee = value * feeBps / 10_000;
        super._update(from, to, value - fee);
        if (fee != 0) super._update(from, address(0xdead), fee);
    }
}

/// @notice Vault-side `swapExactIn` delivery check, exercised through the real V3 adapter and executor.
///         The pre-funded adapter balance stands for idle and for V4 banked fees: both are this token's balance,
///         and the executor's `transferFrom(adapter, amountIn)` spends whichever is there. V4, hooked and native
///         adapters return through the same vault function, so the check covers them without a second deployment.
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

    FeeOnVaultTransferToken internal feeToken;
    MockToken internal other;
    MySunVaultUpgradeable internal vault;
    UniswapV3Adapter internal v3;

    function setUp() public {
        feeToken = new FeeOnVaultTransferToken();
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

        // Reserved balance sits on the adapter before the swap. Deposit above was exact (fee still off).
        feeToken.mint(address(v3), RESERVED);
        other.mint(address(v3), RESERVED);
        // Venue inventory for either direction. The fee does not apply to these mints.
        feeToken.mint(address(router), 1_000e18);
        other.mint(address(router), 1_000e18);
        router.setLinearRate(address(feeToken), address(other), 1e18);
        router.setLinearRate(address(other), address(feeToken), 1e18);
    }

    /// @dev Fee turns on after a normal deposit. The swap would otherwise finish and leave the adapter short by the
    ///      fee. The vault reverts `InexactDelivery` and both the reserved balance and the vault idle stay put.
    function test_ShortDelivery_Reverts_ReservedBalanceUntouched() public {
        feeToken.setFeeFrom(address(vault), FEE_BPS);
        uint256 fee = AMOUNT_IN * FEE_BPS / 10_000;

        uint256 reservedFee = feeToken.balanceOf(address(v3));
        uint256 reservedOther = other.balanceOf(address(v3));
        uint256 vaultFee = feeToken.balanceOf(address(vault));
        uint256 vaultOther = other.balanceOf(address(vault));

        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                IPoolmigoVault.PoolmigoVault__InexactDelivery.selector, address(feeToken), AMOUNT_IN, AMOUNT_IN - fee
            )
        );
        vault.swapExactIn(
            IPositionAdapter(address(v3)),
            ISwapAdapter.SwapParams({
                tokenIn: address(feeToken), tokenOut: address(other), amountIn: AMOUNT_IN, minAmountOut: 1
            })
        );

        assertEq(feeToken.balanceOf(address(v3)), reservedFee, "fee-token idle/bank untouched");
        assertEq(other.balanceOf(address(v3)), reservedOther, "other-token idle/bank untouched");
        assertEq(feeToken.balanceOf(address(vault)), vaultFee, "vault idle untouched");
        assertEq(other.balanceOf(address(vault)), vaultOther, "vault other untouched");
        assertEq(reservedFee, RESERVED);
    }

    /// @dev Same adapter, same reserved balance, fee off. The swap moves the nominal vault amount and leaves the
    ///      adapter where it started.
    function test_ExactDelivery_ReservedBalanceUntouched_VaultMovesNominal() public {
        uint256 vaultFeeBefore = feeToken.balanceOf(address(vault));
        uint256 vaultOtherBefore = other.balanceOf(address(vault));

        vm.prank(keeper);
        vault.swapExactIn(
            IPositionAdapter(address(v3)),
            ISwapAdapter.SwapParams({
                tokenIn: address(feeToken), tokenOut: address(other), amountIn: AMOUNT_IN, minAmountOut: 1
            })
        );

        assertEq(feeToken.balanceOf(address(v3)), RESERVED, "fee-token reserved untouched");
        assertEq(other.balanceOf(address(v3)), RESERVED, "other-token reserved untouched");
        assertEq(feeToken.balanceOf(address(vault)), vaultFeeBefore - AMOUNT_IN);
        assertEq(other.balanceOf(address(vault)), vaultOtherBefore + AMOUNT_IN);
        assertEq(feeToken.allowance(address(vault), address(v3)), 0);
    }

    /// @dev The other direction (exact output token is the fee token, input is standard) also leaves the reserved
    ///      balance in place. The fee is armed and would tax a transfer from the vault, but this swap does not
    ///      pull the fee token from the vault.
    function test_ExactDelivery_OtherDirection_ReservedBalanceUntouched() public {
        feeToken.setFeeFrom(address(vault), FEE_BPS);

        vm.prank(keeper);
        vault.swapExactIn(
            IPositionAdapter(address(v3)),
            ISwapAdapter.SwapParams({
                tokenIn: address(other), tokenOut: address(feeToken), amountIn: AMOUNT_IN, minAmountOut: 1
            })
        );

        assertEq(other.balanceOf(address(v3)), RESERVED, "input reserved untouched");
        assertEq(feeToken.balanceOf(address(v3)), RESERVED, "output reserved untouched");
        assertEq(other.balanceOf(address(vault)), SEED - AMOUNT_IN);
        assertEq(feeToken.balanceOf(address(vault)), SEED + AMOUNT_IN);
    }
}
