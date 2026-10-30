/** Registry bundling and the Worker's fetch routes (in-memory R2; no network). */
import { describe, expect, it } from 'vitest';

import { handleFetch, r2Blob, seedHistoryOnce, NAV_KEY, type Env, type R2Like, type R2ObjectLike } from '../src/app.js';
import { loadChains, withoutOverlayOnlyChains } from '../src/registry.js';

function memR2(): R2Like & { store: Map<string, R2ObjectLike & { value: string }> } {
  const store = new Map<string, R2ObjectLike & { value: string }>();
  return {
    store,
    get: async (k) => store.get(k) ?? null,
    put: async (k, value, opts) => {
      store.set(k, {
        text: async () => value,
        customMetadata: opts?.customMetadata,
        value,
      } as R2ObjectLike & { value: string });
    },
  };
}

const get = (env: Env, path: string, method = 'GET') =>
  handleFetch(new Request(`https://mysun-analytics.example${path}`, { method }), env);

describe('registry', () => {
  it('loads the bundled deployments.json: mainnet 4663 with its vaults and zap periphery', () => {
    const chains = loadChains();
    const rhc = chains.find((c) => c.chainId === 4663);
    expect(rhc?.status).toBe('deployed');
    expect(rhc?.vaults?.map((v) => v.key)).toEqual(expect.arrayContaining(['main', 'pons', 'tri']));
    expect(rhc?.periphery?.zapIn).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it('drops deployed entries without a vaults list (overlay-only), by shape — not by chain id', () => {
    const raw = {
      version: 2,
      chains: {
        '1': { status: 'deployed', name: 'a' },
        '2': { status: 'planned', name: 'b' },
        '3': { status: 'deployed', name: 'c', vaults: [] },
      },
    };
    const out = withoutOverlayOnlyChains(raw) as { chains: Record<string, unknown> };
    expect(Object.keys(out.chains)).toEqual(['2', '3']);
  });

  it('still validates with the keeper rules (bad registry throws)', () => {
    expect(() => loadChains({ version: 1, chains: {} })).toThrow(/version/);
  });
});

describe('fetch routes', () => {
  it('serves the blob as text/plain with CORS', async () => {
    const r2 = memR2();
    await r2Blob(r2).write('{"a":1}\n');
    const res = await get({ mysun_analytics: r2 }, '/analytics/nav-history.jsonl');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(await res.text()).toBe('{"a":1}\n');
  });

  it('404s the JSONL before the first snapshot', async () => {
    const res = await get({ mysun_analytics: memR2() }, '/analytics/nav-history.jsonl');
    expect(res.status).toBe(404);
  });

  it('healthz reports ok + updatedAt from the blob metadata (null before the first write)', async () => {
    const r2 = memR2();
    const env = { mysun_analytics: r2 };
    expect(await (await get(env, '/healthz')).json()).toEqual({ ok: true, updatedAt: null });
    await r2Blob(r2).write('x\n');
    const body = (await (await get(env, '/healthz')).json()) as { ok: boolean; updatedAt: string };
    expect(body.ok).toBe(true);
    expect(Number.isNaN(Date.parse(body.updatedAt))).toBe(false);
    expect(r2.store.has(NAV_KEY)).toBe(true);
  });

  it('everything else is 404', async () => {
    const env = { mysun_analytics: memR2() };
    expect((await get(env, '/')).status).toBe(404);
    expect((await get(env, '/analytics/collect-nav.jsonl')).status).toBe(404);
    expect((await get(env, '/healthz', 'POST')).status).toBe(404);
  });

  it('seedHistoryOnce merges the bundled series exactly once — even after the cron rewrites metadata', async () => {
    const r2 = memR2();
    await seedHistoryOnce(r2);
    const first = r2.store.get(NAV_KEY)!.value;
    const countLines = (s: string) => s.split('\n').filter((l) => l.length > 0).length;
    const firstSeedLine = first.split('\n')[0];
    expect(countLines(first)).toBeGreaterThan(100); // the bundled backfill

    // The cron's own write replaces customMetadata (drops `seeded`) — the old metadata-only guard
    // re-merged the seed every cycle (each pre-cutover row duplicated once per hour). The content
    // check must survive this exact sequence.
    await r2Blob(r2).write('{"ts":"2026-10-22T04:00:00.000Z","vaultKey":"main"}\n');
    await seedHistoryOnce(r2); // must NOT re-merge
    const second = r2.store.get(NAV_KEY)!.value;
    expect(countLines(second)).toBe(countLines(first) + 1);
    expect(second.split('\n').filter((l) => l === firstSeedLine).length).toBe(1); // one copy of the seed
  });
});