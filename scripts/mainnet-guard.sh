#!/usr/bin/env bash
set -euo pipefail
required=I_KNOW_THIS_SPENDS_REAL_AVAX
if [[ "${SHIPFUN_MAINNET_CONFIRM:-}" != "$required" ]]; then printf 'REFUSED: Mainnet mutation is locked.\n' >&2; exit 64; fi
printf 'Guard unlocked, but no Mainnet mutation is implemented by this bootstrap.\n'; exit 65
