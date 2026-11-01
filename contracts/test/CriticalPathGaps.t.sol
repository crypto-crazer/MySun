// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import {MySunVaultUpgradeable} from "contracts/MySunVaultUpgradeable.sol";
import {MySunVaultUpgradeExample} from "contracts/MySunVaultUpgradeExample.sol";
import {IPoolmigoVault} from "contracts/interfaces/IPoolmigoVault.sol";
import {IPositionAdapter} from "contracts/interfaces/IPositionAdapter.sol";
import {MockToken} from "test/mocks/MockToken.sol";
import {VaultImplArgs} from "test/utils/VaultImplArgs.sol";

/**
 * @notice Gaps the main vault suite does not pin down on one page:
 *         - reentrancy across the deposit pull and the redeem payout
 *         - issue #2's exact dust-omission numbers (strict participation)
 *         - issue #3's fee symmetry (harvest-then-redeem vs redeem-before-harvest)
 *         - UUPS: keeper and risk manager cannot upgrade; the implementation is not a proxy;
 *           an owner upgrade still works while the vault is paused
 *         - known issues, asserted as the behaviour today: a lying adapter can skim idle or brick
 *           `redeem`, and `redeem` has no per-token minimum so a moved price is not rejected
 */
contract CriticalPathGapsTest is Test {
    uint16 internal constant FEE_BPS = 1_500;
    uint256 internal constant BPS = 10_000;

    /*//////////////////////////////////////////////////////////////
                         ISSUE #2 — DUST OMISSION
    //////////////////////////////////////////////////////////////*/

    /// @dev The published PoC: S = 100, X = 100, D = 2, then a 49 X deposit whose D entitlement
    ///      floors to 0. Strict participation rejects it (`MissingBasketToken` / `ZeroAmount`)
    ///      before any share is minted, so the two-step composition cannot start.
    function test_Issue2_OmittedDustLegRevertsBeforeMint() public {
        MockToken x = new MockToken("X", "X", 18);
        MockToken d = new MockToken("D", "D", 18);
        address[] memory basket = new address[](2);
        basket[0] = address(x);
        basket[1] = address(d);

        address owner = makeAddr("owner");
        address attacker = makeAddr("attacker");
        MySunVaultUpgradeable vault = _vault(basket, owner, makeAddr("treasury"), 100, FEE_BPS);

        x.mint(owner, 100);
        d.mint(owner, 2);
        _approve(x, d, owner, address(vault));
        vm.prank(owner);
        vault.deposit(basket, _pair(100, 2), 100, owner);
        assertEq(vault.totalSupply(), 100, "genesis K");

        x.mint(attacker, 49 + 74);
        _approve(x, d, attacker, address(vault));

        address[] memory onlyX = new address[](1);
        onlyX[0] = address(x);
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(IPoolmigoVault.PoolmigoVault__MissingBasketToken.selector, address(d)));
        vault.deposit(onlyX, _one(49), 1, attacker);

        vm.prank(attacker);
        vm.expectRevert(IPoolmigoVault.PoolmigoVault__ZeroAmount.selector);
        vault.deposit(basket, _pair(49, 0), 1, attacker);

        assertEq(vault.totalSupply(), 100, "no shares minted");
        assertEq(vault.balanceOf(attacker), 0);
        assertEq(x.balanceOf(address(vault)) + d.balanceOf(address(vault)), 102, "basket untouched");
    }

    /*//////////////////////////////////////////////////////////////
                    ISSUE #3 — FEE SYMMETRY ON EXIT
    //////////////////////////////////////////////////////////////*/

    /// @dev Sole economic comparison the issue asks for, on a 50% holder (shares transferred, so the
    ///      split is exact). Harvest-then-redeem taxes every fee up front; redeem-first taxes only the
    ///      exiting slice. Treasury's take attributable to that slice, and the holder's net tokens, match.
    function test_Issue3_RedeemBeforeHarvestMatchesHarvestThenRedeem() public {
        (MySunVaultUpgradeable vault, MockToken token, SplitFeeAdapter adapter, address owner) = _feeVault(1_000e18);
        address bob = makeAddr("bob");
        vm.prank(owner);
        IERC20(address(vault)).transfer(bob, 50e18);
        adapter.accrue(1_000e18);

        uint256 snap = vm.snapshotState();

        vm.prank(owner);
        vault.setKeeper(owner, true);
        vm.prank(owner);
        vault.rebalance();
        uint256 treasuryAfterHarvest = token.balanceOf(vault.treasury());
        assertEq(treasuryAfterHarvest, 150e18, "15% of 1000");

        vm.prank(bob);
        (, uint256[] memory afterHarvest) = vault.redeem(50e18, bob);
        assertEq(token.balanceOf(vault.treasury()), treasuryAfterHarvest, "redeem adds no second cut");
        assertEq(afterHarvest[0], 925e18, "500 principal + half of the net 850 fees");

        vm.revertToState(snap);

        uint256 treasuryBefore = token.balanceOf(vault.treasury());
        vm.prank(bob);
        (, uint256[] memory beforeHarvest) = vault.redeem(50e18, bob);
        uint256 treasuryOnRedeem = token.balanceOf(vault.treasury()) - treasuryBefore;

        assertEq(treasuryOnRedeem, treasuryAfterHarvest / 2, "slice cut == half of the full harvest cut");
        assertEq(beforeHarvest[0], afterHarvest[0], "holder net matches");
        assertEq(beforeHarvest[0], 925e18);
    }

    /*//////////////////////////////////////////////////////////////
                              REENTRANCY
    //////////////////////////////////////////////////////////////*/

    /// @dev A basket token that calls back into deposit / redeem / rebalance from its own transfer.
    ///      The transient guard rejects every callback; the outer deposit and the later redeem still settle.
    function test_Reentrancy_DepositAndRedeemCallbacksCannotReenter() public {
        ReenteringToken token = new ReenteringToken();
        address[] memory basket = new address[](1);
        basket[0] = address(token);

        address owner = makeAddr("owner");
        address bob = makeAddr("bob");
        MySunVaultUpgradeable vault = _vault(basket, owner, makeAddr("treasury"), 100e18, FEE_BPS);
        token.arm(address(vault));

        token.mint(owner, 100e18);
        vm.startPrank(owner);
        token.approve(address(vault), type(uint256).max);
        // Genesis pull fires the hook too. Arm after, so this seed is quiet.
        token.disarm();
        vault.deposit(basket, _one(100e18), 100e18, owner);
        vault.setKeeper(owner, true);
        vm.stopPrank();

        token.mint(bob, 100e18);
        vm.prank(bob);
        token.approve(address(vault), type(uint256).max);

        token.arm(address(vault));
        vm.prank(bob);
        uint256 minted = vault.deposit(basket, _one(100e18), 1, bob);

        assertFalse(token.redeemEntered(), "deposit callback could not redeem");
        assertFalse(token.depositEntered(), "deposit callback could not re-enter deposit");
        assertFalse(token.rebalanceEntered(), "deposit callback could not rebalance");
        assertEq(minted, 100e18);
        assertEq(vault.balanceOf(bob), 100e18);
        assertEq(vault.balanceOf(owner), 100e18, "owner shares untouched");

        token.arm(address(vault));
        vm.prank(bob);
        vault.redeem(100e18, bob);
        assertFalse(token.depositEntered(), "redeem payout could not deposit");
        assertEq(vault.balanceOf(bob), 0);
        assertEq(token.balanceOf(bob), 100e18, "bob got his principal back");
    }

    /*//////////////////////////////////////////////////////////////
                         UUPS / ACCESS CONTROL
    //////////////////////////////////////////////////////////////*/

    function test_Upgrade_KeeperAndRiskManagerRejected_PausedOwnerSucceeds() public {
        address[] memory basket = new address[](1);
        MockToken token = new MockToken("T", "T", 18);
        basket[0] = address(token);
        address owner = makeAddr("owner");
        address keeper = makeAddr("keeper");
        address risk = makeAddr("risk");
        MySunVaultUpgradeable vault = _vault(basket, owner, makeAddr("treasury"), 10e18, FEE_BPS);

        token.mint(owner, 10e18);
        vm.startPrank(owner);
        token.approve(address(vault), type(uint256).max);
        vault.deposit(basket, _one(10e18), 10e18, owner);
        vault.setKeeper(keeper, true);
        vault.setRiskManager(risk, true);
        vault.setPaused(true);
        vm.stopPrank();

        MySunVaultUpgradeExample next = new MySunVaultUpgradeExample(VaultImplArgs.depositSplit());
        bytes memory deniedKeeper =
            abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, keeper);
        bytes memory deniedRisk = abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, risk);

        vm.prank(keeper);
        vm.expectRevert(deniedKeeper);
        vault.upgradeToAndCall(address(next), "");
        vm.prank(risk);
        vm.expectRevert(deniedRisk);
        vault.upgradeToAndCall(address(next), "");

        // Implementation is not a proxy: even its deployer cannot UUPS-upgrade it.
        vm.expectRevert(UUPSUpgradeable.UUPSUnauthorizedCallContext.selector);
        next.upgradeToAndCall(address(next), "");

        uint256 supplyBefore = vault.totalSupply();
        vm.prank(owner);
        vault.upgradeToAndCall(address(next), "");

        assertTrue(vault.paused(), "pause survives the upgrade");
        assertEq(vault.totalSupply(), supplyBefore);
        assertEq(vault.owner(), owner);
        vm.prank(owner);
        vm.expectRevert(IPoolmigoVault.PoolmigoVault__Paused.selector);
        vault.deposit(basket, _one(1), 1, owner);
    }

    function test_Access_StrangerCannotKeeperOrRiskSurface() public {
        address[] memory basket = new address[](1);
        MockToken token = new MockToken("T", "T", 18);
        basket[0] = address(token);
        address owner = makeAddr("owner");
        address stranger = makeAddr("stranger");
        MySunVaultUpgradeable vault = _vault(basket, owner, makeAddr("treasury"), 10e18, FEE_BPS);
        SplitFeeAdapter adapter = new SplitFeeAdapter(address(vault), address(token));
        vm.prank(owner);
        vault.addAdapter(adapter);

        vm.startPrank(stranger);
        vm.expectRevert(IPoolmigoVault.PoolmigoVault__NotKeeper.selector);
        vault.rebalance();
        vm.expectRevert(IPoolmigoVault.PoolmigoVault__NotKeeper.selector);
        vault.deployTo(adapter, _one(1));
        vm.expectRevert(IPoolmigoVault.PoolmigoVault__NotKeeper.selector);
        vault.pullFrom(adapter, 1);
        vm.expectRevert(IPoolmigoVault.PoolmigoVault__NotRiskManager.selector);
        vault.pause();
        vm.expectRevert(IPoolmigoVault.PoolmigoVault__NotRiskManager.selector);
        vault.emergencyUnwind();
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                          KNOWN-ISSUE DEMONSTRATIONS
    //////////////////////////////////////////////////////////////*/

    /// @dev Known issue: `redeem` skims whatever the adapter reports as fees, and does not check
    ///      `fees[i] <= amounts[i]` (the bound {IPositionAdapter} documents). A report of fees with
    ///      no tokens delivered taxes the redeemer's idle; `type(uint256).max` bricks the redeem.
    function test_KnownIssue_OverReportedFeesTaxOrBrickRedeem() public {
        MockToken token = new MockToken("T", "T", 18);
        address[] memory basket = new address[](1);
        basket[0] = address(token);
        address owner = makeAddr("owner");
        address treasury = makeAddr("treasury");
        // 10% so the phantom cut is an obvious slice of idle.
        MySunVaultUpgradeable vault = _vault(basket, owner, treasury, 100e18, 1_000);
        OverReportingAdapter adapter = new OverReportingAdapter(address(vault), address(token));
        vm.prank(owner);
        vault.addAdapter(adapter);

        token.mint(owner, 1_000e18);
        vm.startPrank(owner);
        token.approve(address(vault), type(uint256).max);
        vault.deposit(basket, _one(1_000e18), 100e18, owner);
        vm.stopPrank();
        assertEq(token.balanceOf(address(vault)), 1_000e18, "nothing deployed");

        adapter.setMode(OverReportingAdapter.Mode.Phantom);
        vm.prank(owner);
        (, uint256[] memory sent) = vault.redeem(100e18, owner);
        // Idle 1000, reported fees 1000, cut 100, nothing arrived from the adapter.
        assertEq(token.balanceOf(treasury), 100e18, "phantom fee taken from idle");
        assertEq(sent[0], 900e18, "redeemer paid the cut out of principal");

        // Fresh vault: a huge fee report underflows the payout and reverts the whole redeem.
        MySunVaultUpgradeable vault2 = _vault(basket, owner, treasury, 100e18, 1_000);
        OverReportingAdapter adapter2 = new OverReportingAdapter(address(vault2), address(token));
        vm.prank(owner);
        vault2.addAdapter(adapter2);
        token.mint(owner, 1_000e18);
        vm.startPrank(owner);
        token.approve(address(vault2), type(uint256).max);
        vault2.deposit(basket, _one(1_000e18), 100e18, owner);
        vm.stopPrank();
        adapter2.setMode(OverReportingAdapter.Mode.Brick);
        uint256 idleBefore = token.balanceOf(address(vault2));
        vm.prank(owner);
        vm.expectRevert();
        vault2.redeem(100e18, owner);
        assertEq(token.balanceOf(address(vault2)), idleBefore, "bricked redeem moved nothing");
        assertEq(vault2.totalSupply(), 100e18, "shares unburned");
    }

    /// @dev Known issue: `redeem` takes no per-token minimum. `previewRedeem` is the spot report;
    ///      the withdrawal itself can pay a much smaller amount (moved pool, zero mins in the adapter)
    ///      and the transaction still succeeds.
    function test_KnownIssue_RedeemIgnoresDeliveryBelowPreview() public {
        MockToken a = new MockToken("A", "A", 18);
        MockToken b = new MockToken("B", "B", 18);
        address[] memory basket = new address[](2);
        basket[0] = address(a);
        basket[1] = address(b);
        address owner = makeAddr("owner");
        MySunVaultUpgradeable vault = _vault(basket, owner, makeAddr("treasury"), 100e18, FEE_BPS);
        SlippageAdapter adapter = new SlippageAdapter(address(vault), address(a), address(b));
        vm.prank(owner);
        vault.addAdapter(adapter);

        a.mint(owner, 100e18);
        b.mint(owner, 100e18);
        vm.startPrank(owner);
        a.approve(address(vault), type(uint256).max);
        b.approve(address(vault), type(uint256).max);
        vault.deposit(basket, _pair(100e18, 100e18), 100e18, owner);
        vault.setKeeper(owner, true);
        vault.deployTo(adapter, _pair(100e18, 100e18));
        vm.stopPrank();

        adapter.setPayBps(100, 10_000); // token A pays 1% of the reported holding
        (, uint256[] memory preview) = vault.previewRedeem(100e18);
        assertEq(preview[0], 100e18, "preview trusts position()");

        vm.prank(owner);
        (, uint256[] memory sent) = vault.redeem(100e18, owner);
        assertEq(sent[0], 1e18, "1% delivered");
        assertEq(sent[1], 100e18);
        assertLt(sent[0], preview[0] / 10, "no min-amount revert");
    }

    /*//////////////////////////////////////////////////////////////
                                  HELPERS
    //////////////////////////////////////////////////////////////*/

    function _vault(address[] memory basket, address owner, address treasury, uint256 genesis, uint16 feeBps)
        internal
        returns (MySunVaultUpgradeable vault)
    {
        MySunVaultUpgradeable impl = new MySunVaultUpgradeable(VaultImplArgs.depositSplit());
        vault = MySunVaultUpgradeable(
            address(
                new ERC1967Proxy(
                    address(impl),
                    abi.encodeCall(
                        MySunVaultUpgradeable(address(0)).initialize,
                        (owner, "sunGapLP", "sunGapLP", basket, treasury, feeBps, genesis, uint256(0))
                    )
                )
            )
        );
    }

    function _feeVault(uint256 principal)
        internal
        returns (MySunVaultUpgradeable vault, MockToken token, SplitFeeAdapter adapter, address owner)
    {
        token = new MockToken("T", "T", 18);
        address[] memory basket = new address[](1);
        basket[0] = address(token);
        owner = makeAddr("owner");
        vault = _vault(basket, owner, makeAddr("treasury"), 100e18, FEE_BPS);
        adapter = new SplitFeeAdapter(address(vault), address(token));
        vm.prank(owner);
        vault.addAdapter(adapter);

        token.mint(owner, principal);
        vm.startPrank(owner);
        token.approve(address(vault), type(uint256).max);
        vault.deposit(basket, _one(principal), 100e18, owner);
        vault.setKeeper(owner, true);
        vault.deployTo(adapter, _one(principal));
        vm.stopPrank();
    }

    function _approve(MockToken x, MockToken d, address who, address vault) internal {
        vm.startPrank(who);
        x.approve(vault, type(uint256).max);
        d.approve(vault, type(uint256).max);
        vm.stopPrank();
    }

    function _one(uint256 amount) internal pure returns (uint256[] memory amounts) {
        amounts = new uint256[](1);
        amounts[0] = amount;
    }

    function _pair(uint256 a, uint256 b) internal pure returns (uint256[] memory amounts) {
        amounts = new uint256[](2);
        amounts[0] = a;
        amounts[1] = b;
    }
}

/*//////////////////////////////////////////////////////////////
                               FIXTURES
//////////////////////////////////////////////////////////////*/

/// @dev One-token adapter that keeps principal and fees apart and reports the fee slice honestly.
contract SplitFeeAdapter is IPositionAdapter {
    using SafeERC20 for IERC20;

    address public immutable vault;
    address public immutable token;
    uint256 public principal;
    uint256 public fees;

    error SplitFeeAdapter__OnlyVault();

    modifier onlyVault() {
        if (msg.sender != vault) revert SplitFeeAdapter__OnlyVault();
        _;
    }

    constructor(address vault_, address token_) {
        vault = vault_;
        token = token_;
    }

    function accrue(uint256 amount) external {
        MockToken(token).mint(address(this), amount);
        fees += amount;
    }

    function dex() external pure returns (bytes32) {
        return keccak256("SPLIT_FEE");
    }

    function poolId() external pure returns (bytes32) {
        return bytes32(uint256(1));
    }

    function position() public view returns (address[] memory tokens, uint256[] memory amounts) {
        tokens = _tokens();
        amounts = new uint256[](1);
        amounts[0] = principal + fees;
    }

    function deploy(uint256[] calldata amounts)
        external
        onlyVault
        returns (address[] memory tokens, uint256[] memory deployedNow)
    {
        tokens = _tokens();
        deployedNow = new uint256[](1);
        if (amounts[0] != 0) {
            IERC20(token).safeTransferFrom(vault, address(this), amounts[0]);
            principal += amounts[0];
            deployedNow[0] = amounts[0];
        }
    }

    function withdrawProportional(uint256 sharesWad, address to)
        external
        onlyVault
        returns (address[] memory tokens, uint256[] memory amounts, uint256[] memory feeOut)
    {
        tokens = _tokens();
        amounts = new uint256[](1);
        feeOut = new uint256[](1);
        uint256 p = (principal * sharesWad) / 1e18;
        uint256 f = (fees * sharesWad) / 1e18;
        principal -= p;
        fees -= f;
        amounts[0] = p + f;
        feeOut[0] = f;
        if (p + f != 0) IERC20(token).safeTransfer(to, p + f);
    }

    function harvest() external onlyVault returns (address[] memory tokens, uint256[] memory amounts) {
        tokens = _tokens();
        amounts = new uint256[](1);
        amounts[0] = fees;
        fees = 0;
        if (amounts[0] != 0) IERC20(token).safeTransfer(vault, amounts[0]);
    }

    function unwindAll(address to)
        external
        onlyVault
        returns (address[] memory tokens, uint256[] memory amounts, uint256[] memory feeOut)
    {
        return this.withdrawProportional(1e18, to);
    }

    function _tokens() internal view returns (address[] memory tokens) {
        tokens = new address[](1);
        tokens[0] = token;
    }
}

/// @dev Reports fees the vault did not receive, or a fee so large the payout underflows.
contract OverReportingAdapter is IPositionAdapter {
    enum Mode {
        None,
        Phantom,
        Brick
    }

    address public immutable vault;
    address public immutable token;
    Mode public mode;

    error OverReportingAdapter__OnlyVault();

    constructor(address vault_, address token_) {
        vault = vault_;
        token = token_;
    }

    function setMode(Mode mode_) external {
        mode = mode_;
    }

    function dex() external pure returns (bytes32) {
        return keccak256("OVER_REPORT");
    }

    function poolId() external pure returns (bytes32) {
        return bytes32(uint256(2));
    }

    function position() external view returns (address[] memory tokens, uint256[] memory amounts) {
        tokens = new address[](1);
        tokens[0] = token;
        amounts = new uint256[](1);
    }

    function deploy(uint256[] calldata) external view returns (address[] memory tokens, uint256[] memory deployedNow) {
        if (msg.sender != vault) revert OverReportingAdapter__OnlyVault();
        tokens = new address[](1);
        tokens[0] = token;
        deployedNow = new uint256[](1);
    }

    function withdrawProportional(uint256, address)
        external
        view
        returns (address[] memory tokens, uint256[] memory amounts, uint256[] memory feeOut)
    {
        if (msg.sender != vault) revert OverReportingAdapter__OnlyVault();
        tokens = new address[](1);
        tokens[0] = token;
        amounts = new uint256[](1);
        feeOut = new uint256[](1);
        if (mode == Mode.Phantom) feeOut[0] = 1_000e18;
        if (mode == Mode.Brick) feeOut[0] = type(uint256).max;
    }

    function harvest() external view returns (address[] memory tokens, uint256[] memory amounts) {
        if (msg.sender != vault) revert OverReportingAdapter__OnlyVault();
        tokens = new address[](1);
        tokens[0] = token;
        amounts = new uint256[](1);
    }

    function unwindAll(address)
        external
        view
        returns (address[] memory tokens, uint256[] memory amounts, uint256[] memory feeOut)
    {
        if (msg.sender != vault) revert OverReportingAdapter__OnlyVault();
        tokens = new address[](1);
        tokens[0] = token;
        amounts = new uint256[](1);
        feeOut = new uint256[](1);
    }
}

/// @dev `position()` reports the real holding; the withdrawal pays only `payBps` of it.
contract SlippageAdapter is IPositionAdapter {
    using SafeERC20 for IERC20;

    address public immutable vault;
    IERC20 public immutable token0;
    IERC20 public immutable token1;
    uint256 public bal0;
    uint256 public bal1;
    uint256 public pay0Bps = 10_000;
    uint256 public pay1Bps = 10_000;

    error SlippageAdapter__OnlyVault();

    modifier onlyVault() {
        if (msg.sender != vault) revert SlippageAdapter__OnlyVault();
        _;
    }

    constructor(address vault_, address token0_, address token1_) {
        vault = vault_;
        token0 = IERC20(token0_);
        token1 = IERC20(token1_);
    }

    function setPayBps(uint256 pay0, uint256 pay1) external {
        pay0Bps = pay0;
        pay1Bps = pay1;
    }

    function dex() external pure returns (bytes32) {
        return keccak256("SLIPPAGE");
    }

    function poolId() external pure returns (bytes32) {
        return bytes32(uint256(3));
    }

    function position() public view returns (address[] memory tokens, uint256[] memory amounts) {
        tokens = _tokens();
        amounts = new uint256[](2);
        amounts[0] = bal0;
        amounts[1] = bal1;
    }

    function deploy(uint256[] calldata amounts)
        external
        onlyVault
        returns (address[] memory tokens, uint256[] memory deployedNow)
    {
        tokens = _tokens();
        deployedNow = new uint256[](2);
        if (amounts[0] != 0) {
            token0.safeTransferFrom(vault, address(this), amounts[0]);
            bal0 += amounts[0];
            deployedNow[0] = amounts[0];
        }
        if (amounts[1] != 0) {
            token1.safeTransferFrom(vault, address(this), amounts[1]);
            bal1 += amounts[1];
            deployedNow[1] = amounts[1];
        }
    }

    function withdrawProportional(uint256 sharesWad, address to)
        external
        onlyVault
        returns (address[] memory tokens, uint256[] memory amounts, uint256[] memory feeOut)
    {
        tokens = _tokens();
        amounts = new uint256[](2);
        feeOut = new uint256[](2);
        uint256 out0 = (bal0 * sharesWad / 1e18) * pay0Bps / 10_000;
        uint256 out1 = (bal1 * sharesWad / 1e18) * pay1Bps / 10_000;
        bal0 -= out0;
        bal1 -= out1;
        amounts[0] = out0;
        amounts[1] = out1;
        if (out0 != 0) token0.safeTransfer(to, out0);
        if (out1 != 0) token1.safeTransfer(to, out1);
    }

    function harvest() external view onlyVault returns (address[] memory tokens, uint256[] memory amounts) {
        tokens = _tokens();
        amounts = new uint256[](2);
    }

    function unwindAll(address to)
        external
        onlyVault
        returns (address[] memory tokens, uint256[] memory amounts, uint256[] memory feeOut)
    {
        return this.withdrawProportional(1e18, to);
    }

    function _tokens() internal view returns (address[] memory tokens) {
        tokens = new address[](2);
        tokens[0] = address(token0);
        tokens[1] = address(token1);
    }
}

/// @dev On every non-mint transfer, tries to re-enter the vault and records which calls got in.
contract ReenteringToken is ERC20 {
    address public vault;
    bool public armed;
    bool public redeemEntered;
    bool public depositEntered;
    bool public rebalanceEntered;

    constructor() ERC20("Reenter", "RE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(address vault_) external {
        vault = vault_;
        armed = true;
        redeemEntered = false;
        depositEntered = false;
        rebalanceEntered = false;
    }

    function disarm() external {
        armed = false;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (!armed || from == address(0) || to == address(0)) return;
        armed = false;
        MySunVaultUpgradeable v = MySunVaultUpgradeable(vault);
        address[] memory tokens = new address[](1);
        tokens[0] = address(this);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 1;
        try v.redeem(1, address(this)) {
            redeemEntered = true;
        } catch {}
        try v.deposit(tokens, amounts, 1, address(this)) {
            depositEntered = true;
        } catch {}
        try v.rebalance() {
            rebalanceEntered = true;
        } catch {}
    }
}
