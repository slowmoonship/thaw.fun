import Fastify from "fastify";
import { access } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { JsonChainRepository } from "./json-chain-repository.js";
import { LocalAvalancheAdapter } from "./local-avalanche-adapter.js";
import { FujiAvalancheAdapter } from "./fuji-avalanche-adapter.js";
import { MainnetAvalancheAdapter } from "./unsupported-avalanche-adapter.js";
import { L1Orchestrator } from "./l1-orchestrator.js";
import { AppError } from "./errors.js";
import { validateCreateInput } from "./validation.js";
import { hasUnresolvedFujiMutation, type AvalancheAdapter, type ChainNetwork } from "./domain.js";

const available = async (paths: string[]) => { for (const path of paths) { try { await access(path); return true; } catch {} } return false; };
export interface BuildAppOptions { orchestrator?: L1Orchestrator; runtimePath?: string; network?: ChainNetwork; adapter?: AvalancheAdapter }

export function configuredNetwork(value = process.env.SHIPFUN_ENVIRONMENT ?? process.env.APP_ENVIRONMENT ?? "local"): ChainNetwork {
  if (value === "local" || value === "fuji" || value === "mainnet") return value;
  throw new AppError("INVALID_ENVIRONMENT", `unsupported environment ${value}`, 500);
}

export function adapterFor(network: ChainNetwork): AvalancheAdapter {
  if (network === "local") return new LocalAvalancheAdapter();
  if (network === "fuji") return new FujiAvalancheAdapter();
  return new MainnetAvalancheAdapter();
}

export function repositoryPathFor(network: ChainNetwork): string {
  if (network === "fuji") {
    const path = process.env.SHIPFUN_FUJI_REPOSITORY_PATH || resolve(import.meta.dirname, "../../..", ".runtime", "fuji-chains.json");
    if (!isAbsolute(path)) throw new AppError("INVALID_FUJI_REPOSITORY_PATH", "Fuji repository path must be absolute", 500);
    return path;
  }
  if (network === "mainnet") return process.env.SHIPFUN_MAINNET_REPOSITORY_PATH ?? resolve(process.cwd(), ".runtime", "mainnet-chains.json");
  return process.env.CHAIN_REPOSITORY_PATH ?? resolve(process.cwd(), ".runtime", "chains.json");
}

const FUJI_BROWSER_ORIGIN = "http://127.0.0.1:5173";
const FUJI_BROWSER_HOSTS = new Set(["127.0.0.1:5173", "127.0.0.1:3000"]);

export function isFujiBrowserWriteRequest(headers: { origin?: string; host?: string }): boolean {
  return headers.origin === FUJI_BROWSER_ORIGIN && FUJI_BROWSER_HOSTS.has(headers.host ?? "");
}

export const buildApp = async (options: BuildAppOptions = {}) => {
  const app = Fastify({ logger: true });
  const network = options.network ?? configuredNetwork();
  const fujiMutationEnabled = network === "fuji"
    && process.env.SHIPFUN_FUJI_MUTATION_APPROVED === "true"
    && process.env.SHIPFUN_FUJI_INTERACTIVE_SIGNING === "true"
    && Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const assertFujiWriteAccess = (headers: { origin?: string; host?: string }) => {
    if (network !== "fuji") return;
    if (!fujiMutationEnabled) throw new AppError("FUJI_MUTATION_NOT_APPROVED", "Fuji mutation gate is closed", 403);
    if (!isFujiBrowserWriteRequest(headers)) {
      throw new AppError("FUJI_BROWSER_ORIGIN_REQUIRED", "Fuji writes require the local operator browser", 403);
    }
  };
  const operatorView = (chain: Awaited<ReturnType<L1Orchestrator["getStatus"]>>) => ({
    ...chain,
    canContinueExpiration: fujiMutationEnabled && chain.network === "fuji" && chain.status === "EXPIRING"
      && Boolean(chain.validatorId) && !hasUnresolvedFujiMutation(chain),
  });
  const runtimePath = options.runtimePath ?? repositoryPathFor(network);
  const orchestrator = options.orchestrator ?? new L1Orchestrator(new JsonChainRepository(runtimePath), options.adapter ?? adapterFor(network), { network });
  await orchestrator.initialize();
  app.get("/health", async () => ({ status: "ok" }));
  app.get("/environment", async () => ({
    appName: process.env.APP_NAME ?? "Disposable L1",
    appBrand: process.env.APP_BRAND ?? "thaw.fun",
    environment: network,
    network,
    fujiMutationEnabled,
    avalancheCliAvailable: await available([`${process.env.HOME}/.local/bin/avalanche`, "/usr/local/bin/avalanche"]),
    platformCliAvailable: await available([`${process.env.HOME}/.local/bin/platform-cli`, "/usr/local/bin/platform-cli"])
  }));
  app.post("/chains", async (request, reply) => {
    assertFujiWriteAccess(request.headers);
    const input = validateCreateInput(request.body);
    const chain = await orchestrator.create(input);
    return reply.code(202).send({ id: chain.id, status: chain.status });
  });
  app.get<{ Params: { id: string } }>("/chains/:id", async (request) => operatorView(await orchestrator.getStatus(request.params.id)));
  app.get("/chains", async () => (await orchestrator.list()).map(operatorView));
  app.post<{ Params: { id: string } }>("/chains/:id/expire", async (request, reply) => {
    assertFujiWriteAccess(request.headers);
    await orchestrator.expire(request.params.id);
    return reply.send(operatorView(await orchestrator.getStatus(request.params.id)));
  });
  app.post<{ Params: { id: string } }>("/chains/:id/recover", async (request, reply) => {
    assertFujiWriteAccess(request.headers);
    await orchestrator.recover(request.params.id);
    return reply.send(operatorView(await orchestrator.getStatus(request.params.id)));
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) return reply.code(error.statusCode).send({ error: error.code, message: error.message });
    app.log.error(error);
    return reply.code(500).send({ error: "INTERNAL_ERROR", message: "internal server error" });
  });
  app.addHook("onClose", async () => { orchestrator.close(); });
  return app;
};
