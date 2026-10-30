# mysun-analytics (Cloudflare Worker)

The NAV/fee collector (`backend/src/collect-nav.ts`) ported to a Worker (R2 storage, hourly cron).
The collection logic and sweep are unchanged; the row schema gains one APPENDED field
(`performanceFeeBps`, after `adapterCount` — field order is the wire contract). An hourly cron (`0 * * * *`) collects
every vault on the bundled `shared/deployments.json` registry, and `fetch` serves
`GET /analytics/nav-history.jsonl` (text/plain, CORS `*`) and `GET /healthz` (`{"ok":true,"updatedAt":…}`).
Everything else returns 404.

**Deploy:** `pnpm install && pnpm deploy`, then `pnpm exec wrangler secret put DRPC_API_KEY`. The key is optional; without it the collector uses the public dRPC endpoint. Check the config without deploying with `pnpm exec wrangler deploy --dry-run`.

**Storage** (binding `mysun_analytics`): one R2 object, `nav-history.jsonl`, holds the whole JSONL,
one row per vault per hour; custom metadata `{ updatedAt }`. The cron is the only writer: each cycle
sweeps the stored blob, appends the new rows, and stores the result with one `put`. A once-only
`seedHistoryOnce` merges the bundled first-run series (idempotent via metadata `seeded`).

**Limits to watch:** the blob grows about 72 rows (~55 KiB) a day. The full sweep costs about
4.5 ms of CPU at one month and about 12 ms at four months (Free plan: 10 ms). One cycle makes about
14 RPC subrequests (multicall-batched).

**Deployed:** `https://mysun-analytics.tcfsh-crazer.workers.dev` (route `analytics.mysun.dev/*` is
registered but the host has no DNS record — use the workers.dev URL). The old Railway hosting was
retired 2026-10-22; this Worker is the only collector.

## Ops notes (hard-won)

- **`wrangler kv` operates on LOCAL storage by default in Wrangler v4.**
  `wrangler kv key put|get|list|delete` without `--remote` hits the local dev store
  (`.wrangler/state`), so the CLI "sees" data no deployed Worker ever had. Always pass `--remote` when
  seeding or inspecting the real namespace. A deployed Worker returning `{"updatedAt":null}` +
  `no snapshots yet` while the CLI shows rows is *this*, not an edge/cache bug — a matching namespace
  id on both sides does not prove the write went remote.
- **The `analytics.mysun.dev/*` route needs a proxied DNS record for the hostname**, otherwise the
  host does not resolve (`Could not resolve host`) and the route is inert. `demo.mysun.dev` still
  carries its leftover tunnel CNAME, which is why that route works. Add e.g. `A analytics -> 192.0.2.1`,
  proxied; the Worker route intercepts at the edge and the origin is never contacted.
- **Checking the cron:** the deployed triggers are visible at
  `GET /accounts/{account_id}/workers/scripts/mysun-analytics/schedules` (wrangler's OAuth token works;
  cron times are UTC). `wrangler tail` shows cron invocations live. Dashboard Observability / Workers
  Logs is off by default.
- **The wrangler-login OAuth token cannot edit DNS** (`zone:read` only, no `dns_records:edit`) — DNS
  changes are dashboard clicks or a purpose-scoped API token.
- The first-run seed restored the pre-cutover series (132 rows as of 2026-10-22) from the bundled
  `src/seed.ts`; regenerate it from a known-good JSONL when a fresh bucket needs history.

