#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"
if network_is_running && rpc eth_chainId >/dev/null 2>&1; then pass "local Avalanche network and ShipFunDev L1 already running"; exit 0; fi
CHAIN_CONFIG="${HOME}/.avalanche-cli/subnets/${CHAIN_NAME}/sidecar.json"
restart_node() {
  local flags_file="$1" process_file node_dir pid uri staking log_file http_port staking_port label
  node_dir="$(dirname "$flags_file")"; process_file="$node_dir/process.json"
  pid="$(jq -r '.pid // 0' "$process_file" 2>/dev/null || printf '0')"
  http_port="$(jq -r '."http-port"' "$flags_file")"; staking_port="$(jq -r '."staking-port"' "$flags_file")"
  label="com.shipfun.avalanchego.${http_port}"
  if launchctl print "gui/$(id -u)/${label}" >/dev/null 2>&1; then return 0; fi
  if ((pid>0)) && kill -0 "$pid" 2>/dev/null; then return 0; fi
  uri="http://127.0.0.1:${http_port}"; staking="127.0.0.1:${staking_port}"
  log_file="$node_dir/logs/shipfun-supervisor.log"
  mkdir -p "$node_dir/logs"
  launchctl submit -l "$label" -o "$log_file" -e "$log_file" -- "${HOME}/.avalanche-cli/bin/avalanchego/avalanchego-v1.14.0/avalanchego" --config-file "$flags_file"
  for _ in {1..10}; do pid="$(launchctl print "gui/$(id -u)/${label}" 2>/dev/null | awk '/^[[:space:]]*pid = / {print $3; exit}')"; [[ -n "$pid" ]] && break; sleep 1; done
  [[ -n "$pid" ]] || { fail "launchctl did not start $label"; exit 1; }
  jq -n --argjson pid "$pid" --arg uri "$uri" --arg staking "$staking" '{pid:$pid,uri:$uri,stakingAddress:$staking}' >"$process_file.tmp"
  mv "$process_file.tmp" "$process_file"
}
if [[ -f "$CHAIN_CONFIG" ]] && jq -e '.Networks["Local Network"].BlockchainID != ""' "$CHAIN_CONFIG" >/dev/null; then
  latest_run="$(find "${HOME}/.avalanche-cli/runs" -maxdepth 1 -type d -name 'network_*' -print | sort | tail -n1)"
  if [[ -n "$latest_run" ]]; then while IFS= read -r file; do restart_node "$file"; done < <(find "$latest_run" -mindepth 2 -maxdepth 2 -name flags.json -print | sort); fi
  while IFS= read -r file; do restart_node "$file"; done < <(find "${HOME}/.avalanche-cli/local/${CHAIN_NAME}-local-node-local-network" -mindepth 2 -maxdepth 2 -name flags.json -print | sort)
  for _ in {1..60}; do if network_is_running && rpc eth_chainId >/dev/null 2>&1; then pass "restored persisted local Avalanche nodes"; exit 0; fi; sleep 1; done
  fail "persisted nodes did not become healthy"; exit 1
fi
if [[ ! -f "$CHAIN_CONFIG" ]]; then
  avalanche blockchain create "$CHAIN_NAME" --skip-update-check --evm --vm-version v0.8.0 --proof-of-authority --test-defaults --evm-chain-id "$CHAIN_ID_DECIMAL" --evm-token SHIP --validator-manager-owner 0x8db97C7cece249c2b98bdC0226Cc4C2A57BF52FC --proxy-contract-owner 0x8db97C7cece249c2b98bdC0226Cc4C2A57BF52FC
  [[ -f "$CHAIN_CONFIG" ]] || { fail "Avalanche CLI did not persist ShipFunDev configuration"; exit 1; }
fi
if ! avalanche blockchain deploy "$CHAIN_NAME" --skip-update-check --local --ewoq --avalanchego-version v1.14.0 --signature-aggregator-version v0.5.4; then
  source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"
  rpc eth_chainId >/dev/null 2>&1 || { fail "deployment stopped before ShipFunDev RPC became usable"; exit 1; }
  warn "CLI post-deploy helper failed, but the L1 RPC is live"
fi
pass "ShipFunDev local L1 started"
