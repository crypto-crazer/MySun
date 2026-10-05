// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import {Script, console2} from "forge-std/Script.sol";
import {Upgrades} from "openzeppelin-foundry-upgrades/Upgrades.sol";
import {MySunVaultUpgradeable} from "contracts/MySunVaultUpgradeable.sol";

/**
 * @notice Deploys the UUPS proxy + MySunVaultUpgradeable implementation, validated by the OZ plugin.
 *
 * Always `forge clean && forge build` first (stale build-info aborts the OZ validator).
 *
 * LOCAL anvil (throwaway dev key is acceptable):
 *   forge script script/DeployMySunVaultUpgradeable.s.sol \
 *     --rpc-url http://127.0.0.1:8546 --broadcast --private-key $ANVIL_DEV_KEY
 *
 * Robinhood TESTNET (chain 46630 — key stays in an encrypted keystore, never plaintext):
 *   forge script script/DeployMySunVaultUpgradeable.s.sol \
 *     --rpc-url https://rpc.testnet.chain.robinhood.com \
 *     --account <keystoreName> --sender <yourAddress> --broadcast
 *
 * Env params:
 *   OWNER     — vault owner + upgrade authority (multisig behind timelock on mainnet)
 *   NAME      — receipt-token name   (optional, default "sunEthLP"; per vault — notes/NAMING.md)
 *   SYMBOL    — receipt-token symbol (optional, default "sunEthLP"; per vault — notes/NAMING.md)
 *   TREASURY  — performance-fee recipient
 *   FEE_BPS   — performance fee in bps (<= 3000)
 *   TOKENS    — comma-separated basket token addresses, e.g. "0xUSDG,0xWETH" (1..8, no duplicates)
 *   GENESIS_SHARES   — K, shares minted by the owner-gated genesis deposit (non-zero, 18-dp raw units;
 *                      set from the team's one-time off-chain valuation so display starts ≈$1/share)
 *   MAX_TOTAL_SUPPLY — receipt-token supply cap (raw units; 0 = uncapped; if set, >= GENESIS_SHARES)
 */
contract DeployMySunVaultUpgradeable is Script {
    function run() external returns (address proxy) {
        address owner = vm.envAddress("OWNER");
        string memory name = vm.envOr("NAME", string("sunEthLP"));
        string memory symbol = vm.envOr("SYMBOL", string("sunEthLP"));
        address treasury = vm.envAddress("TREASURY");
        uint16 feeBps = uint16(vm.envUint("FEE_BPS"));
        address[] memory tokens = vm.envAddress("TOKENS", ",");
        uint256 genesisShares = vm.envUint("GENESIS_SHARES");
        uint256 maxTotalSupply = vm.envUint("MAX_TOTAL_SUPPLY");

        vm.startBroadcast();
        proxy = Upgrades.deployUUPSProxy(
            _artifact(),
            abi.encodeCall(
                MySunVaultUpgradeable(address(0)).initialize,
                (owner, name, symbol, tokens, treasury, feeBps, genesisShares, maxTotalSupply)
            )
        );
        vm.stopBroadcast();

        console2.log("MySun vault (proxy) deployed at:", proxy);
        console2.log("  implementation:", Upgrades.getImplementationAddress(proxy), _artifact());
        console2.log("  receipt :", name, symbol);
        console2.log("  owner   :", owner);
        console2.log("  treasury:", treasury);
        console2.log("  fee bps :", feeBps);
        console2.log("  genesis shares (K):", genesisShares);
        console2.log("  max total supply  :", maxTotalSupply);
        for (uint256 i; i < tokens.length; ++i) {
            console2.log("  token   :", tokens[i]);
        }
    }

    /// @dev Implementation artifact the OZ plugin validates and deploys. The `initialize` selector is shared with the
    ///      legacy artifact (same inherited function), so only this name differs in the legacy script.
    function _artifact() internal pure virtual returns (string memory) {
        return "MySunVaultUpgradeable.sol";
    }
}
