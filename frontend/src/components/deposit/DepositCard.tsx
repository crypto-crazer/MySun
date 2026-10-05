import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Vault } from '@/lib/types';
import { STABLE, TOKEN_PRICES, vaultName } from '@/demo/data/vaults';
import { CONSTANTS } from '@/demo/constants';
import * as m from '@/demo/math';
import { useStore } from '@/store/useStore';
import { useVaultApr } from '@/store/selectors';
import { cx, fmtPct, fmtToken, fmtUsd } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { SlidingKey } from '@/components/ui/SlidingKey';
import { TokenIcon, TokenPair } from '@/components/ui/TokenIcon';
import { useConnectWallet } from '@/chain/useConnectWallet';

const TX_DELAY = 1500;
type Tab = 'deposit' | 'withdraw';
const DUAL = '__dual__';

interface Props {
  vault: Vault;
  initialAmount?: string;
  /** Name the vault and link to its page. On for the overlay; off on the vault page, which already says so. */
  showVaultLink?: boolean;
}

export function DepositCard({ vault: v, initialAmount, showVaultLink = true }: Props) {
  const [tab, setTab] = useState<Tab>('deposit');

  return (
    <div className="w-full max-w-[440px] mx-auto lg:max-w-none">
      <div className="grid gap-4 rounded-lg border border-stroke-strong bg-background-elevated px-[18px] pb-[18px]">
        <div className="relative -mx-[18px] grid grid-cols-2 border-b border-stroke-strong" role="tablist">
          <span
            aria-hidden
            className={cx(
              'pointer-events-none absolute -bottom-px left-0 h-0.5 w-1/2 transition-transform duration-300 ease-dusk',
              tab === 'withdraw' && 'translate-x-full',
            )}
          >
            <span className="absolute inset-y-0 inset-x-[18px] bg-strong" />
          </span>
          {(['deposit', 'withdraw'] as Tab[]).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={cx(
                'relative py-[13px] text-base transition-colors duration-300 ease-dusk',
                tab === t ? 'text-strong' : 'text-weaker hover:text-weak',
              )}
            >
              {t === 'deposit' ? 'Deposit' : 'Withdraw'}
            </button>
          ))}
        </div>

        {showVaultLink && (
          <div className="flex items-center gap-3">
            <TokenPair a={v.token0} b={v.token1} size={26} chain={v.chain} />
            <span className="min-w-0 flex-1 font-serif text-xl font-light leading-tight text-strong">{vaultName(v)}</span>
            <Link to={`/vault/${v.id}`} className="shrink-0 text-xs text-weaker hover:text-strong">View vault →</Link>
          </div>
        )}

        <div key={`${v.id}-${tab}`} className="animate-[vault-tab-in_200ms_ease-out]">
          {tab === 'deposit' ? <DepositForm vault={v} initialAmount={initialAmount} /> : <WithdrawForm vault={v} />}
        </div>
      </div>
    </div>
  );
}

// ───────────────────────── shared bits ─────────────────────────

function Chevron({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={cx('h-4 w-4 text-weaker shrink-0', className)} fill="none" aria-hidden>
      <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="eyebrow mb-2">{label}</div>
      {children}
    </div>
  );
}

/** Amount box — the one thing the user touches. Token is shown, not chosen here. */
function AmountBox({
  value, onChange, tokenLabel, tokenIcon, balance, connected, usd, autoFocus, error,
}: {
  value: string; onChange: (s: string) => void; tokenLabel: string; tokenIcon?: React.ReactNode;
  balance?: number; connected: boolean; usd?: number; autoFocus?: boolean; error?: boolean;
}) {
  return (
    <div className={cx('well grid gap-1.5 pb-2.5 pl-3.5 pr-3.5 pt-3 ring-inset', error ? 'ring-1 ring-stroke-error/60' : 'focus-within:ring-1 focus-within:ring-stroke-focused')}>
      <div className="flex items-center gap-2.5">
        <input
          type="number"
          inputMode="decimal"
          min={0}
          step="any"
          autoFocus={autoFocus}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="0"
          className="w-0 min-w-0 flex-1 bg-transparent display text-[30px] leading-[1.15] num text-strong placeholder:text-weaker outline-none focus-visible:outline-none"
        />
        <span className="inline-flex items-center gap-2 whitespace-nowrap text-sm font-medium">
          {tokenIcon}
          {tokenLabel}
        </span>
      </div>
      <div className="flex items-center justify-between gap-2 text-xs num">
        <span className="text-weaker">{usd !== undefined && usd > 0 ? `≈ ${fmtUsd(usd, { compact: false, cents: true })}` : ''}</span>
        {connected && balance !== undefined && (
          <span className="text-weaker">
            Balance {fmtToken(balance)}
            <button onClick={() => onChange(String(balance))} className="ml-1.5 font-bold text-strong hover:text-accent-bright">Max</button>
          </span>
        )}
      </div>
    </div>
  );
}

/** The tokens a vault takes and pays out: the dollar token, each side of the pair, then both sides together. */
function useTokenOptions(v: Vault) {
  return useMemo(() => {
    const singles = Array.from(new Set([STABLE, v.token0, v.token1])).map((t) => ({ id: t, label: t, name: t, icon: <TokenIcon symbol={t} size={18} /> }));
    return [...singles, { id: DUAL, label: 'Both', name: `${v.token0} + ${v.token1}`, icon: <TokenPair a={v.token0} b={v.token1} size={18} /> }];
  }, [v]);
}

/**
 * Visible choice of what to pay with or receive — single tokens or both, each with its logo.
 * One groove across the card with equal columns, so three or four options always share a row.
 * The options sit in the recess; the chosen one is raised out of it as a glass key.
 */
function TokenChoice({ options, value, onChange }: { options: Array<{ id: string; label: string; name: string; icon: React.ReactNode }>; value: string; onChange: (id: string) => void }) {
  const track = useRef<HTMLDivElement>(null);
  return (
    <div ref={track} className="well groove grid w-full" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      <SlidingKey track={track} chosen='[aria-pressed="true"]' tone="glass" />
      {options.map((o) => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          aria-pressed={value === o.id}
          title={o.name === o.label ? undefined : o.name}
          className={cx(
            'inline-flex h-9 items-center justify-center gap-1.5 whitespace-nowrap text-sm font-medium transition-colors duration-300 ease-dusk',
            value === o.id ? 'text-strong' : 'text-weak hover:text-strong',
          )}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ───────────────────────── Deposit ─────────────────────────

function DepositForm({ vault: v, initialAmount }: { vault: Vault; initialAmount?: string }) {
  const connected = useStore((s) => s.connected);
  const { connectWallet: connect, isPending: connecting } = useConnectWallet();
  const balances = useStore((s) => s.user.balances);
  const degenAck = useStore((s) => s.user.degenAcknowledged);
  const acknowledgeDegen = useStore((s) => s.acknowledgeDegen);
  const deposit = useStore((s) => s.deposit);
  const pushToast = useStore((s) => s.pushToast);
  const { tvl, breakdown: b } = useVaultApr(v);
  const apr = b.totalApr;

  const [asset, setAsset] = useState(STABLE);
  const [amount, setAmount] = useState(initialAmount ?? '');
  const [amount1, setAmount1] = useState('');
  const [details, setDetails] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [degenOpen, setDegenOpen] = useState(false);
  const [ack, setAck] = useState(false);

  const bal = (t: string) => balances[t] ?? 0;
  const payOptions = useTokenOptions(v);
  const isDual = asset === DUAL;
  const amt = Number(amount) || 0;
  const amt1 = Number(amount1) || 0;

  const preview = useMemo(() => {
    if (isDual) return amt + amt1 > 0 ? m.dualPreview(v, amt, amt1, TOKEN_PRICES) : null;
    return amt > 0 ? m.zapPreview(v, tvl, asset, amt, TOKEN_PRICES) : null;
  }, [isDual, amt, amt1, v, tvl, asset]);

  const insufficientToken = isDual ? (amt > bal(v.token0) ? v.token0 : amt1 > bal(v.token1) ? v.token1 : null) : amt > bal(asset) ? asset : null;
  const insufficient = connected && !!insufficientToken;
  const monthly = preview ? (preview.netUsd * apr) / 12 : 0;

  const doDeposit = async () => {
    if (!preview) return;
    setBusy(true);
    await new Promise((r) => setTimeout(r, TX_DELAY));
    const spend = isDual ? [{ token: v.token0, amount: amt }, { token: v.token1, amount: amt1 }] : [{ token: asset, amount: amt }];
    deposit({ vaultId: v.id, preview, stake: true, spend });
    setBusy(false);
    setAmount('');
    setAmount1('');
    setDone(true);
    setTimeout(() => setDone(false), 2200);
    const what = isDual ? `${fmtToken(amt)} ${v.token0} + ${fmtToken(amt1)} ${v.token1}` : `${fmtToken(amt)} ${asset}`;
    pushToast({ title: 'Deposit confirmed', detail: `${what} into ${vaultName(v)} · earning ${fmtPct(apr)} APR`, tone: 'success' });
  };

  const onSubmit = () => {
    if (!connected) return void connect();
    if (v.tier === 'Degen' && !degenAck) return setDegenOpen(true);
    void doDeposit();
  };

  // Button state machine — the button is the guidance.
  let cta: { label: string; disabled: boolean; variant?: 'primary' | 'secondary' } = { label: 'Deposit', disabled: true };
  if (busy) cta = { label: 'Confirming…', disabled: true };
  else if (done) cta = { label: 'Deposited ✓', disabled: true };
  else if (!connected) cta = { label: 'Connect wallet', disabled: false };
  else if (!preview || preview.netUsd <= 0) cta = { label: 'Enter an amount', disabled: true };
  else if (insufficient) cta = { label: `Insufficient ${insufficientToken}`, disabled: true };
  else cta = { label: isDual ? `Deposit ${v.token0} + ${v.token1}` : `Deposit ${fmtToken(amt)} ${asset}`, disabled: false };

  return (
    <div className="grid gap-4">
      <Field label="Pay with">
        <TokenChoice options={payOptions} value={asset} onChange={(id) => { setAsset(id); setAmount(''); setAmount1(''); }} />
      </Field>

      <Field label="Amount">
        {isDual ? (
          <div className="space-y-2">
            <AmountBox value={amount} onChange={setAmount} tokenLabel={v.token0} tokenIcon={<TokenIcon symbol={v.token0} size={20} />} balance={bal(v.token0)} connected={connected} usd={amt * TOKEN_PRICES[v.token0]} autoFocus error={connected && amt > bal(v.token0)} />
            <AmountBox value={amount1} onChange={setAmount1} tokenLabel={v.token1} tokenIcon={<TokenIcon symbol={v.token1} size={20} />} balance={bal(v.token1)} connected={connected} usd={amt1 * TOKEN_PRICES[v.token1]} error={connected && amt1 > bal(v.token1)} />
          </div>
        ) : (
          <AmountBox value={amount} onChange={setAmount} tokenLabel={asset} tokenIcon={<TokenIcon symbol={asset} size={20} />} balance={bal(asset)} connected={connected} usd={preview?.inputUsd} autoFocus error={insufficient} />
        )}
      </Field>

      <Field label="You receive">
        <div className="grid gap-1.5 border-t border-stroke-strong pt-3 num">
          <div className="flex items-baseline justify-between gap-2.5">
            <span className={cx('display num truncate text-[26px] leading-8', preview ? 'text-strong' : 'text-weaker')}>
              {preview ? fmtToken(preview.tdlp, 1) : '0'} <span className="ml-0.5 text-sm font-normal text-weak">{v.receiptSymbol}</span>
            </span>
            {preview && <span className="text-xs text-weaker shrink-0">≈ {fmtUsd(preview.netUsd, { compact: false, cents: true })}</span>}
          </div>
          <div className="flex items-center justify-between gap-2.5 text-xs text-weaker">
            <span className={preview ? 'text-success' : undefined}>{preview ? `Earning ~${fmtUsd(monthly, { compact: false, cents: monthly < 100 })} / month` : 'Earning'}</span>
            <span>at {fmtPct(apr)} APR</span>
          </div>
        </div>
      </Field>

      <Button block onClick={onSubmit} disabled={cta.disabled} loading={busy || connecting}>{cta.label}</Button>

      <div className="text-xs num">
        <button onClick={() => setDetails(!details)} aria-expanded={details} className="w-full flex items-center justify-between gap-2.5 py-0.5 text-left text-weaker hover:text-weak">
          <span>
            1 {v.receiptSymbol} = ${v.pricePerShare.toFixed(4)}
            {preview && !isDual && <> · {fmtPct(preview.priceImpact, 2)} impact</>}
          </span>
          <Chevron className={cx('transition-transform', details && 'rotate-180')} />
        </button>
        {details && (
          <dl className="mt-1.5 grid animate-fade-in">
            {preview && !isDual && (
              <>
                <Row k="Auto-swap" v={preview.legs.map((l) => `${fmtToken(l.amount)} ${l.token}`).join(' + ')} />
                <Row k="Price impact" v={fmtPct(preview.priceImpact, 2)} />
                <Row k="Swap fee" v={`~${fmtUsd(preview.swapFeeUsd, { compact: false, cents: true })}`} />
              </>
            )}
            <Row k="Performance fee" v={`${fmtPct(CONSTANTS.PERFORMANCE_FEE, 0)} of earnings`} />
            <Row k="Withdrawal fee" v={fmtPct(CONSTANTS.WITHDRAWAL_FEE)} />
            <Row k="Lock-up" v="None · redeem anytime" />
          </dl>
        )}
        <p className="mt-3 text-xs leading-normal text-weaker">LP positions can lose value and may underperform holding the assets. Review the vault strategy, fees and risks before depositing.</p>
      </div>

      <Modal
        open={degenOpen}
        onClose={() => setDegenOpen(false)}
        title="High-risk vault"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDegenOpen(false)}>Cancel</Button>
            <Button disabled={!ack} onClick={() => { acknowledgeDegen(); setDegenOpen(false); void doDeposit(); }}>I understand, deposit</Button>
          </>
        }
      >
        <p>Degen vaults run narrow, high-frequency ranges on volatile pairs. Higher fees, higher impermanent loss risk. Net value can underperform holding.</p>
        <label className="mt-4 flex items-start gap-2.5 cursor-pointer text-strong">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5 accent-fill-accent" />
          <span className="text-sm">I understand this vault can lose value versus holding the underlying tokens.</span>
        </label>
      </Modal>
    </div>
  );
}

// ───────────────────────── Withdraw ─────────────────────────

function WithdrawForm({ vault: v }: { vault: Vault }) {
  const connected = useStore((s) => s.connected);
  const { connectWallet: connect, isPending: connecting } = useConnectWallet();
  const position = useStore((s) => s.user.positions[v.id]);
  const withdraw = useStore((s) => s.withdraw);
  const pushToast = useStore((s) => s.pushToast);
  const [amount, setAmount] = useState('');
  const [asset, setAsset] = useState(STABLE);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const receiveOptions = useTokenOptions(v);
  const total = m.positionTdlp(position);
  const amt = Number(amount) || 0;
  const preview = amt > 0 ? m.withdrawPreview(v, amt, asset === DUAL ? 'both' : asset, TOKEN_PRICES) : null;
  const insufficient = connected && amt > total + 1e-9;

  const submit = async () => {
    if (!connected) return void connect();
    if (!preview) return;
    setBusy(true);
    await new Promise((r) => setTimeout(r, TX_DELAY));
    withdraw({ vaultId: v.id, preview });
    setBusy(false);
    setAmount('');
    setDone(true);
    setTimeout(() => setDone(false), 2200);
    pushToast({ title: 'Withdrawal confirmed', detail: `Received ${preview.outputs.map((o) => `${fmtToken(o.amount)} ${o.token}`).join(' + ')}`, tone: 'success' });
  };

  let cta = { label: 'Withdraw', disabled: true };
  if (busy) cta = { label: 'Confirming…', disabled: true };
  else if (done) cta = { label: 'Withdrawn ✓', disabled: true };
  else if (!connected) cta = { label: 'Connect wallet', disabled: false };
  else if (total <= 0) cta = { label: 'Nothing to withdraw', disabled: true };
  else if (!preview) cta = { label: 'Enter an amount', disabled: true };
  else if (insufficient) cta = { label: `Insufficient ${v.receiptSymbol}`, disabled: true };
  else cta = { label: 'Withdraw', disabled: false };

  return (
    <div className="grid gap-4">
      <Field label="Receive in">
        <TokenChoice options={receiveOptions} value={asset} onChange={setAsset} />
      </Field>
      <Field label="Amount">
        <AmountBox value={amount} onChange={setAmount} tokenLabel={v.receiptSymbol} tokenIcon={<TokenPair a={v.token0} b={v.token1} size={18} />} balance={connected ? total : undefined} connected={connected} usd={amt * v.pricePerShare} error={insufficient} />
      </Field>
      <Field label="Receive">
        <div className="grid gap-1.5 border-t border-stroke-strong pt-3 num">
          <div className="display num text-[22px] leading-8 text-strong">
            {preview ? preview.outputs.map((o) => `${fmtToken(o.amount)} ${o.token}`).join(' + ') : <span className="text-weaker">0</span>}
          </div>
          <div className="text-xs text-weaker">{preview ? `${fmtUsd(preview.netUsd, { compact: false, cents: true })} after ${fmtPct(CONSTANTS.WITHDRAWAL_FEE)} fee` : 'No lock-up. Redeem anytime.'}</div>
        </div>
      </Field>
      <Button block variant="secondary" onClick={submit} disabled={cta.disabled} loading={busy || connecting}>{cta.label}</Button>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-2.5 py-[5px]">
      <dt className="text-weaker">{k}</dt>
      <dd className="text-right text-strong">{v}</dd>
    </div>
  );
}
