// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import {Test, console2} from "forge-std/Test.sol";
import {Upgrades, Options} from "openzeppelin-foundry-upgrades/Upgrades.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {MySunVaultUpgradeable} from "contracts/MySunVaultUpgradeable.sol";
import {MySunVaultUpgradeExample} from "contracts/MySunVaultUpgradeExample.sol";
import {IPoolmigoVault} from "contracts/interfaces/IPoolmigoVault.sol";
import {IPositionAdapter} from "contracts/interfaces/IPositionAdapter.sol";
import {MockToken} from "test/mocks/MockToken.sol";
import {MockBehaviorToken} from "test/mocks/MockBehaviorToken.sol";
import {MockPositionAdapter} from "test/mocks/MockPositionAdapter.sol";
import {BrokenPositionAdapter} from "test/mocks/BrokenPositionAdapter.sol";

contract PoolmigoVaultUpgradeableTest is Test {
    MySunVaultUpgradeable internal vault;
    MockToken internal usdg; // 6dp
    MockToken internal weth; // 18dp
    MockPositionAdapter internal uniV3; // DEX #1, pool #1
    MockPositionAdapter internal uniV4; // DEX #2, pool #2

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal keeper = makeAddr("keeper");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    bytes32 internal constant DEX_V3 = keccak256("UNISWAP_V3");
    bytes32 internal constant DEX_V4 = keccak256("UNISWAP_V4");

    uint16 internal constant FEE_BPS = 1500;
    // Flagship receipt (per-vault initialize params since batch 3 — notes/NAMING.md).
    string internal constant NAME = "sunEthLP";
    string internal constant SYMBOL = "sunEthLP";
    uint256 internal constant BPS = 10_000;

    // Genesis basket (owner-seeded): 1_000 USDG + 1 WETH; shares = K = GENESIS (test scale — the real K
    // comes from the team's one-time off-chain valuation, ≈$1/share).
    uint256 internal constant BOOT_USDG = 1_000e6;
    uint256 internal constant BOOT_WETH = 1e18;
    uint256 internal constant GENESIS = 1_000e18;
    // Mirrors of the vault's private deposit-side virtuals (independent expectations in tests).
    uint256 internal constant VS = 1;
    uint256 internal constant VA = 1;

    address[] internal basket;

    function setUp() public {
        usdg = new MockToken("Mock USDG", "USDG", 6);
        weth = new MockToken("Mock WETH", "WETH", 18);
        basket.push(address(usdg));
        basket.push(address(weth));

        vault = MySunVaultUpgradeable(_deployVault(basket));

        uniV3 = new MockPositionAdapter(basket, address(vault), DEX_V3, bytes32(uint256(1)));
        uniV4 = new MockPositionAdapter(basket, address(vault), DEX_V4, bytes32(uint256(2)));

        vm.startPrank(owner);
        vault.addAdapter(IPositionAdapter(address(uniV3)));
        vault.addAdapter(IPositionAdapter(address(uniV4)));
        vault.setKeeper(keeper, true);
        vm.stopPrank();

        _fund(owner); // genesis is owner-only: the owner seeds the basket
        _fund(alice);
        _fund(bob);
    }

    /*//////////////////////////////////////////////////////////////
                          1. INITIALIZE / PROXY
    //////////////////////////////////////////////////////////////*/

    function test_InitializeSetsState() public view {
        assertEq(vault.name(), "sunEthLP");
        assertEq(vault.symbol(), "sunEthLP");
        assertEq(vault.decimals(), 18);
        assertEq(vault.owner(), owner);
        assertEq(vault.treasury(), treasury);
        assertEq(vault.performanceFeeBps(), FEE_BPS);
        assertEq(vault.genesisShares(), GENESIS);
        assertEq(vault.maxTotalSupply(), 0); // default fixture is uncapped
        assertFalse(vault.paused());
        address[] memory t = vault.tokens();
        assertEq(t.length, 2);
        assertEq(t[0], address(usdg));
        assertEq(t[1], address(weth));
        assertTrue(vault.isToken(address(usdg)));
        assertTrue(vault.isToken(address(weth)));
        assertFalse(vault.isToken(alice));
        assertEq(vault.adapterCount(), 2);
        assertTrue(vault.isKeeper(keeper));
    }

    function test_ReinitializeRejected() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        vault.initialize(owner, NAME, SYMBOL, basket, treasury, FEE_BPS, GENESIS, 0);
    }

    function test_ImplementationInitializersLocked() public {
        address impl = Upgrades.getImplementationAddress(address(vault));
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        MySunVaultUpgradeable(impl).initialize(owner, NAME, SYMBOL, basket, treasury, FEE_BPS, GENESIS, 0);
    }

    function test_InitializeValidation() public {
        MySunVaultUpgradeable impl = new MySunVaultUpgradeable();
        address[] memory empty;
        address[] memory dup = new address[](2);
        dup[0] = address(usdg);
        dup[1] = address(usdg);
        address[] memory withZero = new address[](1);

        vm.expectRevert(IPoolmigoVault.PoolmigoVault__ZeroAddress.selector);
        _rawProxy(impl, _initData(address(0), NAME, SYMBOL, basket, treasury, FEE_BPS, GENESIS, 0));
        vm.expectRevert(IPoolmigoVault.PoolmigoVault__ZeroAddress.selector);
        _rawProxy(impl, _initData(owner, NAME, SYMBOL, basket, address(0), FEE_BPS, GENESIS, 0));
        vm.expectRevert(abi.encodeWithSelector(IPoolmigoVault.PoolmigoVault__FeeTooHigh.selector, 3001, 3000));
        _rawProxy(impl, _initData(owner, NAME, SYMBOL, basket, treasury, 3001, GENESIS, 0));
        vm.expectRevert(IPoolmigoVault.PoolmigoVault__LengthMismatch.selector);
        _rawProxy(impl, _initData(owner, NAME, SYMBOL, empty, treasury, FEE_BPS, GENESIS, 0));
        vm.expectRevert(
            abi.encodeWithSelector(IPoolmigoVault.PoolmigoVault__TokenAlreadyRegistered.selector, address(usdg))
        );
        _rawProxy(impl, _initData(owner, NAME, SYMBOL, dup, treasury, FEE_BPS, GENESIS, 0));
        vm.expectRevert(IPoolmigoVault.PoolmigoVault__ZeroAddress.selector);
        _rawProxy(impl, _initData(owner, NAME, SYMBOL, withZero, treasury, FEE_BPS, GENESIS, 0));

        // Genesis constant K must be non-zero; a non-zero cap must fit the genesis mint.
        vm.expectRevert(IPoolmigoVault.PoolmigoVault__ZeroGenesisShares.selector);
        _rawProxy(impl, _initData(owner, NAME, SYMBOL, basket, treasury, FEE_BPS, 0, 0));
        vm.expectRevert(
            abi.encodeWithSelector(IPoolmigoVault.PoolmigoVault__InvalidSupplyCap.selector, GENESIS - 1, GENESIS)
        );
        _rawProxy(impl, _initData(owner, NAME, SYMBOL, basket, treasury, FEE_BPS, GENESIS, GENESIS - 1));
        // Boundary: cap == K is accepted; cap == 0 means uncapped.
        _rawProxy(impl, _initData(owner, NAME, SYMBOL, basket, treasury, FEE_BPS, GENESIS, GENESIS));
        _rawProxy(impl, _initData(owner, NAME, SYMBOL, basket, treasury, FEE_BPS, GENESIS, 0));
    }

    /*//////////////////////////////////////////////////////////////
                              2. addToken
    //////////////////////////////////////////////////////////////*/

    function test_AddToken() public {
        MockToken dai = new MockToken("DAI", "DAI", 18);
        vm.prank(owner);
        vm.expectEmit(true, false, false, false, address(vault));
        emit IPoolmigoVault.TokenAdded(address(dai));
        vault.addToken(address(dai));
        assertTrue(vault.isToken(address(dai)));
        assertEq(vault.tokens().length, 3);
        assertEq(vault.tokens()[2], address(dai));
    }

    function test_AddTokenOnlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, alice));
        vault.addToken(makeAddr("x"));
    }

    function test_AddTokenRejectsDupZeroCap() public {
        vm.startPrank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(IPoolmigoVault.PoolmigoVault__TokenAlreadyRegistered.selector, address(usdg))
        );
        vault.addToken(address(usdg));
        vm.expectRevert(IPoolmigoVault.PoolmigoVault__ZeroAddress.selector);
        vault.addToken(address(0));

        // 2 already registered; fill to MAX_TOKENS (8), then the 9th must revert.
        for (uint256 i = 2; i < vault.MAX_TOKENS(); ++i) {
            vault.addToken(address(new MockToken("T", "T", 18)));
        }
        assertEq(vault.tokens().length, vault.MAX_TOKENS());
        MockToken ninth = new MockToken("T", "T", 18);
        vm.expectRevert(
            abi.encodeWithSelector(IPoolmigoVault.PoolmigoVault__MaxTokensReached.selector, vault.MAX_TOKENS())
        );
        vault.addToken(address(ninth));
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                             3. addAdapter
    //////////////////////////////////////////////////////////////*/

    function test_AddAdapterHappyPath() public view {
        assertTrue(vault.isAdapter(address(uniV3)));
        assertTrue(vault.isAdapter(address(uniV4)));
        assertEq(address(vault.adapterAt(0)), address(uniV3));
        assertEq(address(vault.adapterAt(1)), address(uniV4));
        assertEq(vault.adapters().length, 2);
        assertEq(vault.adapterAt(0).dex(), DEX_V3);
        assertEq(vault.adapterAt(1).dex(), DEX_V4);
        assertTrue(vault.adapterAt(0).poolId() != vault.adapterAt(1).poolId());
    }

    function test_AddAdapterEmits() public {
        MockPositionAdapter a = new MockPositionAdapter(basket, address(vault), DEX_V3, bytes32(uint256(99)));
        vm.prank(owner);
        vm.expectEmit(true, true, true, false, address(vault));
        emit IPoolmigoVault.AdapterAdded(address(a), DEX_V3, bytes32(uint256(99)));
        vault.addAdapter(IPositionAdapter(address(a)));
    }

    function test_AddAdapterRejectsUnregisteredToken() public {
        MockToken other = new MockToken("OTHER", "OTHER", 18);
        address[] memory t = new address[](2);
        t[0] = address(usdg);
        t[1] = address(other);
        MockPositionAdapter bad = new MockPositionAdapter(t, address(vault), DEX_V3, bytes32(uint256(9)));
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                IPoolmigoVault.PoolmigoVault__AdapterTokenNotRegistered.selector, address(bad), address(other)
            )
        );
        vault.addAdapter(IPositionAdapter(address(bad)));
    }

    function test_AddAdapterRejectsEmptyAndZeroTokens() public {
        address[] memory none;
        MockPositionAdapter empty = new MockPositionAdapter(none, address(vault), DEX_V3, bytes32(uint256(9)));
        address[] memory withZero = new address[](1);
        MockPositionAdapter zeroTok = new MockPositionAdapter(withZero, address(vault), DEX_V3, bytes32(uint256(9)));

        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(IPoolmigoVault.PoolmigoVault__AdapterNoTokens.selector, address(empty)));
        vault.addAdapter(IPositionAdapter(address(empty)));
        vm.expectRevert(IPoolmigoVault.PoolmigoVault__ZeroAddress.selector);
        vault.addAdapter(IPositionAdapter(address(zeroTok)));
        vm.stopPrank();
    }

    function test_AddAdapterRejectsDupZeroCapAndNonOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, alice));
        vault.addAdapter(IPositionAdapter(address(uniV3)));

        vm.startPrank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(IPoolmigoVault.PoolmigoVault__AdapterAlreadyRegistered.selector, address(uniV3))
        );
        vault.addAdapter(IPositionAdapter(address(uniV3)));
        vm.expectRevert(IPoolmigoVault.PoolmigoVault__ZeroAddress.selector);
        vault.addAdapter(IPositionAdapter(address(0)));

        for (uint256 i = 2; i < vault.MAX_ADAPTERS(); ++i) {
            vault.addAdapter(
                IPositionAdapter(address(new MockPositionAdapter(basket, address(vault), DEX_V3, bytes32(i))))
            );
        }
        assertEq(vault.adapterCount(), vault.MAX_ADAPTERS());
        MockPositionAdapter ninth = new MockPositionAdapter(basket, address(vault), DEX_V3, bytes32(uint256(999)));
        vm.expectRevert(
            abi.encodeWithSelector(IPoolmigoVault.PoolmigoVault__MaxAdaptersReached.selector, vault.MAX_ADAPTERS())
        );
        vault.addAdapter(IPositionAdapter(address(ninth)));
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                           4-9. DEPOSIT RULES
    //////////////////////////////////////////////////////////////*/

    function test_DepositBootstrapFullBasket() public {
        vm.prank(owner); // genesis preview is owner-gated like the deposit itself
        (uint256 pShares, uint256[] memory pReq) = vault.previewDeposit(basket, _amts(BOOT_USDG, BOOT_WETH));
        assertEq(pShares, GENESIS);
        assertEq(pReq[0], BOOT_USDG);
        assertEq(pReq[1], BOOT_WETH);

        vm.prank(owner);
        vm.expectEmit(true, true, false, true, address(vault));
        emit IPoolmigoVault.Deposited(owner, owner, basket, _amts(BOOT_USDG, BOOT_WETH), GENESIS);
        uint256 shares = vault.deposit(basket, _amts(BOOT_USDG, BOOT_WETH), GENESIS, owner);

        assertEq(shares, GENESIS); // shares = K on genesis, independent of the amounts
        assertEq(vault.balanceOf(owner), GENESIS);
        assertEq(vault.totalSupply(), GENESIS);
        assertEq(usdg.balanceOf(address(vault)), BOOT_USDG);
        assertEq(weth.balanceOf(address(vault)), BOOT_WETH);
    }

    function test_GenesisIsOwnerOnly() public {
        vm.startPrank(alice);
        vm.expectRevert(IPoolmigoVault.PoolmigoVault__GenesisNotOwner.selector);
        vault.previewDeposit(basket, _amts(BOOT_USDG, BOOT_WETH));
        vm.expectRevert(IPoolmigoVault.PoolmigoVault__GenesisNotOwner.selector);
        vault.deposit(basket, _amts(BOOT_USDG, BOOT_WETH), GENESIS, alice);
        vm.stopPrank();
        assertEq(vault.totalSupply(), 0);

        // The owner may seed on behalf of any receiver; K does not depend on the amounts offered.
        vm.prank(owner);
        uint256 shares = vault.deposit(basket, _amts(7e6, 3), GENESIS, alice);
        assertEq(shares, GENESIS);
        assertEq(vault.balanceOf(alice), GENESIS);
    }

    function test_GenesisReArmsAfterFullRedemption() public {
        _bootstrap();
        vm.prank(bob);
        uint256 bobShares = vault.deposit(basket, _amts(100e6, 0.1e18), 1, bob);
        vm.prank(bob);
        vault.redeem(bobShares, bob);
        vm.prank(owner);
        vault.redeem(GENESIS, owner);
        assertEq(vault.totalSupply(), 0);

        // Supply back at 0: the genesis branch re-arms — owner-gated again, same stored K.
        vm.prank(alice);
        vm.expectRevert(IPoolmigoVault.PoolmigoVault__GenesisNotOwner.selector);
        vault.deposit(basket, _amts(BOOT_USDG, BOOT_WETH), 1, alice);

        vm.prank(owner);
        uint256 shares = vault.deposit(basket, _amts(2 * BOOT_USDG, 2 * BOOT_WETH), GENESIS, owner);
        assertEq(shares, GENESIS);
        assertEq(vault.totalSupply(), GENESIS);
    }

    function test_DepositBootstrapRequiresFullBasketAndNonZero() public {
        address[] memory only = new address[](1);
        only[0] = address(usdg);
        uint256[] memory one = new uint256[](1);
        one[0] = 1e6;

        vm.startPrank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(IPoolmigoVault.PoolmigoVault__MissingBasketToken.selector, address(weth))
        );
        vault.deposit(only, one, 1, owner);
        vm.expectRevert(IPoolmigoVault.PoolmigoVault__ZeroAmount.selector);
        vault.deposit(basket, _amts(BOOT_USDG, 0), 1, owner);
        vm.stopPrank();
    }

    function test_DepositNormalExactRatio() public {
        _bootstrap();
        uint256 bobUsdgBefore = usdg.balanceOf(bob);
        uint256 bobWethBefore = weth.balanceOf(bob);

        // Exactly half the basket -> half the supply, less the virtual-asset haircut: the +1 raw unit on
        // T_usdg (1e9) makes USDG bind at floor(500e6 * (1e21 + 1) / (1e9 + 1)) — 1e-9 relative below
        // K/2. Only the required WETH is pulled (the 5e8-wei excess stays with bob).
        (uint256 pShares, uint256[] memory pReq) = vault.previewDeposit(basket, _amts(500e6, 0.5e18));
        assertEq(pShares, 499_999_999_500_000_000_500);
        assertEq(pReq[0], 500e6);
        assertEq(pReq[1], 499_999_999_500_000_001);
        assertLe(pShares, GENESIS / 2);
        assertApproxEqRel(pShares, GENESIS / 2, 1e9); // within 1e-9

        vm.prank(bob);
        uint256 shares = vault.deposit(basket, _amts(500e6, 0.5e18), 1, bob);
        assertEq(shares, pShares);
        assertEq(vault.balanceOf(bob), pShares);
        assertEq(vault.totalSupply(), GENESIS + pShares);
        assertEq(bobUsdgBefore - usdg.balanceOf(bob), pReq[0]);
        assertEq(bobWethBefore - weth.balanceOf(bob), pReq[1]);
    }

    function test_DepositMinSharesSlippageGuard() public {
        _bootstrap();
        uint256[] memory amounts = _amts(100e6, 0.1e18);
        (uint256 expected,) = vault.previewDeposit(basket, amounts);

        // minShares above the computable count -> revert, and nothing is pulled.
        uint256 bobUsdgBefore = usdg.balanceOf(bob);
        uint256 bobWethBefore = weth.balanceOf(bob);
        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(IPoolmigoVault.PoolmigoVault__InsufficientSharesOut.selector, expected + 1, expected)
        );
        vault.deposit(basket, amounts, expected + 1, bob);
        assertEq(usdg.balanceOf(bob), bobUsdgBefore);
        assertEq(weth.balanceOf(bob), bobWethBefore);

        // minShares equal to the actual count -> passes.
        vm.prank(bob);
        uint256 shares = vault.deposit(basket, amounts, expected, bob);
        assertEq(shares, expected);
        assertEq(vault.balanceOf(bob), expected);
    }

    function test_DepositZeroMinSharesReverts() public {
        // Enforced for everyone, genesis included (the owner knows shares == genesisShares upfront).
        vm.prank(owner);
        vm.expectRevert(IPoolmigoVault.PoolmigoVault__ZeroMinShares.selector);
        vault.deposit(basket, _amts(BOOT_USDG, BOOT_WETH), 0, owner);

        _bootstrap();
        vm.prank(bob);
        vm.expectRevert(IPoolmigoVault.PoolmigoVault__ZeroMinShares.selector);
        vault.deposit(basket, _amts(100e6, 0.1e18), 0, bob);
    }

    function test_DepositNormalPullsOnlyRequired_ReverseOrder() public {
        _bootstrap();
        // Tokens offered in reverse registry order; amounts aligned to the offered order.
        address[] memory rev = new address[](2);
        rev[0] = address(weth);
        rev[1] = address(usdg);
        uint256 bobUsdgBefore = usdg.balanceOf(bob);
        uint256 bobWethBefore = weth.balanceOf(bob);

        // Quarter basket in reverse order: USDG binds (virtual-asset haircut, see ExactRatio).
        vm.prank(bob);
        uint256 shares = vault.deposit(rev, _amts(0.25e18, 250e6), 1, bob);
        assertEq(shares, 249_999_999_750_000_000_250);
        assertEq(bobUsdgBefore - usdg.balanceOf(bob), 250e6);
        assertEq(bobWethBefore - weth.balanceOf(bob), 249_999_999_750_000_001);
    }

    function test_DepositSkewedRatioMinTokenBinds() public {
        _bootstrap();
        uint256 bobUsdgBefore = usdg.balanceOf(bob);
        uint256 bobWethBefore = weth.balanceOf(bob);

        // Offers 600 USDG but only 0.5 WETH: WETH binds -> floor(0.5e18 * (1e21+1) / (1e18+1)) shares;
        // only ceil(shares * (1e9+1) / (1e21+1)) = 500e6 + 1 USDG pulled (the +1 is the virtual-asset
        // rounding in the holders' favour); the ~100 USDG excess is never pulled.
        vm.prank(bob);
        uint256 shares = vault.deposit(basket, _amts(600e6, 0.5e18), 1, bob);
        assertEq(shares, 499_999_999_999_999_999_500);
        assertEq(bobUsdgBefore - usdg.balanceOf(bob), 500e6 + 1, "only required USDG pulled");
        assertEq(bobWethBefore - weth.balanceOf(bob), 0.5e18);
        assertEq(usdg.balanceOf(address(vault)), 1_500e6 + 1);
        assertEq(weth.balanceOf(address(vault)), 1.5e18);

        // Now USDG binds: 100 USDG vs 5 WETH -> only ~0.1 WETH pulled (the ~4.9 WETH excess stays).
        bobUsdgBefore = usdg.balanceOf(bob);
        bobWethBefore = weth.balanceOf(bob);
        vm.prank(bob);
        shares = vault.deposit(basket, _amts(100e6, 5e18), 1, bob);
        assertEq(shares, 99_999_999_866_666_666_811);
        assertEq(bobUsdgBefore - usdg.balanceOf(bob), 100e6);
        assertEq(bobWethBefore - weth.balanceOf(bob), 99_999_999_866_666_667, "only required WETH pulled");
    }

    function test_DepositMissingBasketTokenReverts() public {
        _bootstrap();
        address[] memory only = new address[](1);
        only[0] = address(usdg);
        uint256[] memory one = new uint256[](1);
        one[0] = 100e6;
        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(IPoolmigoVault.PoolmigoVault__MissingBasketToken.selector, address(weth))
        );
        vault.deposit(only, one, 1, bob);

        // Zero amount on a held token is also a miss.
        vm.prank(bob);
        vm.expectRevert(IPoolmigoVault.PoolmigoVault__ZeroAmount.selector);
        vault.deposit(basket, _amts(100e6, 0), 1, bob);
    }

    function test_DepositUnheldRegisteredTokenPullsZero() public {
        _bootstrap();
        MockToken dai = new MockToken("DAI", "DAI", 18);
        vm.prank(owner);
        vault.addToken(address(dai));
        dai.mint(bob, 10e18);
        vm.prank(bob);
        dai.approve(address(vault), type(uint256).max);

        // DAI is registered but T_dai == 0: offering it pulls 0; omitting it is fine too.
        address[] memory three = new address[](3);
        three[0] = address(usdg);
        three[1] = address(weth);
        three[2] = address(dai);
        uint256[] memory a = new uint256[](3);
        a[0] = 100e6;
        a[1] = 0.1e18;
        a[2] = 5e18;
        vm.prank(bob);
        uint256 shares = vault.deposit(three, a, 1, bob);
        assertEq(shares, 99_999_999_900_000_000_100);
        assertEq(dai.balanceOf(bob), 10e18, "DAI never pulled");

        vm.prank(bob);
        shares = vault.deposit(basket, _amts(100e6, 0.1e18), 1, bob);
        assertEq(shares, 99_999_999_900_000_000_100);
    }

    // ---- K-31: exact-delivery pulls — fee-on-transfer / rebasing-up tokens are rejected ----

    function test_Deposit_RevertsOnShortDelivery() public {
        MockBehaviorToken fot = new MockBehaviorToken("FOT", "FOT");
        fot.setBehavior(500, 0); // 5% fee-on-transfer (short delivery)

        // Seed the base basket, then register FOT and leave the vault holding it so its draw is required.
        vm.prank(owner);
        vault.deposit(basket, _amts(BOOT_USDG, BOOT_WETH), GENESIS, owner);
        vm.prank(owner);
        vault.addToken(address(fot));
        fot.mint(address(vault), 1e18);

        address[] memory t3 = new address[](3);
        t3[0] = address(usdg);
        t3[1] = address(weth);
        t3[2] = address(fot);
        uint256[] memory a3 = _amts3(BOOT_USDG, BOOT_WETH, 1_000e18);
        (, uint256[] memory req) = vault.previewDeposit(t3, a3);
        uint256 reqFot = req[2];
        assertGt(reqFot, 0, "FOT draw must be non-dust for this test");

        fot.mint(alice, 1_000e18);
        vm.prank(alice);
        fot.approve(address(vault), type(uint256).max);
        uint256 fee = reqFot * 500 / 10_000;
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                IPoolmigoVault.PoolmigoVault__InexactDelivery.selector, address(fot), reqFot, reqFot - fee
            )
        );
        vault.deposit(t3, a3, 1, alice);
    }

    function test_Deposit_RevertsOnExcessDelivery() public {
        MockBehaviorToken rebase = new MockBehaviorToken("UP", "UP");
        rebase.setBehavior(0, 5000); // +50% minted to the recipient (excess delivery)

        vm.prank(owner);
        vault.deposit(basket, _amts(BOOT_USDG, BOOT_WETH), GENESIS, owner);
        vm.prank(owner);
        vault.addToken(address(rebase));
        rebase.mint(address(vault), 1e18);

        address[] memory t3 = new address[](3);
        t3[0] = address(usdg);
        t3[1] = address(weth);
        t3[2] = address(rebase);
        uint256[] memory a3 = _amts3(BOOT_USDG, BOOT_WETH, 1_000e18);
        (, uint256[] memory req) = vault.previewDeposit(t3, a3);
        uint256 reqUp = req[2];
        assertGt(reqUp, 0, "UP draw must be non-dust for this test");

        rebase.mint(alice, 1_000e18);
        vm.prank(alice);
        rebase.approve(address(vault), type(uint256).max);
        uint256 bonus = reqUp * 5000 / 10_000;
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                IPoolmigoVault.PoolmigoVault__InexactDelivery.selector, address(rebase), reqUp, reqUp + bonus
            )
        );
        vault.deposit(t3, a3, 1, alice);
    }

    function test_GenesisDeposit_RevertsOnShortDelivery() public {
        MockBehaviorToken fot = new MockBehaviorToken("FOT", "FOT");
        fot.setBehavior(200, 0); // 2% fee
        address[] memory t1 = new address[](1);
        t1[0] = address(fot);
        MySunVaultUpgradeable fresh = MySunVaultUpgradeable(_deployVault(t1));

        fot.mint(owner, 100e18);
        vm.prank(owner);
        fot.approve(address(fresh), type(uint256).max);
        uint256[] memory a1 = new uint256[](1);
        a1[0] = 100e18;
        uint256 fee = 100e18 * 200 / 10_000;
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                IPoolmigoVault.PoolmigoVault__InexactDelivery.selector, address(fot), 100e18, 100e18 - fee
            )
        );
        fresh.deposit(t1, a1, GENESIS, owner);
    }

    function test_DepositInputValidation() public {
        _bootstrap();
        MockToken other = new MockToken("OTHER", "OTHER", 18);
        address[] memory unknown = new address[](2);
        unknown[0] = address(usdg);
        unknown[1] = address(other);
        address[] memory dup = new address[](2);
        dup[0] = address(usdg);
        dup[1] = address(usdg);
        uint256[] memory three = new uint256[](3);
        address[] memory none;
        uint256[] memory noAmts;

        vm.startPrank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(IPoolmigoVault.PoolmigoVault__TokenNotRegistered.selector, address(other))
        );
        vault.deposit(unknown, _amts(1e6, 1e18), 1, bob);
        vm.expectRevert(abi.encodeWithSelector(IPoolmigoVault.PoolmigoVault__DuplicateToken.selector, address(usdg)));
        vault.deposit(dup, _amts(1e6, 1e6), 1, bob);
        vm.expectRevert(IPoolmigoVault.PoolmigoVault__LengthMismatch.selector);
        vault.deposit(basket, three, 1, bob);
        vm.expectRevert(IPoolmigoVault.PoolmigoVault__LengthMismatch.selector);
        vault.deposit(none, noAmts, 1, bob);
        vm.expectRevert(IPoolmigoVault.PoolmigoVault__ZeroAddress.selector);
        vault.deposit(basket, _amts(1e6, 1e15), 1, address(0));
        vm.stopPrank();

        // Too small to mint a share. At K = 1_000e18 one WETH wei is already worth 1_000 share-wei, so
        // ZeroShares needs a coarse share scale: a vault seeded with K = 1 gives
        // floor(1 * (1 + VS) / (1e18 + VA)) == 0 on the WETH leg.
        MySunVaultUpgradeable coarse = MySunVaultUpgradeable(_deployVaultWith(basket, 1, 0));
        _approveFor(owner, address(coarse));
        _approveFor(bob, address(coarse));
        vm.prank(owner);
        coarse.deposit(basket, _amts(BOOT_USDG, BOOT_WETH), 1, owner);
        vm.prank(bob);
        vm.expectRevert(IPoolmigoVault.PoolmigoVault__ZeroShares.selector);
        coarse.deposit(basket, _amts(1e6, 1), 1, bob);
    }

    function test_PauseFreezesDepositsAndRedemptions() public {
        _bootstrap();
        vm.prank(keeper);
        vault.deployTo(IPositionAdapter(address(uniV3)), _amts(400e6, 0.4e18));

        vm.prank(owner);
        vault.setPaused(true);

        vm.prank(bob);
        vm.expectRevert(IPoolmigoVault.PoolmigoVault__Paused.selector);
        vault.deposit(basket, _amts(100e6, 0.1e18), 1, bob);

        uint256 shares = vault.balanceOf(owner);
        vm.prank(owner);
        vm.expectRevert(IPoolmigoVault.PoolmigoVault__Paused.selector);
        vault.redeem(shares, owner); // frozen too: the pause is a full safety freeze
        assertEq(vault.balanceOf(owner), shares);

        // Unpausing (owner-only) restores redemptions.
        vm.prank(owner);
        vault.setPaused(false);
        vm.prank(owner);
        vault.redeem(shares, owner);
        assertEq(vault.balanceOf(owner), 0);
        assertEq(usdg.balanceOf(owner), 1_000_000e6);
        assertEq(weth.balanceOf(owner), 1_000e18);
    }

    /*//////////////////////////////////////////////////////////////
                             10-12. REDEEM
    //////////////////////////////////////////////////////////////*/

    function test_RedeemAcrossIdleAndTwoAdapters() public {
        _bootstrap();
        vm.startPrank(keeper);
        vault.deployTo(IPositionAdapter(address(uniV3)), _amts(300e6, 0.3e18));
        vault.deployTo(IPositionAdapter(address(uniV4)), _amts(200e6, 0.2e18));
        vm.stopPrank();
        // Idle: 500 USDG / 0.5 WETH. Bob joins with (just under, virtual-asset haircut) a third of the pot.
        vm.prank(bob);
        uint256 bobShares = vault.deposit(basket, _amts(500e6, 0.5e18), 1, bob);
        assertEq(bobShares, 499_999_999_500_000_000_500);
        assertEq(vault.totalSupply(), GENESIS + bobShares);

        // Adapters are asked for sharesWad = floor(shares * 1e18 / S) — a third, to 1e-18.
        uint256 supply = vault.totalSupply();
        uint256 sharesWad = (bobShares * 1e18) / supply;
        assertEq(sharesWad, 333_333_333_111_111_111);

        (, uint256[] memory owed) = vault.previewRedeem(bobShares);
        // floor(holding * sharesWad / 1e18) per adapter + the vault's exact idle slice; preview mirrors redeem
        // (exact on the linear mock adapters).
        assertEq(owed[0], 499_999_998);
        assertEq(owed[1], 499_999_999_500_000_000);
        // Versus exact pro-rata of the whole basket (floor(shares * T_i / S)): 1 raw unit short on USDG, exact on
        // WETH. Under the former whole-bps fraction (3333 bps) the USDG shortfall was 16_666 units.
        (, uint256[] memory totalsBefore) = vault.totalTokens();
        assertEq((bobShares * totalsBefore[0]) / supply - owed[0], 1);
        assertEq((bobShares * totalsBefore[1]) / supply, owed[1]);

        uint256 bobUsdgBefore = usdg.balanceOf(bob);
        uint256 bobWethBefore = weth.balanceOf(bob);
        vm.prank(bob);
        (address[] memory t, uint256[] memory sent) = vault.redeem(bobShares, bob);

        assertEq(t[0], address(usdg));
        assertEq(t[1], address(weth));
        // Adapters floor the 1e18-scaled slice; the vault sends its exact idle slice; dust stays with holders.
        assertEq(sent[0], owed[0]);
        assertEq(sent[1], owed[1]);
        assertEq(usdg.balanceOf(bob) - bobUsdgBefore, sent[0]);
        assertEq(weth.balanceOf(bob) - bobWethBefore, sent[1]);
        assertEq(vault.balanceOf(bob), 0);
        assertEq(vault.totalSupply(), GENESIS);

        // Adapters shrank by floor(holding * sharesWad / 1e18) each; remaining holders keep exactly the rest.
        (, uint256[] memory a3) = uniV3.position();
        (, uint256[] memory a4) = uniV4.position();
        assertEq(a3[0], 300e6 - (300e6 * sharesWad) / 1e18);
        assertEq(a4[1], 0.2e18 - (0.2e18 * sharesWad) / 1e18);
        assertEq(a3[0], 200_000_001);
        assertEq(a4[1], 133_333_333_377_777_778);
        // Rounding dust (a few raw units, no longer ~1bp of the adapter holdings) stays for the remaining holders.
        (, uint256[] memory totals) = vault.totalTokens();
        assertEq(totals[0], 1_000_000_002);
        assertEq(totals[1], 1_000_000_000_000_000_001);
    }

    function test_RedeemFullSupplyDrainsEverything() public {
        _bootstrap();
        vm.startPrank(keeper);
        vault.deployTo(IPositionAdapter(address(uniV3)), _amts(300e6, 0.3e18));
        vault.deployTo(IPositionAdapter(address(uniV4)), _amts(300e6, 0.3e18));
        vm.stopPrank();

        vm.prank(owner);
        vm.expectEmit(true, true, false, true, address(vault));
        emit IPoolmigoVault.Redeemed(owner, owner, GENESIS, basket, _amts(BOOT_USDG, BOOT_WETH));
        vault.redeem(GENESIS, owner);

        assertEq(vault.totalSupply(), 0);
        assertEq(usdg.balanceOf(owner), 1_000_000e6);
        assertEq(weth.balanceOf(owner), 1_000e18);
        assertEq(usdg.balanceOf(address(vault)), 0);
        assertEq(weth.balanceOf(address(vault)), 0);
        (, uint256[] memory totals) = vault.totalTokens();
        assertEq(totals[0], 0);
        assertEq(totals[1], 0);
    }

    function test_RedeemRevertsOnBadInput() public {
        _bootstrap();
        vm.startPrank(bob); // bob holds no shares
        vm.expectRevert(IPoolmigoVault.PoolmigoVault__ZeroShares.selector);
        vault.redeem(0, bob);
        vm.expectRevert(abi.encodeWithSelector(IPoolmigoVault.PoolmigoVault__InsufficientShares.selector, 0, 1));
        vault.redeem(1, bob);
        vm.stopPrank();

        vm.startPrank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(IPoolmigoVault.PoolmigoVault__InsufficientShares.selector, GENESIS, GENESIS + 1)
        );
        vault.redeem(GENESIS + 1, owner);
        vm.expectRevert(IPoolmigoVault.PoolmigoVault__ZeroAddress.selector);
        vault.redeem(1, address(0));
        vm.stopPrank();
    }

    function test_RedeemToDifferentReceiver() public {
        _bootstrap();
        vm.prank(owner);
        vault.redeem(GENESIS / 10, bob);
        assertEq(usdg.balanceOf(bob), 1_000_000e6 + 100e6);
        assertEq(weth.balanceOf(bob), 1_000e18 + 0.1e18);
        assertEq(vault.balanceOf(owner), GENESIS - GENESIS / 10);
    }

    /*//////////////////////////////////////////////////////////////
                           13-14. REBALANCE
    //////////////////////////////////////////////////////////////*/

    function test_RebalanceHarvestsAllAdaptersAndSkimsFeeInKind() public {
        _bootstrap();
        vm.startPrank(keeper);
        vault.deployTo(IPositionAdapter(address(uniV3)), _amts(500e6, 0.5e18));
        vault.deployTo(IPositionAdapter(address(uniV4)), _amts(500e6, 0.5e18));
        vm.stopPrank();

        uniV3.simulateFees(_amts(60e6, 0.06e18));
        uniV4.simulateFees(_amts(40e6, 0));

        // Uncollected fees already count toward the basket.
        (, uint256[] memory before) = vault.totalTokens();
        assertEq(before[0], 1_100e6);
        assertEq(before[1], 1.06e18);

        uint256[] memory expFees = _amts(15e6, 0.009e18);
        vm.prank(keeper);
        vm.expectEmit(true, false, false, true, address(vault));
        emit IPoolmigoVault.PerformanceFeeAccrued(treasury, basket, expFees);
        vm.expectEmit(true, false, false, true, address(vault));
        emit IPoolmigoVault.Rebalanced(keeper, basket, _amts(100e6, 0.06e18), expFees);
        (address[] memory t, uint256[] memory harvested, uint256[] memory fees) = vault.rebalance();

        assertEq(t[0], address(usdg));
        assertEq(t[1], address(weth));
        assertEq(harvested[0], 100e6);
        assertEq(harvested[1], 0.06e18);
        assertEq(fees[0], 15e6); // 15% of 100 USDG across both pools
        assertEq(fees[1], 0.009e18); // 15% of 0.06 WETH
        assertEq(usdg.balanceOf(treasury), 15e6);
        assertEq(weth.balanceOf(treasury), 0.009e18);
        // Vault keeps the rest idle; principal untouched in positions.
        assertEq(usdg.balanceOf(address(vault)), 85e6);
        assertEq(weth.balanceOf(address(vault)), 0.051e18);
        (, uint256[] memory a3) = uniV3.position();
        assertEq(a3[0], 500e6);
        assertEq(a3[1], 0.5e18);
        (, uint256[] memory totals) = vault.totalTokens();
        assertEq(totals[0], 1_085e6);
        assertEq(totals[1], 1.051e18);
    }

    function test_RebalanceZeroFeeBps() public {
        _bootstrap();
        vm.prank(owner);
        vault.setPerformanceFeeBps(0);
        uniV3.simulateFees(_amts(10e6, 0));
        vm.prank(keeper);
        (, uint256[] memory harvested, uint256[] memory fees) = vault.rebalance();
        assertEq(harvested[0], 10e6);
        assertEq(fees[0], 0);
        assertEq(usdg.balanceOf(treasury), 0);
        assertEq(usdg.balanceOf(address(vault)), BOOT_USDG + 10e6);
    }

    function test_RebalanceNotKeeperReverts() public {
        vm.prank(alice);
        vm.expectRevert(IPoolmigoVault.PoolmigoVault__NotKeeper.selector);
        vault.rebalance();
    }

    function test_RebalanceWhilePausedReverts() public {
        vm.prank(owner);
        vault.setPaused(true);
        vm.prank(keeper);
        vm.expectRevert(IPoolmigoVault.PoolmigoVault__Paused.selector);
        vault.rebalance();
    }

    function test_RebalanceNoAdaptersReverts() public {
        MySunVaultUpgradeable fresh = MySunVaultUpgradeable(_deployVault(basket));
        vm.prank(owner);
        fresh.setKeeper(keeper, true);
        vm.prank(keeper);
        vm.expectRevert(IPoolmigoVault.PoolmigoVault__NoAdapters.selector);
        fresh.rebalance();
    }

    /*//////////////////////////////////////////////////////////////
                              15. deployTo
    //////////////////////////////////////////////////////////////*/

    function test_DeployToMovesIdleAndCleansApprovals() public {
        _bootstrap();
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true, address(vault));
        emit IPoolmigoVault.Deployed(keeper, address(uniV3), basket, _amts(400e6, 0.4e18));
        vault.deployTo(IPositionAdapter(address(uniV3)), _amts(400e6, 0.4e18));

        // Adapter saw exactly the approved amounts at pull time; approvals are zero afterwards.
        assertEq(uniV3.allowanceSeenOnDeploy(0), 400e6);
        assertEq(uniV3.allowanceSeenOnDeploy(1), 0.4e18);
        assertEq(usdg.allowance(address(vault), address(uniV3)), 0);
        assertEq(weth.allowance(address(vault), address(uniV3)), 0);

        assertEq(usdg.balanceOf(address(vault)), 600e6);
        assertEq(weth.balanceOf(address(vault)), 0.6e18);
        (, uint256[] memory a3) = uniV3.position();
        assertEq(a3[0], 400e6);
        assertEq(a3[1], 0.4e18);
        (, uint256[] memory totals) = vault.totalTokens();
        assertEq(totals[0], BOOT_USDG);
        assertEq(totals[1], BOOT_WETH);
    }

    function test_DeployToReverts() public {
        _bootstrap();
        MockPositionAdapter rogue = new MockPositionAdapter(basket, address(vault), DEX_V3, bytes32(uint256(7)));
        uint256[] memory three = new uint256[](3);

        vm.prank(alice);
        vm.expectRevert(IPoolmigoVault.PoolmigoVault__NotKeeper.selector);
        vault.deployTo(IPositionAdapter(address(uniV3)), _amts(1e6, 0));

        vm.startPrank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(IPoolmigoVault.PoolmigoVault__AdapterNotRegistered.selector, address(rogue))
        );
        vault.deployTo(IPositionAdapter(address(rogue)), _amts(1e6, 0));
        vm.expectRevert(IPoolmigoVault.PoolmigoVault__LengthMismatch.selector);
        vault.deployTo(IPositionAdapter(address(uniV3)), three);
        vm.expectRevert(
            abi.encodeWithSelector(
                IPoolmigoVault.PoolmigoVault__InsufficientIdle.selector, address(weth), BOOT_WETH, BOOT_WETH + 1
            )
        );
        vault.deployTo(IPositionAdapter(address(uniV3)), _amts(1e6, BOOT_WETH + 1));
        vm.stopPrank();

        vm.prank(owner);
        vault.setPaused(true);
        vm.prank(keeper);
        vm.expectRevert(IPoolmigoVault.PoolmigoVault__Paused.selector);
        vault.deployTo(IPositionAdapter(address(uniV3)), _amts(1e6, 0));
    }

    /*//////////////////////////////////////////////////////////////
                            16. removeAdapter
    //////////////////////////////////////////////////////////////*/

    function test_RemoveAdapterRevertsIfFundedThenWorksAfterUnwind() public {
        _bootstrap();
        vm.prank(keeper);
        vault.deployTo(IPositionAdapter(address(uniV3)), _amts(500e6, 0.5e18));

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                IPoolmigoVault.PoolmigoVault__AdapterStillFunded.selector, address(uniV3), address(usdg), 500e6
            )
        );
        vault.removeAdapter(IPositionAdapter(address(uniV3)));

        // Uncollected fees alone also count as funded.
        vm.prank(owner);
        vault.emergencyUnwind();
        uniV4.simulateFees(_amts(0, 1));
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                IPoolmigoVault.PoolmigoVault__AdapterStillFunded.selector, address(uniV4), address(weth), 1
            )
        );
        vault.removeAdapter(IPositionAdapter(address(uniV4)));

        vm.prank(owner);
        vm.expectEmit(true, false, false, false, address(vault));
        emit IPoolmigoVault.AdapterRemoved(address(uniV3));
        vault.removeAdapter(IPositionAdapter(address(uniV3)));
        assertFalse(vault.isAdapter(address(uniV3)));
        assertEq(vault.adapterCount(), 1);
        assertEq(address(vault.adapterAt(0)), address(uniV4)); // swap-and-pop

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(IPoolmigoVault.PoolmigoVault__AdapterNotRegistered.selector, address(uniV3))
        );
        vault.removeAdapter(IPositionAdapter(address(uniV3)));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, alice));
        vault.removeAdapter(IPositionAdapter(address(uniV4)));
    }

    /*//////////////////////////////////////////////////////////////
                          17. emergencyUnwind
    //////////////////////////////////////////////////////////////*/

    function test_EmergencyUnwindPullsAllPositionsAndPauses() public {
        _bootstrap();
        vm.startPrank(keeper);
        vault.deployTo(IPositionAdapter(address(uniV3)), _amts(500e6, 0.5e18));
        vault.deployTo(IPositionAdapter(address(uniV4)), _amts(400e6, 0.4e18));
        vm.stopPrank();
        uniV4.simulateFees(_amts(10e6, 0));

        vm.prank(alice);
        vm.expectRevert(IPoolmigoVault.PoolmigoVault__NotRiskManager.selector);
        vault.emergencyUnwind();

        vm.prank(owner);
        vm.expectEmit(false, false, false, true, address(vault));
        emit IPoolmigoVault.PausedSet(true);
        vm.expectEmit(true, false, false, true, address(vault));
        emit IPoolmigoVault.EmergencyUnwound(owner, basket, _amts(910e6, 0.9e18));
        (address[] memory t, uint256[] memory unwound) = vault.emergencyUnwind();

        assertEq(t[0], address(usdg));
        assertEq(unwound[0], 910e6);
        assertEq(unwound[1], 0.9e18);
        assertTrue(vault.paused());
        assertEq(usdg.balanceOf(address(vault)), 1_010e6);
        assertEq(weth.balanceOf(address(vault)), 1e18);
        (, uint256[] memory a3) = uniV3.position();
        (, uint256[] memory a4) = uniV4.position();
        assertEq(a3[0] + a3[1] + a4[0] + a4[1], 0);
        assertEq(usdg.balanceOf(address(uniV3)) + usdg.balanceOf(address(uniV4)), 0);
    }

    /*//////////////////////////////////////////////////////////////
                    17b. RISK MANAGERS (pause + unwind)
    //////////////////////////////////////////////////////////////*/

    function test_SetRiskManager() public {
        address rm1 = makeAddr("rm1");
        address rm2 = makeAddr("rm2");
        assertFalse(vault.isRiskManager(rm1));

        vm.startPrank(owner);
        vm.expectEmit(true, false, false, true, address(vault));
        emit IPoolmigoVault.RiskManagerSet(rm1, true);
        vault.setRiskManager(rm1, true);
        vm.expectEmit(true, false, false, true, address(vault));
        emit IPoolmigoVault.RiskManagerSet(rm2, true);
        vault.setRiskManager(rm2, true);
        assertTrue(vault.isRiskManager(rm1));
        assertTrue(vault.isRiskManager(rm2));

        vm.expectEmit(true, false, false, true, address(vault));
        emit IPoolmigoVault.RiskManagerSet(rm1, false);
        vault.setRiskManager(rm1, false);
        assertFalse(vault.isRiskManager(rm1));
        assertTrue(vault.isRiskManager(rm2));

        vm.expectRevert(IPoolmigoVault.PoolmigoVault__ZeroAddress.selector);
        vault.setRiskManager(address(0), true);
        vm.stopPrank();
        assertFalse(vault.isKeeper(rm2)); // separate role from keeper
    }

    function test_SetRiskManagerOnlyOwner() public {
        address rm = _addRiskManager("rm");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, alice));
        vault.setRiskManager(alice, true);
        // a risk manager cannot manage the role either
        vm.prank(rm);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, rm));
        vault.setRiskManager(alice, true);
        assertFalse(vault.isRiskManager(alice));
    }

    function test_RiskManagerCanPause() public {
        address rm = _addRiskManager("rm");
        _bootstrap();
        vm.prank(keeper);
        vault.deployTo(IPositionAdapter(address(uniV3)), _amts(400e6, 0.4e18));

        vm.prank(rm);
        vm.expectEmit(false, false, false, true, address(vault));
        emit IPoolmigoVault.PausedSet(true);
        vault.pause();
        assertTrue(vault.paused());

        vm.prank(bob);
        vm.expectRevert(IPoolmigoVault.PoolmigoVault__Paused.selector);
        vault.deposit(basket, _amts(100e6, 0.1e18), 1, bob);
        vm.startPrank(keeper);
        vm.expectRevert(IPoolmigoVault.PoolmigoVault__Paused.selector);
        vault.deployTo(IPositionAdapter(address(uniV3)), _amts(1e6, 0));
        vm.expectRevert(IPoolmigoVault.PoolmigoVault__Paused.selector);
        vault.pullFrom(IPositionAdapter(address(uniV3)), 2_500);
        vm.expectRevert(IPoolmigoVault.PoolmigoVault__Paused.selector);
        vault.rebalance();
        vm.stopPrank();

        uint256 shares = vault.balanceOf(owner);
        vm.prank(owner);
        vm.expectRevert(IPoolmigoVault.PoolmigoVault__Paused.selector);
        vault.redeem(shares, owner); // frozen too — the pause blocks every flow
        assertEq(vault.balanceOf(owner), shares);
    }

    function test_PauseIdempotent() public {
        address rm1 = _addRiskManager("rm1");
        address rm2 = _addRiskManager("rm2");
        vm.prank(rm1);
        vault.pause();

        // Racing alerting services / the owner: no revert, no second event.
        vm.recordLogs();
        vm.prank(rm2);
        vault.pause();
        vm.prank(owner);
        vault.pause();
        assertEq(vm.getRecordedLogs().length, 0);
        assertTrue(vault.paused());
    }

    function test_OwnerCanPause() public {
        vm.prank(owner);
        vm.expectEmit(false, false, false, true, address(vault));
        emit IPoolmigoVault.PausedSet(true);
        vault.pause();
        assertTrue(vault.paused());
    }

    function test_RiskManagerCannotUnpause() public {
        address rm = _addRiskManager("rm");
        vm.startPrank(rm);
        vault.pause();
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, rm));
        vault.setPaused(false);
        vm.stopPrank();
        assertTrue(vault.paused());
    }

    function test_RiskManagerCannotCallOwnerSurface() public {
        address rm = _addRiskManager("rm");
        bytes memory unauthorized = abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, rm);
        vm.startPrank(rm);
        vm.expectRevert(unauthorized);
        vault.setPaused(true);
        vm.expectRevert(unauthorized);
        vault.setKeeper(rm, true);
        vm.expectRevert(unauthorized);
        vault.setTreasury(rm);
        vm.expectRevert(unauthorized);
        vault.setPerformanceFeeBps(1);
        vm.expectRevert(unauthorized);
        vault.setMaxTotalSupply(1);
        vm.expectRevert(unauthorized);
        vault.addToken(makeAddr("token3"));
        vm.expectRevert(unauthorized);
        vault.removeAdapter(IPositionAdapter(address(uniV3)));
        vm.expectRevert(unauthorized);
        vault.forceRemoveAdapter(IPositionAdapter(address(uniV3)));
        // ... nor keeper flows
        vm.expectRevert(IPoolmigoVault.PoolmigoVault__NotKeeper.selector);
        vault.rebalance();
        vm.expectRevert(IPoolmigoVault.PoolmigoVault__NotKeeper.selector);
        vault.pullFrom(IPositionAdapter(address(uniV3)), 2_500);
        vm.stopPrank();
    }

    function test_NonRiskManagerCannotPauseOrUnwind() public {
        address[2] memory callers = [alice, keeper];
        for (uint256 i; i < callers.length; ++i) {
            vm.startPrank(callers[i]);
            vm.expectRevert(IPoolmigoVault.PoolmigoVault__NotRiskManager.selector);
            vault.pause();
            vm.expectRevert(IPoolmigoVault.PoolmigoVault__NotRiskManager.selector);
            vault.emergencyUnwind();
            vm.stopPrank();
        }
        assertFalse(vault.paused());
    }

    function test_RiskManagerEmergencyUnwind() public {
        address rm = _addRiskManager("rm");
        _bootstrap();
        vm.startPrank(keeper);
        vault.deployTo(IPositionAdapter(address(uniV3)), _amts(500e6, 0.5e18));
        vault.deployTo(IPositionAdapter(address(uniV4)), _amts(400e6, 0.4e18));
        vm.stopPrank();
        uniV4.simulateFees(_amts(10e6, 0));

        vm.prank(rm);
        vm.expectEmit(false, false, false, true, address(vault));
        emit IPoolmigoVault.PausedSet(true);
        vm.expectEmit(true, false, false, true, address(vault));
        emit IPoolmigoVault.EmergencyUnwound(rm, basket, _amts(910e6, 0.9e18));
        (, uint256[] memory unwound) = vault.emergencyUnwind();

        assertEq(unwound[0], 910e6);
        assertEq(unwound[1], 0.9e18);
        assertTrue(vault.paused());
        assertEq(usdg.balanceOf(address(vault)), 1_010e6);
        assertEq(weth.balanceOf(address(vault)), 1e18);
        (, uint256[] memory a3) = uniV3.position();
        (, uint256[] memory a4) = uniV4.position();
        assertEq(a3[0] + a3[1] + a4[0] + a4[1], 0);
        assertEq(usdg.balanceOf(rm) + weth.balanceOf(rm), 0); // nothing leaves the vault
    }

    function test_RemovedRiskManagerLosesRights() public {
        address rm = _addRiskManager("rm");
        vm.prank(owner);
        vault.setRiskManager(rm, false);

        vm.startPrank(rm);
        vm.expectRevert(IPoolmigoVault.PoolmigoVault__NotRiskManager.selector);
        vault.pause();
        vm.expectRevert(IPoolmigoVault.PoolmigoVault__NotRiskManager.selector);
        vault.emergencyUnwind();
        vm.stopPrank();
        assertFalse(vault.paused());
    }

    function test_UnpauseByOwnerResumesFlows() public {
        address rm = _addRiskManager("rm");
        _bootstrap();
        vm.prank(rm);
        vault.pause();

        vm.prank(owner);
        vm.expectEmit(false, false, false, true, address(vault));
        emit IPoolmigoVault.PausedSet(false);
        vault.setPaused(false);
        assertFalse(vault.paused());

        vm.prank(keeper);
        vault.deployTo(IPositionAdapter(address(uniV3)), _amts(400e6, 0.4e18));
        (, uint256[] memory a3) = uniV3.position();
        assertEq(a3[0], 400e6);

        vm.prank(rm);
        vm.expectEmit(false, false, false, true, address(vault));
        emit IPoolmigoVault.PausedSet(true);
        vault.pause();
        assertTrue(vault.paused());
    }

    /*//////////////////////////////////////////////////////////////
                            18. totalTokens
    //////////////////////////////////////////////////////////////*/

    function test_TotalTokensSumsIdleAndAdapters() public {
        (address[] memory t0, uint256[] memory z) = vault.totalTokens();
        assertEq(t0.length, 2);
        assertEq(z[0] + z[1], 0);

        _bootstrap();
        vm.startPrank(keeper);
        vault.deployTo(IPositionAdapter(address(uniV3)), _amts(300e6, 0.1e18));
        vault.deployTo(IPositionAdapter(address(uniV4)), _amts(200e6, 0.2e18));
        vm.stopPrank();
        uniV3.simulateFees(_amts(7e6, 0.003e18));

        (address[] memory t, uint256[] memory totals) = vault.totalTokens();
        assertEq(t[0], address(usdg));
        assertEq(t[1], address(weth));
        assertEq(totals[0], 500e6 + 300e6 + 200e6 + 7e6);
        assertEq(totals[1], 0.7e18 + 0.1e18 + 0.2e18 + 0.003e18);
    }

    /*//////////////////////////////////////////////////////////////
                             OWNER SETTERS
    //////////////////////////////////////////////////////////////*/

    function test_OwnerSetters() public {
        address t2 = makeAddr("treasury2");
        vm.startPrank(owner);
        vm.expectEmit(true, true, false, false, address(vault));
        emit IPoolmigoVault.TreasurySet(treasury, t2);
        vault.setTreasury(t2);
        assertEq(vault.treasury(), t2);
        vm.expectRevert(IPoolmigoVault.PoolmigoVault__ZeroAddress.selector);
        vault.setTreasury(address(0));

        vm.expectEmit(false, false, false, true, address(vault));
        emit IPoolmigoVault.PerformanceFeeSet(FEE_BPS, 3000);
        vault.setPerformanceFeeBps(3000);
        assertEq(vault.performanceFeeBps(), 3000);
        vm.expectRevert(abi.encodeWithSelector(IPoolmigoVault.PoolmigoVault__FeeTooHigh.selector, 3001, 3000));
        vault.setPerformanceFeeBps(3001);

        vm.expectEmit(true, false, false, true, address(vault));
        emit IPoolmigoVault.KeeperSet(keeper, false);
        vault.setKeeper(keeper, false);
        assertFalse(vault.isKeeper(keeper));
        vm.expectRevert(IPoolmigoVault.PoolmigoVault__ZeroAddress.selector);
        vault.setKeeper(address(0), true);

        vault.setPaused(true);
        assertTrue(vault.paused());
        vault.setPaused(false);
        assertFalse(vault.paused());
        vm.stopPrank();

        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, alice));
        vault.setTreasury(alice);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, alice));
        vault.setPerformanceFeeBps(1);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, alice));
        vault.setKeeper(alice, true);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, alice));
        vault.setPaused(true);
        vm.stopPrank();
    }

    function test_Ownable2Step() public {
        vm.prank(owner);
        vault.transferOwnership(bob);
        assertEq(vault.owner(), owner);
        assertEq(vault.pendingOwner(), bob);
        vm.prank(bob);
        vault.acceptOwnership();
        assertEq(vault.owner(), bob);
    }

    /*//////////////////////////////////////////////////////////////
                          19. UPGRADE PATH (UUPS)
    //////////////////////////////////////////////////////////////*/

    function test_UpgradePreservesStateAndAddsFeature() public {
        _bootstrap();
        vm.startPrank(keeper);
        vault.deployTo(IPositionAdapter(address(uniV3)), _amts(500e6, 0.5e18));
        vault.deployTo(IPositionAdapter(address(uniV4)), _amts(300e6, 0.3e18));
        vm.stopPrank();

        vm.prank(owner);
        vault.setMaxTotalSupply(5_000e18);

        uint256 sharesBefore = vault.balanceOf(owner);
        (, uint256[] memory totalsBefore) = vault.totalTokens();
        uint256 adaptersBefore = vault.adapterCount();
        address[] memory tokensBefore = vault.tokens();

        // The reinitializer(2) intentionally does NOT re-call parent initializers (they ran in the
        // base initialize; re-calling would revert/reset). Narrowly allow the validator's
        // "missing-initializer-call" check for this known-safe reinitializer pattern.
        Options memory opts;
        opts.unsafeAllow = "missing-initializer,missing-initializer-call";
        vm.startPrank(owner);
        Upgrades.upgradeProxy(
            address(vault),
            "MySunVaultUpgradeExample.sol",
            abi.encodeCall(MySunVaultUpgradeExample.initializeExample, (3600)),
            opts
        );
        vm.stopPrank();

        MySunVaultUpgradeExample upgraded = MySunVaultUpgradeExample(address(vault));

        // State preserved across the upgrade (same proxy, same storage).
        assertEq(upgraded.balanceOf(owner), sharesBefore);
        assertEq(upgraded.totalSupply(), sharesBefore);
        (, uint256[] memory totalsAfter) = upgraded.totalTokens();
        assertEq(totalsAfter[0], totalsBefore[0]);
        assertEq(totalsAfter[1], totalsBefore[1]);
        assertEq(upgraded.adapterCount(), adaptersBefore);
        assertEq(upgraded.tokens().length, tokensBefore.length);
        assertEq(upgraded.tokens()[0], tokensBefore[0]);
        assertEq(upgraded.tokens()[1], tokensBefore[1]);
        assertEq(upgraded.treasury(), treasury);
        assertEq(upgraded.performanceFeeBps(), FEE_BPS);
        assertEq(upgraded.owner(), owner);
        assertTrue(upgraded.isKeeper(keeper));
        assertEq(upgraded.genesisShares(), GENESIS);
        assertEq(upgraded.maxTotalSupply(), 5_000e18);
        assertEq(upgraded.name(), "sunEthLP");

        // The example's new functionality works: the reinitializer wrote the field into the fixture's OWN namespace.
        // (P3 trimmed the test-only fixture to fit EIP-170 — version()/setter gone; the fix round dropped its getter too.)
        assertEq(
            uint256(vm.load(address(vault), 0xcca7159ac201d617b51ce7033b4f9c4a1b9f7200d111d0202b4a866e29c27b00)),
            3600,
            "namespaced slot"
        );
        // The one-shot reinitializer is spent (owner call reverts) and owner-gated (third party reverts).
        vm.prank(owner);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        upgraded.initializeExample(1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, alice));
        upgraded.initializeExample(1);

        // Base behaviour still works post-upgrade: the keeper pulls a slice back, then the genesis holder
        // redeems everything in kind across both pools.
        vm.prank(keeper);
        upgraded.pullFrom(IPositionAdapter(address(uniV3)), 5_000);
        vm.prank(owner);
        upgraded.redeem(sharesBefore, owner);
        assertEq(usdg.balanceOf(owner), 1_000_000e6);
        assertEq(weth.balanceOf(owner), 1_000e18);
    }

    function test_UpgradeOnlyOwner() public {
        MySunVaultUpgradeExample newImpl = new MySunVaultUpgradeExample();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, alice));
        vault.upgradeToAndCall(address(newImpl), "");
    }

    /*//////////////////////////////////////////////////////////////
                             FUZZ (STATELESS)
    //////////////////////////////////////////////////////////////*/

    /// @dev Deposit at an arbitrary offered ratio: required <= offered on both legs, the binding leg is
    ///      pulled at (nearly) its full offer, and redeeming returns the pulled amounts within adapter dust.
    function testFuzz_DepositThenRedeemRoundTrips(uint256 offerUsdg, uint256 offerWeth, uint256 splitBps) public {
        offerUsdg = bound(offerUsdg, 1e6, 500_000e6);
        offerWeth = bound(offerWeth, 1e15, 500e18);
        splitBps = bound(splitBps, 0, BPS);

        _bootstrap();
        vm.startPrank(keeper);
        vault.deployTo(
            IPositionAdapter(address(uniV3)), _amts((BOOT_USDG * splitBps) / BPS, (BOOT_WETH * splitBps) / BPS)
        );
        vm.stopPrank();

        (uint256 pShares, uint256[] memory req) = vault.previewDeposit(basket, _amts(offerUsdg, offerWeth));
        assertLe(req[0], offerUsdg);
        assertLe(req[1], offerWeth);
        // Same-proportion invariant: required legs mirror the basket ratio (ceil rounding), priced with
        // the deposit-side virtuals: ceil(shares * (T + VA) / (S + VS)).
        assertEq(req[0], _ceilMulDiv(pShares, BOOT_USDG + VA, GENESIS + VS));
        assertEq(req[1], _ceilMulDiv(pShares, BOOT_WETH + VA, GENESIS + VS));

        uint256 u0 = usdg.balanceOf(bob);
        uint256 w0 = weth.balanceOf(bob);
        vm.prank(bob);
        uint256 shares = vault.deposit(basket, _amts(offerUsdg, offerWeth), 1, bob);
        assertEq(shares, pShares);
        assertEq(u0 - usdg.balanceOf(bob), req[0]);
        assertEq(w0 - weth.balanceOf(bob), req[1]);

        vm.prank(bob);
        (, uint256[] memory sent) = vault.redeem(shares, bob);
        assertEq(vault.balanceOf(bob), 0);
        // Rounding dust (floor on redeem / ceil on deposit / adapter floor) stays in the vault.
        assertLe(sent[0], req[0]);
        assertLe(sent[1], req[1]);
        // Rounding dust stays in the vault for the remaining holders. Bound (x = exact pro-rata shares * T'_i / S'):
        //   req - x < 2 (ceil on deposit + the VA haircut, < shares / (S + shares) < 1);
        //   x - sent < H / 1e18 + 2 (adapter: floor of sharesWad costs < H / 1e18, floor of the slice < 1;
        //   idle: floor < 1) — so req - sent <= H / 1e18 + 3 (was H / 10_000 + 2 under the bps fraction).
        assertApproxEqAbs(sent[0], req[0], ((BOOT_USDG * splitBps) / BPS) / 1e18 + 3);
        assertApproxEqAbs(sent[1], req[1], ((BOOT_WETH * splitBps) / BPS) / 1e18 + 3);
    }

    /*//////////////////////////////////////////////////////////////
                    BATCH 2 — SUPPLY CAP (PRD F1.2)
    //////////////////////////////////////////////////////////////*/

    function test_SupplyCapEnforcedOnDepositAndPreview() public {
        uint256 cap = GENESIS + 100e18;
        MySunVaultUpgradeable v = MySunVaultUpgradeable(_deployVaultWith(basket, GENESIS, cap));
        _approveFor(owner, address(v));
        _approveFor(bob, address(v));
        assertEq(v.maxTotalSupply(), cap);
        vm.prank(owner);
        v.deposit(basket, _amts(BOOT_USDG, BOOT_WETH), GENESIS, owner);

        // ~500e18 shares would push supply past the cap: preview and deposit revert identically.
        uint256 newSupply = GENESIS + 499_999_999_500_000_000_500;
        bytes memory capErr =
            abi.encodeWithSelector(IPoolmigoVault.PoolmigoVault__SupplyCapExceeded.selector, newSupply, cap);
        vm.expectRevert(capErr);
        v.previewDeposit(basket, _amts(500e6, 0.5e18));
        uint256 bobUsdgBefore = usdg.balanceOf(bob);
        vm.prank(bob);
        vm.expectRevert(capErr);
        v.deposit(basket, _amts(500e6, 0.5e18), 1, bob);
        assertEq(usdg.balanceOf(bob), bobUsdgBefore, "nothing pulled on a cap revert");

        // Under the cap: fine.
        vm.prank(bob);
        uint256 shares = v.deposit(basket, _amts(100e6, 0.1e18), 1, bob);
        assertLe(v.totalSupply(), cap);
        assertEq(v.totalSupply(), GENESIS + shares);

        // Raise, then the previously-rejected deposit goes through.
        vm.prank(owner);
        vm.expectEmit(false, false, false, true, address(v));
        emit IPoolmigoVault.MaxTotalSupplySet(cap, 2_000e18);
        v.setMaxTotalSupply(2_000e18);
        vm.prank(bob);
        v.deposit(basket, _amts(500e6, 0.5e18), 1, bob);

        // 0 = uncapped: a deposit far above the old cap succeeds.
        vm.prank(owner);
        v.setMaxTotalSupply(0);
        vm.prank(bob);
        v.deposit(basket, _amts(100_000e6, 100e18), 1, bob);
        assertGt(v.totalSupply(), 2_000e18);
    }

    function test_SupplyCapIncludesGenesis() public {
        // cap == K is valid at init; genesis lands exactly on the cap; the next deposit is rejected.
        MySunVaultUpgradeable v = MySunVaultUpgradeable(_deployVaultWith(basket, GENESIS, GENESIS));
        _approveFor(owner, address(v));
        _approveFor(bob, address(v));
        vm.prank(owner);
        v.deposit(basket, _amts(BOOT_USDG, BOOT_WETH), GENESIS, owner);
        assertEq(v.totalSupply(), GENESIS);
        vm.prank(bob);
        vm.expectPartialRevert(IPoolmigoVault.PoolmigoVault__SupplyCapExceeded.selector);
        v.deposit(basket, _amts(1e6, 1e15), 1, bob);

        // A cap lowered below K while supply is 0 blocks the genesis mint itself.
        vm.prank(owner);
        vault.setMaxTotalSupply(GENESIS - 1);
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(IPoolmigoVault.PoolmigoVault__SupplyCapExceeded.selector, GENESIS, GENESIS - 1)
        );
        vault.deposit(basket, _amts(BOOT_USDG, BOOT_WETH), GENESIS, owner);
    }

    function test_SetMaxTotalSupplyRules() public {
        _bootstrap();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, alice));
        vault.setMaxTotalSupply(10_000e18);

        // Below current supply would brick deposits -> rejected. Equal to supply is allowed.
        vm.startPrank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(IPoolmigoVault.PoolmigoVault__InvalidSupplyCap.selector, GENESIS - 1, GENESIS)
        );
        vault.setMaxTotalSupply(GENESIS - 1);
        vm.expectEmit(false, false, false, true, address(vault));
        emit IPoolmigoVault.MaxTotalSupplySet(0, GENESIS);
        vault.setMaxTotalSupply(GENESIS);
        assertEq(vault.maxTotalSupply(), GENESIS);
        vm.stopPrank();

        // Redemptions are never affected by the cap.
        vm.prank(owner);
        vault.redeem(GENESIS / 2, owner);
        assertEq(vault.totalSupply(), GENESIS / 2);
    }

    /*//////////////////////////////////////////////////////////////
                         BATCH 2 — KEEPER pullFrom
    //////////////////////////////////////////////////////////////*/

    function test_PullFromMovesSliceToIdle() public {
        _bootstrap();
        vm.prank(keeper);
        vault.deployTo(IPositionAdapter(address(uniV3)), _amts(400e6, 0.4e18));
        (, uint256[] memory totalsBefore) = vault.totalTokens();
        uint256 idleU = usdg.balanceOf(address(vault));
        uint256 idleW = weth.balanceOf(address(vault));
        uint256 keeperU = usdg.balanceOf(keeper);

        vm.prank(keeper);
        vm.expectEmit(true, true, false, true, address(vault));
        emit IPoolmigoVault.PulledFrom(keeper, address(uniV3), 2_500, basket, _amts(100e6, 0.1e18));
        (address[] memory t, uint256[] memory got) = vault.pullFrom(IPositionAdapter(address(uniV3)), 2_500);

        assertEq(t[0], address(usdg));
        assertEq(got[0], 100e6);
        assertEq(got[1], 0.1e18);
        // Idle grew by exactly the adapter's slice; the adapter shrank by it; basket totals unchanged.
        assertEq(usdg.balanceOf(address(vault)) - idleU, 100e6);
        assertEq(weth.balanceOf(address(vault)) - idleW, 0.1e18);
        (, uint256[] memory a3) = uniV3.position();
        assertEq(a3[0], 300e6);
        assertEq(a3[1], 0.3e18);
        (, uint256[] memory totalsAfter) = vault.totalTokens();
        assertEq(totalsAfter[0], totalsBefore[0]);
        assertEq(totalsAfter[1], totalsBefore[1]);
        // Destination is hard-wired to the vault: nothing reached the caller.
        assertEq(usdg.balanceOf(keeper), keeperU);
    }

    function test_PullFromFullDrainsAdapter() public {
        _bootstrap();
        vm.prank(keeper);
        vault.deployTo(IPositionAdapter(address(uniV3)), _amts(400e6, 0.4e18));
        uniV3.simulateFees(_amts(3e6, 0)); // uncollected fees come back too

        vm.prank(keeper);
        vault.pullFrom(IPositionAdapter(address(uniV3)), 10_000);
        (, uint256[] memory a3) = uniV3.position();
        assertEq(a3[0] + a3[1], 0);
        assertEq(usdg.balanceOf(address(uniV3)) + weth.balanceOf(address(uniV3)), 0);
        assertEq(usdg.balanceOf(address(vault)), BOOT_USDG + 3e6);
        assertEq(weth.balanceOf(address(vault)), BOOT_WETH);
    }

    function test_PullFromReverts() public {
        _bootstrap();
        vm.prank(keeper);
        vault.deployTo(IPositionAdapter(address(uniV3)), _amts(400e6, 0.4e18));
        MockPositionAdapter rogue = new MockPositionAdapter(basket, address(vault), DEX_V3, bytes32(uint256(7)));

        vm.prank(alice);
        vm.expectRevert(IPoolmigoVault.PoolmigoVault__NotKeeper.selector);
        vault.pullFrom(IPositionAdapter(address(uniV3)), 2_500);
        vm.prank(owner); // not even the owner: keeper-only
        vm.expectRevert(IPoolmigoVault.PoolmigoVault__NotKeeper.selector);
        vault.pullFrom(IPositionAdapter(address(uniV3)), 2_500);

        vm.startPrank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IPoolmigoVault.PoolmigoVault__InvalidSharesBps.selector, 0));
        vault.pullFrom(IPositionAdapter(address(uniV3)), 0);
        vm.expectRevert(abi.encodeWithSelector(IPoolmigoVault.PoolmigoVault__InvalidSharesBps.selector, 10_001));
        vault.pullFrom(IPositionAdapter(address(uniV3)), 10_001);
        vm.expectRevert(
            abi.encodeWithSelector(IPoolmigoVault.PoolmigoVault__AdapterNotRegistered.selector, address(rogue))
        );
        vault.pullFrom(IPositionAdapter(address(rogue)), 2_500);
        vm.stopPrank();

        vm.prank(owner);
        vault.setPaused(true);
        vm.prank(keeper);
        vm.expectRevert(IPoolmigoVault.PoolmigoVault__Paused.selector);
        vault.pullFrom(IPositionAdapter(address(uniV3)), 2_500);
    }

    /// @dev "Pull from venue A, deploy to venue B" — full on-chain re-shape, no owner step; A becomes removable.
    function test_PullThenDeployReshapesAcrossVenues() public {
        _bootstrap();
        vm.prank(keeper);
        vault.deployTo(IPositionAdapter(address(uniV3)), _amts(800e6, 0.8e18));
        (, uint256[] memory totalsBefore) = vault.totalTokens();

        vm.startPrank(keeper);
        (, uint256[] memory pulled) = vault.pullFrom(IPositionAdapter(address(uniV3)), 10_000);
        vault.deployTo(IPositionAdapter(address(uniV4)), pulled);
        vm.stopPrank();

        (, uint256[] memory a3) = uniV3.position();
        (, uint256[] memory a4) = uniV4.position();
        assertEq(a3[0] + a3[1], 0);
        assertEq(a4[0], 800e6);
        assertEq(a4[1], 0.8e18);
        (, uint256[] memory totalsAfter) = vault.totalTokens();
        assertEq(totalsAfter[0], totalsBefore[0]);
        assertEq(totalsAfter[1], totalsBefore[1]);

        vm.prank(owner);
        vault.removeAdapter(IPositionAdapter(address(uniV3)));
        assertEq(vault.adapterCount(), 1);

        // Holders are whole after the move.
        vm.prank(owner);
        vault.redeem(GENESIS, owner);
        assertEq(usdg.balanceOf(owner), 1_000_000e6);
        assertEq(weth.balanceOf(owner), 1_000e18);
    }

    /*//////////////////////////////////////////////////////////////
               BATCH 2 — VIRTUAL SHARES (DONATION GUARD)
    //////////////////////////////////////////////////////////////*/

    /// @dev (a) Donation-inflation PoC, minority attacker. The attacker deposits normally, donates basket
    ///      tokens straight to the vault AND into an adapter, a victim deposits (loosest minShares = 1),
    ///      the attacker redeems. Measured on real balances, the attacker's net is negative on BOTH
    ///      tokens: the donation is shared pro-rata with the genesis holder and the victim, and deposits
    ///      only ever pull ceil(shares * (T + VA) / (S + VS)) — the victim pays for exactly the shares
    ///      it receives, so share-price inflation has nothing to extract. The victim buys in at the
    ///      post-donation basket ratio (break-even), losing only the documented redeem dust (ceil on
    ///      deposit + floors on redeem, incl. the adapter's 1e18-scaled slice).
    ///      Run with -vv for the numbers; at VS = VA = 1 they are (raw units, USDG 6dp / WETH 18dp):
    ///        attacker net: USDG -5_000_000_003 (-5_000.00), WETH -5_000_000_002_500_000_000 (-5.0000000025)
    ///        victim   net: USDG             -2,             WETH                    -2 (dust)
    ///      (Under the former whole-bps adapter fraction: attacker -5_000_540_002 / -5_000_540_001_529_687_500,
    ///      victim -121_555 / -121_553_915_625_001 — the bps floor left ~1bp of the adapter slice behind.)
    function test_DonationInflation_MinorityAttackerLoses() public {
        address attacker = makeAddr("attacker");
        _fund(attacker);
        _approveFor(attacker, address(uniV3));
        _bootstrap();
        vm.prank(keeper);
        vault.deployTo(IPositionAdapter(address(uniV3)), _amts(400e6, 0.4e18));
        uint256[2] memory a0 = [usdg.balanceOf(attacker), weth.balanceOf(attacker)];
        uint256[2] memory v0 = [usdg.balanceOf(bob), weth.balanceOf(bob)];

        vm.startPrank(attacker);
        uint256 sA = vault.deposit(basket, _amts(BOOT_USDG, BOOT_WETH), 1, attacker);
        usdg.transfer(address(vault), 5_000e6); // idle donation
        weth.transfer(address(vault), 5e18);
        uniV3.donate(_amts(5_000e6, 5e18)); // adapter-side donation
        vm.stopPrank();

        vm.prank(bob);
        uint256 sV = vault.deposit(basket, _amts(4_000e6, 4e18), 1, bob);
        assertGt(sV, 0);

        vm.prank(attacker);
        vault.redeem(sA, attacker);
        // Victim's dust budget: deposit ceil + redeem floors + the adapter's 1e18-scaled slice (a few raw units).
        (, uint256[] memory a3) = uniV3.position();
        vm.prank(bob);
        vault.redeem(sV, bob);

        int256[2] memory aNet = _net(a0, attacker);
        int256[2] memory vNet = _net(v0, bob);
        console2.log("minority attacker net USDG:", aNet[0]);
        console2.log("minority attacker net WETH:", aNet[1]);
        console2.log("victim net USDG           :", vNet[0]);
        console2.log("victim net WETH           :", vNet[1]);
        assertLe(aNet[0], 0, "attacker cannot profit (USDG)");
        assertLe(aNet[1], 0, "attacker cannot profit (WETH)");
        assertGe(vNet[0], -int256(a3[0] / 1e18 + 3), "victim loses at most dust (USDG)");
        assertGe(vNet[1], -int256(a3[1] / 1e18 + 3), "victim loses at most dust (WETH)");
    }

    /// @dev (a) Donation-inflation PoC, WORST case: the attacker is the SOLE holder of a 1-share-wei supply
    ///      (genesis holder exited, attacker burned down to 1 share-wei, leaving 1 raw unit of each token),
    ///      donates 1_000 USDG + 1 WETH to inflate the share price to ~1_000 USDG/share-wei, and the victim
    ///      deposits with the loosest minShares = 1. Deposit pricing with VS = VA = 1 hands the victim
    ///      3 of 4 shares for 1_500 USDG + 1.5 WETH (+3 raw units); the attacker's 1 share then redeems for
    ///      only a quarter of the pot. Numbers (raw units, run with -vv):
    ///        attacker net: USDG -375_000_000 (-375), WETH -375_000_000_000_000_000 (-0.375)
    ///        victim   net: USDG +375_000_000 (+375), WETH +375_000_000_000_000_000 (+0.375)
    ///      Without virtuals (VS = VA = 0) the same flow is break-even for the attacker (the victim gets 1
    ///      share for exactly 1 pot, pays only for it) — no profit either way; the virtuals make it a loss.
    function test_DonationInflation_SoleHolderAtOneShareWeiLoses() public {
        address attacker = makeAddr("attacker");
        _fund(attacker);
        _bootstrap();
        uint256[2] memory a0 = [usdg.balanceOf(attacker), weth.balanceOf(attacker)];
        uint256[2] memory v0 = [usdg.balanceOf(bob), weth.balanceOf(bob)];

        vm.prank(attacker);
        uint256 sA = vault.deposit(basket, _amts(BOOT_USDG, BOOT_WETH), 1, attacker);
        vm.prank(owner);
        vault.redeem(GENESIS, owner); // genesis holder exits
        vm.prank(attacker);
        vault.redeem(sA - 1, attacker); // burn down to a single share-wei
        assertEq(vault.totalSupply(), 1);
        (, uint256[] memory dust) = vault.totalTokens();
        assertEq(dust[0], 1);
        assertEq(dust[1], 1);

        vm.startPrank(attacker);
        usdg.transfer(address(vault), 1_000e6);
        weth.transfer(address(vault), 1e18);
        vm.stopPrank();

        vm.prank(bob);
        uint256 sV = vault.deposit(basket, _amts(2_000e6, 2e18), 1, bob);
        assertEq(sV, 3);

        vm.prank(attacker);
        vault.redeem(1, attacker);
        vm.prank(bob);
        vault.redeem(sV, bob);

        int256[2] memory aNet = _net(a0, attacker);
        int256[2] memory vNet = _net(v0, bob);
        console2.log("sole-holder attacker net USDG:", aNet[0]);
        console2.log("sole-holder attacker net WETH:", aNet[1]);
        console2.log("victim net USDG              :", vNet[0]);
        console2.log("victim net WETH              :", vNet[1]);
        assertLt(aNet[0], 0, "attacker strictly loses (USDG)");
        assertLt(aNet[1], 0, "attacker strictly loses (WETH)");
        assertGe(vNet[0], 0, "victim not harmed (USDG)");
        assertGe(vNet[1], 0, "victim not harmed (WETH)");
    }

    /// @dev (b) Round trip at the unit-test scale: deposit then immediate redeem never pays out more than
    ///      was pulled, per token, on real balances (strict — no +1 allowance needed; see the vault's
    ///      VIRTUAL_SHARES note for why this holds whenever VS/VA <= S/T_i).
    function testFuzz_RoundTripNeverGains(uint256 offerUsdg, uint256 offerWeth, uint256 splitBps) public {
        offerUsdg = bound(offerUsdg, 1, 900_000e6);
        offerWeth = bound(offerWeth, 1e3, 900e18);
        splitBps = bound(splitBps, 0, BPS);
        _bootstrap();
        vm.prank(keeper);
        vault.deployTo(
            IPositionAdapter(address(uniV3)), _amts((BOOT_USDG * splitBps) / BPS, (BOOT_WETH * splitBps) / BPS)
        );
        _assertRoundTripNoGain(vault, offerUsdg, offerWeth);
    }

    /// @dev (b) Round trip at the DemoLocal scale (K = 10_000e18; 100k USDG + 10 WETH), swept from 1e-6x to
    ///      5x the vault. This is the test that forced the VIRTUAL_SHARES tuning: at VS = 1e6 the WETH leg
    ///      pays out up to +908 wei more than was pulled (S/T_weth = 1e3 < VS/VA).
    function test_RoundTrip_DemoScale_NeverGains() public {
        MySunVaultUpgradeable v = MySunVaultUpgradeable(_deployVaultWith(basket, 10_000e18, 0));
        _approveFor(owner, address(v));
        _approveFor(bob, address(v));
        vm.prank(owner);
        v.deposit(basket, _amts(100_000e6, 10e18), 10_000e18, owner);

        uint256[7] memory num = [uint256(1), 1, 1, 1, 1, 1, 5];
        uint256[7] memory den = [uint256(1e6), 1e3, 100, 3, 2, 1, 1];
        for (uint256 i; i < num.length; ++i) {
            _assertRoundTripNoGain(v, (100_000e6 * num[i]) / den[i] + 1, (10e18 * num[i]) / den[i] + 1);
        }
    }

    /// @dev bob deposits (offerUsdg, offerWeth) into `v` and immediately redeems everything; per token, what
    ///      comes back must be <= what was pulled.
    function _assertRoundTripNoGain(MySunVaultUpgradeable v, uint256 offerUsdg, uint256 offerWeth) internal {
        uint256[2] memory b0 = [usdg.balanceOf(bob), weth.balanceOf(bob)];
        vm.prank(bob);
        uint256 shares = v.deposit(basket, _amts(offerUsdg, offerWeth), 1, bob);
        uint256[2] memory b1 = [usdg.balanceOf(bob), weth.balanceOf(bob)];
        vm.prank(bob);
        v.redeem(shares, bob);
        uint256 backU = usdg.balanceOf(bob) - b1[0];
        uint256 backW = weth.balanceOf(bob) - b1[1];
        assertLe(backU, b0[0] - b1[0], "round trip gained USDG");
        assertLe(backW, b0[1] - b1[1], "round trip gained WETH");
    }

    /*//////////////////////////////////////////////////////////////
                  BATCH 3 — PER-VAULT RECEIPT NAME / SYMBOL
    //////////////////////////////////////////////////////////////*/

    function test_CustomReceiptNameSymbolStored() public {
        MySunVaultUpgradeable v = MySunVaultUpgradeable(
            Upgrades.deployUUPSProxy(
                "MySunVaultUpgradeable.sol",
                _initData(owner, "sun5StocksLP", "sun5StocksLP", basket, treasury, FEE_BPS, GENESIS, 0)
            )
        );
        assertEq(v.name(), "sun5StocksLP");
        assertEq(v.symbol(), "sun5StocksLP");
        assertEq(v.decimals(), 18);

        // Name and symbol are independent params; interior/edge whitespace is kept verbatim (only a
        // blank string is rejected).
        MySunVaultUpgradeable impl = new MySunVaultUpgradeable();
        MySunVaultUpgradeable w = MySunVaultUpgradeable(
            address(
                new ERC1967ProxyLite(
                    address(impl), _initData(owner, " migo Test LP ", "mTLP", basket, treasury, FEE_BPS, GENESIS, 0)
                )
            )
        );
        assertEq(w.name(), " migo Test LP ");
        assertEq(w.symbol(), "mTLP");
    }

    function test_EmptyReceiptNameReverts() public {
        MySunVaultUpgradeable impl = new MySunVaultUpgradeable();
        string[4] memory blanks = ["", " ", "   ", "\t\n\r \x0b\x0c"];
        for (uint256 i; i < blanks.length; ++i) {
            vm.expectRevert(IPoolmigoVault.PoolmigoVault__EmptyReceiptName.selector);
            _rawProxy(impl, _initData(owner, blanks[i], SYMBOL, basket, treasury, FEE_BPS, GENESIS, 0));
        }
        // Blank name is reported even when the symbol is blank too (name is checked first).
        vm.expectRevert(IPoolmigoVault.PoolmigoVault__EmptyReceiptName.selector);
        _rawProxy(impl, _initData(owner, "", "", basket, treasury, FEE_BPS, GENESIS, 0));
    }

    function test_EmptyReceiptSymbolReverts() public {
        MySunVaultUpgradeable impl = new MySunVaultUpgradeable();
        string[4] memory blanks = ["", " ", "   ", "\t\n\r \x0b\x0c"];
        for (uint256 i; i < blanks.length; ++i) {
            vm.expectRevert(IPoolmigoVault.PoolmigoVault__EmptyReceiptSymbol.selector);
            _rawProxy(impl, _initData(owner, NAME, blanks[i], basket, treasury, FEE_BPS, GENESIS, 0));
        }
        // One visible byte is enough.
        _rawProxy(impl, _initData(owner, NAME, " x ", basket, treasury, FEE_BPS, GENESIS, 0));
    }

    /// @dev Two vaults on the same chain: different baskets (sharing USDG), different receipts, and
    ///      fully independent accounting — deposits, deploys and redemptions on B never move A.
    function test_SecondVaultCoexistsWithIndependentAccounting() public {
        MockToken nvda = new MockToken("Mock NVDA", "mNVDA", 18);
        MockToken aapl = new MockToken("Mock AAPL", "mAAPL", 18);
        address[] memory stockBasket = new address[](3);
        stockBasket[0] = address(usdg);
        stockBasket[1] = address(nvda);
        stockBasket[2] = address(aapl);

        uint256 genesisB = 25_000e18;
        MySunVaultUpgradeable b = MySunVaultUpgradeable(
            Upgrades.deployUUPSProxy(
                "MySunVaultUpgradeable.sol",
                _initData(owner, "sun5StocksLP", "sun5StocksLP", stockBasket, treasury, FEE_BPS, genesisB, 1_000_000e18)
            )
        );
        address[] memory pair = new address[](2);
        pair[0] = address(usdg);
        pair[1] = address(nvda);
        MockPositionAdapter nvdaPair =
            new MockPositionAdapter(pair, address(b), bytes32("uniswap-v3"), bytes32("mNVDA/mUSDG 0.30%"));
        vm.startPrank(owner);
        b.addAdapter(IPositionAdapter(address(nvdaPair)));
        b.setKeeper(keeper, true);
        vm.stopPrank();

        // Receipts differ; A is untouched.
        assertEq(vault.name(), "sunEthLP");
        assertEq(vault.symbol(), "sunEthLP");
        assertEq(b.name(), "sun5StocksLP");
        assertEq(b.symbol(), "sun5StocksLP");
        assertEq(b.tokens().length, 3);
        assertEq(b.genesisShares(), genesisB);
        assertEq(b.maxTotalSupply(), 1_000_000e18);
        // A's adapter set does not leak into B (and B's pair adapter is not registered on A).
        assertEq(b.adapterCount(), 1);
        assertFalse(vault.isAdapter(address(nvdaPair)));

        // Seed both vaults (owner-gated genesis on each).
        _bootstrap();
        nvda.mint(owner, 100e18);
        aapl.mint(owner, 100e18);
        vm.startPrank(owner);
        usdg.approve(address(b), type(uint256).max);
        nvda.approve(address(b), type(uint256).max);
        aapl.approve(address(b), type(uint256).max);
        b.deposit(stockBasket, _amts3(2_000e6, 10e18, 10e18), genesisB, owner);
        vm.stopPrank();
        assertEq(vault.totalSupply(), GENESIS);
        assertEq(b.totalSupply(), genesisB);

        (, uint256[] memory aTotals0) = vault.totalTokens();
        uint256 aliceA0 = vault.balanceOf(alice);

        // Alice deposits into B only: half the seed basket.
        nvda.mint(alice, 50e18);
        aapl.mint(alice, 50e18);
        vm.startPrank(alice);
        usdg.approve(address(b), type(uint256).max);
        nvda.approve(address(b), type(uint256).max);
        aapl.approve(address(b), type(uint256).max);
        uint256[] memory offer = _amts3(1_000e6, 5e18, 5e18);
        (uint256 preview, uint256[] memory req) = b.previewDeposit(stockBasket, offer);
        uint256 minted = b.deposit(stockBasket, offer, preview, alice);
        vm.stopPrank();
        assertEq(minted, preview);
        assertGt(minted, 0);
        assertEq(b.balanceOf(alice), minted);
        assertEq(b.totalSupply(), genesisB + minted);

        // Keeper moves part of B's idle into the NVDA pair.
        uint256[] memory into = new uint256[](2);
        into[0] = 1_000e6;
        into[1] = 4e18;
        vm.prank(keeper);
        b.deployTo(IPositionAdapter(address(nvdaPair)), into);

        (, uint256[] memory bTotals) = b.totalTokens();
        assertEq(bTotals[0], 2_000e6 + req[0], "B usdg total");
        assertEq(bTotals[1], 10e18 + req[1], "B nvda total");
        assertEq(bTotals[2], 10e18 + req[2], "B aapl total");

        // A saw none of it — the shared USDG token is accounted per vault by balance.
        (, uint256[] memory aTotals1) = vault.totalTokens();
        assertEq(aTotals1[0], aTotals0[0], "A usdg moved");
        assertEq(aTotals1[1], aTotals0[1], "A weth moved");
        assertEq(vault.totalSupply(), GENESIS);
        assertEq(vault.balanceOf(alice), aliceA0);

        // Redeem Alice from B in full: B supply returns to genesis, A still untouched.
        vm.prank(alice);
        (, uint256[] memory out) = b.redeem(minted, alice);
        assertLe(out[0], req[0], "redeem gained usdg");
        assertLe(out[1], req[1], "redeem gained nvda");
        assertLe(out[2], req[2], "redeem gained aapl");
        assertEq(b.totalSupply(), genesisB);
        (, uint256[] memory aTotals2) = vault.totalTokens();
        assertEq(aTotals2[0], aTotals0[0]);
        assertEq(aTotals2[1], aTotals0[1]);
        assertEq(vault.totalSupply(), GENESIS);

        // A's receipt is not B's receipt: Bob's A shares give him nothing on B.
        vm.startPrank(bob);
        (uint256 bobPreview,) = vault.previewDeposit(basket, _amts(BOOT_USDG, BOOT_WETH));
        vault.deposit(basket, _amts(BOOT_USDG, BOOT_WETH), bobPreview, bob);
        assertEq(vault.balanceOf(bob), bobPreview);
        assertEq(b.balanceOf(bob), 0);
        vm.expectRevert(abi.encodeWithSelector(IPoolmigoVault.PoolmigoVault__InsufficientShares.selector, 0, 1));
        b.redeem(1, bob);
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
          PRE-AUDIT FIXES — K-8 ADAPTER SLICE AT 1e18 PRECISION
    //////////////////////////////////////////////////////////////*/

    /// @dev A redemption of ~1e-6 of supply (far below the former 1-bp quantum) with 90 % of the basket deployed:
    ///      it now receives its adapter slice too and lands within the documented rounding of exact pro-rata —
    ///      per token, exactFloor - sent <= H / 1e18 + A + 1 (A adapters holding H in total: each adapter loses
    ///      < H_a / 1e18 to the sharesWad floor and < 1 to its own floor; the idle floor < 1). Under the bps
    ///      fraction sharesBps was 0 here and only the 10 % idle slice was paid.
    function test_RedeemFarBelowOneBpLandsWithinRounding() public {
        _bootstrap();
        vm.startPrank(keeper);
        vault.deployTo(IPositionAdapter(address(uniV3)), _amts(450e6, 0.45e18));
        vault.deployTo(IPositionAdapter(address(uniV4)), _amts(450e6, 0.45e18));
        vm.stopPrank();
        vm.prank(bob);
        uint256 shares = vault.deposit(basket, _amts(1_000, 1e12), 1, bob);
        uint256 supply = vault.totalSupply();
        assertApproxEqRel(shares * 1e6, supply, 0.01e18, "~1e-6 of supply");
        assertEq((shares * BPS) / supply, 0, "the former sharesBps would be 0");

        (, uint256[] memory totals) = vault.totalTokens();
        uint256 idleW = weth.balanceOf(address(vault));
        (, uint256[] memory owed) = vault.previewRedeem(shares);
        vm.prank(bob);
        (, uint256[] memory sent) = vault.redeem(shares, bob);

        for (uint256 i; i < 2; ++i) {
            uint256 exactFloor = (shares * totals[i]) / supply;
            assertEq(sent[i], owed[i], "preview exact on linear mocks");
            assertLe(sent[i], exactFloor, "never above exact pro-rata");
            assertLe(exactFloor - sent[i], 3, "within H/1e18 + A + 1 (H <= 1e18, A = 2)");
        }
        // Under the bps fraction bob would have received only his idle slice: ~10 % of his WETH entitlement.
        uint256 bpsEraWeth = (shares * idleW) / supply;
        console2.log("1e-6 redeem WETH, exact floor :", (shares * totals[1]) / supply);
        console2.log("1e-6 redeem WETH, sent        :", sent[1]);
        console2.log("1e-6 redeem WETH, bps-era     :", bpsEraWeth);
        assertLt(bpsEraWeth * 5, sent[1]);
    }

    /// @dev Same bound for any redemption size from 1 share-wei to 1 bp of supply (owner redeems out of genesis).
    function testFuzz_SmallRedeemWithinRounding(uint256 shares, uint256 splitBps) public {
        splitBps = bound(splitBps, 0, BPS);
        _bootstrap();
        shares = bound(shares, 1, GENESIS / BPS);
        uint256 h0 = (BOOT_USDG * splitBps) / BPS / 2;
        uint256 h1 = (BOOT_WETH * splitBps) / BPS / 2;
        vm.startPrank(keeper);
        vault.deployTo(IPositionAdapter(address(uniV3)), _amts(h0, h1));
        vault.deployTo(IPositionAdapter(address(uniV4)), _amts(h0, h1));
        vm.stopPrank();
        (, uint256[] memory totals) = vault.totalTokens();
        vm.prank(owner);
        (, uint256[] memory sent) = vault.redeem(shares, owner);
        for (uint256 i; i < 2; ++i) {
            uint256 exactFloor = (shares * totals[i]) / GENESIS;
            assertLe(sent[i], exactFloor);
            assertLe(exactFloor - sent[i], 3);
        }
    }

    /*//////////////////////////////////////////////////////////////
               PRE-AUDIT FIXES — K-9 FORCE-REMOVE A BROKEN ADAPTER
    //////////////////////////////////////////////////////////////*/

    function test_ForceRemoveAdapterUnblocksRedeemAndDeposit() public {
        BrokenPositionAdapter broken = new BrokenPositionAdapter(basket, address(vault));
        vm.prank(owner);
        vault.addAdapter(IPositionAdapter(address(broken)));
        _bootstrap();
        vm.startPrank(keeper);
        vault.deployTo(IPositionAdapter(address(uniV3)), _amts(300e6, 0.3e18));
        vault.deployTo(IPositionAdapter(address(broken)), _amts(200e6, 0.2e18));
        vm.stopPrank();
        vm.prank(bob);
        uint256 bobShares = vault.deposit(basket, _amts(100e6, 0.1e18), 1, bob);

        // (1) withdrawProportional reverts: every redemption is blocked (deposits still work); removeAdapter
        //     cannot help — the adapter still reports holdings.
        broken.setBroken(false, true);
        vm.prank(bob);
        vm.expectRevert(BrokenPositionAdapter.BrokenPositionAdapter__Broken.selector);
        vault.redeem(bobShares, bob);
        vm.prank(owner);
        vm.expectRevert(BrokenPositionAdapter.BrokenPositionAdapter__Broken.selector);
        vault.redeem(1e18, owner);
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                IPoolmigoVault.PoolmigoVault__AdapterStillFunded.selector, address(broken), address(usdg), 200e6
            )
        );
        vault.removeAdapter(IPositionAdapter(address(broken)));

        // (2) position() reverts too: deposits and previews are blocked, removeAdapter reverts outright.
        broken.setBroken(true, true);
        vm.prank(bob);
        vm.expectRevert(BrokenPositionAdapter.BrokenPositionAdapter__Broken.selector);
        vault.deposit(basket, _amts(100e6, 0.1e18), 1, bob);
        vm.expectRevert(BrokenPositionAdapter.BrokenPositionAdapter__Broken.selector);
        vault.previewRedeem(bobShares);
        vm.prank(owner);
        vm.expectRevert(BrokenPositionAdapter.BrokenPositionAdapter__Broken.selector);
        vault.removeAdapter(IPositionAdapter(address(broken)));

        // (3) Only the owner can force-remove; unknown adapters are rejected.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, alice));
        vault.forceRemoveAdapter(IPositionAdapter(address(broken)));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IPoolmigoVault.PoolmigoVault__AdapterNotRegistered.selector, alice));
        vault.forceRemoveAdapter(IPositionAdapter(alice));

        // (4) Owner force-removes WITHOUT calling the adapter (it would revert) and without it being empty.
        vm.prank(owner);
        vm.expectEmit(true, false, false, false, address(vault));
        emit IPoolmigoVault.AdapterForceRemoved(address(broken));
        vault.forceRemoveAdapter(IPositionAdapter(address(broken)));
        assertFalse(vault.isAdapter(address(broken)));
        assertEq(vault.adapterCount(), 2);
        assertEq(address(vault.adapterAt(0)), address(uniV3));
        assertEq(address(vault.adapterAt(1)), address(uniV4)); // swap-and-pop moved the last entry

        // (5) The loops work again: bob (the locked-in redeemer) exits pro-rata of what the vault can still reach;
        //     the broken adapter's assets stay where they are.
        (, uint256[] memory reach) = vault.totalTokens();
        uint256 supply = vault.totalSupply();
        vm.prank(bob);
        (, uint256[] memory sent) = vault.redeem(bobShares, bob);
        for (uint256 i; i < 2; ++i) {
            assertLe(sent[i], (bobShares * reach[i]) / supply);
            assertLe((bobShares * reach[i]) / supply - sent[i], 2); // one funded adapter + idle floors
        }
        assertEq(usdg.balanceOf(address(broken)), 200e6, "stranded in the removed adapter");
        assertEq(weth.balanceOf(address(broken)), 0.2e18);
        vm.prank(alice);
        assertGt(vault.deposit(basket, _amts(100e6, 0.1e18), 1, alice), 0, "deposits work again");

        // (6) Recovery if the adapter works again: re-registering it counts its holdings again.
        broken.setBroken(false, false);
        (, uint256[] memory beforeReAdd) = vault.totalTokens();
        vm.prank(owner);
        vault.addAdapter(IPositionAdapter(address(broken)));
        (, uint256[] memory afterReAdd) = vault.totalTokens();
        assertEq(afterReAdd[0] - beforeReAdd[0], 200e6);
        assertEq(afterReAdd[1] - beforeReAdd[1], 0.2e18);
    }

    /*//////////////////////////////////////////////////////////////
                PRE-AUDIT FIXES — K-13 UPGRADE-EXAMPLE REINITIALIZER OWNER-ONLY
    //////////////////////////////////////////////////////////////*/

    /// @dev The K-13 scenario: the proxy is upgraded with EMPTY call data, so the reinitializer is still unspent.
    ///      A third party cannot consume it; the owner can, exactly once.
    function test_InitializeExampleOnlyOwnerAfterEmptyUpgrade() public {
        MySunVaultUpgradeExample impl = new MySunVaultUpgradeExample();
        vm.prank(owner);
        vault.upgradeToAndCall(address(impl), "");
        MySunVaultUpgradeExample upgraded = MySunVaultUpgradeExample(address(vault));

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, alice));
        upgraded.initializeExample(1);
        assertEq(
            uint64(
                uint256(vm.load(address(vault), 0xcca7159ac201d617b51ce7033b4f9c4a1b9f7200d111d0202b4a866e29c27b00))
            ),
            0
        );

        vm.prank(owner);
        upgraded.initializeExample(3600);
        assertEq(
            uint64(
                uint256(vm.load(address(vault), 0xcca7159ac201d617b51ce7033b4f9c4a1b9f7200d111d0202b4a866e29c27b00))
            ),
            3600
        );
        vm.prank(owner);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        upgraded.initializeExample(1);
    }

    /*//////////////////////////////////////////////////////////////
        FIX ROUND — K-14 STRICT PARTICIPATION (a held token always forces offers)
    //////////////////////////////////////////////////////////////*/

    /// @dev Registers DAI (unheld), funds bob with it, returns the 3-token offer vector [usdg, weth, dai].
    function _addDai() internal returns (MockToken dai, address[] memory three) {
        dai = new MockToken("DAI", "DAI", 18);
        vm.prank(owner);
        vault.addToken(address(dai));
        dai.mint(bob, 10e18);
        vm.prank(bob);
        dai.approve(address(vault), type(uint256).max);
        three = new address[](3);
        three[0] = address(usdg);
        three[1] = address(weth);
        three[2] = address(dai);
    }

    /// @dev (1) Strict participation (fix-round behavior; was "dust does not force offers"): a 1-wei
    ///      donation of a registered token does NOT admit omissions — the omission and the explicit
    ///      zero-offer both revert; offering it (>= its ceil draw) works, pricing of USDG/WETH unchanged.
    function test_Strict_DustDonationForcesOffers() public {
        _bootstrap();
        (MockToken dai, address[] memory three) = _addDai();
        uint256[] memory offer = _amts(100e6, 0.1e18);
        uint256 s = 99_999_999_900_000_000_100; // bob's share count for `offer` (USDG/WETH-bound)

        dai.mint(address(this), 1);
        dai.transfer(address(vault), 1); // the donation: T_dai = 1
        (, uint256[] memory totals) = vault.totalTokens();
        assertEq(totals[2], 1);

        // Omission and explicit zero both revert — preview included (same rule as the pull path).
        vm.expectRevert(abi.encodeWithSelector(IPoolmigoVault.PoolmigoVault__MissingBasketToken.selector, address(dai)));
        vault.previewDeposit(basket, offer);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IPoolmigoVault.PoolmigoVault__MissingBasketToken.selector, address(dai)));
        vault.deposit(basket, offer, 1, bob);
        vm.prank(bob);
        vm.expectRevert(IPoolmigoVault.PoolmigoVault__ZeroAmount.selector);
        vault.deposit(three, _amts3(100e6, 0.1e18, 0), 1, bob);

        // Offering the dust works: the binding token still sets the share count; the pull is the ceil draw.
        (, uint256[] memory req) = vault.previewDeposit(three, _amts3(100e6, 0.1e18, 1e18));
        assertGt(req[2], 0);
        uint256 daiBefore = dai.balanceOf(bob);
        vm.prank(bob);
        uint256 shares = vault.deposit(three, _amts3(100e6, 0.1e18, 1e18), 1, bob);
        assertEq(shares, s, "share count unchanged by the donation");
        assertEq(daiBefore - dai.balanceOf(bob), req[2], "the ceil draw of the dust token is pulled");
    }

    /// @dev (2) The old per-deposit boundary is gone: ANY held amount — 1 wei or material — forces offers;
    ///      there is no "still optional" zone. T_i == 0 stays optional (U:test_DepositUnheldRegisteredTokenPullsZero).
    function test_Strict_AnyHeldAmountForces() public {
        _bootstrap();
        (MockToken dai, address[] memory three) = _addDai();
        uint256[] memory offer = _amts(100e6, 0.1e18);

        dai.mint(address(this), 20e18);
        dai.transfer(address(vault), 1); // 1 wei held: already mandatory (was optional before the fix round)
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IPoolmigoVault.PoolmigoVault__MissingBasketToken.selector, address(dai)));
        vault.deposit(basket, offer, 1, bob);

        // Not per deposit anymore: a smaller deposit gets the same answer.
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IPoolmigoVault.PoolmigoVault__MissingBasketToken.selector, address(dai)));
        vault.deposit(basket, _amts(50e6, 0.05e18), 1, bob);

        // Material holding: same revert; offering works and pulls the ceil draw.
        dai.transfer(address(vault), 10e18);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IPoolmigoVault.PoolmigoVault__MissingBasketToken.selector, address(dai)));
        vault.deposit(basket, _amts(1e6, 0.001e18), 1, bob);

        (uint256 s, uint256[] memory req) = vault.previewDeposit(three, _amts3(100e6, 0.1e18, 1e18));
        uint256 daiBefore = dai.balanceOf(bob);
        vm.prank(bob);
        assertEq(vault.deposit(three, _amts3(100e6, 0.1e18, 1e18), 1, bob), s);
        assertEq(daiBefore - dai.balanceOf(bob), req[2]);
    }

    /// @dev (3) Round trip never gains with a third token of any size; under strict participation the offer
    ///      must include it (omission reverts regardless of size); per token what comes back is <= what
    ///      was pulled. (Was: "bob omits it when the rule allows" — no longer possible.)
    function testFuzz_RoundTripNeverGains_WithDustToken(
        uint256 offerUsdg,
        uint256 offerWeth,
        uint256 dust,
        uint256 splitBps
    ) public {
        offerUsdg = bound(offerUsdg, 1, 900_000e6);
        offerWeth = bound(offerWeth, 1e3, 900e18);
        dust = bound(dust, 1, 1e6);
        splitBps = bound(splitBps, 0, BPS);
        _bootstrap();
        (MockToken dai, address[] memory three) = _addDai();
        vm.prank(keeper);
        vault.deployTo(
            IPositionAdapter(address(uniV3)), _amts((BOOT_USDG * splitBps) / BPS, (BOOT_WETH * splitBps) / BPS)
        );
        dai.mint(address(this), dust);
        dai.transfer(address(vault), dust);

        // Strict: omitting the held token reverts (regardless of size).
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IPoolmigoVault.PoolmigoVault__MissingBasketToken.selector, address(dai)));
        vault.deposit(basket, _amts(offerUsdg, offerWeth), 1, bob);

        uint256[3] memory b0 = [usdg.balanceOf(bob), weth.balanceOf(bob), dai.balanceOf(bob)];
        vm.prank(bob);
        uint256 shares = vault.deposit(three, _amts3(offerUsdg, offerWeth, 10e18), 1, bob);
        uint256[3] memory b1 = [usdg.balanceOf(bob), weth.balanceOf(bob), dai.balanceOf(bob)];
        vm.prank(bob);
        vault.redeem(shares, bob);
        assertLe(usdg.balanceOf(bob) - b1[0], b0[0] - b1[0], "round trip gained USDG");
        assertLe(weth.balanceOf(bob) - b1[1], b0[1] - b1[1], "round trip gained WETH");
        assertLe(dai.balanceOf(bob) - b1[2], b0[2] - b1[2], "round trip gained DAI");
    }

    /*//////////////////////////////////////////////////////////////
                  PRE-AUDIT FIXES — DEMO-SCALE DEPOSIT GAS
    //////////////////////////////////////////////////////////////*/

    /// @dev Gas of one normal deposit at the DemoLocal shapes, cold storage (vm.cool on every touched
    ///      contract), measured with vm.lastCallGas. (a) flagship: 2 tokens, 2 mock adapters, both
    ///      funded + fees (DemoLocal `_keeperDemo`); (b) stocks: 6 tokens, 5 pair adapters, 2 funded.
    ///      Logged for the K-14 gas budget (+10 %); run with -vv.
    function test_Gas_DemoScaleDeposit() public {
        // (a) flagship shape.
        MySunVaultUpgradeable a = MySunVaultUpgradeable(_deployVaultWith(basket, 10_000e18, 500_000e18));
        MockPositionAdapter a3 = new MockPositionAdapter(basket, address(a), DEX_V3, bytes32(uint256(1)));
        MockPositionAdapter a4 = new MockPositionAdapter(basket, address(a), DEX_V4, bytes32(uint256(2)));
        vm.startPrank(owner);
        a.addAdapter(IPositionAdapter(address(a3)));
        a.addAdapter(IPositionAdapter(address(a4)));
        a.setKeeper(keeper, true);
        vm.stopPrank();
        _approveFor(owner, address(a));
        _approveFor(bob, address(a));
        vm.prank(owner);
        a.deposit(basket, _amts(100_000e6, 10e18), 10_000e18, owner);
        vm.startPrank(keeper);
        a.deployTo(IPositionAdapter(address(a3)), _amts(50_000e6, 5e18));
        a.deployTo(IPositionAdapter(address(a4)), _amts(25_000e6, 2.5e18));
        vm.stopPrank();
        a3.simulateFees(_amts(250e6, 0.05e18));
        a4.simulateFees(_amts(100e6, 0.02e18));
        _coolAll(address(a), address(a3), address(a4));
        vm.prank(bob);
        a.deposit(basket, _amts(1_000e6, 0.1e18), 1, bob);
        uint256 gasA = vm.lastCallGas().gasTotalUsed;
        console2.log("demo-scale deposit gas (2 tokens, 2 adapters):", gasA);

        // (b) stocks shape: USDG + 5 stocks, one pair adapter per stock, two of them funded.
        address[] memory sb = new address[](6);
        sb[0] = address(usdg);
        MockPositionAdapter[] memory pairs = new MockPositionAdapter[](5);
        MySunVaultUpgradeable b;
        for (uint256 i; i < 5; ++i) {
            sb[1 + i] = address(new MockToken("S", "S", 18));
        }
        b = MySunVaultUpgradeable(_deployVaultWith(sb, 25_000e18, 1_000_000e18));
        uint256[] memory boot = new uint256[](6);
        uint256[] memory offer = new uint256[](6);
        boot[0] = 20_000e6;
        offer[0] = 1_000e6;
        vm.prank(owner);
        usdg.approve(address(b), type(uint256).max);
        vm.prank(bob);
        usdg.approve(address(b), type(uint256).max);
        for (uint256 i; i < 5; ++i) {
            address[] memory pt = new address[](2);
            pt[0] = address(usdg);
            pt[1] = sb[1 + i];
            pairs[i] = new MockPositionAdapter(pt, address(b), DEX_V3, bytes32(i));
            vm.prank(owner);
            b.addAdapter(IPositionAdapter(address(pairs[i])));
            MockToken(sb[1 + i]).mint(owner, 100e18);
            MockToken(sb[1 + i]).mint(bob, 50e18);
            vm.prank(owner);
            MockToken(sb[1 + i]).approve(address(b), type(uint256).max);
            vm.prank(bob);
            MockToken(sb[1 + i]).approve(address(b), type(uint256).max);
            boot[1 + i] = 10e18;
            offer[1 + i] = 1e18;
        }
        vm.startPrank(owner);
        b.deposit(sb, boot, 25_000e18, owner);
        b.setKeeper(keeper, true);
        vm.stopPrank();
        vm.startPrank(keeper);
        b.deployTo(IPositionAdapter(address(pairs[0])), _amts(4_000e6, 4e18));
        b.deployTo(IPositionAdapter(address(pairs[1])), _amts(3_000e6, 3e18));
        vm.stopPrank();
        vm.cool(address(b));
        for (uint256 i; i < 6; ++i) {
            vm.cool(sb[i]);
        }
        for (uint256 i; i < 5; ++i) {
            vm.cool(address(pairs[i]));
        }
        vm.prank(bob);
        b.deposit(sb, offer, 1, bob);
        uint256 gasB = vm.lastCallGas().gasTotalUsed;
        console2.log("demo-scale deposit gas (6 tokens, 5 adapters):", gasB);
    }

    function _coolAll(address v, address x, address y) internal {
        vm.cool(v);
        vm.cool(x);
        vm.cool(y);
        vm.cool(address(usdg));
        vm.cool(address(weth));
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    function _deployVault(address[] memory tokens_) internal returns (address proxy) {
        proxy = _deployVaultWith(tokens_, GENESIS, 0);
    }

    function _deployVaultWith(address[] memory tokens_, uint256 genesis, uint256 cap) internal returns (address) {
        return Upgrades.deployUUPSProxy(
            "MySunVaultUpgradeable.sol", _initData(owner, NAME, SYMBOL, tokens_, treasury, FEE_BPS, genesis, cap)
        );
    }

    function _initData(
        address owner_,
        string memory name_,
        string memory symbol_,
        address[] memory tokens_,
        address treasury_,
        uint16 feeBps,
        uint256 genesis,
        uint256 cap
    ) internal pure returns (bytes memory) {
        return abi.encodeCall(
            MySunVaultUpgradeable(address(0)).initialize,
            (owner_, name_, symbol_, tokens_, treasury_, feeBps, genesis, cap)
        );
    }

    /// @dev Plain ERC1967 proxy pointing at a given impl (bypasses OZ validation) for init-revert tests.
    function _rawProxy(MySunVaultUpgradeable impl, bytes memory data) internal {
        new ERC1967ProxyLite(address(impl), data);
    }

    /// @dev Owner-gated genesis: the owner seeds BOOT_USDG + BOOT_WETH and receives K = GENESIS shares.
    function _bootstrap() internal {
        vm.prank(owner);
        vault.deposit(basket, _amts(BOOT_USDG, BOOT_WETH), GENESIS, owner);
    }

    function _addRiskManager(string memory label) internal returns (address rm) {
        rm = makeAddr(label);
        vm.prank(owner);
        vault.setRiskManager(rm, true);
    }

    function _fund(address who) internal {
        usdg.mint(who, 1_000_000e6);
        weth.mint(who, 1_000e18);
        _approveFor(who, address(vault));
    }

    function _approveFor(address who, address spender) internal {
        vm.startPrank(who);
        usdg.approve(spender, type(uint256).max);
        weth.approve(spender, type(uint256).max);
        vm.stopPrank();
    }

    /// @dev Signed per-token balance change of `who` since `start` (USDG, WETH).
    function _net(uint256[2] memory start, address who) internal view returns (int256[2] memory d) {
        d[0] = int256(usdg.balanceOf(who)) - int256(start[0]);
        d[1] = int256(weth.balanceOf(who)) - int256(start[1]);
    }

    function _amts(uint256 a, uint256 b) internal pure returns (uint256[] memory arr) {
        arr = new uint256[](2);
        arr[0] = a;
        arr[1] = b;
    }

    function _amts3(uint256 a, uint256 b, uint256 c) internal pure returns (uint256[] memory arr) {
        arr = new uint256[](3);
        arr[0] = a;
        arr[1] = b;
        arr[2] = c;
    }

    function _ceilMulDiv(uint256 x, uint256 y, uint256 d) internal pure returns (uint256) {
        uint256 p = x * y;
        return p / d + (p % d == 0 ? 0 : 1);
    }
}

/// @dev Thin wrapper so the test can deploy an un-validated proxy for initializer-revert checks.
contract ERC1967ProxyLite is ERC1967Proxy {
    constructor(address impl, bytes memory data) ERC1967Proxy(impl, data) {}
}
