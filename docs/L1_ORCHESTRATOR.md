# L1 Orchestrator

## Architecture

`Fastify routes → L1Orchestrator → AvalancheAdapter → CommandRunner / JSON-RPC`.
Chain records are stored in `.runtime/chains.json` through an atomic temporary-file-and-rename repository. Avalanche CLI commands accept argument arrays and never pass user input through a shell. Display names are separated from generated letter-only CLI names such as `chainakcnpfbe` (CLI 1.9.6 rejects digits and punctuation in names).

## State machine

Allowed transitions are `CREATING → LIVE|FAILED`, `LIVE → EXPIRING|FAILED`, and `EXPIRING → DEAD|FAILED`. `DEAD` and `FAILED` are terminal. The lifetime starts only after metadata, `eth_chainId`, `eth_blockNumber`, and transaction-backed block growth are verified.

A creation records `requiresRecovery = true` immediately before the adapter begins an external deploy mutation. Successful creation clears it. If readiness fails or the API is interrupted after that point, the record may become `FAILED` but continues to occupy the single active slot until the external resources are explicitly reconciled. Failures before the mutation marker remain ordinary `FAILED` records and release the slot.

## Local behavior

Only one disposable chain may be active. Creation uses Avalanche CLI 1.9.6 with pinned Subnet-EVM/AvalancheGo versions, no automatic ICM deployment, and no relayer. IDs and RPC are read from CLI sidecar metadata and cross-checked against genesis and RPC.

On this offline development host, CLI 1.9.6 can leave `download-cache/min_cli_version.json` as a zero-byte file and then fail every command while parsing it. Before each CLI operation the adapter backs up only that empty cache file and restores the verified official `min-version` schema (default `1.9.3`, overridable by `AVALANCHE_MIN_CLI_VERSION`); it never modifies chain state or metadata.

Avalanche CLI 1.9.6 does not expose a reliable single-L1 process stop. Expiration therefore attempts to record the final block, then uses graceful `avalanche network stop`; an unavailable final-block RPC is logged but cannot prevent death. The adapter checks official Local network status first, so replay after a crash between physical stop and `DEAD` persistence safely treats an already stopped network as success. This is intentionally Local-only and preserves the CLI snapshot/configuration; it never runs `network clean`.

## API

- `POST /chains` returns `202 { id, status: "CREATING" }`.
- `GET /chains/:id` returns persisted identity plus current block, RPC health, and remaining seconds.
- `GET /chains` lists historical records.
- `POST /chains/:id/expire` runs the same real expiration path early.

At API startup, overdue `LIVE` records expire immediately and future expirations are rescheduled. Scheduler, manual API, and startup expiration all share one per-chain in-memory operation. Status polling never writes an old lifecycle snapshot back to the repository. An interrupted `CREATING` record becomes `FAILED` rather than replaying a potentially mutating CLI operation; its persisted recovery marker determines whether it continues to block creation.

## Network adapters and current delivery scope

Fuji has a concrete adapter with Subnet/blockchain creation, L1 conversion, RPC/block-growth verification, and validator/host lifecycle orchestration implemented and covered by the current test suite. Full public Fuji E2E has not yet been completed and is not claimed by this submission.

The validated submission scope is the reproducible Local disposable-L1 lifecycle demonstrated in the repository. Mainnet remains mutation-disabled (`MAINNET_MUTATION_DISABLED`). Public hosting, wallet-funded Fuji deployment, and Mainnet workflows are future work.
