export type ChainNetwork = "local" | "fuji" | "mainnet";
export type ChainStatus = "CREATING" | "LIVE" | "EXPIRING" | "DEAD" | "FAILED";

export interface DisposableChain {
  id: string;
  name: string;
  internalName: string;
  symbol: string;
  network: ChainNetwork;
  evmChainId: number;
  createdAt: string;
  expiresAt?: string;
  expiredAt?: string;
  lifetimeSeconds: number;
  status: ChainStatus;
  subnetId?: string;
  blockchainId?: string;
  validatorManagerAddress?: string;
  validatorId?: string;
  validatorNodeId?: string;
  conversionId?: string;
  managerLibraryAddress?: string;
  managerImplementationAddress?: string;
  managerPoaAddress?: string;
  rpcUrl?: string;
  latestBlock?: number;
  finalBlock?: number;
  failureReason?: string;
  requiresRecovery?: boolean;
  fujiJournal?: Array<{ step: string; phase: "pending" | "accepted" | "verified"; txId?: string; at: string }>;
  probeTxHash?: string;
  probeReceiptBlock?: number;
  probeBlockBefore?: number;
  probeBlockAfter?: number;
}

const FUJI_EXTERNAL_STEPS = new Set([
  "subnet_create", "chain_create", "convert_to_l1", "manager_deploy_library", "manager_deploy_implementation",
  "manager_deploy_poa", "manager_upgrade", "manager_initialize", "manager_authority",
  "manager_validator_set", "block_probe", "validator_disable",
]);

export function hasUnresolvedFujiMutation(chain: DisposableChain): boolean {
  const pending = new Set<string>();
  for (const event of chain.fujiJournal ?? []) {
    if (!FUJI_EXTERNAL_STEPS.has(event.step)) continue;
    if (event.phase === "pending") pending.add(event.step);
    else if (event.phase === "verified" || (event.phase === "accepted" && !event.step.startsWith("manager_"))) pending.delete(event.step);
  }
  return pending.size > 0;
}

export interface ChainView extends DisposableChain {
  remainingSeconds: number;
  rpcHealthy: boolean;
  canContinueExpiration?: boolean;
}

export interface CreateChainInput {
  name: string;
  symbol: string;
  lifetimeSeconds: number;
}

export interface CreatedL1 {
  subnetId: string;
  blockchainId: string;
  rpcUrl: string;
  validatorManagerAddress?: string;
  validatorId?: string;
  validatorNodeId?: string;
  latestBlock: number;
}

export interface AvalancheAdapter {
  preflightCreate?(chain: DisposableChain): Promise<unknown>;
  createL1(chain: DisposableChain, markExternalMutationStarted?: () => Promise<void>, checkpoint?: (update: Partial<DisposableChain>) => Promise<void>, preparation?: unknown): Promise<CreatedL1>;
  getBlockNumber(chain: DisposableChain): Promise<number>;
  isRpcHealthy(chain: DisposableChain): Promise<boolean>;
  expireL1(chain: DisposableChain, checkpoint?: (update: Partial<DisposableChain>) => Promise<void>): Promise<void>;
}

export interface ChainRepository {
  create(chain: DisposableChain): Promise<void>;
  update(chain: DisposableChain): Promise<void>;
  findById(id: string): Promise<DisposableChain | null>;
  list(): Promise<DisposableChain[]>;
}
