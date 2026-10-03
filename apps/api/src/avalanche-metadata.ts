import { readFile } from "node:fs/promises";
import type { CreatedL1 } from "./domain.js";

const AVALANCHE_ID = /^[1-9A-HJ-NP-Za-km-z]{40,60}$/;
const NODE_ID = /^NodeID-[1-9A-HJ-NP-Za-km-z]{30,60}$/;
const ADDRESS = /^0x[a-fA-F0-9]{40}$/;

interface SidecarNetwork {
  SubnetID?: unknown;
  BlockchainID?: unknown;
  RPCEndpoints?: unknown;
  ValidatorManagerAddress?: unknown;
  BootstrapValidators?: unknown;
}

export async function parseLocalDeployment(sidecarPath: string, genesisPath: string, expectedChainId: number): Promise<CreatedL1> {
  const [sidecarRaw, genesisRaw] = await Promise.all([readFile(sidecarPath, "utf8"), readFile(genesisPath, "utf8")]);
  const sidecar = JSON.parse(sidecarRaw) as { Networks?: Record<string, SidecarNetwork> };
  const genesis = JSON.parse(genesisRaw) as { config?: { chainId?: unknown } };
  const network = sidecar.Networks?.["Local Network"];
  if (!network) throw new Error("Avalanche sidecar has no Local Network deployment");
  if (genesis.config?.chainId !== expectedChainId) throw new Error("Avalanche genesis chain ID does not match allocated EVM chain ID");
  const subnetId = stringMatching(network.SubnetID, AVALANCHE_ID, "Subnet ID");
  const blockchainId = stringMatching(network.BlockchainID, AVALANCHE_ID, "Blockchain ID");
  if (!Array.isArray(network.RPCEndpoints) || network.RPCEndpoints.length === 0) throw new Error("Avalanche sidecar has no RPC endpoint");
  const rpcUrl = stringMatching(network.RPCEndpoints[0], /^http:\/\/127\.0\.0\.1:\d+\/ext\/bc\/[1-9A-HJ-NP-Za-km-z]{40,60}\/rpc$/, "Local RPC URL");
  if (!rpcUrl.includes(`/ext/bc/${blockchainId}/rpc`)) throw new Error("Avalanche RPC URL does not contain the parsed Blockchain ID");
  const validators = Array.isArray(network.BootstrapValidators) ? network.BootstrapValidators as Record<string, unknown>[] : [];
  const validator = validators[0];
  const validatorId = validator?.ValidationID === undefined ? undefined : stringMatching(validator.ValidationID, AVALANCHE_ID, "Validation ID");
  const validatorNodeId = validator?.NodeID === undefined ? undefined : stringMatching(validator.NodeID, NODE_ID, "Validator Node ID");
  const validatorManagerAddress = network.ValidatorManagerAddress === undefined || network.ValidatorManagerAddress === ""
    ? undefined
    : stringMatching(network.ValidatorManagerAddress, ADDRESS, "Validator Manager address");
  return { subnetId, blockchainId, rpcUrl, validatorId, validatorNodeId, validatorManagerAddress, latestBlock: 0 };
}

function stringMatching(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`invalid ${label} in Avalanche metadata`);
  return value;
}
