/**
 * All logic lives here; the entry module (`index.ts`) exports ONLY the worker default
 * handler — workerd builds its handler map from the entry's top-level exports, so named
 * constants/functions in the entry break the runtime ("Incorrect type for map entry").
 */

import { runCycle, type BlobIo } from './collect.js';
import { loadChains } from './registry.js';
import { SEED_JSONL } from './seed.js';

export const NAV_KEY = 'nav-history.jsonl';

/** The slice of the Workers R2 binding this worker uses (no @cloudflare/workers-types dependency). */
export interface R2ObjectLike {
  text(): Promise<string>;
  customMetadata?: Record<string, string>;
}

export interface R2Like {
  get(key: string): Promise<R2ObjectLike | null>;
  put(key: string, value: string, options?: { customMetadata?: Record<string, string> }): Promise<void>;
}

export interface Env {
  mysun_analytics: R2Like;
  /** Secret (`wrangler secret put DRPC_API_KEY`); unset ⇒ the registry's public RPC. */
  DRPC_API_KEY?: string;
}

export const CORS = { 'access-control-allow-origin': '*' };

/** Never let the CDN cache collector responses: the edge cache returns the same stale body to
 * every request (and ignores query busters), which hides new snapshots and read-through bugs. */
const NO_CACHE = { 'cache-control': 'no-store' };

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...CORS, ...NO_CACHE },
  });
}

export function r2Blob(bucket: R2Like): BlobIo {
  return {
    read: async () => {
      const obj = await bucket.get(NAV_KEY);
      return obj === null ? null : obj.text();
    },
    write: async (text) => {
      await bucket.put(NAV_KEY, text, { customMetadata: { updatedAt: new Date().toISOString() } });
    },
  };
}

export async function handleFetch(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(404, { error: 'not found' });
  if (url.pathname === '/healthz') {
    const obj = await env.mysun_analytics.get(NAV_KEY);
    const updatedAt = obj?.customMetadata?.['updatedAt'];
    return json(200, { ok: true, updatedAt: updatedAt ?? null });
  }
  if (url.pathname === '/analytics/nav-history.jsonl') {
    const obj = await env.mysun_analytics.get(NAV_KEY);
    if (obj === null) return json(404, { error: 'no snapshots yet' });
    const text = await obj.text();
    return new Response(text, {
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8', ...CORS, ...NO_CACHE },
    });
  }
  return json(404, { error: 'not found' });
}

export async function handleScheduled(env: Env): Promise<void> {
  try {
    const r2 = env.mysun_analytics;
    await seedHistoryOnce(r2);
    const result = await runCycle(r2Blob(r2), {
      chains: loadChains(),
      drpcApiKey: env.DRPC_API_KEY || undefined,
    });
    console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'info', msg: 'collect cycle done', svc: 'mysun-collect', ...result }));
  } catch (err) {
    // Never fail the cron: the next hourly run retries from the stored blob.
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'error', msg: 'collect cycle failed', svc: 'mysun-collect', error: String(err) }));
  }
}

/**
 * Restores the pre-cutover series ONCE; the hourly cron appends afterwards.
 *
 * Idempotent by CONTENT, not metadata: the cron's own blob write rewrites customMetadata every
 * cycle (dropping any `seeded` flag), so a metadata marker alone would re-merge the seed on every
 * run. The object is only re-seeded while it does not yet start with the seed's first row.
 */
export async function seedHistoryOnce(r2: R2Like): Promise<void> {
  const seed = SEED_JSONL.trim();
  const existing = await r2.get(NAV_KEY);
  const current = existing ? await existing.text() : '';
  const firstSeedLine = seed.split('\n')[0] ?? '';
  if (firstSeedLine !== '' && current.startsWith(firstSeedLine)) return; // already seeded
  const meta = { ...(existing?.customMetadata ?? {}) };
  const merged = (seed + (current.length > 0 ? '\n' : '') + current).trimStart();
  await r2.put(NAV_KEY, merged, { customMetadata: { ...meta, seeded: '1', updatedAt: new Date().toISOString() } });
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'info', msg: 'history seeded', svc: 'mysun-collect', rows: merged === '' ? 0 : merged.split('\n').length }));
}