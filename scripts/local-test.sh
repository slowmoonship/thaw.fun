#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"
# Public EWOQ key from Avalanche local test genesis; never use outside local.
LOCAL_TEST_PRIVATE_KEY="${SHIPFUN_LOCAL_TEST_PRIVATE_KEY:-56289e99c94b6912bfc12adc093c9b51124f0dc54ac7a766b2bc5ccf558d8027}"
FUNDED_ADDRESS=0x8db97C7cece249c2b98bdC0226Cc4C2A57BF52FC
RECIPIENT=0x1111111111111111111111111111111111111111
network_is_running || { fail "Avalanche local network not running"; exit 1; }; pass "Avalanche local network running"
chain_hex="$(rpc eth_chainId | jq -er .result)"; chain_decimal="$((chain_hex))"
[[ "$chain_decimal" == "$CHAIN_ID_DECIMAL" ]] || { fail "chain ID $chain_decimal expected $CHAIN_ID_DECIMAL"; exit 1; }; pass "eth_chainId = $chain_hex ($chain_decimal)"
b1h="$(rpc eth_blockNumber | jq -er .result)"; b1="$((b1h))"
balance="$(cast balance "$FUNDED_ADDRESS" --rpc-url "$LOCAL_RPC_URL")"; ((balance>0)) || { fail "zero balance"; exit 1; }; pass "native balance non-zero"
tx_json="$(cast send "$RECIPIENT" --value 1wei --private-key "$LOCAL_TEST_PRIVATE_KEY" --rpc-url "$LOCAL_RPC_URL" --json)"
tx_hash="$(jq -er .transactionHash <<<"$tx_json")"; [[ "$(jq -er .status <<<"$tx_json")" == 0x1 ]] || { fail "transfer reverted"; exit 1; }; pass "native transfer: $tx_hash"
b2h="$(rpc eth_blockNumber | jq -er .result)"; b2="$((b2h))"
((b2>b1)) || { fail "block did not grow after confirmed transaction ($b1 -> $b2)"; exit 1; }; pass "blocks grow: $b1 -> $b2"
deploy="$(forge create "$PROJECT_ROOT/contracts/src/HelloShip.sol:HelloShip" --root "$PROJECT_ROOT/contracts" --rpc-url "$LOCAL_RPC_URL" --private-key "$LOCAL_TEST_PRIVATE_KEY" --broadcast 2>&1)"
address="$(awk '/Deployed to:/ {print $3}' <<<"$deploy" | tail -n1)"; [[ "$address" =~ ^0x[0-9a-fA-F]{40}$ ]] || { printf '%s\n' "$deploy"; fail "deployment parse failed"; exit 1; }; pass "HelloShip deployed: $address"
message="$(cast call "$address" 'message()(string)' --rpc-url "$LOCAL_RPC_URL")"; [[ "$message" == '"ship.fun environment ready"' ]] || { fail "unexpected response: $message"; exit 1; }; pass "contract call: $message"
latest_hex="$(rpc eth_blockNumber | jq -er .result)"; latest="$((latest_hex))"; pass "latest tested block: $latest"
presult="$(curl --fail --silent --show-error -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"platform.getBlockchains","params":{}}' "$PLATFORM_RPC_URL/ext/bc/P")"
blockchain_id="$(jq -er --arg n "$CHAIN_NAME" '.result.blockchains[]|select(.name==$n)|.id' <<<"$presult" | head -n1)"; subnet_id="$(jq -er --arg n "$CHAIN_NAME" '.result.blockchains[]|select(.name==$n)|.subnetID' <<<"$presult" | head -n1)"
printf 'SHIPFUN_LOCAL_SUBNET_ID=%s\nSHIPFUN_LOCAL_BLOCKCHAIN_ID=%s\nSHIPFUN_LOCAL_EVM_CHAIN_ID=%s\nSHIPFUN_LOCAL_RPC_URL=%s\nSHIPFUN_LOCAL_LATEST_BLOCK=%s\nSHIPFUN_LOCAL_HELLOSHIP_ADDRESS=%s\nSHIPFUN_LOCAL_TRANSFER_TX=%s\n' "$subnet_id" "$blockchain_id" "$chain_decimal" "$LOCAL_RPC_URL" "$latest" "$address" "$tx_hash" >"$RUNTIME_FILE"
chmod 600 "$RUNTIME_FILE"; printf '\nALL PASS\n'
