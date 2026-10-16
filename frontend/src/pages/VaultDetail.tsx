import { Link, useParams } from 'react-router-dom';
import { VAULT_BY_ID, TIER_CAPACITY, poolLabel, vaultName } from '@/demo/data/vaults';
import { fmtDate, fmtPct, fmtToken, fmtUsd, cx } from '@/lib/format';
import * as m from '@/demo/math';
import { useStore } from '@/store/useStore';
import { useMarketStatus, useVaultApr } from '@/store/selectors';
import { TokenPair } from '@/components/ui/TokenIcon';
import { Stat, StatRow } from '@/components/ui/Stat';
import { PriceRange } from '@/components/vault/PriceRange';
import { NavChart } from '@/components/vault/NavChart';
import { DepositCard } from '@/components/deposit/DepositCard';
import type { Vault } from '@/lib/types';
import { Tooltip } from '@/components/ui/Tooltip';

export function VaultDetail() {
  const { id = '' } = useParams();
  const v = VAULT_BY_ID[id];
  const market = useMarketStatus();
  if (!v) {
    return (
      <div className="text-sm text-weaker">
        Vault not found. <Link to="/" className="text-strong">Back to markets</Link>
      </div>
    );
  }
  return <VaultView vaultId={v.id} market={market} />;
}

function VaultView({ vaultId, market }: { vaultId: string; market: 'open' | 'closed' }) {
  const v = VAULT_BY_ID[vaultId];
  const { tvl, breakdown: b } = useVaultApr(v);
  const cap = TIER_CAPACITY[v.tier];

  return (
    <div className="wrap pt-[26px] pb-[120px]">
      <div className="grid items-start gap-x-10 gap-y-10 lg:grid-cols-[minmax(0,1fr)_384px]">
        <header className="grid gap-6 lg:col-start-1">
          <Link to="/" className="group -my-1.5 inline-flex items-center gap-3 justify-self-start py-1.5 text-md text-weak transition-colors duration-300 ease-dusk hover:text-strong">
            {/* BoxIcons arrow-back (react-icons BiArrowBack), filled with the link's colour so it follows the hover. */}
            <svg width="20" height="20" viewBox="0 0 24 24" className="shrink-0 transition-transform duration-300 ease-dusk group-hover:-translate-x-1" fill="currentColor" aria-hidden>
              <path d="M21 11H6.414l5.293-5.293-1.414-1.414L2.586 12l7.707 7.707 1.414-1.414L6.414 13H21z" />
            </svg>
            All vaults
          </Link>
          {/* The 36px pair is centred on the name's line (line-height 1), not on the name and pool line together */}
          <div className="flex flex-wrap items-start gap-[18px] [--name:clamp(38px,4.4vw,60px)]">
            <span className="flex shrink-0 mt-[calc((var(--name)-36px)/2)]"><TokenPair a={v.token0} b={v.token1} size={36} chain={v.chain} /></span>
            <div>
              <h1 className="title !font-normal text-[length:var(--name)]">{vaultName(v)}</h1>
              <p className="num mt-2 text-sm text-weak">{poolLabel(v)}</p>
            </div>
          </div>
          <StatRow cols={3}>
            <Stat label="TVL" value={fmtUsd(tvl)} />
            {/* The fee APR alone: PMG rewards are not counted while nothing on screen shows or pays them */}
            <Stat label="APR" value={fmtPct(b.feeApr)} />
            <Stat label="Capacity" value={`${fmtUsd(tvl)} / ${cap / 1_000_000}M`} />
          </StatRow>
        </header>

        <aside className="grid gap-3.5 lg:sticky lg:top-20 lg:col-start-2 lg:row-span-3 lg:row-start-1">
          <YourPosition vault={v} tvl={tvl} />
          <DepositCard key={v.id} vault={v} showVaultLink={false} />
        </aside>

        <PriceRange vault={v} market={market} className="min-w-0 lg:col-start-1" />
        <NavChart vault={v} className="min-w-0 lg:col-start-1" />
      </div>
    </div>
  );
}

function YourPosition({ vault: v, tvl }: { vault: Vault; tvl: number }) {
  const connected = useStore((s) => s.connected);
  const p = useStore((s) => s.user.positions[v.id]);
  if (!connected || !p) return null;
  const value = m.positionValue(p, v);
  const fees = m.feesEarned(value, v.feeApr7d, p.depositedAt, Date.now());
  const b = m.aprBreakdown(v, tvl);
  return (
    <section className="grid gap-3 rounded-lg border border-stroke-strong bg-background-elevated px-[18px] pb-[18px] pt-4">
      <h2 className="eyebrow">Your position</h2>
      <Tooltip content={`${fmtToken(m.positionTdlp(p), 1)} ${v.receiptSymbol} · deposited ${fmtDate(p.depositedAt)}`} align="start" side="bottom" wide>
        <div className="display num cursor-help text-[34px] leading-none tracking-[-0.015em]">{fmtUsd(value, { compact: false, cents: true })}</div>
      </Tooltip>
      <dl className="num text-sm">
        <Row label="Fees earned" value={`+${fmtUsd(fees, { compact: false, cents: true })}`} tone="text-success" tip={`Fees compound into your ${v.receiptSymbol} automatically. Nothing to claim.`} />
        <Row label="Your APR" value={fmtPct(b.feeApr)} tip="From trading fees: the 7-day average, annualised." />
      </dl>
    </section>
  );
}

function Row({ label, value, tone, tip }: { label: string; value: string; tone?: string; tip: string }) {
  return (
    <Tooltip content={tip} align="start" side="bottom" wide className="flex w-full">
      <div className="flex w-full cursor-help justify-between gap-2.5 border-t border-stroke-weak py-[7px]">
        <dt className="text-weaker">{label}</dt>
        <dd className={cx(tone ?? 'text-strong')}>{value}</dd>
      </div>
    </Tooltip>
  );
}
