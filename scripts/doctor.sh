#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"
printf 'THAW.FUN ENVIRONMENT DOCTOR\n\n'
failures=0; warnings=0
check(){ local label="$1" cmd="$2" ver="$3"; if command -v "$cmd" >/dev/null 2>&1; then pass "$label: $(eval "$ver" 2>&1 | head -n1)"; else fail "$label: missing"; failures=$((failures+1)); fi; }
pass "OS: $(sw_vers -productName) $(sw_vers -productVersion)"
pass "architecture: $(uname -m)"
if bytes="$(sysctl -n hw.memsize 2>/dev/null)"; then pass "RAM: $((bytes/1024/1024/1024)) GiB"; else warn "RAM: sysctl unavailable in sandbox"; warnings=$((warnings+1)); fi
pass "free disk: $(df -h "$PROJECT_ROOT" | awk 'NR==2 {print $4}')"
check Git git 'git --version'; check Node node 'node --version'; check pnpm pnpm 'pnpm --version'; check curl curl 'curl --version'; check jq jq 'jq --version'; check make make 'make --version'; check 'Avalanche CLI' avalanche 'avalanche --version'; check 'Platform CLI' platform-cli 'platform-cli version'; check Foundry forge 'forge --version'
if command -v docker >/dev/null 2>&1; then
  if docker info >/dev/null 2>&1; then pass "Docker: $(docker --version) (running)"; else warn "Docker installed, daemon not running"; warnings=$((warnings+1)); fi
  if docker compose version >/dev/null 2>&1; then pass "Docker Compose: $(docker compose version)"; elif command -v docker-compose >/dev/null 2>&1; then pass "Docker Compose: $(docker-compose version --short)"; else fail "Docker Compose missing"; failures=$((failures+1)); fi
else fail "Docker missing"; fail "Docker Compose missing"; failures=$((failures+2)); fi
if network_is_running; then
  pass "Avalanche local network running"
  curl --fail --silent "${PLATFORM_RPC_URL}/ext/health" >/dev/null && pass "Avalanche RPC healthy" || { fail "Avalanche RPC unhealthy"; failures=$((failures+1)); }
  if id="$(rpc eth_chainId | jq -er .result)"; then pass "ShipFunDev chain ID: $id"; else fail "ShipFunDev RPC unavailable"; failures=$((failures+1)); fi
  if block="$(rpc eth_blockNumber | jq -er .result)"; then pass "ShipFunDev block: $block"; else fail "ShipFunDev block unavailable"; failures=$((failures+1)); fi
else warn "Avalanche local network not running (run make local-up)"; warnings=$((warnings+1)); fi
printf '\nSUMMARY: '
if ((failures)); then printf 'FAIL (%d failures, %d warnings)\n' "$failures" "$warnings"; exit 1; elif ((warnings)); then printf 'WARN (%d warnings)\n' "$warnings"; else printf 'PASS\n'; fi
