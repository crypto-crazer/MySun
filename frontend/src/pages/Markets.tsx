import { useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { VAULTS, VAULT_BY_ID, vaultName } from '@/demo/data/vaults';
import { CHAINS, type ChainId } from '@/demo/data/chains';
import { ChainFilter } from '@/components/ui/ChainFilter';
import * as m from '@/demo/math';
import { cx, fmtPct, fmtToken, fmtUsd } from '@/lib/format';
import { CONSTANTS } from '@/demo/constants';
import type { MarketStatus } from '@/lib/market';
import type { Vault } from '@/lib/types';
import { useStore } from '@/store/useStore';
import { useMarketStatus, useUserDerived, useVaultApr } from '@/store/selectors';
import { Stat, StatRow } from '@/components/ui/Stat';
import { TokenPair } from '@/components/ui/TokenIcon';
import { BoostedApr } from '@/components/ui/BoostedApr';
import { Button } from '@/components/ui/Button';
import { AprBreakdown } from '@/components/vault/AprBreakdown';
import { DepositModal } from '@/components/deposit/DepositModal';
import { ClaimModal } from '@/components/rewards/ClaimModal';
import { Welcome } from '@/components/layout/Welcome';
import { SkyScene } from '@/components/brand/SkyScene';
import { RangeMeter } from '@/components/vault/RangeMeter';


export function Markets() {
  const tvlDelta = useStore((s) => s.user.tvlDelta);
  const d = useUserDerived();
  const [q, setQ] = useState('');
  const [chain, setChain] = useState<ChainId | 'all'>('all');
  const [sort, setSort] = useState<{ key: 'tvl' | 'apr'; dir: 'asc' | 'desc' }>({ key: 'tvl', dir: 'desc' });
  const toggleSort = (key: 'tvl' | 'apr') => setSort((s) => (s.key === key ? { key, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' }));
  const [params, setParams] = useSearchParams();
  const depositVault = VAULT_BY_ID[params.get('deposit') ?? ''] ?? null;
  const claimOpen = params.get('claim') === '1';
  const rows = useMemo(
    () =>
      VAULTS.filter((v) => chain === 'all' || v.chain === chain)
        .filter((v) => `${vaultName(v)} ${CHAINS[v.chain].name}`.toLowerCase().replace(/\s/g, '').includes(q.toLowerCase().replace(/\s/g, '')))
        .map((v) => ({ v, tvl: m.effectiveTvl(v, tvlDelta), apr: m.aprBreakdown(v, m.effectiveTvl(v, tvlDelta)).totalApr }))
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
  const cols = showMine ? COLS_MINE : COLS;

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
              <div className="display num !font-light text-[clamp(48px,6vw,80px)] leading-none tracking-[-0.02em]">{fmtUsd(d.depositsUsd, { compact: false })}</div>
            </>
          ) : (
            <Welcome />
          )}
        </div>
        <div className="wrap relative z-[4] py-6 sm:absolute sm:inset-x-0 sm:bottom-0">
          {showMine ? (
            <StatRow cols={2} packed rule={false}>
              <Stat label="Fees earned" value={`+${fmtUsd(totalFees, { compact: false, cents: true })}`} tone="success" />
              <Stat label="PMG rewards" value={`${fmtToken(d.pendingTide, 2)} PMG`} tone="accent" sub={<>≈ {fmtUsd(d.pendingTide * CONSTANTS.TIDE_PRICE, { compact: false, cents: true })}</>} />
            </StatRow>
          ) : (
            <StatRow cols={2} packed rule={false}>
              <Stat label="Total TVL" value={fmtUsd(m.totalTvl(VAULTS, tvlDelta))} />
              <Stat label="Fees earned (24h)" value={fmtUsd(m.dailyFees(VAULTS, tvlDelta), { compact: false })} />
            </StatRow>
          )}
        </div>
      </section>

      {/* The plaza: every vault as an instrument */}
      <div className="wrap pt-[52px] pb-[120px]">
        <div className="mb-[22px] flex flex-wrap items-end justify-between gap-x-7 gap-y-[18px]">
          <div className="flex flex-wrap items-baseline gap-x-3.5 gap-y-2">
            <h1 className="title text-[clamp(32px,3.6vw,46px)]">Vaults</h1>
            <span className="text-sm text-weaker num">{rows.length} of {VAULTS.length} vaults</span>
          </div>
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

        <div className={cx('eyebrow hidden items-center gap-x-6 border-b border-stroke-strong px-4 pb-2.5 md:grid', cols)}>
          <span>Vault</span>
          <span>Price within its range</span>
          <span className="justify-self-end"><SortHead label="APR" active={sort.key === 'apr'} dir={sort.dir} onClick={() => toggleSort('apr')} /></span>
          <span className="justify-self-end"><SortHead label="TVL" active={sort.key === 'tvl'} dir={sort.dir} onClick={() => toggleSort('tvl')} /></span>
          {showMine && <span className="justify-self-end">My deposit</span>}
          <span />
        </div>
        <div className="eyebrow flex justify-end gap-[18px] px-3 md:hidden">
          <SortHead label="APR" active={sort.key === 'apr'} dir={sort.dir} onClick={() => toggleSort('apr')} />
          <SortHead label="TVL" active={sort.key === 'tvl'} dir={sort.dir} onClick={() => toggleSort('tvl')} />
        </div>
        <ul>
          {rows.map(({ v, tvl }) => (
            <VaultRow key={v.id} vault={v} tvl={tvl} market={market} showMine={showMine} cols={cols} onDeposit={() => setParams({ deposit: v.id })} />
          ))}
          {rows.length === 0 && (
            <li className="border-b border-stroke-weak py-12 text-center text-weaker">No vaults match{q ? ` "${q}"` : ''}{chain !== 'all' ? ` on ${CHAINS[chain].name}` : ''}.</li>
          )}
        </ul>
      </div>
      <DepositModal vault={depositVault} onClose={() => setParams({})} />
      <ClaimModal open={claimOpen} onClose={() => setParams({})} />
    </div>
  );
}

// Columns: vault, its range, APR, TVL, (my deposit), action
const COLS = 'md:grid-cols-[minmax(190px,1.15fr)_minmax(220px,1.7fr)_96px_92px_104px]';
const COLS_MINE = 'md:grid-cols-[minmax(170px,1.1fr)_minmax(200px,1.5fr)_88px_84px_110px_96px] lg:grid-cols-[minmax(190px,1.15fr)_minmax(220px,1.7fr)_96px_92px_118px_104px]';

function VaultRow({ vault: v, tvl, market, showMine, cols, onDeposit }: { vault: Vault; tvl: number; market: MarketStatus; showMine: boolean; cols: string; onDeposit: () => void }) {
  const navigate = useNavigate();
  const { breakdown: b } = useVaultApr(v);
  const position = useStore((s) => s.user.positions[v.id]);
  const [hover, setHover] = useState(false);
  const aprCell = useRef<HTMLDivElement>(null);
  const [pop, setPop] = useState<{ top: number; right: number } | null>(null);
  const onEnter = () => {
    const r = aprCell.current?.getBoundingClientRect();
    if (r) setPop({ top: r.bottom + 4, right: window.innerWidth - r.right });
    setHover(true);
  };
  const label = 'mr-1.5 text-xs font-normal text-weaker md:hidden';

  return (
    <li
      className={cx(
        'grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-2 border-b border-stroke-weak px-3 py-4 md:px-4 transition-colors duration-300 ease-dusk hover:bg-strong/[0.035]',
        "[grid-template-areas:'pair_apr''meter_meter''tvl_act''mine_act'] md:[grid-template-areas:none]",
        cols,
      )}
      onClick={() => navigate(`/vault/${v.id}`)}
    >
      <div className="flex min-w-0 items-center gap-3.5 [grid-area:pair] md:[grid-area:auto]">
        <TokenPair a={v.token0} b={v.token1} size={26} chain={v.chain} />
        <div className="min-w-0 font-serif text-[23px] font-light leading-[1.1] text-strong md:whitespace-nowrap">{vaultName(v)}</div>
      </div>
      <div className="min-w-0 [grid-area:meter] md:[grid-area:auto]"><RangeMeter vault={v} market={market} /></div>
      <div ref={aprCell} className="justify-self-end whitespace-nowrap [grid-area:apr] md:[grid-area:auto]" onMouseEnter={onEnter} onMouseLeave={() => setHover(false)}>
        <BoostedApr value={fmtPct(b.totalApr)} className="display num text-xl" />
        {hover &&
          pop &&
          createPortal(
            <div
              className="fixed z-40 w-72 bg-background-popover border border-stroke-strong rounded-md shadow-pop p-3 text-left animate-fade-in"
              style={{ top: pop.top, right: pop.right }}
              onClick={(e) => e.stopPropagation()}
            >
              <AprBreakdown vault={v} compact />
            </div>,
            document.body,
          )}
      </div>
      <div className="num text-md text-weak [grid-area:tvl] md:justify-self-end md:[grid-area:auto]"><span className={label}>TVL</span>{fmtUsd(tvl)}</div>
      {showMine && (
        <div className="num grid gap-px [grid-area:mine] md:justify-items-end md:[grid-area:auto]">
          {position ? (
            <>
              <span className="text-strong"><span className={label}>My deposit</span>{fmtUsd(m.positionValue(position, v), { compact: false })}</span>
              <small className="text-xs text-success">+{fmtUsd(m.feesEarned(m.positionValue(position, v), v.feeApr7d, position.depositedAt, Date.now()), { compact: false, cents: true })} fees</small>
            </>
          ) : (
            <span className="text-weaker"><span className={label}>My deposit</span>—</span>
          )}
        </div>
      )}
      <div className="justify-self-end self-center [grid-area:act] md:[grid-area:auto]">
        <Button size="sm" onClick={(e) => { e.stopPropagation(); onDeposit(); }}>
          Deposit
        </Button>
      </div>
    </li>
  );
}

function SortHead({ label, active, dir, onClick }: { label: string; active: boolean; dir: 'asc' | 'desc'; onClick: () => void }) {
  return (
    <button onClick={onClick} className={cx('inline-flex items-center gap-[5px] uppercase tracking-label hover:text-strong', active && 'text-strong')} aria-sort={active ? (dir === 'desc' ? 'descending' : 'ascending') : 'none'}>
      {label}
      <span aria-hidden>{active ? (dir === 'desc' ? '↓' : '↑') : '↕'}</span>
    </button>
  );
}
