/**
 * Test-environment pinning. The app reads its WalletConnect project id from `.env.local`, which
 * every developer of this repo has (and CI does not) — the suite must not quietly change behavior
 * with that file. Pinned off here, BEFORE any test module imports the wallet layer, so
 * `walletConnectEnabled` is the same in every environment.
 */
import { vi } from 'vitest';

vi.stubEnv('VITE_WALLETCONNECT_PROJECT_ID', '');
// Same for team mode: a developer's `.env.local` hash must not unlock the suite. A test that needs a
// configured gate stubs its own fixture hash (teamgate.test.tsx) or uses `createTeamMode`.
vi.stubEnv('VITE_GOLDEN_FINGER_SHA256', '');
// Same for the NAV-history collector: with a developer's URL every vault page would fetch the live
// feed, and the chart would sit on its loading frame instead of the fallback the tests assert. A
// test that needs a feed passes its own URL (navhistory.test.tsx).
vi.stubEnv('VITE_NAV_HISTORY_URL', '');

/*
 * jsdom has no ResizeObserver; the vault page's chart (recharts' ResponsiveContainer) and range
 * drawing (useElementWidth) need one. A no-op is enough — the tests read text, not layout.
 */
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
