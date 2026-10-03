import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JsonChainRepository } from "../src/json-chain-repository.js";
import type { DisposableChain } from "../src/domain.js";

test("persists records across repository instances with valid JSON", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chain-repository-"));
  const file = join(directory, "chains.json");
  const chain: DisposableChain = { id: "one", name: "PEPE", internalName: "chain-one", symbol: "PEPE", network: "local", evmChainId: 100000001, createdAt: new Date(0).toISOString(), lifetimeSeconds: 60, status: "CREATING" };
  await new JsonChainRepository(file).create(chain);
  chain.status = "FAILED";
  await new JsonChainRepository(file).update(chain);
  assert.equal((await new JsonChainRepository(file).findById("one"))?.status, "FAILED");
  assert.ok(Array.isArray(JSON.parse(await readFile(file, "utf8"))));
  await rm(directory, { recursive: true, force: true });
});
