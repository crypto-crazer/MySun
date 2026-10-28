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
  const connected = useStore((s) => s.connected);
  const storeAddress = useStore((s) => s.address);
  const readOnlyMode = useStore((s) => s.readOnlyMode);
  const { address, chainId, walletName } = useWallet();
  const { chain: target, isWrongChain: wrongChain } = useTargetChain();
  const { switchTo, switching, error } = useSwitchToChain();
  const { connectWallet, isPending } = useConnectWallet();
  const disconnectAll = useDisconnectWallet();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useDismiss(ref, open, setOpen);

  if (!connected) {
    return (
      <Button size="sm" className="sm:!px-4" onClick={connectWallet} loading={isPending}>
        {isPending ? 'Connecting' : 'Connect wallet'}
      </Button>
    );
  }

  // Read-only mode has no account: say so rather than show an invented address.
  const shown = storeAddress ?? 'Read-only';

  return (
    <div className="relative" ref={ref}>
      <Button variant="secondary" size="sm" onClick={() => setOpen(!open)} className={cx('sm:!px-4', wrongChain && 'btn-glass-warning')}>
        <span className="flex items-center gap-2 font-mono text-xs font-normal">
          {/* The wallet mark takes the label's colour on a real connection, grey in read-only mode. */}
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
          {storeAddress ? shortAddress(storeAddress) : shown}
          {wrongChain && <span className="text-warning">!</span>}
        </span>
      </Button>
      {open && (
        <div className={cx(POPOVER_PANEL, 'w-72 p-3')}>
          <div className="text-2xs text-weaker mb-2 num break-all">{shown}</div>

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
          ) : (
            <div className="mb-3 rounded border border-stroke-warning/40 bg-fill-warning/10 px-3 py-2 text-2xs text-warning leading-snug">
              Read-only mode — no chain connection. Connect a browser wallet to deposit or withdraw.
            </div>
          )}

          <div className="mt-3 pt-2 border-t border-stroke-strong">
            <Button variant="secondary" size="sm" block onClick={() => { disconnectAll(); setOpen(false); }}>
              {readOnlyMode && !address ? 'Leave read-only mode' : 'Disconnect'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

