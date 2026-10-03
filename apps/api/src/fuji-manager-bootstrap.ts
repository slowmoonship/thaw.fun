import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { CommandRunnerLike, CommandResult } from "./command-runner.js";
import { CommandRunner } from "./command-runner.js";
import { conversionData, conversionUnsignedWarpMessage, decodeAvalancheId, warpPredicateAccessList } from "./fuji-conversion.js";
import type { DisposableChain } from "./domain.js";
import type { FujiDeploymentMetadata, FujiManagerBootstrap, FujiNodeIdentity } from "./fuji-avalanche-adapter.js";

const PINNED_ICM_COMMIT = "0b68b03c906d17850712b49aa20f2dc18ed55568";
const PINNED_SOLC_SHA256 = "cc3f94a70ac681b0304084acc1980aabe2a1bb3240d44ce76a8df0e1e77a2110";
const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const PROXY_ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const INITIAL_VALIDATOR_WEIGHT = 100n;

interface RpcClient { call<T>(url: string, method: string, params?: unknown[]): Promise<T>; }
type RecordStep = (step: string, phase: "pending" | "accepted" | "verified", txId?: string) => Promise<void>;

export interface FoundryFujiManagerOptions {
  contractsPath: string;
  signatureAggregatorUrl: string;
  keystorePath: string;
  signerAddress: string;
  pChainRpcUrl: string;
  castExecutable: string;
  forgeExecutable: string;
  compilerPath: string;
  runner?: CommandRunnerLike;
  rpc: RpcClient;
  fetchSignature?: (url: string, body: object) => Promise<string>;
}

export class FoundryFujiManagerBootstrap implements FujiManagerBootstrap {
  private readonly runner: CommandRunnerLike;
  private readonly fetchSignature: (url: string, body: object) => Promise<string>;

  constructor(private readonly options: FoundryFujiManagerOptions) {
    this.runner = options.runner ?? new CommandRunner();
    this.fetchSignature = options.fetchSignature ?? requestSignature;
  }

  async assertReady(): Promise<void> {
    const o = this.options;
    if (!o.contractsPath || !isAbsolute(o.contractsPath)) throw new Error("FUJI_MANAGER_CONTRACTS_PATH_REQUIRED");
    if (!o.compilerPath || !isAbsolute(o.compilerPath)) throw new Error("FUJI_PINNED_SOLC_PATH_REQUIRED");
    if (!o.keystorePath || !isAbsolute(o.keystorePath) || !/^0x[0-9a-fA-F]{40}$/.test(o.signerAddress)) throw new Error("FUJI_MANAGER_ENCRYPTED_SIGNER_REQUIRED");
    const endpoint = new URL(o.signatureAggregatorUrl);
    if (endpoint.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)) {
      throw new Error("FUJI_LOCAL_SIGNATURE_AGGREGATOR_REQUIRED");
    }
    const source = await this.runner.run("git", ["-C", o.contractsPath, "rev-parse", "HEAD"], { timeoutMs: 10_000 });
    if (source.stdout.trim() !== PINNED_ICM_COMMIT) throw new Error("FUJI_MANAGER_SOURCE_COMMIT_MISMATCH");
    const compilerSha256 = createHash("sha256").update(await readFile(o.compilerPath)).digest("hex");
    if (compilerSha256 !== PINNED_SOLC_SHA256) throw new Error("FUJI_PINNED_SOLC_SHA256_MISMATCH");
    await this.runner.run(o.forgeExecutable, ["build", "--offline", "--root", o.contractsPath, "--use", o.compilerPath], {
      timeoutMs: 180_000, cwd: o.contractsPath, env: signerEnvironment(),
    });
    try {
      const healthResponse = await fetch(new URL("/health", endpoint), { signal: AbortSignal.timeout(5_000) });
      const health = await healthResponse.json() as { status?: unknown };
      if (!healthResponse.ok || health.status !== "up") throw new Error("unhealthy");
    } catch {
      throw new Error("FUJI_LOCAL_SIGNATURE_AGGREGATOR_NOT_READY");
    }
  }

  async initialize(
    _chain: DisposableChain,
    deployment: FujiDeploymentMetadata,
    node: FujiNodeIdentity,
    record: RecordStep,
    checkpoint?: (update: Partial<DisposableChain>) => Promise<void>,
  ): Promise<void> {
    const o = this.options;
    const subnet = await o.rpc.call<{ conversionID?: string; managerChainID?: string; managerAddress?: string }>(
      o.pChainRpcUrl, "platform.getSubnet", [{ subnetID: deployment.subnetId }],
    );
    if (!subnet.conversionID || !subnet.managerChainID || !subnet.managerAddress) throw new Error("P-Chain conversion metadata is incomplete");
    if (!decodeAvalancheId(subnet.managerChainID).equals(decodeAvalancheId(deployment.blockchainId))) throw new Error("P-Chain manager chain ID mismatch");
    if (subnet.managerAddress.toLowerCase() !== deployment.validatorManagerAddress.toLowerCase()) throw new Error("P-Chain manager address mismatch");
    const conversion = conversionData({
      subnetId: deployment.subnetId, blockchainId: deployment.blockchainId,
      managerAddress: deployment.validatorManagerAddress, nodeId: node.nodeId,
      blsPublicKey: node.blsPublicKey, weight: INITIAL_VALIDATOR_WEIGHT,
    });
    if (!decodeAvalancheId(subnet.conversionID).equals(decodeAvalancheId(conversion.conversionId))) {
      throw new Error("P-Chain conversion ID does not match the exact initial validator tuple");
    }
    const current = await o.rpc.call<{ validators?: Array<{ nodeID?: string; weight?: string }> }>(
      o.pChainRpcUrl, "platform.getCurrentValidators", [{ subnetID: deployment.subnetId, nodeIDs: [node.nodeId] }],
    );
    if (current.validators?.length !== 1 || current.validators[0]?.nodeID !== node.nodeId || BigInt(current.validators[0]?.weight ?? -1) !== INITIAL_VALIDATOR_WEIGHT) {
      throw new Error("P-Chain initial validator identity or weight mismatch");
    }
    await checkpoint?.({ conversionId: conversion.conversionId });

    const library = await this.deploy("manager_deploy_library", "contracts/validator-manager/ValidatorMessages.sol:ValidatorMessages", [], deployment.rpcUrl, record);
    await checkpoint?.({ managerLibraryAddress: library });
    const implementation = await this.deploy("manager_deploy_implementation", "contracts/validator-manager/ValidatorManager.sol:ValidatorManager", [
      `--libraries=contracts/validator-manager/ValidatorMessages.sol:ValidatorMessages:${library}`, "--constructor-args", "0",
    ], deployment.rpcUrl, record);
    await checkpoint?.({ managerImplementationAddress: implementation });

    const adminWord = await o.rpc.call<string>(deployment.rpcUrl, "eth_getStorageAt", [deployment.validatorManagerAddress, PROXY_ADMIN_SLOT, "latest"]);
    const admin = storageAddress(adminWord);
    if (!admin || admin === "0x0000000000000000000000000000000000000000") throw new Error("ValidatorManager ProxyAdmin slot is empty");
    await this.requireAddressCall(deployment.rpcUrl, admin, "owner()(address)", o.signerAddress);
    const upgradeTx = await this.send("manager_upgrade", deployment.rpcUrl, admin, "upgrade(address,address)", [deployment.validatorManagerAddress, implementation], record);
    const implWord = await o.rpc.call<string>(deployment.rpcUrl, "eth_getStorageAt", [deployment.validatorManagerAddress, IMPLEMENTATION_SLOT, "latest"]);
    if (storageAddress(implWord)?.toLowerCase() !== implementation.toLowerCase()) throw new Error("ValidatorManager proxy upgrade did not change implementation slot");
    await record("manager_upgrade", "verified", upgradeTx);

    const subnetHex = `0x${decodeAvalancheId(deployment.subnetId).toString("hex")}`;
    const settingsTx = await this.send("manager_initialize", deployment.rpcUrl, deployment.validatorManagerAddress,
      "initialize((address,bytes32,uint64,uint8))", [`(${o.signerAddress},${subnetHex},0,20)`], record);
    await this.requireAddressCall(deployment.rpcUrl, deployment.validatorManagerAddress, "owner()(address)", o.signerAddress);
    await this.requireValueCall(deployment.rpcUrl, deployment.validatorManagerAddress, "subnetID()(bytes32)", subnetHex);
    await record("manager_initialize", "verified", settingsTx);

    const poa = await this.deploy("manager_deploy_poa", "contracts/validator-manager/PoAManager.sol:PoAManager", [
      "--constructor-args", o.signerAddress, deployment.validatorManagerAddress,
    ], deployment.rpcUrl, record);
    await checkpoint?.({ managerPoaAddress: poa });
    await this.requireAddressCall(deployment.rpcUrl, poa, "owner()(address)", o.signerAddress);

    // The P-Chain signs this public conversion payload; the local aggregator handles only
    // public BLS signatures. A timeout or mismatch leaves the record recovery-blocking.
    const unsigned = conversionUnsignedWarpMessage(deployment.subnetId, conversion.conversionId);
    const subnetIdHex = `0x${decodeAvalancheId(deployment.subnetId).toString("hex")}`;
    const signed = await this.fetchSignature(`${o.signatureAggregatorUrl.replace(/\/$/, "")}/aggregate-signatures`, {
      message: unsigned.toString("hex"), justification: subnetIdHex,
      "signing-subnet-id": subnetIdHex, "quorum-percentage": 67,
    });
    const accessList = warpPredicateAccessList(unsigned, signed);
    const validatorSetTx = await this.send("manager_validator_set", deployment.rpcUrl, deployment.validatorManagerAddress,
      "initializeValidatorSet((bytes32,bytes32,address,(bytes,bytes,uint64)[]),uint32)", [conversion.castTuple, "0"], record,
      ["--access-list", accessList]);
    await this.requireValueCall(deployment.rpcUrl, deployment.validatorManagerAddress, "isValidatorSetInitialized()(bool)", "true");
    await this.requireValueCall(deployment.rpcUrl, deployment.validatorManagerAddress, "l1TotalWeight()(uint64)", String(INITIAL_VALIDATOR_WEIGHT));
    await record("manager_validator_set", "verified", validatorSetTx);

    const authorityTx = await this.send("manager_authority", deployment.rpcUrl, deployment.validatorManagerAddress,
      "transferOwnership(address)", [poa], record);
    await this.requireAddressCall(deployment.rpcUrl, deployment.validatorManagerAddress, "owner()(address)", poa);
    await record("manager_authority", "verified", authorityTx);
  }

  private async deploy(step: string, contract: string, extra: string[], rpcUrl: string, record: RecordStep): Promise<string> {
    await record(step, "pending");
    const result = await this.runner.run(this.options.forgeExecutable, [
      "create", "--broadcast", "--offline", "--root", this.options.contractsPath,
      "--use", this.options.compilerPath,
      "--rpc-url", rpcUrl, "--keystore", this.options.keystorePath, "--json", contract, ...extra,
    ], { cwd: this.options.contractsPath, timeoutMs: 240_000, stdin: "inherit", operatorPasswordPrompt: true, redactFailureOutput: true, env: signerEnvironment() });
    const receipt = parseJsonResult(result);
    const address = receipt.deployedTo;
    const hash = receipt.transactionHash;
    if (!isAddress(address) || !isHash(hash)) throw new Error(`${step} did not return deployed address and transaction hash`);
    await record(step, "accepted", hash);
    const code = await this.options.rpc.call<string>(rpcUrl, "eth_getCode", [address, "latest"]);
    if (!/^0x[0-9a-fA-F]{2,}$/.test(code) || code === "0x00") throw new Error(`${step} deployment code was not confirmed`);
    await record(step, "verified", hash);
    return address;
  }

  private async send(step: string, rpcUrl: string, to: string, signature: string, values: string[], record: RecordStep, extra: string[] = []): Promise<string> {
    await record(step, "pending");
    const result = await this.runner.run(this.options.castExecutable, [
      "send", "--rpc-url", rpcUrl, "--keystore", this.options.keystorePath, "--json", ...extra,
      to, signature, ...values,
    ], { timeoutMs: 180_000, stdin: "inherit", operatorPasswordPrompt: true, redactFailureOutput: true, env: signerEnvironment() });
    const receipt = parseJsonResult(result);
    if (!isHash(receipt.transactionHash)) throw new Error(`${step} did not return a transaction hash`);
    await record(step, "accepted", receipt.transactionHash);
    if (receipt.status !== "0x1" && receipt.status !== "1") throw new Error(`${step} transaction receipt was not successful`);
    return receipt.transactionHash;
  }

  private async requireAddressCall(rpcUrl: string, to: string, signature: string, expected: string): Promise<void> {
    const result = await this.runner.run(this.options.castExecutable, ["call", "--rpc-url", rpcUrl, to, signature], { timeoutMs: 30_000 });
    if (result.stdout.trim().toLowerCase() !== expected.toLowerCase()) throw new Error(`${signature} does not match expected public address`);
  }

  private async requireValueCall(rpcUrl: string, to: string, signature: string, expected: string): Promise<void> {
    const result = await this.runner.run(this.options.castExecutable, ["call", "--rpc-url", rpcUrl, to, signature], { timeoutMs: 30_000 });
    if (result.stdout.trim().toLowerCase() !== expected.toLowerCase()) throw new Error(`${signature} does not match expected value`);
  }
}

function signerEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of ["PLATFORM_CLI_KEY_PASSWORD", "AVALANCHE_PRIVATE_KEY", "ETH_PASSWORD", "CAST_PASSWORD", "CAST_UNSAFE_PASSWORD", "ETH_PRIVATE_KEY", "ETH_KEYSTORE"]) delete env[name];
  return env;
}

function storageAddress(word: string): string | undefined {
  return /^0x[0-9a-fA-F]{64}$/.test(word) ? `0x${word.slice(-40)}` : undefined;
}
function isAddress(value: unknown): value is string { return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value); }
function isHash(value: unknown): value is string { return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value); }
function parseJsonResult(result: CommandResult): Record<string, string> {
  try { return JSON.parse(result.stdout.trim()) as Record<string, string>; }
  catch { throw new Error("Foundry signing command did not return parseable JSON"); }
}

async function requestSignature(url: string, body: object): Promise<string> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`local signature aggregator HTTP ${response.status}`);
  const payload = await response.json() as { "signed-message"?: unknown };
  if (typeof payload["signed-message"] !== "string") throw new Error("local signature aggregator returned no signed message");
  return payload["signed-message"].startsWith("0x") ? payload["signed-message"] : `0x${payload["signed-message"]}`;
}
