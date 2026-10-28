import { Outlet, useSearchParams } from 'react-router-dom';
import { useEffect } from 'react';
import { Header } from './Header';
import { ToastHost } from '@/components/ui/Toast';
import { usePendingTicker } from '@/store/selectors';
import { useStore } from '@/store/useStore';
import { useWalletBridge } from '@/chain/useConnectWallet';
import { BRAND } from '@/lib/brand';

export function Layout() {
  usePendingTicker();
  // Mirrors the connected account into the demo store, so a real connection also opens the demo surfaces.
  useWalletBridge();
  // Demo controls (URL params): ?market=open|closed|auto forces the US market status.
  const [params] = useSearchParams();
  const setOverride = useStore((s) => s.setMarketOverride);
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  useEffect(() => {
    const m = params.get('market');
    if (m === 'open' || m === 'closed' || m === 'auto') setOverride(m);
    const t = params.get('theme');
    if (t === 'dark' || t === 'light') setTheme(t);
  }, [params, setOverride, setTheme]);
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      {/* Pages set their own width (class "wrap"), so a page can run a band edge to edge. */}
      <main className="flex-1 w-full">
        <Outlet />
      </main>
      <footer className="border-t border-stroke-weak">
        <div className="wrap py-6 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 text-xs text-weaker">
          <span>{BRAND.name} · figures are read live from the chain. The price chart is illustrative until enough history exists.</span>
        </div>
      </footer>
      <ToastHost />
    </div>
  );
}
