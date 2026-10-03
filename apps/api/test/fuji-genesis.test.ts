import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFujiGenesisTemplate, prepareFujiGenesis } from "../src/fuji-genesis.js";
import type { DisposableChain } from "../src/domain.js";

const manager = `0x${"a".repeat(40)}`;
const probe = `0x${"b".repeat(40)}`;
const code = "0x6001600055";
const admin = `0x${"c".repeat(40)}`;
const adminCode = "0x6002600055";
const implementationSlot = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const adminSlot = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const ownerSlot = `0x${"0".repeat(64)}`;
const sha256 = (value: Buffer) => createHash("sha256").update(value).digest("hex");

test("generates an isolated per-record genesis with matching manager and funded probe", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fuji-genesis-"));
  try {
    const templatePath = join(directory, "template.json");
    const manifestPath = join(directory, "manifest.json");
    const template = Buffer.from(JSON.stringify({ config: { chainId: 999 }, alloc: {
      [manager.slice(2)]: { code, balance: "0x0", storage: {
        [implementationSlot]: `0x${"0".repeat(24)}${"12".repeat(20)}`,
        [adminSlot]: `0x${"0".repeat(24)}${admin.slice(2)}`,
      } },
      [admin.slice(2)]: { code: adminCode, balance: "0x0", storage: { [ownerSlot]: `0x${"0".repeat(24)}${probe.slice(2)}` } },
      [probe.slice(2)]: { balance: "0x2386f26fc10000" },
    } }));
    await writeFile(templatePath, template);
    await writeFile(manifestPath, JSON.stringify({
      templateSha256: sha256(template), validatorManagerAddress: manager,
      validatorManagerCodeSha256: sha256(Buffer.from(code.slice(2), "hex")),
      proxyAdminAddress: admin, proxyAdminCodeSha256: sha256(Buffer.from(adminCode.slice(2), "hex")),
      proxyAdminOwner: probe, probeAddress: probe,
    }));
    const options = { templatePath, manifestPath, outputDir: join(directory, "output"), managerAddress: manager, probeAddress: probe };
    const chain: DisposableChain = { id: "one", name: "FUJI", internalName: "chainone", symbol: "FUJI", network: "fuji", evmChainId: 123456789, createdAt: new Date(0).toISOString(), lifetimeSeconds: 300, status: "CREATING" };
    const path = await prepareFujiGenesis(chain, options);
    const generated = JSON.parse(await readFile(path, "utf8"));
    assert.equal(generated.config.chainId, chain.evmChainId);
    assert.equal(generated.alloc[manager.slice(2)].code, code);
    await assert.rejects(() => prepareFujiGenesis(chain, options), /already exists/);
    await writeFile(templatePath, Buffer.from(template.toString().replace("999", "998")));
    await assert.rejects(() => prepareFujiGenesis({ ...chain, id: "two" }, options), /template hash mismatch/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("rejects unreviewed official source and insecure example account", async () => {
  assert.throws(() => buildFujiGenesisTemplate(Buffer.from("{}"), probe), /source hash mismatch/);
  const directory = await mkdtemp(join(tmpdir(), "fuji-genesis-unsafe-"));
  try {
    const templatePath = join(directory, "template.json");
    const manifestPath = join(directory, "manifest.json");
    const source = Buffer.from(JSON.stringify({ config: { chainId: 1 }, alloc: {
      [manager.slice(2)]: { code, storage: {
        [implementationSlot]: `0x${"0".repeat(24)}${"12".repeat(20)}`,
        [adminSlot]: `0x${"0".repeat(24)}${admin.slice(2)}`,
      } },
      [admin.slice(2)]: { code: adminCode, storage: { [ownerSlot]: `0x${"0".repeat(24)}${probe.slice(2)}` } },
      [probe.slice(2)]: { balance: "0x2386f26fc10000" },
      "8db97C7cEcE249c2b98bDC0226Cc4C2A57BF52FC": { balance: "0x1" },
    } }));
    await writeFile(templatePath, source);
    await writeFile(manifestPath, JSON.stringify({ templateSha256: sha256(source), validatorManagerAddress: manager,
      validatorManagerCodeSha256: sha256(Buffer.from(code.slice(2), "hex")), proxyAdminAddress: admin,
      proxyAdminCodeSha256: sha256(Buffer.from(adminCode.slice(2), "hex")), proxyAdminOwner: probe, probeAddress: probe }));
    await assert.rejects(() => prepareFujiGenesis({ id: "unsafe", name: "FUJI", internalName: "chainunsafe", symbol: "FUJI", network: "fuji", evmChainId: 123, createdAt: new Date(0).toISOString(), lifetimeSeconds: 300, status: "CREATING" },
      { templatePath, manifestPath, outputDir: join(directory, "out"), managerAddress: manager, probeAddress: probe }), /insecure example account/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
