#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"
network_is_running || { fail "Avalanche local network is not healthy"; exit 1; }
pass "Avalanche local network healthy"
printf 'ShipFunDev RPC: %s\n' "$LOCAL_RPC_URL"
printf 'Chain ID: %s\n' "$(rpc eth_chainId | jq -er .result)"
printf 'Block number: %s\n' "$(rpc eth_blockNumber | jq -er .result)"
if [[ -f "$SIDECAR_FILE" ]]; then
  printf 'Subnet ID: %s\n' "$(jq -r '.Networks["Local Network"].SubnetID' "$SIDECAR_FILE")"
  printf 'Blockchain ID: %s\n' "$(jq -r '.Networks["Local Network"].BlockchainID' "$SIDECAR_FILE")"
fi
