import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import type { AvalancheAdapter, CreatedL1, DisposableChain } from "./domain.js";
import type { CommandRunnerLike } from "./command-runner.js";
import { CommandRunner } from "./command-runner.js";
import { parseLocalDeployment } from "./avalanche-metadata.js";
import { hexQuantityToNumber, rpcCall } from "./rpc.js";
import type { StructuredLogger } from "./logger.js";
import { jsonLogger } from "./logger.js";
import { CommandError } from "./errors.js";

const LOCAL_OWNER = "0x8db97C7cece249c2b98bdC0226Cc4C2A57BF52FC";
const LOCAL_TEST_KEY = "56289e99c94b6912bfc12adc093c9b51124f0dc54ac7a766b2bc5ccf558d8027";
const BLOCK_PROBE_RECIPIENT = "0x1111111111111111111111111111111111111111";

export interface LocalAdapterOptions {
  homeDir?: string;
  avalancheCliBaseDir?: string;
  avalancheExecutable?: string;
  castExecutable?: string;
  vmVersion?: string;
  avalancheGoVersion?: string;
  signatureAggregatorVersion?: string;
  runner?: CommandRunnerLike;
  logger?: StructuredLogger;
}

class PartialDeploymentError extends Error {
  constructor(message: string, public readonly deployment: CreatedL1) { super(message); }
}

export class LocalAvalancheAdapter implements AvalancheAdapter {
  private readonly homeDir: string;
  private readonly avalancheCliBaseDir: string;
  private readonly avalanche: string;
  private readonly cast: string;
  private readonly vmVersion: string;
  private readonly avalancheGoVersion: string;
  private readonly signatureAggregatorVersion: string;
  private readonly runner: CommandRunnerLike;
  private readonly logger: StructuredLogger;

  constructor(options: LocalAdapterOptions = {}) {
    this.homeDir = options.homeDir ?? homedir();
    this.avalancheCliBaseDir = options.avalancheCliBaseDir ?? process.env.AVALANCHE_CLI_BASE_DIR ?? join(this.homeDir, ".avalanche-cli");
    this.avalanche = options.avalancheExecutable ?? process.env.AVALANCHE_CLI_PATH ?? "avalanche";
    this.cast = options.castExecutable ?? process.env.CAST_PATH ?? join(this.homeDir, ".foundry", "bin", "cast");
    this.vmVersion = options.vmVersion ?? process.env.AVALANCHE_VM_VERSION ?? "v0.8.0";
    this.avalancheGoVersion = options.avalancheGoVersion ?? process.env.AVALANCHEGO_VERSION ?? "v1.14.0";
    this.signatureAggregatorVersion = options.signatureAggregatorVersion ?? process.env.AVALANCHE_SIGNATURE_AGGREGATOR_VERSION ?? "v0.5.4";
    this.runner = options.runner ?? new CommandRunner();
    this.logger = options.logger ?? jsonLogger;
  }

  async createL1(chain: DisposableChain, markExternalMutationStarted?: () => Promise<void>): Promise<CreatedL1> {
    const started = Date.now();
    this.log(chain, "create_config", "CREATING");
    await this.quarantineEmptyCliCache();
    await this.runner.run(this.avalanche, [
      "blockchain", "create", chain.internalName,
      "--skip-update-check", "--evm", "--vm-version", this.vmVersion,
      "--proof-of-authority", "--test-defaults",
      "--evm-chain-id", String(chain.evmChainId), "--evm-token", chain.symbol,
      "--validator-manager-owner", LOCAL_OWNER, "--proxy-contract-owner", LOCAL_OWNER,
    ], { timeoutMs: 300_000 });

    this.log(chain, "deploy", "CREATING");
    await this.quarantineEmptyCliCache();
    await markExternalMutationStarted?.();
    let deployFailure: unknown;
    try {
      await this.runner.run(this.avalanche, [
        "blockchain", "deploy", chain.internalName,
        "--skip-update-check", "--local", "--ewoq",
        "--avalanchego-version", this.avalancheGoVersion,
        "--signature-aggregator-version", this.signatureAggregatorVersion,
        "--skip-icm-deploy", "--skip-relayer",
      ], { timeoutMs: 900_000 });
    } catch (error) {
      // CLI 1.9.6 may fail in a post-deploy helper after the L1 is already live.
      deployFailure = error;
    }

    const base = join(this.avalancheCliBaseDir, "subnets", chain.internalName);
    const metadata = await this.waitForMetadata(join(base, "sidecar.json"), join(base, "genesis.json"), chain.evmChainId);
    if (deployFailure) this.logger.info({ chainId: chain.id, internalName: chain.internalName, operation: "deploy", status: "metadata_recovered" }, "CLI exited non-zero after usable deployment metadata appeared");
    try {
      await this.waitForRpc(metadata.rpcUrl, chain.evmChainId);
      const before = await this.blockNumber(metadata.rpcUrl);
      await this.runner.run(this.cast, [
        "send", BLOCK_PROBE_RECIPIENT, "--value", "1wei", "--private-key", LOCAL_TEST_KEY,
        "--rpc-url", metadata.rpcUrl, "--json",
      ], { timeoutMs: 120_000 });
      const after = await this.blockNumber(metadata.rpcUrl);
      if (after <= before) throw new Error(`block production was not proven (${before} -> ${after})`);
      this.logger.info({ chainId: chain.id, internalName: chain.internalName, operation: "create", status: "LIVE", duration: Date.now() - started }, "Local L1 is live");
      return { ...metadata, latestBlock: after };
    } catch (error) {
      throw new PartialDeploymentError(error instanceof Error ? error.message : String(error), metadata);
    }
  }

  async getBlockNumber(chain: DisposableChain): Promise<number> {
    if (!chain.rpcUrl) throw new Error("chain has no RPC URL");
    return this.blockNumber(chain.rpcUrl);
  }

  async isRpcHealthy(chain: DisposableChain): Promise<boolean> {
    try {
      if (!chain.rpcUrl) return false;
      const chainId = hexQuantityToNumber(await rpcCall(chain.rpcUrl, "eth_chainId"), "chain ID");
      await this.blockNumber(chain.rpcUrl);
      return chainId === chain.evmChainId;
    } catch { return false; }
  }

  async expireL1(chain: DisposableChain): Promise<void> {
    this.log(chain, "expire_network_stop", "EXPIRING");
    // Avalanche CLI 1.9.6 has no reliable single-L1 process stop. The MVP permits
    // one active disposable Local L1, so graceful whole-network stop is intentional.
    await this.quarantineEmptyCliCache();
    try {
      await this.runner.run(this.avalanche, ["network", "status", "--skip-update-check"], { timeoutMs: 30_000 });
    } catch (error) {
      if (isNetworkStopped(error)) return;
      throw error;
    }
    try {
      await this.runner.run(this.avalanche, ["network", "stop", "--skip-update-check"], { timeoutMs: 180_000 });
    } catch (error) {
      if (isNetworkStopped(error)) return;
      throw error;
    }
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (!(await this.isRpcHealthy(chain))) return;
      await delay(500);
    }
    throw new Error("Local RPC remained healthy after avalanche network stop");
  }

  private async waitForMetadata(sidecar: string, genesis: string, chainId: number): Promise<CreatedL1> {
    const deadline = Date.now() + 30_000;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try { return await parseLocalDeployment(sidecar, genesis, chainId); }
      catch (error) { lastError = error; await delay(500); }
    }
    throw lastError instanceof Error ? lastError : new Error("Avalanche deployment metadata did not appear");
  }

  private async waitForRpc(url: string, expectedChainId: number): Promise<void> {
    const deadline = Date.now() + 120_000;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const actual = hexQuantityToNumber(await rpcCall(url, "eth_chainId"), "chain ID");
        if (actual !== expectedChainId) throw new Error(`RPC chain ID ${actual} does not match ${expectedChainId}`);
        await this.blockNumber(url);
        return;
      } catch (error) { lastError = error; await delay(1_000); }
    }
    throw lastError instanceof Error ? lastError : new Error("Local RPC did not become healthy");
  }

  private async blockNumber(url: string): Promise<number> {
    return hexQuantityToNumber(await rpcCall(url, "eth_blockNumber"), "block number");
  }

  private log(chain: DisposableChain, operation: string, status: string): void {
    this.logger.info({ chainId: chain.id, internalName: chain.internalName, operation, status }, operation);
  }

  private async quarantineEmptyCliCache(): Promise<void> {
    const cache = join(this.avalancheCliBaseDir, "download-cache", "min_cli_version.json");
    try {
      if ((await stat(cache)).size > 0) return;
      await rename(cache, `${cache}.corrupt-${Date.now()}.bak`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await mkdir(join(this.avalancheCliBaseDir, "download-cache"), { recursive: true });
    await writeFile(cache, `${JSON.stringify({ "min-version": process.env.AVALANCHE_MIN_CLI_VERSION ?? "1.9.3" }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  }
}

const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function isNetworkStopped(error: unknown): boolean {
  if (!(error instanceof CommandError)) return false;
  return `${error.stdout}\n${error.stderr}`.toLowerCase().includes("network is not running");
}
