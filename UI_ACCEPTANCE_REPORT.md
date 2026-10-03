# thaw.fun Final UI Local Integration Acceptance

Status: **PASS**  
Validated: 2026-09-20 (Asia/Shanghai)  
Branch: `main`  
Validated base commit: `83bfc05`  
Final acceptance changes: the commit containing this report

## Environment and safety

- UI: Vue/Vite at `http://127.0.0.1:5173`
- API: Fastify at `http://127.0.0.1:3000`
- Network: Avalanche Local only
- Repository: `.runtime/chains.json`
- Fuji mutations: 0
- Mainnet mutations: 0
- Real AVAX spent: 0
- `avalanche network clean`: not run
- Existing Avalanche metadata and repository history were preserved

## Accepted chain

| Field | Observed value |
|---|---|
| Name / symbol | `USELESS` / `LOL` |
| Lifetime | 60 seconds |
| Record ID | `007c9a8d-0d0a-4cc0-8cb3-f27939c0d50d` |
| Internal name | `chainaahmjkinanak` |
| Subnet ID | `2kp8p9FnJhv586AEYMhyxvZeVEe2P9SNhZU9kXPzrikoJTukR5` |
| Blockchain ID | `c5nJmPREUtrKDpZ2yPtLLz5DKcaVnNz73e3fm65i9qAxGA4Yh` |
| EVM chain ID | `300608358` (`0x11eaeb66`) |
| RPC URL | `http://127.0.0.1:9656/ext/bc/c5nJmPREUtrKDpZ2yPtLLz5DKcaVnNz73e3fm65i9qAxGA4Yh/rpc` |
| LIVE block | `1` |
| Final block | `1` |
| Created at | `2026-09-20T04:53:06.809Z` |
| Expires at | `2026-09-20T04:54:59.993Z` |
| Expired at | `2026-09-20T04:55:04.201Z` |

## Lifecycle observations

- **BIRTH — PASS.** The final page showed the thaw.fun brand, `LOCAL / API LINKED`, and only Name, Symbol, and Lifetime inputs. The submitted values were `USELESS`, `LOL`, and `60`.
- **CREATING — PASS.** The UI displayed API status `CREATING` and record ID `007c9a8d-0d0a-4cc0-8cb3-f27939c0d50d` without a percentage or invented deployment steps. A browser refresh restored the same active record and did not expose a second creation form.
- **LIVE — PASS.** LIVE appeared only after the adapter recovered usable deployment metadata, verified RPC, and proved block growth with a Local transaction. The UI showed the observed IDs, RPC URL, block `1`, a decreasing countdown (`00:46` then `00:26`), `RPC HEALTHY`, and API state `LIVE`.
- **RPC proof — PASS.** Direct Local JSON-RPC returned `eth_chainId = 0x11eaeb66`, matching decimal `300608358`, and `eth_blockNumber = 0x1`, matching the API/UI block.
- **EXPIRING — PASS.** Natural expiry was used; manual termination was not clicked. The repository showed `EXPIRING` from `2026-09-20T04:55:00Z` through `04:55:03Z`, then `DEAD`. It did not return to LIVE.
- **DEAD — PASS.** The UI showed the obituary, API state `DEAD`, final block `1`, and `RPC STOPPED`. The persisted record retained the same identifiers and recorded `expiredAt`.
- **RPC offline — PASS.** A post-death `eth_blockNumber` request failed to connect to `127.0.0.1:9656` with curl exit code `7`.

## Refresh and restart recovery

- Browser refresh during CREATING: **PASS**; restored the active CREATING record.
- Browser refresh during LIVE: **PASS**; restored LIVE with the same IDs, healthy RPC, block, and a lower countdown.
- Browser refresh after DEAD: **PASS**; restored the latest DEAD obituary rather than returning to BIRTH.
- API restart after DEAD: **PASS**; the API reopened the same JSON repository and the refreshed UI restored the same DEAD record. RPC remained offline and no mutation or resurrection occurred.
- JSON consistency: **PASS**; `finalBlock`, `expiredAt`, identifiers, and terminal status remained intact after polling, refresh, and API restart.

## Failure and recovery handling

- The first UI submission created record `7b01f6d9-21e4-4623-9354-4913f782a251` but failed before external mutation because Avalanche CLI had left `min_cli_version.json` empty. It has no `requiresRecovery` marker. The documented cache file was restored and the safe retry produced the accepted chain above. No two chain creations ran concurrently.
- Existing real post-mutation failure record `c776bd2f-e827-4dfb-b0a4-26fc76abcaa7` was used for a read-only UI check. The UI displayed `RECOVERY REQUIRED`, `FAILED / BLOCKED`, and the backend reason, with no return-to-BIRTH or create action. No additional failure chain was created for this check.

## Verification

| Check | Result |
|---|---|
| `pnpm build` | PASS |
| `pnpm typecheck` | PASS |
| `pnpm --filter @shipfun/api test` | PASS — 25/25 |
| Real Local UI lifecycle | PASS |
| Browser refresh recovery | PASS |
| API restart recovery | PASS |
| Latest DEAD restoration | PASS |
| requiresRecovery UI handling | PASS |

## Minimal UI fixes made during acceptance

1. Restore the newest relevant record in priority order: active chain, blocked `requiresRecovery` failure, then latest DEAD chain.
2. Expose `requiresRecovery` in the UI type and render a non-actionable recovery-required state instead of offering another creation.

## Known non-blockers

- Avalanche CLI 1.9.6 can leave its minimum-version cache empty on this host. The documented cache restoration was required once before the successful creation attempt.
- The pinned Signature Aggregator download can return a post-deploy error. The frozen adapter correctly recovered because deployment metadata and RPC were usable; LIVE was not published until RPC and block growth verification passed.
- Local death intentionally stops the whole Local network. This is the documented Local-only strategy and does not alter the Fuji/Mainnet safety posture.

## Verdict

**FINAL MEME UI FROZEN — READY FOR FUJI**
