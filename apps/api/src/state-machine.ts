import type { ChainStatus } from "./domain.js";

const transitions: Record<ChainStatus, readonly ChainStatus[]> = {
  CREATING: ["LIVE", "FAILED"],
  LIVE: ["EXPIRING", "FAILED"],
  EXPIRING: ["DEAD", "FAILED"],
  DEAD: [],
  FAILED: [],
};

export function assertTransition(from: ChainStatus, to: ChainStatus): void {
  if (!transitions[from].includes(to)) throw new Error(`illegal chain transition: ${from} -> ${to}`);
}
