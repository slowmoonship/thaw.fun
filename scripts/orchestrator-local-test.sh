#!/usr/bin/env bash
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_PORT="${ORCHESTRATOR_TEST_PORT:-3100}"
API_URL="http://127.0.0.1:${API_PORT}"
REPOSITORY_PATH="${PROJECT_ROOT}/.runtime/e2e-chains.json"
RESULT_PATH="${PROJECT_ROOT}/.runtime/orchestrator-e2e.json"
mkdir -p "${PROJECT_ROOT}/.runtime"

APP_ENVIRONMENT=local API_HOST=127.0.0.1 API_PORT="$API_PORT" CHAIN_REPOSITORY_PATH="$REPOSITORY_PATH" \
  pnpm --dir "$PROJECT_ROOT" --filter @shipfun/api exec tsx src/server.ts >"${PROJECT_ROOT}/.runtime/e2e-api.log" 2>&1 &
api_pid=$!
cleanup(){ kill "$api_pid" >/dev/null 2>&1 || true; wait "$api_pid" >/dev/null 2>&1 || true; }
trap cleanup EXIT

for _ in {1..30}; do curl --fail --silent "$API_URL/health" >/dev/null 2>&1 && break; sleep 1; done
curl --fail --silent "$API_URL/health" >/dev/null

created="$(curl --fail --silent -H 'content-type: application/json' --data '{"name":"E2E Demo","symbol":"E2E","lifetimeSeconds":60}' "$API_URL/chains")"
chain_id="$(jq -er .id <<<"$created")"
printf 'Created %s\n' "$chain_id"

deadline=$((SECONDS+1200))
saw_live=0
while ((SECONDS<deadline)); do
  status_json="$(curl --fail --silent "$API_URL/chains/$chain_id")"
  status="$(jq -er .status <<<"$status_json")"
  printf '%s status=%s block=%s remaining=%s\n' "$(date -u +%FT%TZ)" "$status" "$(jq -r '.latestBlock // .finalBlock // "-"' <<<"$status_json")" "$(jq -r '.remainingSeconds' <<<"$status_json")"
  if [[ "$status" == LIVE ]]; then saw_live=1; fi
  if [[ "$status" == DEAD ]]; then
    ((saw_live==1)) || { printf 'FAIL chain reached DEAD without observed LIVE\n' >&2; exit 1; }
    jq -e '.subnetId and .blockchainId and .rpcUrl and (.finalBlock|type=="number") and .expiredAt' <<<"$status_json" >/dev/null
    jq . <<<"$status_json" >"$RESULT_PATH"
    printf 'PASS birth -> life -> death; evidence: %s\n' "$RESULT_PATH"
    exit 0
  fi
  if [[ "$status" == FAILED ]]; then jq . <<<"$status_json"; exit 1; fi
  sleep 5
done
printf 'FAIL timed out waiting for DEAD\n' >&2
exit 1
