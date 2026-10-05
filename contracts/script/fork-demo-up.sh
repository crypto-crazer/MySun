#!/usr/bin/env bash
# fork-demo-up.sh — the local demo stack on Robinhood Chain state: REAL USDG / WETH, REAL Uniswap v3 + v4
# adapters (vault "demo"), the mock "stocks" vault, the zap periphery (registered to the "demo" vault:
# zap-in routes USDG→WETH and zap-out routes WETH→USDG, both on the same fee-100 pool) and the strategy-layer
# PlanExecutor (a vault keeper; keeper #1 is whitelisted on it). One command,
# repeatable, a few minutes.
#
# Why a freeze step: the public RHC RPC is NOT an archive node — it serves state for recent blocks only
# (observed: a fork block aged out after ~10–30 minutes). A live `anvil --fork-url` of it then dies: it
# cannot fetch any uncached slot, and cannot even mine (each block writes a fresh EIP-2935 block-hash slot).
# So the stack is deployed on a fresh live fork, then FROZEN (script/fork-demo-freeze.mjs: every fetched
# account/slot + every local change) and anvil is restarted standalone from that state file — same chain id,
# port, addresses and block height, no upstream dependency, persisted on exit (`anvil --state`). A slot the
# live fork never read would come back as ZERO (e.g. WETH.decimals()), hence the warm-up + fidelity check.
#
# Steps (the upstream-dependent part — 0 to 6 — is kept short and runs first; any failure aborts):
#   0. stop the anvil on $PORT (refuses if the listener is not anvil); start a live fork of RHC, chain id 46630
#   1. guard: chain id 46630 + real RHC contracts present
#   2. warm-up (batched): every upstream read the demo relies on later — token metadata + balances, the
#      pool's state / the WHOLE observations ring / tick bitmap ±2 words and every initialized tick in them
#   3. gas: every anvil dev account used below gets 10k ETH if it has less than 100
#   4. funding: impersonate the USDG/WETH fee-100 pool (it holds real USDG + WETH), ERC-20-transfer working
#      balances to OWNER (#0), DEMO_USER (#2) and TRADER (#3 — real swap volume in the backend suite)
#   5. TWAP: evm_increaseTime 1800 + evm_mine — the adapters guard spot≈TWAP; on a frozen fork one window
#      forward makes the pool's 1800 s TWAP equal its spot (the fork suites' vm.warp)
#   6. forge clean && forge build && forge script DemoLocalFork.s.sol (anvil #0 key; #1 is the keeper)
#   7. post-deploy spot checks (cast) + the warm-up reads again + the venue + zap preview reads
#      (the fidelity baseline — all cached by now)
#   8. freeze: dump local state → stop the fork (flushes foundry's fork cache) → merge → restart standalone;
#      the warm-up reads on the frozen node must equal the baseline byte for byte
#
# Usage (from contracts/):
#   export ANVIL_DEV_KEY=<anvil account #0 private key>   # the public, well-known Anvil default — LOCAL ONLY
#   script/fork-demo-up.sh
# Env: PORT (8547), HOST (0.0.0.0), STATE_DIR (~/.mysun/fork-demo), ANVIL_LOG ($STATE_DIR/anvil.log),
#      RHC_RPC (https://rpc.mainnet.chain.robinhood.com).
# Restart the frozen stack later (no redeploy):
#   anvil --state ~/.mysun/fork-demo/state.json --chain-id 46630 --host 0.0.0.0 --port 8547
#
# Writes ../shared/deployment.local.json (rpcUrl http://127.0.0.1:8547, "fork": true, "mintable": false,
# "periphery" = the zap-in / zap-out addresses + the PlanExecutor the deploy registered to the "demo" vault).
# Then: cd ../frontend && pnpm sync:shared.
set -euo pipefail

PORT="${PORT:-8547}"
HOST="${HOST:-0.0.0.0}"
RPC="http://127.0.0.1:$PORT"
RHC_RPC="${RHC_RPC:-https://rpc.mainnet.chain.robinhood.com}"
STATE_DIR="${STATE_DIR:-$HOME/.mysun/fork-demo}"
ANVIL_LOG="${ANVIL_LOG:-$STATE_DIR/anvil.log}"
: "${ANVIL_DEV_KEY:?export ANVIL_DEV_KEY=<anvil account #0 key> (public Anvil default, LOCAL ONLY)}"
export PATH="$PATH:$HOME/.foundry/bin"
cd "$(dirname "$0")/.."
mkdir -p "$STATE_DIR"

# Verified RHC addresses (notes/RHC_ADDRESSES.md).
USDG=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168
WETH=0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73
POOL=0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca # v3 USDG/WETH 0.01% — the funding source
NFPM=0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3
POSM=0x58daec3116aae6D93017bAAea7749052E8a04fA7
PM=0x8366a39CC670B4001A1121B8F6A443A643e40951   # v4 PoolManager
UR=0x204FAca1764B154221e35c0d20aBb3c525710498   # UniversalRouter 2.1.2 (official robinhood.json) — adapters' swap router
PERMIT2=0x000000000022D473030F116dDEE9F6B43aC78BA3 # canonical Permit2 — UR pulls the user's tokens through it
SR02=0xCaf681a66D020601342297493863E78C959E5cb2 # v3 SwapRouter02 — the backend fee-volume trader trades through it
V3_FACTORY=0x1f7d7550B1b028f7571E69A784071F0205FD2EfA # v3 factory (for the SwapRouter02 wiring read)

# Anvil dev accounts (public, well-known — LOCAL ONLY).
OWNER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266     # #0 deployer / genesis
KEEPER=0x70997970C51812dc3A010C7d01b50e0d17dc79C8    # #1 keeper
DEMO_USER=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC # #2 frontend e2e / demo wallet
TRADER=0x90F79bf6EB2c4f870365E785982E1f101E93b906    # #3 swap volume (backend fee test)

# Working balances: USDG (6 dp) + WETH (18 dp) per account.
FUND=(
  "$OWNER 400000000000 150000000000000000000"    # 400k USDG + 150 WETH
  "$DEMO_USER 250000000000 50000000000000000000" # 250k USDG +  50 WETH
  "$TRADER 1000000000000 100000000000000000000"  #   1M USDG + 100 WETH
)

c() { cast "$@" --rpc-url "$RPC"; }
num() { c "$@" | awk '{print $1}'; } # uint call without cast's "[1.3e6]" suffix

# Stop the anvil listening on $PORT (graceful: a fork flushes its cache, a standalone one dumps --state).
stop_anvil() {
  local pid
  pid=$(lsof -nP -t -i "tcp:$PORT" -sTCP:LISTEN 2>/dev/null || true)
  [ -z "$pid" ] && return 0
  if [ "$(basename "$(ps -o comm= -p "$pid")")" != anvil ]; then
    echo "refusing: port $PORT is held by $(ps -o comm= -p "$pid"), not anvil" >&2
    exit 1
  fi
  kill -TERM "$pid"
  for _ in $(seq 1 60); do kill -0 "$pid" 2>/dev/null || return 0; sleep 0.5; done
  echo "anvil $pid did not exit" >&2
  exit 1
}

# Start anvil detached (survives this shell: HUP ignored — macOS nohup refuses without a console).
start_anvil() {
  (zsh -c 'trap "" HUP; exec "$@"' anvil "$(command -v anvil)" "$@" --chain-id 46630 --host "$HOST" --port "$PORT" \
    </dev/null >>"$ANVIL_LOG" 2>&1 &)
  for _ in $(seq 1 60); do c chain-id >/dev/null 2>&1 && return 0; sleep 0.5; done
  echo "anvil did not come up — see $ANVIL_LOG" >&2
  exit 1
}

echo "== 0. fresh live fork of RHC on :$PORT (log $ANVIL_LOG)"
stop_anvil
start_anvil --fork-url "$RHC_RPC"
FORK_BLOCK=$(c rpc anvil_nodeInfo | jq -r '.forkConfig.forkBlockNumber')
echo "forked RHC at block $FORK_BLOCK"

echo "== 1. guard"
CHAIN_ID=$(c chain-id)
[ "$CHAIN_ID" = 46630 ] || { echo "chain id $CHAIN_ID != 46630" >&2; exit 1; }
[ "$(c code "$USDG")" != 0x ] || { echo "no code at USDG — $RPC is not an RHC fork" >&2; exit 1; }
echo "chain id $CHAIN_ID · block $(c block-number) · USDG symbol $(c call "$USDG" 'symbol()(string)')"
# The adapters swap through UR 2.1.2: it must be the RHC-wired router (a mainnet-wired copy answers with the
# mainnet PoolManager). Reading it also pulls its code into the fork cache, so the frozen state keeps it.
UR_PM=$(c call "$UR" 'poolManager()(address)' | tr '[:upper:]' '[:lower:]')
[ "$UR_PM" = "$(echo "$PM" | tr '[:upper:]' '[:lower:]')" ] || { echo "UniversalRouter $UR is not wired to the RHC PoolManager ($UR_PM)" >&2; exit 1; }
echo "UniversalRouter $UR · poolManager $UR_PM"
# The backend fee test (c2) still trades as an ordinary participant through the v3 SwapRouter02 — on the
# FROZEN node its code must exist, so pull it into the cache here too (the OLD adapter's constructor used
# to read it; nothing in the new deploy touches it). The factory read doubles as its wiring check.
SR02_FACTORY=$(c call "$SR02" 'factory()(address)' | tr '[:upper:]' '[:lower:]')
[ "$SR02_FACTORY" = "$(echo "$V3_FACTORY" | tr '[:upper:]' '[:lower:]')" ] || { echo "SwapRouter02 $SR02 factory != RHC v3 factory ($SR02_FACTORY)" >&2; exit 1; }
echo "SwapRouter02 $SR02 · factory $SR02_FACTORY"

echo "== 2. warm-up: the upstream reads the demo relies on (live fork → fork cache)"
WARM=$(node script/fork-demo-freeze.mjs warm "$RPC" "$STATE_DIR/warm-prefork.txt")
echo "$WARM" | grep -v '^CENTER_TICK='
CENTER_TICK=$(echo "$WARM" | sed -n 's/^CENTER_TICK=//p')

echo "== 3. gas (ETH) for the dev accounts"
for a in "$OWNER" "$KEEPER" "$DEMO_USER" "$TRADER"; do
  bal=$(c balance "$a" --ether)
  if [ "$(echo "$bal < 100" | bc)" = 1 ]; then
    c rpc anvil_setBalance "$a" 0x21E19E0C9BAB2400000 >/dev/null # 10,000 ETH
    bal=$(c balance "$a" --ether)
  fi
  echo "$a  $bal ETH"
done

echo "== 4. funding: impersonate the fee-100 pool → real USDG / WETH"
c rpc anvil_impersonateAccount "$POOL" >/dev/null
c rpc anvil_setBalance "$POOL" 0xDE0B6B3A7640000 >/dev/null # 1 ETH for gas
for row in "${FUND[@]}"; do
  read -r to usdg weth <<<"$row"
  c send --unlocked --from "$POOL" "$USDG" 'transfer(address,uint256)' "$to" "$usdg" >/dev/null
  c send --unlocked --from "$POOL" "$WETH" 'transfer(address,uint256)' "$to" "$weth" >/dev/null
  echo "$to  USDG $(num call "$USDG" 'balanceOf(address)(uint256)' "$to")  WETH $(num call "$WETH" 'balanceOf(address)(uint256)' "$to")"
done
c rpc anvil_stopImpersonatingAccount "$POOL" >/dev/null
echo "pool left with USDG $(num call "$USDG" 'balanceOf(address)(uint256)' "$POOL")  WETH $(num call "$WETH" 'balanceOf(address)(uint256)' "$POOL")"

echo "== 5. TWAP: one 1800 s window forward"
c rpc evm_increaseTime 1800 >/dev/null
c rpc evm_mine >/dev/null
echo "block $(c block-number) · timestamp $(c block latest -f timestamp)"

echo "== 6. clean build + DemoLocalFork.s.sol"
forge clean
forge build
forge script script/DemoLocalFork.s.sol --rpc-url "$RPC" --broadcast --private-key "$ANVIL_DEV_KEY"

check() {
  local deployment=../shared/deployment.local.json vault v3 v4 zap_in zap_out plan_executor
  vault=$(jq -r '.vaults[] | select(.key=="demo") | .vault' "$deployment")
  zap_in=$(jq -r '.periphery.zapIn' "$deployment")
  zap_out=$(jq -r '.periphery.zapOut' "$deployment")
  plan_executor=$(jq -r '.periphery.planExecutor' "$deployment")
  echo "deployment.local.json: fork=$(jq '.fork' "$deployment") mintable=$(jq '.mintable' "$deployment") rpcUrl=$(jq -r '.rpcUrl' "$deployment")"
  echo "chain id $(c chain-id) · block $(c block-number)"
  echo "USDG.symbol()      = $(c call "$USDG" 'symbol()(string)')"
  echo "vault [demo]       = $vault  $(c call "$vault" 'symbol()(string)')"
  echo "vault totalTokens  = $(c call "$vault" 'totalTokens()(address[],uint256[])' | tr '\n' ' ')"
  read -r v3 v4 <<<"$(c call "$vault" 'adapters()(address[])' | tr -d '[],')"
  for a in "$v3" "$v4"; do
    echo "adapter $a  dex $(c call "$a" 'dex()(bytes32)')  tokenId $(num call "$a" 'tokenId()(uint256)')  twapTick $(num call "$a" 'twapTick()(int24)')"
    echo "  position $(c call "$a" 'position()(address[],uint256[])' | tr '\n' ' ')"
  done
  echo "NFPM.balanceOf(v3 adapter) = $(num call "$NFPM" 'balanceOf(address)(uint256)' "$v3")"
  echo "NFPM.ownerOf(v3 tokenId)   = $(c call "$NFPM" 'ownerOf(uint256)(address)' "$(num call "$v3" 'tokenId()(uint256)')")"
  echo "POSM.ownerOf(v4 tokenId)   = $(c call "$POSM" 'ownerOf(uint256)(address)' "$(num call "$v4" 'tokenId()(uint256)')")"
  echo "zap-in             = $zap_in  vault registered $(c call "$zap_in" 'isVaultRegistered(address)(bool)' "$vault")"
  echo "zap-out            = $zap_out  vault registered $(c call "$zap_out" 'isVaultRegistered(address)(bool)' "$vault")"
  echo "plan-executor      = $plan_executor  vault keeper $(c call "$vault" 'isKeeper(address)(bool)' "$plan_executor")  keeper(#1) $(c call "$plan_executor" 'isKeeper(address)(bool)' "$KEEPER")  nonce(#1) $(num call "$plan_executor" 'nonces(address)(uint256)' "$KEEPER")"
}

# The venue reads the post-freeze paths depend on (a zap swap walks UR → Permit2 → pool; v4 withdrawals walk
# POSM → PM). Each call also fetches the contract's code into the fork cache; appended to the warm baseline,
# so the frozen node must answer them identically too.
venue_reads() {
  echo "UR.poolManager()           $(c call "$UR" 'poolManager()(address)')"
  echo "Permit2.DOMAIN_SEPARATOR() $(c call "$PERMIT2" 'DOMAIN_SEPARATOR()(bytes32)')"
  echo "NFPM.factory()             $(c call "$NFPM" 'factory()(address)')"
  echo "POSM.nextTokenId()         $(c call "$POSM" 'nextTokenId()(uint256)' | awk '{print $1}')"
  echo "PM.owner()                 $(c call "$PM" 'owner()(address)')"
  echo "SR02.factory()             $(c call "$SR02" 'factory()(address)')"
}

# The zap preview reads: they exercise each zap's own path (vault math, the typed route, the pool's 600 s
# TWAP walk) while the fork is live, so a user's zap on the frozen node takes the cached path.
zap_reads() {
  local deployment=../shared/deployment.local.json vault zap_in zap_out
  vault=$(jq -r '.vaults[] | select(.key=="demo") | .vault' "$deployment")
  zap_in=$(jq -r '.periphery.zapIn' "$deployment")
  zap_out=$(jq -r '.periphery.zapOut' "$deployment")
  echo "zapIn.isVaultRegistered(demo)      $(c call "$zap_in" 'isVaultRegistered(address)(bool)' "$vault")"
  echo "zapIn.previewZap(demo, USDG, 1000e6) $(c call "$zap_in" 'previewZap(address,address,uint256,uint16)(address[],uint256[],uint256,uint256[])' "$vault" "$USDG" 1000000000 0 | tr '\n' ' ')"
  echo "zapOut.isVaultRegistered(demo)     $(c call "$zap_out" 'isVaultRegistered(address)(bool)' "$vault")"
  echo "zapOut.previewRedeem(demo, USDG, 1000e18) $(c call "$zap_out" 'previewRedeem(address,address,uint256,uint16)(address[],uint256[],uint256,uint256[])' "$vault" "$USDG" 1000000000000000000000 0 | tr '\n' ' ')"
}

echo "== 7. post-deploy spot checks (live fork) + fidelity baseline"
check
node script/fork-demo-freeze.mjs warm "$RPC" "$STATE_DIR/warm-live.txt" "$CENTER_TICK" | grep -v '^CENTER_TICK='
{ venue_reads; zap_reads; } | tee -a "$STATE_DIR/warm-live.txt"

echo "== 8. freeze: live fork → standalone anvil state ($STATE_DIR/state.json)"
node script/fork-demo-freeze.mjs dump "$RPC" "$STATE_DIR/local-dump.json"
stop_anvil # the fork flushes ~/.foundry/cache/rpc/<chain>/$FORK_BLOCK on exit
node script/fork-demo-freeze.mjs merge "$STATE_DIR/local-dump.json" "$FORK_BLOCK" "$STATE_DIR/state.json"
start_anvil --state "$STATE_DIR/state.json"
node script/fork-demo-freeze.mjs warm "$RPC" "$STATE_DIR/warm-frozen.txt" "$CENTER_TICK" | grep -v '^CENTER_TICK='
{ venue_reads; zap_reads; } | tee -a "$STATE_DIR/warm-frozen.txt"
if ! diff -u "$STATE_DIR/warm-live.txt" "$STATE_DIR/warm-frozen.txt"; then
  echo "freeze fidelity FAILED: the frozen node answers the warm-up reads differently (diff above)" >&2
  exit 1
fi
echo "freeze fidelity: all $(wc -l <"$STATE_DIR/warm-frozen.txt" | tr -d ' ') warm-up reads answer identically on the frozen node"
c rpc evm_mine >/dev/null # proves the standalone node mines (the aged-out live fork could not)
echo "-- spot checks (frozen standalone anvil) --"
check
echo "fork demo stack is up on :$PORT — next: cd ../frontend && pnpm sync:shared"
