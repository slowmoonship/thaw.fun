#!/usr/bin/env bash
# demo-reset.sh — wipe the disposable demo unit, keep the evidence.
#
# Removes:
#   - ~/.avalanche-cli/e2e            (the whole isolated CLI state unit:
#                                       snapshots/runs/subnets/bin/download-cache/...)
#   - .runtime-demo/chains.json       (API chain records)
#   - .runtime-demo/logs/*            (runtime logs of the wiped rounds)
#   - .runtime-demo/*.pid             (stale pid files)
# Keeps:
#   - .runtime-demo/evidence/         (probe + card evidence — NEVER deleted)
#
# Historical note: the probe-001 command log originally lived at
# .runtime-demo/logs/commands.log. Before wiping logs/, this script moves it
# (once) into evidence/probe-001/ so the historical evidence survives the
# reset, matching the W7 acceptance criterion "probe-001 evidence unchanged
# (49 files + commands.log)".
#
# Why a reset is mandatory between E2E rounds: the API's Local DEAD path runs
# `avalanche network stop` WITHOUT --dont-save, so a completed E2E saves the
# network state as ~/.avalanche-cli/e2e/snapshots/default. The next
# `network start` would then RESTORE that snapshot (with its chain history)
# instead of creating a fresh genesis. demo-up refuses to start in that state.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
DEMO_DIR="$REPO_ROOT/.runtime-demo"
LOG_DIR="$DEMO_DIR/logs"
E2E_ROOT="$HOME/.avalanche-cli/e2e"

log()  { printf '[demo-reset] %s\n' "$*"; }
fail() { printf '[demo-reset] FAIL: %s\n' "$*" >&2; exit 1; }

# ------------------------------------------------------- preconditions
for port in 3000 5173 9650 9651 9652 9653 9654 9655 9656 9657 9658 9659 9660; do
  if lsof -nP -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    fail "port $port is still listening — run ./scripts/demo-down.sh first (reset refuses to run while anything is up)"
  fi
done
if pgrep -fl avalanchego >/dev/null 2>&1; then
  fail "an avalanchego process is still running — run ./scripts/demo-down.sh first"
fi
if [[ -e "$E2E_ROOT/localNetworks.json" ]]; then
  fail "$E2E_ROOT/localNetworks.json exists — the local network appears to be running; run ./scripts/demo-down.sh first"
fi

# -------------------------------------------------------------- wipe
if [[ -d "$E2E_ROOT" ]]; then
  rm -rf "$E2E_ROOT"
  log "removed $E2E_ROOT"
else
  log "$E2E_ROOT already absent"
fi

rm -f "$DEMO_DIR/chains.json"
rm -f "$DEMO_DIR"/*.pid
log "removed chains.json and pid files (if present)"

# Preserve the historical probe-001 command log, then wipe runtime logs.
if [[ -f "$LOG_DIR/commands.log" && ! -f "$DEMO_DIR/evidence/probe-001/commands.log" ]]; then
  mv "$LOG_DIR/commands.log" "$DEMO_DIR/evidence/probe-001/commands.log"
  log "preserved probe-001 commands.log -> evidence/probe-001/commands.log"
fi
if [[ -d "$LOG_DIR" ]]; then
  find "$LOG_DIR" -mindepth 1 -delete
  log "cleared $LOG_DIR"
fi

# ------------------------------------------------- final structure proof
log "remaining .runtime-demo structure:"
( cd "$DEMO_DIR" && find . | sort ) | sed 's/^/  /'
if [[ ! -d "$DEMO_DIR/evidence" ]]; then
  fail "evidence directory missing after reset"
fi
log "reset complete — evidence/ preserved; ready for a fresh demo-up"
