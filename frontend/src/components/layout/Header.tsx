import { useRef } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { WalletButton } from './WalletButton';
import { ChainSelector } from './ChainSelector';
import { useStore } from '@/store/useStore';
import { cx } from '@/lib/format';
import { Mark } from '@/components/brand/Mark';
import { BRAND } from '@/lib/brand';

const NAV = [
  { to: '/', label: 'Earn' },
  { to: '/live', label: 'Live vault' },
  { to: '/analytics', label: 'Analytics' },
];

export function Header() {
  const reset = useStore((s) => s.reset);
  const pushToast = useStore((s) => s.pushToast);
  const navigate = useNavigate();
  const clicks = useRef<number[]>([]);

  // Hidden demo reset: 5 clicks on the logo within 2.5s.
  const onLogo = () => {
    const now = Date.now();
    clicks.current = [...clicks.current.filter((t) => now - t < 2500), now];
    if (clicks.current.length >= 5) {
      clicks.current = [];
      reset();
      pushToast({ title: 'Demo reset', detail: 'Wallet disconnected. Positions restored to defaults.', tone: 'warning' });
      navigate('/');
    }
  };

  return (
    <header className="sticky top-0 z-30 bg-background-base/85 backdrop-blur-md border-b border-stroke-weak">
      <div className="wrap min-h-[60px] py-2 md:py-0 flex flex-wrap items-center gap-x-3 gap-y-1 md:gap-x-7">
        <button onClick={onLogo} className="flex items-center gap-3 select-none py-2 text-strong" aria-label={BRAND.name}>
          <Mark size={24} />
          <span className="wordmark hidden sm:inline">{BRAND.name}</span>
        </button>
        <nav className="flex items-center gap-0.5 order-last w-full md:order-none md:w-auto md:flex-1 overflow-x-auto md:overflow-visible">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === '/'}
              className={({ isActive }) =>
                cx(
                  'relative px-3 py-2 text-base whitespace-nowrap transition-colors',
                  // the active page is marked by a short tick on the header rule, in the sun colour
                  isActive ? 'text-strong after:absolute after:left-1/2 after:-bottom-[3px] md:after:-bottom-[11px] after:h-[9px] after:w-px after:bg-accent' : 'text-weaker hover:text-strong',
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
