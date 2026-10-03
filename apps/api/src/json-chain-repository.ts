import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { ChainRepository, DisposableChain } from "./domain.js";

export class JsonChainRepository implements ChainRepository {
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly filePath: string) {}

  async create(chain: DisposableChain): Promise<void> {
    await this.mutate((chains) => {
      if (chains.some((item) => item.id === chain.id)) throw new Error(`duplicate chain id: ${chain.id}`);
      chains.push(structuredClone(chain));
    });
  }

  async update(chain: DisposableChain): Promise<void> {
    await this.mutate((chains) => {
      const index = chains.findIndex((item) => item.id === chain.id);
      if (index < 0) throw new Error(`chain not found: ${chain.id}`);
      chains[index] = structuredClone(chain);
    });
  }

  async findById(id: string): Promise<DisposableChain | null> {
    await this.queue;
    return (await this.read()).find((chain) => chain.id === id) ?? null;
  }

  async list(): Promise<DisposableChain[]> {
    await this.queue;
    return this.read();
  }

  private async mutate(change: (chains: DisposableChain[]) => void): Promise<void> {
    const operation = this.queue.then(async () => {
      const chains = await this.read();
      change(chains);
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(chains, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.filePath);
    });
    this.queue = operation.catch(() => undefined);
    await operation;
  }

  private async read(): Promise<DisposableChain[]> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8"));
      if (!Array.isArray(parsed)) throw new Error("chain repository root must be an array");
      return parsed as DisposableChain[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
}
