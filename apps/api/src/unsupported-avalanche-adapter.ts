import type { AvalancheAdapter, CreatedL1, DisposableChain } from "./domain.js";

export class UnsupportedAvalancheAdapter implements AvalancheAdapter {
  constructor(private readonly code: "FUJI_NOT_CONFIGURED" | "MAINNET_MUTATION_DISABLED") {}
  async createL1(_chain: DisposableChain): Promise<CreatedL1> { throw new Error(this.code); }
  async getBlockNumber(_chain: DisposableChain): Promise<number> { throw new Error(this.code); }
  async isRpcHealthy(_chain: DisposableChain): Promise<boolean> { return false; }
  async expireL1(_chain: DisposableChain): Promise<void> { throw new Error(this.code); }
}

export class MainnetAvalancheAdapter extends UnsupportedAvalancheAdapter {
  constructor() { super("MAINNET_MUTATION_DISABLED"); }
}
