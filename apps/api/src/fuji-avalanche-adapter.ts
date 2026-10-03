import { createHash } from "node:crypto";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { connect, isIP } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CommandRunnerLike } from "./command-runner.js";
import { CommandRunner } from "./command-runner.js";
import type { AvalancheAdapter, CreatedL1, DisposableChain } from "./domain.js";
import { CommandError, sanitizeFailure } from "./errors.js";
import type { StructuredLogger } from "./logger.js";
import { jsonLogger } from "./logger.js";
import { hexQuantityToNumber, rpcCall } from "./rpc.js";
import { prepareFujiGenesis } from "./fuji-genesis.js";
import { FoundryFujiManagerBootstrap } from "./fuji-manager-bootstrap.js";

const BLOCK_PROBE_RECIPIENT = "0x1111111111111111111111111111111111111111";
const DEFAULT_P_CHAIN_RPC = "https://api.avax-test.network/ext/P";
// darwin/arm64 build of the pinned v2.0.1 CLI with both conversion owner fields
// explicitly set to the signing P-Chain address. Never fall back to upstream.
const OWNER_SAFE_PLATFORM_CLI_SHA256 = "c6e4c3fe5cea038b8ecd207cafe57a9c2f466b008957e652854bbd119ad654ba";

export interface FujiNodeIdentity {
  nodeId: string;
  blsPublicKey: string;
  blsProofOfPossession: string;
}

export interface FujiDeploymentMetadata {
  subnetId: string;
  blockchainId: string;
  validatorManagerAddress: string;
  validatorId: string;
  validatorNodeId: string;
  rpcUrl: string;
}

export interface FujiHostingController {
  assertReady(): Promise<void>;
  assertCreateReady(): Promise<void>;
  prepare(chain: DisposableChain, deployment: FujiDeploymentMetadata): Promise<void>;
  stop(chain: DisposableChain): Promise<"stopped" | "already-stopped">;
  isStopped(chain: DisposableChain): Promise<boolean>;
}

export interface FujiManagerBootstrap {
  assertReady(): Promise<void>;
  initialize(
    chain: DisposableChain,
    deployment: FujiDeploymentMetadata,
    node: FujiNodeIdentity,
    record: (step: string, phase: "pending" | "accepted" | "verified", txId?: string) => Promise<void>,
    checkpoint?: (update: Partial<DisposableChain>) => Promise<void>,
  ): Promise<void>;
}

interface RpcClient {
  call<T>(url: string, method: string, params?: unknown[]): Promise<T>;
}

export interface FujiAdapterOptions {
  platformCliExecutable?: string;
  castExecutable?: string;
  keyName?: string;
  genesisPath?: string;
  officialGenesisSourcePath?: string;
  genesisManifestPath?: string;
  genesisOutputDir?: string;
  validatorManagerAddress?: string;
  nodeAddress?: string;
  rpcBaseUrl?: string;
  pChainRpcUrl?: string;
  pChainAddress?: string;
  maxPChainGasPriceNAvax?: bigint;
  minPChainBalanceNAvax?: bigint;
  probeKeystorePath?: string;
  probeAddress?: string;
  interactiveSigning?: boolean;
  validatorBalanceAvax?: number;
  runner?: CommandRunnerLike;
  hosting?: FujiHostingController;
  managerBootstrap?: FujiManagerBootstrap;
  rpc?: RpcClient;
  logger?: StructuredLogger;
  readinessAttempts?: number;
  readinessDelayMs?: number;
  accessFile?: (path: string) => Promise<void>;
  prepareGenesis?: typeof prepareFujiGenesis;
  readProbeAddress?: () => Promise<string>;
  readFujiWalletAddress?: () => Promise<string>;
  rpcReachable?: (url: string) => Promise<boolean>;
  hasTty?: boolean;
  inspectProbeFiles?: (keystore: string) => Promise<void>;
  verifyPlatformCli?: () => Promise<void>;
}

class PartialFujiDeploymentError extends Error {
  readonly requiresRecovery = true;
  constructor(message: string, public readonly deployment: Partial<CreatedL1>) { super(message); }
}

class FujiCleanupIncompleteError extends Error {
  readonly requiresRecovery = true;
}

class FujiCreatePreparation {
  constructor(
    readonly chainId: string,
    readonly genesisPath: string,
    readonly node: FujiNodeIdentity,
  ) {}
}

export class CommandFujiHostingController implements FujiHostingController {
  constructor(
    private readonly executable: string | undefined,
    private readonly runner: CommandRunnerLike = new CommandRunner(),
  ) {}

  async assertReady(): Promise<void> {
    if (!this.executable) throw new Error("FUJI_HOST_CONTROL_NOT_CONFIGURED");
  }

  async assertCreateReady(): Promise<void> {
    await this.assertReady();
    await this.runner.run(this.executable!, ["check"], { timeoutMs: 20_000 });
    const configured = process.env.SHIPFUN_FUJI_PUBLIC_IP;
    if (!configured || !isIP(configured)) throw new Error("FUJI_PUBLIC_IP_REQUIRED");
    const reported = await rpcCall<{ ip?: string }>("http://127.0.0.1:9650/ext/info", "info.getNodeIP");
    let endpoint: URL;
    try { endpoint = new URL(`http://${reported.ip ?? ""}`); }
    catch { throw new Error("FUJI_NODE_PUBLIC_ENDPOINT_INVALID"); }
    const expected = new URL(`http://${isIP(configured) === 6 ? `[${configured}]` : configured}`);
    if (endpoint.port !== "9651" || endpoint.hostname !== expected.hostname) {
      throw new Error("FUJI_NODE_ADVERTISED_IP_MISMATCH");
    }
  }

  async prepare(chain: DisposableChain, deployment: FujiDeploymentMetadata): Promise<void> {
    await this.assertReady();
    await this.runner.run(this.executable!, ["prepare", chain.internalName, deployment.subnetId, deployment.blockchainId], { timeoutMs: 300_000 });
  }

  async stop(chain: DisposableChain): Promise<"stopped" | "already-stopped"> {
    await this.assertReady();
    try {
      await this.runner.run(this.executable!, ["stop", chain.internalName], { timeoutMs: 180_000 });
      return "stopped";
    } catch (error) {
      if (commandOutput(error).includes("already stopped")) return "already-stopped";
      throw error;
    }
  }

  async isStopped(chain: DisposableChain): Promise<boolean> {
    await this.assertReady();
    try {
      await this.runner.run(this.executable!, ["is-stopped", chain.internalName], { timeoutMs: 30_000 });
      return true;
    } catch { return false; }
  }
}

export class FujiAvalancheAdapter implements AvalancheAdapter {
  private readonly preflightTokens = new WeakSet<FujiCreatePreparation>();
  private readonly platformCli: string;
  private readonly cast: string;
  private readonly keyName: string;
  private readonly genesisPath: string;
  private readonly officialGenesisSourcePath: string;
  private readonly genesisManifestPath: string;
  private readonly genesisOutputDir: string;
  private readonly manager: string;
  private readonly nodeAddress: string;
  private readonly rpcBaseUrl: string;
  private readonly pChainRpcUrl: string;
  private readonly pChainAddress: string;
  private readonly maxPChainGasPriceNAvax: bigint | undefined;
  private readonly minPChainBalanceNAvax: bigint | undefined;
  private readonly probeKeystore: string;
  private readonly probeAddress: string;
  private readonly interactiveSigning: boolean;
  private readonly validatorBalanceAvax: number;
  private readonly runner: CommandRunnerLike;
  private readonly hosting: FujiHostingController;
  private readonly managerBootstrap: FujiManagerBootstrap | undefined;
  private readonly rpc: RpcClient;
  private readonly logger: StructuredLogger;
  private readonly attempts: number;
  private readonly delayMs: number;
  private readonly accessFile: (path: string) => Promise<void>;
  private readonly prepareGenesis: typeof prepareFujiGenesis;
  private readonly readProbeAddress: () => Promise<string>;
  private readonly readFujiWalletAddress: () => Promise<string>;
  private readonly rpcReachable: (url: string) => Promise<boolean>;
  private readonly hasTty: boolean;
  private readonly inspectProbeFiles: (keystore: string) => Promise<void>;
  private readonly verifyPlatformCli: () => Promise<void>;

  constructor(options: FujiAdapterOptions = {}) {
    this.platformCli = options.platformCliExecutable ?? process.env.PLATFORM_CLI_PATH ?? "platform-cli";
    this.cast = options.castExecutable ?? process.env.CAST_PATH ?? join(homedir(), ".foundry", "bin", "cast");
    this.keyName = options.keyName ?? process.env.SHIPFUN_FUJI_KEY_NAME ?? "";
    this.genesisPath = options.genesisPath ?? process.env.SHIPFUN_FUJI_GENESIS_PATH ?? "";
    this.officialGenesisSourcePath = options.officialGenesisSourcePath ?? process.env.SHIPFUN_FUJI_OFFICIAL_GENESIS_SOURCE_PATH ?? "";
    this.genesisManifestPath = options.genesisManifestPath ?? process.env.SHIPFUN_FUJI_GENESIS_MANIFEST_PATH ?? "";
    this.genesisOutputDir = options.genesisOutputDir ?? (process.env.SHIPFUN_FUJI_GENESIS_OUTPUT_DIR || resolve(import.meta.dirname, "../../..", ".runtime", "fuji-genesis"));
    this.manager = options.validatorManagerAddress ?? process.env.SHIPFUN_FUJI_VALIDATOR_MANAGER_ADDRESS ?? "";
    this.nodeAddress = options.nodeAddress ?? process.env.SHIPFUN_FUJI_NODE_ADDRESS ?? "";
    this.rpcBaseUrl = options.rpcBaseUrl ?? process.env.SHIPFUN_FUJI_RPC_BASE_URL ?? "";
    this.pChainRpcUrl = options.pChainRpcUrl ?? process.env.SHIPFUN_FUJI_P_CHAIN_RPC_URL ?? DEFAULT_P_CHAIN_RPC;
    this.pChainAddress = options.pChainAddress ?? process.env.SHIPFUN_FUJI_P_ADDRESS ?? "";
    this.maxPChainGasPriceNAvax = options.maxPChainGasPriceNAvax ?? positiveBigInt(process.env.SHIPFUN_FUJI_MAX_P_GAS_PRICE_NAVAX);
    this.minPChainBalanceNAvax = options.minPChainBalanceNAvax ?? positiveBigInt(process.env.SHIPFUN_FUJI_MIN_P_BALANCE_NAVAX);
    this.probeKeystore = options.probeKeystorePath ?? process.env.SHIPFUN_FUJI_PROBE_KEYSTORE ?? "";
    this.probeAddress = options.probeAddress ?? process.env.SHIPFUN_FUJI_PROBE_ADDRESS ?? "";
    this.interactiveSigning = options.interactiveSigning ?? process.env.SHIPFUN_FUJI_INTERACTIVE_SIGNING === "true";
    this.validatorBalanceAvax = options.validatorBalanceAvax ?? 1;
    this.runner = options.runner ?? new CommandRunner();
    this.rpc = options.rpc ?? { call: rpcCall };
    this.hosting = options.hosting ?? new CommandFujiHostingController(process.env.SHIPFUN_FUJI_HOST_CONTROL_EXECUTABLE, this.runner);
    this.managerBootstrap = options.managerBootstrap ?? new FoundryFujiManagerBootstrap({
      contractsPath: process.env.SHIPFUN_FUJI_ICM_CONTRACTS_PATH ?? "",
      signatureAggregatorUrl: process.env.SHIPFUN_FUJI_SIG_AGG_URL ?? "",
      keystorePath: this.probeKeystore,
      signerAddress: this.probeAddress,
      pChainRpcUrl: this.pChainRpcUrl,
      castExecutable: this.cast,
      forgeExecutable: process.env.FORGE_PATH ?? join(homedir(), ".foundry", "bin", "forge"),
      compilerPath: process.env.SHIPFUN_FUJI_SOLC_PATH ?? "",
      runner: this.runner,
      rpc: this.rpc,
    });
    this.logger = options.logger ?? jsonLogger;
    this.attempts = options.readinessAttempts ?? 60;
    this.delayMs = options.readinessDelayMs ?? 2_000;
    this.accessFile = options.accessFile ?? access;
    this.prepareGenesis = options.prepareGenesis ?? prepareFujiGenesis;
    this.readProbeAddress = options.readProbeAddress ?? (async () => {
      const result = await this.runner.run(this.cast, ["wallet", "address", "--keystore", this.probeKeystore], {
        timeoutMs: 60_000, stdin: "inherit", operatorPasswordPrompt: true, redactFailureOutput: true, env: safeSignerEnvironment(),
      });
      const address = result.stdout.trim();
      if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("encrypted Fuji probe keystore did not return an EVM address");
      return address;
    });
    this.readFujiWalletAddress = options.readFujiWalletAddress ?? (async () => {
      const result = await this.runner.run(this.platformCli, ["wallet", "address", "--network", "fuji", "--key-name", this.keyName], {
        timeoutMs: 60_000, stdin: "inherit", operatorPasswordPrompt: true, redactFailureOutput: true, env: safeSignerEnvironment(),
      });
      const address = result.stdout.match(/P-Chain Address:\s*(P-fuji1[0-9a-z]+)/)?.[1];
      if (!address) throw new Error("Fuji wallet address was not returned by Platform CLI");
      return address;
    });
    this.rpcReachable = options.rpcReachable ?? tcpReachable;
    this.hasTty = options.hasTty ?? (Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY));
    this.inspectProbeFiles = options.inspectProbeFiles ?? inspectProbeFiles;
    this.verifyPlatformCli = options.verifyPlatformCli ?? (async () => {
      if (!isAbsolute(this.platformCli)) throw new Error("FUJI_OWNER_SAFE_PLATFORM_CLI_REQUIRED");
      const digest = createHash("sha256").update(await readFile(this.platformCli)).digest("hex");
      if (digest !== OWNER_SAFE_PLATFORM_CLI_SHA256) throw new Error("FUJI_OWNER_SAFE_PLATFORM_CLI_MISMATCH");
    });
  }

  async preflightCreate(chain: DisposableChain): Promise<FujiCreatePreparation> {
    this.assertFuji(chain);
    const preparation = await this.preflight(chain);
    this.preflightTokens.add(preparation);
    return preparation;
  }

  async createL1(chain: DisposableChain, markExternalMutationStarted?: () => Promise<void>, checkpoint?: (update: Partial<DisposableChain>) => Promise<void>, prepared?: unknown): Promise<CreatedL1> {
    this.assertFuji(chain);
    const preparation = prepared === undefined ? await this.preflightCreate(chain) : prepared;
    if (!(preparation instanceof FujiCreatePreparation) || preparation.chainId !== chain.id || !this.preflightTokens.delete(preparation)) {
      throw new Error("FUJI_CREATE_PREFLIGHT_MISMATCH");
    }
    const { genesisPath, node } = preparation;
    const partial: Partial<CreatedL1 & DisposableChain> = {
      validatorManagerAddress: this.manager,
      validatorNodeId: node.nodeId,
    };

    const journal = [...(chain.fujiJournal ?? [])];
    const record = async (step: string, phase: "pending" | "accepted" | "verified", txId?: string) => {
      journal.push({ step, phase, ...(txId ? { txId } : {}), at: new Date().toISOString() });
      await checkpoint?.({ ...partial, fujiJournal: [...journal] });
    };

    await markExternalMutationStarted?.();
    try {
      await record("subnet_create", "pending");
      const subnet = await this.runSigned(["subnet", "create"]);
      partial.subnetId = parseLabeledId(subnet.stdout, "Subnet ID");
      await record("subnet_create", "accepted", parseOptionalTxId(subnet.stdout));

      await record("chain_create", "pending");
      const blockchain = await this.runSigned([
        "chain", "create", "--subnet-id", partial.subnetId,
        "--genesis", genesisPath, "--name", chain.internalName,
      ]);
      partial.blockchainId = parseOptionalLabeledId(blockchain.stdout, "Blockchain ID")
        ?? parseLabeledId(blockchain.stdout, "Chain ID");
      partial.rpcUrl = `${this.rpcBaseUrl.replace(/\/$/, "")}/ext/bc/${partial.blockchainId}/rpc`;
      await record("chain_create", "accepted", parseOptionalTxId(blockchain.stdout));

      await record("convert_to_l1", "pending");
      const conversion = await this.runSigned([
        "subnet", "convert-to-l1", "--subnet-id", partial.subnetId,
        "--chain-id", partial.blockchainId, "--manager", this.manager,
        "--validator-node-ids", node.nodeId,
        "--validator-bls-public-keys", node.blsPublicKey,
        "--validator-bls-pops", node.blsProofOfPossession,
        "--validator-balance", String(this.validatorBalanceAvax),
        "--validator-weights", "100",
      ], 300_000);
      await record("convert_to_l1", "accepted", parseOptionalTxId(conversion.stdout));
      partial.validatorId = parseOptionalLabeledId(conversion.stdout, "Validation ID")
        ?? await this.readValidationId(partial.subnetId, node.nodeId);
      await record("validation_id", "verified");

      const deployment = requireDeployment(partial);
      await this.hosting.prepare(chain, deployment);
      await this.waitForExpectedRpc(deployment.rpcUrl, chain.evmChainId);
      await this.managerBootstrap!.initialize(chain, deployment, node, record, checkpoint);
      const before = await this.blockNumber(deployment.rpcUrl);
      await record("block_probe", "pending");
      const probe = await this.runner.run(this.cast, [
        "send", BLOCK_PROBE_RECIPIENT, "--value", "1wei",
        "--keystore", this.probeKeystore,
        "--rpc-url", deployment.rpcUrl, "--json",
      ], { timeoutMs: 120_000, stdin: "inherit", operatorPasswordPrompt: true, redactFailureOutput: true, env: safeSignerEnvironment() });
      const receipt = parseProbeReceipt(probe.stdout);
      partial.probeTxHash = receipt.hash;
      partial.probeReceiptBlock = receipt.block;
      partial.probeBlockBefore = before;
      await checkpoint?.({ ...partial, fujiJournal: [...journal] });
      await record("block_probe", "accepted", receipt.hash);
      const after = await this.blockNumber(deployment.rpcUrl);
      if (after <= before) throw new Error(`transaction was confirmed without block growth (${before} -> ${after})`);
      partial.probeBlockAfter = after;
      await checkpoint?.({ ...partial, fujiJournal: [...journal] });
      await record("block_probe", "verified", receipt.hash);
      this.logger.info({ chainId: chain.id, internalName: chain.internalName, operation: "fuji_create", status: "LIVE" }, "Fuji L1 is live");
      return { ...deployment, latestBlock: after };
    } catch (error) {
      throw new PartialFujiDeploymentError(sanitizeFailure(error), partial);
    }
  }

  async getBlockNumber(chain: DisposableChain): Promise<number> {
    if (!chain.rpcUrl) throw new Error("chain has no RPC URL");
    return this.blockNumber(chain.rpcUrl);
  }

  async isRpcHealthy(chain: DisposableChain): Promise<boolean> {
    try {
      if (!chain.rpcUrl) return false;
      const actual = hexQuantityToNumber(await this.rpc.call(chain.rpcUrl, "eth_chainId"), "chain ID");
      if (actual !== chain.evmChainId) return false;
      await this.blockNumber(chain.rpcUrl);
      return true;
    } catch { return false; }
  }

  async expireL1(chain: DisposableChain, checkpoint?: (update: Partial<DisposableChain>) => Promise<void>): Promise<void> {
    this.assertFuji(chain);
    try {
      if (!chain.validatorId) throw new Error("Fuji chain has no Validation ID");
      await this.hosting.assertReady();
      const journal = [...(chain.fujiJournal ?? [])];
      const record = async (step: string, phase: "pending" | "accepted" | "verified", txId?: string) => {
        journal.push({ step, phase, ...(txId ? { txId } : {}), at: new Date().toISOString() });
        await checkpoint?.({ fujiJournal: [...journal] });
      };
      if (!(await this.validatorInactive(chain.validatorId))) {
        await this.preflightSigningOnly();
        await record("validator_disable", "pending");
        try {
          const disable = await this.runSigned(["l1", "disable-validator", "--validation-id", chain.validatorId], 180_000);
          await record("validator_disable", "accepted", parseOptionalTxId(disable.stdout));
        } catch (error) {
          if (!isAlreadyDisabled(error) && !(await this.validatorInactive(chain.validatorId))) throw error;
        }
      }
      if (!(await this.validatorInactive(chain.validatorId))) throw new Error("P-Chain did not confirm validator inactive");
      await record("validator_inactive", "verified");
      await this.hosting.stop(chain);
      await record("hosting_stop", "accepted");
      for (let attempt = 0; attempt < this.attempts; attempt += 1) {
        if (!(await this.rpcReachable(chain.rpcUrl ?? "")) && await this.hosting.isStopped(chain)) {
          await record("rpc_offline", "verified");
          return;
        }
        await delay(this.delayMs);
      }
      throw new Error("Fuji RPC or hosting remained online after cleanup");
    } catch (error) {
      throw new FujiCleanupIncompleteError(sanitizeFailure(error));
    }
  }

  private async preflight(chain: DisposableChain): Promise<FujiCreatePreparation> {
    await this.hosting.assertCreateReady();
    await this.preflightSigningOnly(this.conversionDeposit());
    if (!this.genesisPath || !this.genesisManifestPath || !this.officialGenesisSourcePath) throw new Error("reviewed Fuji genesis template, manifest, and pinned official source are required");
    if (!/^0x[0-9a-fA-F]{40}$/.test(this.manager)) throw new Error("valid Fuji validator manager address is required");
    if (!this.nodeAddress) throw new Error("SHIPFUN_FUJI_NODE_ADDRESS is required");
    if (!/^https?:\/\//.test(this.rpcBaseUrl)) throw new Error("valid SHIPFUN_FUJI_RPC_BASE_URL is required");
    if (!this.probeKeystore || !/^0x[0-9a-fA-F]{40}$/.test(this.probeAddress)) throw new Error("encrypted Fuji probe identity is required");
    for (const path of [this.genesisPath, this.genesisManifestPath, this.officialGenesisSourcePath, this.probeKeystore]) {
      if (!isAbsolute(path)) throw new Error("Fuji artifact paths must be absolute");
      await this.accessFile(path);
    }
    await this.inspectProbeFiles(this.probeKeystore);
    if ((await this.readProbeAddress()).toLowerCase() !== this.probeAddress.toLowerCase()) throw new Error("Fuji probe keystore address mismatch");
    if (!this.managerBootstrap) throw new Error("FUJI_MANAGER_BOOTSTRAP_NOT_CONFIGURED");
    await this.managerBootstrap.assertReady();
    const node = await this.readNodeIdentity();
    await this.hosting.assertCreateReady();
    const preparedGenesis = await this.prepareGenesis(chain, {
      templatePath: this.genesisPath,
      officialSourcePath: this.officialGenesisSourcePath,
      manifestPath: this.genesisManifestPath,
      outputDir: this.genesisOutputDir,
      managerAddress: this.manager,
      probeAddress: this.probeAddress,
    });
    return new FujiCreatePreparation(chain.id, preparedGenesis, node);
  }

  private async preflightSigningOnly(deposit = 0n): Promise<void> {
    if (!this.keyName) throw new Error("SHIPFUN_FUJI_KEY_NAME is required");
    if (!this.interactiveSigning) throw new Error("FUJI_INTERACTIVE_SIGNING_REQUIRED");
    if (!this.hasTty) throw new Error("FUJI_OPERATOR_TTY_REQUIRED");
    await this.verifyPlatformCli();
    if (!/^P-fuji1[0-9a-z]+$/.test(this.pChainAddress) || !this.maxPChainGasPriceNAvax || !this.minPChainBalanceNAvax) {
      throw new Error("FUJI_EXPLICIT_P_CHAIN_BUDGET_REQUIRED");
    }
    await this.assertPChainBudget(deposit);
    if (await this.readFujiWalletAddress() !== this.pChainAddress) throw new Error("FUJI_KEY_NAME_P_ADDRESS_MISMATCH");
  }

  private async readNodeIdentity(): Promise<FujiNodeIdentity> {
    const result = await this.runner.run(this.platformCli, ["node", "info", "--ip", this.nodeAddress], { timeoutMs: 30_000 });
    return {
      nodeId: parseLabeledId(result.stdout, "Node ID"),
      blsPublicKey: parseHexLabel(result.stdout, "BLS Public Key", 96),
      blsProofOfPossession: parseOptionalHexLabel(result.stdout, "BLS Proof of Possession", 192)
        ?? parseHexLabel(result.stdout, "BLS PoP", 192),
    };
  }

  private async runSigned(args: readonly string[], timeoutMs = 180_000) {
    await this.verifyPlatformCli();
    const deposit = args[0] === "subnet" && args[1] === "convert-to-l1"
      ? this.conversionDeposit() : 0n;
    await this.assertPChainBudget(deposit);
    return this.runner.run(this.platformCli, [...args, "--network", "fuji", "--key-name", this.keyName], { timeoutMs, stdin: "inherit", operatorPasswordPrompt: true, redactFailureOutput: true, env: safeSignerEnvironment() });
  }

  private conversionDeposit(): bigint {
    const nAvax = Math.round(this.validatorBalanceAvax * 1_000_000_000);
    if (!Number.isSafeInteger(nAvax) || nAvax <= 0) throw new Error("FUJI_VALIDATOR_BALANCE_INVALID");
    return BigInt(nAvax);
  }

  private async assertPChainBudget(deposit: bigint): Promise<void> {
    const [feeState, feeConfig, wallet] = await Promise.all([
      this.rpc.call<{ price?: string | number }>(this.pChainRpcUrl, "platform.getFeeState", []),
      this.rpc.call<{ maxCapacity?: string | number }>(this.pChainRpcUrl, "platform.getFeeConfig", []),
      this.rpc.call<{ balance?: string }>(this.pChainRpcUrl, "platform.getBalance", [{ addresses: [this.pChainAddress] }]),
    ]);
    const price = strictPositiveBigInt(feeState.price, "P-Chain gas price");
    const maxCapacity = strictPositiveBigInt(feeConfig.maxCapacity, "P-Chain max capacity");
    const balance = strictPositiveBigInt(wallet.balance, "P-Chain wallet balance");
    if (price > this.maxPChainGasPriceNAvax!) throw new Error("FUJI_P_CHAIN_GAS_PRICE_EXCEEDS_APPROVED_THRESHOLD");
    if (balance < deposit + price * maxCapacity + this.minPChainBalanceNAvax!) {
      throw new Error("FUJI_P_CHAIN_CLEANUP_RESERVE_INSUFFICIENT");
    }
  }

  private async validatorInactive(validationId: string): Promise<boolean> {
    const result = await this.rpc.call<{ balance?: string }>(this.pChainRpcUrl, "platform.getL1Validator", [{ validationID: validationId }]);
    if (typeof result.balance !== "string" || !/^\d+$/.test(result.balance)) throw new Error("P-Chain validator balance is unavailable");
    return BigInt(result.balance) === 0n;
  }

  private async readValidationId(subnetId: string, nodeId: string): Promise<string> {
    const response = await this.rpc.call<{ validators?: Array<Record<string, unknown>> }>(
      this.pChainRpcUrl,
      "platform.getCurrentValidators",
      [{ subnetID: subnetId, nodeIDs: [nodeId] }],
    );
    const validator = response.validators?.find((item) => item.nodeID === nodeId) ?? response.validators?.[0];
    const validationId = validator?.validationID ?? validator?.validationId;
    if (typeof validationId !== "string" || validationId.length < 20) throw new Error("Validation ID was not returned by the P-Chain");
    return validationId;
  }

  private async waitForExpectedRpc(url: string, expectedChainId: number): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < this.attempts; attempt += 1) {
      try {
        const actual = hexQuantityToNumber(await this.rpc.call(url, "eth_chainId"), "chain ID");
        if (actual !== expectedChainId) throw new Error(`RPC chain ID ${actual} does not match ${expectedChainId}`);
        await this.blockNumber(url);
        return;
      } catch (error) { lastError = error; await delay(this.delayMs); }
    }
    throw lastError instanceof Error ? lastError : new Error("Fuji RPC did not become healthy");
  }

  private async blockNumber(url: string): Promise<number> {
    return hexQuantityToNumber(await this.rpc.call(url, "eth_blockNumber"), "block number");
  }

  private assertFuji(chain: DisposableChain): void {
    if (chain.network !== "fuji") throw new Error(`Fuji adapter refuses network ${chain.network}`);
  }
}

function requireDeployment(value: Partial<CreatedL1>): FujiDeploymentMetadata {
  const required = ["subnetId", "blockchainId", "validatorManagerAddress", "validatorId", "validatorNodeId", "rpcUrl"] as const;
  for (const key of required) if (!value[key]) throw new Error(`Fuji deployment is missing ${key}`);
  return value as FujiDeploymentMetadata;
}

function parseLabeledId(output: string, label: string): string {
  const value = parseOptionalLabeledId(output, label);
  if (!value) throw new Error(`${label} was not returned by platform-cli`);
  return value;
}

function parseOptionalLabeledId(output: string, label: string): string | undefined {
  return output.match(new RegExp(`${escapeRegExp(label)}\\s*:?\\s*([A-Za-z0-9-]{20,})`, "i"))?.[1];
}

function parseOptionalTxId(output: string): string | undefined {
  return parseOptionalLabeledId(output, "Transaction ID") ?? parseOptionalLabeledId(output, "Tx ID");
}

function parseProbeReceipt(output: string): { hash: string; block: number } {
  const receipt = JSON.parse(output) as { transactionHash?: unknown; status?: unknown; blockNumber?: unknown };
  if (receipt.status !== "0x1" || typeof receipt.transactionHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(receipt.transactionHash)) {
    throw new Error("Fuji probe transaction receipt is not a confirmed success");
  }
  return { hash: receipt.transactionHash, block: hexQuantityToNumber(receipt.blockNumber, "probe receipt block") };
}

function parseHexLabel(output: string, label: string, characters: number): string {
  const value = parseOptionalHexLabel(output, label, characters);
  if (!value) throw new Error(`${label} was not returned by platform-cli`);
  return value;
}

function parseOptionalHexLabel(output: string, label: string, characters: number): string | undefined {
  const value = output.match(new RegExp(`${escapeRegExp(label)}\\s*:?\\s*(?:0x)?([0-9a-fA-F]{${characters}})(?![0-9a-fA-F])`, "i"))?.[1];
  return value ? `0x${value}` : undefined;
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function delay(milliseconds: number) { return new Promise<void>((resolve) => setTimeout(resolve, milliseconds)); }

function commandOutput(error: unknown): string {
  if (!(error instanceof CommandError)) return "";
  return `${error.stdout}\n${error.stderr}`.toLowerCase();
}

function isAlreadyDisabled(error: unknown): boolean {
  const output = commandOutput(error);
  return output.includes("already disabled") || output.includes("validator is disabled") || output.includes("inactive validator");
}

function tcpReachable(url: string): Promise<boolean> {
  const endpoint = new URL(url);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)) throw new Error("Fuji RPC offline check requires localhost");
  const port = Number(endpoint.port || (endpoint.protocol === "https:" ? "443" : "80"));
  return new Promise((resolve) => {
    const socket = connect({ host: endpoint.hostname.replace(/^\[|\]$/g, ""), port });
    socket.setTimeout(2_000);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => { socket.destroy(); resolve(false); });
    socket.once("timeout", () => { socket.destroy(); resolve(true); });
  });
}

export async function inspectProbeFiles(keystore: string): Promise<void> {
  const repositoryRoot = resolve(import.meta.dirname, "../../..");
  const canonical = await realpath(keystore);
  const relation = relative(repositoryRoot, canonical);
  if (!relation.startsWith(`..${sep}`) && relation !== "..") throw new Error("Fuji probe secrets must be stored outside the repository");
  const metadata = await stat(canonical);
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) throw new Error("Fuji probe secret files must be regular files with owner-only permissions");
  const encrypted = JSON.parse(await readFile(keystore, "utf8")) as { crypto?: { cipher?: string; ciphertext?: string }; Crypto?: { cipher?: string; ciphertext?: string } };
  const crypto = encrypted.crypto ?? encrypted.Crypto;
  if (!crypto?.cipher || !crypto.ciphertext) throw new Error("Fuji probe keystore must be encrypted");
}

function safeSignerEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of ["PLATFORM_CLI_KEY_PASSWORD", "AVALANCHE_PRIVATE_KEY", "ETH_PASSWORD", "CAST_PASSWORD", "CAST_UNSAFE_PASSWORD", "ETH_PRIVATE_KEY", "ETH_KEYSTORE"]) delete env[name];
  return env;
}

function positiveBigInt(value: string | undefined): bigint | undefined {
  return value && /^\d+$/.test(value) && BigInt(value) > 0n ? BigInt(value) : undefined;
}
function strictPositiveBigInt(value: unknown, label: string): bigint {
  if ((typeof value !== "string" && typeof value !== "number") || !/^\d+$/.test(String(value)) || BigInt(value) < 1n) {
    throw new Error(`${label} is unavailable`);
  }
  return BigInt(value);
}
