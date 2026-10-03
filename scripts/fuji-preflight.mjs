#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { currentPublicIpStatus, nodeEndpointIp, sameIp } from "./fuji-public-ip.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repository = resolve(root, ".runtime", "fuji-chains.json");
const hostControl = resolve(root, "scripts", "fuji-host-control.mjs");
let blocked = false;

function report(label, status, detail) {
  process.stdout.write(`${label}: ${status}${detail ? ` (${detail})` : ""}\n`);
  if (status === "BLOCKED") blocked = true;
}

async function rpc(url, method, params = {}) {
  const response = await fetch(url, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(body.error.message ?? "RPC error");
  return body.result;
}

async function run() {
  report("REPOSITORY", "INFO", repository);
  try {
    const records = JSON.parse(await readFile(repository, "utf8"));
    if (!Array.isArray(records)) throw new Error("invalid repository JSON");
    const active = records.filter((record) => ["CREATING", "LIVE", "EXPIRING"].includes(record.status) || record.requiresRecovery);
    report("FUJI RECORDS", active.length ? "BLOCKED" : "PASS", `${records.length} total, ${active.length} active/recovery`);
  } catch (error) {
    if (error.code === "ENOENT") report("FUJI RECORDS", "PASS", "repository has not been created");
    else report("FUJI RECORDS", "BLOCKED", error.message);
  }

  try {
    const result = execFileSync(process.execPath, [hostControl, "check"], { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] });
    report("HOST BINARIES", "PASS", result.trim());
  } catch (error) {
    report("HOST BINARIES", "BLOCKED", String(error.stderr ?? error.message).trim().split("\n").at(-1));
  }

  const pAddress = process.env.SHIPFUN_FUJI_P_ADDRESS;
  const cAddress = process.env.SHIPFUN_FUJI_C_ADDRESS;
  if (!/^P-fuji1[0-9a-z]+$/.test(pAddress ?? "") || !/^0x[0-9a-fA-F]{40}$/.test(cAddress ?? "")) {
    report("PUBLIC WALLET ADDRESSES", "BLOCKED", "set SHIPFUN_FUJI_P_ADDRESS and SHIPFUN_FUJI_C_ADDRESS");
  }
  try {
    const info = await rpc("https://api.avax-test.network/ext/info", "info.getNodeVersion");
    report("FUJI PUBLIC RPC", "PASS", `${info.version}, rpcchainvm ${info.rpcProtocolVersion}`);
    const pUrl = "https://api.avax-test.network/ext/bc/P";
    const height = await rpc(pUrl, "platform.getHeight");
    report("P-CHAIN HEIGHT", "PASS", height.height);
    const fee = await rpc(pUrl, "platform.getValidatorFeeState");
    report("VALIDATOR FEE", "INFO", `${fee.price} nAVAX/s at ${fee.timestamp}`);
    if (pAddress && cAddress) {
      const pBalance = await rpc(pUrl, "platform.getBalance", { addresses: [pAddress] });
      const cBalance = await rpc("https://api.avax-test.network/ext/bc/C/rpc", "eth_getBalance", [cAddress, "latest"]);
      report("P-CHAIN BALANCE", BigInt(pBalance.balance) > 0n ? "PASS" : "BLOCKED", `${formatUnits(BigInt(pBalance.balance), 9)} AVAX`);
      report("C-CHAIN BALANCE", BigInt(cBalance) > 0n ? "PASS" : "BLOCKED", `${formatUnits(BigInt(cBalance), 18)} AVAX`);
    }
  } catch (error) {
    report("FUJI READ-ONLY RPC", "BLOCKED", error.message);
  }

  try {
    const node = await rpc("http://127.0.0.1:9650/ext/info", "info.getNodeID");
    report("MAC NODE ID", "PASS", node.nodeID);
    const publicEndpoint = await rpc("http://127.0.0.1:9650/ext/info", "info.getNodeIP");
    const advertisedIp = nodeEndpointIp(publicEndpoint.ip);
    const ipStatus = currentPublicIpStatus(advertisedIp);
    report("MAC ADVERTISED IP", ipStatus.qualified ? "PASS" : "BLOCKED", `${publicEndpoint.ip}: ${ipStatus.reason}`);
    if (process.env.SHIPFUN_FUJI_PUBLIC_IP && !sameIp(process.env.SHIPFUN_FUJI_PUBLIC_IP, advertisedIp)) {
      report("CONFIGURED PUBLIC IP", "BLOCKED", "node advertises a different address than SHIPFUN_FUJI_PUBLIC_IP");
    }
    const peers = await rpc("http://127.0.0.1:9650/ext/info", "info.peers");
    report("MAC OUTBOUND PEERS", peers.numPeers > 0 ? "PASS" : "BLOCKED", String(peers.numPeers));
    const health = await fetch("http://127.0.0.1:9650/ext/health", { signal: AbortSignal.timeout(5_000) });
    report("MAC BOOTSTRAP HEALTH", health.ok ? "PASS" : "BLOCKED", `HTTP ${health.status}`);
  } catch (error) {
    report("MAC NODE BOOTSTRAP", "BLOCKED", "project Fuji node is not running or is not reachable at localhost:9650");
  }
  try {
    const state = await stat(resolve(root, ".runtime", "fuji-node", "data"));
    report("ISOLATED DATA", state.isDirectory() ? "PASS" : "BLOCKED", resolve(root, ".runtime", "fuji-node", "data"));
  } catch { report("ISOLATED DATA", "INFO", "not created yet"); }
  report("INBOUND 9651", "UNKNOWN", "requires an external connection test while the node is running");
  report("FUJI MUTATION", "NOT RUN", "preflight performs no transaction");
  process.exitCode = blocked ? 2 : 0;
}

function formatUnits(amount, decimals) {
  const unit = 10n ** BigInt(decimals);
  return `${amount / unit}.${String(amount % unit).padStart(decimals, "0")}`;
}

await run();
