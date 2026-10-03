#!/usr/bin/env bash
# demo-down.sh — tear the demo runtime down in reverse order: Web -> API -> network.
#
# Process cleanup mechanism (documented for the report):
#   primary:   PID files written by demo-up.sh (.runtime-demo/{api,web}.pid);
#              the recorded PID plus its whole descendant tree (recursive
#              pgrep -P) receives SIGTERM.
#   fallback:  whatever still LISTENs on 3000 / 5173 (lsof -t) receives SIGTERM.
#              demo-up's guards guarantee those ports can only be ours.
#   escalate:  if a port is still bound after TERM + grace period, SIGKILL.
#   network:   RUN_CLI_E2E-isolated `avalanche network stop --dont-save`
#              (never saves a snapshot; never network clean).
# The script is idempotent: running it on an already-down runtime exits 0.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
DEMO_DIR="$REPO_ROOT/.runtime-demo"
LOG_DIR="$DEMO_DIR/logs"
DEMO_CLI="$REPO_ROOT/scripts/demo-cli.sh"
API_PORT=3000
WEB_PORT=5173

log()  { printf '[demo-down] %s\n' "$*"; }
fail() { printf '[demo-down] FAIL: %s\n' "$*" >&2; exit 1; }

collect_descendants() { # $1: pid — prints descendant pids (children first)
  local pid="$1" child
  while IFS= read -r child; do
    [[ -n "$child" ]] || continue
    collect_descendants "$child"
    printf '%s\n' "$child"
  done < <(pgrep -P "$pid" 2>/dev/null || true)
}

term_tree() { # $1: root pid
  local pid="$1" d
  [[ -n "$pid" ]] || return 0
  kill -TERM "$pid" 2>/dev/null || true
  while IFS= read -r d; do
    [[ -n "$d" ]] && kill -TERM "$d" 2>/dev/null || true
  done < <(collect_descendants "$pid")
}

wait_port_free() { # $1: port, $2: label — TERM fallback then KILL escalation
  local port="$1" label="$2" i pids pid
  if ! lsof -nP -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    log "$label: port $port already free"
    return 0
  fi
  pids="$(lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  for pid in $pids; do term_tree "$pid"; done
  for ((i = 0; i < 15; i++)); do
    lsof -nP -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 || { log "$label: port $port released"; return 0; }
    sleep 1
  done
  pids="$(lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  for pid in $pids; do
    log "$label: escalating to SIGKILL on port $port holder $pid"
    kill -KILL "$pid" 2>/dev/null || true
  done
  sleep 1
  lsof -nP -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 \
    || { log "$label: port $port released (after KILL)"; return 0; }
  fail "port $port is still bound after TERM+KILL"
}

stop_component() { # $1: label, $2: pid file, $3: port
  local label="$1" pidfile="$2" port="$3" pid
  if [[ -f "$pidfile" ]]; then
    pid="$(cat "$pidfile" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      log "stopping $label (pid tree rooted at $pid)"
      term_tree "$pid"
    else
      log "$label: recorded pid not alive (pid file: $pidfile)"
    fi
  else
    log "$label: no pid file (not started by demo-up?)"
  fi
  wait_port_free "$port" "$label"
  rm -f "$pidfile"
}

# ------------------------------------------------------------------ web
stop_component "Web" "$DEMO_DIR/web.pid" "$WEB_PORT"

# ------------------------------------------------------------------ api
stop_component "API" "$DEMO_DIR/api.pid" "$API_PORT"

# --------------------------------------------------------------- network
if "$DEMO_CLI" network stop --skip-update-check --dont-save \
     >"$LOG_DIR/demo-down-network-stop.log" 2>&1; then
  log "network stopped (--dont-save; no snapshot written)"
else
  if grep -qi "network is not running" "$LOG_DIR/demo-down-network-stop.log"; then
    log "network was already stopped (idempotent)"
  else
    cat "$LOG_DIR/demo-down-network-stop.log" >&2
    fail "network stop failed"
  fi
fi

# ------------------------------------------------------------ assertions
for port in "$API_PORT" "$WEB_PORT" 9650 9651 9652 9653 9654 9655 9656 9657 9658 9659 9660; do
  lsof -nP -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 \
    && fail "port $port is still listening after teardown"
done
if pgrep -fl avalanchego >/dev/null 2>&1; then
  pgrep -fl avalanchego >&2
  fail "avalanchego processes still running after teardown"
fi
for pattern in "tsx watch src/server.ts" "vite --host 127.0.0.1"; do
  if pgrep -fl "$pattern" | grep -v "$0" >/dev/null 2>&1; then
    pgrep -fl "$pattern" >&2
    fail "leftover process matching '$pattern'"
  fi
done

log "demo runtime fully down (ports free, no residual processes)"
