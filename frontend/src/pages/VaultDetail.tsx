import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { VAULT_BY_ID, TIER_CAPACITY, vaultName } from '@/demo/data/vaults';
import { fmtDate, fmtPct, fmtToken, fmtUsd, cx } from '@/lib/format';
import * as m from '@/demo/math';
import { useStore } from '@/store/useStore';
import { useMarketStatus, useVaultApr } from '@/store/selectors';
import { TokenPair } from '@/components/ui/TokenIcon';
import { Stat, StatRow } from '@/components/ui/Stat';
import { PriceRange } from '@/components/vault/PriceRange';
import { AprBreakdown } from '@/components/vault/AprBreakdown';
import { NavChart } from '@/components/vault/NavChart';
import { DepositCard } from '@/components/deposit/DepositCard';
import type { Vault } from '@/lib/types';
import { CONSTANTS } from '@/demo/constants';
import { useUserDerived } from '@/store/selectors';
import { Button } from '@/components/ui/Button';
import { Tooltip } from '@/components/ui/Tooltip';
import { BoostedApr } from '@/components/ui/BoostedApr';
import { ClaimModal } from '@/components/rewards/ClaimModal';

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
  const [params, setParams] = useSearchParams();
  const { tvl, breakdown: b } = useVaultApr(v);
  const cap = TIER_CAPACITY[v.tier];
  const [aprHover, setAprHover] = useState(false);

  return (
    <div className="wrap pt-[26px] pb-[120px]">
      <div className="grid items-start gap-x-10 gap-y-10 lg:grid-cols-[minmax(0,1fr)_384px]">
        <header className="grid gap-6 lg:col-start-1">
          <Link to="/" className="group -my-1.5 inline-flex items-center gap-3 justify-self-start py-1.5 text-md text-weak transition-colors duration-300 ease-dusk hover:text-strong">
            {/* Drawn, not typed: a long hairline shaft with a small head, which the typeface's own arrow is not. */}
            <svg viewBox="0 0 28 12" className="h-3 w-7 shrink-0 transition-transform duration-300 ease-dusk group-hover:-translate-x-1" fill="none" aria-hidden>
              <path d="M27 6H1.5M6 1.5 1.5 6 6 10.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            All vaults
          </Link>
          <div className="flex flex-wrap items-center gap-[18px]">
            <TokenPair a={v.token0} b={v.token1} size={36} chain={v.chain} />
            <h1 className="title font-thin text-[clamp(38px,4.4vw,60px)]">{vaultName(v)}</h1>
          </div>
          <StatRow cols={3}>
            <Stat label="TVL" value={fmtUsd(tvl)} />
            <div className="cursor-help" onMouseEnter={() => setAprHover(true)} onMouseLeave={() => setAprHover(false)}>
              <Stat label="APR" value={<BoostedApr value={fmtPct(b.totalApr)} />} />
              {aprHover && (
                <div className="absolute left-0 top-full mt-1 z-40 w-72 bg-background-popover border border-stroke-strong rounded-md shadow-pop p-3 animate-fade-in">
                  <AprBreakdown vault={v} compact />
                </div>
              )}
            </div>
            <Stat label="Capacity" value={`${fmtUsd(tvl)} / ${cap / 1_000_000}M`} />
          </StatRow>
        </header>

        <aside className="grid gap-3.5 lg:sticky lg:top-20 lg:col-start-2 lg:row-span-3 lg:row-start-1">
          <YourPosition vault={v} tvl={tvl} onClaim={() => setParams({ claim: '1' })} />
          <DepositCard key={v.id} vault={v} showVaultLink={false} />
        </aside>

        <PriceRange vault={v} market={market} className="min-w-0 lg:col-start-1" />
        <NavChart vault={v} className="min-w-0 lg:col-start-1" />
      </div>
      <ClaimModal open={params.get('claim') === '1'} onClose={() => setParams({})} />
    </div>
  );
}

function YourPosition({ vault: v, tvl, onClaim }: { vault: Vault; tvl: number; onClaim: () => void }) {
  const connected = useStore((s) => s.connected);
  const p = useStore((s) => s.user.positions[v.id]);
  const d = useUserDerived();
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
        <Row label="Your APR" value={fmtPct(b.totalApr)} tip={`${fmtPct(b.feeApr)} from fees + ${fmtPct(b.tideApr)} in PMG`} />
        <Row label="PMG rewards" value={`${fmtToken(d.pendingTide, 1)} PMG`} tone="text-accent" tip={`≈ ${fmtUsd(d.pendingTide * CONSTANTS.TIDE_PRICE, { compact: false, cents: true })} across all your vaults`} />
      </dl>
      <Button block variant="accent" onClick={onClaim} disabled={d.pendingTide < 0.005}>
        {d.pendingTide < 0.005 ? 'No rewards to claim yet' : `Claim ${fmtToken(d.pendingTide, 1)} PMG`}
      </Button>
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
