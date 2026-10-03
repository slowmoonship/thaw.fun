#!/usr/bin/env bash
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="${HOME}/.local/bin:${HOME}/bin:${HOME}/.foundry/bin:${PATH}"
CHAIN_NAME=ShipFunDev
CHAIN_ID_DECIMAL=20250917
SIDECAR_FILE="${HOME}/.avalanche-cli/subnets/${CHAIN_NAME}/sidecar.json"
if [[ -n "${SHIPFUN_LOCAL_RPC_URL:-}" ]]; then
  LOCAL_RPC_URL="$SHIPFUN_LOCAL_RPC_URL"
elif [[ -f "$SIDECAR_FILE" ]]; then
  LOCAL_RPC_URL="$(jq -r '.Networks["Local Network"].RPCEndpoints[0] // empty' "$SIDECAR_FILE")"
else
  LOCAL_RPC_URL="http://127.0.0.1:9654/ext/bc/${CHAIN_NAME}/rpc"
fi
PLATFORM_RPC_URL=http://127.0.0.1:9650
RUNTIME_FILE="${PROJECT_ROOT}/avalanche/local/runtime.env"
pass(){ printf 'PASS  %s\n' "$*"; }
warn(){ printf 'WARN  %s\n' "$*"; }
fail(){ printf 'FAIL  %s\n' "$*"; }
rpc(){ curl --fail --silent --show-error -H 'content-type: application/json' --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":[]}" "${LOCAL_RPC_URL}"; }
network_is_running(){ curl --max-time 2 --fail --silent "${PLATFORM_RPC_URL}/ext/health" >/dev/null 2>&1; }
