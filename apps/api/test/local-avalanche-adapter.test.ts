import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir, access } from "node:fs/promises";
import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CommandRunnerLike, CommandResult, RunOptions } from "../src/command-runner.js";
import { CommandError } from "../src/errors.js";
import type { DisposableChain } from "../src/domain.js";
import { LocalAvalancheAdapter } from "../src/local-avalanche-adapter.js";

test("Local expiration accepts official already-stopped network status", async () => {
  const directory = await mkdtemp(join(tmpdir(), "local-expire-"));
  const cacheDirectory = join(directory, ".avalanche-cli", "download-cache");
  await mkdir(cacheDirectory, { recursive: true });
  await writeFile(join(cacheDirectory, "min_cli_version.json"), '{"min-version":"1.9.3"}\n');
  const runner = new StoppedNetworkRunner();
  const adapter = new LocalAvalancheAdapter({ homeDir: directory, runner });
  await adapter.expireL1(chain());
  assert.deepEqual(runner.commands, ["network status --skip-update-check"]);
  await rm(directory, { recursive: true, force: true });
});

class StoppedNetworkRunner implements CommandRunnerLike {
  commands: string[] = [];
  async run(executable: string, args: readonly string[], _options?: RunOptions): Promise<CommandResult> {
    this.commands.push(args.join(" "));
    throw new CommandError(executable, args, 1, "", "Error: network is not running", false);
  }
}

function chain(): DisposableChain {
  return {
    id: "stopped", name: "STOPPED", internalName: "chain-stopped", symbol: "STOP", network: "local",
    evmChainId: 123456789, createdAt: new Date(0).toISOString(), lifetimeSeconds: 60, status: "EXPIRING",
    rpcUrl: "http://127.0.0.1/rpc",
  };
}

test("Local quarantine writes the CLI cache under homeDir/.avalanche-cli by default", async () => {
  await withAdapterEnvironment({ AVALANCHE_CLI_BASE_DIR: undefined, AVALANCHE_MIN_CLI_VERSION: undefined }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "local-default-"));
    try {
      const adapter = new LocalAvalancheAdapter({ homeDir: directory, runner: new StoppedNetworkRunner() });
      await adapter.expireL1(chain());
      const raw = await readFile(join(directory, ".avalanche-cli", "download-cache", "min_cli_version.json"), "utf8");
      assert.deepEqual(JSON.parse(raw), { "min-version": "1.9.3" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test("Local quarantine reads and writes only the configured avalancheCliBaseDir", async () => {
  await withAdapterEnvironment({ AVALANCHE_CLI_BASE_DIR: undefined, AVALANCHE_MIN_CLI_VERSION: undefined }, async () => {
    const home = await mkdtemp(join(tmpdir(), "local-override-home-"));
    const base = await mkdtemp(join(tmpdir(), "local-override-base-"));
    try {
      const cacheDirectory = join(base, "download-cache");
      await mkdir(cacheDirectory, { recursive: true });
      await writeFile(join(cacheDirectory, "min_cli_version.json"), "");
      const adapter = new LocalAvalancheAdapter({ homeDir: home, avalancheCliBaseDir: base, runner: new StoppedNetworkRunner() });
      await adapter.expireL1(chain());
      const raw = await readFile(join(cacheDirectory, "min_cli_version.json"), "utf8");
      assert.deepEqual(JSON.parse(raw), { "min-version": "1.9.3" });
      const files = await readdir(cacheDirectory);
      assert.ok(files.some((name) => name.startsWith("min_cli_version.json.corrupt-")), "empty cache file was quarantined in the overridden base dir");
      await assert.rejects(access(join(home, ".avalanche-cli")));
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(base, { recursive: true, force: true });
    }
  });
});

test("Local quarantine follows AVALANCHE_CLI_BASE_DIR from the environment", async () => {
  const home = await mkdtemp(join(tmpdir(), "local-env-home-"));
  const base = await mkdtemp(join(tmpdir(), "local-env-base-"));
  await withAdapterEnvironment({ AVALANCHE_CLI_BASE_DIR: base, AVALANCHE_MIN_CLI_VERSION: undefined }, async () => {
    const adapter = new LocalAvalancheAdapter({ homeDir: home, runner: new StoppedNetworkRunner() });
    await adapter.expireL1(chain());
    const raw = await readFile(join(base, "download-cache", "min_cli_version.json"), "utf8");
    assert.deepEqual(JSON.parse(raw), { "min-version": "1.9.3" });
    await assert.rejects(access(join(home, ".avalanche-cli")));
  });
  await rm(home, { recursive: true, force: true });
  await rm(base, { recursive: true, force: true });
});

test("Local createL1 reads sidecar metadata from the configured avalancheCliBaseDir", async () => {
  const home = await mkdtemp(join(tmpdir(), "local-sidecar-home-"));
  const base = await mkdtemp(join(tmpdir(), "local-sidecar-base-"));
  const fixture = {
    subnetId: "2kp8p9FnJhv586AEYMhyxvZeVEe2P9SNhZU9kXPzrikoJTukR5",
    blockchainId: "c5nJmPREUtrKDpZ2yPtLLz5DKcaVnNz73e3fm65i9qAxGA4Yh",
    evmChainId: chain().evmChainId,
  };
  let blockHeight = 0;
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      const method = (JSON.parse(body) as { method?: string }).method;
      const result = method === "eth_chainId"
        ? `0x${fixture.evmChainId.toString(16)}`
        : `0x${(++blockHeight).toString(16)}`;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const rpcUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/ext/bc/${fixture.blockchainId}/rpc`;
  try {
    const runner = new SidecarWritingRunner(async () => {
      const subnetsDirectory = join(base, "subnets", chain().internalName);
      await mkdir(subnetsDirectory, { recursive: true });
      await writeFile(join(subnetsDirectory, "sidecar.json"), JSON.stringify({
        Networks: {
          "Local Network": {
            SubnetID: fixture.subnetId,
            BlockchainID: fixture.blockchainId,
            RPCEndpoints: [rpcUrl],
            ValidatorManagerAddress: "",
            BootstrapValidators: [],
          },
        },
      }));
      await writeFile(join(subnetsDirectory, "genesis.json"), JSON.stringify({ config: { chainId: fixture.evmChainId } }));
    });
    const adapter = new LocalAvalancheAdapter({
      homeDir: home,
      avalancheCliBaseDir: base,
      runner,
      avalancheExecutable: "avalanche",
      castExecutable: "cast",
      vmVersion: "v0.8.0",
      avalancheGoVersion: "v1.14.0",
      signatureAggregatorVersion: "v0.5.4",
    });
    const created = await adapter.createL1(chain());
    assert.equal(created.subnetId, fixture.subnetId);
    assert.equal(created.blockchainId, fixture.blockchainId);
    assert.equal(created.rpcUrl, rpcUrl);
    assert.ok(created.latestBlock > 0, "createL1 resolved LIVE only after proven block growth");
    assert.deepEqual(runner.commands, [
      {
        executable: "avalanche",
        args: ["blockchain", "create", "chain-stopped", "--skip-update-check", "--evm", "--vm-version", "v0.8.0", "--proof-of-authority", "--test-defaults", "--evm-chain-id", "123456789", "--evm-token", "STOP", "--validator-manager-owner", "0x8db97C7cece249c2b98bdC0226Cc4C2A57BF52FC", "--proxy-contract-owner", "0x8db97C7cece249c2b98bdC0226Cc4C2A57BF52FC"],
      },
      {
        executable: "avalanche",
        args: ["blockchain", "deploy", "chain-stopped", "--skip-update-check", "--local", "--ewoq", "--avalanchego-version", "v1.14.0", "--signature-aggregator-version", "v0.5.4", "--skip-icm-deploy", "--skip-relayer"],
      },
      {
        executable: "cast",
        args: ["send", "0x1111111111111111111111111111111111111111", "--value", "1wei", "--private-key", "56289e99c94b6912bfc12adc093c9b51124f0dc54ac7a766b2bc5ccf558d8027", "--rpc-url", rpcUrl, "--json"],
      },
    ]);
    await assert.rejects(access(join(home, ".avalanche-cli")));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(home, { recursive: true, force: true });
    await rm(base, { recursive: true, force: true });
  }
});

class SidecarWritingRunner implements CommandRunnerLike {
  readonly commands: { executable: string; args: string[] }[] = [];

  constructor(private readonly writeSidecar: () => Promise<void>) {}

  async run(executable: string, args: readonly string[], _options?: RunOptions): Promise<CommandResult> {
    this.commands.push({ executable, args: [...args] });
    if (args[0] === "blockchain" && args[1] === "create") await this.writeSidecar();
    return { executable, args, exitCode: 0, stdout: "", stderr: "", durationMs: 0 };
  }
}

async function withAdapterEnvironment(environment: Record<string, string | undefined>, run: () => Promise<void>): Promise<void> {
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(environment)) {
    saved.set(key, process.env[key]);
    if (environment[key] === undefined) delete process.env[key];
    else process.env[key] = environment[key] as string;
  }
  try {
    await run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
