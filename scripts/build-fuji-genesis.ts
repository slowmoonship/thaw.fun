#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { buildFujiGenesisTemplate } from "../apps/api/src/fuji-genesis.js";

async function main() {
  const [officialSource, publicProbeAddress, destination] = process.argv.slice(2);
  if (!officialSource || !publicProbeAddress || !destination || !isAbsolute(officialSource) || !isAbsolute(destination)) {
    throw new Error("usage: tsx scripts/build-fuji-genesis.ts /absolute/official-genesis.json 0xPUBLIC_PROBE_ADDRESS /absolute/output-directory");
  }
  const root = resolve(import.meta.dirname, "..");
  if (!resolve(destination).startsWith(`${root}/.runtime/`)) throw new Error("Fuji artifacts must stay under ignored .runtime/");
  const { template, manifest } = buildFujiGenesisTemplate(await readFile(officialSource), publicProbeAddress);
  await mkdir(destination, { recursive: true, mode: 0o700 });
  await writeFile(join(destination, "genesis-template.json"), template, { flag: "wx", mode: 0o600 });
  await writeFile(join(destination, "genesis-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  process.stdout.write(`Public Fuji genesis template and manifest written under ${destination}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`Fuji genesis generation failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
