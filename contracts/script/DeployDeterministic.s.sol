// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import {Script, console2} from "forge-std/Script.sol";
import {Upgrades, Options} from "openzeppelin-foundry-upgrades/Upgrades.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {MySunVaultUpgradeable} from "contracts/MySunVaultUpgradeable.sol";
import {PoolmigoCreate3} from "contracts/periphery/PoolmigoCreate3.sol";

/**
 * @notice Deterministic vault deployment: the UUPS proxy lands on
 * `CREATE3_FACTORY.create3Address(deployer, SALT)` — the same address on every chain where the factory
 * sits at the same address AND the same deployer account broadcasts this script — while the
 * implementation is a plain per-chain CREATE (its address may differ; the proxy stores it).
 * Salt default: keccak256("poolmigo.vault.v1") — the registered salt text predates the MySun rebrand and stays
 * unchanged (renaming it would move the predicted address). The factory binds the salt to the caller
 * (effective salt = keccak256(SALT ‖ deployer)), so nobody else can squat the team's documented salts;
 * the flip side is that a different deployer lands on a different address — always deploy from the
 * project's one dedicated deployer account (notes/NAMING.md, salt registry).
 * ONE SALT PER VAULT PER CHAIN: a second vault (e.g. the stocks basket) needs its own salt —
 * registry in notes/NAMING.md (e.g. SALT=$(cast keccak "poolmigo.vault.stocks.v1")).
 *
 * Always `forge clean && forge build` first (the OZ validator needs a single fresh build-info).
 *
 *   CREATE3_FACTORY=0x... OWNER=0x... TREASURY=0x... FEE_BPS=1000 TOKENS=0x..,0x.. \
 *   GENESIS_SHARES=10000000000000000000000 MAX_TOTAL_SUPPLY=500000000000000000000000 \
 *   forge script script/DeployDeterministic.s.sol --rpc-url <rpc> \
 *     --account <keystoreName> --sender <address> --broadcast
 *
 * Env: CREATE3_FACTORY, OWNER, TREASURY, FEE_BPS, TOKENS (comma-separated), GENESIS_SHARES (K, non-zero),
 *      MAX_TOTAL_SUPPLY (0 = uncapped);
 *      NAME / SYMBOL (receipt token, optional, default "sunEthLP" / "sunEthLP");
 *      SALT (bytes32, optional); LABEL (optional log tag, so two runs can be diffed).
 */
contract DeployDeterministic is Script {
    struct Params {
        address owner;
        string name;
        string symbol;
        address treasury;
        uint16 feeBps;
        address[] tokens;
        uint256 genesisShares;
        uint256 maxTotalSupply;
        bytes32 salt;
        string label;
    }

    function run() external returns (address proxy, address implementation) {
        Params memory p = _readParams();
        PoolmigoCreate3 factory = PoolmigoCreate3(vm.envAddress("CREATE3_FACTORY"));
        bytes memory initData = abi.encodeCall(
            MySunVaultUpgradeable(address(0)).initialize,
            (p.owner, p.name, p.symbol, p.tokens, p.treasury, p.feeBps, p.genesisShares, p.maxTotalSupply)
        );

        // OZ upgrade-safety validation (needs a single fresh build-info — clean-build first).
        Options memory opts;
        Upgrades.validateImplementation("MySunVaultUpgradeable.sol", opts);

        vm.startBroadcast();
        // The proxy address depends on the broadcasting deployer (salt bound to msg.sender at the factory).
        (, address deployer,) = vm.readCallers();
        address predicted = factory.create3Address(deployer, p.salt);
        implementation = address(new MySunVaultUpgradeable());
        bytes memory proxyCode = abi.encodePacked(type(ERC1967Proxy).creationCode, abi.encode(implementation, initData));
        proxy = factory.deploy(p.salt, proxyCode);
        vm.stopBroadcast();

        _verify(p, proxy, implementation, predicted);
        _log(p, proxy, implementation, address(factory), predicted);
        console2.log("[%s] POOLMIGO_DEPLOYER=%s", p.label, deployer);
    }

    function _readParams() internal view returns (Params memory p) {
        p.owner = vm.envAddress("OWNER");
        p.name = vm.envOr("NAME", string("sunEthLP"));
        p.symbol = vm.envOr("SYMBOL", string("sunEthLP"));
        p.treasury = vm.envAddress("TREASURY");
        p.feeBps = uint16(vm.envUint("FEE_BPS"));
        p.tokens = vm.envAddress("TOKENS", ",");
        p.genesisShares = vm.envUint("GENESIS_SHARES");
        p.maxTotalSupply = vm.envUint("MAX_TOTAL_SUPPLY");
        p.salt = vm.envOr("SALT", keccak256("poolmigo.vault.v1"));
        p.label = vm.envOr("LABEL", string("deploy"));
    }

    function _verify(Params memory p, address proxy, address implementation, address predicted) internal view {
        require(proxy == predicted, "CREATE3 address mismatch");
        require(Upgrades.getImplementationAddress(proxy) == implementation, "EIP-1967 slot mismatch");
        MySunVaultUpgradeable vault = MySunVaultUpgradeable(proxy);
        require(
            vault.owner() == p.owner && vault.treasury() == p.treasury && vault.performanceFeeBps() == p.feeBps
                && vault.genesisShares() == p.genesisShares && vault.maxTotalSupply() == p.maxTotalSupply,
            "initialize state mismatch"
        );
        require(
            keccak256(bytes(vault.name())) == keccak256(bytes(p.name))
                && keccak256(bytes(vault.symbol())) == keccak256(bytes(p.symbol)),
            "receipt name/symbol mismatch"
        );
    }

    function _log(Params memory p, address proxy, address implementation, address factory, address predicted)
        internal
        view
    {
        console2.log("[%s] POOLMIGO_PROXY=%s", p.label, proxy);
        console2.log("[%s] POOLMIGO_IMPL=%s", p.label, implementation);
        console2.log("[%s] POOLMIGO_FACTORY=%s", p.label, factory);
        console2.log("[%s] POOLMIGO_PREDICTED=%s", p.label, predicted);
        console2.log("[%s] POOLMIGO_RECEIPT=%s", p.label, string.concat(p.name, " / ", p.symbol));
    }
}
