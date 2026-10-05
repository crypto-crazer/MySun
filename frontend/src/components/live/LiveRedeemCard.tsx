/**
 * In-kind redemption. `redeem(shares, receiver)` burns the vault's receipt token and sends a pro-rata slice of EVERY
 * basket token — it reads no adapter reports and works even while rebalancing is paused, so there
 * is no state in which a holder cannot get out.
 *
 * Where the chain has a zap-out periphery for this vault, a second facet redeems to USDG only
 * (`ZapRedeemCard` below); the in-kind redeem stays the default.
 */
import { useState, type ReactNode } from 'react';
import { erc20Abi, parseEventLogs } from 'viem';
import { vaultAbi, zapOutAbi } from '@/config/generated';
import { useWallet } from '@/wallet/context';
import { waitForReceipt } from '@/chain/client';
import { chainFor, chainLabel } from '@/chain/chains';
import { describeSwitchError } from '@/chain/switchChain';
import { NetworkManual } from './NetworkManual';
import { useSwitchToChain } from '@/chain/useTargetChain';
import { formatAmount, formatAmountSignificant, parseAmount, toExactString } from '@/chain/amounts';
import { tokensNeedingApproval } from '@/chain/deposit';
import { describeChainError } from '@/chain/errors';
import {
  ZAP_DEFAULT_SLIPPAGE_BPS,
  ZAP_MAX_SLIPPAGE_BPS,
  describeZapError,
  parseZapRedeemShares,
  parseZapSlippage,
  zapMinimum,
  zapOutCallAbi,
} from '@/chain/zap';
import {
  usePreviewRedeem,
  usePreviewZapRedeem,
  useZapAllowance,
  useZapRoutes,
  type LiveVault,
  type UserBasket,
  type ZapRoute,
} from '@/chain/useVault';
import { Button } from '@/components/ui/Button';
import { useConnectWallet } from '@/chain/useConnectWallet';
import { useStore } from '@/store/useStore';
import { cx } from '@/lib/format';
import { Message } from './Message';
import { TokenAmountList } from './TokenAmount';
import { StepTrail } from './StepTrail';
import { ZapModeSwitch, type ZapMode } from './LiveDepositCard';

/**
 * The redeem card. The "to USDG only" facet is offered only when the chain lists a zap-out contract
 * and the zap has this vault registered with routes into USDG (never on a planned chain or a
 * periphery-less vault); in-kind redeem stays the default and is always there.
 */
export function LiveRedeemCard({ vault, user }: { vault: LiveVault; user: UserBasket }) {
  const { zapOut } = useZapRoutes(vault);
  const [mode, setMode] = useState<ZapMode>('basket');
  const modeSwitch = zapOut ? <ZapModeSwitch value={mode} onChange={setMode} zapLabel={`To ${zapOut.token.symbol} only`} /> : null;
  if (zapOut && mode === 'zap') {
    return <ZapRedeemCard key={vault.address} vault={vault} user={user} route={zapOut} modeSwitch={modeSwitch} />;
  }
  return <BasketRedeemCard vault={vault} user={user} modeSwitch={modeSwitch} />;
}

function BasketRedeemCard({ vault, user, modeSwitch }: { vault: LiveVault; user: UserBasket; modeSwitch: ReactNode }) {
  const { address, chainId, write } = useWallet();
  const { connectWallet, isPending: connecting } = useConnectWallet();
  const { switchTo, switching, error: switchError } = useSwitchToChain();
  const pushToast = useStore((s) => s.pushToast);

  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [received, setReceived] = useState<bigint[] | null>(null);

  const parsed = value.trim() === '' ? null : parseAmount(value, vault.decimals);
  const shares = parsed && parsed.ok ? parsed.value : 0n;
  const parseError = parsed && !parsed.ok ? parsed.error : undefined;
  const tooMany = shares > user.shares;

  const preview = usePreviewRedeem(vault, shares, shares > 0n && !tooMany);
  const errCtx = {
    shareDecimals: vault.decimals,
    shareSymbol: vault.receipt.symbol,
    tokenDecimals: Object.fromEntries(vault.tokens.map((t) => [t.address, t.decimals])),
    tokenSymbols: Object.fromEntries(vault.tokens.map((t) => [t.address, t.symbol])),
  };

  const wrongChain = Boolean(address) && chainId !== vault.chainId;
  const switchTarget = chainFor(vault.chainId);

  const submit = async () => {
    if (!address || shares === 0n) return;
    setError(null);
    setReceived(null);
    setBusy(true);
    try {
      const hash = await write({
        chainId: vault.chainId,
        address: vault.address,
        abi: vaultAbi,
        functionName: 'redeem',
        args: [shares, address],
      });
      const receipt = await waitForReceipt(vault.chainId, hash);
      const events = parseEventLogs({ abi: vaultAbi, logs: receipt.logs, eventName: 'Redeemed' });
      const amounts = (events[0]?.args as { amounts?: readonly bigint[] } | undefined)?.amounts;
      setReceived(amounts ? [...amounts] : null);
      setValue('');
      vault.refetch();
      user.refetch();
      pushToast({
        title: 'Redeem confirmed',
        detail: `Burned ${formatAmountSignificant(shares, vault.decimals)} ${vault.receipt.symbol} from ${vault.entry?.label ?? 'the vault'} on ${chainLabel(vault.chainId)}`,
        tone: 'success',
      });
    } catch (err) {
      setError(describeChainError(err, errCtx));
    } finally {
      setBusy(false);
    }
  };

  let cta: { label: string; disabled: boolean; onClick: () => void } = { label: 'Redeem', disabled: true, onClick: () => {} };
  if (!address) cta = { label: 'Connect wallet', disabled: false, onClick: connectWallet };
  else if (wrongChain) {
    cta = { label: `Switch to ${chainLabel(vault.chainId)}`, disabled: false, onClick: () => void switchTo(vault.chainId).catch(() => {}) };
  }
  else if (vault.paused) cta = { label: 'Vault is paused', disabled: true, onClick: () => {} };
  else if (user.shares === 0n) cta = { label: `No ${vault.receipt.symbol} to redeem`, disabled: true, onClick: () => {} };
  else if (parseError) cta = { label: 'Fix the amount', disabled: true, onClick: () => {} };
  else if (shares === 0n) cta = { label: 'Enter an amount', disabled: true, onClick: () => {} };
  else if (tooMany) cta = { label: `Max ${formatAmountSignificant(user.shares, vault.decimals)}`, disabled: true, onClick: () => {} };
  else cta = { label: 'Redeem in kind', disabled: false, onClick: () => void submit() };

  return (
    <section className="bg-background-elevated border border-stroke-weak rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="display text-sm font-semibold">Redeem</h3>
        <span className="text-2xs text-weaker">Always available · never blocked by a position</span>
      </div>

      {modeSwitch}

      <div className="rounded-md bg-fill-recessed border border-stroke-weak px-3 pt-2.5 pb-2">
        <div className="flex items-center gap-2">
          <input
            inputMode="decimal"
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(e) => { setValue(e.target.value); setReceived(null); }}
            placeholder="0"
            aria-label={`${vault.receipt.symbol} amount to redeem`}
            className="flex-1 min-w-0 bg-transparent display text-2xl num text-strong placeholder:text-weaker outline-none"
          />
          <span className="h-9 px-3 rounded-full bg-fill-weak border border-stroke-weak inline-flex items-center text-sm font-medium whitespace-nowrap">
            {vault.receipt.symbol}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2 mt-1 text-xs num">
          <span className={parseError || tooMany ? 'text-error' : 'text-weaker'}>{parseError ?? (tooMany ? 'More than you hold' : '')}</span>
          <span className="text-weaker whitespace-nowrap">
            Balance {formatAmountSignificant(user.shares, vault.decimals)}
            <button
              onClick={() => setValue(toExactString(user.shares, vault.decimals))}
              className="ml-1.5 text-strong font-medium hover:brightness-110"
            >
              Max
            </button>
          </span>
        </div>
      </div>

      <div className="rounded-md bg-fill-recessed border border-stroke-weak px-3 py-2">
        <div className="text-xs text-weaker mb-1">You receive</div>
        <TokenAmountList tokens={vault.tokens} amounts={preview.owed ?? vault.tokens.map(() => 0n)} digits={6} />
      </div>

      {preview.error && <Message tone="warn">{describeChainError(preview.error, errCtx)}</Message>}
      {error && <Message tone="error">{error}</Message>}
      {wrongChain && switchError && switchTarget && (
        <Message tone="error">{describeSwitchError(switchError, switchTarget)}</Message>
      )}
      {received && (
        <Message tone="ok">
          Redeemed.{' '}
          {vault.tokens.map((t, i) => `${formatAmount(received[i] ?? 0n, t.decimals, 6)} ${t.symbol}`).join(' + ')} sent to your wallet.
        </Message>
      )}

      <Button block size="lg" variant="secondary" onClick={cta.onClick} disabled={cta.disabled || busy} loading={busy || connecting || (wrongChain && switching)}>
        {busy ? 'Redeeming…' : cta.label}
      </Button>

      {wrongChain && <NetworkManual chainId={vault.chainId} />}

      <p className="text-2xs text-weaker leading-relaxed">
        Each adapter delivers <span className="num">floor(sharesWad / 1e18)</span> of what it holds straight to your wallet
        (sharesWad = floor(your shares × 1e18 / total supply)); the vault sends your exact slice of its idle balances.
        Adapter-side rounding leaves a few raw units behind for the remaining holders — a documented dust convention; the
        vault never over-delivers.
      </p>
    </section>
  );
}

type ZapStep = 'form' | 'approving' | 'redeeming';

/**
 * Exit to one token through the zap-out periphery: the zap pulls the shares, redeems in kind, sells
 * every other basket token into USDG (TWAP-guarded, `slippageBps` tightens the route) and sends it
 * all on. The receipt token is approved to the ZAP for exactly the shares; `minAmountOut` comes from
 * the zap's `previewRedeem` × (1 − tolerance) and bounds the TOTAL USDG delivered.
 */
function ZapRedeemCard({ vault, user, route, modeSwitch }: { vault: LiveVault; user: UserBasket; route: ZapRoute; modeSwitch: ReactNode }) {
  const { address, chainId, write } = useWallet();
  const { connectWallet, isPending: connecting } = useConnectWallet();
  const { switchTo, switching, error: switchError } = useSwitchToChain();
  const pushToast = useStore((s) => s.pushToast);
  const token = route.token;

  const [value, setValue] = useState('');
  const [slippage, setSlippage] = useState(String(ZAP_DEFAULT_SLIPPAGE_BPS / 100));
  const [step, setStep] = useState<ZapStep>('form');
  const [error, setError] = useState<string | null>(null);
  const [received, setReceived] = useState<bigint | null>(null);

  const parsed = parseZapRedeemShares(value, vault.decimals, user.shares);
  const shares = parsed?.ok ? parsed.value : 0n;
  const slip = parseZapSlippage(slippage);
  const bps = slip.ok ? slip.bps : ZAP_DEFAULT_SLIPPAGE_BPS;

  const preview = usePreviewZapRedeem(vault, route.zap, token.address, shares, bps, parsed?.ok === true && slip.ok);
  const minOut = zapMinimum(preview.amountOut ?? 0n, bps);
  const { allowance, refetch: refetchAllowance } = useZapAllowance(vault, vault.address, address, route.zap);
  const needsApproval = tokensNeedingApproval([vault.address], [shares], [allowance]).length > 0;
  const passThrough = vault.tokens
    .map((t, i) => ({ t, amount: preview.passThrough?.[i] ?? 0n }))
    .filter((x) => x.amount > 0n);

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
  const busy = step !== 'form';

  const approve = async () => {
    setError(null);
    setStep('approving');
    try {
      // The receipt token is the vault itself; the zap pulls exactly these shares.
      const hash = await write({
        chainId: vault.chainId,
        address: vault.address,
        abi: erc20Abi,
        functionName: 'approve',
        args: [route.zap, shares],
      });
      await waitForReceipt(vault.chainId, hash);
      refetchAllowance();
      pushToast({ title: `${vault.receipt.symbol} approved`, detail: 'The zap may now pull these shares.', tone: 'success' });
    } catch (err) {
      setError(describeZapError(err, errCtx));
    } finally {
      setStep('form');
    }
  };

  const submit = async () => {
    if (!address || shares === 0n || minOut === 0n) return;
    setError(null);
    setReceived(null);
    setStep('redeeming');
    try {
      const hash = await write({
        chainId: vault.chainId,
        address: route.zap,
        abi: zapOutCallAbi,
        functionName: 'zapRedeem',
        args: [vault.address, token.address, shares, minOut, bps, address],
      });
      const receipt = await waitForReceipt(vault.chainId, hash);
      const event = parseEventLogs({ abi: zapOutAbi, logs: receipt.logs, eventName: 'ZapRedeemed' })[0];
      const amountOut = (event?.args as { amountOut?: bigint } | undefined)?.amountOut ?? 0n;
      setReceived(amountOut);
      setValue('');
      vault.refetch();
      user.refetch();
      refetchAllowance();
      pushToast({
        title: 'Zap redeem confirmed',
        detail: `Burned ${formatAmountSignificant(shares, vault.decimals)} ${vault.receipt.symbol} for ${formatAmount(amountOut, token.decimals, 6)} ${token.symbol} from ${vault.entry?.label ?? 'the vault'} on ${chainLabel(vault.chainId)}`,
        tone: 'success',
      });
    } catch (err) {
      setError(describeZapError(err, errCtx));
    } finally {
      setStep('form');
    }
  };

  let cta: { label: string; disabled: boolean; onClick: () => void } = { label: 'Redeem', disabled: true, onClick: () => {} };
  if (!address) cta = { label: 'Connect wallet', disabled: false, onClick: connectWallet };
  else if (wrongChain) {
    cta = { label: `Switch to ${chainLabel(vault.chainId)}`, disabled: false, onClick: () => void switchTo(vault.chainId).catch(() => {}) };
  }
  else if (vault.paused) cta = { label: 'Vault is paused', disabled: true, onClick: () => {} };
  else if (user.shares === 0n) cta = { label: `No ${vault.receipt.symbol} to redeem`, disabled: true, onClick: () => {} };
  else if (parsed && !parsed.ok) cta = { label: parsed.error === 'More than you hold' ? `Max ${formatAmountSignificant(user.shares, vault.decimals)}` : 'Fix the amount', disabled: true, onClick: () => {} };
  else if (!parsed) cta = { label: 'Enter an amount', disabled: true, onClick: () => {} };
  else if (!slip.ok) cta = { label: 'Fix the slippage tolerance', disabled: true, onClick: () => {} };
  else if (preview.error) cta = { label: 'Zap not possible', disabled: true, onClick: () => {} };
  else if (preview.amountOut === undefined) cta = { label: 'Previewing…', disabled: true, onClick: () => {} };
  else if (needsApproval) cta = { label: `Approve ${vault.receipt.symbol} for the zap`, disabled: false, onClick: () => void approve() };
  else cta = { label: `Redeem to ${token.symbol}`, disabled: false, onClick: () => void submit() };

  return (
    <section className="bg-background-elevated border border-stroke-weak rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="display text-sm font-semibold">Redeem to {token.symbol} only</h3>
        <span className="text-2xs text-weaker">Redeems in kind · the zap sells the rest into {token.symbol}</span>
      </div>

      {modeSwitch}

      <StepTrail
        steps={[
          { label: 'Amount', state: parsed?.ok && preview.amountOut !== undefined ? 'done' : 'active' },
          { label: 'Approve', state: !parsed?.ok || preview.amountOut === undefined ? 'todo' : needsApproval ? 'active' : 'done' },
          { label: 'Redeem', state: received !== null ? 'done' : step === 'redeeming' ? 'active' : 'todo' },
        ]}
      />

      <div className={cx('rounded-md bg-fill-recessed border px-3 pt-2.5 pb-2', parsed && !parsed.ok ? 'border-stroke-error/60' : 'border-stroke-weak')}>
        <div className="flex items-center gap-2">
          <input
            inputMode="decimal"
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(e) => { setValue(e.target.value); setReceived(null); }}
            placeholder="0"
            aria-label={`${vault.receipt.symbol} amount to redeem to ${token.symbol}`}
            className="flex-1 min-w-0 bg-transparent display text-2xl num text-strong placeholder:text-weaker outline-none"
          />
          <span className="h-9 px-3 rounded-full bg-fill-weak border border-stroke-weak inline-flex items-center text-sm font-medium whitespace-nowrap">
            {vault.receipt.symbol}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2 mt-1 text-xs num">
          <span className={parsed && !parsed.ok ? 'text-error' : 'text-weaker'}>{parsed && !parsed.ok ? parsed.error : ''}</span>
          <span className="text-weaker whitespace-nowrap">
            Balance {formatAmountSignificant(user.shares, vault.decimals)}
            <button
              onClick={() => setValue(toExactString(user.shares, vault.decimals))}
              className="ml-1.5 text-strong font-medium hover:brightness-110"
            >
              Max
            </button>
          </span>
        </div>
      </div>

      <div className="rounded-md bg-fill-recessed border border-stroke-weak px-3 py-2.5 space-y-2">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-xs text-weaker">You receive (est.)</span>
          <span className="display num text-xl font-semibold text-strong">
            {preview.amountOut !== undefined ? formatAmount(preview.amountOut, token.decimals, 6) : '0'}{' '}
            <span className="text-sm font-normal text-weak">{token.symbol}</span>
          </span>
        </div>
        {passThrough.length > 0 && (
          <div className="text-2xs text-weaker num">
            Plus in kind (no route / dust): {passThrough.map((x) => `${formatAmount(x.amount, x.t.decimals, 6)} ${x.t.symbol}`).join(' + ')}
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
                aria-label="Zap redeem slippage tolerance in percent"
                className="w-12 bg-transparent outline-none text-right text-strong"
              />
              <span className="text-weaker ml-0.5">%</span>
            </span>
          </label>
          <span className={cx('text-right', slip.ok ? 'text-weak' : 'text-error')}>
            {slip.ok ? <>min {formatAmount(minOut, token.decimals, 6)} {token.symbol}</> : slip.error}
          </span>
        </div>
        {slip.ok && slip.clamped && (
          <div className="text-2xs text-warning">Capped at the route limit of {ZAP_MAX_SLIPPAGE_BPS / 100}%.</div>
        )}
        {slip.ok && slip.bps === 0 && (
          <div className="text-2xs text-weaker">0% — the minimum is the preview exactly; the swap leg uses the route’s own cap.</div>
        )}
      </div>

      {preview.error && <Message tone="warn">{describeZapError(preview.error, errCtx)}</Message>}
      {error && <Message tone="error">{error}</Message>}
      {wrongChain && switchError && switchTarget && (
        <Message tone="error">{describeSwitchError(switchError, switchTarget)}</Message>
      )}
      {received !== null && (
        <Message tone="ok">
          Redeemed. {formatAmount(received, token.decimals, 6)} {token.symbol} sent to your wallet.
        </Message>
      )}

      <Button block size="lg" variant="secondary" onClick={cta.onClick} disabled={cta.disabled || busy} loading={busy || connecting || (wrongChain && switching)}>
        {step === 'approving' ? `Approving ${vault.receipt.symbol}…` : step === 'redeeming' ? 'Redeeming…' : cta.label}
      </Button>

      {wrongChain && <NetworkManual chainId={vault.chainId} />}

      <p className="text-2xs text-weaker leading-relaxed">
        The vault redeems your exact in-kind slice first (no ratio feedback); the zap then sells each other basket token in one
        swap on its route pool (UniversalRouter, TWAP-guarded, your tolerance at most {ZAP_MAX_SLIPPAGE_BPS / 100}%). Your minimum
        bounds the total {token.symbol} delivered; nothing stays in the zap.
      </p>
    </section>
  );
}
