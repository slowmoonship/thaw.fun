# Local Demo Runbook (isolated, disposable runtime)

Operational manual for running the thaw.fun Local demo on this machine using the
`demo-*` scripts. Everything runs against an **isolated** Avalanche CLI state root
(`~/.avalanche-cli/e2e`); the historical `~/.avalanche-cli` state, the quarantine,
and all Fuji data are never read or written (verified in probe-001 / REPORT #002).

## Components

| Component | Address | Started by |
| --- | --- | --- |
| UI (Web) | http://127.0.0.1:5173 | `demo-up.sh` (vite; `/api` proxied to the API) |
| API | http://127.0.0.1:3000 (`/health`, `/environment`, `/chains`) | `demo-up.sh` (pnpm `@shipfun/api` dev) |
| Local network RPC | http://127.0.0.1:9650 (primary nodes on 9650/9652) | `demo-up.sh` (RUN_CLI_E2E-isolated `avalanche network start`) |
| CLI state root | `~/.avalanche-cli/e2e` | `demo-cli.sh` forces `RUN_CLI_E2E=1` |
| API chain records | `.runtime-demo/chains.json` | `demo-up.sh` (`CHAIN_REPOSITORY_PATH`) |

## Standard flow

```
./scripts/demo-up.sh          # fresh primary network + API + Web + readiness checks
# -> open http://127.0.0.1:5173
# -> the USER fills in the L1 parameters (e.g. Frostbite / FRST / 300s) and clicks Create
# -> observe CREATING -> LIVE -> EXPIRING -> DEAD in the UI
./scripts/demo-down.sh        # stop Web, API, and the network (no snapshot saved)
```

**Discipline:** the first real Create is always performed by the user in the UI.
An agent must never silently create a chain on the user's behalf.

`demo-up.sh` aborts (without side effects) when any port is busy, an
`avalanchego` process exists, a leftover snapshot exists, or the CLI version is
not 1.9.6. Its freshness assertion requires `getBlockchains` to return exactly
the two primary-network chains (X-Chain, C-Chain) with subnetID
`11111111111111111111111111111111LpoYY`; anything else means old state leaked in
and the run is not a fresh demo.

## E2E PASS #1 / #2 / #3 (reproducibility standard, handoff §12)

- **E2E PASS #1** — first genuine full cycle on the isolated runtime
  (`demo-up` → user Create → LIVE with real IDs + working RPC → natural
  EXPIRING → DEAD → `demo-down`). One pass does **not** make the demo
  "reproducible".
- **E2E PASS #2** — run `./scripts/demo-reset.sh`, then complete a second,
  fully independent cycle. Only after PASS #2 may the demo be called
  **LOCAL DEMO READY**.
- **E2E PASS #3** — a third reset + cycle, used for the **final recording**.

## Why `demo-reset.sh` is mandatory between rounds

The API's Local DEAD path ends with `avalanche network stop` **without**
`--dont-save`. After a real E2E reaches DEAD, the CLI therefore saves the
network state as `~/.avalanche-cli/e2e/snapshots/default`. The next
`network start` would **restore that snapshot** (chain history included)
instead of creating a fresh genesis — which would silently break the
"disposable demo" guarantee. Consequences:

1. After every completed E2E round: `./scripts/demo-down.sh`, then
   `./scripts/demo-reset.sh` before the next `demo-up.sh`.
2. `demo-up.sh` hard-fails if `snapshots/default` exists, with a pointer to
   the reset script. Never try to "reuse" a post-E2E snapshot for the next demo.

`demo-reset.sh` deletes `~/.avalanche-cli/e2e`, `.runtime-demo/chains.json`,
`.runtime-demo/logs/*`, and stale pid files. It **never** deletes
`.runtime-demo/evidence/`.

## Evidence checklist for every E2E round

Save all of the following for each PASS round (they are the acceptance record):

- [ ] API record ID (`GET /chains` / `GET /chains/:id`)
- [ ] Subnet ID and Blockchain ID of the created L1
- [ ] EVM chain ID (`eth_chainId` result)
- [ ] RPC request/response transcripts: `eth_chainId`, `eth_blockNumber`
      before and after a real transaction (block-growth proof)
- [ ] Lifecycle timestamps: created / expires / expiredAt (from the API record)
- [ ] UI screenshots (Create form, CREATING, LIVE, EXPIRING, DEAD)
- [ ] `api.log` / `web.log` paths (`.runtime-demo/logs/`) and the round's
      `demo-up`/`demo-down` console output
- [ ] `git commit` hash of the repo at demo time
- [ ] Demo script versions (`scripts/demo-*.sh`; currently delivered by
      Card #004, 2026-09-29)

Do not infer one round's IDs or block proofs from another round's records.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `demo-up` fails on `min_cli_version.json` | The preseed step normally prevents this (writes `{"min-version": "1.9.3"}` into the e2e root). If it still fails, check `~/.avalanche-cli/e2e/download-cache/` is writable, then re-run `demo-up` (the preseed step itself is idempotent). Do not hand-edit anything under the old `~/.avalanche-cli`. |
| `demo-up` fails: port busy | A previous demo/API/web/network is still up. Run `./scripts/demo-down.sh` and retry. |
| `demo-up` fails: leftover snapshot at `~/.avalanche-cli/e2e/snapshots/default` | Expected after a real E2E (see above). Run `./scripts/demo-reset.sh`, then `demo-up` again. |
| Fresh assertion fails (`getBlockchains` ≠ exactly X+C, or unhealthy) | **Stop. Do not demo in this state.** The network was already stopped by the script; collect `demo-up-network-*.log` / `demo-up-blockchains.json` from `.runtime-demo/logs/` and report to the operator/PM. |
| `demo-down` reports leftover processes | Re-run `./scripts/demo-down.sh` (idempotent). If a port stays bound, identify the holder via `lsof -nP -iTCP:<port> -sTCP:LISTEN` before doing anything manual. |

Never run `avalanche network clean`, never use `--snapshot-name`, and never
invoke the bare `avalanche` command for demo work — always go through
`./scripts/demo-cli.sh`, which forces `RUN_CLI_E2E=1` so the isolated state
root is used.
