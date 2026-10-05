// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import {Test, Vm} from "forge-std/Test.sol";
import {Upgrades} from "openzeppelin-foundry-upgrades/Upgrades.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {MySunVaultUpgradeable} from "contracts/MySunVaultUpgradeable.sol";
import {IPoolmigoVault} from "contracts/interfaces/IPoolmigoVault.sol";
import {IPositionAdapter} from "contracts/interfaces/IPositionAdapter.sol";
import {ILiquidityAdapter} from "contracts/interfaces/ILiquidityAdapter.sol";
import {ISwapAdapter} from "contracts/interfaces/ISwapAdapter.sol";
import {PlanExecutor} from "contracts/periphery/PlanExecutor.sol";
import {MockToken} from "test/mocks/MockToken.sol";
import {MockLiquidityAdapter} from "test/mocks/MockLiquidityAdapter.sol";
import {MockSwapAdapter} from "test/mocks/MockSwapAdapter.sol";
import {MockPlanVault} from "test/mocks/MockPlanVault.sol";

/**
 * @notice Strategy layer P3 — {PlanExecutor} unit coverage.
 *         - Against {MockPlanVault} (a recording stand-in for the vault keeper surface): strict array order, the exact
 *           dispatch shape of each kind, the upfront checks (caller, deadline, nonce, supply pin, adapter pins,
 *           coverage, kinds, payload sizes) running before ANY component, decode failures, all-or-nothing, re-entry.
 *         - Against the REAL vault + {MockSwapAdapter}: a plan runs only as a vault keeper, vault gates (pause) bubble,
 *           the vault's keeper events carry the executor.
 */
contract PlanExecutorTest is Test {
    MockPlanVault internal mv;
    PlanExecutor internal exec;
    MockLiquidityAdapter internal la;
    MockLiquidityAdapter internal lb;
    MockToken internal tA;
    MockToken internal tB;

    address internal owner = makeAddr("owner");
    address internal keeper = makeAddr("keeper");
    address internal keeper2 = makeAddr("keeper2");
    address internal alice = makeAddr("alice");

    uint256 internal constant SUPPLY = 1_000e18;
    address[] internal basket;

    function setUp() public {
        tA = new MockToken("Token A", "TKA", 18);
        tB = new MockToken("Token B", "TKB", 18);
        basket.push(address(tA));
        basket.push(address(tB));
        mv = new MockPlanVault();
        mv.setTotalSupply(SUPPLY);
        exec = new PlanExecutor(IPoolmigoVault(address(mv)), owner);
        la = new MockLiquidityAdapter(basket, address(mv), "LA", bytes32(uint256(1)));
        lb = new MockLiquidityAdapter(basket, address(mv), "LB", bytes32(uint256(2)));
        lb.setPositionState(-600, 600, 5e17, 7);
        vm.startPrank(owner);
        exec.setKeeper(keeper, true);
        exec.setKeeper(keeper2, true);
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                              WIRING / ADMIN
    //////////////////////////////////////////////////////////////*/

    function test_Constructor() public {
        assertEq(address(exec.VAULT()), address(mv));
        assertEq(exec.owner(), owner);
        vm.expectRevert(PlanExecutor.PlanExecutor__ZeroAddress.selector);
        new PlanExecutor(IPoolmigoVault(address(0)), owner);
        assertEq(exec.KIND_HARVEST(), 0);
        assertEq(exec.KIND_SWAP(), 1);
        assertEq(exec.KIND_ADD_LIQUIDITY(), 2);
        assertEq(exec.KIND_REMOVE_LIQUIDITY(), 3);
        assertEq(exec.KIND_CLOSE_POSITION(), 4);
    }

    function test_SetKeeper_OwnerOnlyEmitsRejectsZero() public {
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, keeper));
        exec.setKeeper(alice, true);

        vm.startPrank(owner);
        vm.expectRevert(PlanExecutor.PlanExecutor__ZeroAddress.selector);
        exec.setKeeper(address(0), true);
        vm.expectEmit(true, true, true, true, address(exec));
        emit PlanExecutor.KeeperSet(alice, true);
        exec.setKeeper(alice, true);
        assertTrue(exec.isKeeper(alice));
        vm.expectEmit(true, true, true, true, address(exec));
        emit PlanExecutor.KeeperSet(alice, false);
        exec.setKeeper(alice, false);
        vm.stopPrank();
        assertFalse(exec.isKeeper(alice));
    }

    function test_ExecutePlan_NonKeeperReverts() public {
        PlanExecutor.Plan memory plan = _plan(0, _pins1(address(la)), _comps1(_harvest()));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PlanExecutor.PlanExecutor__NotKeeper.selector, alice));
        exec.executePlan(plan);

        vm.prank(owner);
        exec.setKeeper(keeper, false);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(PlanExecutor.PlanExecutor__NotKeeper.selector, keeper));
        exec.executePlan(plan);
        // The executor's OWNER is not a keeper either (roles are separate).
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PlanExecutor.PlanExecutor__NotKeeper.selector, owner));
        exec.executePlan(plan);
        assertEq(mv.callCount(), 0);
    }

    /*//////////////////////////////////////////////////////////////
                         ORDER + DISPATCH SHAPES
    //////////////////////////////////////////////////////////////*/

    /// @dev Remove → Swap → Add → Harvest → Close run in exactly that order, each as the right typed vault call with
    ///      the payload's params verbatim (Close = `pullFrom(adapter, 10_000)`, Harvest = `rebalance()` with its
    ///      adapter field ignored); the vault sees the executor as caller; the nonce is consumed; `PlanExecuted`
    ///      carries keccak256(abi.encode(plan)).
    function test_ExecutePlan_OrderAndDispatchShapes() public {
        ILiquidityAdapter.RemoveLiquidityParams memory r = ILiquidityAdapter.RemoveLiquidityParams(4e17, 11, 12);
        ISwapAdapter.SwapParams memory s = ISwapAdapter.SwapParams(address(tA), address(tB), 3e18, 2e18);
        ILiquidityAdapter.AddLiquidityParams memory a =
            ILiquidityAdapter.AddLiquidityParams(-120, 240, 9e17, 8e17, 5e18, 6e18, 7);
        PlanExecutor.Component[] memory comps = new PlanExecutor.Component[](5);
        comps[0] = _remove(address(la), r);
        comps[1] = _swap(address(lb), s);
        comps[2] = _addC(address(la), a);
        comps[3] = PlanExecutor.Component(0, alice, ""); // harvest: adapter ignored, needs no pin
        comps[4] = _close(address(lb));
        PlanExecutor.Plan memory plan = _plan(0, _pins2(address(la), address(lb)), comps);

        vm.prank(keeper);
        vm.expectEmit(true, true, true, true, address(exec));
        emit PlanExecutor.PlanExecuted(keccak256(abi.encode(plan)), keeper, 0);
        exec.executePlan(plan);

        assertEq(mv.callCount(), 5);
        uint8[5] memory kinds = [3, 1, 2, 0, 4];
        address[5] memory adapters = [address(la), address(lb), address(la), address(0), address(lb)];
        bytes[5] memory params = [abi.encode(r), abi.encode(s), abi.encode(a), bytes(""), abi.encode(uint256(10_000))];
        for (uint256 i; i < 5; ++i) {
            MockPlanVault.Call memory c = mv.callAt(i);
            assertEq(c.kind, kinds[i], "kind / order");
            assertEq(c.adapter, adapters[i], "adapter");
            assertEq(c.params, params[i], "typed params verbatim");
            assertEq(c.caller, address(exec), "the vault sees the executor");
        }
        assertEq(exec.nonces(keeper), 1);
        assertEq(exec.nonces(keeper2), 0, "per keeper");
    }

    /// @dev The same components in another order are executed in THAT order (no reordering by kind).
    function test_ExecutePlan_ArrayOrderIsExecutionOrder() public {
        PlanExecutor.Component[] memory comps = new PlanExecutor.Component[](4);
        comps[0] = _close(address(la));
        comps[1] = _harvest();
        comps[2] = _addC(address(la), ILiquidityAdapter.AddLiquidityParams(-60, 60, 1, 0, 1, 1, 0));
        comps[3] = _close(address(la));
        _exec(keeper, _plan(0, _pins1(address(la)), comps));
        uint8[4] memory kinds = [4, 0, 2, 4];
        assertEq(mv.callCount(), 4);
        for (uint256 i; i < 4; ++i) {
            assertEq(mv.callAt(i).kind, kinds[i]);
        }
    }

    /// @dev No components: only the nonce moves — a keeper's way to invalidate a plan already signed off/broadcast.
    function test_ExecutePlan_EmptyPlanConsumesNonce() public {
        PlanExecutor.Plan memory plan = _plan(0, new PlanExecutor.Pin[](0), new PlanExecutor.Component[](0));
        vm.prank(keeper);
        vm.expectEmit(true, true, true, true, address(exec));
        emit PlanExecutor.PlanExecuted(keccak256(abi.encode(plan)), keeper, 0);
        exec.executePlan(plan);
        assertEq(exec.nonces(keeper), 1);
        assertEq(mv.callCount(), 0);
    }

    /*//////////////////////////////////////////////////////////////
                         NONCE / DEADLINE / SUPPLY
    //////////////////////////////////////////////////////////////*/

    function test_ExecutePlan_NonceReplayAndOutOfOrder() public {
        PlanExecutor.Plan memory p0 = _plan(0, _pins1(address(la)), _comps1(_harvest()));
        vm.prank(keeper);
        exec.executePlan(p0);

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(PlanExecutor.PlanExecutor__InvalidNonce.selector, 1, 0));
        exec.executePlan(p0); // replay

        PlanExecutor.Plan memory p2 = _plan(2, _pins1(address(la)), _comps1(_harvest()));
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(PlanExecutor.PlanExecutor__InvalidNonce.selector, 1, 2));
        exec.executePlan(p2); // skips ahead

        // Another keeper's counter is independent: nonce 0 is still fresh for keeper2.
        vm.prank(keeper2);
        exec.executePlan(p0);
        assertEq(exec.nonces(keeper2), 1);

        PlanExecutor.Plan memory p1 = _plan(1, _pins1(address(la)), _comps1(_harvest()));
        vm.prank(keeper);
        exec.executePlan(p1);
        vm.prank(keeper);
        exec.executePlan(p2);
        assertEq(exec.nonces(keeper), 3);
        assertEq(mv.callCount(), 4);
    }

    function test_ExecutePlan_Deadline() public {
        PlanExecutor.Plan memory plan = _plan(0, _pins1(address(la)), _comps1(_harvest()));
        plan.deadline = uint64(block.timestamp - 1);
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(PlanExecutor.PlanExecutor__Expired.selector, plan.deadline, block.timestamp)
        );
        exec.executePlan(plan);

        plan.deadline = uint64(block.timestamp); // inclusive
        vm.prank(keeper);
        exec.executePlan(plan);
        assertEq(exec.nonces(keeper), 1);
    }

    function test_ExecutePlan_SupplyPinMismatch() public {
        PlanExecutor.Plan memory plan = _plan(0, _pins1(address(la)), _comps1(_close(address(la))));
        plan.expectedTotalSupply = SUPPLY + 1;
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(PlanExecutor.PlanExecutor__SupplyMismatch.selector, SUPPLY + 1, SUPPLY));
        exec.executePlan(plan);

        plan.expectedTotalSupply = SUPPLY;
        mv.setTotalSupply(SUPPLY - 1); // e.g. a redemption landed after the plan was sized
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(PlanExecutor.PlanExecutor__SupplyMismatch.selector, SUPPLY, SUPPLY - 1));
        exec.executePlan(plan);
        assertEq(mv.callCount(), 0);
        assertEq(exec.nonces(keeper), 0);
    }

    /*//////////////////////////////////////////////////////////////
                           PINS + COVERAGE
    //////////////////////////////////////////////////////////////*/

    /// @dev Any single field off (token id, either bound, liquidity, configVersion) fails the pin, upfront — no
    ///      component runs, even one on a different, correctly pinned adapter.
    function test_ExecutePlan_AdapterPinMismatchEveryField() public {
        for (uint256 f; f < 5; ++f) {
            PlanExecutor.Pin[] memory pins = _pins2(address(la), address(lb));
            if (f == 0) pins[1].tokenId += 1;
            if (f == 1) pins[1].tickLower -= 1;
            if (f == 2) pins[1].tickUpper += 1;
            if (f == 3) pins[1].liquidity -= 1;
            if (f == 4) pins[1].configVersion += 1;
            _execExpect(
                keeper,
                _plan(0, pins, _comps1(_close(address(la)))),
                abi.encodeWithSelector(PlanExecutor.PlanExecutor__PinMismatch.selector, 1, address(lb))
            );
        }
        assertEq(mv.callCount(), 0);
        assertEq(exec.nonces(keeper), 0);
    }

    /// @dev A pin taken before a state change goes stale: the live positionState moved (e.g. an owner config change
    ///      bumped configVersion) → the plan fails; re-pinning makes it pass.
    function test_ExecutePlan_StalePinAfterLiveChange() public {
        PlanExecutor.Pin[] memory pins = _pins1(address(la));
        la.setPositionState(-120, 240, 1e18, 2); // configVersion 1 → 2
        _execExpect(
            keeper,
            _plan(0, pins, _comps1(_close(address(la)))),
            abi.encodeWithSelector(PlanExecutor.PlanExecutor__PinMismatch.selector, 0, address(la))
        );

        _exec(keeper, _plan(0, _pins1(address(la)), _comps1(_close(address(la)))));
        assertEq(mv.callCount(), 1);
    }

    /// @dev Every adapter-bearing component must be pinned; Harvest needs no pin (its adapter field is ignored).
    function test_ExecutePlan_CoverageViolation() public {
        PlanExecutor.Component[] memory comps = new PlanExecutor.Component[](3);
        comps[0] = _harvest();
        comps[1] = _close(address(la));
        comps[2] = _remove(address(lb), ILiquidityAdapter.RemoveLiquidityParams(0, 0, 0));
        _execExpect(
            keeper,
            _plan(0, _pins1(address(la)), comps),
            abi.encodeWithSelector(PlanExecutor.PlanExecutor__UnpinnedAdapter.selector, 2, address(lb))
        );

        // address(0) on an adapter kind is never covered.
        comps[2] = _swap(address(0), ISwapAdapter.SwapParams(address(tA), address(tB), 1, 1));
        _execExpect(
            keeper,
            _plan(0, _pins1(address(la)), comps),
            abi.encodeWithSelector(PlanExecutor.PlanExecutor__UnpinnedAdapter.selector, 2, address(0))
        );

        // No pins at all: only Harvest is allowed.
        _execExpect(
            keeper,
            _plan(0, new PlanExecutor.Pin[](0), _comps1(_close(address(la)))),
            abi.encodeWithSelector(PlanExecutor.PlanExecutor__UnpinnedAdapter.selector, 0, address(la))
        );
        assertEq(mv.callCount(), 0);

        PlanExecutor.Component[] memory h = new PlanExecutor.Component[](1);
        h[0] = PlanExecutor.Component(0, address(lb), ""); // harvest naming an unpinned adapter: ignored
        _exec(keeper, _plan(0, new PlanExecutor.Pin[](0), h));
        assertEq(mv.callCount(), 1);
    }

    /*//////////////////////////////////////////////////////////////
                         KINDS / PAYLOADS / DECODE
    //////////////////////////////////////////////////////////////*/

    function test_ExecutePlan_UnsupportedKind() public {
        uint8[3] memory bad = [5, 6, 255];
        for (uint256 i; i < 3; ++i) {
            PlanExecutor.Component[] memory comps = new PlanExecutor.Component[](2);
            comps[0] = _harvest(); // valid and first — still never runs
            comps[1] = PlanExecutor.Component(bad[i], address(la), "");
            _execExpect(
                keeper,
                _plan(0, _pins1(address(la)), comps),
                abi.encodeWithSelector(PlanExecutor.PlanExecutor__UnsupportedComponent.selector, 1, bad[i])
            );
        }
        assertEq(mv.callCount(), 0);
    }

    /// @dev Payload length must be the exact ABI size of the kind's struct (0 for Harvest / Close) — no trailing
    ///      bytes, no short payloads; checked upfront.
    function test_ExecutePlan_PayloadSizeChecks() public {
        bytes memory swapOk = abi.encode(ISwapAdapter.SwapParams(address(tA), address(tB), 1, 1));
        bytes memory addOk = abi.encode(ILiquidityAdapter.AddLiquidityParams(-60, 60, 1, 0, 1, 1, 0));
        bytes memory removeOk = abi.encode(ILiquidityAdapter.RemoveLiquidityParams(1, 0, 0));
        assertEq(swapOk.length, 128);
        assertEq(addOk.length, 224);
        assertEq(removeOk.length, 96);

        _expectBadPayload(0, hex"00");
        _expectBadPayload(4, abi.encode(uint256(10_000)));
        _expectBadPayload(1, _trim(swapOk, 1));
        _expectBadPayload(1, bytes.concat(swapOk, hex"00"));
        _expectBadPayload(2, _trim(addOk, 32));
        _expectBadPayload(2, bytes.concat(addOk, bytes32(0)));
        _expectBadPayload(3, _trim(removeOk, 1));
        _expectBadPayload(3, swapOk);
        assertEq(mv.callCount(), 0);
    }

    /// @dev Right length, invalid content: abi.decode into the typed struct reverts (int24 out of range, dirty address
    ///      bits) — the whole plan rolls back, including components that already ran, and the nonce is not consumed.
    function test_ExecutePlan_DecodeFailureReverts() public {
        bytes memory addBad = abi.encode(ILiquidityAdapter.AddLiquidityParams(-60, 60, 1, 0, 1, 1, 0));
        assembly ("memory-safe") {
            mstore(add(addBad, 0x20), shl(200, 1)) // tickLower word: not a sign-extended int24
        }
        PlanExecutor.Component[] memory comps = new PlanExecutor.Component[](2);
        comps[0] = _harvest();
        comps[1] = PlanExecutor.Component(2, address(la), addBad);
        _execExpectAny(keeper, _plan(0, _pins1(address(la)), comps));

        bytes memory swapBad = abi.encode(ISwapAdapter.SwapParams(address(tA), address(tB), 1, 1));
        assembly ("memory-safe") {
            mstore(add(swapBad, 0x40), not(0)) // tokenOut word: high bits set
        }
        comps[1] = PlanExecutor.Component(1, address(la), swapBad);
        _execExpectAny(keeper, _plan(0, _pins1(address(la)), comps));

        assertEq(mv.callCount(), 0, "the harvest that ran first was rolled back");
        assertEq(exec.nonces(keeper), 0);

        // Control: the same plan with clean payload words executes — the revert was the decode.
        comps[1] = _addC(address(la), ILiquidityAdapter.AddLiquidityParams(-60, 60, 1, 0, 1, 1, 0));
        _exec(keeper, _plan(0, _pins1(address(la)), comps));
        comps[1] = _swap(address(la), ISwapAdapter.SwapParams(address(tA), address(tB), 1, 1));
        _exec(keeper, _plan(1, _pins1(address(la)), comps));
        assertEq(mv.callCount(), 4);
    }

    /*//////////////////////////////////////////////////////////////
                      ALL-OR-NOTHING / RE-ENTRY
    //////////////////////////////////////////////////////////////*/

    function test_ExecutePlan_LaterFailureRollsBackEverything() public {
        mv.setFailAt(3);
        PlanExecutor.Component[] memory comps = new PlanExecutor.Component[](3);
        comps[0] = _harvest();
        comps[1] = _close(address(la));
        comps[2] = _close(address(la));
        _execExpect(
            keeper,
            _plan(0, _pins1(address(la)), comps),
            abi.encodeWithSelector(MockPlanVault.MockPlanVault__Fail.selector, 3)
        );
        assertEq(mv.callCount(), 0);
        assertEq(exec.nonces(keeper), 0, "nonce not consumed");
    }

    function test_ExecutePlan_ReentryBlocked() public {
        PlanExecutor.Plan memory inner = _plan(0, _pins1(address(la)), _comps1(_harvest()));
        mv.setReenter(address(exec), abi.encodeCall(PlanExecutor.executePlan, (inner)));
        _execExpect(
            keeper,
            _plan(0, _pins1(address(la)), _comps1(_harvest())),
            abi.encodePacked(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector)
        );
        assertEq(exec.nonces(keeper), 0);
    }

    /*//////////////////////////////////////////////////////////////
                 REAL VAULT: KEEPER WIRING, GATES, EVENTS
    //////////////////////////////////////////////////////////////*/

    /// @dev Remove → Swap → Add → Harvest → Close through the real vault: runs only once the executor is a VAULT
    ///      keeper; the vault's keeper events name the executor; the swap's output stays in the vault; a paused vault
    ///      blocks the plan (no pause mirror needed); a deposit after sizing breaks the supply pin.
    function test_RealVault_PlanRunsAsVaultKeeper() public {
        (MySunVaultUpgradeable vault, MockSwapAdapter msa, PlanExecutor px) = _realVault();
        PlanExecutor.Component[] memory comps = new PlanExecutor.Component[](5);
        comps[0] = _remove(address(msa), ILiquidityAdapter.RemoveLiquidityParams(0, 0, 0));
        comps[1] = _swap(address(msa), ISwapAdapter.SwapParams(address(tA), address(tB), 10e18, 10e18));
        comps[2] = _addC(address(msa), ILiquidityAdapter.AddLiquidityParams(-120, 240, 1e18, 0, 1e18, 1e18, 0));
        comps[3] = _harvest();
        comps[4] = _close(address(msa));
        PlanExecutor.Plan memory plan = _planFor(vault, 0, _pins1(address(msa)), comps);

        // Not yet a vault keeper: the vault's own gate bubbles, nothing consumed.
        vm.prank(keeper);
        vm.expectRevert(IPoolmigoVault.PoolmigoVault__NotKeeper.selector);
        px.executePlan(plan);
        assertEq(px.nonces(keeper), 0);

        vm.prank(owner);
        vault.setKeeper(address(px), true);
        vm.prank(owner);
        vault.setPaused(true);
        vm.prank(keeper);
        vm.expectRevert(IPoolmigoVault.PoolmigoVault__Paused.selector);
        px.executePlan(plan);
        vm.prank(owner);
        vault.setPaused(false);

        uint256 a0 = tA.balanceOf(address(vault));
        uint256 b0 = tB.balanceOf(address(vault));
        vm.recordLogs();
        vm.prank(keeper);
        px.executePlan(plan);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(msa.removeCalls(), 1);
        assertEq(msa.swapCalls(), 1);
        assertEq(msa.addCalls(), 1);
        assertEq(tA.balanceOf(address(vault)), a0 - 10e18, "swap input left the vault");
        assertEq(tB.balanceOf(address(vault)), b0 + 10e18, "swap output stayed in the vault");
        assertEq(tA.allowance(address(vault), address(msa)) + tB.allowance(address(vault), address(msa)), 0);
        assertEq(tA.balanceOf(address(px)) + tB.balanceOf(address(px)), 0, "the executor holds nothing");
        // Vault keeper events carry the executor as keeper (topic 1).
        bytes32[4] memory sigs = [
            IPoolmigoVault.LiquidityRemoved.selector,
            IPoolmigoVault.LiquidityAdded.selector,
            IPoolmigoVault.Rebalanced.selector,
            IPoolmigoVault.PulledFrom.selector
        ];
        for (uint256 k; k < 4; ++k) {
            uint256 seen;
            for (uint256 i; i < logs.length; ++i) {
                if (logs[i].emitter == address(vault) && logs[i].topics[0] == sigs[k]) {
                    assertEq(address(uint160(uint256(logs[i].topics[1]))), address(px));
                    ++seen;
                }
            }
            assertEq(seen, 1, "one vault event per component");
        }
        assertEq(px.nonces(keeper), 1);

        // A deposit after the next plan was sized: the supply pin catches it.
        PlanExecutor.Plan memory next = _planFor(vault, 1, _pins1(address(msa)), _comps1(_harvest()));
        tA.mint(alice, 10e18);
        tB.mint(alice, 10e18);
        vm.startPrank(alice);
        tA.approve(address(vault), 10e18);
        tB.approve(address(vault), 10e18);
        vault.deposit(basket, _pair(10e18, 10e18), 1, alice);
        vm.stopPrank();
        vm.prank(keeper);
        vm.expectPartialRevert(PlanExecutor.PlanExecutor__SupplyMismatch.selector);
        px.executePlan(next);
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    function _exec(address who, PlanExecutor.Plan memory plan) internal {
        vm.prank(who);
        exec.executePlan(plan);
    }

    /// @dev Plans are built BEFORE the prank / expectRevert (building one makes external view calls).
    function _execExpect(address who, PlanExecutor.Plan memory plan, bytes memory err) internal {
        vm.prank(who);
        vm.expectRevert(err);
        exec.executePlan(plan);
    }

    function _execExpectAny(address who, PlanExecutor.Plan memory plan) internal {
        vm.prank(who);
        vm.expectRevert();
        exec.executePlan(plan);
    }

    function _realVault() internal returns (MySunVaultUpgradeable vault, MockSwapAdapter msa, PlanExecutor px) {
        vault = MySunVaultUpgradeable(
            Upgrades.deployUUPSProxy(
                "MySunVaultUpgradeable.sol",
                abi.encodeCall(
                    MySunVaultUpgradeable(address(0)).initialize,
                    (owner, "sunEthLP", "sunEthLP", basket, owner, uint16(1500), 1_000e18, uint256(0))
                )
            )
        );
        msa = new MockSwapAdapter(basket, address(vault), "MS", bytes32(uint256(3)));
        px = new PlanExecutor(IPoolmigoVault(address(vault)), owner);
        vm.startPrank(owner);
        vault.addAdapter(IPositionAdapter(address(msa)));
        px.setKeeper(keeper, true);
        tA.mint(owner, 1_000e18);
        tB.mint(owner, 1_000e18);
        tA.approve(address(vault), 1_000e18);
        tB.approve(address(vault), 1_000e18);
        vault.deposit(basket, _pair(1_000e18, 1_000e18), 1_000e18, owner);
        vm.stopPrank();
    }

    function _planFor(
        MySunVaultUpgradeable vault,
        uint256 nonce,
        PlanExecutor.Pin[] memory pins,
        PlanExecutor.Component[] memory comps
    ) internal view returns (PlanExecutor.Plan memory) {
        return PlanExecutor.Plan(nonce, uint64(block.timestamp + 60), vault.totalSupply(), pins, comps);
    }

    function _plan(uint256 nonce, PlanExecutor.Pin[] memory pins, PlanExecutor.Component[] memory comps)
        internal
        view
        returns (PlanExecutor.Plan memory)
    {
        return PlanExecutor.Plan(nonce, uint64(block.timestamp + 60), mv.totalSupply(), pins, comps);
    }

    /// @dev A pin equal to the adapter's live positionState().
    function _pin(address adapter) internal view returns (PlanExecutor.Pin memory p) {
        p.adapter = adapter;
        (p.tokenId, p.tickLower, p.tickUpper, p.liquidity, p.configVersion) = ILiquidityAdapter(adapter).positionState();
    }

    function _pins1(address a) internal view returns (PlanExecutor.Pin[] memory pins) {
        pins = new PlanExecutor.Pin[](1);
        pins[0] = _pin(a);
    }

    function _pins2(address a, address b) internal view returns (PlanExecutor.Pin[] memory pins) {
        pins = new PlanExecutor.Pin[](2);
        pins[0] = _pin(a);
        pins[1] = _pin(b);
    }

    function _comps1(PlanExecutor.Component memory c) internal pure returns (PlanExecutor.Component[] memory comps) {
        comps = new PlanExecutor.Component[](1);
        comps[0] = c;
    }

    function _harvest() internal pure returns (PlanExecutor.Component memory) {
        return PlanExecutor.Component(0, address(0), "");
    }

    function _swap(address adapter, ISwapAdapter.SwapParams memory p)
        internal
        pure
        returns (PlanExecutor.Component memory)
    {
        return PlanExecutor.Component(1, adapter, abi.encode(p));
    }

    function _addC(address adapter, ILiquidityAdapter.AddLiquidityParams memory p)
        internal
        pure
        returns (PlanExecutor.Component memory)
    {
        return PlanExecutor.Component(2, adapter, abi.encode(p));
    }

    function _remove(address adapter, ILiquidityAdapter.RemoveLiquidityParams memory p)
        internal
        pure
        returns (PlanExecutor.Component memory)
    {
        return PlanExecutor.Component(3, adapter, abi.encode(p));
    }

    function _close(address adapter) internal pure returns (PlanExecutor.Component memory) {
        return PlanExecutor.Component(4, adapter, "");
    }

    function _expectBadPayload(uint8 kind, bytes memory payload) internal {
        PlanExecutor.Component[] memory comps = new PlanExecutor.Component[](2);
        comps[0] = _harvest();
        comps[1] = PlanExecutor.Component(kind, address(la), payload);
        _execExpect(
            keeper,
            _plan(0, _pins1(address(la)), comps),
            abi.encodeWithSelector(PlanExecutor.PlanExecutor__InvalidPayload.selector, 1, payload.length)
        );
    }

    function _trim(bytes memory b, uint256 cut) internal pure returns (bytes memory out) {
        out = new bytes(b.length - cut);
        for (uint256 i; i < out.length; ++i) {
            out[i] = b[i];
        }
    }

    function _pair(uint256 a, uint256 b) internal pure returns (uint256[] memory out) {
        out = new uint256[](2);
        out[0] = a;
        out[1] = b;
    }
}
