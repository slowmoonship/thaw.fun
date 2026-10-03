#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"
stopped=0
latest_run="$(find "${HOME}/.avalanche-cli/runs" -maxdepth 1 -type d -name 'network_*' -print | sort | tail -n1)"
flags_files=()
if [[ -n "$latest_run" ]]; then while IFS= read -r file; do flags_files+=("$file"); done < <(find "$latest_run" -mindepth 2 -maxdepth 2 -name flags.json -print | sort); fi
while IFS= read -r file; do flags_files+=("$file"); done < <(find "${HOME}/.avalanche-cli/local/${CHAIN_NAME}-local-node-local-network" -mindepth 2 -maxdepth 2 -name flags.json -print | sort)
for flags in "${flags_files[@]}"; do
  file="$(dirname "$flags")/process.json"
  http_port="$(jq -r '."http-port"' "$flags")"; label="com.shipfun.avalanchego.${http_port}"
  if launchctl print "gui/$(id -u)/${label}" >/dev/null 2>&1; then launchctl remove "$label"; stopped=$((stopped+1)); continue; fi
  pid="$(jq -r '.pid // 0' "$file" 2>/dev/null || printf '0')"
  if ((pid>0)) && kill -0 "$pid" 2>/dev/null; then
    command_line="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    [[ "$command_line" == *".avalanche-cli/bin/avalanchego/"* ]] || { fail "refusing to stop unrecognized PID $pid"; exit 1; }
    kill -TERM "$pid"; stopped=$((stopped+1))
  fi
done
for _ in {1..30}; do
  alive=0; for flags in "${flags_files[@]}"; do http_port="$(jq -r '."http-port"' "$flags")"; label="com.shipfun.avalanchego.${http_port}"; launchctl print "gui/$(id -u)/${label}" >/dev/null 2>&1 && alive=$((alive+1)); file="$(dirname "$flags")/process.json"; pid="$(jq -r '.pid // 0' "$file" 2>/dev/null || printf '0')"; ((pid>0)) && kill -0 "$pid" 2>/dev/null && alive=$((alive+1)); done
  ((alive==0)) && { pass "gracefully stopped $stopped persisted AvalancheGo nodes"; exit 0; }
  sleep 1
done
fail "one or more AvalancheGo nodes did not stop within 30 seconds"; exit 1
