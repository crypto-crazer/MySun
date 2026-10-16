import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { VAULTS, VAULT_BY_ID, VOLUME_SNAPSHOT_DATE, vaultName } from '@/demo/data/vaults';
import { CHAINS, type ChainId } from '@/demo/data/chains';
import { ChainFilter } from '@/components/ui/ChainFilter';
import * as m from '@/demo/math';
import { cx, fmtPct, fmtUsd } from '@/lib/format';
import type { MarketStatus } from '@/lib/market';
import type { Vault } from '@/lib/types';
import { useStore } from '@/store/useStore';
import { useMarketStatus, useUserDerived, useVaultApr } from '@/store/selectors';
import { Stat, StatRow } from '@/components/ui/Stat';
import { TokenPair } from '@/components/ui/TokenIcon';
import { Button } from '@/components/ui/Button';
import { HINT_UNDERLINE, Tooltip } from '@/components/ui/Tooltip';
import { Arrow } from '@/components/ui/Arrow';
import { DepositModal } from '@/components/deposit/DepositModal';
import { Welcome } from '@/components/layout/Welcome';
import { SkyScene } from '@/components/brand/SkyScene';
import { RangeMeter } from '@/components/vault/RangeMeter';


export function Markets() {
  const tvlDelta = useStore((s) => s.user.tvlDelta);
  const d = useUserDerived();
  const [q, setQ] = useState('');
  const [chain, setChain] = useState<ChainId | 'all'>('all');
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'tvl', dir: 'desc' });
  const toggleSort = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' }));
  const [params, setParams] = useSearchParams();
  const depositVault = VAULT_BY_ID[params.get('deposit') ?? ''] ?? null;
  const rows = useMemo(
    () =>
      VAULTS.filter((v) => chain === 'all' || v.chain === chain)
        .filter((v) => `${vaultName(v)} ${CHAINS[v.chain].name}`.toLowerCase().replace(/\s/g, '').includes(q.toLowerCase().replace(/\s/g, '')))
        .map((v) => ({ v, tvl: m.effectiveTvl(v, tvlDelta), apr: m.aprBreakdown(v, m.effectiveTvl(v, tvlDelta)).feeApr, vol: v.volume24h }))
        .sort((a, b) => (sort.dir === 'desc' ? b[sort.key] - a[sort.key] : a[sort.key] - b[sort.key])),
    [q, chain, tvlDelta, sort],
  );
  const showMine = d.connected && d.hasPositions;
  const positions = useStore((s) => s.user.positions);
  const now = Date.now();
  const totalFees = Object.entries(positions).reduce((a, [id, p]) => {
    const pv = VAULT_BY_ID[id];
    return pv ? a + m.feesEarned(m.positionValue(p, pv), pv.feeApr7d, p.depositedAt, now) : a;
  }, 0);

  const market = useMarketStatus();

  return (
    <div>
      {/* The sky: who you are here and what you hold, over the scene */}
      <section className={cx('relative overflow-hidden border-b border-stroke-strong', d.connected ? 'sm:h-[clamp(360px,44vh,410px)]' : 'sm:h-[clamp(410px,54vh,500px)]')}>
        {/* On phones the scene is a band across the top; from sm up it fills the section */}
        <SkyScene className="absolute inset-x-0 top-0 h-[260px] w-full sm:h-full" />
        <div className="sky-shade absolute inset-x-0 top-0 z-[2] h-[260px] pointer-events-none sm:h-full" />
        <div className="wrap relative z-[4] grid justify-items-start gap-[18px] pt-[190px] sm:pt-[clamp(32px,6vh,56px)]">
          {d.connected ? (
            <>
              <p className="eyebrow !text-weak">Your deposits</p>
              <div className="display text-[clamp(48px,6vw,80px)] leading-none tracking-[-0.02em]">{fmtUsd(d.depositsUsd, { compact: false })}</div>
            </>
          ) : (
            <Welcome />
          )}
        </div>
        <div className="wrap relative z-[4] py-6 sm:absolute sm:inset-x-0 sm:bottom-0">
          {/* Your own fees lead once you hold a position; the whole protocol's readings stay either way */}
          <StatRow cols={showMine ? 3 : 2} packed rule={false}>
            {showMine && <Stat label="Your fees earned" value={`+${fmtUsd(totalFees, { compact: false, cents: true })}`} tone="success" />}
            <Stat label="Total TVL" value={fmtUsd(m.totalTvl(VAULTS, tvlDelta))} />
            <Stat label="All vaults' fees (24h)" value={fmtUsd(m.dailyFees(VAULTS, tvlDelta), { compact: false })} />
          </StatRow>
        </div>
      </section>

      {/* The plaza: every vault as an instrument */}
      <div className="wrap pt-[52px] pb-[120px]">
        <div className="mb-[22px] flex flex-wrap items-end justify-between gap-x-7 gap-y-[18px]">
          <h1 className="title text-[clamp(32px,3.6vw,46px)]">Vaults</h1>
          <div className="flex w-full flex-wrap items-center gap-x-[22px] gap-y-3.5 sm:w-auto">
            <ChainFilter value={chain} onChange={setChain} />
            <label className="flex h-10 w-full items-center gap-2 rounded border border-stroke-strong px-3 text-weaker focus-within:border-stroke-strongest sm:w-[220px]">
              <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0" fill="none" aria-hidden>
                <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
                <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search vaults"
                aria-label="Search vaults"
                className="min-w-0 flex-1 bg-transparent text-sm text-strong outline-none placeholder:text-weaker focus-visible:outline-none"
              />
            </label>
          </div>
        </div>

        <div className={cx('eyebrow hidden items-center border-b border-stroke-strong px-4 pb-2.5 lg:grid', COLS)}>
          <span>Vault</span>
          <span>Price within its range</span>
          <span className="justify-self-end"><SortHead label="APR" active={sort.key === 'apr'} dir={sort.dir} onClick={() => toggleSort('apr')} /></span>
          <span className="justify-self-end"><SortHead label="TVL" active={sort.key === 'tvl'} dir={sort.dir} onClick={() => toggleSort('tvl')} /></span>
          <span className="justify-self-end"><SortHead label="1D Vol" tip={VOLUME_NOTE} active={sort.key === 'vol'} dir={sort.dir} onClick={() => toggleSort('vol')} /></span>
          <span />
        </div>
        <div className="eyebrow flex justify-end gap-[18px] px-3 lg:hidden">
          <SortHead label="APR" active={sort.key === 'apr'} dir={sort.dir} onClick={() => toggleSort('apr')} />
          <SortHead label="TVL" active={sort.key === 'tvl'} dir={sort.dir} onClick={() => toggleSort('tvl')} />
          <SortHead label="1D Vol" tip={VOLUME_NOTE} active={sort.key === 'vol'} dir={sort.dir} onClick={() => toggleSort('vol')} />
        </div>
        <ul>
          {rows.map(({ v, tvl }) => (
            <VaultRow key={v.id} vault={v} tvl={tvl} market={market} onDeposit={() => setParams({ deposit: v.id })} />
          ))}
          {rows.length === 0 && (
            <li className="border-b border-stroke-weak py-12 text-center text-weaker">No vaults match{q ? ` "${q}"` : ''}{chain !== 'all' ? ` on ${CHAINS[chain].name}` : ''}.</li>
          )}
        </ul>
      </div>
      <DepositModal vault={depositVault} onClose={() => setParams({})} />
    </div>
  );
}

type SortKey = 'tvl' | 'apr' | 'vol';

// Columns: vault, its range, APR, TVL, 24h volume, action
// A row only fits from lg; below that it stacks as on a phone. Up to xl the figure columns and gaps
// are tighter, so the longest pair name keeps clear of the range meter's low price. A longer name is
// cut with an ellipsis rather than run into it: every row is its own grid, so the column cannot size to it.
const COLS =
  'lg:grid-cols-[minmax(250px,1.15fr)_minmax(200px,1.7fr)_88px_76px_76px_76px] lg:gap-x-4 xl:grid-cols-[minmax(190px,1.15fr)_minmax(220px,1.7fr)_96px_92px_104px_104px] xl:gap-x-6';

function VaultRow({ vault: v, tvl, market, onDeposit }: { vault: Vault; tvl: number; market: MarketStatus; onDeposit: () => void }) {
  const navigate = useNavigate();
  const { breakdown: b } = useVaultApr(v);
  const label = 'mr-1.5 text-xs font-normal text-weaker lg:hidden';

  return (
    <li
      className={cx(
        'grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-2 border-b border-stroke-weak px-3 py-4 lg:px-4 transition-colors duration-300 ease-dusk hover:bg-strong/[0.035]',
        "[grid-template-areas:'pair_apr''meter_meter''tvl_act''vol_act'] lg:[grid-template-areas:none]",
        COLS,
      )}
      onClick={() => navigate(`/vault/${v.id}`)}
    >
      {/* The 26px pair is centred on the name's first line, so a name that wraps on a phone does not pull it down */}
      <div className="flex min-w-0 items-start gap-3.5 [grid-area:pair] [--name:calc(23px*1.1)] lg:[grid-area:auto]">
        <span className="flex shrink-0 mt-[calc((var(--name)-26px)/2)]"><TokenPair a={v.token0} b={v.token1} size={26} chain={v.chain} /></span>
        <div className="min-w-0 font-serif text-[23px] font-normal leading-[var(--name)] text-strong lg:truncate" title={vaultName(v)}>{vaultName(v)}</div>
      </div>
      <div className="min-w-0 [grid-area:meter] lg:[grid-area:auto]"><RangeMeter vault={v} market={market} /></div>
      {/* The fee APR alone: PMG rewards are not counted while nothing on screen shows or pays them */}
      <div className="display num justify-self-end whitespace-nowrap text-xl text-strong [grid-area:apr] lg:[grid-area:auto]">{fmtPct(b.feeApr)}</div>
      <div className="num text-md text-weak [grid-area:tvl] lg:justify-self-end lg:[grid-area:auto]"><span className={label}>TVL</span>{fmtUsd(tvl)}</div>
      <div className="num text-md text-weak [grid-area:vol] lg:justify-self-end lg:[grid-area:auto]"><span className={label}>1D Vol</span>{fmtUsd(v.volume24h, { tenths: true })}</div>
      <div className="justify-self-end self-center [grid-area:act] lg:[grid-area:auto]">
        <Button size="sm" onClick={(e) => { e.stopPropagation(); onDeposit(); }}>
          Deposit
        </Button>
      </div>
    </li>
  );
}

/** A sortable column label. With a `tip`, the label is underlined and explains itself on hover or focus. */
function SortHead({ label, active, dir, onClick, tip }: { label: string; active: boolean; dir: 'asc' | 'desc'; onClick: () => void; tip?: ReactNode }) {
  const head = (
    <button onClick={onClick} className={cx('inline-flex items-center gap-[5px] whitespace-nowrap uppercase tracking-label hover:text-strong', active && 'text-strong')}>
      {/* Only the sorted column carries an arrow. It sits before the label, so the label stays flush with the
          right-aligned figures below and does not shift when the arrow comes and goes */}
      {active && <Arrow dir={dir === 'desc' ? 'down' : 'up'} size={10} />}
      <span className={cx(tip != null && HINT_UNDERLINE)}>{label}</span>
      {/* aria-sort is only read on a column header, and these rows are a list, not a table: the state goes in the name */}
      <span className="sr-only">{active ? `, sorted ${dir === 'desc' ? 'descending' : 'ascending'}` : ', sortable'}</span>
    </button>
  );
  return tip ? <Tooltip content={tip} align="end">{head}</Tooltip> : head;
}

/** What the 1D Vol figure is: the whole pool's, from one day's snapshot, not the vault's own and not live. */
const VOLUME_NOTE = (
  <span className="normal-case tracking-normal">The whole pool's trading volume over 24 hours, not this vault's share. Snapshot from {VOLUME_SNAPSHOT_DATE}, not updated live.</span>
);
