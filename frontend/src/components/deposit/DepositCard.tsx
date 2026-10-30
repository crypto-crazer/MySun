/**
 * The deposit / withdraw card, as the original design drew it — tabs, "Pay with" (or "Zap in") / "Receive in",
 * one amount box per token, "You receive", one guiding button, the details fold — wired to the
 * deployed vault. Every figure is a chain read; every action is a real transaction:
 *
 *  - In kind: offer a MAX per basket token → `previewDeposit` says the shares and what is pulled →
 *    approve the vault only where the allowance is short → `deposit(tokens, amounts, minShares, me)`.
 *  - One token (zap-in), the deposit default where `useZapRoutes` serves the vault — USDG by default, or any basket
 *    token the zap routes to every other one: approve the ZAP for exactly the offer →
 *    `zapDeposit(vault, token, amount, minShares, 0, me)` (leg bound 0 = each route's own cap).
 *  - Withdraw: `redeem(shares, me)` in kind, or `zapRedeem` to USDG only (approve the zap for the shares).
 *
 * `minShares` / `minAmountOut` are quoted at SIGNING time: the preview is re-read just before the
 * wallet prompt, and the transaction is refused if it moved past the tolerance from what was on screen.
 * A paused vault freezes every action ("Vault is paused"). USD figures (≈ $) are display only: live
 * reference-pool spots and the live spot NAV, passed in by the page.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { Address } from 'viem';
import { erc20Abi, parseEventLogs } from 'viem';
import { readContract } from 'viem/actions';
import { vaultAbi, zapInAbi, zapOutAbi } from '@/config/generated';
import { useWallet } from '@/wallet/context';
import { publicClientFor, waitForReceipt } from '@/chain/client';
import { chainFor, chainLabel, isLocalChain, resolveLocalRpcUrl } from '@/chain/chains';
import { describeSwitchError } from '@/chain/switchChain';
import { useSwitchToChain } from '@/chain/useTargetChain';
import { useConnectWallet } from '@/chain/useConnectWallet';
import { formatAmount, formatAmountSignificant, parseAmount, toExactString } from '@/chain/amounts';
import {
  DEFAULT_SLIPPAGE_BPS,
  dispatchBasket,
  fillAtMix,
  insufficientBalance,
  minSharesFromPreview,
  parseSlippageBps,
  tokensNeedingApproval,
} from '@/chain/deposit';
import { describeChainError } from '@/chain/errors';
import {
  ZAP_DEFAULT_SLIPPAGE_BPS,
  ZAP_LEG_SLIPPAGE_BPS,
  ZAP_MAX_SLIPPAGE_BPS,
  describeZapError,
  isZapRouteSymbol,
  parseZapDepositAmount,
  parseZapRedeemShares,
  parseZapSlippage,
  zapInCallAbi,
  zapMinimum,
  zapOutCallAbi,
  zapSizeWarning,
} from '@/chain/zap';
import {
  usePreviewDeposit,
  usePreviewRedeem,
  usePreviewZap,
  usePreviewZapRedeem,
  useZapAllowance,
  useLiveVaultAt,
  useUserBasket,
  useZapRoutes,
  type LiveVault,
  type TokenMeta,
  type UserBasket,
  type ZapRoute,
} from '@/chain/useVault';
import { basketName, basketOrder, basketOrderIndices, displaySymbol, feeLabel, tokenUsdPrices, vaultRouteId } from '@/chain/liveVaults';
import type { LiveVaultRow } from '@/chain/useLiveVaults';
import type { ChainSpots } from '@/chain/useSpotPrices';
import { useStore } from '@/store/useStore';
import { cx, fmtPrice, fmtUsd } from '@/lib/format';
import { Arrow } from '@/components/ui/Arrow';
import { Button } from '@/components/ui/Button';
import { PercentInput } from '@/components/ui/PercentInput';
import { useDismiss } from '@/components/ui/Popover';
import { SlidingKey } from '@/components/ui/SlidingKey';
import { Spinner } from '@/components/ui/Spinner';
import { TokenGroup, TokenIcon } from '@/components/ui/TokenIcon';
import { Hint } from '@/components/ui/Tooltip';
import { Message } from '@/components/live/Message';
import { NetworkManual } from '@/components/live/NetworkManual';

type Tab = 'deposit' | 'withdraw';
/** In kind (every basket token) or the single-token zap facet. */
type Mode = 'basket' | 'zap';

interface Props {
  vault: LiveVault;
  user: UserBasket;
  /** USD per whole token, keyed by lowercase address — display only (live spot; USDG at its peg). */
  usdPrices?: ReadonlyMap<string, number>;
  /** Live spot NAV per receipt token, USD — display only. */
  nav?: number;
  initialAmount?: string;
  /** Name the vault and link to its page. On for the overlay; off on the vault page, which already says so. */
  showVaultLink?: boolean;
}

export function DepositCard({ vault: v, user, usdPrices, nav, initialAmount, showVaultLink = true }: Props) {
  const [tab, setTab] = useState<Tab>('deposit');
  const routes = useZapRoutes(v);
  // The vault lists its tokens only once their symbols are read (seeded from the page's catalogue row)
  const symbols = basketOrder(v.tokens.map((t) => t.symbol));
  const unreachable = v.hasDeployment && (Boolean(v.error) || (!v.isLoading && v.tokens.length === 0));
  const ctx: FormContext = { vault: v, symbols, user, usdPrices: usdPrices ?? new Map(), nav };

  return (
    <div className="w-full max-w-[440px] mx-auto lg:max-w-none">
      <div className="rounded-lg border border-stroke-strong bg-background-elevated px-5 pb-5">
        <div className="relative -mx-5 grid grid-cols-2 border-b border-stroke-strong" role="tablist">
          <span
            aria-hidden
            className={cx(
              'pointer-events-none absolute -bottom-px left-0 h-0.5 w-1/2 transition-transform duration-300 ease-dusk',
              tab === 'withdraw' && 'translate-x-full',
            )}
          >
            <span className="absolute inset-y-0 inset-x-5 bg-strong" />
          </span>
          {(['deposit', 'withdraw'] as Tab[]).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={cx(
                'relative py-3 text-base transition-colors duration-300 ease-dusk',
                tab === t ? 'text-strong' : 'text-weaker hover:text-weak',
              )}
            >
              {t === 'deposit' ? 'Deposit' : 'Withdraw'}
            </button>
          ))}
        </div>

        {/* The vault's name gets room on both sides, so it reads as the title of the overlay, apart from the tabs and the form */}
        {showVaultLink && v.entry && (
          <div className="flex items-center gap-3 py-8">
            {symbols.length > 0 && <TokenGroup symbols={symbols} size={26} />}
            <span className="min-w-0 flex-1 font-serif text-xl font-normal leading-tight text-strong">{basketName(symbols, v.entry.label)}</span>
            <Link to={`/vault/${vaultRouteId(v.chainId, v.entry.key)}`} className="inline-flex shrink-0 items-center gap-1 text-xs text-weaker hover:text-strong">View vault<Arrow /></Link>
          </div>
        )}

        <div key={`${v.chainId}-${v.address}-${tab}`} className={cx('animate-[vault-tab-in_200ms_ease-out]', !showVaultLink && 'pt-4')}>
          {!v.hasDeployment ? (
            <Message tone="warn">No vault deployed here.</Message>
          ) : unreachable ? (
            <Message tone="error">
              Cannot reach the vault on {chainLabel(v.chainId)}
              {v.deployment ? ` (${resolveLocalRpcUrl(v.deployment.rpcUrl, v.deployment.local === true)})` : ''}.{' '}
              {isLocalChain(v.chainId) ? 'Start the local chain and the demo stack, then reload.' : 'The RPC did not answer; try again shortly.'}
            </Message>
          ) : tab === 'deposit' ? (
            // The zap form's shape holds while the vault's reads and the route land, so nothing flashes in
            <DepositForm ctx={ctx} routes={routes.zapIn} routePending={routes.zapInStatus === 'probing'} initialAmount={initialAmount} />
          ) : v.tokens.length === 0 ? (
            <div className="flex justify-center py-10"><Spinner className="h-5 w-5 text-weaker" /></div>
          ) : (
            <WithdrawForm ctx={ctx} route={routes.zapOut} />
          )}
        </div>
      </div>
    </div>
  );
}

// ───────────────────────── shared bits ─────────────────────────

interface FormContext {
  vault: LiveVault;
  /** The basket in the name's order. */
  symbols: string[];
  user: UserBasket;
  usdPrices: ReadonlyMap<string, number>;
  nav: number | undefined;
}

function errorContext(v: LiveVault, route?: ZapRoute) {
  return {
    shareDecimals: v.decimals,
    shareSymbol: v.receipt.symbol,
    tokenDecimals: Object.fromEntries(v.tokens.map((t) => [t.address, t.decimals])),
    tokenSymbols: Object.fromEntries(v.tokens.map((t) => [t.address, t.symbol])),
    ...(route ? { routeSymbol: route.token.symbol, routeDecimals: route.token.decimals } : {}),
  };
}

/** The vault as the confirmation toasts name it: the basket's display name ("ETH / USDG"), not the registry label. */
const vaultName = (v: LiveVault) => basketName(v.tokens.map((t) => t.symbol), v.entry?.label ?? 'the vault');

/** Whole-token display value of a raw amount (USD estimates only — never fed to a transaction). */
const whole = (raw: bigint, decimals: number) => Number(raw) / 10 ** decimals;

/** How the basket fields fill: the tooltip on the in-kind "Amount" label. */
const MIX_EXPLAINER =
  "Deposits go in at the vault's current mix, so the other amounts fill in as you type. The token you hold least of sets the most you can add — use its Max.";

function Chevron({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={cx('h-4 w-4 text-weaker shrink-0', className)} fill="none" aria-hidden>
      <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Field({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div>
      <div className="eyebrow mb-2">{label}</div>
      {children}
    </div>
  );
}

/** Amount box — the one thing the user touches. The token is shown, or chosen in `picker` where the form offers a choice. */
function AmountBox({
  value, onChange, tokenLabel, tokenIcon, picker, balance, decimals, connected, usd, autoFocus, disabled, error, note, ariaLabel,
}: {
  value: string; onChange: (s: string) => void; tokenLabel: string; tokenIcon?: ReactNode; picker?: ReactNode;
  balance?: bigint; decimals: number; connected: boolean; usd?: number; autoFocus?: boolean; disabled?: boolean; error?: string | boolean; note?: string; ariaLabel: string;
}) {
  return (
    <div className={cx('well grid gap-2 px-4 py-3', error ? 'well-field-error' : 'well-field')}>
      <div className="flex items-center gap-3">
        <input
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          autoFocus={autoFocus}
          disabled={disabled}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="0"
          aria-label={ariaLabel}
          className="w-0 min-w-0 flex-1 bg-transparent display text-3xl leading-9 num text-strong placeholder:text-weaker outline-none focus-visible:outline-none"
        />
        {picker ?? (
          <span className="inline-flex items-center gap-2 whitespace-nowrap text-base font-medium">
            {tokenIcon}
            {tokenLabel}
          </span>
        )}
      </div>
      <div className="flex items-center justify-between gap-2 text-xs num">
        <span className="text-weaker">{usd !== undefined && usd > 0 ? `≈ ${fmtUsd(usd, { compact: false, cents: true })}` : ''}</span>
        {connected && balance !== undefined && (
          <span className="text-weaker">
            Balance {formatAmountSignificant(balance, decimals)}
            <button onClick={() => onChange(toExactString(balance, decimals))} className="ml-2 font-bold text-strong hover:text-accent-bright">Max</button>
          </span>
        )}
      </div>
      {(typeof error === 'string' || note) && (
        <div className={cx('text-2xs num', typeof error === 'string' ? 'text-error' : 'text-weaker')}>{typeof error === 'string' ? error : note}</div>
      )}
    </div>
  );
}

/** What a deposit mints, in receipt tokens, with its ≈ $ once priced. Until there is a preview it reads 0, dimmed. */
function YouReceive({ shares, decimals, symbol, usd }: { shares?: bigint; decimals: number; symbol: string; usd?: number }) {
  return (
    <Field label="You receive">
      <div className="flex items-baseline justify-between gap-3 border-t border-stroke-strong pt-3 num">
        <span className={cx('display num truncate text-2xl', shares !== undefined ? 'text-strong' : 'text-weaker')}>
          {shares !== undefined ? formatAmountSignificant(shares, decimals) : '0'} <span className="ml-0.5 text-base font-normal text-weak">{symbol}</span>
        </span>
        {usd !== undefined && <span className="text-xs text-weaker shrink-0">≈ {fmtUsd(usd, { compact: false, cents: true })}</span>}
      </div>
    </Field>
  );
}

/**
 * The zap's pay-with token: every basket token the chain has a full zap-in route set for, each with the
 * wallet's balance. A menu when there is a choice (arrow keys move through it); one candidate is just its label.
 */
function TokenPicker({ tokens, balances, value, onChange, connected }: { tokens: TokenMeta[]; balances: bigint[]; value: number; onChange: (i: number) => void; connected: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  // The row to focus once the menu has mounted (opened from the keyboard)
  const focusOnOpen = useRef<number | null>(null);

  // Escape closes the menu, not the deposit overlay it sits in
  useDismiss(ref, open, setOpen);
  useEffect(() => {
    if (!open || focusOnOpen.current === null) return;
    items.current[focusOnOpen.current]?.focus();
    focusOnOpen.current = null;
  }, [open]);

  const current = tokens[value];
  if (tokens.length < 2) {
    return (
      <span className="inline-flex items-center gap-2 whitespace-nowrap text-base font-medium">
        <TokenIcon symbol={current.symbol} size={20} />
        {current.symbol}
      </span>
    );
  }

  const focusItem = (i: number) => items.current[(i + tokens.length) % tokens.length]?.focus();
  const onTriggerKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    if (open) return focusItem(value);
    focusOnOpen.current = value;
    setOpen(true);
  };
  const onMenuKey = (e: KeyboardEvent) => {
    const at = items.current.findIndex((el) => el === document.activeElement);
    const to = e.key === 'ArrowDown' ? at + 1 : e.key === 'ArrowUp' ? at - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? tokens.length - 1 : null;
    if (to === null) return;
    e.preventDefault();
    focusItem(to);
  };
  const pick = (i: number) => {
    onChange(i);
    setOpen(false);
    trigger.current?.focus();
  };

  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        ref={trigger}
        type="button"
        onClick={() => setOpen(!open)}
        onKeyDown={onTriggerKey}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Pay with ${current.symbol}`}
        className="-mr-2 inline-flex h-9 items-center gap-2 whitespace-nowrap rounded-full px-2 text-base font-medium transition-colors duration-300 ease-dusk hover:bg-background-elevated"
      >
        <TokenIcon symbol={current.symbol} size={20} />
        {current.symbol}
        <Chevron className={cx('transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <ul
          role="listbox"
          aria-label="Pay with"
          onKeyDown={onMenuKey}
          className="absolute right-0 top-full mt-2 w-60 bg-background-popover border border-stroke-strong rounded-md shadow-pop p-1 animate-fade-in z-40"
        >
          {tokens.map((t, i) => (
            <li key={t.address} role="option" aria-selected={i === value}>
              <button
                ref={(el) => { items.current[i] = el; }}
                type="button"
                onClick={() => pick(i)}
                className={cx(
                  'w-full rounded px-3 py-2 text-left text-base flex items-center gap-2 hover:bg-background-elevated focus-visible:bg-background-elevated',
                  i === value ? 'text-strong' : 'text-weak',
                )}
              >
                <TokenIcon symbol={t.symbol} size={20} />
                <span className="flex-1 min-w-0 truncate">{t.symbol}</span>
                {connected && <span className="num text-xs text-weaker">{formatAmountSignificant(balances[i] ?? 0n, t.decimals)}</span>}
                <span className={cx('w-3 text-strong', i !== value && 'invisible')} aria-hidden>✓</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface ChoiceOption {
  id: Mode;
  label: string;
  name: string;
  icon: ReactNode;
  disabled?: boolean;
}

/** The basket's USDG — the zap's default token — once the vault's tokens are read. */
const zapAnchor = (v: LiveVault) => v.tokens.find((t) => isZapRouteSymbol(t.symbol));

/**
 * The whole basket in kind, "Both" or "All", and the zap's one token ("USDG", or the picked pay-with token):
 * both always there, so the groove never changes shape.
 * The form's default goes first: `zapFirst` (deposit) puts USDG on the left, withdraw keeps the basket there.
 * Each key stays unpickable until what it needs has landed: the basket's tokens, or the zap's route.
 */
function modeOptions({ vault: v, symbols }: FormContext, route: ZapRoute | undefined, zapFirst = false): ChoiceOption[] {
  // The zap's token as the chain names it: the route's, else the basket's USDG; blank until the basket is read
  const symbol = route?.token.symbol ?? zapAnchor(v)?.symbol ?? '';
  // The basket's size lands before its symbols do: name the key by the count, and leave it blank until that lands
  const count = symbols.length || v.tokens.length;
  const basket: ChoiceOption = { id: 'basket', label: count === 0 ? '' : count === 2 ? 'Both' : 'All', name: symbols.map(displaySymbol).join(' + '), icon: <TokenGroup symbols={symbols} size={18} />, disabled: v.tokens.length === 0 };
  const zap: ChoiceOption = { id: 'zap', label: symbol, name: `${symbol} only, through the zap`, icon: symbol && <TokenIcon symbol={symbol} size={18} />, disabled: !route };
  return zapFirst ? [zap, basket] : [basket, zap];
}

/**
 * Visible choice of what to pay with or receive, each with its logo.
 * One groove across the card with equal columns. The options sit in the recess; the chosen one is
 * raised out of it as a glass key.
 */
function TokenChoice({ options, value, onChange }: { options: ChoiceOption[]; value: Mode; onChange: (id: Mode) => void }) {
  const track = useRef<HTMLDivElement>(null);
  return (
    <div ref={track} className="well groove grid w-full" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      <SlidingKey track={track} chosen='[aria-pressed="true"]' />
      {options.map((o) => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          disabled={o.disabled}
          aria-pressed={value === o.id}
          title={o.name === o.label ? undefined : o.name}
          className={cx(
            'inline-flex h-9 items-center justify-center gap-2 whitespace-nowrap text-base font-medium transition-colors duration-300 ease-dusk',
            value === o.id ? 'text-strong' : cx('text-weak', o.disabled ? 'cursor-default' : 'hover:text-strong'),
          )}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * The fold under the button: a "Details" eyebrow, like the card's other labels, that opens the rows.
 * `disabled` draws it closed with nothing to open (the zap's pending shape).
 */
function DetailsFold({ disabled, children }: { disabled?: boolean; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        disabled={disabled}
        aria-expanded={open}
        className="eyebrow w-full flex items-center justify-between gap-3 py-0.5 text-left enabled:hover:text-weak disabled:cursor-default"
      >
        Details
        <Chevron className={cx('transition-transform', open && 'rotate-180')} />
      </button>
      {open && <dl className="mt-2 grid border-t border-stroke-strong pt-2 animate-fade-in">{children}</dl>}
    </>
  );
}

/** The live price of one receipt token, the first row of every deposit fold. */
const priceRow = (nav: number | undefined, symbol: string) => <Row k="Price" v={nav === undefined ? '—' : `${fmtPrice(nav)} per ${symbol}`} />;

function Row({ k, v }: { k: ReactNode; v: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <dt className="text-weaker">{k}</dt>
      <dd className="text-right text-strong">{v}</dd>
    </div>
  );
}

type Cta = { label: string; disabled: boolean; onClick: () => void };
const idle = (label: string): Cta => ({ label, disabled: true, onClick: () => {} });

/** The steps every write CTA shares, in order: connect → right network → not paused. */
function useWriteGate(v: LiveVault) {
  const { address, chainId } = useWallet();
  const { connectWallet, isPending: connecting } = useConnectWallet();
  const { switchTo, switching, error: switchError } = useSwitchToChain();
  const wrongChain = Boolean(address) && chainId !== v.chainId;
  const gate: Cta | null = !address
    ? { label: 'Connect wallet', disabled: false, onClick: connectWallet }
    : wrongChain
      ? { label: `Switch to ${chainLabel(v.chainId)}`, disabled: false, onClick: () => void switchTo(v.chainId).catch(() => {}) }
      : v.paused
        ? idle('Vault is paused')
        : null;
  const switchTarget = chainFor(v.chainId);
  const footer = (
    <>
      {wrongChain && switchError && switchTarget && <Message tone="error">{describeSwitchError(switchError, switchTarget)}</Message>}
      {wrongChain && <NetworkManual chainId={v.chainId} />}
    </>
  );
  return { address, gate, loading: connecting || (wrongChain && switching), footer };
}

// ───────────────────────── Deposit ─────────────────────────

function DepositForm({ ctx, routes, routePending, initialAmount }: { ctx: FormContext; routes: ZapRoute[]; routePending: boolean; initialAmount?: string }) {
  // USDG only by default. Until the chain confirms the route, the zap form's shape shows with nothing
  // to type into, so no amount is lost and nothing moves when it lands. Once the probe settles with no
  // route (a basket without USDG, a vault the zap does not register, a failed probe) the card is in kind.
  const [mode, setMode] = useState<Mode>('zap');
  // The pay-with token, by address: it survives the candidate list re-forming on a poll; the default (USDG) leads it
  const [picked, setPicked] = useState<Address | null>(null);
  const route = routes.find((r) => r.token.address === picked) ?? routes[0];
  const active: Mode = !route && !routePending ? 'basket' : mode;
  const options = modeOptions(ctx, route, true);
  // On the zap the label names it, and what it does is on hover; in kind it is plain "Pay with"
  const label = active === 'zap' ? <Hint tip={ZAP_EXPLAINER} align="start" wide>Zap in</Hint> : 'Pay with';
  const choice = (
    <Field label={label}>
      <TokenChoice options={options} value={active} onChange={setMode} />
    </Field>
  );
  if (active === 'basket') return <BasketDepositForm key="basket" ctx={ctx} choice={choice} />;
  return route ? (
    <ZapDepositForm key="zap" ctx={ctx} routes={routes} route={route} onPick={(r) => setPicked(r.token.address)} choice={choice} initialAmount={initialAmount} />
  ) : (
    <ZapPendingForm key="zap-pending" ctx={ctx} choice={choice} />
  );
}

/** What the zap does: the tooltip on the "Zap in" label, over both the zap form and its pending shape. */
const ZAP_EXPLAINER =
  'The zap buys the other basket tokens on the route pool (TWAP-guarded), then makes the normal in-kind deposit — the vault itself never swaps. Leftovers come back to your wallet.';

/**
 * The zap deposit form's shape while the chain confirms the route: nothing to type into or press yet. The token
 * is the basket's USDG under its on-chain symbol; until the basket is read the box carries no token at all.
 */
function ZapPendingForm({ ctx: { vault: v }, choice }: { ctx: FormContext; choice: ReactNode }) {
  const symbol = zapAnchor(v)?.symbol;
  return (
    <div className="grid gap-4">
      {choice}

      <Field label="Amount">
        <AmountBox
          value=""
          onChange={() => {}}
          tokenLabel={symbol ?? ''}
          tokenIcon={symbol && <TokenIcon symbol={symbol} size={20} />}
          decimals={0}
          connected={false}
          disabled
          ariaLabel={symbol ? `${symbol} amount` : 'Amount'}
        />
      </Field>

      <YouReceive decimals={v.decimals} symbol={v.receipt.symbol} />

      <Button block variant="accent" disabled loading>
        {symbol ? `Checking the ${symbol} route…` : 'Checking the route…'}
      </Button>

      <div className="text-xs num">
        <DetailsFold disabled />
      </div>
    </div>
  );
}

function BasketDepositForm({ ctx, choice }: { ctx: FormContext; choice: ReactNode }) {
  const { vault: v, user, usdPrices, nav } = ctx;
  const { write } = useWallet();
  const pushToast = useStore((s) => s.pushToast);
  const { address, gate, loading, footer } = useWriteGate(v);

  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [slippage, setSlippage] = useState(String(DEFAULT_SLIPPAGE_BPS / 100));
  const [step, setStep] = useState<'form' | 'approving' | 'depositing'>('form');
  const [pendingToken, setPendingToken] = useState<Address | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [minted, setMinted] = useState<bigint | null>(null);

  const offer = useMemo(
    () => dispatchBasket(v.tokens.map((t, i) => ({ token: t.address, decimals: t.decimals, input: inputs[t.address] ?? '', total: v.totals[i] ?? 0n }))),
    [v.tokens, v.totals, inputs],
  );
  const preview = usePreviewDeposit(v, offer.tokens, offer.amounts, offer.ready);
  const slip = parseSlippageBps(slippage);
  const bps = slip.ok ? slip.bps : DEFAULT_SLIPPAGE_BPS;
  const minShares = minSharesFromPreview(preview.shares ?? 0n, bps);
  const required = preview.required ?? [];
  const needsApproval = tokensNeedingApproval(offer.tokens, required, user.allowances);
  // One rule for the red edge and the button: a field is short when its TYPED amount exceeds the wallet, or
  // when what the vault would PULL does (the preview) — the button names the first short field, the edges all of them
  const typedOver = (i: number) => {
    const parsed = parseAmount(inputs[v.tokens[i].address] ?? '', v.tokens[i].decimals);
    return Boolean(address) && parsed.ok && parsed.value > (user.balances[i] ?? 0n);
  };
  const pulledShort = insufficientBalance(offer.tokens, required, user.balances);
  const isShort = (i: number) => typedOver(i) || pulledShort === v.tokens[i].address;
  const shortAt = basketOrderIndices(v.tokens).find(isShort);
  const short = shortAt === undefined ? null : v.tokens[shortAt].address;
  const errCtx = errorContext(v);
  const symbolOf = (a: Address) => v.tokens.find((t) => t.address === a)?.symbol ?? 'token';
  const busy = step !== 'form';

  const approveNext = async () => {
    const token = needsApproval[0];
    if (!token) return;
    const i = offer.tokens.indexOf(token);
    setError(null);
    setStep('approving');
    setPendingToken(token);
    try {
      // Approve the MAX offered (≥ what the vault will pull), so a basket that shifts between the
      // preview and the transaction does not strand the deposit on a stale allowance.
      const hash = await write({ chainId: v.chainId, address: token, abi: erc20Abi, functionName: 'approve', args: [v.address, offer.amounts[i] ?? 0n] });
      await waitForReceipt(v.chainId, hash);
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
    const shown = preview.shares;
    if (!address || shown === undefined || minShares === 0n) return;
    setError(null);
    setStep('depositing');
    try {
      // minShares is quoted NOW, from a fresh preview — not from whatever was on screen.
      const [fresh] = await readContract(publicClientFor(v.chainId), {
        address: v.address,
        abi: vaultAbi,
        functionName: 'previewDeposit',
        args: [offer.tokens, offer.amounts],
      });
      if (fresh < minSharesFromPreview(shown, bps)) {
        preview.refetch();
        setError(`The quote moved past your ${bps / 100}% tolerance since it was shown (now ${formatAmountSignificant(fresh, v.decimals)} ${v.receipt.symbol}). Review it and deposit again.`);
        setStep('form');
        return;
      }
      const hash = await write({
        chainId: v.chainId,
        address: v.address,
        abi: vaultAbi,
        functionName: 'deposit',
        args: [offer.tokens, offer.amounts, minSharesFromPreview(fresh, bps), address],
      });
      const receipt = await waitForReceipt(v.chainId, hash);
      const shares = (parseEventLogs({ abi: vaultAbi, logs: receipt.logs, eventName: 'Deposited' })[0]?.args as { shares?: bigint } | undefined)?.shares ?? 0n;
      setMinted(shares);
      setInputs({});
      v.refetch();
      user.refetch();
      preview.refetch();
      pushToast({
        title: 'Deposit confirmed',
        detail: `Minted ${formatAmountSignificant(shares, v.decimals)} ${v.receipt.symbol} from ${vaultName(v)} on ${chainLabel(v.chainId)}`,
        tone: 'success',
      });
    } catch (err) {
      setError(describeChainError(err, errCtx));
    } finally {
      setStep('form');
    }
  };

  // Button state machine — the button is the guidance, one action at a time, in contract order.
  let cta: Cta;
  if (gate) cta = gate;
  else if (Object.keys(offer.errors).length > 0) cta = idle('Fix the amounts');
  else if (offer.hasMissingAmount) cta = idle(v.tokens.length > 1 ? 'Enter an amount for every token' : 'Enter an amount');
  else if (short) cta = idle(`Insufficient ${symbolOf(short)}`);
  else if (preview.error) cta = idle('Deposit not possible');
  else if (preview.shares === undefined) cta = idle('Previewing…');
  else if (!slip.ok) cta = idle('Fix the slippage tolerance');
  else if (needsApproval.length > 0) cta = { label: `Approve ${symbolOf(needsApproval[0])}`, disabled: false, onClick: () => void approveNext() };
  else cta = { label: v.tokens.length > 1 ? `Deposit ${v.tokens.length} tokens` : 'Deposit', disabled: false, onClick: () => void submit() };

  const sharesUsd = preview.shares !== undefined && nav !== undefined ? whole(preview.shares, v.decimals) * nav : undefined;
  const previewError = preview.error ? describeChainError(preview.error, errCtx) : null;

  return (
    <div className="grid gap-4">
      {choice}

      <Field label={<Hint tip={MIX_EXPLAINER} align="start" wide>Amount</Hint>}>
        <div className="space-y-2">
          {basketOrderIndices(v.tokens).map((i, pos) => {
            const t = v.tokens[i];
            const parsed = parseAmount(inputs[t.address] ?? '', t.decimals);
            const price = usdPrices.get(t.address.toLowerCase());
            const balance = user.balances[i] ?? 0n;
            return (
              <AmountBox
                key={t.address}
                value={inputs[t.address] ?? ''}
                onChange={(s) => { setInputs((x) => fillAtMix(v.tokens, v.totals, x, i, s, address ? user.balances : undefined)); setMinted(null); }}
                tokenLabel={t.symbol}
                tokenIcon={<TokenIcon symbol={t.symbol} size={20} />}
                balance={balance}
                decimals={t.decimals}
                connected={Boolean(address)}
                usd={parsed.ok && price !== undefined ? whole(parsed.value, t.decimals) * price : undefined}
                autoFocus={pos === 0}
                // Red as soon as a field asks for more than the wallet holds, before the preview lands
                error={offer.errors[t.address] ?? (isShort(i) ? true : undefined)}
                ariaLabel={`${t.symbol} amount`}
              />
            );
          })}
        </div>
      </Field>

      <YouReceive shares={preview.shares} decimals={v.decimals} symbol={v.receipt.symbol} usd={sharesUsd} />

      {previewError && <Message tone="warn">{previewError}</Message>}
      {error && <Message tone="error">{error}</Message>}
      {minted !== null && <Message tone="ok">Deposited. Minted {formatAmountSignificant(minted, v.decimals)} {v.receipt.symbol}.</Message>}

      <Button block variant="accent" onClick={cta.onClick} disabled={cta.disabled || busy} loading={busy || loading}>
        {step === 'approving' ? `Approving ${pendingToken ? symbolOf(pendingToken) : ''}…` : step === 'depositing' ? 'Depositing…' : cta.label}
      </Button>
      {footer}

      <div className="text-xs num">
        <DetailsFold>
          {priceRow(nav, v.receipt.symbol)}
          <Row k="Slippage tolerance" v={<PercentInput value={slippage} onChange={setSlippage} error={!slip.ok} ariaLabel="Slippage tolerance in percent" />} />
          <Row k="Minimum received" v={slip.ok ? `${formatAmountSignificant(minShares, v.decimals)} ${v.receipt.symbol}` : <span className="text-error">{slip.error}</span>} />
          <Row k="Offers" v="Maximums · only what is required is pulled" />
          <Row k="Performance fee" v={`${feeLabel(v.performanceFeeBps)} of harvested fees`} />
          <Row k="Lock-up" v="None · redeem anytime" />
        </DetailsFold>
      </div>
    </div>
  );
}

function ZapDepositForm({ ctx, routes, route, onPick, choice, initialAmount }: { ctx: FormContext; routes: ZapRoute[]; route: ZapRoute; onPick: (r: ZapRoute) => void; choice: ReactNode; initialAmount?: string }) {
  const { vault: v, user, usdPrices, nav } = ctx;
  const { write } = useWallet();
  const pushToast = useStore((s) => s.pushToast);
  const { address, gate, loading, footer } = useWriteGate(v);
  const picked = Math.max(routes.indexOf(route), 0);
  const token = route.token;

  const [value, setValue] = useState(initialAmount ?? '');
  const [slippage, setSlippage] = useState(String(ZAP_DEFAULT_SLIPPAGE_BPS / 100));
  const [step, setStep] = useState<'form' | 'approving' | 'zapping'>('form');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ shares: bigint; refunded: bigint } | null>(null);

  // The ≈ $ price the box shows also sizes the dust floor and the size warning (whole tokens without one)
  const price = usdPrices.get(token.address.toLowerCase());
  const parsed = parseZapDepositAmount(value, token.decimals, token.symbol, price);
  const amountIn = parsed?.ok ? parsed.value : 0n;
  const slip = parseZapSlippage(slippage);
  const bps = slip.ok ? slip.bps : ZAP_DEFAULT_SLIPPAGE_BPS;
  const legBps = ZAP_LEG_SLIPPAGE_BPS;
  const preview = usePreviewZap(v, route.zap, token.address, amountIn, legBps, parsed?.ok === true && slip.ok);
  const minShares = zapMinimum(preview.shares ?? 0n, bps);
  const { allowance, refetch: refetchAllowance } = useZapAllowance(v, token.address, address ?? undefined, route.zap);
  const balance = user.balances[route.index] ?? 0n;
  const needsApproval = tokensNeedingApproval([token.address], [amountIn], [allowance]).length > 0;
  const short = insufficientBalance([token.address], [amountIn], [balance]);
  const sizeWarning = zapSizeWarning(amountIn, token.decimals, token.symbol, price);
  const errCtx = errorContext(v, route);
  const busy = step !== 'form';

  const approve = async () => {
    setError(null);
    setStep('approving');
    try {
      // Exactly the offer, to the zap (not the vault): the zap pulls the whole amount and refunds dust.
      const hash = await write({ chainId: v.chainId, address: token.address, abi: erc20Abi, functionName: 'approve', args: [route.zap, amountIn] });
      await waitForReceipt(v.chainId, hash);
      refetchAllowance();
      pushToast({ title: `${token.symbol} approved`, detail: 'The zap may now pull this amount.', tone: 'success' });
    } catch (err) {
      setError(describeZapError(err, errCtx));
    } finally {
      setStep('form');
    }
  };

  const submit = async () => {
    const shown = preview.shares;
    if (!address || shown === undefined || minShares === 0n) return;
    setError(null);
    setStep('zapping');
    try {
      const [, , fresh] = await readContract(publicClientFor(v.chainId), {
        address: route.zap,
        abi: zapInCallAbi,
        functionName: 'previewZap',
        args: [v.address, token.address, amountIn, legBps],
      });
      if (fresh < zapMinimum(shown, bps)) {
        preview.refetch();
        setError(`The quote moved past your ${bps / 100}% tolerance since it was shown (now ${formatAmountSignificant(fresh, v.decimals)} ${v.receipt.symbol}). Review it and deposit again.`);
        return;
      }
      const hash = await write({
        chainId: v.chainId,
        address: route.zap,
        abi: zapInCallAbi,
        functionName: 'zapDeposit',
        args: [v.address, token.address, amountIn, zapMinimum(fresh, bps), legBps, address],
      });
      const receipt = await waitForReceipt(v.chainId, hash);
      const shares = (parseEventLogs({ abi: zapInAbi, logs: receipt.logs, eventName: 'ZapDeposited' })[0]?.args as { shares?: bigint } | undefined)?.shares ?? 0n;
      const refunded = parseEventLogs({ abi: zapInAbi, logs: receipt.logs, eventName: 'ZapRefunded' })
        .filter((e) => (e.args as { token: Address }).token.toLowerCase() === token.address.toLowerCase())
        .reduce((sum, e) => sum + (e.args as { amount: bigint }).amount, 0n);
      setResult({ shares, refunded });
      setValue('');
      v.refetch();
      user.refetch();
      refetchAllowance();
      preview.refetch();
      pushToast({
        title: 'Zap deposit confirmed',
        detail: `Minted ${formatAmountSignificant(shares, v.decimals)} ${v.receipt.symbol} from ${formatAmount(amountIn, token.decimals, 6)} ${token.symbol} into ${vaultName(v)} on ${chainLabel(v.chainId)}`,
        tone: 'success',
      });
    } catch (err) {
      setError(describeZapError(err, errCtx));
    } finally {
      setStep('form');
    }
  };

  let cta: Cta;
  if (gate) cta = gate;
  else if (parsed && !parsed.ok) cta = idle('Fix the amount');
  else if (!parsed) cta = idle(`Enter a ${token.symbol} amount`);
  else if (!slip.ok) cta = idle('Fix the slippage tolerance');
  else if (short) cta = idle(`Insufficient ${token.symbol}`);
  else if (preview.error) cta = idle('Zap not possible');
  else if (preview.shares === undefined) cta = idle('Previewing…');
  else if (needsApproval) cta = { label: `Approve ${token.symbol} for the zap`, disabled: false, onClick: () => void approve() };
  else cta = { label: `Deposit ${formatAmount(amountIn, token.decimals, 6)} ${token.symbol}`, disabled: false, onClick: () => void submit() };

  const sharesUsd = preview.shares !== undefined && nav !== undefined ? whole(preview.shares, v.decimals) * nav : undefined;
  const kept = preview.offers?.[route.index];
  const bought = v.tokens.map((t, i) => ({ t, amount: preview.offers?.[i] ?? 0n, i })).filter((x) => x.i !== route.index && x.amount > 0n);
  const previewError = preview.error ? describeZapError(preview.error, errCtx) : null;

  return (
    <div className="grid gap-4">
      {choice}

      <Field label="Amount">
        <AmountBox
          value={value}
          onChange={(s) => { setValue(s); setResult(null); }}
          tokenLabel={token.symbol}
          picker={
            <TokenPicker
              tokens={routes.map((r) => r.token)}
              balances={routes.map((r) => user.balances[r.index] ?? 0n)}
              value={picked}
              onChange={(i) => { if (i !== picked) { onPick(routes[i]); setValue(''); setResult(null); setError(null); } }}
              connected={Boolean(address)}
            />
          }
          balance={balance}
          decimals={token.decimals}
          connected={Boolean(address)}
          usd={price !== undefined ? whole(amountIn, token.decimals) * price : undefined}
          autoFocus
          error={parsed && !parsed.ok ? parsed.error : short ? true : undefined}
          note={needsApproval && parsed?.ok ? `Approved for the zap: ${formatAmount(allowance, token.decimals, 6)}` : undefined}
          ariaLabel={`${token.symbol} amount`}
        />
      </Field>

      <YouReceive shares={preview.shares} decimals={v.decimals} symbol={v.receipt.symbol} usd={sharesUsd} />

      {sizeWarning && <Message tone="warn">{sizeWarning}</Message>}
      {previewError && <Message tone="warn">{previewError}</Message>}
      {error && <Message tone="error">{error}</Message>}
      {result && (
        <Message tone="ok">
          Deposited. Minted {formatAmountSignificant(result.shares, v.decimals)} {v.receipt.symbol}
          {result.refunded > 0n ? ` · ${formatAmount(result.refunded, token.decimals, 6)} ${token.symbol} refunded` : ''}.
        </Message>
      )}

      <Button block variant="accent" onClick={cta.onClick} disabled={cta.disabled || busy} loading={busy || loading}>
        {step === 'approving' ? `Approving ${token.symbol}…` : step === 'zapping' ? 'Zapping…' : cta.label}
      </Button>
      {footer}

      <div className="text-xs num">
        <DetailsFold>
          {priceRow(nav, v.receipt.symbol)}
          {kept !== undefined && bought.length > 0 && (
            <Row k="Auto-swap" v={`${formatAmount(amountIn - kept, token.decimals, 6)} ${token.symbol} → ${bought.map((x) => `${formatAmount(x.amount, x.t.decimals, 6)} ${x.t.symbol}`).join(' + ')}`} />
          )}
          <Row k="Slippage tolerance" v={<PercentInput value={slippage} onChange={setSlippage} error={!slip.ok} ariaLabel="Zap slippage tolerance in percent" />} />
          <Row k="Minimum received" v={slip.ok ? `${formatAmountSignificant(minShares, v.decimals)} ${v.receipt.symbol}` : <span className="text-error">{slip.error}</span>} />
          <Row k="Performance fee" v={`${feeLabel(v.performanceFeeBps)} of harvested fees`} />
          <Row k="Lock-up" v="None · redeem anytime" />
        </DetailsFold>
        {slip.ok && slip.clamped && <p className="mt-2 text-2xs text-warning">Capped at the maximum of {ZAP_MAX_SLIPPAGE_BPS / 100}%.</p>}
        {/* Under the fold, not inside it: it says what the swap is allowed, so it always shows */}
        <p className="mt-2 text-2xs text-weaker">
          Each swap leg is bounded by its route’s own cap (up to {route.maxLegSlippageBps / 100}% off the TWAP); your tolerance bounds the minimum received.
        </p>
      </div>
    </div>
  );
}

// ───────────────────────── Withdraw ─────────────────────────

function WithdrawForm({ ctx, route }: { ctx: FormContext; route: ZapRoute | undefined }) {
  const [mode, setMode] = useState<Mode>('basket');
  const options = modeOptions(ctx, route);
  const active = route && mode === 'zap' ? 'zap' : 'basket';
  const choice = (
    <Field label="Receive in">
      <TokenChoice options={options} value={active} onChange={setMode} />
    </Field>
  );
  return active === 'zap' && route ? <ZapWithdrawForm key="zap" ctx={ctx} route={route} choice={choice} /> : <BasketWithdrawForm key="basket" ctx={ctx} choice={choice} />;
}

/** The receipt-token amount box both withdraw facets share. */
function SharesBox({ ctx, value, onChange, error, connected }: { ctx: FormContext; value: string; onChange: (s: string) => void; error?: string | boolean; connected: boolean }) {
  const { vault: v, symbols, user, nav } = ctx;
  const parsed = parseAmount(value, v.decimals);
  return (
    <AmountBox
      value={value}
      onChange={onChange}
      tokenLabel={v.receipt.symbol}
      tokenIcon={<TokenGroup symbols={symbols} size={18} />}
      balance={user.shares}
      decimals={v.decimals}
      connected={connected}
      usd={parsed.ok && nav !== undefined ? whole(parsed.value, v.decimals) * nav : undefined}
      error={error}
      ariaLabel={`${v.receipt.symbol} amount to withdraw`}
    />
  );
}

function BasketWithdrawForm({ ctx, choice }: { ctx: FormContext; choice: ReactNode }) {
  const { vault: v, user, usdPrices } = ctx;
  const { write } = useWallet();
  const pushToast = useStore((s) => s.pushToast);
  const { address, gate, loading, footer } = useWriteGate(v);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [received, setReceived] = useState<bigint[] | null>(null);

  const parsed = value.trim() === '' ? null : parseAmount(value, v.decimals);
  const shares = parsed?.ok ? parsed.value : 0n;
  const parseError = parsed && !parsed.ok ? parsed.error : undefined;
  const tooMany = shares > user.shares;
  const preview = usePreviewRedeem(v, shares, shares > 0n && !tooMany);
  const errCtx = errorContext(v);

  const submit = async () => {
    if (!address || shares === 0n) return;
    setError(null);
    setReceived(null);
    setBusy(true);
    try {
      const hash = await write({ chainId: v.chainId, address: v.address, abi: vaultAbi, functionName: 'redeem', args: [shares, address] });
      const receipt = await waitForReceipt(v.chainId, hash);
      const amounts = (parseEventLogs({ abi: vaultAbi, logs: receipt.logs, eventName: 'Redeemed' })[0]?.args as { amounts?: readonly bigint[] } | undefined)?.amounts;
      setReceived(amounts ? [...amounts] : null);
      setValue('');
      v.refetch();
      user.refetch();
      pushToast({
        title: 'Withdrawal confirmed',
        detail: `Burned ${formatAmountSignificant(shares, v.decimals)} ${v.receipt.symbol} from ${vaultName(v)} on ${chainLabel(v.chainId)}`,
        tone: 'success',
      });
    } catch (err) {
      setError(describeChainError(err, errCtx));
    } finally {
      setBusy(false);
    }
  };

  let cta: Cta;
  if (gate) cta = gate;
  else if (user.shares === 0n) cta = idle('Nothing to withdraw');
  else if (parseError) cta = idle('Fix the amount');
  else if (shares === 0n) cta = idle('Enter an amount');
  else if (tooMany) cta = idle(`Insufficient ${v.receipt.symbol}`);
  else cta = { label: 'Withdraw in kind', disabled: false, onClick: () => void submit() };

  const owed = preview.owed;
  const owedUsd = owed?.reduce<number | undefined>((sum, a, i) => {
    const p = usdPrices.get(v.tokens[i]?.address.toLowerCase() ?? '');
    return sum === undefined || p === undefined ? undefined : sum + whole(a, v.tokens[i].decimals) * p;
  }, 0);

  return (
    <div className="grid gap-4">
      {choice}
      <Field label="Amount">
        <SharesBox ctx={ctx} value={value} onChange={(s) => { setValue(s); setReceived(null); }} error={parseError ?? (tooMany ? 'More than you hold' : undefined)} connected={Boolean(address)} />
      </Field>
      <Field label="Receive">
        <div className="grid gap-2 border-t border-stroke-strong pt-3 num">
          <div className="display num text-2xl text-strong">
            {owed ? basketOrderIndices(v.tokens).map((i) => `${formatAmount(owed[i] ?? 0n, v.tokens[i].decimals, 6)} ${v.tokens[i].symbol}`).join(' + ') : <span className="text-weaker">0</span>}
          </div>
          <div className="text-xs text-weaker">{owed && owedUsd !== undefined ? `≈ ${fmtUsd(owedUsd, { compact: false, cents: true })} at spot · no withdrawal fee` : 'No lock-up. Redeem anytime, in kind.'}</div>
        </div>
      </Field>
      {preview.error && <Message tone="warn">{describeChainError(preview.error, errCtx)}</Message>}
      {error && <Message tone="error">{error}</Message>}
      {received && (
        <Message tone="ok">Withdrawn. {basketOrderIndices(v.tokens).map((i) => `${formatAmount(received[i] ?? 0n, v.tokens[i].decimals, 6)} ${v.tokens[i].symbol}`).join(' + ')} sent to your wallet.</Message>
      )}
      <Button block variant="secondary" onClick={cta.onClick} disabled={cta.disabled || busy} loading={busy || loading}>
        {busy ? 'Withdrawing…' : cta.label}
      </Button>
      {footer}
    </div>
  );
}

function ZapWithdrawForm({ ctx, route, choice }: { ctx: FormContext; route: ZapRoute; choice: ReactNode }) {
  const { vault: v, user } = ctx;
  const { write } = useWallet();
  const pushToast = useStore((s) => s.pushToast);
  const { address, gate, loading, footer } = useWriteGate(v);
  const token = route.token;

  const [value, setValue] = useState('');
  const [slippage, setSlippage] = useState(String(ZAP_DEFAULT_SLIPPAGE_BPS / 100));
  const [step, setStep] = useState<'form' | 'approving' | 'redeeming'>('form');
  const [error, setError] = useState<string | null>(null);
  const [received, setReceived] = useState<bigint | null>(null);

  const parsed = parseZapRedeemShares(value, v.decimals, user.shares);
  const shares = parsed?.ok ? parsed.value : 0n;
  const slip = parseZapSlippage(slippage);
  const bps = slip.ok ? slip.bps : ZAP_DEFAULT_SLIPPAGE_BPS;
  const legBps = ZAP_LEG_SLIPPAGE_BPS;
  const preview = usePreviewZapRedeem(v, route.zap, token.address, shares, legBps, parsed?.ok === true && slip.ok);
  const minOut = zapMinimum(preview.amountOut ?? 0n, bps);
  const { allowance, refetch: refetchAllowance } = useZapAllowance(v, v.address, address ?? undefined, route.zap);
  const needsApproval = tokensNeedingApproval([v.address], [shares], [allowance]).length > 0;
  const passThrough = v.tokens.map((t, i) => ({ t, amount: preview.passThrough?.[i] ?? 0n })).filter((x) => x.amount > 0n);
  const errCtx = errorContext(v, route);
  const busy = step !== 'form';

  const approve = async () => {
    setError(null);
    setStep('approving');
    try {
      // The receipt token is the vault itself; the zap pulls exactly these shares.
      const hash = await write({ chainId: v.chainId, address: v.address, abi: erc20Abi, functionName: 'approve', args: [route.zap, shares] });
      await waitForReceipt(v.chainId, hash);
      refetchAllowance();
      pushToast({ title: `${v.receipt.symbol} approved`, detail: 'The zap may now pull these shares.', tone: 'success' });
    } catch (err) {
      setError(describeZapError(err, errCtx));
    } finally {
      setStep('form');
    }
  };

  const submit = async () => {
    const shown = preview.amountOut;
    if (!address || shares === 0n || shown === undefined || minOut === 0n) return;
    setError(null);
    setReceived(null);
    setStep('redeeming');
    try {
      const [, , fresh] = await readContract(publicClientFor(v.chainId), {
        address: route.zap,
        abi: zapOutCallAbi,
        functionName: 'previewRedeem',
        args: [v.address, token.address, shares, legBps],
      });
      if (fresh < zapMinimum(shown, bps)) {
        setError(`The quote moved past your ${bps / 100}% tolerance since it was shown (now ${formatAmount(fresh, token.decimals, 6)} ${token.symbol}). Review it and withdraw again.`);
        return;
      }
      const hash = await write({
        chainId: v.chainId,
        address: route.zap,
        abi: zapOutCallAbi,
        functionName: 'zapRedeem',
        args: [v.address, token.address, shares, zapMinimum(fresh, bps), legBps, address],
      });
      const receipt = await waitForReceipt(v.chainId, hash);
      const amountOut = (parseEventLogs({ abi: zapOutAbi, logs: receipt.logs, eventName: 'ZapRedeemed' })[0]?.args as { amountOut?: bigint } | undefined)?.amountOut ?? 0n;
      setReceived(amountOut);
      setValue('');
      v.refetch();
      user.refetch();
      refetchAllowance();
      pushToast({
        title: 'Zap withdrawal confirmed',
        detail: `Burned ${formatAmountSignificant(shares, v.decimals)} ${v.receipt.symbol} for ${formatAmount(amountOut, token.decimals, 6)} ${token.symbol} from ${vaultName(v)} on ${chainLabel(v.chainId)}`,
        tone: 'success',
      });
    } catch (err) {
      setError(describeZapError(err, errCtx));
    } finally {
      setStep('form');
    }
  };

  let cta: Cta;
  if (gate) cta = gate;
  else if (user.shares === 0n) cta = idle('Nothing to withdraw');
  else if (parsed && !parsed.ok) cta = idle(parsed.error === 'More than you hold' ? `Insufficient ${v.receipt.symbol}` : 'Fix the amount');
  else if (!parsed) cta = idle('Enter an amount');
  else if (!slip.ok) cta = idle('Fix the slippage tolerance');
  else if (preview.error) cta = idle('Zap not possible');
  else if (preview.amountOut === undefined) cta = idle('Previewing…');
  else if (needsApproval) cta = { label: `Approve ${v.receipt.symbol} for the zap`, disabled: false, onClick: () => void approve() };
  else cta = { label: `Withdraw to ${token.symbol}`, disabled: false, onClick: () => void submit() };

  return (
    <div className="grid gap-4">
      {choice}
      <Field label="Amount">
        <SharesBox ctx={ctx} value={value} onChange={(s) => { setValue(s); setReceived(null); }} error={parsed && !parsed.ok ? parsed.error : undefined} connected={Boolean(address)} />
      </Field>
      <Field label="Receive">
        <div className="grid gap-2 border-t border-stroke-strong pt-3 num">
          <div className="display num text-2xl text-strong">
            {preview.amountOut !== undefined ? `${formatAmount(preview.amountOut, token.decimals, 6)} ${token.symbol}` : <span className="text-weaker">0</span>}
          </div>
          <div className="text-xs text-weaker">
            {passThrough.length > 0
              ? `Plus in kind (no route / dust): ${passThrough.map((x) => `${formatAmount(x.amount, x.t.decimals, 6)} ${x.t.symbol}`).join(' + ')}`
              : 'Redeemed in kind, the rest sold into ' + token.symbol + ' by the zap.'}
          </div>
        </div>
      </Field>
      {preview.error && <Message tone="warn">{describeZapError(preview.error, errCtx)}</Message>}
      {error && <Message tone="error">{error}</Message>}
      {received !== null && <Message tone="ok">Withdrawn. {formatAmount(received, token.decimals, 6)} {token.symbol} sent to your wallet.</Message>}
      <Button block variant="secondary" onClick={cta.onClick} disabled={cta.disabled || busy} loading={busy || loading}>
        {step === 'approving' ? `Approving ${v.receipt.symbol}…` : step === 'redeeming' ? 'Withdrawing…' : cta.label}
      </Button>
      {footer}
      <div className="text-xs num">
        <DetailsFold>
          <Row k="Slippage tolerance" v={<PercentInput value={slippage} onChange={setSlippage} error={!slip.ok} ariaLabel="Zap withdraw slippage tolerance in percent" />} />
          <Row k="Minimum received" v={slip.ok ? `${formatAmount(minOut, token.decimals, 6)} ${token.symbol}` : <span className="text-error">{slip.error}</span>} />
        </DetailsFold>
        {slip.ok && slip.clamped && <p className="mt-2 text-2xs text-warning">Capped at the maximum of {ZAP_MAX_SLIPPAGE_BPS / 100}%.</p>}
      </div>
    </div>
  );
}

/**
 * The card for one live vault row (Markets / the vault page): reads that vault — not the header's
 * target — and the connected wallet's basket on its chain, and prices the ≈ $ hints at the row's
 * live spots and spot NAV.
 */
export function VaultDepositCard({ row, spots, initialAmount, showVaultLink }: { row: LiveVaultRow; spots: ChainSpots; initialAmount?: string; showVaultLink?: boolean }) {
  const { address } = useWallet();
  // Seeded from the row Markets already read, so the overlay opens on the basket instead of re-reading it
  const vault = useLiveVaultAt(row.v.chainId, row.v.entry, row.v);
  const user = useUserBasket(address ?? undefined, vault);
  const usdPrices = useMemo(() => tokenUsdPrices(row.v.tokens, spots.spots), [row.v.tokens, spots.spots]);
  return <DepositCard vault={vault} user={user} usdPrices={usdPrices} nav={row.nav} initialAmount={initialAmount} showVaultLink={showVaultLink} />;
}
