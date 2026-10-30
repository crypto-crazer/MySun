/**
 * Worker entry for `mysun-analytics` (NAV/fee collector on Cloudflare).
 *
 *   scheduled  hourly cron → one collect cycle → KV `nav-history.jsonl` (sweep + append, one put)
 *   fetch      GET /analytics/nav-history.jsonl  the stored JSONL (text/plain, CORS *)
 *              GET /healthz                      {"ok":true,"updatedAt":<ISO|null>}
 *              anything else                      404
 *
 * The cron is the key's single writer; `updatedAt` rides on the KV value's metadata, so a health
 * check costs one read and no extra key. A skipped/failed cycle never fails the cron — it logs.
 */

import { Env, handleFetch, handleScheduled } from './app.js';

export default {
  fetch: (req: Request, env: Env) => handleFetch(req, env),
  scheduled: (_controller: unknown, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }) => {
    ctx.waitUntil(handleScheduled(env));
  },
};
