/**
 * The home page: the selected chain's vaults, read live from the chain (src/chain/useLiveVaults.ts).
 * The table follows the header's chain selector (useTargetChain): switch chain, see that chain's
 * vaults. TVL is the basket's `totalTokens()` at the live reference-pool spot (USDG at its $1 peg —
 * display only). APR is the original design's fee APR — trading fees over the last 7 days ÷ the mean
 * TVL, annualised — from the NAV-history collector (src/chain/feeApy.ts; the same fetch the vault
 * page's chart reads); "—" until 7 days are covered. No volume column: the chain cannot answer it
 * (docs/LIVE-DATA.md). NAV, the fee and the basket's composition are on the vault page. Each row's
 * range meter puts the live spot between the adapters' on-chain range (src/chain/ranges.ts). "Deposit"
 * opens the deposit card over this page (`?deposit=<vault id>`), as the original did; the row opens the vault's page.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useWallet } from '@/wallet/context';
import { DEPLOYMENTS } from '@/chain/chains';
import { useTargetChain } from '@/chain/useTargetChain';
import { basketName, holdingUsd, resolveVaultRouteId, tokenUsdPrices, vaultRouteId } from '@/chain/liveVaults';
import { useLiveVaults, type LiveVaultRow } from '@/chain/useLiveVaults';
import type { ChainSpots } from '@/chain/useSpotPrices';
import { useVaultRanges } from '@/chain/useVaultRanges';
import { FEE_APR_WINDOW_DAYS, feeApyPct, fmtFeeApr } from '@/chain/feeApy';
import { useNavHistoryRows } from '@/chain/useNavHistory';
import { cx, fmtUsd } from '@/lib/format';
import { Stat, StatRow } from '@/components/ui/Stat';
import { TokenGroup } from '@/components/ui/TokenIcon';
import { Button } from '@/components/ui/Button';
import { Arrow } from '@/components/ui/Arrow';
import { Spinner } from '@/components/ui/Spinner';
import { HINT_UNDERLINE, Tooltip } from '@/components/ui/Tooltip';
import { RangeMeter } from '@/components/vault/RangeMeter';
import { rangePairsFor } from '@/components/vault/rangePairs';
import { DepositModal } from '@/components/deposit/DepositModal';
import { Welcome } from '@/components/layout/Welcome';
import { SkyScene } from '@/components/brand/SkyScene';

type SortKey = 'apr' | 'tvl';

const APR_HINT = 'Trading fees over the last 7 days ÷ average TVL, annualised. Shows — until 7 days of history exist.';

export function Markets() {
  const { address } = useWallet();
  const { rows: all, spotsFor } = useLiveVaults(address ?? undefined);
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const depositRef = resolveVaultRouteId(params.get('deposit') ?? undefined, DEPLOYMENTS);
  const depositRow = depositRef.kind === 'found' ? all.find((r) => r.id === vaultRouteId(depositRef.ref.chainId, depositRef.ref.key)) ?? null : null;
  const [q, setQ] = useState('');
  const { selectedChainId } = useTargetChain();
  const chain = String(selectedChainId);
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'tvl', dir: 'desc' });
  const toggleSort = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' }));

  const { rows: history } = useNavHistoryRows();
  const aprOf = useMemo(() => {
    const m = new Map<string, number | undefined>();
    for (const r of all) m.set(r.id, feeApyPct(history, r.v.entry.key, FEE_APR_WINDOW_DAYS, r.v.chainId));
    return m;
  }, [all, history]);

  const rows = useMemo(() => {
    const val = (r: LiveVaultRow) => (sort.key === 'apr' ? aprOf.get(r.id) : r.valuation.usd) ?? -1;
    const needle = q.toLowerCase().replace(/\s/g, '');
    return all
      .filter((r) => String(r.v.chainId) === chain)
      // The display name says ETH; the on-chain symbols keep "WETH" findable too.
      .filter((r) => `${nameOf(r)} ${r.v.tokens.map((t) => t.symbol).join(' ')} ${r.v.entry.receipt.symbol} ${r.v.chainName}`.toLowerCase().replace(/\s/g, '').includes(needle))
      .sort((a, b) => (sort.dir === 'desc' ? val(b) - val(a) : val(a) - val(b)));
  }, [all, q, chain, sort, aprOf]);

  const priced = rows.filter((r) => r.valuation.usd !== undefined);
  const totalTvl = priced.reduce((s, r) => s + (r.valuation.usd ?? 0), 0);
  const mine = rows
    .map((r) => holdingUsd(r.v.receiptBalance, r.v.supply, r.valuation.usd))
    .filter((x): x is number => x !== undefined && x > 0);
  const showMine = Boolean(address) && mine.length > 0;

  // The CTA pushes `?deposit=` with a marker, so Back closes the overlay. Closing steps back out of that
  // entry instead of pushing another, so Back afterwards leaves Markets rather than reopening the card;
  // a deep-linked `?deposit=` has no entry of ours to step out of, so it is replaced.
  const deposit = (r: LiveVaultRow) => setParams({ deposit: r.id }, { state: { depositOverlay: true } });
  const closeDeposit = () => ((location.state as { depositOverlay?: boolean } | null)?.depositOverlay ? navigate(-1) : setParams({}, { replace: true }));

  return (
    <div>
      {/* The sky: who you are here and what you hold, over the scene */}
      <section className={cx('relative overflow-hidden border-b border-stroke-strong', showMine ? 'sm:h-[clamp(360px,44vh,410px)]' : 'sm:h-[clamp(410px,54vh,500px)]')}>
        {/* On phones the scene is a band across the top; from sm up it fills the section */}
        <SkyScene className="absolute inset-x-0 top-0 h-[260px] w-full sm:h-full" />
        <div className="sky-shade absolute inset-x-0 top-0 z-[2] h-[260px] pointer-events-none sm:h-full" />
        <div className="wrap relative z-[4] grid justify-items-start gap-5 pt-48 sm:pt-[clamp(32px,6vh,56px)]">
          {showMine ? (
            <>
              <p className="eyebrow !text-weak">Your deposits</p>
              <div className="display text-[clamp(48px,6vw,80px)] leading-none tracking-[-0.02em]">{fmtUsd(mine.reduce((s, x) => s + x, 0), { compact: false })}</div>
            </>
          ) : (
            <Welcome />
          )}
        </div>
        <div className="wrap relative z-[4] py-6 sm:absolute sm:inset-x-0 sm:bottom-0">
          <StatRow cols={2} packed rule={false}>
            <Stat label="Total TVL" value={priced.length > 0 ? fmtUsd(totalTvl) : '—'} sub={priced.length < rows.length && priced.length > 0 ? `${priced.length} of ${rows.length} vaults priced` : undefined} />
          </StatRow>
        </div>
      </section>

      {/* The plaza: every vault as an instrument */}
      <div className="wrap pt-[52px] pb-[120px]">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-x-7 gap-y-5">
          <h1 className="title text-[clamp(32px,3.6vw,46px)]">Vaults</h1>
          <div className="flex w-full flex-wrap items-center gap-x-6 gap-y-4 sm:w-auto">
            <label className="flex h-10 w-full items-center gap-2 rounded border border-stroke-strong px-3 text-weaker focus-within:border-stroke-strongest sm:w-[220px]">
              <svg viewBox="0 0 16 16" className="h-4 w-4 shrink-0" fill="none" aria-hidden>
                <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
                <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search vaults"
                aria-label="Search vaults"
                className="min-w-0 flex-1 bg-transparent text-base text-strong outline-none placeholder:text-weaker focus-visible:outline-none"
              />
            </label>
          </div>
        </div>

        <div className={cx('eyebrow hidden items-center border-b border-stroke-strong px-4 pb-3 lg:grid', COLS)}>
          <span>Vault</span>
          <span>Price range</span>
          <span className="justify-self-end"><SortHead label="APR" hint={APR_HINT} active={sort.key === 'apr'} dir={sort.dir} onClick={() => toggleSort('apr')} /></span>
          <span className="justify-self-end"><SortHead label="TVL" active={sort.key === 'tvl'} dir={sort.dir} onClick={() => toggleSort('tvl')} /></span>
          <span />
        </div>
        <div className="eyebrow flex justify-end gap-5 px-3 lg:hidden">
          <SortHead label="APR" hint={APR_HINT} active={sort.key === 'apr'} dir={sort.dir} onClick={() => toggleSort('apr')} />
          <SortHead label="TVL" active={sort.key === 'tvl'} dir={sort.dir} onClick={() => toggleSort('tvl')} />
        </div>
        <ul>
          {rows.map((r) => (
            <VaultRow key={r.id} row={r} apr={aprOf.get(r.id)} spots={spotsFor(r.v.chainId)} onDeposit={() => deposit(r)} />
          ))}
          {rows.length === 0 && (
            <li className="border-b border-stroke-weak py-12 text-center text-weaker">No vaults match{q ? ` "${q}"` : ''}.</li>
          )}
        </ul>
      </div>
      <DepositModal row={depositRow} spots={depositRow ? spotsFor(depositRow.v.chainId) : undefined} onClose={closeDeposit} />
    </div>
  );
}

function nameOf(r: LiveVaultRow): string {
  return basketName(r.v.ready ? r.v.tokens.map((t) => t.symbol) : [], r.v.entry.label);
}

// Columns: vault, its price range, APR, TVL, action
// A row only fits from lg; below that it stacks as on a phone.
const COLS =
  'lg:grid-cols-[minmax(220px,1.15fr)_minmax(180px,1.7fr)_72px_92px_76px] lg:gap-x-4 xl:grid-cols-[minmax(190px,1.15fr)_minmax(200px,1.7fr)_88px_104px_104px] xl:gap-x-6';

function VaultRow({ row: r, apr, spots, onDeposit }: { row: LiveVaultRow; apr: number | undefined; spots: ChainSpots; onDeposit: () => void }) {
  const navigate = useNavigate();
  const { v, valuation } = r;
  const label = 'mr-2 text-xs font-normal text-weaker lg:hidden';
  const symbols = v.tokens.map((t) => t.symbol);
  const loading = !v.failed && (!v.ready || (r.spotsLoading && valuation.usd === undefined));
  const usdCell = (x: number | undefined, fmt: (n: number) => string) =>
    v.failed ? <span className="text-weaker">—</span> : loading ? <Spinner className="h-4 w-4 text-weaker inline-block" /> : x === undefined ? <span className="text-weaker">—</span> : fmt(x);

  return (
    <li
      data-vault={r.id}
      className={cx(
        'grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-2 border-b border-stroke-weak px-3 py-4 lg:px-4 transition-colors duration-300 ease-dusk hover:bg-strong/[0.035]',
        "[grid-template-areas:'pair_pair''meter_meter''apr_act''tvl_act'] lg:[grid-template-areas:none]",
        COLS,
      )}
      onClick={() => navigate(`/vault/${r.id}`)}
    >
      <div className="flex min-w-0 items-start gap-3 [grid-area:pair] [--name:28px] lg:[grid-area:auto]">
        {symbols.length > 0 && <span className="flex shrink-0 mt-[calc((var(--name)-26px)/2)]"><TokenGroup symbols={symbols} size={26} /></span>}
        <div className="min-w-0">
          <div className="font-serif text-xl font-normal leading-[var(--name)] text-strong lg:truncate" title={nameOf(r)}>{nameOf(r)}</div>
          {/* Only an exception earns a line under the name */}
          {v.paused && <div className="mt-1 text-2xs text-warning">Paused</div>}
          {v.failed && <div className="mt-1 text-2xs text-warning">Chain not reachable</div>}
        </div>
      </div>
      <div className="min-w-0 [grid-area:meter] lg:[grid-area:auto]">
        <Range row={r} spots={spots} />
      </div>
      <div className="num text-md text-weak [grid-area:apr] lg:justify-self-end lg:[grid-area:auto]" title="Trading fees, 7-day average, annualised"><span className={label}>APR</span>{apr === undefined ? <span className="text-weaker">—</span> : fmtFeeApr(apr)}</div>
      <div className="display num text-xl text-strong [grid-area:tvl] lg:justify-self-end lg:[grid-area:auto]"><span className={label}>TVL</span>{usdCell(valuation.usd, (n) => fmtUsd(n, { cents: n < 10_000 }))}</div>
      <div className="justify-self-end self-center [grid-area:act] lg:[grid-area:auto]">
        <Button size="sm" disabled={v.paused === true} onClick={(e) => { e.stopPropagation(); onDeposit(); }}>
          {v.paused ? 'Paused' : 'Deposit'}
        </Button>
      </div>
    </li>
  );
}

/** The first non-USDG token with a live position: its spot between the adapters' on-chain range. */
function Range({ row: { v }, spots }: { row: LiveVaultRow; spots: ChainSpots }) {
  const { bands } = useVaultRanges(v.chainId, v.address, v.tokens);
  const pair = rangePairsFor(v.tokens, tokenUsdPrices(v.tokens, spots.spots), bands)[0];
  if (!pair) return null;
  return (
    <div title={`${pair.base} in ${pair.quote} — live price, on-chain range`}>
      <RangeMeter price={pair.price} lower={pair.lower} upper={pair.upper} />
    </div>
  );
}

/** A sortable column label; with a hint, the label is underlined and explains itself on hover or focus. */
function SortHead({ label, hint, active, dir, onClick }: { label: string; hint?: string; active: boolean; dir: 'asc' | 'desc'; onClick: () => void }): ReactNode {
  const head = (
    <button onClick={onClick} className={cx('inline-flex items-center gap-1 whitespace-nowrap uppercase tracking-label hover:text-strong', active && 'text-strong')}>
      {/* Only the sorted column carries an arrow, before the label, so the label stays flush right */}
      {active && <Arrow dir={dir === 'desc' ? 'down' : 'up'} size={10} />}
      <span className={hint && HINT_UNDERLINE}>{label}</span>
      <span className="sr-only">{active ? `, sorted ${dir === 'desc' ? 'descending' : 'ascending'}` : ', sortable'}</span>
    </button>
  );
  return hint ? <Tooltip content={hint} wide align="end" className="normal-case tracking-normal">{head}</Tooltip> : head;
}
