/**
 * One registry vault, `/vault/<chainId>-<key>` (or the classic `/vault/<key>` when only one chain
 * lists that key), as the original vault page laid it out — stats, the deposit / withdraw card in
 * the side column, the price range, the basket, the price chart — read live
 * (src/chain/useLiveVaults.ts + src/chain/useVault.ts): TVL and spot NAV at the reference pools'
 * live spot, the performance fee, the basket composition and the exact spot
 * prices used, and the price range: the live spot between the adapters' on-chain range
 * (src/chain/useVaultRanges.ts). The card's deposits and withdrawals are real transactions on this
 * vault's chain. Mocked: the price chart's line only (no history on chain), under an Illustrative badge — never
 * the live price or the spot-NAV readout. The fee APR (stat row + "Your APR") and "Fees earned" come from the
 * NAV-history collector (src/chain/feeApy.ts) through the chart's own fetch; "—" until a day of rows
 * exists (MIN_FEE_APR_DAYS). The APR's one hint, shared with the vault list, is FEE_APR_HINT.
 * A staging vault (team mode only) gets no region treatment on this page: the header's Staging chip
 * is the only hint, by the owner's call.
 */
import { useEffect, useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useWallet } from '@/wallet/context';
import { chainFor, chainLabel, findVault, isLocalChain } from '@/chain/chains';
import { formatAmount, formatAmountSignificant, shortHex } from '@/chain/amounts';
import { basketName, basketOrderIndices, displaySymbol, feeLabel, holdingUsd, resolveVaultRouteId, tokenUsdPrices, vaultRouteId } from '@/chain/liveVaults';
import { USD_ANCHOR_SYMBOL, spotUsdPerToken } from '@/chain/spot';
import { anchorOf, useLiveVaults, type LiveVaultRow } from '@/chain/useLiveVaults';
import { useOpenVault, useSwitchToChain } from '@/chain/useTargetChain';
import { useLiveVaultAt, useUserBasket } from '@/chain/useVault';
import { describeSwitchError } from '@/chain/switchChain';
import type { ChainSpots } from '@/chain/useSpotPrices';
import { useVaultRanges } from '@/chain/useVaultRanges';
import { useVisibleDeployments } from '@/chain/useVaultCatalog';
import { FEE_APR_HINT, FEE_APR_WINDOW_DAYS, feeAprWindowDays, feeApyPct, feesEarnedUsd, fmtFeeApr, fmtFeeAprWindow } from '@/chain/feeApy';
import { useNavHistoryRows } from '@/chain/useNavHistory';
import { cx, fmtPct, fmtPrice, fmtUsd } from '@/lib/format';
import { TokenGroup } from '@/components/ui/TokenIcon';
import { Stat, StatRow } from '@/components/ui/Stat';
import { Button } from '@/components/ui/Button';
import { Hint, Tooltip } from '@/components/ui/Tooltip';
import { NavChart } from '@/components/vault/NavChart';
import { BasketBar } from '@/components/vault/BasketBar';
import { PriceRange } from '@/components/vault/PriceRange';
import { rangePairsFor } from '@/components/vault/rangePairs';
import { DepositCard } from '@/components/deposit/DepositCard';
import { LocalDevPanel } from '@/components/live/LocalDevPanel';
import { Message } from '@/components/live/Message';

export function VaultDetail() {
  const { id = '' } = useParams();
  const { address } = useWallet();
  const { rows, spotsFor } = useLiveVaults(address ?? undefined);
  // Team mode: a staging vault resolves only while unlocked; locked, its id is just "not found".
  const deployments = useVisibleDeployments();
  const resolved = resolveVaultRouteId(id, deployments);
  if (resolved.kind === 'ambiguous') {
    return (
      <div className="wrap pt-6 text-base text-weaker">
        <p>
          <span className="text-strong">{id}</span> names a vault on more than one network. Which one?
        </p>
        <ul className="mt-3 grid gap-2">
          {resolved.matches.map((m) => (
            <li key={m.chainId}>
              <Link to={`/vault/${vaultRouteId(m.chainId, m.key)}`} className="text-strong hover:underline">
                {findVault(m.chainId, m.key)?.label ?? m.key} — {chainLabel(m.chainId)}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  const ref = resolved.kind === 'found' ? resolved.ref : undefined;
  const row = ref && rows.find((r) => r.v.chainId === ref.chainId && r.v.entry.key === ref.key);
  if (!row) {
    return (
      <div className="wrap pt-6 text-base text-weaker">
        Vault not found. <Link to="/" className="text-strong">Back to vaults</Link>
      </div>
    );
  }
  return <VaultView key={row.id} row={row} spots={spotsFor(row.v.chainId)} />;
}

function VaultView({ row, spots }: { row: LiveVaultRow; spots: ChainSpots }) {
  const { v, valuation, nav } = row;
  const { address, chainId } = useWallet();
  const openVault = useOpenVault();
  const { switchTo, switching, error: switchError } = useSwitchToChain();
  // The vault the card reads and writes: this page's vault, whatever the header or wallet points at.
  const vault = useLiveVaultAt(v.chainId, v.entry, v);
  const user = useUserBasket(address ?? undefined, vault);
  const usdPrices = useMemo(() => tokenUsdPrices(v.tokens, spots.spots), [v.tokens, spots.spots]);
  const { bands } = useVaultRanges(v.chainId, v.address, v.tokens);
  const pairs = useMemo(() => rangePairsFor(v.tokens, usdPrices, bands), [v.tokens, usdPrices, bands]);
  // Looking at a vault selects its chain in the header — no wallet prompt.
  useEffect(() => openVault(v.chainId), [openVault, v.chainId]);
  // The fee APR and fees earned: the collector's rows, the same fetch the NAV chart reads. Both count
  // harvests already swept back into the vault, not just the pending balance (see chain/feeApy.ts).
  const { rows: history } = useNavHistoryRows();
  const earnings = useMemo(
    () => ({
      apr: feeApyPct(history, v.entry.key, FEE_APR_WINDOW_DAYS, v.chainId),
      // The hours the figure really covers: the full 24 h once the series is that old, less while it fills.
      aprWindow: fmtFeeAprWindow(feeAprWindowDays(history, v.entry.key, FEE_APR_WINDOW_DAYS, v.chainId)),
      fees: feesEarnedUsd(history, v.entry.key, v.chainId),
    }),
    [history, v.entry.key, v.chainId],
  );

  // The legs follow the on-chain order; the bar, its legend and the table read in the name's
  const order = basketOrderIndices(v.tokens);
  const symbols = order.map((i) => v.tokens[i].symbol);
  const name = basketName(symbols, v.entry.label);
  const usd = (x: number | undefined, cents = true) => (x === undefined ? '—' : fmtUsd(x, { cents }));
  const wrongChain = Boolean(address) && chainId !== v.chainId;
  const switchTarget = chainFor(v.chainId);
  // The wallet's slice of each basket token — what its receipt redeems for now. Whenever a wallet is
  // connected; "—" with no position, and until the redeem preview lands (a position always owes something).
  const yours = address ? new Map(vault.tokens.map((t, i) => [t.address.toLowerCase(), user.owed[i] ?? 0n])) : undefined;
  const yoursReady = user.shares > 0n && user.owed.some((x) => x > 0n);

  return (
    <div className="wrap pt-6 pb-[120px]">
      <div className="grid items-start gap-x-10 gap-y-10 lg:grid-cols-[minmax(0,1fr)_384px]">
        <header className="grid gap-6 lg:col-start-1">
          <Link to="/" className="group -my-2 inline-flex items-center gap-3 justify-self-start py-2 text-md text-weak transition-colors duration-300 ease-dusk hover:text-strong">
            {/* BoxIcons arrow-back (react-icons BiArrowBack), filled with the link's colour so it follows the hover. */}
            <svg width="20" height="20" viewBox="0 0 24 24" className="shrink-0 transition-transform duration-300 ease-dusk group-hover:-translate-x-1" fill="currentColor" aria-hidden>
              <path d="M21 11H6.414l5.293-5.293-1.414-1.414L2.586 12l7.707 7.707 1.414-1.414L6.414 13H21z" />
            </svg>
            All vaults
          </Link>
          <div className="flex flex-wrap items-start gap-5 [--name:clamp(38px,4.4vw,60px)]">
            {symbols.length > 0 && <span className="flex shrink-0 mt-[calc((var(--name)-36px)/2)]"><TokenGroup symbols={symbols} size={36} /></span>}
            <div>
              <h1 className="title !font-normal text-[length:var(--name)]">{name}</h1>
              <p className="num mt-2 flex flex-wrap items-center gap-2 text-base text-weak">
                {v.entry.receipt.symbol} · {v.chainName} · <span title={v.address}>{shortHex(v.address)}</span>
              </p>
            </div>
          </div>
          {v.failed && <p className="text-base text-warning">{v.chainName} RPC not reachable right now — figures will fill in when it answers.</p>}
          {v.paused && <p className="text-base text-warning">Vault is paused — deposits, redemptions and keeper operations are frozen.</p>}
          {wrongChain && (
            <div className="grid gap-2">
              <Message tone="warn">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>Your wallet is on {chainLabel(chainId)}. Figures below come from {v.chainName}; switch network to deposit or withdraw.</span>
                  <Button size="sm" variant="secondary" loading={switching} onClick={() => void switchTo(v.chainId).catch(() => {})}>
                    Switch to {v.chainName}
                  </Button>
                </div>
              </Message>
              {switchError && switchTarget && <Message tone="error">{describeSwitchError(switchError, switchTarget)}</Message>}
            </div>
          )}
          <StatRow>
            <Stat label="Total deposited" value={usd(valuation.usd)} sub={valuation.unpriced.length > 0 ? `no price for ${valuation.unpriced.join(', ')}` : undefined} />
            {/* The fee APR alone, as the original design's stat row drew it */}
            <Stat label="APR" value={fmtFeeApr(earnings.apr)} />
            <Stat label="Price" value={nav === undefined ? '—' : fmtPrice(nav)} sub={`per ${v.entry.receipt.symbol}`} />
            <Stat label="Performance fee" value={feeLabel(v.performanceFeeBps)} sub="on harvested fees only" />
          </StatRow>
        </header>

        <aside className="grid gap-4 lg:sticky lg:top-20 lg:col-start-2 lg:row-span-4 lg:row-start-1">
          {address && <YourPosition row={row} apr={earnings.apr} aprWindow={earnings.aprWindow} fees={earnings.fees} />}
          {/* On the wrong network the card's own footer carries "Add the network by hand", as in the Markets overlay: no second copy here */}
          <DepositCard vault={vault} user={user} usdPrices={usdPrices} nav={nav} showVaultLink={false} />
          {/* Demo chain only, with no wallet on another network: fund the wallet from the local node. */}
          {isLocalChain(v.chainId) && !wrongChain && vault.tokens.length > 0 && <LocalDevPanel vault={vault} user={user} />}
        </aside>

        {pairs.length > 0 && <PriceRange pairs={pairs} className="min-w-0 lg:col-start-1" />}

        <section className="min-w-0 lg:col-start-1">
          <h2 className="title text-2xl leading-tight mb-4">Basket</h2>
          {valuation.usd !== undefined && valuation.usd > 0 && <BasketBar className="mb-4" tokens={order.map((i) => displaySymbol(v.tokens[i].symbol))} legs={order.map((i) => valuation.legs[i])} />}
          {/* No share column: the bar's legend gives each share. Phones fold the spot price under the token, so the table fits */}
          <table className="w-full text-base num">
            <thead>
              <tr className="text-xs text-weaker border-b border-stroke-strong">
                <th className="text-left font-medium pb-2">Token</th>
                <th className="text-right font-medium pb-2">In the vault</th>
                <th className="hidden text-right font-medium pb-2 sm:table-cell">Spot price</th>
                <th className="text-right font-medium pb-2">Value</th>
                {yours && (
                  <th className="text-right font-medium pb-2">
                    <Hint tip={`What your ${v.entry.receipt.symbol} redeems for right now, in kind.`} align="end" wide>
                      Yours
                    </Hint>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {order.map((i) => {
                const t = v.tokens[i];
                const leg = valuation.legs[i];
                const anchor = anchorOf(v.tokens);
                const price = t.symbol === USD_ANCHOR_SYMBOL ? 1 : leg?.spot && anchor ? spotUsdPerToken(leg.spot, t.decimals, anchor.decimals) : undefined;
                const priceText = price === undefined ? '—' : fmtPrice(price);
                return (
                  <tr key={t.address} className="border-b border-stroke-weak">
                    <td className="py-3 text-strong">
                      <div>{displaySymbol(t.symbol)}</div>
                      <div className="text-xs text-weaker sm:hidden">{priceText}</div>
                    </td>
                    <td className="py-3 text-right text-strong">{formatAmount(t.total, t.decimals, 6)}</td>
                    <td className="hidden py-3 text-right text-weak sm:table-cell">{priceText}</td>
                    <td className="py-3 text-right text-weak">{usd(leg?.usd)}</td>
                    {yours && <td className="py-3 text-right text-strong">{yoursReady ? formatAmount(yours.get(t.address.toLowerCase()) ?? 0n, t.decimals, 6) : '—'}</td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
          <PricesUsed row={row} spots={spots} />
        </section>

        <NavChart seed={row.id} chainId={v.chainId} vaultKey={v.entry.key} symbol={v.entry.receipt.symbol} liveNav={nav} className="min-w-0 lg:col-start-1" />
      </div>
    </div>
  );
}

/**
 * The wallet's live holding: receipt balance, and its slice of the spot TVL — then the original design's
 * earnings rows: the vault's fees earned to date (harvested plus still unclaimed), and the fee APR
 * (annualised over the last 24 hours).
 */
function YourPosition({
  row: { v, valuation },
  apr,
  aprWindow,
  fees,
}: {
  row: LiveVaultRow;
  apr: number | undefined;
  aprWindow: string | undefined;
  fees: number | undefined;
}) {
  if (!v.receiptBalance) return null;
  const value = holdingUsd(v.receiptBalance, v.supply, valuation.usd);
  return (
    <section className="grid gap-3 rounded-lg border border-stroke-strong bg-background-elevated px-5 pb-5 pt-4">
      <h2 className="eyebrow">Your position</h2>
      <div className="display num text-3xl leading-none tracking-[-0.015em]">{value === undefined ? '—' : fmtUsd(value, { compact: false, cents: true })}</div>
      <p className="num text-base text-weak">
        {formatAmountSignificant(v.receiptBalance, v.decimals)} {v.entry.receipt.symbol}
        {v.supply ? <> · {fmtPct(Number(v.receiptBalance) / Number(v.supply))} of supply</> : null}
      </p>
      <dl className="num text-base">
        <Row
          label="Fees earned"
          value={fees === undefined ? '—' : fmtUsd(fees, { compact: false, cents: true })}
          tone={fees === undefined ? 'text-weaker' : 'text-success'}
          tip={`Trading fees the vault has earned in total, all holders together. They compound into your ${v.entry.receipt.symbol} automatically — nothing to claim.`}
        />
        <Row
          label="Your APR"
          value={fmtFeeApr(apr)}
          sub={aprWindow}
          tip={FEE_APR_HINT}
        />
      </dl>
    </section>
  );
}

function Row({ label, value, sub, tone, tip }: { label: string; value: string; sub?: string; tone?: string; tip: string }) {
  return (
    <Tooltip content={tip} align="start" side="bottom" wide className="flex w-full">
      <div className="flex w-full cursor-help justify-between gap-3 border-t border-stroke-weak py-2">
        <dt className="text-weaker">
          {label}
          {sub && <span className="block text-2xs">{sub}</span>}
        </dt>
        <dd className={cx(tone ?? 'text-strong')}>{value}</dd>
      </div>
    </Tooltip>
  );
}

/** Where each USD figure comes from: the reference pool and fee tier behind every spot. */
function PricesUsed({ row: { v }, spots }: { row: LiveVaultRow; spots: ChainSpots }) {
  const lines = v.tokens.flatMap((t) => {
    const s = spots.spots.get(t.address.toLowerCase());
    return s ? [{ symbol: displaySymbol(t.symbol), pool: s.pool, fee: s.fee }] : [];
  });
  return (
    <p className={cx('mt-3 text-2xs text-weaker leading-relaxed')}>
      {USD_ANCHOR_SYMBOL} at its $1 peg
      {lines.map((l) => (
        <span key={l.pool}>
          {' · '}
          {l.symbol} at the live spot of pool <span title={l.pool}>{shortHex(l.pool)}</span>
          {l.fee !== undefined && <> ({(l.fee / 10_000).toFixed(2)}%)</>}
        </span>
      ))}
      . No oracle, no TWAP — display only.
    </p>
  );
}
