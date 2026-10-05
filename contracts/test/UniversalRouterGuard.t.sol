// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import {Test, Vm} from "forge-std/Test.sol";

/**
 * @notice Source guard for the swap router address. On Robinhood Chain 0x66a9893c…A8Af is a byte-for-byte copy of
 *         the Ethereum-MAINNET UniversalRouter (mainnet immutables — no code behind them on RHC; every swap reverts
 *         at the first pool call). It must never be wired anywhere deployable: this suite fails if its address
 *         appears (any case) in any file under `src/` or `script/`. Positive control: the official UniversalRouter
 *         2.1.2 (`deploy-addresses/robinhood.json`) IS what the fork demo script deploys with.
 */
contract UniversalRouterGuardTest is Test {
    /// @dev Lower-case hex fragment of the dead copy (unique prefix; the full address is in the fork suites only).
    string internal constant DEAD_COPY = "66a9893cc07d91d95644aedd05d03f95e1dba8af";
    string internal constant OFFICIAL_UR_2_1_2 = "204faca1764b154221e35c0d20abb3c525710498";

    function test_DeadRouterCopyAppearsNowhereInSrcOrScript() public view {
        assertGt(_assertAbsent("src"), 0, "scanned src/");
        assertGt(_assertAbsent("script"), 0, "scanned script/");
    }

    function test_ForkDemoUsesOfficialRouter() public view {
        string memory demo = vm.toLowercase(vm.readFile("script/DemoLocalFork.s.sol"));
        assertTrue(vm.indexOf(demo, OFFICIAL_UR_2_1_2) != type(uint256).max, "demo wires UR 2.1.2");
        string memory runbook = vm.toLowercase(vm.readFile("script/fork-demo-up.sh"));
        assertTrue(vm.indexOf(runbook, OFFICIAL_UR_2_1_2) != type(uint256).max, "runbook guards UR 2.1.2");
    }

    /// @dev Every regular file under `dir` (recursive), lower-cased, must not contain the dead copy's address or its
    ///      8-hex-digit prefix. Returns the number of files scanned.
    function _assertAbsent(string memory dir) internal view returns (uint256 files) {
        Vm.DirEntry[] memory entries = vm.readDir(dir, 32);
        for (uint256 i; i < entries.length; ++i) {
            Vm.DirEntry memory e = entries[i];
            assertEq(bytes(e.errorMessage).length, 0, e.errorMessage);
            if (e.isDir || e.isSymlink) {
                continue;
            }
            string memory body = vm.toLowercase(vm.readFile(e.path));
            assertEq(vm.indexOf(body, DEAD_COPY), type(uint256).max, e.path);
            assertEq(vm.indexOf(body, "66a9893c"), type(uint256).max, e.path);
            ++files;
        }
    }
}
