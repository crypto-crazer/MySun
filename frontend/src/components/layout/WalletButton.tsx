import { useEffect, useRef, useState } from 'react';
import { useWallet } from '@/wallet/context';
import { useStore } from '@/store/useStore';
import { Button } from '@/components/ui/Button';
import { CONSTANTS, DEMO_ADDRESS } from '@/demo/constants';
import { cx, fmtToken, fmtUsd, shortAddress } from '@/lib/format';
import { TokenIcon } from '@/components/ui/TokenIcon';
import { TOKEN_PRICES } from '@/demo/data/vaults';
import { DemoBadge } from '@/components/ui/DataBadge';
import { useConnectWallet, useDisconnectWallet } from '@/chain/useConnectWallet';
import { chainLabel } from '@/chain/chains';
import { useSwitchToChain, useTargetChain } from '@/chain/useTargetChain';
import { useLiveVault, useUserBasket } from '@/chain/useVault';
import { formatAmount, formatAmountSignificant } from '@/chain/amounts';

export function WalletButton() {
  const connected = useStore((s) => s.connected);
  const storeAddress = useStore((s) => s.address);
  const demoWallet = useStore((s) => s.demoWallet);
  const balances = useStore((s) => s.user.balances);
  const { address, chainId, walletName } = useWallet();
  const { chain: target, isWrongChain: wrongChain } = useTargetChain();
  const { switchTo, switching } = useSwitchToChain();
  const { connectWallet, isPending } = useConnectWallet();
  const disconnectAll = useDisconnectWallet();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  if (!connected) {
    return (
      <Button size="sm" className="sm:!px-4" onClick={connectWallet} loading={isPending}>
        {isPending ? 'Connecting' : 'Connect wallet'}
      </Button>
    );
  }

  const shown = storeAddress ?? DEMO_ADDRESS;

  return (
    <div className="relative" ref={ref}>
      <Button variant="secondary" size="sm" onClick={() => setOpen(!open)} className={cx('sm:!px-4', wrongChain && 'btn-glass-warning')}>
        <span className="flex items-center gap-2.5 font-mono text-xs font-normal">
          {/* The wallet mark takes the colour the status dot had: green on a real connection, grey on the demo wallet. */}
          <svg
            viewBox="0 0 16 16"
            className={cx('h-4 w-4 shrink-0', address ? 'text-success' : 'text-weaker')}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden
          >
            <path d="M1.75 5.75h12.5v7.5H1.75zM1.75 5.75v-3h10v3" />
            <path d="M10 8.5h2v2h-2z" fill="currentColor" stroke="none" />
          </svg>
          {shortAddress(shown)}
          {wrongChain && <span className="text-warning">!</span>}
        </span>
      </Button>
      {open && (
        <div className="absolute right-0 top-full mt-2 w-72 bg-background-popover border border-stroke-strong rounded-md shadow-pop p-3 animate-fade-in z-40">
          <div className="text-2xs text-weaker mb-2 num break-all">{shown}</div>

          {address ? (
            <div className="mb-3 rounded border border-stroke-weak bg-background-elevated px-2.5 py-2">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="text-weaker">Wallet</span>
                <span className="text-strong">{walletName ?? 'Browser wallet'}</span>
              </div>
              <div className="flex items-center justify-between gap-2 text-xs mt-1">
                <span className="text-weaker">Network</span>
                <span className={cx('num', wrongChain ? 'text-warning' : 'text-strong')}>{chainLabel(chainId)}</span>
              </div>
              {wrongChain && (
                <Button size="sm" block className="mt-2" loading={switching} onClick={() => void switchTo(target.id).catch(() => {})}>
                  Switch to {target.name}
                </Button>
              )}
            </div>
          ) : (
            <div className="mb-3 rounded border border-stroke-warning/40 bg-fill-warning/10 px-2.5 py-2 text-2xs text-warning leading-snug">
              Demo wallet — no chain connection. Connect a browser wallet to use the live vault.
            </div>
          )}

          {address && <LiveBalances account={address} />}

          <div className="mt-3 pt-2 border-t border-stroke-weak">
            <div className="flex items-center justify-between mb-1">
              <span className="text-2xs text-weaker">Prototype balances</span>
              <DemoBadge />
            </div>
            <div className="divide-y divide-stroke-weak text-sm">
              <Row token="PMG" amount={balances.PMG ?? 0} usd={(balances.PMG ?? 0) * CONSTANTS.TIDE_PRICE} tide />
              <Row token="USDG" amount={balances.USDG ?? 0} usd={balances.USDG ?? 0} />
              <Row token="NVDA" amount={balances.NVDA ?? 0} usd={(balances.NVDA ?? 0) * TOKEN_PRICES.NVDA} />
            </div>
          </div>

          <Button variant="secondary" size="sm" block className="mt-3" onClick={() => { disconnectAll(); setOpen(false); }}>
            {demoWallet && !address ? 'Leave demo wallet' : 'Disconnect'}
          </Button>
        </div>
      )}
    </div>
  );
}

/** Real balances of the selected vault's basket + its receipt token. */
function LiveBalances({ account }: { account: `0x${string}` }) {
  const vault = useLiveVault();
  const user = useUserBasket(account, vault);
  if (!vault.hasDeployment || vault.error || vault.tokens.length === 0) return null;
  return (
    <div>
      <div className="text-2xs text-weaker mb-1 truncate">Live vault balances · {vault.entry?.label}</div>
      <div className="divide-y divide-stroke-weak text-sm">
        <div className="flex items-center justify-between py-2">
          <span className="text-weak">{vault.receipt.symbol}</span>
          <span className="num font-medium">{formatAmountSignificant(user.shares, vault.decimals)}</span>
        </div>
        {vault.tokens.map((t, i) => (
          <div key={t.address} className="flex items-center justify-between py-2">
            <span className="text-weak">{t.symbol}</span>
            <span className="num font-medium">{formatAmount(user.balances[i] ?? 0n, t.decimals, 4)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Row({ token, amount, usd, tide }: { token: string; amount: number; usd: number; tide?: boolean }) {
  return (
    <div className="flex items-center justify-between py-2">
      <span className="inline-flex items-center gap-2 text-weak">
        <TokenIcon symbol={token} size={18} />
        {token}
      </span>
      <span className="text-right">
        <span className={tide ? 'text-accent num font-medium' : 'num font-medium'}>{fmtToken(amount)}</span>
        <span className="block text-2xs text-weaker num">{fmtUsd(usd, { compact: false, cents: true })}</span>
      </span>
    </div>
  );
}
