import assert from "node:assert/strict";
import test from "node:test";
import type { AvalancheAdapter, ChainRepository, CreatedL1, DisposableChain } from "../src/domain.js";
import { L1Orchestrator } from "../src/l1-orchestrator.js";
import { buildApp } from "../src/app.js";

class MemoryRepository implements ChainRepository {
  constructor(public chains: DisposableChain[] = []) {}
  async create(chain: DisposableChain) { this.chains.push(structuredClone(chain)); }
  async update(chain: DisposableChain) { this.chains[this.chains.findIndex((item) => item.id === chain.id)] = structuredClone(chain); }
  async findById(id: string) { return structuredClone(this.chains.find((item) => item.id === id) ?? null); }
  async list() { return structuredClone(this.chains); }
}

class FakeAdapter implements AvalancheAdapter {
  expired = 0;
  async preflightCreate(_chain: DisposableChain): Promise<unknown> { return undefined; }
  async createL1(_chain: DisposableChain): Promise<CreatedL1> { return deployment(); }
  async getBlockNumber() { return 8; }
  async isRpcHealthy() { return true; }
  async expireL1() { this.expired += 1; }
}

const liveChain = (overrides: Partial<DisposableChain> = {}): DisposableChain => ({
  id: "live", name: "LIVE", internalName: "chain-live", symbol: "LIVE", network: "local",
  evmChainId: 123456789, createdAt: new Date(0).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
  lifetimeSeconds: 60, status: "LIVE", rpcUrl: "http://127.0.0.1/rpc", ...overrides,
});

const deployment = (): CreatedL1 => ({
  subnetId: `2${"A".repeat(49)}`, blockchainId: `3${"B".repeat(49)}`,
  rpcUrl: "http://127.0.0.1:9654/ext/bc/fake/rpc", latestBlock: 7,
});

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

test("creates, verifies, schedules and expires a chain", async () => {
  const repository = new MemoryRepository();
  const adapter = new FakeAdapter();
  const orchestrator = new L1Orchestrator(repository, adapter, { idFactory: () => "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" });
  const created = await orchestrator.create({ name: "PEPE", symbol: "PEPE", lifetimeSeconds: 0.02 });
  assert.match(created.internalName, /^chain[a-p]+$/);
  await orchestrator.waitForIdle(created.id);
  assert.equal((await repository.findById(created.id))?.status, "LIVE");
  await new Promise((resolve) => setTimeout(resolve, 60));
  await orchestrator.waitForIdle(created.id);
  const dead = await repository.findById(created.id);
  assert.equal(dead?.status, "DEAD");
  assert.equal(dead?.finalBlock, 8);
  assert.equal(adapter.expired, 1);
  orchestrator.close();
});

test("startup reconciliation expires overdue LIVE records", async () => {
  const chain = liveChain({ id: "overdue", expiresAt: new Date(1).toISOString() });
  const repository = new MemoryRepository([chain]);
  const adapter = new FakeAdapter();
  const orchestrator = new L1Orchestrator(repository, adapter, { now: () => new Date(2) });
  await orchestrator.initialize();
  await orchestrator.waitForIdle(chain.id);
  assert.equal((await repository.findById(chain.id))?.status, "DEAD");
  orchestrator.close();
});

test("rejects a second active chain", async () => {
  const repository = new MemoryRepository();
  const orchestrator = new L1Orchestrator(repository, new FakeAdapter());
  await orchestrator.create({ name: "ONE", symbol: "ONE", lifetimeSeconds: 60 });
  await assert.rejects(() => orchestrator.create({ name: "TWO", symbol: "TWO", lifetimeSeconds: 60 }), hasCode("ACTIVE_CHAIN_EXISTS"));
  orchestrator.close();
});

test("explicit Fuji orchestration persists network fuji", async () => {
  const repository = new MemoryRepository();
  const orchestrator = new L1Orchestrator(repository, new FakeAdapter(), { network: "fuji" });
  const created = await orchestrator.create({ name: "FUJI", symbol: "FUJI", lifetimeSeconds: 60 });
  await orchestrator.waitForIdle(created.id);
  assert.equal((await repository.findById(created.id))?.network, "fuji");
  orchestrator.close();
});

test("Fuji preflight failure leaves no one-shot record and permits a later attempt", async () => {
  class PreflightAdapter extends FakeAdapter {
    calls = 0;
    creations = 0;
    override async preflightCreate(chain: DisposableChain): Promise<unknown> {
      this.calls += 1;
      if (this.calls === 1) throw new Error("FUJI_PINNED_SOLC_PATH_REQUIRED");
      return { chainId: chain.id };
    }
    override async createL1(_chain: DisposableChain, _mark?: () => Promise<void>, _checkpoint?: (update: Partial<DisposableChain>) => Promise<void>, prepared?: unknown): Promise<CreatedL1> {
      this.creations += 1;
      assert.deepEqual(prepared, { chainId: _chain.id });
      return deployment();
    }
  }
  const adapter = new PreflightAdapter();
  const repository = new MemoryRepository();
  const orchestrator = new L1Orchestrator(repository, adapter, { network: "fuji" });
  await assert.rejects(() => orchestrator.create({ name: "FUJI", symbol: "FUJI", lifetimeSeconds: 60 }), hasCode("FUJI_PREFLIGHT_FAILED"));
  assert.deepEqual(await repository.list(), []);
  assert.equal(adapter.creations, 0);
  const created = await orchestrator.create({ name: "FUJI", symbol: "FUJI", lifetimeSeconds: 60 });
  await orchestrator.waitForIdle(created.id);
  assert.equal((await repository.findById(created.id))?.status, "LIVE");
  assert.equal(adapter.calls, 2);
  assert.equal(adapter.creations, 1);
  orchestrator.close();
});

test("concurrent Fuji create calls serialize preflight and preserve the one-shot record", async () => {
  const preflightStarted = deferred();
  const releasePreflight = deferred();
  class SlowPreflightAdapter extends FakeAdapter {
    preflights = 0;
    override async preflightCreate(): Promise<unknown> {
      this.preflights += 1;
      preflightStarted.resolve();
      await releasePreflight.promise;
      return undefined;
    }
  }
  const repository = new MemoryRepository();
  const adapter = new SlowPreflightAdapter();
  const orchestrator = new L1Orchestrator(repository, adapter, { network: "fuji" });
  const first = orchestrator.create({ name: "ONE", symbol: "ONE", lifetimeSeconds: 60 });
  await preflightStarted.promise;
  const second = orchestrator.create({ name: "TWO", symbol: "TWO", lifetimeSeconds: 60 });
  releasePreflight.resolve();
  const created = await first;
  await assert.rejects(() => second, hasCode("FUJI_SINGLE_CREATE_ATTEMPT_USED"));
  await orchestrator.waitForIdle(created.id);
  assert.equal(adapter.preflights, 1);
  assert.equal(repository.chains.length, 1);
  orchestrator.close();
});

test("Fuji repository permits only one create attempt even after DEAD", async () => {
  const repository = new MemoryRepository();
  const orchestrator = new L1Orchestrator(repository, new FakeAdapter(), { network: "fuji" });
  const created = await orchestrator.create({ name: "FUJI", symbol: "FUJI", lifetimeSeconds: 60 });
  await orchestrator.waitForIdle(created.id);
  await orchestrator.expire(created.id);
  assert.equal((await repository.findById(created.id))?.status, "DEAD");
  await assert.rejects(() => orchestrator.create({ name: "SECOND", symbol: "SECOND", lifetimeSeconds: 60 }), hasCode("FUJI_SINGLE_CREATE_ATTEMPT_USED"));
  assert.equal(repository.chains.length, 1);
  orchestrator.close();
});

test("stale polling cannot overwrite DEAD lifecycle fields", async () => {
  const blockReadStarted = deferred();
  const releaseBlockRead = deferred<number>();
  let reads = 0;
  class RacingAdapter extends FakeAdapter {
    override async getBlockNumber() {
      reads += 1;
      if (reads === 1) { blockReadStarted.resolve(); return releaseBlockRead.promise; }
      return 9;
    }
  }
  const repository = new MemoryRepository([liveChain()]);
  const orchestrator = new L1Orchestrator(repository, new RacingAdapter());
  const polling = orchestrator.getStatus("live");
  await blockReadStarted.promise;
  await orchestrator.expire("live");
  const deadBeforePollReturns = await repository.findById("live");
  releaseBlockRead.resolve(10);
  await polling;
  const final = await repository.findById("live");
  assert.equal(final?.status, "DEAD");
  assert.equal(final?.finalBlock, 9);
  assert.equal(final?.expiredAt, deadBeforePollReturns?.expiredAt);
  orchestrator.close();
});

test("concurrent manual expiration performs one mutation", async () => {
  const stopStarted = deferred();
  const releaseStop = deferred();
  class SlowAdapter extends FakeAdapter {
    override async expireL1() { this.expired += 1; stopStarted.resolve(); await releaseStop.promise; }
  }
  const adapter = new SlowAdapter();
  const repository = new MemoryRepository([liveChain()]);
  const orchestrator = new L1Orchestrator(repository, adapter);
  const first = orchestrator.expire("live");
  const second = orchestrator.expire("live");
  await stopStarted.promise;
  assert.equal(adapter.expired, 1);
  releaseStop.resolve();
  await Promise.all([first, second]);
  assert.equal((await repository.findById("live"))?.status, "DEAD");
  assert.equal(adapter.expired, 1);
  orchestrator.close();
});

test("scheduler and manual API expiration share one mutation", async () => {
  const stopStarted = deferred();
  const releaseStop = deferred();
  class SlowAdapter extends FakeAdapter {
    override async expireL1() { this.expired += 1; stopStarted.resolve(); await releaseStop.promise; }
  }
  const adapter = new SlowAdapter();
  const repository = new MemoryRepository([liveChain({ expiresAt: new Date(Date.now() + 15).toISOString() })]);
  const orchestrator = new L1Orchestrator(repository, adapter);
  await orchestrator.initialize();
  const app = await buildApp({ orchestrator });
  await stopStarted.promise;
  const manual = app.inject({ method: "POST", url: "/chains/live/expire" });
  releaseStop.resolve();
  const response = await manual;
  assert.equal(response.statusCode, 200);
  assert.equal(adapter.expired, 1);
  assert.equal((await repository.findById("live"))?.status, "DEAD");
  await app.close();
});

test("post-mutation creation failure requires recovery and blocks another create", async () => {
  class UncertainAdapter extends FakeAdapter {
    override async createL1(_chain: DisposableChain, mark?: () => Promise<void>): Promise<CreatedL1> {
      await mark?.();
      throw new Error("readiness failed");
    }
  }
  const repository = new MemoryRepository();
  const orchestrator = new L1Orchestrator(repository, new UncertainAdapter());
  const created = await orchestrator.create({ name: "ONE", symbol: "ONE", lifetimeSeconds: 60 });
  await orchestrator.waitForIdle(created.id);
  const failed = await repository.findById(created.id);
  assert.equal(failed?.status, "FAILED");
  assert.equal(failed?.requiresRecovery, true);
  await assert.rejects(() => orchestrator.create({ name: "TWO", symbol: "TWO", lifetimeSeconds: 60 }), hasCode("ACTIVE_CHAIN_EXISTS"));
  orchestrator.close();
});

test("post-mutation creation failure persists known Fuji metadata", async () => {
  class PartialError extends Error {
    readonly requiresRecovery = true;
    readonly deployment = { subnetId: SUBNET_ID, blockchainId: BLOCKCHAIN_ID, validatorNodeId: "NodeID-partial" };
  }
  class PartialAdapter extends FakeAdapter {
    override async createL1(_chain: DisposableChain, mark?: () => Promise<void>): Promise<CreatedL1> {
      await mark?.();
      throw new PartialError("RPC verification failed");
    }
  }
  const repository = new MemoryRepository();
  const orchestrator = new L1Orchestrator(repository, new PartialAdapter(), { network: "fuji" });
  const created = await orchestrator.create({ name: "FUJI", symbol: "FUJI", lifetimeSeconds: 60 });
  await orchestrator.waitForIdle(created.id);
  const failed = await repository.findById(created.id);
  assert.equal(failed?.subnetId, SUBNET_ID);
  assert.equal(failed?.blockchainId, BLOCKCHAIN_ID);
  assert.equal(failed?.validatorNodeId, "NodeID-partial");
  assert.equal(failed?.requiresRecovery, true);
  orchestrator.close();
});

test("pre-mutation creation failure releases the active slot", async () => {
  class PreMutationAdapter extends FakeAdapter {
    attempts = 0;
    override async createL1(): Promise<CreatedL1> {
      this.attempts += 1;
      if (this.attempts === 1) throw new Error("configuration failed");
      return deployment();
    }
  }
  const repository = new MemoryRepository();
  const adapter = new PreMutationAdapter();
  const orchestrator = new L1Orchestrator(repository, adapter);
  const first = await orchestrator.create({ name: "ONE", symbol: "ONE", lifetimeSeconds: 60 });
  await orchestrator.waitForIdle(first.id);
  assert.equal((await repository.findById(first.id))?.requiresRecovery, undefined);
  const second = await orchestrator.create({ name: "TWO", symbol: "TWO", lifetimeSeconds: 60 });
  await orchestrator.waitForIdle(second.id);
  assert.equal((await repository.findById(second.id))?.status, "LIVE");
  orchestrator.close();
});

test("LIVE persistence failure after mutation retains recovery requirement", async () => {
  class FailLiveRepository extends MemoryRepository {
    override async update(chain: DisposableChain) {
      if (chain.status === "LIVE") throw new Error("LIVE persistence failed");
      return super.update(chain);
    }
  }
  class MarkingAdapter extends FakeAdapter {
    override async createL1(_chain: DisposableChain, mark?: () => Promise<void>): Promise<CreatedL1> {
      await mark?.();
      return deployment();
    }
  }
  const repository = new FailLiveRepository();
  const orchestrator = new L1Orchestrator(repository, new MarkingAdapter());
  const created = await orchestrator.create({ name: "ONE", symbol: "ONE", lifetimeSeconds: 60 });
  await orchestrator.waitForIdle(created.id);
  const failed = await repository.findById(created.id);
  assert.equal(failed?.status, "FAILED");
  assert.equal(failed?.requiresRecovery, true);
  await assert.rejects(() => orchestrator.create({ name: "TWO", symbol: "TWO", lifetimeSeconds: 60 }), hasCode("ACTIVE_CHAIN_EXISTS"));
  orchestrator.close();
});

test("RPC failure does not prevent expiration", async () => {
  class OfflineRpcAdapter extends FakeAdapter {
    override async getBlockNumber(): Promise<number> { throw new Error("RPC offline"); }
  }
  const adapter = new OfflineRpcAdapter();
  const repository = new MemoryRepository([liveChain()]);
  const orchestrator = new L1Orchestrator(repository, adapter);
  await orchestrator.expire("live");
  const dead = await repository.findById("live");
  assert.equal(adapter.expired, 1);
  assert.equal(dead?.status, "DEAD");
  assert.equal(dead?.finalBlock, undefined);
  orchestrator.close();
});

test("unresolved expiration cleanup remains FAILED and recovery-blocking", async () => {
  class CleanupError extends Error { readonly requiresRecovery = true; }
  class BrokenCleanupAdapter extends FakeAdapter {
    override async expireL1() { throw new CleanupError("validator state unresolved"); }
  }
  const repository = new MemoryRepository([liveChain({ network: "fuji" })]);
  const orchestrator = new L1Orchestrator(repository, new BrokenCleanupAdapter(), { network: "fuji" });
  await orchestrator.expire("live");
  const failed = await repository.findById("live");
  assert.equal(failed?.status, "FAILED");
  assert.equal(failed?.requiresRecovery, true);
  await assert.rejects(() => orchestrator.create({ name: "TWO", symbol: "TWO", lifetimeSeconds: 60 }), hasCode("FUJI_SINGLE_CREATE_ATTEMPT_USED"));
  orchestrator.close();
});

test("Fuji restart during EXPIRING retains recovery without automatic signing", async () => {
  const adapter = new FakeAdapter();
  const repository = new MemoryRepository([liveChain({ network: "fuji", status: "EXPIRING", validatorId: "validator-id" })]);
  const restarted = new L1Orchestrator(repository, adapter, { network: "fuji" });
  await restarted.initialize();
  assert.equal(adapter.expired, 0);
  assert.equal((await repository.findById("live"))?.status, "EXPIRING");
  assert.equal((await repository.findById("live"))?.requiresRecovery, true);
  await restarted.expire("live");
  assert.equal(adapter.expired, 1);
  assert.equal((await repository.findById("live"))?.status, "DEAD");
  restarted.close();
});

test("an uncertain Fuji journal step blocks resumed expiration until reconciliation", async () => {
  const adapter = new FakeAdapter();
  const repository = new MemoryRepository([liveChain({
    network: "fuji", status: "EXPIRING", validatorId: "validator-id",
    fujiJournal: [{ step: "validator_disable", phase: "pending", at: new Date(0).toISOString() }],
  })]);
  const orchestrator = new L1Orchestrator(repository, adapter, { network: "fuji" });
  const app = await buildApp({ orchestrator, network: "fuji" });
  try {
    assert.equal((await app.inject({ method: "GET", url: "/chains/live" })).json().canContinueExpiration, false);
    await assert.rejects(() => orchestrator.expire("live"), hasCode("FUJI_MANUAL_RECONCILIATION_REQUIRED"));
    assert.equal(adapter.expired, 0);
    assert.equal((await repository.findById("live"))?.requiresRecovery, true);
  } finally { await app.close(); }
});

test("Fuji mutation endpoints remain closed without explicit approval", async () => {
  const previous = process.env.SHIPFUN_FUJI_MUTATION_APPROVED;
  delete process.env.SHIPFUN_FUJI_MUTATION_APPROVED;
  const repository = new MemoryRepository([liveChain({ network: "fuji", validatorId: "validator-id" })]);
  const adapter = new FakeAdapter();
  const orchestrator = new L1Orchestrator(repository, adapter, { network: "fuji" });
  const app = await buildApp({ orchestrator, network: "fuji" });
  try {
    assert.equal((await app.inject({ method: "GET", url: "/chains/live" })).json().canContinueExpiration, false);
    assert.equal((await app.inject({ method: "GET", url: "/chains" })).json()[0].canContinueExpiration, false);
    const requests = [
      { method: "POST" as const, url: "/chains", payload: { name: "FUJI", symbol: "FUJI", lifetimeSeconds: 60 } },
      { method: "POST" as const, url: "/chains/live/expire" },
      { method: "POST" as const, url: "/chains/live/recover" },
    ];
    for (const request of requests) {
      const response = await app.inject(request);
      assert.equal(response.statusCode, 403);
      assert.equal(response.json().error, "FUJI_MUTATION_NOT_APPROVED");
    }
    assert.equal(adapter.expired, 0);
    assert.equal(repository.chains.length, 1);
  } finally {
    await app.close();
    if (previous === undefined) delete process.env.SHIPFUN_FUJI_MUTATION_APPROVED;
    else process.env.SHIPFUN_FUJI_MUTATION_APPROVED = previous;
  }
});

test("startup reconciliation completes after physical stop preceded DEAD persistence", async () => {
  class AlreadyStoppedAdapter extends FakeAdapter {
    stopped = false;
    physicalStops = 0;
    override async getBlockNumber(): Promise<number> {
      if (this.stopped) throw new Error("RPC offline");
      return 8;
    }
    override async expireL1() {
      this.expired += 1;
      if (!this.stopped) { this.stopped = true; this.physicalStops += 1; }
    }
  }
  class FailDeadOnceRepository extends MemoryRepository {
    failed = false;
    override async update(chain: DisposableChain) {
      if (chain.status === "DEAD" && !this.failed) { this.failed = true; throw new Error("persistence interrupted"); }
      return super.update(chain);
    }
  }
  const adapter = new AlreadyStoppedAdapter();
  const repository = new FailDeadOnceRepository([liveChain()]);
  const first = new L1Orchestrator(repository, adapter);
  await first.expire("live");
  assert.equal((await repository.findById("live"))?.status, "EXPIRING");
  first.close();

  const restarted = new L1Orchestrator(repository, adapter);
  await restarted.initialize();
  await restarted.waitForIdle("live");
  assert.equal((await repository.findById("live"))?.status, "DEAD");
  assert.equal(adapter.physicalStops, 1);
  restarted.close();
});

function hasCode(code: string) {
  return (error: unknown) => (error as { code?: string }).code === code;
}

const SUBNET_ID = `2${"A".repeat(49)}`;
const BLOCKCHAIN_ID = `3${"B".repeat(49)}`;
