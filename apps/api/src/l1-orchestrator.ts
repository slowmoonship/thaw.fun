import { randomUUID } from "node:crypto";
import { hasUnresolvedFujiMutation, type AvalancheAdapter, type ChainNetwork, type ChainRepository, type ChainView, type CreateChainInput, type DisposableChain } from "./domain.js";
import { AppError, sanitizeFailure } from "./errors.js";
import { generateEvmChainId } from "./chain-id.js";
import { assertTransition } from "./state-machine.js";
import type { StructuredLogger } from "./logger.js";
import { jsonLogger } from "./logger.js";

const ACTIVE = new Set(["CREATING", "LIVE", "EXPIRING"]);

export interface OrchestratorOptions {
  now?: () => Date;
  idFactory?: () => string;
  logger?: StructuredLogger;
  network?: ChainNetwork;
}

export class L1Orchestrator {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly operations = new Map<string, Promise<void>>();
  private readonly expirationOperations = new Map<string, Promise<void>>();
  private createLock: Promise<void> = Promise.resolve();
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly logger: StructuredLogger;
  private readonly network: ChainNetwork;

  constructor(
    private readonly repository: ChainRepository,
    private readonly adapter: AvalancheAdapter,
    options: OrchestratorOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.logger = options.logger ?? jsonLogger;
    this.network = options.network ?? "local";
  }

  async initialize(): Promise<void> {
    for (const chain of await this.repository.list()) {
      if (chain.status === "CREATING") {
        await this.fail(chain, "CREATION_INTERRUPTED_BY_API_RESTART");
      } else if (chain.status === "EXPIRING") {
        if (this.network === "fuji") {
          chain.requiresRecovery = true;
          await this.repository.update(chain);
        } else this.startExpiration(chain.id);
      } else if (chain.status === "LIVE") {
        if (!chain.expiresAt || Date.parse(chain.expiresAt) <= this.now().getTime()) {
          if (this.network === "fuji") await this.markManualExpiration(chain.id);
          else this.startExpiration(chain.id);
        }
        else this.schedule(chain);
      }
    }
  }

  async create(input: CreateChainInput): Promise<DisposableChain> {
    let release!: () => void;
    const previous = this.createLock;
    this.createLock = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const records = await this.repository.list();
      if (this.network === "fuji" && records.length > 0) {
        throw new AppError("FUJI_SINGLE_CREATE_ATTEMPT_USED", "Fuji repository already contains its one permitted chain attempt", 409);
      }
      if (records.some((chain) => ACTIVE.has(chain.status) || chain.requiresRecovery)) {
        throw new AppError("ACTIVE_CHAIN_EXISTS", "only one active disposable L1 is allowed", 409);
      }
      const id = this.idFactory();
      const suffix = id.replaceAll("-", "").slice(0, 12).toLowerCase().replace(/[0-9a-f]/g, (character) => "abcdefghijklmnop"[Number.parseInt(character, 16)]!);
      const chain: DisposableChain = {
        id,
        name: input.name,
        internalName: `chain${suffix}`,
        symbol: input.symbol,
        network: this.network,
        evmChainId: generateEvmChainId(records.map((item) => item.evmChainId)),
        createdAt: this.now().toISOString(),
        lifetimeSeconds: input.lifetimeSeconds,
        status: "CREATING",
      };
      let preparation: unknown;
      if (this.network === "fuji") {
        if (!this.adapter.preflightCreate) throw new AppError("FUJI_PREFLIGHT_NOT_CONFIGURED", "Fuji creation requires a pre-mutation preflight", 503);
        try { preparation = await this.adapter.preflightCreate(chain); }
        catch (error) { throw new AppError("FUJI_PREFLIGHT_FAILED", sanitizeFailure(error), 422); }
      }
      await this.repository.create(chain);
      this.track(chain.id, this.runCreation(chain.id, preparation));
      return chain;
    } finally { release(); }
  }

  async getStatus(id: string): Promise<ChainView> {
    let chain = await this.requireChain(id);
    if (chain.status === "LIVE") {
      if (chain.expiresAt && Date.parse(chain.expiresAt) <= this.now().getTime()) {
        if (this.network === "fuji") await this.markManualExpiration(id);
        else await this.expire(id);
        chain = await this.requireChain(id);
      } else {
        try {
          const latestBlock = await this.adapter.getBlockNumber(chain);
          const authoritative = await this.requireChain(id);
          chain = authoritative.status === "LIVE" ? { ...authoritative, latestBlock } : authoritative;
        } catch (error) {
          this.logger.error({ chainId: chain.id, internalName: chain.internalName, operation: "status_rpc", status: chain.status, error: sanitizeFailure(error) }, "RPC status check failed");
        }
      }
    }
    const rpcHealthy = chain.status === "LIVE" ? await this.adapter.isRpcHealthy(chain) : false;
    const authoritative = await this.requireChain(id);
    if (authoritative.status !== "LIVE") return { ...authoritative, remainingSeconds: remaining(authoritative, this.now()), rpcHealthy: false };
    const current = { ...authoritative, latestBlock: chain.latestBlock ?? authoritative.latestBlock };
    return { ...current, remainingSeconds: remaining(current, this.now()), rpcHealthy };
  }

  async list(): Promise<ChainView[]> {
    const records = await this.repository.list();
    return Promise.all(records.map((chain) => this.getStatus(chain.id)));
  }

  async expire(id: string): Promise<void> {
    if (this.network === "fuji" && hasUnresolvedFujiMutation(await this.requireChain(id))) {
      throw new AppError("FUJI_MANUAL_RECONCILIATION_REQUIRED", "an external Fuji mutation has an unresolved outcome", 409);
    }
    return this.startExpiration(id);
  }

  async recover(id: string): Promise<void> {
    if (this.network !== "fuji") throw new AppError("RECOVERY_UNAVAILABLE", "Fuji recovery only", 409);
    const chain = await this.requireChain(id);
    if (chain.status !== "FAILED" || !chain.requiresRecovery) throw new AppError("RECOVERY_UNAVAILABLE", "chain does not need recovery", 409);
    if (hasUnresolvedFujiMutation(chain)) throw new AppError("FUJI_MANUAL_RECONCILIATION_REQUIRED", "an external Fuji mutation has an unresolved outcome", 409);
    if (!chain.validatorId) throw new AppError("MANUAL_RECONCILIATION_REQUIRED", "validator identity is unknown; inspect the P-Chain before cleanup", 409);
    chain.status = "EXPIRING";
    await this.repository.update(chain);
    return this.startExpiration(id);
  }

  async waitForIdle(id: string): Promise<void> { await this.operations.get(id); }

  close(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private async runCreation(id: string, preparation?: unknown): Promise<void> {
    const chain = await this.requireChain(id);
    try {
      const created = await this.adapter.createL1(chain, async () => {
        chain.requiresRecovery = true;
        await this.repository.update(chain);
      }, async (update) => {
        Object.assign(chain, update);
        await this.repository.update(chain);
      }, preparation);
      assertTransition(chain.status, "LIVE");
      const live: DisposableChain = {
        ...chain,
        ...created,
        status: "LIVE",
        requiresRecovery: false,
        expiresAt: new Date(this.now().getTime() + chain.lifetimeSeconds * 1_000).toISOString(),
      };
      await this.repository.update(live);
      Object.assign(chain, live);
      this.schedule(live);
    } catch (error) {
      if (error && typeof error === "object" && "deployment" in error) Object.assign(chain, (error as { deployment: object }).deployment);
      await this.fail(chain, sanitizeFailure(error));
    }
  }

  private async runExpiration(id: string): Promise<void> {
    const chain = await this.requireChain(id);
    if (chain.status === "DEAD") return;
    if (chain.status !== "LIVE" && chain.status !== "EXPIRING") throw new AppError("CHAIN_NOT_LIVE", `cannot expire chain in ${chain.status}`, 409);
    try {
      if (chain.status === "LIVE") {
        assertTransition(chain.status, "EXPIRING");
        chain.status = "EXPIRING";
        await this.repository.update(chain);
      }
      try {
        chain.finalBlock = await this.adapter.getBlockNumber(chain);
        chain.latestBlock = chain.finalBlock;
        await this.repository.update(chain);
      } catch (error) {
        this.logger.warn({ chainId: chain.id, internalName: chain.internalName, operation: "final_block", status: chain.status, error: sanitizeFailure(error) }, "Final block unavailable; expiration continues");
      }
      await this.adapter.expireL1(chain, async (update) => {
        Object.assign(chain, update);
        await this.repository.update(chain);
      });
      assertTransition(chain.status, "DEAD");
      chain.status = "DEAD";
      chain.requiresRecovery = false;
      delete chain.failureReason;
      chain.expiredAt = this.now().toISOString();
      await this.repository.update(chain);
      this.logger.info({ chainId: chain.id, internalName: chain.internalName, operation: "expire", status: "DEAD" }, "L1 is dead");
    } catch (error) {
      if (this.network === "fuji" || (error && typeof error === "object" && "requiresRecovery" in error)) chain.requiresRecovery = true;
      await this.fail(chain, sanitizeFailure(error));
    }
    finally {
      const timer = this.timers.get(id);
      if (timer) clearTimeout(timer);
      this.timers.delete(id);
    }
  }

  private schedule(chain: DisposableChain): void {
    if (!chain.expiresAt) throw new Error("LIVE chain has no expiresAt");
    const delay = Math.max(0, Date.parse(chain.expiresAt) - this.now().getTime());
    const timer = setTimeout(() => {
      void this.startExpiration(chain.id).catch((error) => {
        this.logger.error(
          { chainId: chain.id, operation: "scheduled_expiry", error: sanitizeFailure(error) },
          "Scheduled expiration failed",
        );
      });
    }, delay);
    timer.unref();
    this.timers.set(chain.id, timer);
    this.logger.info({ chainId: chain.id, internalName: chain.internalName, operation: "schedule_expiry", status: chain.status, duration: delay }, "Expiration scheduled");
  }

  private async markManualExpiration(id: string): Promise<void> {
    const chain = await this.requireChain(id);
    if (chain.status !== "LIVE") return;
    chain.status = "EXPIRING";
    chain.requiresRecovery = true;
    await this.repository.update(chain);
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
    this.logger.warn({ chainId: id, operation: "fuji_manual_expiry", status: "EXPIRING" }, "Fuji expiry needs operator signing");
  }

  private track(id: string, operation: Promise<void>): void {
    this.operations.set(id, operation);
    const cleanup = () => { if (this.operations.get(id) === operation) this.operations.delete(id); };
    void operation.then(cleanup, cleanup);
  }

  private startExpiration(id: string): Promise<void> {
    const existing = this.expirationOperations.get(id);
    if (existing) return existing;
    const operation = this.runExpiration(id);
    this.expirationOperations.set(id, operation);
    this.track(id, operation);
    const cleanup = () => { if (this.expirationOperations.get(id) === operation) this.expirationOperations.delete(id); };
    void operation.then(cleanup, cleanup);
    return operation;
  }

  private async fail(chain: DisposableChain, reason: string): Promise<void> {
    if (chain.status === "FAILED" || chain.status === "DEAD") return;
    assertTransition(chain.status, "FAILED");
    chain.status = "FAILED";
    chain.failureReason = reason;
    await this.repository.update(chain);
    this.logger.error({ chainId: chain.id, internalName: chain.internalName, operation: "lifecycle", status: "FAILED", error: reason }, "L1 lifecycle failed");
  }

  private async requireChain(id: string): Promise<DisposableChain> {
    const chain = await this.repository.findById(id);
    if (!chain) throw new AppError("CHAIN_NOT_FOUND", "chain not found", 404);
    return chain;
  }
}

function remaining(chain: DisposableChain, now: Date): number {
  if (chain.status !== "LIVE" || !chain.expiresAt) return 0;
  return Math.max(0, Math.ceil((Date.parse(chain.expiresAt) - now.getTime()) / 1_000));
}
