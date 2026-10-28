# Live data — what the app reads, and what it cannot

The web app is **live by default**. Every number on screen comes from a chain read unless the chain
has no way to answer it. Where it has none, the figure is either absent (shown as "—") or, if the design
keeps a placeholder, it is illustrative: the vault page's price chart carries an **Illustrative** badge
until enough history exists, and the site footer says so too. A Demo badge never sits on a live number. The vault page's title carries a **Live on-chain** badge.

Monorepo rules that apply here: the vault keeps its accounting in kind (a vector of token amounts).
It has no on-chain NAV and reads no oracle. **USD is shown for display only**, worked out in the
browser as described below.

## Chains

| What | Source |
|---|---|
| Chains and vaults offered | The deployment registry (`shared/deployments.json`). Every build lists both registry chains in the network switcher: Robinhood Chain (4663) and the Demo Chain (46630). The default chain is the first live deployment, Robinhood Chain (4663). |
| Demo Chain | A normal switcher chain again. It is the local demonstration stack, read from the machine that serves the app (or that machine's address on the local network). Where it is not running, its vaults show as not reachable. |

## How USD is computed (display only)

- **USDG** counts at its $1 peg.
- **Any other basket token** is priced from the live `slot0().sqrtPriceX96` of its reference pool. That is the pool the zap periphery routes through (`routes(USDG, token).refPool`). There is no TWAP and no oracle.
- If a token has a balance but no reference pool, it is **not priced**. The vault's TVL is then shown as "—", never as a partial sum.
- **TVL** = Σ `totalTokens()` valued at spot.
- **Spot NAV** = TVL ÷ receipt `totalSupply()`. A vault with zero supply has no NAV.

## Range bounds

The price range drawing on the vault page uses the bounds the vault's adapters actually hold:

- The app reads the vault's `adapters()`. For each adapter it reads `positionState()` (position id, lower
  tick, upper tick) and `TOKEN0()` / `TOKEN1()`, the token order of the adapter's pool. An adapter with
  position id 0 holds no position and is skipped.
- Each tick becomes a price with Uniswap's TickMath (`sqrtPriceX96 = sqrt(1.0001^tick) · 2^96`, ported
  exactly). The same pool-ratio → USDG conversion as the spot price then applies.
- An adapter counts toward a token's band only when its pool is that token against USDG (the same pair as
  the token's reference pool), on any venue. Adapters on other pairs, such as WETH/PONS, have no USDG
  bound, so they add nothing.
- Per token: **lower** = the lowest lower bound across its adapters, **upper** = the highest upper bound.
  The marker is the live spot.
- A token with no live position, or a vault whose reads fail, gets **no band**. The meter and the drawing
  are then not shown. The app never falls back to a made-up width.

## Per section

| Section | Live from the chain | Mocked, and why |
|---|---|---|
| **Markets** (home) | One row per registry vault: the basket name from its symbols (`tokens()` → ERC-20 `symbol`, WETH shown as ETH), `paused`, the **basket bar** (each token's share of the spot value, in the name's order, with the share and value on hover; `—` while the basket is unpriced or empty), **APR** (fee APR: Δ cumulative harvested fees over the last 7 days ÷ mean TVL, annualised — from the hourly collector feed, `—` until 7 days are covered; the APR header's hint says so) and **Total deposited** (the vault's TVL). Hero stat: **TVL**, the total across the network's vaults. Protocol-level figures are labelled TVL; a vault's or a wallet's are "Total deposited". "Your deposits" = the connected wallet's `balanceOf` ÷ supply × TVL. A row's **Deposit** opens the deposit card over the page (`?deposit=<vault>`); the row itself opens the vault page. The per-token amounts, the fee, NAV and the price range are on the vault page. | Nothing. Volume is **not shown**: it needs swap history. |
| **Vault page** | Total deposited (the vault's TVL), APR, spot NAV (labelled **Price**), performance fee, `paused`, per-token totals, spot price and value, each token's share (a bar and its legend), plus the reference pool and fee tier behind each price. Supply and the `maxTotalSupply` cap are not shown. Your position is your `balanceOf` and its share of TVL; with a wallet connected, the basket table's **Yours** column is what your receipt redeems for in kind. The **price range drawing** places the live spot between the vault's on-chain range for each token. The **deposit / withdraw card** is live end to end: per-token balances and allowances, `previewDeposit` / `previewRedeem`, the zap quotes where the zap serves the vault, and real transactions (`approve` + `deposit` with a `minShares` re-quoted at signing time; `redeem`; the zap's deposit and redeem). Deposits open on USDG through the zap (every deployed vault is served): until the chain confirms the route, the zap form shows with nothing to type into, and the in-kind form is one click away. A paused vault disables every action. Its "≈ $" hints use the live spots and spot NAV. | The **price-chart line** is snapshots from the collector (`VITE_NAV_HISTORY_URL`), backfilled from the first hour the service ran; before that, Illustrative. With at least 6 hourly snapshots for the vault, the line is real: drawn at the snapshots' own times, with a "snapshots until" time. With fewer, no configured source, or an unreachable one, it is illustrative and its last point is pinned to the live spot NAV. The illustrative line carries an **Illustrative** badge; the real one shows its "snapshots until" time instead. The "Price now" readout under the title is live either way and never badged. |

## Why some figures cannot be live

- **No indexer.** The app reads current state only. Time series (fees over time, return since genesis) need event history, and the app has no indexer to supply it. The public block-explorer API is not reachable from the app. The single exception is the NAV/fee time series from the Railway collector (hourly off-chain snapshots, `VITE_NAV_HISTORY_URL`), which feeds the price chart and the fee APR.
- **NAV history comes from a snapshot collector, not the chain.** A read-only service snapshots every deployed vault hourly (spot TVL, spot NAV, fees, valued the same display-only way as above) and serves the rows as JSON Lines. The app reads that file when the build sets `VITE_NAV_HISTORY_URL`; history starts at the collector's first snapshot.
- **No usable on-chain TWAP.** Uniswap v3 observation data on Robinhood Chain is degenerate, so a time-weighted price cannot be read from it. Spot `slot0` is live and is what the app uses.
- **Tokenomics not deployed.** Reward emissions and buybacks have no on-chain source.

Adding an indexer (or extending the collector) is the path to replacing the remaining illustrative blocks with real series.
