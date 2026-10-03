<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";

type ApiStatus = "CREATING" | "LIVE" | "EXPIRING" | "DEAD" | "FAILED";
type ProductPhase = "BIRTH" | "CREATING" | "LIVE" | "DEAD";

interface ChainStatus {
  id: string; name: string; symbol: string; network: "local" | "fuji" | "mainnet";
  evmChainId: number; createdAt: string; expiresAt?: string; expiredAt?: string;
  lifetimeSeconds: number; status: ApiStatus; remainingSeconds: number; rpcHealthy: boolean;
  latestBlock?: number; finalBlock?: number; subnetId?: string; blockchainId?: string;
  validatorManagerAddress?: string; validatorId?: string; validatorNodeId?: string;
  rpcUrl?: string; failureReason?: string; requiresRecovery?: boolean;
  canContinueExpiration?: boolean;
}
interface Environment { appBrand: string; environment: string; network: string; fujiMutationEnabled?: boolean; }

const phases: ProductPhase[] = ["BIRTH", "CREATING", "LIVE", "DEAD"];
const name = ref("Frostbite");
const symbol = ref("FRST");
const lifetimeSeconds = ref(300);
const chain = ref<ChainStatus>();
const environment = ref<Environment>();
const chainsLoaded = ref(false);
const isLoading = ref(true);
const error = ref("");
const isSubmitting = ref(false);
const fujiCreateStarted = ref(false);
const submittedFujiChainId = ref("");
const isExpiring = ref(false);
const copied = ref("");
let poll: number | undefined;

const phase = computed<ProductPhase>(() => {
  if (!chain.value) return "BIRTH";
  if (chain.value.status === "CREATING") return "CREATING";
  if (chain.value.status === "FAILED") return "CREATING";
  if (chain.value.status === "DEAD") return "DEAD";
  return "LIVE";
});
const phaseIndex = computed(() => phases.indexOf(phase.value));
const displayBlock = computed(() => chain.value?.status === "DEAD" ? chain.value.finalBlock : chain.value?.latestBlock);
const remaining = computed(() => formatDuration(chain.value?.remainingSeconds ?? 0));
const lifetimeLabel = computed(() => formatDuration(lifetimeSeconds.value));
const footerNetwork = computed(() => {
  const network = chain.value?.network ?? environment.value?.network;
  return network === "local" ? `LOCAL / ${environment.value?.environment ?? "UNKNOWN"}` : `MAC HOST / ${(network ?? "UNKNOWN").toUpperCase()}`;
});
const fujiMutationEnabled = computed(() => environment.value?.fujiMutationEnabled === true);
const fujiReadOnly = computed(() => environment.value?.network === "fuji" && !fujiMutationEnabled.value);
const unsupportedNetwork = computed(() => Boolean(environment.value) && environment.value?.network !== "local" && environment.value?.network !== "fuji");
const canCreate = computed(() => chainsLoaded.value && (environment.value?.network === "local" || (environment.value?.network === "fuji" && fujiMutationEnabled.value && !fujiCreateStarted.value)) && name.value.trim().length > 0 && symbol.value.trim().length > 0 && lifetimeSeconds.value >= 60 && lifetimeSeconds.value <= 604800 && !isSubmitting.value);
const fujiCleanupMessage = computed(() => {
  if (chain.value?.network !== "fuji") return "";
  if (!fujiMutationEnabled.value) return "Fuji cleanup is locked by the API. Keep this record; DEAD is not confirmed.";
  if (chain.value.canContinueExpiration === true) return "Continue this record once. Foreground validator-disable signing may follow.";
  return "Cleanup is not available for this record. Await explicit API permission or operator reconciliation; do not resubmit.";
});

function formatDuration(totalSeconds: number) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes.toString().padStart(2, "0")}:${rest.toString().padStart(2, "0")}`;
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const problem = body as { error?: string; message?: string };
    throw new Error([problem.error, problem.message].filter(Boolean).join(": ") || `Request failed (${response.status})`);
  }
  return body as T;
}

function startPolling(id: string) {
  if (poll) window.clearInterval(poll);
  poll = window.setInterval(() => void refresh(id), 2000);
}

async function createChain() {
  if (!canCreate.value) return;
  error.value = "";
  isSubmitting.value = true;
  let fujiBeforeMutationRejected = false;
  if (environment.value?.network === "fuji") {
    fujiCreateStarted.value = true;
    try { window.localStorage.setItem("thaw-fuji-create-attempt-started", "true"); } catch { /* The in-memory latch still protects this page. */ }
  }
  try {
    const response = await fetch("/api/chains", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: name.value.trim(), symbol: symbol.value.trim().toUpperCase(), lifetimeSeconds: lifetimeSeconds.value }),
    });
    if (environment.value?.network === "fuji" && [403, 422].includes(response.status)) {
      const problem = await response.clone().json().catch(() => ({})) as { error?: string };
      fujiBeforeMutationRejected = ["FUJI_PREFLIGHT_FAILED", "FUJI_MUTATION_NOT_APPROVED", "FUJI_BROWSER_ORIGIN_REQUIRED"].includes(problem.error ?? "");
    }
    const created = await readJson<{ id: string; status: ApiStatus }>(response);
    if (environment.value?.network === "fuji") submittedFujiChainId.value = created.id;
    await refresh(created.id);
    startPolling(created.id);
  } catch (cause) {
    if (fujiBeforeMutationRejected) {
      fujiCreateStarted.value = false;
      try { window.localStorage.removeItem("thaw-fuji-create-attempt-started"); } catch { /* The in-memory latch is already cleared. */ }
    }
    error.value = cause instanceof Error ? cause.message : "Creation request failed";
  }
  finally { isSubmitting.value = false; }
}

async function refresh(id: string) {
  try {
    const response = await fetch(`/api/chains/${encodeURIComponent(id)}`);
    chain.value = await readJson<ChainStatus>(response);
    error.value = "";
    if (["DEAD", "FAILED"].includes(chain.value.status) && poll) { window.clearInterval(poll); poll = undefined; }
  } catch (cause) { error.value = cause instanceof Error ? cause.message : "Status refresh failed"; }
}

async function expireNow() {
  if (!chain.value) return;
  const early = chain.value.status === "LIVE";
  const continuation = chain.value.status === "EXPIRING" && chain.value.network === "fuji" && chain.value.canContinueExpiration === true;
  if ((!early && !continuation) || (chain.value.network !== "local" && chain.value.network !== "fuji") || (chain.value.network === "fuji" && !fujiMutationEnabled.value)) return;
  error.value = "";
  isExpiring.value = true;
  try {
    const response = await fetch(`/api/chains/${encodeURIComponent(chain.value.id)}/expire`, { method: "POST" });
    chain.value = await readJson<ChainStatus>(response);
    if (!(["DEAD", "FAILED"] as ApiStatus[]).includes(chain.value.status)) startPolling(chain.value.id);
  } catch (cause) { error.value = cause instanceof Error ? cause.message : "Termination request failed"; }
  finally { isExpiring.value = false; }
}

async function copyValue(label: string, value?: string | number) {
  if (value === undefined) return;
  try {
    await navigator.clipboard.writeText(String(value));
    copied.value = label;
    window.setTimeout(() => { if (copied.value === label) copied.value = ""; }, 1400);
  } catch { copied.value = ""; }
}

function resetToBirth() {
  chain.value = undefined; error.value = "";
  if (poll) window.clearInterval(poll);
  poll = undefined;
}

onMounted(async () => {
  try { fujiCreateStarted.value = window.localStorage.getItem("thaw-fuji-create-attempt-started") === "true"; } catch { /* Storage may be unavailable. */ }
  try {
    const [environmentResponse, chainsResponse] = await Promise.all([fetch("/api/environment"), fetch("/api/chains")]);
    environment.value = await readJson<Environment>(environmentResponse);
    const chains = await readJson<ChainStatus[]>(chainsResponse);
    chainsLoaded.value = true;
    const newestFirst = [...chains].reverse();
    const active = newestFirst.find((item) => ["CREATING", "LIVE", "EXPIRING"].includes(item.status));
    const blocked = newestFirst.find((item) => item.status === "FAILED" && item.requiresRecovery);
    const latestDead = newestFirst.find((item) => item.status === "DEAD");
    const restored = environment.value.network === "fuji" ? newestFirst[0] : active ?? blocked ?? latestDead;
    if (restored) {
      chain.value = restored;
      if (["CREATING", "LIVE", "EXPIRING"].includes(restored.status)) startPolling(restored.id);
    }
  } catch (cause) { error.value = cause instanceof Error ? cause.message : "API unavailable"; }
  finally { isLoading.value = false; }
});
onUnmounted(() => { if (poll) window.clearInterval(poll); });
</script>

<template>
  <main class="shell">
    <header class="topbar">
      <div class="brand"><span class="brand-mark" aria-hidden="true">▲</span><span>thaw<span class="brand-dot">.</span>fun</span></div>
      <div class="network-stack"><div class="network" :class="{ offline: !environment }"><span class="pulse" aria-hidden="true"></span>{{ environment ? `${environment.network} / api linked` : "api unlinked" }}</div><strong v-if="!isLoading && !chainsLoaded" class="mode-label">STATE UNAVAILABLE · ACTIONS LOCKED</strong><strong v-else-if="unsupportedNetwork" class="mode-label">NETWORK UNSUPPORTED · ACTIONS LOCKED</strong><strong v-else-if="fujiReadOnly" class="mode-label">VIEW ONLY · ACTIONS LOCKED</strong></div>
    </header>
    <nav class="phase-rail" aria-label="L1 lifecycle">
      <template v-for="(item, index) in phases" :key="item">
        <div class="phase" :class="{ current: item === phase, passed: index < phaseIndex }"><span class="phase-number">0{{ index + 1 }}</span><span>{{ item }}</span></div>
        <span v-if="index < phases.length - 1" class="rail" :class="{ filled: index < phaseIndex }" aria-hidden="true"></span>
      </template>
    </nav>

    <section v-if="phase === 'BIRTH'" class="birth-layout">
      <div class="hero-copy">
        <p class="eyebrow">Disposable Avalanche L1</p>
        <h1>Give a chain<br><em>just enough time.</em></h1>
        <p class="lede">Launch a real disposable L1. Let it produce blocks. At expiry, verify the validator, node, and RPC actually stop.</p>
        <div v-if="fujiCreateStarted" class="read-only-callout" role="status"><strong>FUJI REQUEST STARTED · DO NOT RESUBMIT</strong><span>The request may have reached the API even if a response or status refresh failed. Check the existing record through the API and your foreground API terminal; reconcile this attempt before any further action.</span><code v-if="submittedFujiChainId">RECORD ID: {{ submittedFujiChainId }}</code></div>
        <div v-else-if="!isLoading && !chainsLoaded" class="read-only-callout" role="status"><strong>CHAIN STATE UNAVAILABLE</strong><span>Existing records could not be checked. Create stays locked until the API state loads.</span></div>
        <div v-else-if="unsupportedNetwork" class="read-only-callout" role="status"><strong>NETWORK NOT SUPPORTED</strong><span>This page cannot create a chain on the reported network.</span></div>
        <div v-else-if="fujiReadOnly" class="read-only-callout" role="status"><strong>FUJI IS IN VIEW-ONLY MODE</strong><span>The API is connected, but it has disabled Create and cleanup. Opening this page does not launch an L1.</span></div>
        <div v-else-if="environment?.network === 'fuji' && fujiMutationEnabled" class="read-only-callout" role="status"><strong>REAL FUJI OPERATION</strong><span>Clicking Create sends a real Fuji request that may initiate P-Chain writes. Watch your own foreground API terminal and respond only to an expected password prompt there.</span></div>
        <div v-else class="truth-line"><span>NO TESTNET THEATER</span><span>NO IMMORTAL DEV CHAINS</span></div>
      </div>
      <form class="birth-card" @submit.prevent>
        <div class="card-kicker"><span>Birth certificate</span><span>01 / 04</span></div>
        <label><span>Name</span><input v-model="name" maxlength="40" autocomplete="off" placeholder="Frostbite"></label>
        <label><span>Symbol</span><input v-model="symbol" maxlength="10" autocomplete="off" placeholder="FRST" @input="symbol = symbol.toUpperCase()"></label>
        <label><span>Lifetime <b>{{ lifetimeLabel }}</b></span><input v-model.number="lifetimeSeconds" type="number" min="60" max="604800" step="60"><small>60 seconds — 7 days. Mortality is configurable.</small></label>
        <button class="primary" type="button" :disabled="!canCreate" @click="createChain"><span>{{ isSubmitting ? "REQUESTING BIRTH" : fujiCreateStarted && environment?.network === 'fuji' ? "FUJI REQUEST STARTED" : !chainsLoaded && !isLoading ? "CHAIN STATE UNAVAILABLE" : unsupportedNetwork ? "NETWORK NOT SUPPORTED" : fujiReadOnly ? "CREATE LOCKED BY API" : environment?.network === 'fuji' ? "CREATE FUJI L1" : "CREATE L1" }}</span><span aria-hidden="true">↗</span></button>
      </form>
    </section>

    <section v-else-if="chain?.status === 'FAILED'" class="state-page failure-page">
      <div class="state-heading"><p class="eyebrow">Lifecycle exception / API truth</p><h1>{{ chain.requiresRecovery ? "RECOVERY REQUIRED." : chain.network === 'fuji' ? "FUJI REQUEST FAILED." : "BIRTH FAILED." }}</h1><p>{{ chain.requiresRecovery ? "External mutation may have started. This environment must be reconciled before another chain can be created." : chain.network === 'fuji' ? "The API did not reach LIVE. This Fuji attempt remains recorded for operator review." : "The infrastructure did not reach LIVE. No chain data has been invented to fill the gap." }}</p></div>
      <div class="failure-code"><span>API STATUS</span><strong>{{ chain.requiresRecovery ? "FAILED / BLOCKED" : "FAILED" }}</strong><code>{{ chain.failureReason ?? "REASON NOT REPORTED" }}</code></div>
      <p v-if="chain.network === 'fuji'" class="decision-note">{{ chain.requiresRecovery ? "DO NOT RETRY. Preserve this record and reconcile the external state before any further action." : "This Fuji attempt is recorded. Operator review is required; do not send a second Create request." }}</p>
      <button v-if="!chain.requiresRecovery && chain.network === 'local'" class="secondary" type="button" @click="resetToBirth">RETURN TO BIRTH</button>
    </section>

    <section v-else-if="phase === 'CREATING'" class="state-page creating-page">
      <div class="state-heading"><p class="eyebrow">Request accepted / API truth</p><h1>MAKING<br>WEATHER.</h1><p>The API is processing this request. A live chain has not been confirmed yet; there is no decorative progress bar because the API does not provide one.</p></div>
      <div class="orbit" aria-hidden="true"><div class="orbit-core">▲</div></div>
      <div class="status-strip">
        <span><i></i> API STATUS</span><strong>{{ chain?.status }}</strong><code>{{ chain?.id }}</code>
        <p v-if="chain?.network === 'fuji'" class="operator-note">A foreground signature may be needed in the operator terminal. Check the actual prompt; do not resubmit Create. This page changes only when the API state changes.</p>
      </div>
    </section>

    <section v-else class="state-page chain-page" :class="{ 'dead-page': phase === 'DEAD' }">
      <div class="state-heading">
        <p class="eyebrow">{{ chain?.status === 'EXPIRING' ? 'Lifecycle cleanup / API truth' : phase === 'LIVE' ? 'The temporary sovereign' : 'Post-mortem / persisted' }}</p>
        <h1>{{ chain?.status === 'EXPIRING' ? 'EXPIRING.' : phase === 'LIVE' ? chain?.name : 'IT LIVED.' }}</h1>
        <p v-if="chain?.status === 'EXPIRING'">Lifetime elapsed; cleanup is not yet confirmed.<span v-if="chain?.network === 'fuji'" class="cleanup-copy">{{ fujiCleanupMessage }}</span></p><p v-else-if="phase === 'LIVE'">Real chain. Real blocks. Very limited career prospects.</p><p v-else>{{ chain?.name }} completed its assigned lifespan. Nothing has been rounded up for the obituary.</p>
      </div>
      <div class="metric-hero">
        <div><span>{{ chain?.status === "EXPIRING" ? "CLEANUP" : phase === "LIVE" ? "TIME REMAINING" : "FINAL BLOCK" }}</span><strong>{{ chain?.status === "EXPIRING" ? "PENDING" : phase === "LIVE" ? remaining : (displayBlock ?? "—") }}</strong></div>
        <div class="seal" :class="{ stopped: phase === 'DEAD', unverified: phase !== 'DEAD' && !chain?.rpcHealthy }"><span>{{ phase === "DEAD" ? "RPC" : chain?.rpcHealthy ? "RPC" : "RPC?" }}</span><b>{{ phase === "DEAD" ? "STOPPED" : chain?.rpcHealthy ? "HEALTHY" : "UNVERIFIED" }}</b></div>
      </div>
      <div class="facts">
        <button v-if="chain?.network === 'fuji'" type="button" @click="copyValue('network', chain.network)"><span>NETWORK</span><strong>FUJI</strong><small>{{ copied === "network" ? "COPIED" : "COPY" }}</small></button>
        <button type="button" @click="copyValue('chain', chain?.evmChainId)"><span>EVM CHAIN ID</span><strong>{{ chain?.evmChainId }}</strong><small>{{ copied === "chain" ? "COPIED" : "COPY" }}</small></button>
        <button type="button" @click="copyValue('block', displayBlock)"><span>{{ phase === "DEAD" ? "FINAL BLOCK" : "LATEST BLOCK" }}</span><strong>{{ displayBlock ?? "NOT REPORTED" }}</strong><small v-if="displayBlock !== undefined">{{ copied === "block" ? "COPIED" : "COPY" }}</small></button>
        <button type="button" @click="copyValue('subnet', chain?.subnetId)"><span>SUBNET ID</span><strong>{{ chain?.subnetId ?? "NOT REPORTED" }}</strong><small v-if="chain?.subnetId">{{ copied === "subnet" ? "COPIED" : "COPY" }}</small></button>
        <button type="button" @click="copyValue('blockchain', chain?.blockchainId)"><span>BLOCKCHAIN ID</span><strong>{{ chain?.blockchainId ?? "NOT REPORTED" }}</strong><small v-if="chain?.blockchainId">{{ copied === "blockchain" ? "COPIED" : "COPY" }}</small></button>
        <button v-if="chain?.network === 'fuji'" type="button" @click="copyValue('manager', chain.validatorManagerAddress)"><span>VALIDATOR MANAGER</span><strong>{{ chain.validatorManagerAddress ?? "NOT REPORTED" }}</strong><small v-if="chain.validatorManagerAddress">{{ copied === "manager" ? "COPIED" : "COPY" }}</small></button>
        <button v-if="chain?.network === 'fuji'" type="button" @click="copyValue('validation', chain.validatorId)"><span>VALIDATION ID</span><strong>{{ chain.validatorId ?? "NOT REPORTED" }}</strong><small v-if="chain.validatorId">{{ copied === "validation" ? "COPIED" : "COPY" }}</small></button>
        <button v-if="chain?.network === 'fuji'" class="wide" type="button" @click="copyValue('node', chain.validatorNodeId)"><span>VALIDATOR NODE ID</span><strong>{{ chain.validatorNodeId ?? "NOT REPORTED" }}</strong><small v-if="chain.validatorNodeId">{{ copied === "node" ? "COPIED" : "COPY" }}</small></button>
        <button class="wide" type="button" @click="copyValue('rpc', chain?.rpcUrl)"><span>RPC ENDPOINT</span><strong>{{ chain?.rpcUrl ?? "NOT REPORTED" }}</strong><small v-if="chain?.rpcUrl">{{ copied === "rpc" ? "COPIED" : "COPY" }}</small></button>
      </div>
      <div class="action-row">
        <div class="api-truth"><span>API STATE</span><strong>{{ chain?.status }}</strong><small v-if="chain?.status === 'EXPIRING'">{{ chain.network === 'fuji' ? isExpiring ? 'Cleanup request sent. Check the operator terminal for a signing prompt.' : fujiCleanupMessage : 'Termination is running. Waiting for the API.' }}</small></div>
        <button v-if="chain?.status === 'LIVE' && (chain.network === 'local' || (chain.network === 'fuji' && fujiMutationEnabled))" class="danger" type="button" :disabled="isExpiring" @click="expireNow">{{ isExpiring ? "TERMINATING…" : "TERMINATE EARLY" }}</button>
        <button v-else-if="chain?.status === 'EXPIRING' && chain.network === 'fuji' && fujiMutationEnabled && chain.canContinueExpiration" class="danger" type="button" :disabled="isExpiring" @click="expireNow">{{ isExpiring ? "CLEANUP REQUESTED…" : "CONTINUE CLEANUP" }}</button>
        <button v-else-if="phase === 'DEAD' && chain?.network === 'local'" class="secondary" type="button" @click="resetToBirth">CREATE ANOTHER</button>
      </div>
    </section>
    <aside v-if="error" class="error-panel" role="alert"><span>EXCEPTION</span><strong>{{ error }}</strong></aside>
    <footer><span>AVALANCHE L1 INFRASTRUCTURE</span><span>BUILD → RUN → REMOVE</span><span>{{ footerNetwork }}</span></footer>
  </main>
</template>

<style>
@import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Space+Grotesk:wght@400;500;600;700&display=swap');
:root { color-scheme: dark; font-family: "Space Grotesk", Arial, sans-serif; background: #090909; color: #f4f1eb; font-synthesis: none; }
* { box-sizing: border-box; } body { margin: 0; min-width: 320px; min-height: 100vh; background: #090909; } button, input { font: inherit; } button { color: inherit; }
.shell { min-height: 100vh; display: flex; flex-direction: column; background: radial-gradient(circle at 76% 32%, rgba(232, 43, 35, .12), transparent 28%), #090909; overflow: hidden; }
.topbar { height: 88px; display: flex; align-items: center; justify-content: space-between; padding: 0 4vw; border-bottom: 1px solid #343434; }
.brand { display: flex; align-items: center; gap: 13px; font-size: 27px; font-weight: 700; letter-spacing: -1.5px; }
.brand-mark { display: grid; place-items: center; width: 34px; height: 34px; color: #090909; background: #ed2d25; font-size: 18px; clip-path: polygon(50% 0, 100% 100%, 0 100%); padding-top: 9px; }.brand-dot { color: #ed2d25; }
.network-stack { display: grid; justify-items: end; gap: 8px; }.network { display: flex; align-items: center; gap: 9px; font: 500 12px/1 "DM Mono", monospace; letter-spacing: .08em; text-transform: uppercase; }.mode-label { color: #f4f1eb; font: 500 12px/1 "DM Mono", monospace; letter-spacing: .04em; }.pulse { width: 8px; height: 8px; border-radius: 50%; background: #63dc88; box-shadow: 0 0 0 4px rgba(99, 220, 136, .12); }.network.offline .pulse { background: #ed2d25; box-shadow: none; }
.phase-rail { height: 74px; display: flex; align-items: center; padding: 0 4vw; border-bottom: 1px solid #343434; }.phase { display: flex; gap: 8px; align-items: center; color: #666; font: 500 11px/1 "DM Mono", monospace; letter-spacing: .08em; }.phase-number { font-size: 9px; }.phase.current { color: #f4f1eb; }.phase.current::after { content: ""; width: 6px; height: 6px; background: #ed2d25; border-radius: 50%; }.phase.passed { color: #a8a8a8; }.rail { height: 1px; flex: 1; max-width: 120px; margin: 0 17px; background: #333; }.rail.filled { background: #ed2d25; }
.birth-layout, .state-page { flex: 1; min-height: 610px; }.birth-layout { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(360px, .75fr); }.hero-copy { padding: clamp(70px, 9vw, 150px) 6vw 60px 7vw; border-right: 1px solid #343434; }
.eyebrow { color: #ed2d25; margin: 0 0 25px; font: 500 12px/1 "DM Mono", monospace; letter-spacing: .15em; text-transform: uppercase; } h1 { max-width: 970px; margin: 0; font-size: clamp(58px, 7.1vw, 118px); line-height: .86; letter-spacing: -.075em; text-transform: uppercase; } h1 em { color: #ed2d25; font-style: normal; }.lede { max-width: 650px; margin: 37px 0 0; color: #bcbcbc; font-size: clamp(18px, 1.5vw, 23px); line-height: 1.45; }.truth-line { display: flex; gap: 35px; margin-top: 70px; color: #838383; font: 500 10px/1 "DM Mono", monospace; letter-spacing: .1em; }.read-only-callout { display: grid; gap: 10px; max-width: 650px; margin-top: 34px; padding: 17px 20px; border-left: 4px solid #ed2d25; background: #1b1414; }.read-only-callout strong { color: #f4f1eb; font: 500 14px/1.2 "DM Mono", monospace; letter-spacing: .06em; }.read-only-callout span { color: #d0c8c5; font-size: 16px; line-height: 1.4; }
.birth-card { align-self: center; margin: 60px 5vw; border: 1px solid #444; background: rgba(16, 16, 16, .9); box-shadow: 12px 12px 0 #ed2d25; }.card-kicker { display: flex; justify-content: space-between; padding: 17px 20px; border-bottom: 1px solid #444; color: #aaa; font: 500 11px/1 "DM Mono", monospace; letter-spacing: .1em; text-transform: uppercase; }.birth-card label { display: grid; gap: 10px; padding: 20px; border-bottom: 1px solid #333; color: #b3b3b3; font: 500 12px/1 "DM Mono", monospace; letter-spacing: .08em; text-transform: uppercase; }.birth-card label > span { display: flex; justify-content: space-between; }.birth-card label b { color: #f4f1eb; }.birth-card input { width: 100%; border: 0; outline: 0; color: #f4f1eb; background: transparent; font: 600 clamp(25px, 2.5vw, 39px)/1.15 "Space Grotesk", sans-serif; letter-spacing: -.04em; }.birth-card small { color: #aaa; font-size: 11px; letter-spacing: .03em; text-transform: none; }.primary, .danger, .secondary { display: flex; justify-content: space-between; align-items: center; width: 100%; border: 0; padding: 24px 21px; font-weight: 700; letter-spacing: .06em; cursor: pointer; }.primary { color: white; background: #ed2d25; }.primary:hover:not(:disabled), .danger:hover:not(:disabled) { background: #ff3b32; } button:disabled { opacity: .58; cursor: not-allowed; }
.state-page { position: relative; padding: clamp(55px, 7vw, 100px) 7vw 55px; }.creating-page { min-height: 520px; display: grid; grid-template-columns: 1.1fr .9fr; align-items: center; }.state-heading p:last-child { max-width: 600px; color: #bcbcbc; font-size: 20px; line-height: 1.45; }.cleanup-copy { display: block; margin-top: 15px; color: #f0c883; }.creating-page h1 { color: #f4f1eb; }.failure-page { display: flex; flex-direction: column; justify-content: center; align-items: flex-start; }.failure-page h1 { color: #ed2d25; }.failure-code { width: min(760px, 100%); display: grid; grid-template-columns: auto auto 1fr; gap: 18px; margin: 35px 0 20px; padding: 20px; border: 1px solid #ed2d25; font: 500 13px/1.5 "DM Mono", monospace; }.failure-code span { color: #aaa; }.failure-code code { overflow-wrap: anywhere; color: #d0d0d0; }.decision-note { max-width: 760px; margin: 0 0 25px; color: #f4f1eb; font: 500 14px/1.5 "DM Mono", monospace; }.failure-page .secondary { margin-top: 8px; }.orbit { justify-self: center; display: grid; place-items: center; width: min(35vw, 470px); aspect-ratio: 1; border: 1px solid #3b3b3b; border-radius: 50%; animation: spin 9s linear infinite; }.orbit::before, .orbit::after { content: ""; position: absolute; border: 1px dashed #555; border-radius: 50%; }.orbit::before { width: 72%; height: 72%; }.orbit::after { width: 20px; height: 20px; top: 3%; background: #ed2d25; border: 0; }.orbit-core { display: grid; place-items: center; width: 45%; height: 45%; color: #ed2d25; font-size: 70px; border: 1px solid #ed2d25; border-radius: 50%; animation: spin 9s linear infinite reverse; } @keyframes spin { to { transform: rotate(360deg); } }
.status-strip { position: absolute; left: 7vw; right: 7vw; bottom: 45px; display: grid; grid-template-columns: auto auto 1fr; gap: 25px; align-items: center; padding-top: 18px; border-top: 1px solid #333; font: 500 13px/1.4 "DM Mono", monospace; }.status-strip span { color: #aaa; }.status-strip i { display: inline-block; width: 7px; height: 7px; margin-right: 8px; border-radius: 50%; background: #ed2d25; animation: blink 1.2s infinite; }.status-strip code { justify-self: end; color: #aaa; overflow-wrap: anywhere; }.status-strip .operator-note { grid-column: 1 / -1; max-width: 780px; margin: -6px 0 0; color: #f0c883; font: 500 15px/1.5 "DM Mono", monospace; letter-spacing: 0; } @keyframes blink { 50% { opacity: .25; } }
.chain-page .state-heading { display: grid; grid-template-columns: 1.3fr .7fr; gap: 20px; align-items: end; }.chain-page .state-heading .eyebrow { grid-column: 1 / -1; margin-bottom: -4px; }.chain-page h1 { font-size: clamp(56px, 6.8vw, 110px); overflow-wrap: anywhere; }.chain-page .state-heading p:last-child { justify-self: end; }.metric-hero { display: flex; align-items: center; justify-content: space-between; gap: 35px; margin: 55px 0 0; padding: 30px 0; border-top: 1px solid #444; border-bottom: 1px solid #444; }.metric-hero > div:first-child span, .facts span, .api-truth span { display: block; color: #999; margin-bottom: 8px; font: 500 11px/1 "DM Mono", monospace; letter-spacing: .09em; }.metric-hero > div:first-child strong { font-size: clamp(56px, 8vw, 125px); line-height: .85; letter-spacing: -.06em; }.seal { flex: 0 0 118px; display: grid; place-items: center; aspect-ratio: 1; color: #63dc88; border: 1px solid currentColor; border-radius: 50%; transform: rotate(-8deg); font: 500 10px/1.4 "DM Mono", monospace; }.seal span { font-size: 25px; font-weight: 700; }.seal.stopped { color: #ed2d25; }.seal.unverified { color: #aaa; }
.facts { display: grid; grid-template-columns: repeat(2, 1fr); border-left: 1px solid #333; }.facts button { min-width: 0; position: relative; display: block; text-align: left; padding: 19px 45px 19px 18px; border: 0; border-right: 1px solid #333; border-bottom: 1px solid #333; background: transparent; cursor: pointer; }.facts button:hover { background: #141414; }.facts button.wide { grid-column: 1 / -1; }.facts strong { display: block; overflow: hidden; text-overflow: ellipsis; color: #e5e1dc; font: 500 14px/1.3 "DM Mono", monospace; white-space: nowrap; }.facts small { position: absolute; top: 20px; right: 14px; color: #ed2d25; font: 500 9px/1 "DM Mono", monospace; }.action-row { display: flex; justify-content: space-between; align-items: center; gap: 30px; margin-top: 25px; }.api-truth { display: grid; grid-template-columns: auto auto; align-items: baseline; column-gap: 12px; row-gap: 10px; font: 500 13px/1.3 "DM Mono", monospace; }.api-truth span { margin: 0; }.api-truth small { grid-column: 1 / -1; max-width: 640px; color: #c6c6c6; font-size: 13px; line-height: 1.45; }.danger, .secondary { width: auto; min-width: 225px; justify-content: center; padding: 19px 25px; }.danger { background: #ed2d25; }.secondary { background: #f4f1eb; color: #090909; }.dead-page { background: linear-gradient(110deg, rgba(237,45,37,.08), transparent 40%); }
.error-panel { margin: 0 7vw 30px; display: grid; grid-template-columns: auto 1fr auto; gap: 20px; align-items: center; padding: 15px 18px; border: 1px solid #ed2d25; color: #ed2d25; font: 500 11px/1.4 "DM Mono", monospace; }.error-panel span { font-size: 9px; }.error-panel button { border: 0; padding: 9px 12px; background: #ed2d25; color: white; cursor: pointer; } footer { display: flex; justify-content: space-between; padding: 18px 4vw; border-top: 1px solid #343434; color: #656565; font: 500 9px/1 "DM Mono", monospace; letter-spacing: .08em; }
@media (max-width: 820px) { .topbar { height: 70px; }.phase-rail { overflow-x: auto; }.rail { min-width: 22px; margin: 0 9px; }.birth-layout { grid-template-columns: 1fr; }.hero-copy { padding: 65px 6vw; border-right: 0; border-bottom: 1px solid #343434; }.birth-card { margin: 45px 7vw 65px; }.creating-page { grid-template-columns: 1fr; padding-bottom: 150px; }.orbit { position: absolute; right: -12vw; top: 210px; width: 55vw; opacity: .5; }.chain-page .state-heading { grid-template-columns: 1fr; }.chain-page .state-heading p:last-child { justify-self: start; }.facts { grid-template-columns: 1fr; }.facts button.wide { grid-column: auto; }.action-row { align-items: stretch; flex-direction: column; }.danger, .secondary { width: 100%; } }
@media (max-width: 520px) { .network { font-size: 10px; letter-spacing: .02em; }.mode-label { font-size: 9px; }.network .pulse { display: block; }.phase-number { display: none; }.truth-line, footer span:nth-child(2) { display: none; }.birth-card { margin-left: 4vw; margin-right: 7vw; }.metric-hero { align-items: flex-end; }.seal { flex-basis: 84px; }.seal span { font-size: 18px; }.failure-code { grid-template-columns: 1fr; }.status-strip { grid-template-columns: auto 1fr; }.status-strip code { grid-column: 1 / -1; justify-self: start; }.error-panel { grid-template-columns: 1fr; } }
@media (prefers-reduced-motion: reduce) { .orbit, .orbit-core, .status-strip i { animation: none; } }
</style>
