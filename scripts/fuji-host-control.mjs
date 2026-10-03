#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { copyFile, mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { currentPublicIpStatus } from "./fuji-public-ip.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const runtime = join(root, ".runtime", "fuji-node");
const dataDir = join(runtime, "data");
const pluginDir = join(runtime, "plugins");
const logsDir = join(runtime, "logs");
const statePath = join(runtime, "host.json");
const vmId = "srEXiWaHuhNyGwPUi444Tu47ZEDwxTWrbQiuD7FmgSAQ6X7Dy";
const [action, ...input] = process.argv.slice(2);

try {
  if (action === "check") await check();
  else if (action === "start") await start("");
  else if (action === "prepare") await prepare(input);
  else if (action === "stop") await stop(input[0]);
  else if (action === "is-stopped") await isStopped(input[0]);
  else if (action === "status") await status();
  else throw new Error("usage: fuji-host-control.mjs check|start|prepare <chain> <subnet-id> <blockchain-id>|stop <chain>|is-stopped <chain>|status");
} catch (error) {
  process.stderr.write(`FUJI HOST CONTROL: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}

async function check() {
  const binary = requiredAbsolute("SHIPFUN_FUJI_AVALANCHEGO_BIN");
  const plugin = requiredAbsolute("SHIPFUN_FUJI_SUBNET_EVM_BIN");
  const publicIp = process.env.SHIPFUN_FUJI_PUBLIC_IP;
  if (!publicIp || !isIP(publicIp)) throw new Error("SHIPFUN_FUJI_PUBLIC_IP must be an explicit IPv4 or IPv6 address; automatic NAT discovery is disabled");
  if (publicIp === "127.0.0.1" || publicIp === "::1") throw new Error("loopback cannot be advertised to Fuji peers");
  const ipStatus = currentPublicIpStatus(publicIp);
  if (!ipStatus.qualified) throw new Error(`public IP qualification failed: ${ipStatus.reason}`);
  await Promise.all([stat(binary), stat(plugin)]);
  const nodeVersion = execFileSync(binary, ["--version"], { encoding: "utf8", timeout: 10_000 }).trim();
  const pluginVersion = execFileSync(plugin, ["--version"], { encoding: "utf8", timeout: 10_000 }).trim();
  const helpResult = spawnSync(binary, ["--help"], { encoding: "utf8", timeout: 10_000 });
  if (helpResult.error || helpResult.status !== 0) throw new Error("AvalancheGo --help failed");
  const nodeHelp = `${helpResult.stdout}\n${helpResult.stderr}`;
  for (const flag of ["--partial-sync-primary-network", "--data-dir", "--plugin-dir", "--http-host", "--http-port", "--staking-port", "--public-ip", "--api-admin-enabled", "--track-subnets"]) {
    if (!nodeHelp.includes(flag)) throw new Error(`AvalancheGo does not support required flag ${flag}`);
  }
  const nodeProtocol = nodeVersion.match(/rpcchainvm=(\d+)/)?.[1];
  const pluginProtocol = pluginVersion.match(/rpcchainvm=(\d+)/)?.[1];
  if (!/^avalanchego\/1\.(?:1[5-9]|[2-9]\d)\./.test(nodeVersion)) throw new Error("Fuji Helicon requires AvalancheGo v1.15.0-fuji or later");
  if (!nodeProtocol || nodeProtocol !== pluginProtocol) throw new Error("AvalancheGo and Subnet-EVM RPCChainVM protocols differ");
  process.stdout.write(JSON.stringify({ nodeVersion, pluginVersion, protocol: nodeProtocol, publicIp, dataDir, pluginDir, httpHost: "127.0.0.1", httpPort: 9650, stakingPort: 9651, natMapping: "disabled-by-explicit-public-ip" }) + "\n");
}

async function start(subnetId) {
  await check();
  const state = await readState();
  const live = state ? processState(state) : "stopped";
  if (live === "running") throw new Error("project Fuji node is already running");
  if (live === "unknown") throw new Error("cannot identify recorded PID; refusing to start a second process");
  await mkdir(pluginDir, { recursive: true, mode: 0o700 });
  await mkdir(logsDir, { recursive: true, mode: 0o700 });
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const binary = requiredAbsolute("SHIPFUN_FUJI_AVALANCHEGO_BIN");
  await copyFile(requiredAbsolute("SHIPFUN_FUJI_SUBNET_EVM_BIN"), join(pluginDir, vmId));
  const args = [
    "--network-id=fuji", "--partial-sync-primary-network",
    `--data-dir=${dataDir}`, `--plugin-dir=${pluginDir}`,
    "--http-host=127.0.0.1", "--http-port=9650", "--staking-port=9651",
    `--public-ip=${process.env.SHIPFUN_FUJI_PUBLIC_IP}`,
    "--api-admin-enabled=false",
  ];
  if (subnetId) args.push(`--track-subnets=${subnetId}`);
  const log = await open(join(logsDir, "avalanchego.log"), "a", 0o600);
  const child = spawn(binary, args, { detached: true, shell: false, stdio: ["ignore", log.fd, log.fd] });
  await log.close();
  if (!child.pid) throw new Error("AvalancheGo did not provide a PID");
  child.unref();
  await persist({ pid: child.pid, binary, dataDir, subnetId, argsHash: sha256(args.join("\u0000")), startedAt: new Date().toISOString() });
  process.stdout.write(`started project Fuji node pid=${child.pid} data=${dataDir}\n`);
}

async function prepare([chain, subnetId, blockchainId]) {
  assertChain(chain);
  assertId(subnetId);
  assertId(blockchainId);
  const state = await readState();
  if (!state || processState(state) !== "running") throw new Error("bootstrap Fuji node must be running before prepare");
  if (state.subnetId && state.subnetId !== subnetId) throw new Error("project node is already tracking another subnet");
  if (state.chain && state.chain !== chain) throw new Error("project node belongs to another chain");
  await stop();
  await start(subnetId);
  const prepared = await readState();
  await persist({ ...prepared, chain, blockchainId });
  process.stdout.write(`tracking subnet=${subnetId} blockchain=${blockchainId} chain=${chain}\n`);
}

async function stop(chain) {
  if (chain) assertChain(chain);
  const state = await readState();
  if (!state) { process.stdout.write("already stopped\n"); return; }
  if (chain && state.chain && state.chain !== chain) throw new Error("project node belongs to another chain");
  const live = processState(state);
  if (live === "unknown") throw new Error("recorded PID is not demonstrably this project node; refusing signal");
  if (live === "stopped") { process.stdout.write("already stopped\n"); return; }
  process.kill(state.pid, "SIGTERM");
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (processState(state) === "stopped") { process.stdout.write("stopped project Fuji node\n"); return; }
    await new Promise((done) => setTimeout(done, 1_000));
  }
  throw new Error("project Fuji node did not stop within 30 seconds");
}

async function isStopped(chain) {
  if (chain) assertChain(chain);
  const state = await readState();
  if (chain && state?.chain && state.chain !== chain) throw new Error("project node belongs to another chain");
  if (!state || processState(state) === "stopped") { process.stdout.write("stopped\n"); return; }
  if (processState(state) === "running") process.exitCode = 1;
  else throw new Error("project Fuji node identity is uncertain");
}

async function status() {
  const state = await readState();
  process.stdout.write(JSON.stringify({ state: state ? processState(state) : "stopped", pid: state?.pid ?? null, chain: state?.chain ?? null, subnetId: state?.subnetId ?? null, blockchainId: state?.blockchainId ?? null, dataDir, rpcUrl: "http://127.0.0.1:9650", logPath: join(logsDir, "avalanchego.log") }) + "\n");
}

function processState(state) {
  try { process.kill(state.pid, 0); } catch (error) {
    if (error.code === "ESRCH") return "stopped";
    return "unknown";
  }
  try {
    const command = execFileSync("/bin/ps", ["-p", String(state.pid), "-o", "command="], { encoding: "utf8", timeout: 5_000 });
    return command.includes(state.binary) && command.includes(`--data-dir=${dataDir}`) && command.includes("--network-id=fuji") ? "running" : "unknown";
  } catch { return "unknown"; }
}

async function readState() {
  try { return JSON.parse(await readFile(statePath, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function persist(state) {
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  const temporary = `${statePath}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(state) + "\n", { mode: 0o600, flag: "wx" });
  await rename(temporary, statePath);
}

function requiredAbsolute(name) {
  const value = process.env[name];
  if (!value || !isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return value;
}

function assertChain(value) { if (!/^chain[a-p]{12}$/.test(value ?? "")) throw new Error("invalid project chain name"); }
function assertId(value) { if (!/^[1-9A-HJ-NP-Za-km-z]{30,60}$/.test(value ?? "")) throw new Error("invalid Avalanche ID"); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
