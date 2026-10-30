import { Outlet } from 'react-router-dom';
import { Header } from './Header';
import { ToastHost } from '@/components/ui/Toast';
import { useWalletBridge } from '@/chain/useConnectWallet';
import { BRAND } from '@/lib/brand';
import { TeamModeProvider, TeamModeTapTarget } from './TeamMode';

export function Layout() {
  // Mirrors the connected account into the store, which the hero's connect gate reads.
  useWalletBridge();

  return (
    <TeamModeProvider>
      <div className="min-h-screen flex flex-col">
        <Header />
        {/* Pages set their own width (class "wrap"), so a page can run a band edge to edge. */}
        <main className="flex-1 w-full">
          <Outlet />
        </main>
        <footer className="border-t border-stroke-weak">
          <p className="wrap py-6 text-xs text-weaker">
            {/* The brand name hides team mode's entry (7 quick taps) — see ./TeamMode.tsx */}
            <TeamModeTapTarget>{BRAND.name}</TeamModeTapTarget> · figures are read live from the chain. The price chart is illustrative until enough history exists.
          </p>
        </footer>
        <ToastHost />
      </div>
    </TeamModeProvider>
  );
}
