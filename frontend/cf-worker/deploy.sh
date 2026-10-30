#!/usr/bin/env bash
# One-shot demo deploy: build the frontend, then ship it to the Cloudflare edge,
# where the `mysun-demo` worker serves https://demo.mysun.dev (static assets only).
#
# Run from anywhere; typically:
#   cd frontend && pnpm deploy:demo
#   bash cf-worker/deploy.sh --build-only   # the same build + checks, no wrangler deploy
#
# Prereqs (once per machine): `pnpm install`, and wrangler auth — `pnpm exec wrangler login`
# (OAuth, cached in ~/Library/Preferences/.wrangler) or CLOUDFLARE_API_TOKEN in the environment.
set -euo pipefail
cd "$(dirname "$0")/.." # -> frontend/

# The deployed bundle carries no demo-chain (46630) registry data: build from a production variant
# of src/config/generated.ts (`sync-shared.ts --prod` omits the local chain), then put the committed
# file back — on success or failure — before anything else runs.
gen=src/config/generated.ts
backup="$(mktemp "${TMPDIR:-/tmp}/mysun-generated.XXXXXX")"
cp "$gen" "$backup"
restore() { if [ -f "$backup" ]; then cp "$backup" "$gen" && rm -f "$backup"; fi; }
trap restore EXIT
./node_modules/.bin/tsx scripts/sync-shared.ts --prod
pnpm build
restore
if grep -rlq 46630 dist/; then
  echo "deploy: dist/ still contains 46630 (demo-chain data) — refusing to deploy" >&2
  exit 1
fi
if grep -rlqE 'fonts\.(googleapis|gstatic)\.com' dist/; then
  echo "deploy: dist/ references fonts.googleapis.com / fonts.gstatic.com (a Google font host) — refusing to deploy" >&2
  exit 1
fi
if [ "${1:-}" = "--build-only" ]; then
  echo "deploy: --build-only — dist/ built (no 46630, no Google font host), not deployed"
  exit 0
fi
cd cf-worker
export WRANGLER_SEND_METRICS=false
exec ../node_modules/.bin/wrangler deploy
