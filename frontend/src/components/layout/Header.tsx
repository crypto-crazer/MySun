import { useRef } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { WalletButton } from './WalletButton';
import { ChainSelector } from './ChainSelector';
import { useStore } from '@/store/useStore';
import { cx } from '@/lib/format';
import { Mark, Wordmark, WordmarkZh } from '@/components/brand/Mark';
import { BRAND } from '@/lib/brand';

const NAV = [{ to: '/', label: 'Earn' }];

export function Header() {
  const reset = useStore((s) => s.reset);
  const pushToast = useStore((s) => s.pushToast);
  const clicks = useRef<number[]>([]);

  // The logo leads home. Hidden demo reset: 5 clicks on it within 2.5s.
  const onLogo = () => {
    const now = Date.now();
    clicks.current = [...clicks.current.filter((t) => now - t < 2500), now];
    if (clicks.current.length >= 5) {
      clicks.current = [];
      reset();
      pushToast({ title: 'Demo reset', detail: 'Wallet disconnected. Positions restored to defaults.', tone: 'warning' });
    }
  };

  return (
    <header className="sticky top-0 z-30 bg-background-base/85 backdrop-blur-md border-b border-stroke-weak">
      <div className="wrap min-h-[60px] flex items-center gap-x-3 md:gap-x-7">
        {/* The wordmark already carries the mark as its s, so the two never stand side by side: phones get the mark alone.
            The y's tail sits below the letters, so the wordmark drops 2px to put their baseline on the nav's.
            On hover the Chinese wordmark takes its place, centred in the same cell, so the nav never shifts */}
        <Link to="/" onClick={onLogo} className="group flex items-center select-none py-2 text-strong" aria-label={BRAND.name}>
          <Mark size={24} className="sm:hidden" />
          <span className="hidden sm:grid items-center">
            <Wordmark className="[grid-area:1/1] h-5 translate-y-0.5 transition-opacity duration-150 ease-dusk group-hover:opacity-0" />
            <WordmarkZh className="[grid-area:1/1] justify-self-center h-5 opacity-0 transition-opacity duration-150 ease-dusk group-hover:opacity-100" />
          </span>
        </Link>
        {/* With one page to name, phones skip the nav: the header stays one row */}
        <nav className="hidden md:flex md:flex-1 items-center gap-0.5">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === '/'}
              className={({ isActive }) =>
                cx(
                  // The serif runs a step above the sans (16px to 14px) to read at the same size; the 20px line keeps the active tick on the rule
                  'relative px-3 py-2 font-serif text-md leading-5 whitespace-nowrap transition-colors',
                  // the active page is marked by a short tick on the header rule, in the sun colour
                  isActive ? 'text-strong after:absolute after:left-1/2 after:-bottom-[11px] after:h-[9px] after:w-px after:bg-accent' : 'text-weaker hover:text-strong',
                )
              }
            >
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2 shrink-0">
          <ChainSelector />
          <WalletButton />
        </div>
      </div>
    </header>
  );
}
