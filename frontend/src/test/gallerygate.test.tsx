// @vitest-environment jsdom
/**
 * /design-system is team-mode content (owner call, 2026-10-29): while locked the route does not exist
 * — the catch-all sends the address home and the gallery's lazy chunk is never fetched — and unlocking
 * registers it. The gallery is the designer's page; this pins only its reachability.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

const FIXTURE = vi.hoisted(() => {
  // sha256('open sesame') — the same fixture the gate's own suite uses.
  const hash = '41ef4bb0b23661e66301aac36066912dac037827b4ae63a7b1165a5aa93ed4eb';
  vi.stubEnv('VITE_GOLDEN_FINGER_SHA256', hash);
  return { code: 'open sesame' };
});

/* Test-environment shim (see teamgate.test): node's global `localStorage` shadows jsdom's, and the
 * team-mode singleton binds `window.localStorage` at import — install jsdom's before the app loads. */
if (!window.localStorage) {
  const store = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size;
      },
    } satisfies Storage,
  });
}

// No chain in jsdom: reads reject at once, exactly as in teamgate.test.tsx.
vi.mock('@/chain/client', async (orig) => ({
  ...(await orig<typeof import('@/chain/client')>()),
  readMany: vi.fn(async () => {
    throw new Error('test transport: no chain');
  }),
}));

const { ChainProviders } = await import('@/chain/Providers');
const { teamMode } = await import('@/lib/teamMode');
const App = (await import('@/App')).default;

const originalUrl = window.location.href;

beforeEach(() => {
  teamMode.lock();
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  teamMode.lock();
  window.history.replaceState({}, '', originalUrl);
});

/** The real app (its own BrowserRouter), at `path`. */
async function renderAt(path: string) {
  window.history.pushState({}, '', path);
  const view = render(
    <ChainProviders>
      <App />
    </ChainProviders>,
  );
  return view;
}

describe('/design-system behind team mode', () => {
  it('locked: the address is not a route — the catch-all lands on the vault list', async () => {
    await renderAt('/design-system');
    expect(await screen.findByRole('heading', { name: 'Vaults' })).toBeDefined();
    expect(screen.queryByRole('heading', { name: 'Design system' })).toBeNull();
    expect(teamMode.isUnlocked()).toBe(false);
  });

  it('unlocked: the gallery registers and renders', async () => {
    await teamMode.unlock(FIXTURE.code);
    expect(teamMode.isUnlocked()).toBe(true);
    await renderAt('/design-system');
    expect(await screen.findByRole('heading', { name: 'Design system' })).toBeDefined();
    // and it is still the only place it appears: the vault list is not on screen
    expect(screen.queryByRole('heading', { name: 'Vaults' })).toBeNull();
  });

  it('leaving team mode takes the route away again', async () => {
    await teamMode.unlock(FIXTURE.code);
    await renderAt('/design-system');
    expect(await screen.findByRole('heading', { name: 'Design system' })).toBeDefined();
    act(() => teamMode.lock());
    expect(await screen.findByRole('heading', { name: 'Vaults' })).toBeDefined();
    expect(screen.queryByRole('heading', { name: 'Design system' })).toBeNull();
  });
});
