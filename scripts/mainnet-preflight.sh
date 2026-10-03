#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"
printf 'THAW.FUN MAINNET PREFLIGHT\n\n'; failures=0
for cmd in avalanche platform-cli curl jq; do command -v "$cmd" >/dev/null && pass "$cmd available" || { fail "$cmd missing"; failures=$((failures+1)); }; done
for rel in infra/server/bootstrap-ubuntu.sh infra/docker/docker-compose.yml infra/server/Caddyfile infra/server/avalanchego-config.example.json scripts/mainnet-guard.sh; do [[ -f "$PROJECT_ROOT/$rel" ]] && pass "template present: $rel" || { fail "missing: $rel"; failures=$((failures+1)); }; done
if command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then compose=(docker compose); elif command -v docker-compose >/dev/null 2>&1; then compose=(docker-compose); else compose=(); fi
if ((${#compose[@]})) && "${compose[@]}" -f "$PROJECT_ROOT/infra/docker/docker-compose.yml" config --quiet; then pass "Docker Compose config valid"; else fail "Docker Compose config not validated"; failures=$((failures+1)); fi
if jq -e '."http-host"=="127.0.0.1" and ."http-port"==9650' "$PROJECT_ROOT/infra/server/avalanchego-config.example.json" >/dev/null; then pass "AvalancheGo config valid and localhost-only"; else fail "AvalancheGo config invalid/unsafe"; failures=$((failures+1)); fi
if git -C "$PROJECT_ROOT" grep -nEI '(private[_-]?key|AVALANCHE_PRIVATE_KEY)=[0-9a-fA-F]{64}' -- . ':!scripts/local-test.sh' >/dev/null 2>&1; then fail "possible committed key"; failures=$((failures+1)); else pass "no non-local keys detected"; fi
[[ -n "${SHIPFUN_MAINNET_KEY_NAME:-}" ]] && pass "encrypted keystore name configured" || warn "SHIPFUN_MAINNET_KEY_NAME undefined"
if ((failures)); then printf '\nMAINNET PREFLIGHT FAIL (%d blockers)\nMAINNET DEPLOYMENT NOT EXECUTED\n' "$failures"; exit 1; fi
printf '\nMAINNET PREFLIGHT READY\nMAINNET DEPLOYMENT NOT EXECUTED\n'
