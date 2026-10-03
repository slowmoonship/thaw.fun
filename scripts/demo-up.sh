#!/usr/bin/env bash
# demo-up.sh — one-command bring-up of the isolated, disposable Local demo runtime.
#
# Order of operations (each step fails fast and leaves zero side effects where
# possible; the fresh-network assertion actively stops the network it started):
#   1) pre-flight guards        4) network start          7) web (background)
#   2) skeleton + chains.json   5) fresh assertions       8) readiness checks
#   3) min-version preseed      6) api (background)       9) summary
#
# This script never creates an L1. The first real Create belongs to the user
# in the UI (E2E PASS #1). See docs/DEMO_LOCAL_RUNBOOK.md.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
DEMO_DIR="$REPO_ROOT/.runtime-demo"
LOG_DIR="$DEMO_DIR/logs"
E2E_ROOT="$HOME/.avalanche-cli/e2e"
DEMO_CLI="$REPO_ROOT/scripts/demo-cli.sh"
EXPECTED_CLI_VERSION="1.9.6"
PRIMARY_NETWORK_ID="11111111111111111111111111111111LpoYY"
API_PORT=3000
WEB_PORT=5173

log()  { printf '[demo-up] %s\n' "$*"; }
fail() { printf '[demo-up] FAIL: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- 1) guards
for port in 9650 9651 9652 9653 "$API_PORT" "$WEB_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    fail "port $port is already listening; a previous demo/api/web/network may be up — run ./scripts/demo-down.sh (and ./scripts/demo-reset.sh if a snapshot remains)"
  fi
done
if pgrep -fl avalanchego >/dev/null 2>&1; then
  fail "an avalanchego process is already running"
fi
if [[ -e "$E2E_ROOT/snapshots/default" ]]; then
  fail "previous E2E left a snapshot at $E2E_ROOT/snapshots/default — run ./scripts/demo-reset.sh before starting a new round"
fi
if [[ -e "$E2E_ROOT/localNetworks.json" ]]; then
  fail "$E2E_ROOT/localNetworks.json exists — the local network appears to be running; run ./scripts/demo-down.sh first"
fi
command -v avalanche >/dev/null 2>&1 || fail "avalanche binary not found in PATH"
AV_VERSION="$(avalanche --version 2>/dev/null || true)"
[[ "$AV_VERSION" == "avalanche version $EXPECTED_CLI_VERSION" ]] \
  || fail "avalanche CLI version drift: expected 'avalanche version $EXPECTED_CLI_VERSION', got '$AV_VERSION'"

# ------------------------------------------------------------ 2) skeleton
mkdir -p "$LOG_DIR" "$DEMO_DIR/evidence"
if [[ ! -f "$DEMO_DIR/chains.json" ]]; then
  tmp="$(mktemp "$DEMO_DIR/.chains.json.XXXXXX")"
  printf '[]\n' >"$tmp"
  mv "$tmp" "$DEMO_DIR/chains.json"   # atomic publish (same-directory rename)
fi

# ------------------------------------------------------ 3) min-version preseed
# Known quirk (probe-001): a fresh e2e root has no download-cache/min_cli_version.json
# and this host cannot reach raw.githubusercontent.com, so every CLI command fails.
# Idempotent: only writes when the file is missing or zero bytes.
MINVER="$E2E_ROOT/download-cache/min_cli_version.json"
if [[ ! -s "$MINVER" ]]; then
  mkdir -p "$(dirname "$MINVER")"
  tmp="$(mktemp "$(dirname "$MINVER")/.min_cli_version.json.XXXXXX")"
  printf '{"min-version": "1.9.3"}\n' >"$tmp"
  mv "$tmp" "$MINVER"
fi

# -------------------------------------------------------- 4) network start
log "starting isolated local network (RUN_CLI_E2E baseDir: $E2E_ROOT)"
"$DEMO_CLI" network start --skip-update-check --avalanchego-version v1.14.0 \
  2>&1 | tee "$LOG_DIR/demo-up-network-start.log"

# ----------------------------------------------------- 5) fresh assertions
stop_started_network() {
  log "fresh assertion failed — stopping the network we just started"
  "$DEMO_CLI" network stop --skip-update-check --dont-save \
    >"$LOG_DIR/demo-up-abort-network-stop.log" 2>&1 || true
}
STATUS_OUT="$("$DEMO_CLI" network status --skip-update-check 2>&1 | tee "$LOG_DIR/demo-up-network-status.log")"
grep -q "Network Healthy: true" <<<"$STATUS_OUT" \
  || { stop_started_network; fail "network status does not report 'Network Healthy: true'"; }
grep -q "Blockchains Healthy: true" <<<"$STATUS_OUT" \
  || { stop_started_network; fail "network status does not report 'Blockchains Healthy: true'"; }

curl -s -X POST -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"platform.getBlockchains","params":[]}' \
  http://127.0.0.1:9650/ext/P >"$LOG_DIR/demo-up-blockchains.json"
python3 - "$LOG_DIR/demo-up-blockchains.json" "$PRIMARY_NETWORK_ID" <<'PYEOF' \
  || { stop_started_network; fail "getBlockchains fresh assertion failed (expected exactly 2 blockchains, both on the primary network)"; }
import json, sys
path, primary = sys.argv[1], sys.argv[2]
with open(path) as f:
    doc = json.load(f)
chains = doc.get("result", {}).get("blockchains")
assert isinstance(chains, list), f"unexpected response shape: {doc!r}"
assert len(chains) == 2, f"expected exactly 2 blockchains (X+C), got {len(chains)}: {chains!r}"
for chain in chains:
    assert chain["subnetID"] == primary, f"non-primary subnetID: {chain!r}"
names = sorted(c["name"] for c in chains)
assert names == ["C-Chain", "X-Chain"], f"unexpected chain names: {names!r}"
PYEOF
log "fresh primary network verified: 2 blockchains (X-Chain, C-Chain), subnetID=$PRIMARY_NETWORK_ID"

# --------------------------------------------------------------- 6) api
cd "$REPO_ROOT"
export RUN_CLI_E2E=1
export AVALANCHE_CLI_BASE_DIR="$E2E_ROOT"
export CHAIN_REPOSITORY_PATH="$DEMO_DIR/chains.json"
export SHIPFUN_ENVIRONMENT=local
export API_HOST=127.0.0.1
export API_PORT=$API_PORT
export AVALANCHE_VM_VERSION=v0.8.0
export AVALANCHEGO_VERSION=v1.14.0
export AVALANCHE_SIGNATURE_AGGREGATOR_VERSION=v0.5.4
{
  printf 'RUN_CLI_E2E=%s\n' "$RUN_CLI_E2E"
  printf 'AVALANCHE_CLI_BASE_DIR=%s\n' "$AVALANCHE_CLI_BASE_DIR"
  printf 'CHAIN_REPOSITORY_PATH=%s\n' "$CHAIN_REPOSITORY_PATH"
  printf 'SHIPFUN_ENVIRONMENT=%s\n' "$SHIPFUN_ENVIRONMENT"
  printf 'API_HOST=%s\n' "$API_HOST"
  printf 'API_PORT=%s\n' "$API_PORT"
  printf 'AVALANCHE_VM_VERSION=%s\n' "$AVALANCHE_VM_VERSION"
  printf 'AVALANCHEGO_VERSION=%s\n' "$AVALANCHEGO_VERSION"
  printf 'AVALANCHE_SIGNATURE_AGGREGATOR_VERSION=%s\n' "$AVALANCHE_SIGNATURE_AGGREGATOR_VERSION"
} >"$LOG_DIR/env.log"

log "starting API (pnpm --filter @shipfun/api dev) — log: $LOG_DIR/api.log"
pnpm --filter @shipfun/api dev >"$LOG_DIR/api.log" 2>&1 &
API_PID=$!
printf '%s\n' "$API_PID" >"$DEMO_DIR/api.pid"

# --------------------------------------------------------------- 7) web
log "starting Web (pnpm --filter @shipfun/web dev) — log: $LOG_DIR/web.log"
pnpm --filter @shipfun/web dev >"$LOG_DIR/web.log" 2>&1 &
WEB_PID=$!
printf '%s\n' "$WEB_PID" >"$DEMO_DIR/web.pid"

# ------------------------------------------------------- 8) readiness checks
wait_for_url() { # $1 label, $2 url, $3 max-seconds, $4 out-file
  local label="$1" url="$2" max="$3" out="$4" i
  for ((i = 0; i < max; i++)); do
    if curl -sf -o "$out" "$url" >/dev/null 2>&1; then
      log "$label ready"
      return 0
    fi
    if ! kill -0 "$API_PID" 2>/dev/null || ! kill -0 "$WEB_PID" 2>/dev/null; then
      fail "$label not ready and api/web process died — check $LOG_DIR/api.log / $LOG_DIR/web.log"
    fi
    sleep 1
  done
  fail "$label did not become ready within ${max}s ($url)"
}

wait_for_url "API /health"      "http://127.0.0.1:$API_PORT/health"      60 "$LOG_DIR/readiness-health.json"
wait_for_url "Web (HTTP 200)"  "http://127.0.0.1:$WEB_PORT/"            60 "$LOG_DIR/readiness-web.html"
grep -q '"status":"ok"' "$LOG_DIR/readiness-health.json" \
  || fail "unexpected /health payload: $(cat "$LOG_DIR/readiness-health.json")"
curl -sf "http://127.0.0.1:$API_PORT/environment" >"$LOG_DIR/readiness-environment.json" \
  || fail "GET /environment failed"
grep -q '"environment":"local"' "$LOG_DIR/readiness-environment.json" \
  || fail "unexpected /environment payload: $(cat "$LOG_DIR/readiness-environment.json")"
curl -sf "http://127.0.0.1:$API_PORT/chains" >"$LOG_DIR/readiness-chains.json" \
  || fail "GET /chains failed"
grep -qx '\[\]' "$LOG_DIR/readiness-chains.json" \
  || fail "expected empty chains list [], got: $(cat "$LOG_DIR/readiness-chains.json")"

# ------------------------------------------------------------- 9) summary
printf '%s\n' \
  '[demo-up] ready.' \
  "[demo-up]   UI:                http://127.0.0.1:$WEB_PORT" \
  "[demo-up]   API:               http://127.0.0.1:$API_PORT (health/environment/chains)" \
  "[demo-up]   Local network RPC: http://127.0.0.1:9650 (isolated baseDir $E2E_ROOT)" \
  "[demo-up]   api pid: $API_PID (log $LOG_DIR/api.log)" \
  "[demo-up]   web pid: $WEB_PID (log $LOG_DIR/web.log)" \
  '[demo-up]   stop with: ./scripts/demo-down.sh' \
  '[demo-up]   the first real Create is performed by the user in the UI (E2E PASS #1).'
