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
  rpcUrl?: string;
  latestBlock?: number;
  finalBlock?: number;
  failureReason?: string;
}

export interface ChainView extends DisposableChain {
  remainingSeconds: number;
  rpcHealthy: boolean;
}
