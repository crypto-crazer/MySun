# MySun — web app

Automated liquidity vaults for less manual LP management on EVM chains.

**Live is the default.** Every page reads the registry's vaults over RPC (Robinhood Chain 4663 by
default): Markets shows the network's TVL and each vault's total deposited, APR and basket; the vault
page adds the vault token price, the performance fee and the price range (`src/chain/useLiveVaults.ts`),
and its deposit / withdraw card makes real transactions. A number the chain cannot give
(anything that needs history — no indexer) is either absent ("—") or, where the design keeps a
placeholder, comes from `src/demo/` under a **Demo / Illustrative** badge. The per-section contract is
`docs/LIVE-DATA.md` at the repo root.

**Both chains ship in every build.** The header switcher offers Robinhood Chain (4663, the default)
and the "Demo Chain" (46630, `shared/deployment.local.json`), whose RPC `resolveLocalRpcUrl` points at
the host that served the page (laptop, LAN phone) — where the stack is not running its vaults read as
not reachable.

This package uses **pnpm** (`packageManager` is pinned in `package.json`); npm is not used anywhere.

```bash
pnpm install
pnpm dev          # http://localhost:5173
pnpm test         # vitest: spec anchors, chain helpers, wallet picker, render smoke test
pnpm build        # tsc + vite build
pnpm sync:shared  # regenerate src/config/generated.ts from ../shared
pnpm e2e:local    # viem end-to-end against the local chain (see below)
```

## Design system

Colour comes in two layers, declared once in `src/lib/tokens.ts`: primitives (the palette) and semantic
tokens (roles). Only the semantic names become Tailwind utilities, so components write `text-strong`,
`bg-fill-weak`, `border-stroke-weak` and cannot reach a raw colour.

- **Gallery:** http://localhost:5173/design-system — tokens and base components, rendered live. It is
  not linked from the header.
- **Reference:** [`docs/design-system.md`](docs/design-system.md) — token tables and usage rules.

## Running against the local chain

The Demo Chain's vault pages read the deployed demo stack. From the repo root:

```bash
anvil --chain-id 46630 --port 8547
cd contracts && forge clean && forge build && \
  forge script script/DemoLocal.s.sol --rpc-url http://127.0.0.1:8547 --broadcast --private-key $ANVIL_DEV_KEY
cd ../frontend && pnpm sync:shared && pnpm dev
```

Then in your wallet (MetaMask, Rabby, Coinbase Wallet, Brave, Phantom … — see **Wallets** below):

1. **Add network** — pick "Demo Chain" in the header network selector (the app opens on Robinhood
   Chain) (or press **Switch to …** on a Demo Chain vault page) and approve the wallet's add-network prompt. By hand:
   RPC `http://127.0.0.1:8547`, chain id `46630`, currency `ETH`.
2. **Import account** → Anvil account #2 private key
   `0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a`
   (address `0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC`) — a publicly known Anvil test key.
   **Local only. Never fund it on a real network.**
3. Open a Demo Chain vault from the Earn table (e.g. http://localhost:5173/vault/46630-demo, or the
   classic http://localhost:5173/vault/demo — a bare key works when only one chain lists it) and connect. Then:
   - **Mint** — "Local dev tools" (only shown on a local-chain vault page) mints the vault's basket
     tokens to your wallet (not on the fork demo, whose basket is real tokens — see below).
   - **Deposit** — "Pay with: In kind": enter an amount for *every* basket token (the amounts are
     maximums; the vault pulls only what the binding ratio requires), approve what is short, then
     deposit. The card shows the computed shares, the per-token pull and (under the details fold) your
     `minShares` floor, which is re-quoted from a fresh `previewDeposit` when you sign. "USDG only"
     appears where the zap serves the vault.
   - **Withdraw** — enter the vault's receipt token (or Max), check the in-kind breakdown, withdraw
     (or "USDG only" through the zap).

Without a wallet extension the picker offers **read-only mode** instead: the prototype flows stay
usable, the vault pages stay read-only. Without a running chain a Demo Chain vault page says so and everything
else keeps working.

If the demo stack is redeployed, re-run `pnpm sync:shared` (addresses are never hand-copied).

**Fork demo:** `contracts/script/fork-demo-up.sh` deploys the same stack on Robinhood Chain state
(real USDG / WETH, real Uniswap v3 + v4 adapters on `demo`; `deployment.local.json` gets `"fork": true,
"mintable": false`) — Local dev tools then hide the mint rows (wallets #200 / #2 are funded at deploy
time) and offer **Fund my wallet**: your wallet is topped up to 1 ETH for gas (`anvil_setBalance`)
and the basket tokens are sent — every token by an anvil-impersonated call from the pool (a real
token transfers, a mock mints; local node only, no wallet prompts either way); `pnpm e2e:local`
asserts those balances instead of minting; runbook in `contracts/README.md`.

**Demo wallets:** every local stack runs on Anvil's standard test accounts — Foundry's public default
mnemonic `test test test test test test test test test test test junk` (**world-known test keys:
local demo only, never on a real network or with real value**). On the fork demo, #200 `0xCD56…2083` (the
deployer / vault owner) and #2 `0x3C44…93BC` (= `demoUser`) are funded at deploy time (the all-mock
`DemoLocal.s.sol` stack still deploys from #0 `0xf39F…2266`); #1 `0x7099…79C8` is the keeper. Import the
mnemonic in a wallet to act as one of them, or connect any wallet and top up with **Fund my wallet**
— it supplies the basket tokens **and** gas (any wallet is raised to 1 ETH on the local node).

## Wallets

**Connect wallet** opens a picker listing every wallet the browser actually has. There is no
hardcoded list of "supported" wallets and no wallet SDK: discovery is **EIP-6963**
([`mipd`](https://github.com/wevm/mipd)), so any wallet that announces itself shows up with its own
name and icon — MetaMask, Rabby, Coinbase Wallet, Brave, Phantom, Frame, Zerion, Rainbow, and
anything else installed. A pre-EIP-6963 `window.ethereum` still appears, as **Browser wallet**.

Each choice becomes a viem wallet client (`createClient({ transport: custom(provider) })`). Reads
never need a wallet; only deposit / redeem / mint do, and only on a chain MySun is deployed on,
with a one-click network switch — see **Multi-chain** below.

## Multi-chain

MySun targets any EVM chain, with any number of vaults per chain. The app knows both from one
registry, **`shared/deployments.json`** (schema **v2**):

```jsonc
{
  "version": 2,
  "chains": {
    "4663":  { "name": "Robinhood Chain", "rpcUrl": "https://rpc.mainnet.chain.robinhood.com",
               "testnet": false, "status": "planned" },
    "8453":  { "name": "Base", "rpcUrl": "https://mainnet.base.org", "testnet": false,
               "status": "deployed", "explorerUrl": "https://basescan.org",
               "vaults": [
                 { "key": "main", "label": "USDC / WETH basket",
                   "receipt": { "name": "sunEthLP", "symbol": "sunEthLP" },
                   "vault": "0x…", "implementation": "0x…", "keeper": "0x…" }
               ] }
  }
}
```

- `status: "planned"` — a known chain with no MySun deployment yet. It is offered in the network
  selector; Markets lists no vaults for it. It may not list vaults.
- `status: "deployed"` — needs a non-empty **`vaults`** list. Each vault entry has exactly:
  - `key` — lowercase slug (`^[a-z][a-z0-9-]*$`), unique on that chain; it is what the app remembers
    as "the selected vault", so keep it stable across redeploys;
  - `label` — the vault's name until the chain's basket symbols land (non-empty);
  - `receipt` — `{ "name", "symbol" }` of the vault's LP token, as passed to `initialize` (non-empty);
    rendered before any chain read;
  - `vault`, `implementation`, `keeper` — `0x…40` addresses; optional `demoUser` (address).
  The **first** vault listed is the chain's default. Basket tokens and adapters are NOT listed — the
  app reads them from the vault (`tokens()`, `adapters()`).
- Optional `explorerUrl` — passed to the wallet as `blockExplorerUrls` when it adds the chain.

**Adding a chain** = append an entry (key = decimal chain id) → `pnpm sync:shared` → commit the
regenerated `src/config/generated.ts`. **Adding a vault** to a deployed chain = append one entry
(`key` / `label` / `receipt` / addresses) to its `vaults` → `pnpm sync:shared` → commit. No code
change for either. `sync:shared` validates loudly and names the offending path — e.g.
`deployments.json: chains.8453.vaults[1].key "main" is already used by chains.8453.vaults[0]` (bad
address, missing `vaults` on a deployed chain, duplicate key or vault address, empty label/receipt,
unknown key, non-numeric or duplicate chain id, a JSON key written twice, …). Its output is a pure
function of `shared/` — re-running it on unchanged inputs changes nothing, and a unit test fails if
the committed `generated.ts` drifts from what it would render.

**The local stack keeps flowing from `shared/deployment.local.json`** (`{ "version": 2, "chainId",
"rpcUrl", "vaults": [ … ] }`, written by `DemoLocal.s.sol`; the fork variant `DemoLocalFork.s.sol` adds
the optional `"fork": true, "mintable": false`). `sync:shared` overlays it on the
registry entry with the same chain id: that entry becomes `deployed` + `local`, takes the local file's
RPC, and the local `vaults` **replace** the entry's list. So the `46630` entry carries no vaults of its
own, and a redeploy of the demo stack is still just `pnpm sync:shared`. Local-only conveniences (Local
dev tools / mint) appear only on that `local` chain.

### Multiple vaults per chain

**Which vault the app uses** (`src/chain/vaultSelection.ts`): the vault selected for the target chain,
if its key still exists there; otherwise — nothing selected yet, a key that vanished after a redeploy,
anything unreadable in storage — the chain's **first** vault. The choice is kept **per chain** in
`localStorage` (`mysun.vault.selected`, `{ "<chainId>": "<key>" }`), so switching networks and back
returns to the vault you were on; opening a vault page records it. The vault page itself always reads
and writes the vault in its URL (`/vault/<chainId>-<key>`, or a bare `/vault/<key>` when only one chain
lists that key — otherwise the page asks which), and every React Query key carries the vault address,
so moving between vaults never shows another vault's data. The header wallet menu's balances follow
`(target chain, selected vault)`.

**Which chain the app uses** (the *target chain*, `src/chain/targetChain.ts`):

- no wallet → the chain picked in the header selector (default: the first live deployment — the
  local stack only when nothing else is deployed) — read-only, so the vault renders without any extension;
- wallet on a chain with a deployment → that chain, automatically;
- wallet on a chain without one (a `planned` chain, or anything else) → the selected chain, with a
  "wrong network" banner on the vault page and a **Switch to …** button; deposit/withdraw are blocked
  until it switches.

**Switching** (`src/chain/switchChain.ts`): `wallet_switchEthereumChain`; if the wallet answers
"unknown chain" (4902, also when nested inside a -32603), `wallet_addEthereumChain` with parameters
built from the registry (`addEthereumChainParams`), then switch again. A rejection is surfaced, never
retried. Every read, receipt wait and write names its chain explicitly — nothing reads a module-level
"the chain" constant.

### WalletConnect (phones and QR)

WalletConnect is **off until you supply a project id** — none is hardcoded, and the option is hidden
(with a short hint) when it is missing.

1. Get a free project id at <https://cloud.reown.com> (create a project → copy the Project ID).
2. `cp .env.example .env.local` and set it:

   ```bash
   VITE_WALLETCONNECT_PROJECT_ID=your_project_id_here
   ```

3. Restart `pnpm dev`. "WalletConnect" now appears in the picker and opens a QR code.

`.env.local` is gitignored; only `.env.example` is committed. The WalletConnect module is loaded on
demand, so it costs a visitor who connects with a browser extension nothing.

### NAV history (vault-page price chart)

`VITE_NAV_HISTORY_URL` points the vault page's price chart at the NAV-history collector's JSONL
(`…/analytics/nav-history.jsonl`, one hourly snapshot per vault per line). With ≥ 6 snapshots for a
vault the chart draws them (real timestamps, no badge); unset, unreachable or fewer snapshots → the
illustrative line under its badge, as before. Build-time: set it in `.env.local` or the build env.

## Demo controls

| Control | How |
|---|---|
| Enter read-only mode | **Read-only mode** in the wallet picker |
| Reset demo state | Click the **MySun** wordmark 5 times within 2.5 s |
| Force US market status | `?market=closed` / `?market=open` / `?market=auto` (persists until changed) |
| Force a theme | `?theme=dark` / `?theme=light` (persists; header toggle does the same) |

State is persisted to `localStorage` under `mysun-demo-v1`.

## Where things live

| Path | What |
|---|---|
| `src/chain/` | Chain code: registry-driven chains, target chain + vault selection + switching, per-chain viem clients, live reads, amount math, error decoding |
| `src/wallet/` | The wallet layer: EIP-6963 discovery, WalletConnect, picker modal, connection |
| `src/config/generated.ts` | The full registry (local overlay included) + ABIs, generated from `../shared` by `pnpm sync:shared` — do not edit. App code reads `CHAINS` / `DEPLOYMENTS` / `vaultsForChain` from `src/chain/chains.ts` (the whole registry, both chains) |
| `src/chain/useLiveVaults.ts` + `liveVaults.ts` | Every vault live: catalogue reads + reference-pool spots → TVL, spot NAV, fee, keeper (Markets, vault page); `/vault/:id` resolution |
| `src/chain/useVault.ts` | One vault's live state (`useLiveVaultAt`), the wallet's basket, previews and zap routes — the deposit card's data |
| `src/components/live/` | Local dev tools (mint / fund my wallet), the network-manual and message blocks |
| `src/components/ui/DataBadge.tsx` | `Demo data` / `Live on-chain` provenance badges |
| `src/chain/useNavHistory.ts` + `navHistory.ts` | The vault page's real NAV line: the collector's JSONL (`VITE_NAV_HISTORY_URL`), parsed and cut per vault; `useNavHistoryRows` is the one shared fetch (chart + fee APR); ≥ 6 snapshots → real series, else the illustrative fallback |
| `src/chain/feeApy.ts` | The design's fee APR (7D): Δ cumulative `feesUsd` over the window ÷ the window's mean `tvlUsd`, × 365 ÷ days, from the same collector rows; a series shorter than the window → "—". Earn table APR column, vault page APR tile + "Your APR" / "Fees earned" |
| **`src/demo/`** | **Every invented number**: the illustrative NAV line (fallback until the collector has history, badged), plus the legacy prototype data/math and its tests |
| `src/lib/market.ts` | US market clock (America/New_York, weekdays 09:30–16:00 ET, holidays ignored) |
| `src/store/useStore.ts` | zustand store (persisted) with deposit / withdraw / stake |
| `src/store/selectors.ts` | Derived hooks shared by Explore, Vault and Rewards |
| `src/components/deposit/DepositCard.tsx` | The original deposit / withdraw card on the vault page (and over Markets via `?deposit=`), wired to real reads and writes |
| `src/components/vault/PriceRange.tsx` | The range as an instrument: the live spot between the adapters' on-chain range (`src/chain/ranges.ts` + `ticks.ts`, read by `useVaultRanges`) |
| `src/test/` | Spec anchors, store consistency, chain helpers, multi-chain registry + switching, multi-vault registry + selection, vault pages, wallet picker, render smoke test |
| `scripts/` | `sync-shared.ts` (CLI) + `generate.ts` (pure render) + `registry.ts` (validation), `e2e-local.ts` (viem end-to-end) |

## Brand

Dusk direction (the product name is set in `src/lib/brand.ts`). Dark only. The palette is declared once, as
primitives in `src/lib/tokens.ts`; components reach it only through the semantic tokens (see [Design system](#design-system)):

| Colour | Primitive | Value | Role |
|---|---|---|---|
| Night | `plum-950` | `#17121A` | the page, wells |
| Dusk | `plum-900` | `#221A24` | cards, dialogs, the side sheet |
| Mauve | `plum-700` | `#3A2C38` | menus, popovers, chips |
| Limestone / Stone / Haze | `sand-1000` / `sand-700` / `sand-500` | `#EDE0D2` / `#C9B4A6` / `#A08CA0` | text, supporting text, quiet labels |
| Limestone at 12% / 24% on Night | `sand-120` / `sand-240` | `#312B30` / `#4A4346` | hairlines, edges |
| Sun | `sun-1000` | `#FBC97E` | the price, rewards, the one main action |
| Gain / Loss / Caution | `green-1000` / `red-1000` / `tan-1000` | `#92D6A6` / `#FF8A8F` / `#BF9470` | outcomes and caution |
| Lavender | `lavender-1000` | `#8D7087` | a chart series with no meaning of its own, text selection |

One rule shapes the interface: **only the price is round**. The sun, the price mark on a range and price points on a
chart are circles; ranges, controls, cards and token tiles are square-cut. The radius scale is small all the way up to
`rounded-full` for that reason; use `rounded-circle` for a real circle.

The motif: two stones mark a range's bounds, the sun marks the price, a graduated scale is the price axis. It appears
in the price range on the vault page (`components/vault/PriceRange.tsx`) and the scene behind the Earn page. That scene is
alive (`components/brand/SkyScene.tsx`): the sun drifts and the stones slide to re-centre on it when it leaves the
gap. It is a three.js scene (`duskScene.ts`) loaded on demand, so three.js stays out of the main bundle; the still
drawing in `Scene.tsx` shows first and remains when WebGL is unavailable. Readings sit on an engraved rule (`StatRow`).

Type: Newsreader (every title, page and UI; light, vault names at regular, never bold), Geist (UI; emphasis at 500) and Geist Mono via Google
Fonts; Switzer for the figures from the Fontshare CDN. Switzer's licence does not allow its font files in a public
repository, so it is loaded from the CDN in `src/index.css` and never committed. Every action target is at least 36 px tall (44 px for
primary CTAs).

## Design tokens

`src/lib/tokens.ts` is the colour source; `tailwind.config.ts` turns it into CSS variables and the semantic utilities
(`text-*`, `bg-background-*`, `bg-fill-*`, `border-stroke-*`). `font-display` is the sans stack for readings, `font-serif` (classes `title` and
`display`) is Newsreader for every title. Chart libraries that cannot read CSS variables take the same colours from `src/lib/theme.ts`.
