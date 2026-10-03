import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { DisposableChain } from "./domain.js";

interface GenesisManifest {
  templateSha256: string;
  validatorManagerAddress: string;
  validatorManagerCodeSha256: string;
  proxyAdminAddress: string;
  proxyAdminCodeSha256: string;
  proxyAdminOwner: string;
  probeAddress: string;
}

export const OFFICIAL_GENESIS_SHA256 = "50467327bfe86bd5d54916ac093c2bcd742efc0c217863b899d3e316aa0ca6bc";
export const FUJI_MANAGER_PROXY = "0xfacade0000000000000000000000000000000000";
export const FUJI_PROXY_ADMIN = `0xdad${"0".repeat(37)}`;
const INSECURE_EXAMPLE_ACCOUNT = "8db97c7cece249c2b98bdc0226cc4c2a57bf52fc";
const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const OWNER_SLOT = `0x${"0".repeat(64)}`;
const PLACEHOLDER_IMPLEMENTATION = "0x1212121212121212121212121212121212121212";
const PROBE_GENESIS_BALANCE = 1_000n * 10n ** 18n;

type GenesisAccount = { balance?: string; code?: string; storage?: Record<string, string> };
type FujiGenesis = { config?: { chainId?: number }; alloc?: Record<string, GenesisAccount> };

function account(alloc: Record<string, GenesisAccount>, address: string): GenesisAccount | undefined {
  return Object.entries(alloc).find(([key]) => key.toLowerCase().replace(/^0x/, "") === address.toLowerCase().replace(/^0x/, ""))?.[1];
}

function wordAddress(word: string | undefined): string | undefined {
  return /^0x[0-9a-fA-F]{64}$/.test(word ?? "") ? `0x${word!.slice(-40).toLowerCase()}` : undefined;
}

export function buildFujiGenesisTemplate(officialBytes: Buffer, probeAddress: string): { template: Buffer; manifest: GenesisManifest } {
  if (sha256(officialBytes) !== OFFICIAL_GENESIS_SHA256) throw new Error("official Fuji genesis source hash mismatch");
  if (!/^0x[0-9a-fA-F]{40}$/.test(probeAddress) || probeAddress.toLowerCase() === `0x${INSECURE_EXAMPLE_ACCOUNT}`) {
    throw new Error("valid independent public probe address is required");
  }
  const genesis = JSON.parse(officialBytes.toString("utf8")) as FujiGenesis;
  if (!genesis.alloc) throw new Error("official Fuji genesis allocations are missing");
  const manager = account(genesis.alloc, FUJI_MANAGER_PROXY);
  const admin = account(genesis.alloc, FUJI_PROXY_ADMIN);
  if (!manager?.code || !admin?.code) throw new Error("official proxy or ProxyAdmin bytecode is missing");
  if (wordAddress(manager.storage?.[IMPLEMENTATION_SLOT]) !== PLACEHOLDER_IMPLEMENTATION || wordAddress(manager.storage?.[ADMIN_SLOT]) !== FUJI_PROXY_ADMIN) {
    throw new Error("official proxy slots do not match the reviewed placeholder and ProxyAdmin");
  }
  if (wordAddress(admin.storage?.[OWNER_SLOT]) !== `0x${INSECURE_EXAMPLE_ACCOUNT}`) throw new Error("official ProxyAdmin sample owner changed");
  for (const key of Object.keys(genesis.alloc)) if (key.toLowerCase().replace(/^0x/, "") === INSECURE_EXAMPLE_ACCOUNT) delete genesis.alloc[key];
  admin.storage![OWNER_SLOT] = `0x${"0".repeat(24)}${probeAddress.slice(2).toLowerCase()}`;
  genesis.alloc[probeAddress.slice(2)] = { balance: `0x${PROBE_GENESIS_BALANCE.toString(16)}` };
  const template = Buffer.from(`${JSON.stringify(genesis, null, 2)}\n`);
  return { template, manifest: {
    templateSha256: sha256(template), validatorManagerAddress: FUJI_MANAGER_PROXY,
    validatorManagerCodeSha256: sha256(Buffer.from(manager.code.slice(2), "hex")),
    proxyAdminAddress: FUJI_PROXY_ADMIN, proxyAdminCodeSha256: sha256(Buffer.from(admin.code.slice(2), "hex")),
    proxyAdminOwner: probeAddress, probeAddress,
  } };
}

export interface FujiGenesisOptions {
  officialSourcePath?: string;
  templatePath: string;
  manifestPath: string;
  outputDir: string;
  managerAddress: string;
  probeAddress: string;
}

export async function prepareFujiGenesis(chain: DisposableChain, options: FujiGenesisOptions): Promise<string> {
  for (const path of [options.templatePath, options.manifestPath, options.outputDir]) {
    if (!isAbsolute(path)) throw new Error("Fuji genesis paths must be absolute");
  }
  const templateBytes = await readFile(options.templatePath);
  const manifest = JSON.parse(await readFile(options.manifestPath, "utf8")) as GenesisManifest;
  if (options.officialSourcePath) {
    if (!isAbsolute(options.officialSourcePath)) throw new Error("official Fuji genesis source path must be absolute");
    const regenerated = buildFujiGenesisTemplate(await readFile(options.officialSourcePath), options.probeAddress);
    if (!templateBytes.equals(regenerated.template) || JSON.stringify(manifest) !== JSON.stringify(regenerated.manifest)) {
      throw new Error("Fuji genesis template or manifest differs from the pinned official source transformation");
    }
  }
  if (sha256(templateBytes) !== manifest.templateSha256) throw new Error("Fuji genesis template hash mismatch");
  if (manifest.validatorManagerAddress.toLowerCase() !== options.managerAddress.toLowerCase()) throw new Error("Fuji validator manager address mismatch");
  if (manifest.probeAddress.toLowerCase() !== options.probeAddress.toLowerCase()) throw new Error("Fuji probe address mismatch");

  const genesis = JSON.parse(templateBytes.toString("utf8")) as FujiGenesis;
  if (!genesis.config || !Number.isSafeInteger(chain.evmChainId)) throw new Error("Fuji genesis chain ID is invalid");
  genesis.config.chainId = chain.evmChainId;
  const allocations = genesis.alloc ?? {};
  if (account(allocations, `0x${INSECURE_EXAMPLE_ACCOUNT}`)) throw new Error("insecure example account remains funded in Fuji genesis");
  const manager = account(allocations, options.managerAddress);
  if (!manager?.code || !/^0x[0-9a-fA-F]+$/.test(manager.code)) throw new Error("Fuji validator manager bytecode is missing");
  if (sha256(Buffer.from(manager.code.slice(2), "hex")) !== manifest.validatorManagerCodeSha256) throw new Error("Fuji validator manager bytecode hash mismatch");
  if (wordAddress(manager.storage?.[IMPLEMENTATION_SLOT]) !== PLACEHOLDER_IMPLEMENTATION) throw new Error("Fuji manager proxy implementation placeholder mismatch");
  if (wordAddress(manager.storage?.[ADMIN_SLOT]) !== manifest.proxyAdminAddress?.toLowerCase()) throw new Error("Fuji manager proxy admin mismatch");
  const admin = account(allocations, manifest.proxyAdminAddress);
  if (!admin?.code || sha256(Buffer.from(admin.code.slice(2), "hex")) !== manifest.proxyAdminCodeSha256) throw new Error("Fuji ProxyAdmin code hash mismatch");
  if (manifest.proxyAdminOwner?.toLowerCase() !== options.probeAddress.toLowerCase() || wordAddress(admin.storage?.[OWNER_SLOT]) !== options.probeAddress.toLowerCase()) {
    throw new Error("Fuji ProxyAdmin owner must be the encrypted probe signer");
  }
  const probe = account(allocations, options.probeAddress);
  if (!probe?.balance || !/^0x[0-9a-fA-F]+$/.test(probe.balance) || BigInt(probe.balance) < 1_000_000_000_000_000n) {
    throw new Error("Fuji probe account is not sufficiently funded in genesis");
  }
  await mkdir(options.outputDir, { recursive: true, mode: 0o700 });
  const outputPath = join(options.outputDir, `${chain.id}.json`);
  try {
    await stat(outputPath);
    throw new Error("Fuji genesis output already exists; reconcile the record before retrying");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeFile(outputPath, `${JSON.stringify(genesis, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return outputPath;
}

function sha256(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }
