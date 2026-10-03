import assert from "node:assert/strict";
import test from "node:test";
import type { CommandResult, CommandRunnerLike, RunOptions } from "../src/command-runner.js";
import type { DisposableChain } from "../src/domain.js";
import { CommandError, sanitizeFailure } from "../src/errors.js";
import {
  FujiAvalancheAdapter,
  type FujiAdapterOptions,
  type FujiDeploymentMetadata,
  type FujiHostingController,
  type FujiManagerBootstrap,
} from "../src/fuji-avalanche-adapter.js";

const SUBNET_ID = `2${"A".repeat(49)}`;
const BLOCKCHAIN_ID = `3${"B".repeat(49)}`;
const VALIDATION_ID = `4${"C".repeat(49)}`;
const NODE_ID = `NodeID-${"D".repeat(40)}`;
const MANAGER = `0x${"a".repeat(40)}`;
const PROBE_ADDRESS = `0x${"b".repeat(40)}`;
const PROBE_TX = `0x${"c".repeat(64)}`;

class FakeHosting implements FujiHostingController {
  stopped = false;
  createReady = true;
  stopResult: "stopped" | "already-stopped" = "stopped";
  events: string[] = [];
  async assertReady() { this.events.push("host-ready"); }
  async assertCreateReady() {
    this.events.push("host-create-ready");
    if (!this.createReady) throw new Error("FUJI_NODE_ADVERTISED_IP_MISMATCH");
  }
  async prepare(_chain: DisposableChain, _deployment: FujiDeploymentMetadata) { this.events.push("host-prepare"); }
  async stop() { this.events.push("host-stop"); this.stopped = true; return this.stopResult; }
  async isStopped() { this.events.push("host-status"); return this.stopped; }
}

class FakeManagerBootstrap implements FujiManagerBootstrap {
  events: string[] = [];
  async assertReady() { this.events.push("manager-ready"); }
  async initialize(_chain: DisposableChain, _deployment: FujiDeploymentMetadata, _node: { nodeId: string; blsPublicKey: string; blsProofOfPossession: string }, record: (step: string, phase: "pending" | "accepted" | "verified", txId?: string) => Promise<void>) {
    this.events.push("manager-initialize");
    await record("manager_initialize", "pending");
    await record("manager_initialize", "verified", PROBE_TX);
  }
}

class FakeRpc {
  blocks = [9, 10, 11];
  wrongChainId = false;
  offline = false;
  validatorInactive = false;
  pGasPrice = "1";
  pBalance = "1899991730";
  events: string[] = [];
  async call<T>(_url: string, method: string): Promise<T> {
    this.events.push(method);
    if (this.offline && method.startsWith("eth_")) throw new Error("offline");
    if (method === "platform.getCurrentValidators") return { validators: [{ nodeID: NODE_ID, validationID: VALIDATION_ID }] } as T;
    if (method === "platform.getFeeState") return { price: this.pGasPrice } as T;
    if (method === "platform.getFeeConfig") return { maxCapacity: "1000000" } as T;
    if (method === "platform.getBalance") return { balance: this.pBalance } as T;
    if (method === "platform.getL1Validator") return { balance: this.validatorInactive ? "0" : "1000000000" } as T;
    if (method === "eth_chainId") return (this.wrongChainId ? "0x2" : "0x75bcd15") as T;
    if (method === "eth_blockNumber") return `0x${(this.blocks.shift() ?? 11).toString(16)}` as T;
    throw new Error(`unexpected RPC ${method}`);
  }
}

class FakeRunner implements CommandRunnerLike {
  commands: Array<{ executable: string; args: readonly string[]; stdin?: string; operatorPasswordPrompt?: boolean }> = [];
  events: string[] = [];
  failOn?: string;
  disableAlreadyDisabled = false;
  constructor(private readonly rpc?: FakeRpc) {}
  async run(executable: string, args: readonly string[], options?: RunOptions): Promise<CommandResult> {
    const key = args.slice(0, 3).join(" ");
    this.commands.push({ executable, args: [...args], stdin: options?.stdin, operatorPasswordPrompt: options?.operatorPasswordPrompt });
    this.events.push(key);
    if (this.failOn && args.join(" ").includes(this.failOn)) throw new Error(`failed at ${this.failOn}`);
    if (args[0] === "node") return result(executable, args, `Node ID: ${NODE_ID}\nBLS Public Key: ${"1".repeat(96)}\nBLS PoP: ${"2".repeat(192)}\n`);
    if (args[0] === "subnet" && args[1] === "create") return result(executable, args, `Subnet ID: ${SUBNET_ID}\n`);
    if (args[0] === "chain") return result(executable, args, `Chain ID: ${BLOCKCHAIN_ID}\n`);
    if (args[0] === "subnet" && args[1] === "convert-to-l1") return result(executable, args, "Conversion complete\n");
    if (args[0] === "l1") {
      this.rpc!.validatorInactive = true;
      if (this.disableAlreadyDisabled) throw new CommandError(executable, args, 1, "", "validator is already disabled", false);
    }
    if (executable === "cast") {
      this.rpc?.events.push("probe-transaction");
      return result(executable, args, JSON.stringify({ transactionHash: PROBE_TX, status: "0x1", blockNumber: "0xa" }));
    }
    return result(executable, args, "ok\n");
  }
}

function result(executable: string, args: readonly string[], stdout: string): CommandResult {
  return { executable, args, exitCode: 0, stdout, stderr: "", durationMs: 1 };
}

function chain(overrides: Partial<DisposableChain> = {}): DisposableChain {
  return {
    id: "fuji", name: "THAW", internalName: "chainfuji", symbol: "THAW", network: "fuji",
    evmChainId: 123456789, createdAt: new Date(0).toISOString(), lifetimeSeconds: 300, status: "CREATING",
    ...overrides,
  };
}

function harness(overrides: Partial<FujiAdapterOptions> = {}) {
  const rpc = new FakeRpc();
  const runner = new FakeRunner(rpc);
  const hosting = new FakeHosting();
  const managerBootstrap = new FakeManagerBootstrap();
  const adapter = new FujiAvalancheAdapter({
    platformCliExecutable: "platform-cli", castExecutable: "cast", keyName: "shipfun-fuji",
    genesisPath: "/safe/genesis.json", officialGenesisSourcePath: "/safe/official-genesis.json", genesisManifestPath: "/safe/manifest.json", validatorManagerAddress: MANAGER,
    nodeAddress: "127.0.0.1:9650", rpcBaseUrl: "http://127.0.0.1:9650",
    pChainAddress: "P-fuji1emz6yxy8pqp3ww8u9z04dfr85rcwtj5zwfufsd", maxPChainGasPriceNAvax: 10n, minPChainBalanceNAvax: 100_000_000n,
    probeKeystorePath: "/safe/probe-keystore",
    probeAddress: PROBE_ADDRESS,
    interactiveSigning: true, runner, hosting, managerBootstrap, rpc, readinessAttempts: 1, readinessDelayMs: 0,
    accessFile: async () => {}, prepareGenesis: async () => "/safe/generated-genesis.json",
    readProbeAddress: async () => PROBE_ADDRESS, rpcReachable: async () => false, hasTty: true,
    readFujiWalletAddress: async () => "P-fuji1emz6yxy8pqp3ww8u9z04dfr85rcwtj5zwfufsd",
    inspectProbeFiles: async () => {}, verifyPlatformCli: async () => {}, ...overrides,
  });
  return { adapter, rpc, runner, hosting, managerBootstrap };
}

test("unverified Platform CLI fails before any Fuji mutation", async () => {
  const { adapter, runner } = harness({ verifyPlatformCli: async () => { throw new Error("FUJI_OWNER_SAFE_PLATFORM_CLI_MISMATCH"); } });
  let marked = false;
  await assert.rejects(() => adapter.createL1(chain(), async () => { marked = true; }), /FUJI_OWNER_SAFE_PLATFORM_CLI_MISMATCH/);
  assert.equal(marked, false);
  assert.equal(runner.commands.filter(({ args }) => args.includes("--key-name")).length, 0);
});

test("missing secure manager bootstrap configuration fails before the mutation marker", async () => {
  const { adapter, runner } = harness({ managerBootstrap: undefined });
  let marked = false;
  await assert.rejects(() => adapter.createL1(chain(), async () => { marked = true; }), /MANAGER_BOOTSTRAP_NOT_CONFIGURED|MANAGER_CONTRACTS_PATH_REQUIRED/);
  assert.equal(marked, false);
  assert.equal(runner.commands.filter(({ args }) => args.includes("--key-name")).length, 0);
});

test("stale advertised host IP blocks Fuji creation before the mutation marker", async () => {
  const { adapter, hosting, runner } = harness();
  hosting.createReady = false;
  let marked = false;
  await assert.rejects(() => adapter.createL1(chain(), async () => { marked = true; }), /FUJI_NODE_ADVERTISED_IP_MISMATCH/);
  assert.equal(marked, false);
  assert.equal(runner.commands.filter(({ args }) => args.includes("--key-name")).length, 0);
});

test("prepared Fuji creation reuses one genesis output and one set of wallet prompts", async () => {
  let genesisPreparations = 0;
  let probeReads = 0;
  let walletReads = 0;
  const { adapter, runner } = harness({
    prepareGenesis: async () => { genesisPreparations += 1; return "/safe/generated-genesis.json"; },
    readProbeAddress: async () => { probeReads += 1; return PROBE_ADDRESS; },
    readFujiWalletAddress: async () => { walletReads += 1; return "P-fuji1emz6yxy8pqp3ww8u9z04dfr85rcwtj5zwfufsd"; },
  });
  const prepared = await adapter.preflightCreate(chain());
  await adapter.createL1(chain(), async () => {}, undefined, prepared);
  assert.equal(genesisPreparations, 1);
  assert.equal(probeReads, 1);
  assert.equal(walletReads, 1);
  assert.equal(runner.commands.filter(({ args }) => args[0] === "node" && args[1] === "info").length, 1);
  await assert.rejects(() => adapter.createL1(chain(), async () => {}, undefined, prepared), /FUJI_CREATE_PREFLIGHT_MISMATCH/);
  await assert.rejects(() => adapter.createL1(chain({ id: "different" }), async () => {}, undefined, prepared), /FUJI_CREATE_PREFLIGHT_MISMATCH/);
});

test("persists the marker before the first Fuji mutation and collects all metadata", async () => {
  const { adapter, runner } = harness();
  let marked = false;
  const deployment = await adapter.createL1(chain(), async () => { marked = true; runner.events.push("marker"); });
  const firstMutation = runner.events.indexOf("subnet create --network");
  assert.ok(marked);
  assert.ok(runner.events.indexOf("marker") < firstMutation);
  assert.equal(deployment.subnetId, SUBNET_ID);
  assert.equal(deployment.blockchainId, BLOCKCHAIN_ID);
  assert.equal(deployment.validatorId, VALIDATION_ID);
  assert.equal(deployment.validatorNodeId, NODE_ID);
  assert.equal(deployment.latestBlock, 11);
  const conversion = runner.commands.find((command) => command.args.includes("convert-to-l1"));
  assert.equal(conversion?.args[conversion.args.indexOf("--validator-bls-public-keys") + 1], `0x${"1".repeat(96)}`);
  assert.equal(conversion?.args[conversion.args.indexOf("--validator-bls-pops") + 1], `0x${"2".repeat(192)}`);
  for (const command of runner.commands.filter((item) => item.args.includes("--key-name"))) {
    assert.equal(command.stdin, "inherit");
    assert.equal(command.operatorPasswordPrompt, true);
  }
});

test("checkpoints accepted Fuji resource IDs before the next external mutation", async () => {
  const { adapter, runner } = harness();
  const checkpoints: Array<Partial<DisposableChain>> = [];
  await adapter.createL1(chain(), async () => {}, async (update) => { checkpoints.push(structuredClone(update)); });
  const subnet = checkpoints.find((update) => update.subnetId === SUBNET_ID);
  const blockchain = checkpoints.find((update) => update.blockchainId === BLOCKCHAIN_ID);
  const validation = checkpoints.find((update) => update.validatorId === VALIDATION_ID);
  assert.ok(subnet && blockchain && validation);
  assert.ok(runner.events.indexOf("subnet create --network") < runner.events.indexOf("chain create --subnet-id"));
  assert.equal(checkpoints.at(-1)?.probeTxHash, PROBE_TX);
  assert.equal(checkpoints.at(-1)?.probeBlockAfter, 11);
});

test("configuration failure happens before the mutation marker", async () => {
  const { adapter } = harness({ interactiveSigning: false });
  let marked = false;
  await assert.rejects(() => adapter.createL1(chain(), async () => { marked = true; }), /INTERACTIVE_SIGNING_REQUIRED/);
  assert.equal(marked, false);
});

test("key name must resolve to the approved Fuji P-Chain address before mutation", async () => {
  const { adapter, runner } = harness({ readFujiWalletAddress: async () => "P-fuji1different" });
  let marked = false;
  await assert.rejects(() => adapter.createL1(chain(), async () => { marked = true; }), /P_ADDRESS_MISMATCH/);
  assert.equal(marked, false);
  assert.equal(runner.commands.filter(({ args }) => args[0] === "subnet" && args[1] === "create").length, 0);
});

test("P-Chain price and cleanup reserve are checked before any signed mutation", async () => {
  for (const kind of ["price", "reserve"] as const) {
    const { adapter, rpc, runner } = harness();
    if (kind === "price") rpc.pGasPrice = "11";
    else rpc.pBalance = "100000000";
    let marked = false;
    await assert.rejects(() => adapter.createL1(chain(), async () => { marked = true; }), /GAS_PRICE_EXCEEDS|RESERVE_INSUFFICIENT/);
    assert.equal(marked, false);
    assert.equal(runner.commands.filter(({ args }) => args.includes("--key-name")).length, 0);
  }
});

test("Fuji preflight includes the validator conversion deposit in its wallet budget", async () => {
  const { adapter, rpc, runner } = harness();
  rpc.pBalance = "200000000";
  await assert.rejects(() => adapter.preflightCreate(chain()), /FUJI_P_CHAIN_CLEANUP_RESERVE_INSUFFICIENT/);
  assert.equal(runner.commands.filter(({ args }) => args[0] === "subnet" && args[1] === "create").length, 0);
});

test("P-Chain fee spike after subnet creation aborts before chain creation", async () => {
  const { adapter, rpc, runner } = harness();
  const originalRun = runner.run.bind(runner);
  runner.run = async (...args) => {
    const output = await originalRun(...args);
    if (args[1][0] === "subnet" && args[1][1] === "create") rpc.pGasPrice = "11";
    return output;
  };
  const error = await adapter.createL1(chain(), async () => {}).catch((failure: unknown) => failure);
  assert.match((error as Error).message, /GAS_PRICE_EXCEEDS/);
  assert.equal((error as Error & { deployment: { subnetId: string } }).deployment.subnetId, SUBNET_ID);
  assert.ok(!runner.commands.some(({ args }) => args[0] === "chain" && args[1] === "create"));
});

test("missing operator TTY and unsafe probe artifacts fail before the mutation marker", async () => {
  for (const overrides of [{ hasTty: false }, { inspectProbeFiles: async () => { throw new Error("unsafe probe files"); } }]) {
    const { adapter, runner } = harness(overrides);
    let marked = false;
    await assert.rejects(() => adapter.createL1(chain(), async () => { marked = true; }), /TTY_REQUIRED|unsafe probe files/);
    assert.equal(marked, false);
    assert.equal(runner.commands.filter(({ args }) => args.includes("--key-name")).length, 0);
  }
});

test("post-mutation failure retains partial deployment metadata", async () => {
  const { adapter, runner } = harness();
  runner.failOn = "chain create";
  const error = await adapter.createL1(chain(), async () => {}).catch((failure: unknown) => failure);
  assert.ok(error instanceof Error);
  assert.deepEqual((error as Error & { deployment: object }).deployment, {
    validatorManagerAddress: MANAGER, validatorNodeId: NODE_ID, subnetId: SUBNET_ID,
  });
  assert.equal((error as Error & { requiresRecovery: boolean }).requiresRecovery, true);
});

test("rejects an RPC chain ID mismatch after retaining deployment metadata", async () => {
  const { adapter, rpc } = harness();
  rpc.wrongChainId = true;
  const error = await adapter.createL1(chain(), async () => {}).catch((failure: unknown) => failure);
  assert.match((error as Error).message, /does not match/);
  assert.equal((error as Error & { deployment: { blockchainId: string } }).deployment.blockchainId, BLOCKCHAIN_ID);
});

test("a confirmed transaction without block growth cannot become LIVE", async () => {
  const { adapter, rpc } = harness();
  rpc.blocks = [9, 10, 10];
  await assert.rejects(() => adapter.createL1(chain(), async () => {}), /without block growth/);
});

test("expiration accepts already-disabled validator and already-stopped hosting", async () => {
  const { adapter, runner, rpc, hosting } = harness();
  runner.disableAlreadyDisabled = true;
  hosting.createReady = false;
  hosting.stopResult = "already-stopped";
  rpc.offline = true;
  await adapter.expireL1(chain({ status: "EXPIRING", validatorId: VALIDATION_ID, rpcUrl: "http://127.0.0.1/rpc" }));
  assert.equal(hosting.stopped, true);
  assert.ok(!hosting.events.includes("host-create-ready"));
});

test("expiration verifies RPC offline only after validator and hosting cleanup", async () => {
  const { adapter, runner, rpc, hosting } = harness();
  const order: string[] = [];
  const originalRun = runner.run.bind(runner);
  runner.run = async (...args) => { if (args[1][0] === "l1") order.push("disable"); return originalRun(...args); };
  hosting.stop = async () => { order.push("stop"); hosting.stopped = true; rpc.offline = true; return "stopped"; };
  hosting.isStopped = async () => { order.push("host-status"); return true; };
  const originalCall = rpc.call.bind(rpc);
  rpc.call = async <T>(...args: Parameters<typeof originalCall>) => { order.push(args[1]); return originalCall<T>(...args); };
  await adapter.expireL1(chain({ status: "EXPIRING", validatorId: VALIDATION_ID, rpcUrl: "http://127.0.0.1/rpc" }));
  assert.ok(order.indexOf("platform.getL1Validator") < order.indexOf("disable"));
  assert.ok(order.lastIndexOf("platform.getL1Validator") > order.indexOf("disable"));
  assert.ok(order.lastIndexOf("platform.getL1Validator") < order.indexOf("stop"));
  assert.ok(order.indexOf("stop") < order.indexOf("host-status"));
});

test("unresolved cleanup is marked recovery-required", async () => {
  const { adapter, hosting } = harness();
  hosting.stop = async () => { throw new Error("host control unavailable"); };
  const error = await adapter.expireL1(chain({ status: "EXPIRING", validatorId: VALIDATION_ID })).catch((failure: unknown) => failure);
  assert.equal((error as Error & { requiresRecovery: boolean }).requiresRecovery, true);
});

test("cleanup cannot report success while P-Chain validator stays active", async () => {
  const { adapter, rpc, hosting, runner } = harness();
  runner.run = async (executable, args) => result(executable, args, "disable submitted");
  rpc.validatorInactive = false;
  const error = await adapter.expireL1(chain({ status: "EXPIRING", validatorId: VALIDATION_ID, rpcUrl: "http://127.0.0.1/rpc" })).catch((failure: unknown) => failure);
  assert.equal((error as Error & { requiresRecovery: boolean }).requiresRecovery, true);
  assert.match((error as Error).message, /did not confirm validator inactive/);
  assert.equal(hosting.stopped, false);
});

test("cleanup cannot report success while RPC remains TCP-reachable", async () => {
  const { adapter, hosting } = harness({ rpcReachable: async () => true });
  const error = await adapter.expireL1(chain({ status: "EXPIRING", validatorId: VALIDATION_ID, rpcUrl: "http://127.0.0.1/rpc" })).catch((failure: unknown) => failure);
  assert.equal((error as Error & { requiresRecovery: boolean }).requiresRecovery, true);
  assert.equal(hosting.stopped, true);
  assert.match((error as Error).message, /remained online/);
});

test("Fuji commands use literal argv and never include raw signing secrets", async () => {
  const { adapter, runner } = harness();
  await adapter.createL1(chain({ internalName: "literal-name" }), async () => {});
  assert.ok(runner.commands.every((command) => !command.args.some((argument) => argument.includes("private-key") || argument.includes("mnemonic"))));
  assert.ok(runner.commands.every((command) => !command.args.includes("--password-file")));
  assert.ok(runner.commands.some((command) => command.executable === "cast" && command.stdin === "inherit" && command.operatorPasswordPrompt));
});

test("failure sanitization removes password, seed and private-key material", () => {
  const secret = `0x${"f".repeat(64)}`;
  const sanitized = sanitizeFailure(new Error(`password=hunter2 seed: words private_key: ${secret}`));
  assert.doesNotMatch(sanitized, /hunter2|words|f{16}/);
});

test("Fuji adapter errors do not expose signing secrets", async () => {
  const { adapter, runner } = harness();
  runner.run = async (_executable, args) => {
    if (args[0] === "node") return result("platform-cli", args, `Node ID: ${NODE_ID}\nBLS Public Key: 0x${"1".repeat(96)}\nBLS PoP: 0x${"2".repeat(192)}\n`);
    throw new Error("password=hunter2");
  };
  const error = await adapter.createL1(chain(), async () => {}).catch((failure: unknown) => failure);
  assert.doesNotMatch((error as Error).message, /hunter2/);
  assert.match((error as Error).message, /redacted/);
});
