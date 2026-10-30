#!/usr/bin/env bash
# Runs one PHASE of script/DeployStockVaults.s.sol. `vaults` runs ONE forge invocation per slug (STOCK_ONLY): every
# Upgrades.deployUUPSProxy call reads the build-info into script-EVM memory that is never freed, and a single run
# hits MemoryOOG after 7 vaults (rehearsal 2026-10-27). Every other phase runs once over all 12 markets.
# Each run is idempotent (resumes from on-chain state), so a failed slug is simply re-run.
#
#   cd contracts && forge clean && forge build      # immediately before; nothing compiles in between
#   PHASE=vaults bash script/stock-vaults.sh --rpc-url <rpc> --sender <owner> --account <ks> --password-file <pw> \
#     --broadcast --slow
# Env passes through (OWNER, STOCK_LABEL, STOCK_ONLY). Extra args go to `forge script` verbatim.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${PHASE:?set PHASE (plan | vaults | adapters | executors | genesis | verify | all)}"
SLUGS=(spy gld nvda spcx crcl tsla aapl amzn intc mu mstr nvda-spy)

run() {
  forge script script/DeployStockVaults.s.sol "$@"
}

if [[ "$PHASE" == "vaults" || "$PHASE" == "all" ]] && [[ -z "${STOCK_ONLY:-}" ]]; then
  for s in "${SLUGS[@]}"; do
    echo "== PHASE=vaults STOCK_ONLY=$s"
    PHASE=vaults STOCK_ONLY="$s" run "$@"
  done
  [[ "$PHASE" == "vaults" ]] && exit 0
  for p in adapters executors genesis verify; do
    echo "== PHASE=$p"
    PHASE="$p" run "$@"
  done
  exit 0
fi
run "$@"
