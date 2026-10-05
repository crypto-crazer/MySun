import { lazy, Suspense } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Layout } from '@/components/layout/Layout';
import { Markets } from '@/pages/Markets';
import { VaultDetail } from '@/pages/VaultDetail';
import { Navigate } from 'react-router-dom';
import { Analytics } from '@/pages/Analytics';
import { LiveVault } from '@/pages/LiveVault';

// The token and component gallery. Not linked from the header and loaded only when visited.
const DesignSystem = lazy(() => import('@/pages/DesignSystem').then((m) => ({ default: m.DesignSystem })));

export default function App() {
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '')}>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Markets />} />
          <Route path="/live" element={<LiveVault />} />
          <Route path="/explore" element={<Navigate to="/" replace />} />
          <Route path="/vault/:id" element={<VaultDetail />} />
          <Route path="/portfolio" element={<Navigate to="/" replace />} />
          <Route path="/rewards" element={<Navigate to="/" replace />} />
          <Route path="/analytics" element={<Analytics />} />
          <Route path="/flywheel" element={<Navigate to="/analytics" replace />} />
          <Route path="/design-system/:tab?" element={<Suspense fallback={null}><DesignSystem /></Suspense>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
