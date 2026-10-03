#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"
printf 'THAW.FUN FUJI CHECK\n'
key="${SHIPFUN_FUJI_KEY_NAME:-}"
if [[ -z "$key" ]]; then warn "SHIPFUN_FUJI_KEY_NAME unset"; printf 'ACTION: create an isolated encrypted Fuji key, fund it from the Fuji faucet, then set SHIPFUN_FUJI_KEY_NAME.\n'; exit 2; fi
platform-cli wallet address --network fuji --key-name "$key"
platform-cli wallet balance --network fuji --key-name "$key"
