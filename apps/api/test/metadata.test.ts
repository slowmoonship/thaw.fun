import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseLocalDeployment } from "../src/avalanche-metadata.js";

test("parses and cross-checks Avalanche deployment metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "avalanche-metadata-"));
  const blockchainId = `2${"A".repeat(49)}`;
  const sidecar = { Networks: { "Local Network": { SubnetID: `3${"B".repeat(49)}`, BlockchainID: blockchainId, RPCEndpoints: [`http://127.0.0.1:9654/ext/bc/${blockchainId}/rpc`], ValidatorManagerAddress: `0x${"a".repeat(40)}`, BootstrapValidators: [{ NodeID: `NodeID-${"C".repeat(40)}`, ValidationID: `4${"D".repeat(49)}` }] } } };
  await writeFile(join(directory, "sidecar.json"), JSON.stringify(sidecar));
  await writeFile(join(directory, "genesis.json"), JSON.stringify({ config: { chainId: 123456789 } }));
  const result = await parseLocalDeployment(join(directory, "sidecar.json"), join(directory, "genesis.json"), 123456789);
  assert.equal(result.blockchainId, blockchainId);
  assert.equal(result.validatorNodeId, `NodeID-${"C".repeat(40)}`);
  await assert.rejects(() => parseLocalDeployment(join(directory, "sidecar.json"), join(directory, "genesis.json"), 987654321), /does not match/);
  await rm(directory, { recursive: true, force: true });
});
