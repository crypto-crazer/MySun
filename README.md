# MySun

In-kind, multi-DEX / multi-pool LP auto-rebalance vault for **EVM chains**.

Depositors provide the vault's underlying tokens **in kind** and receive the vault's receipt token — e.g.
`sunEthLP` for the flagship ETH basket, `sun5StocksLP` for the five-stock basket — a fungible pro-rata
claim on the whole basket. Share accounting is pure pro-rata over token balances: **no USD valuation,
no on-chain NAV, no third-party oracle reads**. LP positions live behind a generic `IPositionAdapter`
interface, and deposits, redemptions and performance-fee harvesting are all settled in-kind.

> **Status: not production-deployed.** `contracts/src/adapters/` ships real Uniswap V3/V4 adapters
> (exercised against a live-chain fork; **not yet audited**); the default local demo stack runs them on
> a frozen Robinhood Chain fork (`contracts/README.md`), with an all-mock stack kept for offline work.

## Monorepo layout

| Path | What |
| --- | --- |
| `contracts/` | Foundry project — vault core, adapter interface, tests, deploy/upgrade scripts (see `contracts/README.md`) |
| `frontend/` | Web app — multi-wallet connect (viem: EIP-6963 + WalletConnect); deposits, redemptions, position views |
| `backend/` | Keeper service — executes keeper-gated `deployTo` / `rebalance` (`pullFrom` when operated manually) |
| `shared/` | Shared ABIs + local deployment config consumed by frontend and backend |

## Quick start

- Contracts: `cd contracts && forge build && forge test`
- Local demo stack — fork (default): `contracts/script/fork-demo-up.sh` (real pools on Robinhood Chain
  state, frozen into a standalone anvil, then `cd frontend && pnpm sync:shared`); offline mock:
  `anvil --chain-id 46630 --port 8547` + `forge script script/DemoLocal.s.sol --broadcast`
- Frontend: `cd frontend && pnpm install && pnpm dev` — live vault at `/live`; end-to-end check: `pnpm e2e:local`
- Backend: `cd backend && pnpm install && pnpm build && pnpm tick` — dry-run by default; `pnpm start` runs the loop

## License

**Business Source License 1.1** — see [`LICENSE`](LICENSE) (Licensor and Licensed Work as named there). Copying, modification,
redistribution and **non-production** use are granted; production use needs a commercial license (no
Additional Use Grant). On the Change Date (the earlier of 2030-09-30 or four years after a version's first
public distribution) that version converts to **GPL-3.0-or-later**.

Per-file SPDX identifiers apply where present: the Solidity sources, tests and scripts under `contracts/` are
`BUSL-1.1`, except the vendored Uniswap V3 interfaces/math under `contracts/src/adapters/uniswap/` (and the
test-only `contracts/test/fork/utils/ISwapRouter02.sol`), which stay **GPL-2.0-or-later** as marked in their
headers. Files without an SPDX header are covered by `LICENSE`.