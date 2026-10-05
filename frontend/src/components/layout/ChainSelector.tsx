/**
 * Header network selector: every registry chain (SUPPORTED_CHAINS), the target chain ticked.
 * Picking one records it as the selected chain and, with a wallet connected, asks the wallet to
 * switch (adding the chain first if the wallet does not know it). Chains without a deployment are
 * listed — you can go there — but marked so nobody expects a vault.
 */
import { useEffect, useRef, useState } from 'react';
import { SUPPORTED_CHAINS, chainShortLabel, hasDeployment, isLocalChain } from '@/chain/chains';
import { useSwitchToChain, useTargetChain } from '@/chain/useTargetChain';
import { Button } from '@/components/ui/Button';
import { ChainLogo } from '@/components/ui/ChainLogo';
import { Spinner } from '@/components/ui/Spinner';
import { cx } from '@/lib/format';

export function ChainSelector() {
  const { chain, hasDeployment: deployed, isWrongChain } = useTargetChain();
  const { switchTo, switching } = useSwitchToChain();
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

  const warn = isWrongChain || !deployed;
  // The registry does not say whose chain it is, so the mark goes by name. Other chains show the status dot alone.
  const robinhood = /robinhood/i.test(chain.name);

  return (
    <div className="relative" ref={ref}>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => setOpen(!open)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Network: ${chain.name}`}
        title={isWrongChain ? 'Your wallet is on another network' : !deployed ? 'No MySun deployment on this network' : chain.name}
        className={cx('sm:!px-4', warn && 'btn-glass-warning')}
      >
        {/* flex, not inline-flex, here and on the mark: an inline box sits on the label's text line and ends up above centre */}
        <span className="flex min-w-0 items-center gap-2 sm:gap-2.5">
          {switching ? (
            <Spinner className="h-3 w-3 text-weaker" />
          ) : robinhood ? (
            <span className="relative flex shrink-0">
              <ChainLogo chain="robinhood" size={18} />
              {warn && <span className="absolute -bottom-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-warning ring-[1.5px] ring-background-base" aria-hidden />}
            </span>
          ) : (
            <span className={cx('h-2 w-2 rounded-full shrink-0', warn ? 'bg-warning' : 'bg-success')} aria-hidden />
          )}
          <span className="inline-flex min-w-0 items-baseline gap-1.5">
            <span className="max-w-[9rem] truncate">{chainShortLabel(chain.id)}</span>
            {isLocalChain(chain.id) && <span className="text-2xs font-normal text-weaker">local</span>}
          </span>
          <svg viewBox="0 0 12 12" className="h-3 w-3 text-weaker shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
            <path d="M3 4.5l3 3 3-3" />
          </svg>
        </span>
      </Button>
      {open && (
        <ul
          role="listbox"
          aria-label="Networks"
          className="absolute right-0 top-full mt-2 w-72 bg-background-popover border border-stroke-strong rounded-md shadow-pop p-1 animate-fade-in z-40"
        >
          {SUPPORTED_CHAINS.map((c) => {
            const current = c.id === chain.id;
            const live = hasDeployment(c.id);
            return (
              <li key={c.id} role="option" aria-selected={current}>
                <button
                  type="button"
                  disabled={switching}
                  onClick={() => {
                    setOpen(false);
                    void switchTo(c.id).catch(() => {});
                  }}
                  className={cx(
                    'w-full rounded px-2.5 py-2 text-left text-xs flex items-center gap-2 hover:bg-background-elevated disabled:cursor-not-allowed',
                    current ? 'text-strong' : 'text-weak',
                  )}
                >
                  <span className={cx('h-2 w-2 rounded-full shrink-0', live ? 'bg-success' : 'bg-stroke-strong')} aria-hidden />
                  <span className="flex-1 min-w-0">
                    <span className="block truncate">{c.name}</span>
                    <span className="block text-2xs text-weaker num">
                      chain id {c.id}
                      {c.testnet ? ' · testnet' : ''}
                      {live ? '' : ' · no deployment'}
                    </span>
                  </span>
                  {current && <span className="text-strong" aria-hidden>✓</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
