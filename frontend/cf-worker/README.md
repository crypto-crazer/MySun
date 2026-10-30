# mysun-demo — edge worker (Cloudflare)

Serves the built frontend (`../dist`) on https://demo.mysun.dev — static assets only. The worker
proxies nothing to the home Mac (TASK-RETIRE-DEMO-CHAIN-WORKER, 2026-10-23): the demo chain left the
public frontend, the `chain.mysun.dev` tunnel is retired, and the public demo makes zero requests
toward the Mac.

## Deploy

Requires `wrangler login` once on the machine (OAuth, cached on the demo Mac), then from `frontend/`:

    pnpm deploy:demo        # build (tsc + vite) and deploy — cf-worker/deploy.sh

`deploy.sh` cd's here and execs `../node_modules/.bin/wrangler deploy` (wrangler is a devDependency
of `frontend/` — no npx download per run). In CI, set `CLOUDFLARE_API_TOKEN` instead of logging in.

## Notes

- Zone route `demo.mysun.dev/*` intercepts requests at Cloudflare's edge —
  no DNS record is involved; the page is served from the edge, always.
- `binding = "ASSETS"` must stay set or `env.ASSETS` is undefined at runtime.
- `not_found_handling = "single-page-application"` provides the SPA fallback.
- `/rpc` is no longer special: it is an unknown path and gets whatever the ASSETS binding's SPA
  fallback answers. No outbound `fetch` is made for any path (the worker tests assert it).
- Per-client page rate caps (`ratelimit.js`; client = `CF-Connecting-IP`, IPv6 keyed by its /64):
  a sliding 60s window of 180 requests for every path — over the cap the worker answers a text
  429 `rate limited` + `Retry-After: 30`. Counters are per isolate, in memory. A 429 is still a
  worker invocation, so the cap bounds per-client throughput, not the account quota itself.
  Tests: `node --test cf-worker/test/` (from `frontend/`).
