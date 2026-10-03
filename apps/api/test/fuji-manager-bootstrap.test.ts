import assert from "node:assert/strict";
import test from "node:test";
import type { CommandResult, CommandRunnerLike, RunOptions } from "../src/command-runner.js";
import { conversionData } from "../src/fuji-conversion.js";
import { hasUnresolvedFujiMutation, type DisposableChain } from "../src/domain.js";
import { FoundryFujiManagerBootstrap } from "../src/fuji-manager-bootstrap.js";

const subnetId = `0x${"1".repeat(64)}`;
const blockchainId = `0x${"2".repeat(64)}`;
const manager = "0xfacade0000000000000000000000000000000000";
const admin = `0x${"a".repeat(40)}`;
const signer = `0x${"b".repeat(40)}`;
const library = `0x${"c".repeat(40)}`;
const implementation = `0x${"d".repeat(40)}`;
const poa = `0x${"e".repeat(40)}`;
const node = { nodeId: "NodeID-GGU7pZzHKHkC4DuXU7RgihBd4ubvvrwKs", blsPublicKey: `0x${"f".repeat(96)}`, blsProofOfPossession: `0x${"1".repeat(192)}` };
const conversion = conversionData({ subnetId, blockchainId, managerAddress: manager, nodeId: node.nodeId, blsPublicKey: node.blsPublicKey, weight: 100n });
const adminSlot = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const word = (address: string) => `0x${"0".repeat(24)}${address.slice(2)}`;
const tx = (index: number) => `0x${index.toString(16).padStart(64, "0")}`;

class ManagerRunner implements CommandRunnerLike {
  commands: Array<{ executable: string; args: readonly string[]; options?: RunOptions }> = [];
  owner = signer;
  poaOwner = signer;
  initialized = false;
  nextTx = 1;
  async run(executable: string, args: readonly string[], options?: RunOptions): Promise<CommandResult> {
    this.commands.push({ executable, args: [...args], options });
    let stdout = "";
    if (args[0] === "create") {
      const contract = args.find((arg) => arg.includes(".sol:"));
      const deployedTo = contract?.includes("ValidatorMessages") ? library : contract?.includes("PoAManager") ? poa : implementation;
      stdout = JSON.stringify({ deployedTo, transactionHash: tx(this.nextTx++) });
    } else if (args[0] === "send") {
      if (args.includes("initializeValidatorSet((bytes32,bytes32,address,(bytes,bytes,uint64)[]),uint32)")) this.initialized = true;
      if (args.includes("transferOwnership(address)")) this.owner = poa;
      stdout = JSON.stringify({ transactionHash: tx(this.nextTx++), status: "0x1" });
    } else if (args[0] === "call") {
      const target = args.find((arg) => /^0x[0-9a-fA-F]{40}$/.test(arg));
      const signature = args.at(-1);
      stdout = signature === "owner()(address)" ? `${target === poa ? this.poaOwner : this.owner}\n`
        : signature === "subnetID()(bytes32)" ? `${subnetId}\n`
          : signature === "isValidatorSetInitialized()(bool)" ? `${this.initialized}\n`
            : signature === "l1TotalWeight()(uint64)" ? "100\n" : "unexpected";
    }
    return { executable, args, exitCode: 0, stdout, stderr: "", durationMs: 1 };
  }
}

function harness(overrides: { conversionId?: string; signedMessage?: string; wrongImplementation?: boolean } = {}) {
  const runner = new ManagerRunner();
  const rpc = { async call<T>(_url: string, method: string, params: unknown[] = []): Promise<T> {
    if (method === "platform.getSubnet") return { conversionID: overrides.conversionId ?? conversion.conversionId, managerChainID: blockchainId, managerAddress: manager } as T;
    if (method === "platform.getCurrentValidators") return { validators: [{ nodeID: node.nodeId, weight: "100" }] } as T;
    if (method === "eth_getCode") return "0x6001" as T;
    if (method === "eth_getStorageAt") return word(params[1] === adminSlot ? admin : overrides.wrongImplementation ? library : implementation) as T;
    throw new Error(`unexpected RPC ${method}`);
  } };
  const bootstrap = new FoundryFujiManagerBootstrap({
    contractsPath: "/public/icm-contracts", signatureAggregatorUrl: "http://127.0.0.1:18080",
    keystorePath: "/outside-repository/encrypted-keystore", signerAddress: signer,
    pChainRpcUrl: "https://api.avax-test.network/ext/bc/P", castExecutable: "cast", forgeExecutable: "forge",
    compilerPath: "/public/solc", runner, rpc,
    fetchSignature: async (_url, body) => overrides.signedMessage ?? `0x${String(body.message)}000000000000000101${"0".repeat(192)}`,
  });
  const chain: DisposableChain = { id: "fuji", name: "Thaw", internalName: "chainthaw", symbol: "THAW", network: "fuji", evmChainId: 123, createdAt: new Date(0).toISOString(), lifetimeSeconds: 300, status: "CREATING" };
  const deployment = { subnetId, blockchainId, validatorManagerAddress: manager, validatorId: `0x${"3".repeat(64)}`, validatorNodeId: node.nodeId, rpcUrl: "http://127.0.0.1:9650/ext/bc/chain/rpc" };
  return { bootstrap, runner, chain, deployment };
}

test("manager bootstrap journals every external L1 transaction and verifies authority before LIVE", async () => {
  const { bootstrap, runner, chain, deployment } = harness();
  const journal: NonNullable<DisposableChain["fujiJournal"]> = [];
  const metadata: Partial<DisposableChain> = {};
  await bootstrap.initialize(chain, deployment, node,
    async (step, phase, txId) => { journal.push({ step, phase, txId, at: new Date(0).toISOString() }); },
    async (update) => { Object.assign(metadata, update); });
  const sends = runner.commands.filter(({ args }) => args[0] === "send");
  const deploys = runner.commands.filter(({ args }) => args[0] === "create");
  assert.equal(sends.length, 4);
  assert.equal(deploys.length, 3);
  assert.deepEqual(deploys.map(({ args }) => args.includes("--keystore")), [true, true, true]);
  assert.ok(sends.every(({ args, options }) => args.includes("--keystore") && !args.includes("--private-key") && options?.stdin === "inherit" && options.operatorPasswordPrompt));
  assert.ok(deploys.every(({ options }) => options?.operatorPasswordPrompt === true));
  assert.equal(metadata.conversionId, conversion.conversionId);
  assert.equal(metadata.managerImplementationAddress, implementation);
  assert.equal(metadata.managerPoaAddress, poa);
  const initialSet = sends.find(({ args }) => args.includes("initializeValidatorSet((bytes32,bytes32,address,(bytes,bytes,uint64)[]),uint32)"));
  assert.ok(initialSet?.args.includes("--access-list"));
  assert.equal(journal.filter((event) => event.phase === "pending").length, 7);
  assert.equal(journal.filter((event) => event.phase === "verified").length, 7);
  assert.equal(hasUnresolvedFujiMutation({ ...chain, fujiJournal: journal }), false);
});

test("conversion mismatch fails before any L1 transaction", async () => {
  const { bootstrap, runner, chain, deployment } = harness({ conversionId: `0x${"4".repeat(64)}` });
  await assert.rejects(() => bootstrap.initialize(chain, deployment, node, async () => {}), /conversion ID does not match/);
  assert.equal(runner.commands.filter(({ args }) => args[0] === "create" || args[0] === "send").length, 0);
});

test("bad Warp signature blocks initialization and retains a recoverable partial manager", async () => {
  const { bootstrap, chain, deployment } = harness({ signedMessage: `0x${"0".repeat(500)}` });
  const journal: NonNullable<DisposableChain["fujiJournal"]> = [];
  await assert.rejects(() => bootstrap.initialize(chain, deployment, node,
    async (step, phase, txId) => { journal.push({ step, phase, txId, at: new Date(0).toISOString() }); }), /does not match/);
  assert.ok(journal.some((event) => event.step === "manager_deploy_poa" && event.phase === "verified"));
  assert.ok(!journal.some((event) => event.step === "manager_validator_set" && event.phase === "pending"));
});

test("accepted proxy upgrade without matching storage remains unresolved for manual recovery", async () => {
  const { bootstrap, chain, deployment } = harness({ wrongImplementation: true });
  const journal: NonNullable<DisposableChain["fujiJournal"]> = [];
  await assert.rejects(() => bootstrap.initialize(chain, deployment, node,
    async (step, phase, txId) => { journal.push({ step, phase, txId, at: new Date(0).toISOString() }); }), /did not change implementation slot/);
  assert.ok(journal.some((event) => event.step === "manager_upgrade" && event.phase === "accepted"));
  assert.ok(!journal.some((event) => event.step === "manager_upgrade" && event.phase === "verified"));
  assert.equal(hasUnresolvedFujiMutation({ ...chain, fujiJournal: journal }), true);
});
