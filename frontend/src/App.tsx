import { lazy, Suspense } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Layout } from '@/components/layout/Layout';
import { Markets } from '@/pages/Markets';
import { VaultDetail } from '@/pages/VaultDetail';
import { Navigate } from 'react-router-dom';
import { useTeamUnlocked } from '@/lib/teamMode';

// The token and component gallery. Not linked from the header, loaded only when visited, and only
// while team mode is unlocked (src/lib/teamMode.ts): locked visitors fall through to the catch-all and
// the lazy chunk is never even fetched.
const DesignSystem = lazy(() => import('@/pages/DesignSystem').then((m) => ({ default: m.DesignSystem })));

export default function App() {
  const galleryUnlocked = useTeamUnlocked();
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '')}>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Markets />} />
          <Route path="/vault/:id" element={<VaultDetail />} />
          {galleryUnlocked && (
            <Route path="/design-system/:tab?" element={<Suspense fallback={null}><DesignSystem /></Suspense>} />
          )}
          {/* Every other path — retired routes (/live, /explore, /rewards, …) and the gallery while
              locked — goes home. */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
