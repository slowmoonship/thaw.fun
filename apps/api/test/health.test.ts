import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { adapterFor, buildApp, isFujiBrowserWriteRequest, repositoryPathFor } from "../src/app.js";
import { FujiAvalancheAdapter } from "../src/fuji-avalanche-adapter.js";
import { LocalAvalancheAdapter } from "../src/local-avalanche-adapter.js";
import { MainnetAvalancheAdapter } from "../src/unsupported-avalanche-adapter.js";
test("GET /health", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestrator-health-"));
  const app = await buildApp({ runtimePath: join(directory, "chains.json") });
  const response = await app.inject({ method: "GET", url: "/health" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: "ok" });
  await app.close();
  await rm(directory, { recursive: true, force: true });
});

test("Local is default, Fuji is explicit, and Mainnet stays disabled", async () => {
  assert.ok(adapterFor("local") instanceof LocalAvalancheAdapter);
  assert.ok(adapterFor("fuji") instanceof FujiAvalancheAdapter);
  const mainnet = adapterFor("mainnet");
  assert.ok(mainnet instanceof MainnetAvalancheAdapter);
  await assert.rejects(() => mainnet.createL1({
    id: "mainnet", name: "NO", internalName: "chainno", symbol: "NO", network: "mainnet",
    evmChainId: 123456789, createdAt: new Date(0).toISOString(), lifetimeSeconds: 60, status: "CREATING",
  }), /MAINNET_MUTATION_DISABLED/);
  assert.match(repositoryPathFor("fuji"), /\.runtime\/fuji-chains\.json$/);
});

test("GET /environment reports the selected Fuji network", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestrator-fuji-environment-"));
  const app = await buildApp({ network: "fuji", runtimePath: join(directory, "fuji-chains.json") });
  const response = await app.inject({ method: "GET", url: "/environment" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().network, "fuji");
  assert.equal(response.json().environment, "fuji");
  assert.equal(response.json().fujiMutationEnabled, false);
  await app.close();
  await rm(directory, { recursive: true, force: true });
});

test("Fuji browser writes require an explicitly approved UI origin", () => {
  const previous = process.env.SHIPFUN_FUJI_WRITE_ORIGINS;

  try {
    process.env.SHIPFUN_FUJI_WRITE_ORIGINS =
      "http://127.0.0.1:5173,https://thaw.slowmoonship.com";

    assert.equal(
      isFujiBrowserWriteRequest({
        origin: "http://127.0.0.1:5173",
        host: "127.0.0.1:5173",
      }),
      true,
    );

    assert.equal(
      isFujiBrowserWriteRequest({
        origin: "https://thaw.slowmoonship.com",
        host: "thaw.slowmoonship.com",
      }),
      true,
    );

    assert.equal(
      isFujiBrowserWriteRequest({
        host: "thaw.slowmoonship.com",
      }),
      false,
    );

    assert.equal(
      isFujiBrowserWriteRequest({
        origin: "https://other.example",
        host: "thaw.slowmoonship.com",
      }),
      false,
    );
  } finally {
    if (previous === undefined) {
      delete process.env.SHIPFUN_FUJI_WRITE_ORIGINS;
    } else {
      process.env.SHIPFUN_FUJI_WRITE_ORIGINS = previous;
    }
  }
});
