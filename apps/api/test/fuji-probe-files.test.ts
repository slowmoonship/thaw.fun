import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { inspectProbeFiles } from "../src/fuji-avalanche-adapter.js";

test("probe signer artifacts must be encrypted, private, and outside the repository", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shipfun-probe-test-"));
  const keystore = join(directory, "probe.json");
  try {
    await writeFile(keystore, JSON.stringify({ crypto: { cipher: "aes-128-ctr", ciphertext: "00" } }), { mode: 0o600 });
    await assert.doesNotReject(() => inspectProbeFiles(keystore));
    await chmod(keystore, 0o644);
    await assert.rejects(() => inspectProbeFiles(keystore), /owner-only permissions/);
    await chmod(keystore, 0o600);
    await assert.rejects(() => inspectProbeFiles(resolve(import.meta.dirname, "../../../package.json")), /outside the repository/);
    await writeFile(keystore, "{}", { mode: 0o600 });
    await assert.rejects(() => inspectProbeFiles(keystore), /must be encrypted/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
