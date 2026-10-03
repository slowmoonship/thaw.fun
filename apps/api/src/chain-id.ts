import { randomInt } from "node:crypto";

const MIN_CHAIN_ID = 100_000_000;
const MAX_CHAIN_ID = 2_000_000_000;
const RESERVED = new Set([1, 43114]);

export function generateEvmChainId(existing: Iterable<number>, random = randomInt): number {
  const used = new Set(existing);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = random(MIN_CHAIN_ID, MAX_CHAIN_ID);
    if (!RESERVED.has(candidate) && !used.has(candidate)) return candidate;
  }
  throw new Error("unable to allocate a unique EVM chain ID");
}
