/**
 * In-kind deposit against the deployed vault.
 *
 * The flow the contract actually implements: offer a MAX amount per basket token → `previewDeposit`
 * returns the shares that are computable and the exact amount that would be pulled per token →
 * approve only where the allowance is short → `deposit(tokens, amounts, minShares, receiver)`.
 * `minShares` is mandatory and non-zero: it is the depositor's only protection, because the vault
 * prices a deposit from a spot read that can over-price it.
 *
 * Where the chain has a zap-in periphery for this vault, a second facet deposits USDG only
 * (`ZapDepositCard` below) — the same card language, the same connect-first CTA chain.
 */
import { useMemo, useState, type ReactNode } from 'react';
import type { Address } from 'viem';
import { erc20Abi, parseEventLogs } from 'viem';
import { vaultAbi, zapInAbi } from '@/config/generated';
import { useWallet } from '@/wallet/context';
import { waitForReceipt } from '@/chain/client';
import { chainFor, chainLabel } from '@/chain/chains';
import { describeSwitchError } from '@/chain/switchChain';
import { NetworkManual } from './NetworkManual';
import { useSwitchToChain } from '@/chain/useTargetChain';
import { formatAmount, formatAmountSignificant } from '@/chain/amounts';
import {
  DEFAULT_SLIPPAGE_BPS,
  dispatchBasket,
  insufficientBalance,
  minSharesFromPreview,
  parseSlippageBps,
  tokensNeedingApproval,
} from '@/chain/deposit';
import { describeChainError } from '@/chain/errors';
import {
  ZAP_DEFAULT_SLIPPAGE_BPS,
  ZAP_MAX_SLIPPAGE_BPS,
  describeZapError,
  parseZapDepositAmount,
  parseZapSlippage,
  zapInCallAbi,
  zapMinimum,
  zapSizeWarning,
} from '@/chain/zap';
import {
  usePreviewDeposit,
  usePreviewZap,
  useZapAllowance,
  useZapRoutes,
  type LiveVault,
  type TokenMeta,
  type UserBasket,
  type ZapRoute,
} from '@/chain/useVault';
import { Button } from '@/components/ui/Button';
import { Segmented } from '@/components/ui/Tabs';
import { useConnectWallet } from '@/chain/useConnectWallet';
import { useStore } from '@/store/useStore';
import { cx } from '@/lib/format';
import { StepTrail } from './StepTrail';
import { Message } from './Message';
import { LiveAmountInput } from './LiveAmountInput';

type Step = 'form' | 'approving' | 'depositing' | 'done';

/** In kind (every basket token) or the single-asset zap facet. */
export type ZapMode = 'basket' | 'zap';

/** The "In kind / USDG only" switch — shared by the deposit and redeem cards. */
export function ZapModeSwitch({ value, onChange, zapLabel }: { value: ZapMode; onChange: (m: ZapMode) => void; zapLabel: string }) {
  return (
    <Segmented
      size="sm"
      value={value}
      onChange={onChange}
      options={[
        { value: 'basket', label: 'In kind' },
        { value: 'zap', label: zapLabel },
      ]}
    />
  );
}

/**
 * The deposit card. The single-asset facet is offered only when the chain lists a zap-in contract,
 * the zap has this vault registered with routes out of USDG, and a wallet is connected — never on a
 * planned chain or a periphery-less vault (no dead buttons).
 */
export function LiveDepositCard({ vault, user }: { vault: LiveVault; user: UserBasket }) {
  const { address } = useWallet();
  const { zapIn } = useZapRoutes(vault);
  const [mode, setMode] = useState<ZapMode>('basket');
  const route = address ? zapIn : undefined;
  const modeSwitch = route ? <ZapModeSwitch value={mode} onChange={setMode} zapLabel={`${route.token.symbol} only`} /> : null;
  if (route && mode === 'zap') {
    return <ZapDepositCard key={vault.address} vault={vault} user={user} route={route} modeSwitch={modeSwitch} />;
  }
  return <BasketDepositCard vault={vault} user={user} modeSwitch={modeSwitch} />;
}

function BasketDepositCard({ vault, user, modeSwitch }: { vault: LiveVault; user: UserBasket; modeSwitch: ReactNode }) {
  const { address, chainId, write } = useWallet();
  const { connectWallet, isPending: connecting } = useConnectWallet();
  const { switchTo, switching, error: switchError } = useSwitchToChain();
  const pushToast = useStore((s) => s.pushToast);

  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [slippage, setSlippage] = useState(String(DEFAULT_SLIPPAGE_BPS / 100));
  const [step, setStep] = useState<Step>('form');
  const [pendingToken, setPendingToken] = useState<Address | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [minted, setMinted] = useState<bigint | null>(null);

  const offer = useMemo(
    () =>
      dispatchBasket(
        vault.tokens.map((t, i) => ({
          token: t.address,
          decimals: t.decimals,
          input: inputs[t.address] ?? '',
          total: vault.totals[i] ?? 0n,
        })),
      ),
    [vault.tokens, vault.totals, inputs],
  );

  const preview = usePreviewDeposit(vault, offer.tokens, offer.amounts, offer.ready);
  const slip = parseSlippageBps(slippage);
  const bps = slip.ok ? slip.bps : DEFAULT_SLIPPAGE_BPS;
  const minShares = minSharesFromPreview(preview.shares ?? 0n, bps);

  const required = preview.required ?? [];
  const needsApproval = tokensNeedingApproval(offer.tokens, required, user.allowances);
  const short = insufficientBalance(offer.tokens, required, user.balances);
  const errCtx = {
    shareDecimals: vault.decimals,
    shareSymbol: vault.receipt.symbol,
    tokenDecimals: Object.fromEntries(vault.tokens.map((t) => [t.address, t.decimals])),
    tokenSymbols: Object.fromEntries(vault.tokens.map((t) => [t.address, t.symbol])),
  };
  const symbolOf = (a: Address) => vault.tokens.find((t) => t.address === a)?.symbol ?? 'token';

  const wrongChain = Boolean(address) && chainId !== vault.chainId;
  const switchTarget = chainFor(vault.chainId);
  const busy = step === 'approving' || step === 'depositing';

  const refresh = () => {
    vault.refetch();
    user.refetch();
    preview.refetch();
  };

  const approveNext = async () => {
    const token = needsApproval[0];
    if (!token) return;
    const i = offer.tokens.indexOf(token);
    setError(null);
    setStep('approving');
    setPendingToken(token);
    try {
      // Approve the MAX the user offered (≥ what the vault will pull), so a basket that shifts
      // between the preview and the transaction does not strand the deposit on a stale allowance.
      const hash = await write({
        chainId: vault.chainId,
        address: token,
        abi: erc20Abi,
        functionName: 'approve',
        args: [vault.address, offer.amounts[i] ?? 0n],
      });
      await waitForReceipt(vault.chainId, hash);
      user.refetch();
      pushToast({ title: `${symbolOf(token)} approved`, detail: 'The vault may now pull this token.', tone: 'success' });
    } catch (err) {
      setError(describeChainError(err, errCtx));
    } finally {
      setPendingToken(null);
      setStep('form');
    }
  };

  const submit = async () => {
    if (!address || minShares === 0n) return;
    setError(null);
    setStep('depositing');
    try {
      const hash = await write({
        chainId: vault.chainId,
        address: vault.address,
        abi: vaultAbi,
        functionName: 'deposit',
        args: [offer.tokens, offer.amounts, minShares, address],
      });
      const receipt = await waitForReceipt(vault.chainId, hash);
      const events = parseEventLogs({ abi: vaultAbi, logs: receipt.logs, eventName: 'Deposited' });
      const shares = (events[0]?.args as { shares?: bigint } | undefined)?.shares ?? 0n;
      setMinted(shares);
      setStep('done');
      setInputs({});
      refresh();
      pushToast({
        title: 'Deposit confirmed',
        detail: `Minted ${formatAmountSignificant(shares, vault.decimals)} ${vault.receipt.symbol} from ${vault.entry?.label ?? 'the vault'} on ${chainLabel(vault.chainId)}`,
        tone: 'success',
      });
    } catch (err) {
      setError(describeChainError(err, errCtx));
      setStep('form');
    }
  };

  // The button is the guidance — one action at a time, in contract order.
  let cta: { label: string; disabled: boolean; onClick: () => void } = {
    label: 'Deposit',
    disabled: true,
    onClick: () => {},
  };
  if (!address) cta = { label: 'Connect wallet', disabled: false, onClick: connectWallet };
  else if (wrongChain) {
    cta = { label: `Switch to ${chainLabel(vault.chainId)}`, disabled: false, onClick: () => void switchTo(vault.chainId).catch(() => {}) };
  }
  else if (vault.paused) cta = { label: 'Vault is paused', disabled: true, onClick: () => {} };
  else if (Object.keys(offer.errors).length > 0) cta = { label: 'Fix the amounts', disabled: true, onClick: () => {} };
  else if (offer.hasMissingAmount) cta = { label: 'Enter an amount for every token', disabled: true, onClick: () => {} };
  else if (preview.error) cta = { label: 'Deposit not possible', disabled: true, onClick: () => {} };
  else if (preview.shares === undefined) cta = { label: 'Previewing…', disabled: true, onClick: () => {} };
  else if (short) cta = { label: `Insufficient ${symbolOf(short)}`, disabled: true, onClick: () => {} };
  else if (!slip.ok) cta = { label: 'Fix the slippage tolerance', disabled: true, onClick: () => {} };
  else if (needsApproval.length > 0) {
    cta = { label: `Approve ${symbolOf(needsApproval[0])}`, disabled: false, onClick: () => void approveNext() };
  } else cta = { label: `Deposit ${vault.tokens.length} tokens`, disabled: false, onClick: () => void submit() };

  const previewError = preview.error ? describeChainError(preview.error, errCtx) : null;

  return (
    <section className="bg-background-elevated border border-stroke-weak rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="display text-sm font-semibold">Deposit in kind</h3>
        <span className="text-2xs text-weaker">Offers are maximums · only what is required is pulled</span>
      </div>

      {modeSwitch}

      <StepTrail
        steps={[
          { label: 'Amounts', state: offer.ready && preview.shares !== undefined ? 'done' : 'active' },
          {
            label: 'Approve',
            state: !offer.ready || preview.shares === undefined ? 'todo' : needsApproval.length === 0 ? 'done' : 'active',
          },
          { label: 'Deposit', state: step === 'done' ? 'done' : step === 'depositing' ? 'active' : 'todo' },
        ]}
      />

      <div className="space-y-2">
        {vault.tokens.map((t, i) => (
          <LiveDepositRow
            key={t.address}
            token={t}
            value={inputs[t.address] ?? ''}
            onChange={(v) => { setInputs((s) => ({ ...s, [t.address]: v })); setStep('form'); setMinted(null); }}
            balance={user.balances[i] ?? 0n}
            error={offer.errors[t.address]}
            required={required[i]}
            autoFocus={i === 0}
          />
        ))}
      </div>

      <div className="rounded-md bg-fill-recessed border border-stroke-weak px-3 py-2.5 space-y-2">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-xs text-weaker">You receive</span>
          <span className="display num text-xl font-semibold text-strong">
            {preview.shares !== undefined ? formatAmountSignificant(preview.shares, vault.decimals) : '0'}{' '}
            <span className="text-sm font-normal text-weak">{vault.receipt.symbol}</span>
          </span>
        </div>
        <div className="flex items-center justify-between gap-3 text-xs num">
          <label className="flex items-center gap-2 text-weaker">
            Slippage tolerance
            <span className="inline-flex items-center rounded border border-stroke-weak bg-background-elevated px-1.5 h-7">
              <input
                inputMode="decimal"
                value={slippage}
                onChange={(e) => setSlippage(e.target.value)}
                aria-label="Slippage tolerance in percent"
                className="w-12 bg-transparent outline-none text-right text-strong"
              />
              <span className="text-weaker ml-0.5">%</span>
            </span>
          </label>
          <span className={cx('text-right', slip.ok ? 'text-weak' : 'text-error')}>
            {slip.ok ? (
              <>minShares {formatAmountSignificant(minShares, vault.decimals)}</>
            ) : (
              slip.error
            )}
          </span>
        </div>
      </div>

      {previewError && <Message tone="warn">{previewError}</Message>}
      {error && <Message tone="error">{error}</Message>}
      {wrongChain && switchError && switchTarget && (
        <Message tone="error">{describeSwitchError(switchError, switchTarget)}</Message>
      )}
      {step === 'done' && minted !== null && (
        <Message tone="ok">
          Deposited. Minted {formatAmountSignificant(minted, vault.decimals)} {vault.receipt.symbol}.
        </Message>
      )}

      <Button
        block
        size="lg"
        onClick={cta.onClick}
        disabled={cta.disabled || busy}
        loading={busy || connecting || (wrongChain && switching)}
      >
        {step === 'approving' ? `Approving ${pendingToken ? symbolOf(pendingToken) : ''}…` : step === 'depositing' ? 'Depositing…' : cta.label}
      </Button>

      {wrongChain && <NetworkManual chainId={vault.chainId} />}

      <p className="text-2xs text-weaker leading-relaxed">
        Shares are the minimum binding ratio across the basket: <span className="num">min(offered × supply / total)</span>. Anything
        offered above the required amount is never pulled — no refund transfer needed.
      </p>
    </section>
  );
}

type ZapStep = 'form' | 'approving' | 'zapping' | 'done';

/**
 * Single-asset deposit through the zap-in periphery: the wallet offers USDG only; the zap swaps the
 * shortfall into the other basket tokens (TWAP-guarded, `slippageBps` tightens the route) and makes
 * the normal in-kind deposit. The allowance goes to the ZAP (it pulls with `transferFrom`), for
 * exactly the amount offered. `minShares` comes from `previewZap` × (1 − tolerance).
 */
function ZapDepositCard({ vault, user, route, modeSwitch }: { vault: LiveVault; user: UserBasket; route: ZapRoute; modeSwitch: ReactNode }) {
  const { address, chainId, write } = useWallet();
  const { connectWallet, isPending: connecting } = useConnectWallet();
  const { switchTo, switching, error: switchError } = useSwitchToChain();
  const pushToast = useStore((s) => s.pushToast);
  const token = route.token;

  const [value, setValue] = useState('');
  const [slippage, setSlippage] = useState(String(ZAP_DEFAULT_SLIPPAGE_BPS / 100));
  const [step, setStep] = useState<ZapStep>('form');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ shares: bigint; refunded: bigint } | null>(null);

  const parsed = parseZapDepositAmount(value, token.decimals, token.symbol);
  const amountIn = parsed?.ok ? parsed.value : 0n;
  const slip = parseZapSlippage(slippage);
  const bps = slip.ok ? slip.bps : ZAP_DEFAULT_SLIPPAGE_BPS;

  const preview = usePreviewZap(vault, route.zap, token.address, amountIn, bps, parsed?.ok === true && slip.ok);
  const minShares = zapMinimum(preview.shares ?? 0n, bps);
  const { allowance, refetch: refetchAllowance } = useZapAllowance(vault, token.address, address, route.zap);
  const balance = user.balances[route.index] ?? 0n;
  const needsApproval = tokensNeedingApproval([token.address], [amountIn], [allowance]).length > 0;
  const short = insufficientBalance([token.address], [amountIn], [balance]);
  const sizeWarning = zapSizeWarning(amountIn, token.decimals, token.symbol);

  const errCtx = {
    shareDecimals: vault.decimals,
    shareSymbol: vault.receipt.symbol,
    tokenDecimals: Object.fromEntries(vault.tokens.map((t) => [t.address, t.decimals])),
    tokenSymbols: Object.fromEntries(vault.tokens.map((t) => [t.address, t.symbol])),
    routeSymbol: token.symbol,
    routeDecimals: token.decimals,
  };

  const wrongChain = Boolean(address) && chainId !== vault.chainId;
  const switchTarget = chainFor(vault.chainId);
  const busy = step === 'approving' || step === 'zapping';

  const approve = async () => {
    setError(null);
    setStep('approving');
    try {
      // Exactly the offer, to the zap (not the vault): the zap pulls the whole amount and refunds dust.
      const hash = await write({
        chainId: vault.chainId,
        address: token.address,
        abi: erc20Abi,
        functionName: 'approve',
        args: [route.zap, amountIn],
      });
      await waitForReceipt(vault.chainId, hash);
      refetchAllowance();
      pushToast({ title: `${token.symbol} approved`, detail: 'The zap may now pull this amount.', tone: 'success' });
    } catch (err) {
      setError(describeZapError(err, errCtx));
    } finally {
      setStep('form');
    }
  };

  const submit = async () => {
    if (!address || minShares === 0n) return;
    setError(null);
    setStep('zapping');
    try {
      const hash = await write({
        chainId: vault.chainId,
        address: route.zap,
        abi: zapInCallAbi,
        functionName: 'zapDeposit',
        args: [vault.address, token.address, amountIn, minShares, bps, address],
      });
      const receipt = await waitForReceipt(vault.chainId, hash);
      const event = parseEventLogs({ abi: zapInAbi, logs: receipt.logs, eventName: 'ZapDeposited' })[0];
      const shares = (event?.args as { shares?: bigint } | undefined)?.shares ?? 0n;
      const refunded = parseEventLogs({ abi: zapInAbi, logs: receipt.logs, eventName: 'ZapRefunded' })
        .filter((e) => (e.args as { token: Address }).token.toLowerCase() === token.address.toLowerCase())
        .reduce((sum, e) => sum + (e.args as { amount: bigint }).amount, 0n);
      setResult({ shares, refunded });
      setStep('done');
      setValue('');
      vault.refetch();
      user.refetch();
      refetchAllowance();
      preview.refetch();
      pushToast({
        title: 'Zap deposit confirmed',
        detail: `Minted ${formatAmountSignificant(shares, vault.decimals)} ${vault.receipt.symbol} from ${formatAmount(amountIn, token.decimals, 6)} ${token.symbol} into ${vault.entry?.label ?? 'the vault'} on ${chainLabel(vault.chainId)}`,
        tone: 'success',
      });
    } catch (err) {
      setError(describeZapError(err, errCtx));
      setStep('form');
    }
  };

  let cta: { label: string; disabled: boolean; onClick: () => void } = { label: 'Zap deposit', disabled: true, onClick: () => {} };
  if (!address) cta = { label: 'Connect wallet', disabled: false, onClick: connectWallet };
  else if (wrongChain) {
    cta = { label: `Switch to ${chainLabel(vault.chainId)}`, disabled: false, onClick: () => void switchTo(vault.chainId).catch(() => {}) };
  }
  else if (vault.paused) cta = { label: 'Vault is paused', disabled: true, onClick: () => {} };
  else if (parsed && !parsed.ok) cta = { label: 'Fix the amount', disabled: true, onClick: () => {} };
  else if (!parsed) cta = { label: `Enter a ${token.symbol} amount`, disabled: true, onClick: () => {} };
  else if (!slip.ok) cta = { label: 'Fix the slippage tolerance', disabled: true, onClick: () => {} };
  else if (short) cta = { label: `Insufficient ${token.symbol}`, disabled: true, onClick: () => {} };
  else if (preview.error) cta = { label: 'Zap not possible', disabled: true, onClick: () => {} };
  else if (preview.shares === undefined) cta = { label: 'Previewing…', disabled: true, onClick: () => {} };
  else if (needsApproval) cta = { label: `Approve ${token.symbol} for the zap`, disabled: false, onClick: () => void approve() };
  else cta = { label: `Deposit ${formatAmount(amountIn, token.decimals, 6)} ${token.symbol}`, disabled: false, onClick: () => void submit() };

  const previewError = preview.error ? describeZapError(preview.error, errCtx) : null;
  const kept = preview.offers?.[route.index];
  const bought = vault.tokens
    .map((t, i) => ({ t, amount: preview.offers?.[i] ?? 0n, i }))
    .filter((x) => x.i !== route.index && x.amount > 0n);

  return (
    <section className="bg-background-elevated border border-stroke-weak rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="display text-sm font-semibold">Deposit with {token.symbol} only</h3>
        <span className="text-2xs text-weaker">The zap swaps the shortfall · deposits in kind · refunds dust</span>
      </div>

      {modeSwitch}

      <StepTrail
        steps={[
          { label: 'Amount', state: parsed?.ok && preview.shares !== undefined ? 'done' : 'active' },
          { label: 'Approve', state: !parsed?.ok || preview.shares === undefined ? 'todo' : needsApproval ? 'active' : 'done' },
          { label: 'Deposit', state: step === 'done' ? 'done' : step === 'zapping' ? 'active' : 'todo' },
        ]}
      />

      <LiveAmountInput
        token={token}
        value={value}
        onChange={(v) => { setValue(v); setStep('form'); setResult(null); }}
        balance={balance}
        error={parsed && !parsed.ok ? parsed.error : undefined}
        hint={needsApproval && parsed?.ok ? `Approved for the zap: ${formatAmount(allowance, token.decimals, 6)}` : undefined}
        autoFocus
      />

      <div className="rounded-md bg-fill-recessed border border-stroke-weak px-3 py-2.5 space-y-2">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-xs text-weaker">You receive (est.)</span>
          <span className="display num text-xl font-semibold text-strong">
            {preview.shares !== undefined ? formatAmountSignificant(preview.shares, vault.decimals) : '0'}{' '}
            <span className="text-sm font-normal text-weak">{vault.receipt.symbol}</span>
          </span>
        </div>
        {kept !== undefined && bought.length > 0 && (
          <div className="text-2xs text-weaker num">
            Deposits ≈ {formatAmount(kept, token.decimals, 6)} {token.symbol} +{' '}
            {bought.map((x) => `${formatAmount(x.amount, x.t.decimals, 6)} ${x.t.symbol}`).join(' + ')} in kind (swaps ≈{' '}
            {formatAmount(amountIn - kept, token.decimals, 6)} {token.symbol})
          </div>
        )}
        <div className="flex items-center justify-between gap-3 text-xs num">
          <label className="flex items-center gap-2 text-weaker">
            Slippage tolerance
            <span className="inline-flex items-center rounded border border-stroke-weak bg-background-elevated px-1.5 h-7">
              <input
                inputMode="decimal"
                value={slippage}
                onChange={(e) => setSlippage(e.target.value)}
                aria-label="Zap slippage tolerance in percent"
                className="w-12 bg-transparent outline-none text-right text-strong"
              />
              <span className="text-weaker ml-0.5">%</span>
            </span>
          </label>
          <span className={cx('text-right', slip.ok ? 'text-weak' : 'text-error')}>
            {slip.ok ? <>minShares {formatAmountSignificant(minShares, vault.decimals)}</> : slip.error}
          </span>
        </div>
        {slip.ok && slip.clamped && (
          <div className="text-2xs text-warning">Capped at the route limit of {ZAP_MAX_SLIPPAGE_BPS / 100}%.</div>
        )}
        {slip.ok && slip.bps === 0 && (
          <div className="text-2xs text-weaker">0% — minShares is the preview exactly; the swap leg uses the route’s own cap.</div>
        )}
      </div>

      {sizeWarning && <Message tone="warn">{sizeWarning}</Message>}
      {previewError && <Message tone="warn">{previewError}</Message>}
      {error && <Message tone="error">{error}</Message>}
      {wrongChain && switchError && switchTarget && (
        <Message tone="error">{describeSwitchError(switchError, switchTarget)}</Message>
      )}
      {step === 'done' && result && (
        <Message tone="ok">
          Deposited. Minted {formatAmountSignificant(result.shares, vault.decimals)} {vault.receipt.symbol}
          {result.refunded > 0n ? ` · ${formatAmount(result.refunded, token.decimals, 6)} ${token.symbol} refunded` : ''}.
        </Message>
      )}

      <Button
        block
        size="lg"
        onClick={cta.onClick}
        disabled={cta.disabled || busy}
        loading={busy || connecting || (wrongChain && switching)}
      >
        {step === 'approving' ? `Approving ${token.symbol}…` : step === 'zapping' ? 'Zapping…' : cta.label}
      </Button>

      {wrongChain && <NetworkManual chainId={vault.chainId} />}

      <p className="text-2xs text-weaker leading-relaxed">
        The zap buys the other basket tokens in the vault’s current ratio on the route pool (UniversalRouter, TWAP-guarded, your
        tolerance at most {ZAP_MAX_SLIPPAGE_BPS / 100}%), then makes the normal in-kind deposit — the vault itself never swaps.
        Leftovers come back to your wallet; no allowance is left standing.
      </p>
    </section>
  );
}

function LiveDepositRow({
  token,
  value,
  onChange,
  balance,
  error,
  required,
  autoFocus,
}: {
  token: TokenMeta;
  value: string;
  onChange: (v: string) => void;
  balance: bigint;
  error?: string;
  required?: bigint;
  autoFocus?: boolean;
}) {
  const hint = required !== undefined && required > 0n ? `Vault pulls ${formatAmount(required, token.decimals, 6)}` : undefined;
  return <LiveAmountInput token={token} value={value} onChange={onChange} balance={balance} error={error} hint={hint} autoFocus={autoFocus} />;
}
