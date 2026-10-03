# Local validation

Status: **PASS**
Validated: 2026-09-18 (Asia/Shanghai)

| Item | Observed result |
|---|---|
| Network | healthy; 2 primary nodes + 1 ShipFunDev L1 validator |
| Subnet ID | `2W9boARgCWL25z6pMFNtkCfNA5v28VGg9PmBgUJfuKndEdhrvw` |
| Blockchain ID | `28u1rJ1DoisVt7WStNcEZC41aQAWAp4x1SZCYSUFex5nfZajSu` |
| EVM chain ID | `20250917` (`0x1350125`) |
| RPC | `http://127.0.0.1:9654/ext/bc/28u1rJ1DoisVt7WStNcEZC41aQAWAp4x1SZCYSUFex5nfZajSu/rpc` |
| Validator node / ID | `NodeID-HHD9gZXe2iPA32XD8giVJ7t8ia6Vn82j7` / `jbVejeab5dHjhakduNgg8vFh6iMrHJ9MsMDSzFLdedp7KQ2sL` |
| Native balance | funded local-only EWOQ account: non-zero |
| Native transfer | PASS, 1 wei, tx `0xa92d093990abd44b1321536a00d93e35b4aa58d7bb13fa23755fd56f2fa6dc52` |
| Block growth | PASS, `6 → 7` after transfer; latest tested block `8` after deployment |
| HelloShip | `0xe336d36FacA76840407e6836d26119E1EcE0A2b4` |
| Contract read | `message()` returned `ship.fun environment ready` |
| Lifecycle | `local-down` stopped 3 nodes; separate `local-up` restored them; full test passed |

Subnet-EVM creates blocks on demand, so growth is tested around an accepted transaction rather than by waiting for empty blocks. Runtime metadata is intentionally untracked.
