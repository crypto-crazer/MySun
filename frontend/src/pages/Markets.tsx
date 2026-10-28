/**
 * The home page: the selected chain's vaults, read live from the chain (src/chain/useLiveVaults.ts).
 * The table follows the header's chain selector (useTargetChain): switch chain, see that chain's
 * vaults. TVL is the basket's `totalTokens()` at the live reference-pool spot (USDG at its $1 peg —
 * display only). APR is the original design's fee APR — trading fees over the last 7 days ÷ the mean
 * TVL, annualised — from the NAV-history collector (src/chain/feeApy.ts; the same fetch the vault
 * page's chart reads); "—" until 7 days are covered. No volume column: the chain cannot answer it
 * (docs/LIVE-DATA.md). Each row's basket bar is every token's share of that spot value, in the name's
 * order. NAV, the fee, the per-token amounts and the price range are on the vault page.
 * "Deposit" opens the deposit card over this page (`?deposit=<vault id>`), as the original did; the row opens the vault's page.
 */
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useWallet } from '@/wallet/context';
import { useStore } from '@/store/useStore';
import { DEPLOYMENTS } from '@/chain/chains';
import { useTargetChain } from '@/chain/useTargetChain';
import { basketName, basketOrder, displaySymbol, holdingUsd, resolveVaultRouteId, vaultRouteId } from '@/chain/liveVaults';
import { useLiveVaults, type LiveVaultRow } from '@/chain/useLiveVaults';
import { FEE_APR_WINDOW_DAYS, feeApyPct, fmtFeeApr } from '@/chain/feeApy';
import { useNavHistoryRows } from '@/chain/useNavHistory';
import { cx, fmtUsd } from '@/lib/format';
import { Stat } from '@/components/ui/Stat';
import { TokenGroup } from '@/components/ui/TokenIcon';
import { Button } from '@/components/ui/Button';
import { Arrow } from '@/components/ui/Arrow';
import { POPOVER_PANEL, useDismiss } from '@/components/ui/Popover';
import { Spinner } from '@/components/ui/Spinner';
import { HINT_UNDERLINE, Tooltip } from '@/components/ui/Tooltip';
import { BasketBar } from '@/components/vault/BasketBar';
import { DepositModal } from '@/components/deposit/DepositModal';
import { Welcome } from '@/components/layout/Welcome';
import { SkyScene } from '@/components/brand/SkyScene';

type SortKey = 'apr' | 'tvl';
type SortDir = 'asc' | 'desc';
type Sort = { key: SortKey; dir: SortDir };

const APR_HINT = 'Trading fees over the last 7 days ÷ average total deposited, annualised. Shows — until 7 days of history exist.';

export function Markets() {
  const { address } = useWallet();
  const { rows: all, spotsFor } = useLiveVaults(address ?? undefined);
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const depositRef = resolveVaultRouteId(params.get('deposit') ?? undefined, DEPLOYMENTS);
  const depositRow = depositRef.kind === 'found' ? all.find((r) => r.id === vaultRouteId(depositRef.ref.chainId, depositRef.ref.key)) ?? null : null;
  const { selectedChainId } = useTargetChain();
  const chain = String(selectedChainId);
  const [sort, setSort] = useState<Sort>({ key: 'tvl', dir: 'desc' });
  const toggleSort = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' }));

  const { rows: history } = useNavHistoryRows();
  const aprOf = useMemo(() => {
    const m = new Map<string, number | undefined>();
    for (const r of all) m.set(r.id, feeApyPct(history, r.v.entry.key, FEE_APR_WINDOW_DAYS, r.v.chainId));
    return m;
  }, [all, history]);

  const rows = useMemo(() => {
    const val = (r: LiveVaultRow) => (sort.key === 'apr' ? aprOf.get(r.id) : r.valuation.usd) ?? -1;
    return all
      .filter((r) => String(r.v.chainId) === chain)
      .sort((a, b) => (sort.dir === 'desc' ? val(b) - val(a) : val(a) - val(b)));
  }, [all, chain, sort, aprOf]);

  const priced = rows.filter((r) => r.valuation.usd !== undefined);
  const totalTvl = priced.reduce((s, r) => s + (r.valuation.usd ?? 0), 0);
  const mine = rows
    .map((r) => holdingUsd(r.v.receiptBalance, r.v.supply, r.valuation.usd))
    .filter((x): x is number => x !== undefined && x > 0);
  const showMine = Boolean(address) && mine.length > 0;
  const connected = useStore((s) => s.connected);
  // Connected with nothing deposited, the hero has no button: from sm up the reading follows the title, not the ground
  const tvlUnderTitle = connected && !showMine;

  // The CTA pushes `?deposit=` with a marker, so Back closes the overlay. Closing steps back out of that
  // entry instead of pushing another, so Back afterwards leaves Markets rather than reopening the card;
  // a deep-linked `?deposit=` has no entry of ours to step out of, so it is replaced.
  const deposit = (r: LiveVaultRow) => setParams({ deposit: r.id }, { state: { depositOverlay: true } });
  const closeDeposit = () => ((location.state as { depositOverlay?: boolean } | null)?.depositOverlay ? navigate(-1) : setParams({}, { replace: true }));

  return (
    <div>
      {/* The sky: who you are here and what you hold, over the scene */}
      <section className={cx('relative overflow-hidden border-b border-stroke-strong', showMine ? 'sm:h-[clamp(360px,44vh,410px)]' : 'sm:h-[clamp(410px,54vh,500px)]')}>
        {/* On phones the scene is a band across the top, with the title rising into its foot; from sm up it fills the section */}
        <SkyScene className="absolute inset-x-0 top-0 h-[200px] w-full sm:h-full" />
        <div className="sky-shade absolute inset-x-0 top-0 z-[2] h-[200px] pointer-events-none sm:h-full" />
        <div className="wrap relative z-[4] grid justify-items-start gap-5 pt-44 sm:pt-[clamp(32px,6vh,56px)]">
          {showMine ? (
            <>
              <p className="eyebrow !text-weak">Your deposits</p>
              <div className="display text-[clamp(48px,6vw,80px)] leading-none tracking-[-0.02em]">{fmtUsd(mine.reduce((s, x) => s + x, 0), { compact: false })}</div>
            </>
          ) : (
            <Welcome />
          )}
        </div>
        <div className={cx('wrap relative z-[4] py-6', tvlUnderTitle ? 'sm:pt-10' : 'sm:absolute sm:inset-x-0 sm:bottom-0')}>
          <Stat label="TVL" value={priced.length > 0 ? fmtUsd(totalTvl) : '—'} sub={priced.length < rows.length && priced.length > 0 ? `${priced.length} of ${rows.length} vaults priced` : undefined} />
        </div>
      </section>

      {/* The plaza: every vault as an instrument */}
      <div className="wrap pt-8 pb-20 sm:pt-[52px] sm:pb-[120px]">
        <div className="mb-6 flex items-center justify-between gap-4">
          <h1 className="title text-[clamp(32px,3.6vw,46px)]">Vaults</h1>
          <SortMenu sort={sort} onChange={setSort} className="lg:hidden" />
        </div>

        <div className={cx('eyebrow hidden items-center border-b border-stroke-strong px-4 pb-3 lg:grid', COLS)}>
          <span>Vault</span>
          <span>Basket</span>
          <span className="justify-self-end"><SortHead label="APR" hint={APR_HINT} active={sort.key === 'apr'} dir={sort.dir} onClick={() => toggleSort('apr')} /></span>
          <span className="justify-self-end"><SortHead label="Total deposited" active={sort.key === 'tvl'} dir={sort.dir} onClick={() => toggleSort('tvl')} /></span>
          <span />
        </div>
        <ul>
          {rows.map((r) => (
            <VaultRow key={r.id} row={r} apr={aprOf.get(r.id)} onDeposit={() => deposit(r)} />
          ))}
          {rows.length === 0 && (
            <li className="border-b border-stroke-weak py-12 text-center text-weaker">No vaults on this network.</li>
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

// Columns: vault, its basket, APR, total deposited, action
// A row only fits from lg; below that it stacks as on a phone: the two readings side by side, Deposit across the foot.
const COLS =
  'lg:grid-cols-[minmax(220px,1.15fr)_minmax(180px,1fr)_72px_136px_76px] lg:gap-x-4 xl:grid-cols-[minmax(190px,1.15fr)_minmax(200px,1fr)_88px_144px_104px] xl:gap-x-6';

function VaultRow({ row: r, apr, onDeposit }: { row: LiveVaultRow; apr: number | undefined; onDeposit: () => void }) {
  const navigate = useNavigate();
  const { v, valuation } = r;
  const label = 'eyebrow mb-1 block lg:hidden';
  const symbols = basketOrder(v.tokens.map((t) => t.symbol));
  // The legs follow the on-chain order; the bar reads in the name's
  const order = symbols.map((s) => v.tokens.findIndex((t) => t.symbol === s));
  const loading = !v.failed && (!v.ready || (r.spotsLoading && valuation.usd === undefined));
  const usdCell = (x: number | undefined, fmt: (n: number) => string) =>
    v.failed ? <span className="text-weaker">—</span> : loading ? <Spinner className="h-4 w-4 text-weaker inline-block" /> : x === undefined ? <span className="text-weaker">—</span> : fmt(x);

  return (
    <li
      data-vault={r.id}
      className={cx(
        'grid cursor-pointer grid-cols-2 items-center gap-x-6 gap-y-3 border-b border-stroke-weak px-3 py-4 lg:px-4 transition-colors duration-300 ease-dusk hover:bg-strong/[0.035]',
        "[grid-template-areas:'pair_pair''mix_mix''apr_tvl''act_act'] lg:[grid-template-areas:none]",
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
      <div className="mb-2 min-w-0 [grid-area:mix] lg:mb-0 lg:[grid-area:auto]">
        {valuation.usd !== undefined && valuation.usd > 0 ? (
          <BasketBar tokens={order.map((i) => displaySymbol(v.tokens[i].symbol))} legs={order.map((i) => valuation.legs[i])} />
        ) : (
          // An unpriced or empty basket has no shares to draw; the stacked layout drops the dash
          !loading && <span className="hidden text-weaker lg:inline">—</span>
        )}
      </div>
      <div className="num text-xl text-weak lg:text-md [grid-area:apr] lg:justify-self-end lg:[grid-area:auto]" title={APR_HINT}><span className={label}>APR</span>{apr === undefined ? <span className="text-weaker">—</span> : fmtFeeApr(apr)}</div>
      <div className="display num text-xl text-strong [grid-area:tvl] lg:justify-self-end lg:[grid-area:auto]"><span className={label}>Total deposited</span>{usdCell(valuation.usd, (n) => fmtUsd(n, { cents: n < 10_000 }))}</div>
      <div className="mt-2 self-center [grid-area:act] lg:mt-0 lg:justify-self-end lg:[grid-area:auto]">
        <Button size="sm" className="w-full lg:w-auto" disabled={v.paused === true} onClick={(e) => { e.stopPropagation(); onDeposit(); }}>
          {v.paused ? 'Paused' : 'Deposit'}
        </Button>
      </div>
    </li>
  );
}

const SORT_LABEL: Record<SortKey, string> = { tvl: 'Total deposited', apr: 'APR' };
const SORTS: Sort[] = [
  { key: 'tvl', dir: 'desc' },
  { key: 'tvl', dir: 'asc' },
  { key: 'apr', dir: 'desc' },
  { key: 'apr', dir: 'asc' },
];
const dirText = (dir: SortDir) => (dir === 'desc' ? 'high to low' : 'low to high');

/** Below lg the column heads are hidden: one button opens every order, the current one ticked. */
function SortMenu({ sort, onChange, className }: { sort: Sort; onChange: (s: Sort) => void; className?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useDismiss(ref, open, setOpen);

  return (
    <div className={cx('relative', className)} ref={ref}>
      <Button
        type="button"
        // Quiet: a control over the list, not an action on a vault
        variant="ghost"
        size="sm"
        onClick={() => setOpen(!open)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Sort: ${SORT_LABEL[sort.key]}, ${dirText(sort.dir)}`}
      >
        <span className="flex items-center gap-2">
          <svg viewBox="0 0 16 16" className="h-4 w-4 shrink-0 text-weaker" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M5 13V3M2.5 5.5L5 3l2.5 2.5M11 3v10M8.5 10.5L11 13l2.5-2.5" />
          </svg>
          {SORT_LABEL[sort.key]}
          <Arrow dir={sort.dir === 'desc' ? 'down' : 'up'} size={10} />
        </span>
      </Button>
      {open && (
        <ul
          role="listbox"
          aria-label="Sort vaults"
          className={cx(POPOVER_PANEL, 'w-56 p-1')}
        >
          {SORTS.map((s) => {
            const current = s.key === sort.key && s.dir === sort.dir;
            return (
              <li key={`${s.key}-${s.dir}`} role="option" aria-selected={current}>
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    onChange(s);
                  }}
                  // Rows a thumb can hit: 44px tall
                  className={cx('w-full rounded px-3 py-3 text-left text-base flex items-center gap-2 hover:bg-background-elevated', current ? 'text-strong' : 'text-weak')}
                >
                  {SORT_LABEL[s.key]}
                  <Arrow dir={s.dir === 'desc' ? 'down' : 'up'} size={10} />
                  <span className="sr-only">, {dirText(s.dir)}</span>
                  {current && <span className="ml-auto text-strong" aria-hidden>✓</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
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
