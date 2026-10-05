# MySun

In-kind, multi-DEX / multi-pool LP auto-rebalance vault for **EVM chains**.

Depositors provide the vault's underlying tokens **in kind** and receive the vault's receipt token — e.g.
`sunEthLP` for the flagship ETH basket — a fungible pro-rata claim on the whole basket. Share accounting
is pure pro-rata over token balances: **no USD valuation, no on-chain NAV, no third-party oracle reads**.
LP positions live behind a generic `IPositionAdapter` interface (Uniswap v3/v4 or any venue), and deposits,
redemptions and performance-fee harvesting are all settled in-kind.

- **Genesis**: the first deposit (supply == 0) is owner-only and mints a deploy-time constant K
  (`genesisShares`). K is set from a one-time, off-chain valuation of the seed basket so display
  starts at ≈$1/share; the contract itself never prices anything. Later deposits are pure ratios.
- **Donation guard**: deposits price with virtual shares/assets (1/1) and pull only what the minted
  shares require; redemptions stay exact pro-rata.
- **Supply cap**: optional `maxTotalSupply` on the receipt token (0 = uncapped), raised by the owner in stages.
- **Keeper moves**: `pullFrom` (always back into the vault) + `deployTo` re-shape positions across
  ranges/venues on-chain.

## Layout

- `src/` — `MySunVaultUpgradeable.sol` (the vault new deployments ship: a thin wrapper over `PoolmigoVaultUpgradeable.sol`, the shared UUPS-upgradeable implementation with ERC-7201 namespaced storage and token + adapter registries, which earlier deployments run), `MySunVaultUpgradeExample.sol` / `PoolmigoVaultUpgradeExample.sol` (example next implementations for the upgrade path — not released versions), `interfaces/` (`IPositionAdapter`, `IMySunVault` over `IPoolmigoVault`), `adapters/` (`UniswapV3Adapter`, `UniswapV4Adapter` — real, fork-tested; vendored v3 math set), `periphery/` (`MySunZapIn` / `MySunZapOut` — zaps, thin wrappers over `PoolmigoZapIn` / `PoolmigoZapOut`; `PlanExecutor`; `PoolmigoCreate3` — deterministic deploy factory)
- `test/` — Foundry unit/fuzz/upgrade tests + `test/fork/` (live-chain suites for both real adapters) + `test/mocks/` (MockToken / MockPositionAdapter, used by unit tests and the offline demo)
- `script/` — deploy and upgrade scripts (OpenZeppelin upgrades plugin); `export-abis.sh` regenerates `shared/abis/*.json` after any ABI change (then `pnpm sync:shared` in `frontend/` and `pnpm run sync-abis` in `backend/`)
- `lib/` — dependencies: OpenZeppelin contracts / contracts-upgradeable / foundry-upgrades (submodules), forge-std (vendored)

## Build & test

```bash
forge build
forge test
```

Solidity 0.8.34 · Foundry ≥ 1.8 · OpenZeppelin v5.1.0. Node.js is needed by the OpenZeppelin
upgrades plugin used in the upgrade tests and scripts.

## Deterministic deployments (CREATE3)

`src/periphery/PoolmigoCreate3.sol` deploys any contract to an address that depends only on
`(factory, deployer, salt)` — the factory binds each salt to its caller (effective salt =
`keccak256(salt ‖ msg.sender)`), so nobody can squat the team's documented salts. The address is the
same on every chain where the factory sits at the same address **and the same deployer account**
calls it (always deploy vaults from the one dedicated deployer). For the vault, the UUPS **proxy** is the address that must be stable; the implementation
is a plain per-chain deploy (the proxy stores its address).

```bash
# once per chain — as the FIRST tx of the dedicated deployer (nonce 0), so the factory matches:
forge clean && forge build
forge script script/DeployCreate3Factory.s.sol --rpc-url <rpc> --account <keystore> --sender <addr> --broadcast

# the flagship vault (salt default: keccak256("poolmigo.vault.v1"); NAME/SYMBOL default "sunEthLP"):
CREATE3_FACTORY=0x... OWNER=0x... TREASURY=0x... FEE_BPS=1000 TOKENS=0x..,0x.. \
  GENESIS_SHARES=<K, raw 18-dp units> MAX_TOTAL_SUPPLY=<cap, 0 = uncapped> \
  forge script script/DeployDeterministic.s.sol --rpc-url <rpc> --account <keystore> --sender <addr> --broadcast

# a second vault on the same chain: its OWN salt + its own receipt name/symbol
SALT=$(cast keccak "poolmigo.vault.stocks.v1") NAME=sun5StocksLP SYMBOL=sun5StocksLP \
  CREATE3_FACTORY=0x... OWNER=0x... TREASURY=0x... FEE_BPS=1000 TOKENS=0x..,0x..,... \
  GENESIS_SHARES=<K> MAX_TOTAL_SUPPLY=<cap> \
  forge script script/DeployDeterministic.s.sol --rpc-url <rpc> --account <keystore> --sender <addr> --broadcast

# end-to-end proof: same proxy address on two fresh Anvil chains with shifted nonces (same deployer)
script/deterministic-address-check.sh
```

Rules: one documented salt per logical contract — never reuse a salt for different bytecode (the
address does not commit to the code it holds). Do not edit `PoolmigoCreate3.sol` once a factory is
deployed at a cross-chain-shared address: a different dispatcher init code changes every predicted
address. `initialize` runs with `msg.sender == dispatcher` when invoked atomically through the
factory — the vault initializer takes explicit addresses, so that path is safe; keep it that way.

**Multiple vaults per chain.** The receipt token is named per vault:
`initialize(owner_, name_, symbol_, tokens_, treasury_, performanceFeeBps_, genesisShares_, maxTotalSupply_)`
— `name_`/`symbol_` are fixed at initialize (no setter; empty or ASCII-whitespace-only reverts
`PoolmigoVault__EmptyReceiptName` / `PoolmigoVault__EmptyReceiptSymbol`; decimals stay 18). Convention:
`sun<Strategy>LP` (PascalCase strategy/theme, name == symbol), e.g. `sunEthLP` for the flagship ETH basket and
`sun5StocksLP` for the five-stock basket. **One salt per vault per chain**: every vault gets its own documented
salt (`poolmigo.vault.v1` = flagship, `poolmigo.vault.stocks.v1` = stocks basket); a salt is never reused for a
second vault. The salts, the ERC-7201 namespace (`poolmigo.vault.storage`), the `Poolmigo`-prefixed custom errors
(`PoolmigoVault__*` selectors) and the `Poolmigo*` implementation contracts predate the MySun rebrand and are kept
unchanged — the MySun-named contracts are thin wrappers over them (identical ABIs; same runtime code, metadata aside);
vaults already deployed keep the receipt name/symbol they were initialized with (no setter).

## Local demo stack

`script/DemoLocal.s.sol` deploys **two vaults** on a fresh Anvil (chain id 46630): `demo` (mUSDG/mWETH,
receipt `sunEthLP`, two mock adapters) and `stocks` (mUSDG + mNVDA/mAAPL/mTSLA/mSPY/mGME, receipt
`sun5StocksLP`, one mock adapter per mUSDG/stock pair; its proxy reuses the demo vault's implementation).
It seeds each vault (owner genesis, keeper `deployTo`, simulated fees) and writes
`../shared/deployment.local.json` in the v2 schema: `{version: 2, chainId, rpcUrl, vaults: [{key, label,
receipt: {name, symbol}, vault, implementation, keeper, demoUser}]}`.

```bash
anvil --port 8547 --chain-id 46630
forge clean && forge build
forge script script/DemoLocal.s.sol --rpc-url http://127.0.0.1:8547 --broadcast --private-key $ANVIL_DEV_KEY
```

### Fork demo — real USDG / WETH + real Uniswap v3 / v4 adapters

`script/DemoLocalFork.s.sol` is the RHC-fork sibling (the all-mock `DemoLocal.s.sol` stays for offline
work). Same two vaults, same port and chain id (46630), but `demo` holds the REAL RHC USDG / WETH and runs
the REAL `UniswapV3Adapter` (USDG/WETH fee-100 pool) and `UniswapV4Adapter` (fee 500 / spacing 10, TWAP
reference + swap venue = the v3 fee-100 pool; range ±300, TWAP 1800 s, slippage 100 bps — as the fork
suites). `stocks` stays mock. The JSON gains two optional root flags, `"fork": true, "mintable": false`
(absent — the mock script — means not a fork / `MockToken.mint` available): the frontend hides its mint
rows and `e2e:local` / the keeper suite assert pre-funded balances and real-venue behaviour instead.

One command does it all (~4 min):

```bash
export ANVIL_DEV_KEY=<anvil account #0 key>   # public Anvil default — LOCAL ONLY
script/fork-demo-up.sh                         # then: cd ../frontend && pnpm sync:shared
```

1. starts a live fork (`anvil --fork-url https://rpc.mainnet.chain.robinhood.com --chain-id 46630
   --host 0.0.0.0 --port 8547`, replacing whatever anvil holds the port);
2. **warm-up** (`script/fork-demo-freeze.mjs warm`, batched): reads every upstream value the demo relies on
   later — USDG / WETH metadata and balances, the fee-100 pool's state, observations, tick bitmap ±2 words
   and every initialized tick in them (~800 reads);
3. funds OWNER (#0), DEMO_USER (#2) and TRADER (#3) with real USDG / WETH by impersonating the fee-100
   pool (the dev accounts already have ETH for gas; topped up if not);
4. `evm_increaseTime 1800` + `evm_mine` — the adapters' spot≈TWAP guard: one window forward makes the
   pool's TWAP equal its spot;
5. `forge clean && forge build && forge script script/DemoLocalFork.s.sol` — genesis in kind, keeper
   `deployTo` into both real adapters (real swaps, real LP NFTs — the script `require`s each NFT is owned
   by its adapter), then `cast` spot checks;
6. **freezes** the fork into a standalone anvil (`fork-demo-freeze.mjs dump` / `merge`; state in
   `~/.mysun/fork-demo/state.json`, persisted on exit) and re-runs the warm-up reads on the frozen node:
   they must answer byte for byte as on the live fork, else the script fails.

Why the freeze: the public RHC RPC is not an archive node — a fork block's state was served for only
~10–30 minutes in practice. After that a live fork cannot fetch anything uncached and cannot even mine a
block ("historical state … is not available"). The freeze merges everything the fork fetched (foundry's
fork cache) with everything changed locally (`anvil_dumpState`), so the stack runs on without the upstream.
A slot the fork never read reads as **zero** on the frozen node (e.g. `WETH.decimals()` if nobody read it —
hence the warm-up, the fidelity diff, and an `e2e:local` canary): it is a snapshot of the state the demo
touches, not a full chain copy (e.g. a swap crossing beyond the warmed ±5% tick window sees no liquidity
changes). If a run fails with "historical state … is not available", the upstream window closed early —
just rerun. Restart the frozen stack later without redeploying:

```bash
anvil --state ~/.mysun/fork-demo/state.json --chain-id 46630 --host 0.0.0.0 --port 8547
```

## Status — read before using

- **Not deployed.** Do not use with real funds.
- The `UniswapV3Adapter` / `UniswapV4Adapter` here are **real** (fork-tested against live RHC; **not yet
  audited**); `test/mocks/` still holds the mock adapter the unit tests and the offline demo use.
- Reward / tokenomics design is out of scope for this repository.