import { useRef, useState } from 'react';
import { useWallet } from '@/wallet/context';
import { useStore } from '@/store/useStore';
import { Button } from '@/components/ui/Button';
import { POPOVER_PANEL, useDismiss } from '@/components/ui/Popover';
import { cx, shortAddress } from '@/lib/format';
import { NetworkManual } from '@/components/live/NetworkManual';
import { useConnectWallet, useDisconnectWallet } from '@/chain/useConnectWallet';
import { chainLabel } from '@/chain/chains';
import { describeSwitchError } from '@/chain/switchChain';
import { useSwitchToChain, useTargetChain } from '@/chain/useTargetChain';

export function WalletButton() {
  const storeAddress = useStore((s) => s.address);
  const { address, chainId, walletName } = useWallet();
  const { chain: target, isWrongChain: wrongChain } = useTargetChain();
  const { switchTo, switching, error } = useSwitchToChain();
  const { connectWallet, isPending } = useConnectWallet();
  const disconnectAll = useDisconnectWallet();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useDismiss(ref, open, setOpen);

  if (!storeAddress) {
    return (
      <Button size="sm" className="sm:!px-4" onClick={connectWallet} loading={isPending}>
        {isPending ? 'Connecting' : 'Connect wallet'}
      </Button>
    );
  }

  return (
    <div className="relative" ref={ref}>
      <Button variant="secondary" size="sm" onClick={() => setOpen(!open)} className={cx('sm:!px-4', wrongChain && 'btn-glass-warning')}>
        <span className="flex items-center gap-2 font-mono text-xs font-normal">
          {/* The wallet mark takes the label's colour while the wallet reports the account, grey while it is mid-switch. */}
          <svg
            viewBox="0 0 16 16"
            className={cx('h-4 w-4 shrink-0', !address && 'text-weaker')}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden
          >
            <path d="M1.75 5.75h12.5v7.5H1.75zM1.75 5.75v-3h10v3" />
            <path d="M10 8.5h2v2h-2z" fill="currentColor" stroke="none" />
          </svg>
          {shortAddress(storeAddress)}
          {wrongChain && <span className="text-warning">!</span>}
        </span>
      </Button>
      {open && (
        <div className={cx(POPOVER_PANEL, 'w-72 p-3')}>
          <div className="text-2xs text-weaker mb-2 num break-all">{storeAddress}</div>

          {address ? (
            <div className="mb-3 rounded border border-stroke-strong bg-background-elevated px-3 py-2">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="text-weaker">Wallet</span>
                <span className="text-strong">{walletName ?? 'Browser wallet'}</span>
              </div>
              <div className="flex items-center justify-between gap-2 text-xs mt-1">
                <span className="text-weaker">Network</span>
                <span className={cx('num', wrongChain ? 'text-warning' : 'text-strong')}>{chainLabel(chainId)}</span>
              </div>
              {wrongChain && (
                <div className="mt-2">
                  <Button size="sm" block loading={switching} onClick={() => void switchTo(target.id).catch(() => {})}>
                    Switch to {target.name}
                  </Button>
                  {/* A wallet that refuses is the common case on mobile WalletConnect: say why, with
                      the params needed to add the network by hand. Without this the press looked like
                      it did nothing at all. */}
                  {error && (
                    <p className="mt-2 text-2xs leading-snug text-warning break-words">
                      {describeSwitchError(error, target)}
                    </p>
                  )}
                  {/* The manual-add parameters are always one tap away — not only after a failed
                      attempt: many mobile wallets cannot be moved over WalletConnect at all. */}
                  <div className="mt-2">
                    <NetworkManual chainId={target.id} />
                  </div>
                </div>
              )}
            </div>
          ) : null}

          <div className="mt-3 pt-2 border-t border-stroke-strong">
            <Button variant="secondary" size="sm" block onClick={() => { disconnectAll(); setOpen(false); }}>
              Disconnect
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

