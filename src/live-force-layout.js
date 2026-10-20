import { partitionForceLayoutGraph } from "./distributed-force-layout.js";
import { CONVERGENCE_OBSERVATION_SOURCES, SEMANTIC_CONVERGENCE_CHANGED_EVENT } from "./semantic-convergence-service.js";
import { LOCAL_SHEAF_GLUE_CHANGED_EVENT } from "./local-sheaf-glue-service.js";
import { normalizeClaimant, RESOURCE_CLAIMS_CHANGED_EVENT } from "./resource-claim-manager.js";
import { parseResourceId } from "./resource-ids.js";
import { peerHolderId } from "./peer-context.js";
import { DEFAULT_LAYOUT_SETTINGS, LAYOUT_SCHEMAS, layoutCoordinateSignature, normalizeLayoutSettings } from "./layout-schema.js";
import { coordinateSnapshot, filterLayoutResult, changedLayoutResult, layoutResultSize } from "./force-layout-controller.js";

export const LIVE_FORCE_LAYOUT_DEFAULTS = Object.freeze({ ...DEFAULT_LAYOUT_SETTINGS,
  enabled: true, globalCoherence: 0.08, commitIntervalMs: 250 });
export const LIVE_FORCE_LAYOUT_DEFAULT_STORAGE_KEY = "golog.live-force-layout.defaults.v2";
export const LIVE_FORCE_LAYOUT_SETTING_KEYS = Object.freeze([...Object.keys(DEFAULT_LAYOUT_SETTINGS), "globalCoherence"]);
export const LIVE_FORCE_LAYOUT_SETTINGS_CHANGED_EVENT = "live-force-layout:settings-changed";
const resolve = (value) => typeof value === "function" ? value() : value;
const clock = () => globalThis.performance?.now?.() ?? Date.now();
const countKey = (store) => [store.spheres.size, store.edges.size, store.surfaces.size, store.volumes?.size ?? 0].join(":");
const different = (a, b, tolerance = 1e-6) => !a || a.length !== b.length || Math.hypot(...b.map((x, i) => x - a[i])) > tolerance;
function settingValues(settings = {}) {
  const result = normalizeLayoutSettings(settings);
  for (const key of ["globalCoherence", "commitIntervalMs"]) {
    const value = settings[key] ?? LIVE_FORCE_LAYOUT_DEFAULTS[key];
    if (!Number.isFinite(Number(value)) || Number(value) < 0) throw new Error(`Invalid layout setting: ${key}`);
    result[key] = Number(value);
  }
  return { ...result, enabled: settings.enabled ?? true };
}
export function readLiveForceLayoutDefaultSettings(storage) {
  try { return storage?.getItem ? settingValues(JSON.parse(storage.getItem(LIVE_FORCE_LAYOUT_DEFAULT_STORAGE_KEY) ?? "{}")) : {}; }
  catch { return {}; }
}
export function writeLiveForceLayoutDefaultSettings(storage, settings = {}) {
  if (!storage?.setItem) return { ok: false, reason: "storage-unavailable" };
  const defaults = settingValues(settings);
  try { storage.setItem(LIVE_FORCE_LAYOUT_DEFAULT_STORAGE_KEY, JSON.stringify(defaults)); return { ok: true, defaults }; }
  catch (error) { return { ok: false, reason: "storage-write-failed", error: error.message }; }
}
function sharedIntents(store, strength) {
  return (store.semanticConvergence?.intents?.({ strength }) ?? []).filter((intent) =>
    intent.observationSources?.[CONVERGENCE_OBSERVATION_SOURCES.GLOBAL_COMMIT] > 0);
}

// Main and expanded layers share input tracking, numerical execution and barriers.
// Publication remains an authority concern of the enclosing live service.
class LayoutLayer {
  constructor(owner, golog) {
    Object.assign(this, { owner, golog, controller: null, quiescent: false, topologyDirty: true,
      inputsDirty: true, pendingIds: new Set(), observed: new Map(), observedObjects: new Map(), signatures: new Map(),
      pinIds: new Set(), lastFlushAt: -Infinity, lastStepAt: -Infinity, lastResult: null,
      snapshotVersion: 0, snapshotPending: null, releases: [] });
    const on = (type, handler) => this.releases.push(golog.bus.on(type, handler));
    on("store:object-upserted", (record) => this.observe(record));
    on("store:object-deleted", (record) => {
      if (LAYOUT_SCHEMAS[record.elementKind]) { this.topologyDirty = true; this.wake(); }
    });
    on("state:changed", () => {
      if (countKey(golog.state) !== this.counts) { this.topologyDirty = true; this.wake(); }
    });
    const inputEvents = [RESOURCE_CLAIMS_CHANGED_EVENT, LOCAL_SHEAF_GLUE_CHANGED_EVENT];
    if (owner.publicationMode !== "local") inputEvents.push(SEMANTIC_CONVERGENCE_CHANGED_EVENT);
    for (const event of inputEvents) {
      on(event, () => { this.inputsDirty = true; this.snapshotVersion++; this.owner.schedule(); });
    }
  }
  settings() { return typeof this.owner.settings === "function" ? this.owner.settings() : this.owner.settings; }
  wake(ids = null) { this.snapshotVersion++; this.quiescent = false; this.controller?.wake(ids); this.owner.schedule(); }
  observe(object) {
    object = this.golog.state.objects.get(object.id);
    if (!object || this.observedObjects.get(object.id) === object) return;
    const schema = LAYOUT_SCHEMAS[object.elementKind];
    if (!schema) return;
    const record = this.golog.state[schema.collection].get(object.id);
    if (!record) return;
    if (this.signatures.get(object.id) !== schema.boundarySignature(record)) {
      this.topologyDirty = true; this.wake();
    }
    const next = schema.dof ? layoutCoordinateSignature({ id: object.id, schema }, this.golog.state) : [];
    if (different(this.observed.get(object.id), next)) {
      this.observed.set(object.id, next); this.pendingIds.add(object.id); this.inputsDirty = true;
      // The next input upload wakes the union once, after this event burst.
      this.snapshotVersion++; this.quiescent = false; this.owner.schedule();
    }
    this.observedObjects.set(object.id, object);
  }
  updatePins() {
    const store = this.golog.state, pins = new Set();
    let expiry = Infinity;
    for (const record of store.localSheafGlue?.activeInteractionRecords?.({ localOnly: this.owner.publicationMode === "local" }) ?? []) {
      expiry = Math.min(expiry, Number(record.expiresAt ?? Infinity));
      for (const resource of [record.resourceId, record.targetResourceId]) {
        if (!resource) continue;
        try {
          const parsed = parseResourceId(resource);
          if (parsed.gologId === store.gologId && parsed.objectId) pins.add(parsed.objectId);
        } catch { /* Non-coordinate authority resources do not pin layout. */ }
      }
    }
    this.pinIds = pins;
    if (this.pinTimer) clearTimeout(this.pinTimer);
    if (Number.isFinite(expiry)) {
      this.pinTimer = setTimeout(() => { this.inputsDirty = true; this.snapshotVersion++; this.owner.schedule(); }, Math.max(1, expiry - Date.now() + 1));
      this.pinTimer.unref?.();
    }
  }
  ensureController() {
    if (countKey(this.golog.state) !== this.counts) this.topologyDirty = true;
    if (this.topologyRevision !== this.golog.state.topologyRevision) this.topologyDirty = true;
    const origin = this.owner.operationOrigin?.() ?? resolve(this.owner.origin);
    const originKey = JSON.stringify(origin ?? null);
    if (this.controller && this.originKey !== originKey) this.controller.origin = origin;
    if (!this.controller || this.topologyDirty) {
      if (this.controller) { this.flush(); this.controller.dispose?.(); }
      this.controller = this.owner.createForceLayout(this.golog, { gpu: true, ...(origin ? { origin } : {}) });
      this.controller.localInteraction = this.owner.publicationMode === "local";
      this.controller.refreshInputs = () => this.ensureController();
      this.controller.onResidentMotion = () => {
        this.quiescent = false; this.snapshotVersion++; this.owner.schedule();
      };
      this.controller.reset({ settings: this.settings() });
      this.snapshotError = null;
      this.originKey = originKey; this.counts = countKey(this.golog.state);
      this.topologyRevision = this.golog.state.topologyRevision;
      this.topologyDirty = false; this.inputsDirty = true; this.quiescent = false;
      this.observed.clear(); this.observedObjects.clear(); this.signatures.clear();
      for (const row of this.controller.ledger.rows) {
        const record = this.golog.state[row.schema.collection].get(row.id);
        this.observed.set(row.id, row.dof ? layoutCoordinateSignature(row, this.golog.state) : []);
        this.observedObjects.set(row.id, this.golog.state.objects.get(row.id));
        this.signatures.set(row.id, row.schema.boundarySignature(record));
        if (this.owner.publicationMode !== "local" && this.owner.lastPublishedPositionSnapshot && !this.owner.lastPublishedPositionSnapshot.has(row.id)) {
          this.owner.lastPublishedPositionSnapshot.set(row.id, this.observed.get(row.id));
        }
      }
      this.pendingIds.clear();
    }
    this.originKey = originKey;
    if (this.renderSuspended) {
      this.controller.renderAdapter?.(this.controller.resident ? this.controller.simulation : null,
        () => this.controller.flush(), this.controller);
      this.renderSuspended = false;
    }
    if (this.inputsDirty) {
      this.updatePins();
      const external = this.owner.externalIntentProvider?.({ golog: this.golog, store: this.golog.state,
        entry: this, universe: this.owner }) ?? [];
      this.controller.syncInputs({ ids: [...this.pendingIds], pinIds: [...this.pinIds],
        externalIntents: [this.owner.publicationMode === "local" ? []
          : sharedIntents(this.golog.state, this.settings().globalCoherence), external] });
      this.pendingIds.clear(); this.inputsDirty = false;
      this.quiescent = this.controller.diagnostics?.().activeGroupCount === 0;
    }
    return this.controller;
  }
  apply(result) {
    if (!result) return result;
    for (const row of this.controller.ledger.rows) {
      const object = this.golog.state.objects.get(row.id);
      if (object) this.observe(object);
    }
    const residentDrags = this.owner.publicationMode === "local" && this.controller.resident
      ? this.controller.simulation?.dragIds : null;
    const filtered = filterLayoutResult(result, (entry) => (!this.pinIds.has(entry.id) || residentDrags?.has(entry.id)) && !this.pendingIds.has(entry.id)
      && this.golog.state.hasSelectableSimplex(entry.id));
    const store = this.golog.state;
    store.applyLayoutPreviewPositions?.(filtered.positions, filtered.edgeControls, filtered.surfaceControls);
    // Store geometry transports published gauges to its exact boundary. Record
    // that canonical result so our queued events do not masquerade as input.
    for (const row of this.controller.ledger.rows) {
      const object = store.objects.get(row.id);
      if (!object || this.observedObjects.get(row.id) === object) continue;
      const signature = row.dof ? layoutCoordinateSignature(row, store) : [];
      if (signature) { this.observed.set(row.id, signature); this.observedObjects.set(row.id, object); }
    }
    this.lastResult = filtered;
    return filtered;
  }
  flush() {
    if (!this.controller) return null;
    this.snapshotVersion++;
    // A synchronous save/pick may precede the queued domain events.
    for (const row of this.controller.ledger.rows) {
      const object = this.golog.state.objects.get(row.id);
      if (object) this.observe(object);
    }
    this.updatePins();
    const result = this.apply(this.controller.flush());
    this.lastFlushAt = clock();
    return result;
  }
  publishSnapshot() {
    if (this.snapshotPending) return;
    const controller = this.controller, version = this.snapshotVersion;
    const current = () => this.controller === controller && this.snapshotVersion === version && !this.disposed;
    this.lastFlushAt = clock();
    this.snapshotPending = controller.snapshot().then((result) => {
      if (!current()) return;
      // A queued human edit can precede its domain event.
      for (const row of controller.ledger.rows) {
        const object = this.golog.state.objects.get(row.id);
        if (object) this.observe(object);
      }
      if (current()) {
        const applied = this.apply(result);
        this.owner.publish?.(applied);
      }
    }).catch((error) => { if (current()) this.snapshotError = error; })
      .finally(() => { this.snapshotPending = null; });
  }
  step() {
    if (this.snapshotError) throw this.snapshotError;
    const controller = this.ensureController();
    if (this.quiescent) return this.lastResult;
    const result = controller.step({ resident: true, steps: 4 });
    this.quiescent = result.diagnostics?.activeGroupCount === 0;
    this.lastStepAt = clock();
    if (!controller.resident) return this.apply(result);
    // Static browser geometry reads the resident buffers directly. Canonical
    // coordinates are synchronized only for an explicit semantic/save barrier.
    if (this.owner.publicationMode === "local") return result;
    if (this.quiescent) return this.flush();
    if (clock() - this.lastFlushAt >= this.settings().commitIntervalMs) this.publishSnapshot();
    return result;
  }
  setOptions() {
    this.controller?.setOptions?.(this.settings());
    this.inputsDirty = true; this.wake();
  }
  reset() { this.topologyDirty = true; this.wake(); }
  suspend() {
    this.flush(); this.controller?.renderAdapter?.(null);
    this.renderSuspended = true; this.inputsDirty = true; this.quiescent = true;
  }
  dispose() { this.flush(); this.disposed = true; this.controller?.dispose?.(); this.releases.forEach((release) => release?.()); clearTimeout(this.pinTimer); }
}

export class LiveForceLayoutService {
  constructor({ workspace, modeHead, createForceLayout, frameRef = globalThis, defaults = {},
    storage = frameRef?.localStorage ?? null, origin = null, peerProvider = null, localPeerProvider = null,
    publicationMode = "shared" } = {}) {
    if (!["local", "shared"].includes(publicationMode)) throw new TypeError("Invalid coordinate publication mode");
    Object.assign(this, { workspace, modeHead, createForceLayout, frameRef, storage, origin, peerProvider,
      localPeerProvider, publicationMode, lastPartition: null, frameHandle: null, pendingPublication: false, lastClaimAttemptAt: -Infinity,
      lastCommitSubmittedAt: -Infinity, lastPublishedPositionSnapshot: new Map() });
    this.defaults = settingValues({ ...LIVE_FORCE_LAYOUT_DEFAULTS, ...readLiveForceLayoutDefaultSettings(storage), ...defaults });
    this.settings = { ...this.defaults };
    this.releases = [workspace?.bus?.on("workspace:active-changed", ({ golog }) => this.bindActiveGolog(golog)),
      workspace?.bus?.on("mode:changed", () => {
        if (!this.canRun()) this.layer?.suspend(); else this.layer?.wake(); this.schedule();
      })];
    this.bindActiveGolog(workspace?.activeGolog?.() ?? null);
  }
  get controller() { return this.layer?.controller ?? null; }
  get quiescent() { return this.layer?.quiescent ?? false; }
  get quietStepCount() { return this.quiescent ? this.settings.sleepSteps : 0; }
  get lastResult() { return this.layer?.lastResult ?? null; }
  snapshot() {
    return { ...this.settings, publicationMode: this.publicationMode, active: this.canRun(), solving: this.canRun() && !this.quiescent,
      quiescent: this.quiescent, quietStepCount: this.quietStepCount, distributedPeerCount: this.currentPeers().length,
      localPeerId: this.localPeer()?.peerId ?? null, diagnostics: this.controller?.diagnostics?.() ?? null,
      assignedNodeCount: this.lastPartition?.ownedIds.size ?? null };
  }
  emitSettingsChanged() { this.workspace?.bus?.emit(LIVE_FORCE_LAYOUT_SETTINGS_CHANGED_EVENT, this.snapshot()); }
  setEnabled(enabled) {
    if (!enabled) this.layer?.suspend();
    this.settings.enabled = Boolean(enabled);
    if (enabled) this.layer?.setOptions();
    else if (this.frameHandle != null) { this.frameRef.cancelAnimationFrame?.(this.frameHandle); this.frameHandle = null; }
    this.schedule(); this.emitSettingsChanged(); return this.snapshot();
  }
  setSettings(settings = {}) {
    const next = settingValues({ ...this.settings, ...settings });
    if (JSON.stringify(next) !== JSON.stringify(this.settings)) {
      this.settings = next;
      if (next.enabled) this.layer?.setOptions(); else this.layer?.suspend();
      this.schedule(); this.emitSettingsChanged();
    }
    return this.snapshot();
  }
  commitSettingsAsDefaults() {
    this.defaults = { ...this.settings };
    return { ...writeLiveForceLayoutDefaultSettings(this.storage, this.defaults), snapshot: this.snapshot() };
  }
  bindActiveGolog(golog) {
    clearTimeout(this.retryTimer); this.retryTimer = null;
    this.layer?.dispose(); this.activeGolog = golog ?? null;
    this.layer = golog ? new LayoutLayer(this, golog) : null;
    this.lastPublishedPositionSnapshot = new Map(); this.pendingPublication = false;
    this.lastCommitSubmittedAt = -Infinity; this.schedule();
  }
  currentPeers() { return this.publicationMode === "local" ? []
    : (this.peerProvider?.() ?? []).filter((peer) => peer?.peerId && peer.peerId !== "peer-unknown"); }
  localPeer() { const peer = this.publicationMode === "local" ? null : this.localPeerProvider?.(); return peer?.peerId ? peer : null; }
  localPeerCanSolve() { return this.localPeer()?.role !== "observer"; }
  operationOrigin() { return this.localPeer() ?? resolve(this.origin); }
  canRun() { return Boolean(!this.disposed && this.settings.enabled && this.localPeerCanSolve() && this.activeGolog?.state.spheres.size
    && (this.modeHead?.canRunForces?.() ?? true)); }
  ensureController() { return this.canRun() ? this.layer.ensureController() : null; }
  wakeSolver() { this.layer?.wake(); }
  resetSimulation() { this.layer?.reset(); }
  forceOptions() { return { settings: this.settings }; }
  currentIntervalMs() { return 16; }
  schedule() {
    if (this.frameHandle != null || !this.canRun() || (this.quiescent && !this.layer.inputsDirty && !this.layer.topologyDirty)) return;
    this.frameHandle = this.frameRef.requestAnimationFrame?.((time) => { this.frameHandle = null; this.tick(time); }) ?? null;
  }
  tick() { if (this.canRun()) this.step(); this.schedule(); }
  step() {
    if (!this.canRun()) return null;
    const result = this.layer.step();
    if (result && !result.resident) this.publish(result);
    return result;
  }
  flush() { return this.layer?.flush() ?? null; }
  publish(result) {
    // A local snapshot is already validated and installed by LayoutLayer.apply.
    if (!result || this.publicationMode === "local") return;
    const controller = this.controller, store = this.activeGolog.state;
    const owned = this.restrictToOwnedShard(result, controller);
    const patch = changedLayoutResult(owned, this.lastPublishedPositionSnapshot, this.quiescent ? 1e-6 : 0.015);
    this.pendingPublication = layoutResultSize(patch) > 0;
    if (!this.pendingPublication) return;
    const wait = this.settings.commitIntervalMs - (clock() - this.lastCommitSubmittedAt);
    if (wait > 0) { this.retryPublication(wait); return; }
    const operation = controller.createCommitOperation(patch, { layoutId: "live-force-layout", filterUnchanged: false });
    const decision = store.mutationPolicy?.evaluate?.(operation, { emit: false }) ?? { ok: true };
    if (decision.ok) {
      controller.submitCommitOperation(operation);
      for (const [id, value] of coordinateSnapshot(patch)) this.lastPublishedPositionSnapshot.set(id, value);
      this.pendingPublication = false; this.lastCommitSubmittedAt = clock();
    } else {
      this.ensureCommitClaims(store, operation, decision);
      if (decision.reason === "missing-resource-claim") this.retryPublication(2000);
    }
  }
  retryPublication(delay) {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null; const result = this.flush();
      if (result && this.canRun()) this.publish(result);
    }, Math.max(1, delay));
    this.retryTimer.unref?.();
  }
  ensureCommitClaims(store, operation, decision) {
    if (!store.resourceClaims || decision?.reason !== "missing-resource-claim" || clock() - this.lastClaimAttemptAt < 2000) return null;
    const claimant = normalizeClaimant(operation.origin);
    const groups = decision.manifest?.requiredClaimGroups ?? decision.requiredClaimGroups
      ?? [decision.authority?.diagnostics?.missingClaimGroup ?? []];
    const missing = [...new Set(groups.filter((group) => !group.some((id) => store.resourceClaims.claimIsHeldBy(id, claimant)))
      .map((group) => group[0]).filter(Boolean))];
    if (!missing.length) return null;
    this.lastClaimAttemptAt = clock();
    return store.resourceClaims.claimResources({ resourceIds: missing, claimant: operation.origin, ttlMs: 30000 });
  }
  activeForcePeers(store) {
    const local = this.localPeer(), key = local && peerHolderId(local), observed = new Set();
    for (const target of store?.semanticConvergence?.snapshot?.().targets ?? []) for (const observation of target.observations ?? []) {
      if (observation.operationType === "layout:commit" && Date.now() - observation.observedAt < 8000) observed.add(observation.observerKey);
    }
    for (const claim of store?.resourceClaims?.snapshot?.() ?? []) observed.add(claim.holderId);
    const peers = this.currentPeers().filter((peer) => peer.role !== "observer" && (peerHolderId(peer) === key || observed.has(peerHolderId(peer))));
    if (local && local.role !== "observer" && !peers.some((peer) => peerHolderId(peer) === key)) peers.push(local);
    return peers;
  }
  restrictToOwnedShard(result, controller) {
    const peers = this.activeForcePeers(this.activeGolog?.state), local = this.localPeer();
    if (peers.length < 2 || !local) { this.lastPartition = null; return result; }
    const ledger = controller.extractGraph();
    const partition = partitionForceLayoutGraph(ledger, peers);
    const ownedIds = new Set(Object.entries(partition.assignments).filter(([, id]) => id === local.peerId).map(([id]) => id));
    this.lastPartition = { partition, ownedIds };
    return filterLayoutResult(result, (entry) => ownedIds.has(entry.id));
  }
  dispose() {
    this.disposed = true; this.layer?.dispose(); this.releases.forEach((release) => release?.()); clearTimeout(this.retryTimer);
    this.frameRef.cancelAnimationFrame?.(this.frameHandle); this.frameHandle = null;
  }
}
export function createLiveForceLayoutService(options = {}) { return new LiveForceLayoutService(options); }

export class PreviewForceUniverse {
  constructor({ createForceLayout, settingsProvider = null, settingsBus = null, externalIntentProvider = null,
    frameRef = globalThis, origin = null, canRun = null, publicationMode = "shared" } = {}) {
    Object.assign(this, { createForceLayout, settingsProvider, settingsBus, externalIntentProvider, frameRef, origin,
      publicationMode, runAllowed: canRun, entries: new Map(), frameHandle: null, disposed: false });
    this.releaseSettings = settingsBus?.on(LIVE_FORCE_LAYOUT_SETTINGS_CHANGED_EVENT, () => {
      for (const entry of this.entries.values()) { if (this.canRun()) entry.setOptions(); else entry.suspend(); } this.schedule();
    });
  }
  settings() { return settingValues({ ...LIVE_FORCE_LAYOUT_DEFAULTS, ...(this.settingsProvider?.() ?? {}) }); }
  canRun() { return !this.disposed && this.settings().enabled && resolve(this.origin)?.role !== "observer"
    && (this.runAllowed?.() ?? true); }
  setVisibleGologs(gologs = []) {
    if (this.disposed) return;
    const visible = new Map(gologs.filter(Boolean).map((golog) => [golog.id, golog]));
    for (const [id, entry] of this.entries) if (visible.get(id) !== entry.golog) { entry.dispose(); this.entries.delete(id); }
    for (const [id, golog] of visible) if (!this.entries.has(id)) this.entries.set(id, new LayoutLayer(this, golog));
    this.schedule();
  }
  hasActiveEntry() { return [...this.entries.values()].some((entry) => entry.golog.state.spheres.size > 0
    && (!entry.quiescent || entry.inputsDirty || entry.topologyDirty)); }
  wakeAll() { for (const entry of this.entries.values()) entry.wake(); }
  schedule() {
    if (!this.canRun() || this.frameHandle != null || !this.hasActiveEntry()) return;
    this.frameHandle = this.frameRef.requestAnimationFrame?.((time) => { this.frameHandle = null; this.tick(time); }) ?? null;
  }
  tick(time) { this.stepAll(time); this.schedule(); }
  stepAll() {
    if (!this.canRun()) return [];
    return [...this.entries.values()].map((entry) => this.stepEntry(entry)).filter(Boolean);
  }
  stepEntry(entry) { return entry.golog.state.spheres.size ? entry.step() : null; }
  forceOptions() { return { settings: this.settings() }; }
  flush() { return [...this.entries.values()].map((entry) => entry.flush()).filter(Boolean); }
  dispose() {
    this.disposed = true; this.releaseSettings?.(); this.entries.forEach((entry) => entry.dispose()); this.entries.clear();
    this.frameRef.cancelAnimationFrame?.(this.frameHandle); this.frameHandle = null;
  }
}
