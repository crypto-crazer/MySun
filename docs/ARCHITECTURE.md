# Architecture

MySun is an **in-kind LP vault**: depositors supply the vault's basket tokens, and the vault
manages liquidity positions across multiple DEX venues behind a single generic adapter interface.
This document describes the moving parts at a conceptual level; it does not contain market-specific
configuration.

## Receipt token — `sun<Strategy>LP`

Depositing basket tokens mints the vault's receipt token (ERC-20, 18 decimals; name and symbol are
per vault, set at initialization) — `sun<Strategy>LP` by convention (e.g. `sunEthLP` for the flagship
ETH basket, `sun5StocksLP` for the five-stock basket). Vaults deployed before the MySun rebrand keep the
name and symbol they were initialized with — there is no setter. It is a fungible, transferable pro-rata
claim on everything the vault holds. There is no premium/discount mechanism and no secondary-market logic inside the vault —
the receipt is simply a claim.

## In-kind accounting — no oracle, no NAV

Share accounting is a **vector pro-rata over the token basket**. For a deposit of amounts `a_i` of
tokens `i`, with vault totals `T_i` and supply `S`:

```
shares = min_i ( a_i · (S + V_s) / (T_i + V_t) )     (bootstrap, S = 0: shares = K — owner-only genesis)
```

The minimum-across-basket rule means a depositor is credited exactly in proportion to what they
deliver, with no assumption about relative prices. `V_s` / `V_t` are tiny virtual offsets in the
share conversion (inflation guard); `K` is the deploy-time genesis constant that fixes the share
scale (display starts ≈ $1/share, never repriced on-chain). Redemption mirrors it:
`amount_i = shares · T_i / S` per token, always in kind.

Properties worth stating explicitly:

- **No USD valuation, no on-chain NAV, no third-party price oracle.** The vault never has to answer
  "what is this worth in dollars".
- One price-like read exists at deposit time — the venue's own spot price, read through the
  adapter — and it can only *over*-price the depositor. The mandatory, non-zero `minShares`
  parameter is what protects them; the design does not rely on oracle quality.
- Redemption does **not** read adapter position reports: an in-kind claim does not depend on venue
  accounting.

## Positions and adapters

- `IPositionAdapter` is the venue boundary: an adapter knows how to move in-kind amounts into its
  venue, report its current position as (tokens, amounts), and withdraw in kind.
- The vault holds idle balances plus N adapters; total assets = idle balances + adapter positions.
- A permissioned **keeper** executes `deployTo` / `pullFrom` / `rebalance`, moving capital between idle and
  adapters. Rebalance settles accrued venue fees/rewards back into the basket, and the performance
  fee is charged **only on fees/rewards, in kind — never on principal** — whenever accrued fees leave a
  position (harvest, redemption, pull, removal, unwind); adapters therefore report uncollected fees net of it.
- Owner-only controls: keeper management, a risk-manager whitelist (a fast-reaction role that can only
  pause — one-way — and emergency-unwind), the pause switch (a full freeze: deposits, redemptions and all
  keeper actions stop until the owner unpauses), upgrades.
- Adapters that implement the **precise-liquidity** capability (`ILiquidityAdapter`) additionally let the
  keeper add or remove an exact raw liquidity amount (`addLiquidity` / `removeLiquidity`), always inside
  range constraints the owner fixes on the adapter (`setRangeConstraints`: tick box + width bounds). The
  owner chooses *where liquidity may live*; the keeper chooses the exact range and size inside it. Amounts
  are sized at the venue's own spot, principal floors are enforced on what actually settles, and any fee
  slice is reported apart from principal — fees never satisfy a floor and never become principal.
- Every swap the adapters make (deploy-time ratio swaps, add-time rebalancing swaps) runs through one
  shared, stateless **swap executor**: it moves only its caller's own tokens, returns the output to its
  caller, and leaves no balance or allowance behind between calls — the adapters hold it immutably and it
  holds nothing itself.

## Strategy layer

- Registered adapters carry a **capability mask** derived from the adapter's own ERC-165 answers when it is
  added (`addAdapter`; the owner can narrow a bit, never fake one, and can toggle bits afterwards). Bit 0 is
  the precise-liquidity surface (`ILiquidityAdapter`); bit 1 is the **swap** capability: such an adapter also
  accepts a vault-funded `swapExactIn` — the vault force-approves exactly `amountIn` of its idle, the swap
  runs through the adapter's guarded venue path (TWAP-referenced min-out on top of the caller's own floor)
  and the output settles back into the vault. Free idle only — never LP principal.
- A **plan executor** periphery (`PlanExecutor`) runs an ordered list of the vault's keeper calls
  (`deployTo` / `pullFrom` / `rebalance` / `addLiquidity` / `removeLiquidity` / `swapExactIn`) as one
  all-or-nothing transaction. Components are typed (kind + adapter + ABI-encoded parameters), validated
  upfront — including the plan's **pins**: every component's adapter must satisfy the pinned
  `positionState` (tokenId, range, liquidity, `configVersion`) the composer read, so an owner re-configuration
  mid-flight invalidates the plan instead of landing against moved goalposts. Nonces are strict and
  per-keeper (a nonce is consumed after the batch). The executor is itself a vault keeper (the vault sees
  *it* as the operator of every component) with its own caller whitelist, and holds no funds between plans.

## Upgradeability

The vault ships behind a UUPS proxy with ERC-7201–namespaced storage. Upgrade authority is the
owner address; a multisig (behind a timelock where the chain offers one) is the intended setup.

## Deterministic deployments

The vault can be deployed through a small CREATE3 factory (`src/periphery/PoolmigoCreate3.sol`): the
proxy address is a pure function of `(factory, deployer, salt)`, so the vault lives at the **same
address on every chain** where the factory sits at the same address and the same dedicated deployer
broadcasts. Implementation contracts are plain per-chain deploys and irrelevant to the address — the
proxy stores the implementation pointer. Factory and salt conventions: `contracts/README.md`.

## Repository map

- `contracts/` — vault, adapters, periphery (deterministic deploy factory, zap deposits/exits, the plan
  executor), tests, deploy/upgrade scripts (Foundry)
- `frontend/` — web app: wallet connect, deposits/redemptions, position views
- `backend/` — keeper service: executes `deployTo` / `rebalance` / precise-liquidity ops and keeper plans
- `shared/` — ABIs + deployment config consumed by both apps

## Status

The repository ships the full stack: the vault core, real Uniswap v3 and v4 adapters (fork-tested
against live chain state) implementing the precise-liquidity capability behind a shared swap executor,
a zap periphery for single-token deposits and exits, and a strategy layer: capability-masked adapters
(precise liquidity + vault-funded swaps) and an all-or-nothing `PlanExecutor` for keeper-composed plans.
The contracts are not yet audited and the vault is not deployed to production — do not use with real funds.
