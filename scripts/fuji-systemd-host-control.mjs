#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";

const CONFIG = "/home/ubuntu/.avalanchego/configs/node.json";
const SERVICE = "avalanchego";
const RPC = "http://127.0.0.1:9650/ext/info";

const ROOT = "/home/ubuntu/thaw.fun";
const STATE_DIR = resolve(ROOT, ".runtime");
const STATE = resolve(STATE_DIR, "public-fuji-host.json");

const [action, ...args] = process.argv.slice(2);

try {
  if (action === "check") {
    await check();
  } else if (action === "prepare") {
    await prepare(args);
  } else if (action === "stop") {
    await stop(args[0]);
  } else if (action === "is-stopped") {
    await isStopped(args[0]);
  } else if (action === "status") {
    await status();
  } else {
    throw new Error(
      "usage: fuji-systemd-host-control.mjs check|prepare <chain> <subnet-id> <blockchain-id>|stop <chain>|is-stopped <chain>|status",
    );
  }
} catch (error) {
  process.stderr.write(
    `FUJI SYSTEMD HOST CONTROL: ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  );
  process.exitCode = 2;
}

async function check() {
  const config = await readConfig();

  if (config["network-id"] !== "fuji") {
    throw new Error("AvalancheGo is not configured for Fuji");
  }

  const active = systemctl("is-active", SERVICE).trim();
  if (active !== "active") {
    throw new Error(`AvalancheGo service is ${active}`);
  }

  const info = await rpc("info.getNodeVersion");

  process.stdout.write(
    JSON.stringify({
      service: SERVICE,
      active: true,
      config: CONFIG,
      network: config["network-id"],
      publicIp: config["public-ip"] ?? null,
      trackSubnets: parseTracked(config["track-subnets"]),
      nodeVersion: info.version ?? null,
      rpcProtocolVersion: info.rpcProtocolVersion ?? null,
    }) + "\n",
  );
}

async function prepare([chain, subnetId, blockchainId]) {
  assertChain(chain);
  assertAvalancheId(subnetId);
  assertAvalancheId(blockchainId);

  await check();

  const previous = await readState();

  if (
    previous &&
    previous.status === "tracking" &&
    previous.chain !== chain
  ) {
    throw new Error(
      `another thaw.fun chain is already managed: ${previous.chain}`,
    );
  }

  const config = await readConfig();
  const tracked = parseTracked(config["track-subnets"]);

  if (!tracked.includes(subnetId)) {
    tracked.push(subnetId);

    await backupConfig("prepare");

    config["track-subnets"] = tracked.join(",");

    await writeConfig(config);

    systemctl("restart", SERVICE);

    await waitForRpc();
  }

  await writeState({
    status: "tracking",
    chain,
    subnetId,
    blockchainId,
    updatedAt: new Date().toISOString(),
  });

  process.stdout.write(
    `tracking subnet=${subnetId} blockchain=${blockchainId} chain=${chain}\n`,
  );
}

async function stop(chain) {
  if (chain) assertChain(chain);

  const state = await readState();

  if (!state) {
    process.stdout.write("already stopped\n");
    return;
  }

  if (chain && state.chain !== chain) {
    throw new Error(
      `managed chain is ${state.chain}, not ${chain}`,
    );
  }

  const config = await readConfig();
  const tracked = parseTracked(config["track-subnets"]);

  const next = tracked.filter(
    (subnetId) => subnetId !== state.subnetId,
  );

  if (next.length !== tracked.length) {
    await backupConfig("stop");

    if (next.length) {
      config["track-subnets"] = next.join(",");
    } else {
      delete config["track-subnets"];
    }

    await writeConfig(config);

    systemctl("restart", SERVICE);

    await waitForRpc();
  }

  await writeState({
    ...state,
    status: "stopped",
    updatedAt: new Date().toISOString(),
  });

  process.stdout.write(
    `stopped tracking subnet=${state.subnetId} chain=${state.chain}\n`,
  );
}

async function isStopped(chain) {
  if (chain) assertChain(chain);

  const state = await readState();

  if (!state) {
    process.stdout.write("stopped\n");
    return;
  }

  if (chain && state.chain !== chain) {
    throw new Error(
      `managed chain is ${state.chain}, not ${chain}`,
    );
  }

  const config = await readConfig();
  const tracked = parseTracked(config["track-subnets"]);

  if (
    state.status === "stopped" &&
    !tracked.includes(state.subnetId)
  ) {
    process.stdout.write("stopped\n");
    return;
  }

  process.exitCode = 1;
}

async function status() {
  const config = await readConfig();
  const state = await readState();

  process.stdout.write(
    JSON.stringify({
      service: SERVICE,
      config: CONFIG,
      trackSubnets: parseTracked(config["track-subnets"]),
      managed: state,
    }) + "\n",
  );
}

async function readConfig() {
  return JSON.parse(await readFile(CONFIG, "utf8"));
}

async function writeConfig(config) {
  const temporary = `${CONFIG}.thaw-${process.pid}.tmp`;

  await writeFile(
    temporary,
    `${JSON.stringify(config, null, 2)}\n`,
    {
      mode: 0o644,
      flag: "wx",
    },
  );

  await rename(temporary, CONFIG);
}

async function backupConfig(reason) {
  const backup = `${CONFIG}.bak-thaw-${reason}-${Date.now()}`;
  await copyFile(CONFIG, backup);
}

function parseTracked(value) {
  if (typeof value !== "string" || !value.trim()) {
    return [];
  }

  return [
    ...new Set(
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function systemctl(action, service) {
  return execFileSync(
    "sudo",
    ["-n", "systemctl", action, service],
    {
      encoding: "utf8",
      timeout: 120_000,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

async function rpc(method, params = {}) {
  const response = await fetch(RPC, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    }),
    signal: AbortSignal.timeout(5_000),
  });

  if (!response.ok) {
    throw new Error(`AvalancheGo RPC HTTP ${response.status}`);
  }

  const body = await response.json();

  if (body.error) {
    throw new Error(
      body.error.message ?? "AvalancheGo RPC error",
    );
  }

  return body.result;
}

async function waitForRpc() {
  let lastError;

  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await rpc("info.getNodeVersion");
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) =>
        setTimeout(resolve, 2_000),
      );
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("AvalancheGo RPC did not return");
}

async function readState() {
  try {
    return JSON.parse(await readFile(STATE, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeState(value) {
  await mkdir(dirname(STATE), {
    recursive: true,
    mode: 0o700,
  });

  const temporary = `${STATE}.${process.pid}.tmp`;

  await writeFile(
    temporary,
    `${JSON.stringify(value, null, 2)}\n`,
    {
      mode: 0o600,
      flag: "wx",
    },
  );

  await rename(temporary, STATE);
}

function assertChain(value) {
  if (!/^chain[a-p]{12}$/.test(value ?? "")) {
    throw new Error("invalid thaw.fun internal chain name");
  }
}

function assertAvalancheId(value) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{30,60}$/.test(value ?? "")) {
    throw new Error("invalid Avalanche ID");
  }
}
