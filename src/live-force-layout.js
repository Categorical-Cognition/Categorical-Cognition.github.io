import { partitionForceLayoutGraph } from "./distributed-force-layout.js";
import {
  SEMANTIC_CONVERGENCE_CHANGED_EVENT,
} from "./semantic-convergence-service.js";
import { LOCAL_SHEAF_GLUE_CHANGED_EVENT } from "./local-sheaf-glue-service.js";
import { peerHolderId } from "./peer-context.js";
import { RESOURCE_CLAIMS_CHANGED_EVENT } from "./resource-claim-manager.js";

export const LIVE_FORCE_LAYOUT_DEFAULTS = Object.freeze({
  enabled: true,
  gravity: 0.02,
  repulsion: 8,
  edgePull: 0.08,
  edgePlaneGravity: 0.035,
  samePlaneEdgeRepulsion: 0.018,
  oppositeArrowEdgeRepulsion: 0.028,
  twoSimplexNodeBarycenter: 0.0012,
  twoSimplexEdgeBarycenter: 0.0018,
  twoSimplexFaceTightening: 1.8,
  globalCoherence: 0.08,
  restLength: 2.4,
  commitIntervalMs: 48,
});
export const LIVE_FORCE_LAYOUT_DEFAULT_STORAGE_KEY =
  "jsgolog.live-force-layout.defaults.v1";
const FORCE_SETTING_RANGES = Object.freeze({
  gravity: [0, 0.05],
  repulsion: [0, 20],
  edgePull: [0, 0.2],
  edgePlaneGravity: [0, 0.2],
  samePlaneEdgeRepulsion: [0, 0.2],
  oppositeArrowEdgeRepulsion: [0, 0.2],
  twoSimplexNodeBarycenter: [0, 0.05],
  twoSimplexEdgeBarycenter: [0, 0.05],
  twoSimplexFaceTightening: [1, 4],
  globalCoherence: [0, 1],
});
export const LIVE_FORCE_LAYOUT_SETTING_KEYS = Object.freeze(Object.keys(FORCE_SETTING_RANGES));

const POSITION_EPSILON_SQ = 1e-8;
const FORCE_COMMIT_DEADBAND_SQ = 0.015 * 0.015;
const FORCE_COMMIT_CLAIM_TTL_MS = 30_000;
const FORCE_COMMIT_CLAIM_RETRY_MS = 2_000;
const FORCE_COMMIT_MIN_INTERVAL_MS = 120;
const FORCE_SOLVER_ACTIVITY_WINDOW_MS = 8_000;
const FORCE_QUIESCENCE_FORCE_SQ = 0.002 * 0.002;
const FORCE_QUIESCENCE_MOVEMENT_SQ = 0.003 * 0.003;
const FORCE_QUIESCENCE_TICKS = 3;
export const LIVE_FORCE_LAYOUT_SETTINGS_CHANGED_EVENT =
  "live-force-layout:settings-changed";

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function forceSettingValues(settings = {}) {
  return Object.fromEntries(
    LIVE_FORCE_LAYOUT_SETTING_KEYS.flatMap((key) => {
      const number = Number(settings[key]);
      return Number.isFinite(number)
        ? [[key, clamp(number, ...FORCE_SETTING_RANGES[key])]] : [];
    }),
  );
}

export function readLiveForceLayoutDefaultSettings(storage = null) {
  if (!storage?.getItem) {
    return {};
  }
  try {
    return forceSettingValues(
      JSON.parse(storage.getItem(LIVE_FORCE_LAYOUT_DEFAULT_STORAGE_KEY) ?? "{}"),
    );
  } catch {
    return {};
  }
}

export function writeLiveForceLayoutDefaultSettings(storage = null, settings = {}) {
  if (!storage?.setItem) {
    return { ok: false, reason: "storage-unavailable" };
  }
  const defaults = forceSettingValues(settings);
  try {
    storage.setItem(
      LIVE_FORCE_LAYOUT_DEFAULT_STORAGE_KEY,
      JSON.stringify(defaults),
    );
    return { ok: true, defaults };
  } catch (error) {
    return {
      ok: false,
      reason: "storage-write-failed",
      error: error.message,
    };
  }
}

function topologySignature(store) {
  const sphereIds = [...store.spheres.keys()].sort().join(",");
  const edgeIds = [...store.edges.values()]
    .map((edge) => `${edge.id}:${edge.sourceId}->${edge.targetId}`)
    .sort()
    .join(",");
  const surfaceIds = [...store.surfaces.values()]
    .map((surface) => `${surface.id}:${surface.type}:${surface.edgeIds.join("+")}`)
    .sort()
    .join(",");
  return `${sphereIds}|${edgeIds}|${surfaceIds}`;
}

function positionEventsForStore(store, pinnedSphereIds = new Set()) {
  return [
    ...[...store.spheres.values()].map((sphere) => {
      const pinned = pinnedSphereIds.has(sphere.id);
      return {
        id: sphere.id,
        position: sphere.position,
        pinned,
        resetVelocity: pinned,
      };
    }),
    ...[...store.edges.values()].map((edge) => ({
      id: edge.id,
      position: edge.midpoint,
      resetVelocity: false,
    })),
  ];
}

function humanControlledSphereIds(store) {
  if (store?.localSheafGlue?.activeHumanSphereIds) {
    return store.localSheafGlue.activeHumanSphereIds();
  }
  return new Set();
}

function withoutHumanClaimedPositions(result, humanClaimedIds) {
  if (!humanClaimedIds?.size) {
    return result;
  }
  return {
    ...result,
    positions: (result?.positions ?? []).filter(
      (entry) => !humanClaimedIds.has(entry.id),
    ),
    edgeControls: (result?.edgeControls ?? []).filter(
      (entry) => !humanClaimedIds.has(entry.id),
    ),
  };
}

function positionSnapshot(store) {
  return new Map(
    [
      ...(store?.spheres?.values?.() ?? []),
      ...(store?.edges?.values?.() ?? []),
    ].map((object) => [
      object.id,
      (object.bend ?? object.position ?? object.midpoint).clone(),
    ]),
  );
}

function resultMovedSnapshot(result, snapshot, epsilonSq = POSITION_EPSILON_SQ) {
  return [...(result?.positions ?? []), ...(result?.edgeControls ?? [])].some((entry) => {
    const previous = snapshot.get(entry.id);
    const next = entry.bend ?? entry.position ?? entry.midpoint;
    return previous && next && previous.distanceToSquared(next) > epsilonSq;
  });
}

function resultEntriesMovedSince(result, snapshot, epsilonSq = POSITION_EPSILON_SQ) {
  return {
    ...result,
    positions: (result?.positions ?? []).filter((entry) => {
      const previous = snapshot.get(entry.id);
      return (
        previous &&
        entry.position &&
        previous.distanceToSquared(entry.position) > epsilonSq
      );
    }),
    edgeControls: (result?.edgeControls ?? []).filter((entry) => {
      const previous = snapshot.get(entry.id);
      return (
        previous &&
        entry.midpoint &&
        previous.distanceToSquared(entry.bend ?? entry.midpoint) > epsilonSq
      );
    }),
  };
}

function recordSnapshotEntries(snapshot, positions = [], edgeControls = []) {
  const next = snapshot ?? new Map();
  for (const entry of [...positions, ...edgeControls]) {
    const value = entry?.bend ?? entry?.position ?? entry?.midpoint;
    if (!entry?.id || !value) {
      continue;
    }
    next.set(entry.id, value.clone?.() ?? value);
  }
  return next;
}

function resolveOrigin(origin) {
  return typeof origin === "function" ? origin() : origin;
}

function originSignature(origin) {
  const resolved = resolveOrigin(origin);
  if (!resolved) {
    return "none";
  }
  return [
    resolved.peerId ?? "",
    resolved.sessionId ?? "",
    resolved.clientId ?? "",
    resolved.source ?? "",
  ].join("|");
}

function recentLayoutObserverKeys(store, now = Date.now()) {
  const keys = new Set();
  for (const target of store?.semanticConvergence?.snapshot?.().targets ?? []) {
    for (const observation of target.observations ?? []) {
      if (
        observation.operationType !== "layout:commit" ||
        !observation.observerKey ||
        now - Number(observation.observedAt ?? 0) > FORCE_SOLVER_ACTIVITY_WINDOW_MS
      ) {
        continue;
      }
      keys.add(observation.observerKey);
    }
  }
  return keys;
}

function claimedResourceHolderKeys(store) {
  const keys = new Set();
  for (const claim of store?.resourceClaims?.snapshot?.() ?? []) {
    if (claim?.holderId) {
      keys.add(claim.holderId);
    }
  }
  return keys;
}

function maxForceMagnitudeSq(result) {
  return (result?.forceTotals ?? []).reduce(
    (maximum, entry) => Math.max(maximum, entry.force?.lengthSq?.() ?? 0), 0,
  );
}

// Main and nested views share one numerical policy. Scheduling and publication
// are adapters around the same force controller, not separate physical laws.
function forceOptionsFor(store, settings) {
  const vertexCount = store.spheres.size;
  return {
    graphOptions: { edgeStrength: settings.edgePull, defaultRestLength: settings.restLength },
    fieldOptions: {
      centerStrength: settings.gravity,
      chargeStrength: settings.repulsion,
      chargeApproximation: vertexCount > 80 ? "spatial-hash" : "pairwise",
      edgePlaneGravityStrength: settings.edgePlaneGravity,
      samePlaneEdgeRepulsionStrength: settings.samePlaneEdgeRepulsion,
      oppositeArrowEdgeRepulsionStrength: settings.oppositeArrowEdgeRepulsion,
      twoSimplexNodeBarycenterStrength: settings.twoSimplexNodeBarycenter,
      twoSimplexEdgeBarycenterStrength: settings.twoSimplexEdgeBarycenter,
      twoSimplexFaceTighteningFactor: settings.twoSimplexFaceTightening,
    },
    solverOptions: {
      dt: vertexCount > 160 ? 0.36 : 0.48,
      damping: 0.84,
      maxVelocity: vertexCount > 160 ? 0.32 : 0.58,
    },
  };
}

function stepIntervalMs(store, settings) {
  const count = store?.spheres.size ?? 0;
  return Math.max(settings.commitIntervalMs, count > 240 ? 120 : count > 100 ? 80 : 0);
}

export class LiveForceLayoutService {
  constructor({
    workspace,
    modeHead,
    createForceLayout,
    frameRef = globalThis,
    defaults = {},
    storage = frameRef?.localStorage ?? null,
    origin = null,
    peerProvider = null,
    localPeerProvider = null,
  } = {}) {
    this.workspace = workspace;
    this.modeHead = modeHead;
    this.createForceLayout = createForceLayout;
    this.frameRef = frameRef;
    this.origin = origin;
    this.peerProvider = peerProvider;
    this.localPeerProvider = localPeerProvider;
    this.lastPartition = null;
    this.storage = storage;
    this.defaults = {
      ...LIVE_FORCE_LAYOUT_DEFAULTS,
      ...readLiveForceLayoutDefaultSettings(this.storage),
      ...defaults,
    };
    this.settings = {
      enabled: Boolean(this.defaults.enabled),
      ...forceSettingValues(LIVE_FORCE_LAYOUT_DEFAULTS),
      ...forceSettingValues(this.defaults),
    };
    this.activeGolog = null;
    this.controller = null;
    this.lastTopologySignature = null;
    this.lastOriginSignature = null;
    this.lastStepAt = 0;
    this.lastCommitSubmittedAt = -Infinity;
    this.lastPublishedPositionSnapshot = null;
    this.lastClaimAttemptAt = -FORCE_COMMIT_CLAIM_RETRY_MS;
    this.quiescent = false;
    this.quietStepCount = 0;
    this.lastMaxForceMagnitudeSq = null;
    this.applyingForcePreview = false;
    this.frameHandle = null;
    this.releaseStateListener = null;
    this.releaseConvergenceListener = null;
    this.releaseGlueListener = null;
    this.releaseClaimsListener = null;
    this.releaseWorkspaceListener = this.workspace?.bus?.on(
      "workspace:active-changed",
      ({ golog }) => this.bindActiveGolog(golog),
    );
    this.releaseModeListener = this.workspace?.bus?.on("mode:changed", () =>
      this.schedule(),
    );
    this.bindActiveGolog(this.workspace?.activeGolog?.() ?? null);
  }

  snapshot() {
    return {
      ...this.settings,
      active: this.canRun(),
      solving: this.canRun() && !this.quiescent,
      quiescent: this.quiescent,
      quietStepCount: this.quietStepCount,
      lastMaxForce: this.lastMaxForceMagnitudeSq === null
        ? null
        : Math.sqrt(this.lastMaxForceMagnitudeSq),
      distributedPeerCount: this.currentPeers().length,
      localPeerId: this.localPeer()?.peerId ?? null,
      assignedNodeCount: this.lastPartition
        ? [...this.lastPartition.ownedIds].filter((id) => this.activeGolog.state.spheres.has(id)).length
        : null,
    };
  }

  emitSettingsChanged() {
    this.workspace?.bus?.emit?.(
      LIVE_FORCE_LAYOUT_SETTINGS_CHANGED_EVENT,
      this.snapshot(),
    );
  }

  setEnabled(enabled) {
    this.settings.enabled = Boolean(enabled);
    if (this.settings.enabled) {
      this.wakeSolver();
    }
    this.schedule();
    this.emitSettingsChanged();
    return this.snapshot();
  }

  setSettings(settings = {}) {
    const previous = JSON.stringify(this.settings);
    if ("enabled" in settings) {
      this.settings.enabled = Boolean(settings.enabled);
    }
    Object.assign(this.settings, forceSettingValues(settings));

    if (JSON.stringify(this.settings) !== previous) {
      this.resetSimulation();
      this.schedule();
      this.emitSettingsChanged();
    }
    return this.snapshot();
  }

  commitSettingsAsDefaults() {
    this.defaults = {
      ...this.defaults,
      ...forceSettingValues(this.settings),
    };
    return {
      ...writeLiveForceLayoutDefaultSettings(this.storage, this.defaults),
      snapshot: this.snapshot(),
    };
  }

  bindActiveGolog(golog) {
    this.releaseStateListener?.();
    this.releaseConvergenceListener?.();
    this.releaseGlueListener?.();
    this.releaseClaimsListener?.();
    this.releaseStateListener = null;
    this.releaseConvergenceListener = null;
    this.releaseGlueListener = null;
    this.activeGolog = golog ?? null;
    this.resetSimulation();
    if (this.activeGolog) {
      this.releaseStateListener = this.activeGolog.bus.on("state:changed", () => {
        if (!this.applyingForcePreview) {
          this.wakeSolver();
        }
        this.schedule();
      });
      this.releaseClaimsListener = this.activeGolog.bus.on(RESOURCE_CLAIMS_CHANGED_EVENT, () => {
        this.wakeSolver();
        this.schedule();
      });
      this.releaseConvergenceListener = this.activeGolog.bus.on(
        SEMANTIC_CONVERGENCE_CHANGED_EVENT,
        () => {
          this.wakeSolver();
          this.schedule();
        },
      );
      this.releaseGlueListener = this.activeGolog.bus.on(
        LOCAL_SHEAF_GLUE_CHANGED_EVENT,
        () => {
          this.wakeSolver();
          this.schedule();
        },
      );
    }
    this.schedule();
  }

  wakeSolver() {
    this.quiescent = false;
    this.quietStepCount = 0;
  }

  resetSimulation() {
    this.controller = null;
    this.lastTopologySignature = null;
    this.lastOriginSignature = null;
    this.lastStepAt = 0;
    this.lastCommitSubmittedAt = -Infinity;
    this.lastPublishedPositionSnapshot = null;
    this.lastClaimAttemptAt = -FORCE_COMMIT_CLAIM_RETRY_MS;
    this.quiescent = false;
    this.quietStepCount = 0;
    this.lastMaxForceMagnitudeSq = null;
    this.pendingPublication = false;
    this.lastResult = null;
  }

  canRun() {
    return Boolean(
      this.settings.enabled &&
        this.localPeerCanSolve() &&
        this.activeGolog &&
        (this.modeHead?.canRunForces?.() ?? true) &&
        this.activeGolog.state.spheres.size > 0,
    );
  }

  ensureController(options = null) {
    if (!this.activeGolog || typeof this.createForceLayout !== "function") {
      return null;
    }
    const store = this.activeGolog.state;
    const nextSignature = topologySignature(store);
    const origin = this.operationOrigin();
    const nextOriginSignature = originSignature(origin);
    if (this.lastOriginSignature !== nextOriginSignature) {
      this.controller = null;
      this.lastTopologySignature = null;
      this.lastOriginSignature = nextOriginSignature;
    }
    if (!this.controller) {
      this.controller = this.createForceLayout(this.activeGolog, {
        ...(origin ? { origin } : {}),
      });
    }
    if (this.lastTopologySignature !== nextSignature) {
      this.controller.reset(options ?? this.forceOptions(store));
      this.lastTopologySignature = nextSignature;
      this.lastPublishedPositionSnapshot = positionSnapshot(store);
    }
    return this.controller;
  }

  currentPeers() {
    const peers =
      typeof this.peerProvider === "function" ? this.peerProvider() : [];
    return Array.isArray(peers)
      ? peers.filter((peer) => peer?.peerId && peer.peerId !== "peer-unknown")
      : [];
  }

  activeForcePeers(store) {
    const peers = this.currentPeers().filter((peer) => peer.role !== "observer");
    const localPeer = this.localPeer();
    const localKey = localPeer ? peerHolderId(localPeer) : null;
    const recentSolverKeys = recentLayoutObserverKeys(store);
    const claimedHolderKeys = claimedResourceHolderKeys(store);
    const activePeers = peers.filter((peer) => {
      const key = peerHolderId(peer);
      return (
        key === localKey ||
        recentSolverKeys.has(key) ||
        claimedHolderKeys.has(key)
      );
    });
    if (localPeer?.peerId && !activePeers.some((peer) => peerHolderId(peer) === localKey)) {
      activePeers.push(localPeer);
    }
    return activePeers;
  }

  localPeer() {
    const peer =
      typeof this.localPeerProvider === "function"
        ? this.localPeerProvider()
        : null;
    return peer?.peerId ? peer : null;
  }

  localPeerCanSolve() {
    const peer = this.localPeer();
    return !peer || peer.role !== "observer";
  }

  operationOrigin() {
    return this.localPeer() ?? resolveOrigin(this.origin);
  }

  forceOptions(store) {
    return forceOptionsFor(store, { ...this.defaults, ...this.settings });
  }

  currentIntervalMs() {
    return stepIntervalMs(this.activeGolog?.state, this.defaults);
  }

  schedule() {
    if (this.frameHandle || (this.quiescent && !this.pendingPublication) || !this.canRun()) {
      return;
    }
    this.frameHandle = this.frameRef.requestAnimationFrame?.((time) =>
      this.tick(time),
    );
  }

  tick(time = performance.now()) {
    this.frameHandle = null;
    if (!this.canRun()) {
      return;
    }

    if (time - this.lastStepAt >= this.currentIntervalMs()) {
      this.step();
      this.lastStepAt = time;
    }
    this.schedule();
  }

  step() {
    if (this.quiescent && !this.pendingPublication) {
      return null;
    }
    const store = this.activeGolog?.state;
    const options = store ? this.forceOptions(store) : null;
    const controller = this.ensureController(options);
    if (!store || !controller) {
      return null;
    }
    const preStepPositions = positionSnapshot(store);
    const humanControlledIds = humanControlledSphereIds(store);
    const result = this.quiescent && this.lastResult ? this.lastResult : controller.step({
      positionEvents: positionEventsForStore(store, humanControlledIds),
      externalIntents: store.semanticConvergence?.intents?.({
        strength: this.settings.globalCoherence,
      }),
    });
    this.lastResult = result;
    const previewResult = withoutHumanClaimedPositions(result, humanControlledIds);
    const commitResult = this.restrictToOwnedShard(previewResult, controller, options);
    const movedVisibly = resultMovedSnapshot(
      previewResult,
      preStepPositions,
      FORCE_QUIESCENCE_MOVEMENT_SQ,
    );
    this.lastMaxForceMagnitudeSq = maxForceMagnitudeSq(result);
    if (
      this.lastMaxForceMagnitudeSq <= FORCE_QUIESCENCE_FORCE_SQ &&
      !movedVisibly
    ) {
      this.quietStepCount += 1;
    } else {
      this.quietStepCount = 0;
    }
    this.lastPublishedPositionSnapshot ??= preStepPositions;
    const now = performance.now();
    const publishResult = resultEntriesMovedSince(
      commitResult,
      this.lastPublishedPositionSnapshot,
      FORCE_COMMIT_DEADBAND_SQ,
    );
    this.pendingPublication =
      (publishResult.positions?.length ?? 0) + (publishResult.edgeControls?.length ?? 0) > 0;
    const shouldCommit = this.pendingPublication &&
      now - this.lastCommitSubmittedAt >= FORCE_COMMIT_MIN_INTERVAL_MS;
    if (movedVisibly) {
      this.applyingForcePreview = true;
      store.applyLayoutPreviewPositions?.(
        previewResult.positions,
        previewResult.edgeControls,
      );
      queueMicrotask(() => {
        this.applyingForcePreview = false;
      });
    }
    if (shouldCommit) {
      const operation = controller.createCommitOperation(publishResult, {
        layoutId: "live-force-layout",
        filterUnchanged: false,
      });
      const decision = store.mutationPolicy?.evaluate?.(operation, { emit: false });
      if (decision?.ok) {
        controller.submitCommitOperation(operation);
        this.pendingPublication = false;
        this.lastCommitSubmittedAt = now;
        this.lastPublishedPositionSnapshot = recordSnapshotEntries(
          this.lastPublishedPositionSnapshot,
          publishResult.positions,
          publishResult.edgeControls,
        );
      } else {
        this.pendingPublication = decision?.reason === "missing-resource-claim";
        this.ensureCommitClaims(store, operation, decision);
      }
    }
    if (this.quietStepCount >= FORCE_QUIESCENCE_TICKS) {
      this.quiescent = true;
    }
    return result;
  }

  ensureCommitClaims(store, operation, decision) {
    if (
      !store?.resourceClaims ||
      decision?.reason !== "missing-resource-claim"
    ) {
      return null;
    }
    const now = performance.now();
    if (now - this.lastClaimAttemptAt < FORCE_COMMIT_CLAIM_RETRY_MS) {
      return null;
    }
    // The exact policy has already ruled out conflicting holders. Acquire the
    // entire proposed layout's write set, not one missing node per retry cycle.
    const missing = decision.manifest?.writeResources ??
      decision.authority?.diagnostics?.missingClaimGroup ?? [];
    if (missing.length === 0) {
      return null;
    }
    this.lastClaimAttemptAt = now;
    return store.resourceClaims.claimResources({
      resourceIds: missing,
      claimant: operation.origin,
      ttlMs: FORCE_COMMIT_CLAIM_TTL_MS,
    });
  }

  restrictToOwnedShard(result, controller, options) {
    const peers = this.activeForcePeers(this.activeGolog?.state);
    const localPeer = this.localPeer();
    if (peers.length < 2 || !localPeer?.peerId) {
      this.lastPartition = null;
      return result;
    }
    const graph = controller.extractGraph(options?.graphOptions ?? {});
    const partition = partitionForceLayoutGraph(graph, peers);
    const ownedIds = new Set(
      Object.entries(partition.assignments)
        .filter(([, peerId]) => peerId === localPeer.peerId)
        .map(([id]) => id),
    );
    this.lastPartition = { partition, ownedIds };
    return {
      ...result,
      positions: (result.positions ?? []).filter((entry) => ownedIds.has(entry.id)),
      edgeControls: (result.edgeControls ?? []).filter((entry) =>
        ownedIds.has(entry.id),
      ),
    };
  }

  dispose() {
    this.releaseStateListener?.();
    this.releaseConvergenceListener?.();
    this.releaseGlueListener?.();
    this.releaseClaimsListener?.();
    this.releaseWorkspaceListener?.();
    this.releaseModeListener?.();
    if (this.frameHandle) {
      this.frameRef.cancelAnimationFrame?.(this.frameHandle);
      this.frameHandle = null;
    }
  }
}

export function createLiveForceLayoutService(options = {}) {
  return new LiveForceLayoutService(options);
}

export class PreviewForceUniverse {
  constructor({
    createForceLayout,
    settingsProvider = null,
    settingsBus = null,
    externalIntentProvider = null,
    frameRef = globalThis,
    origin = null,
  } = {}) {
    this.createForceLayout = createForceLayout;
    this.settingsProvider = settingsProvider;
    this.settingsBus = settingsBus;
    this.externalIntentProvider = externalIntentProvider;
    this.frameRef = frameRef;
    this.origin = origin;
    this.entries = new Map();
    this.frameHandle = null;
    this.disposed = false;
    this.lastSettingsSignature = "";
    this.releaseSettingsListener = this.settingsBus?.on?.(
      LIVE_FORCE_LAYOUT_SETTINGS_CHANGED_EVENT,
      () => {
        this.wakeAll();
        this.schedule();
      },
    );
  }

  settings() {
    return {
      ...LIVE_FORCE_LAYOUT_DEFAULTS,
      ...(typeof this.settingsProvider === "function"
        ? this.settingsProvider() ?? {}
        : {}),
    };
  }

  settingsSignature() {
    return JSON.stringify(this.settings());
  }

  setVisibleGologs(gologs = []) {
    if (this.disposed) {
      return;
    }
    const visible = new Map(
      gologs.filter(Boolean).map((golog) => [golog.id, golog]),
    );
    for (const [gologId, entry] of this.entries.entries()) {
      if (visible.get(gologId) === entry.golog) {
        continue;
      }
      entry.releaseStateListener?.();
      this.entries.delete(gologId);
    }
    for (const [gologId, golog] of visible.entries()) {
      if (this.entries.has(gologId)) {
        continue;
      }
      const entry = {
        golog,
        controller: null,
        topologySignature: null,
        quiescent: false,
        quietStepCount: 0,
        lastStepAt: -Infinity,
        applyingPreview: false,
        releaseStateListener: null,
      };
      entry.releaseStateListener = golog.bus.on("state:changed", () => {
        if (!entry.applyingPreview) {
          entry.quiescent = false;
          entry.quietStepCount = 0;
        }
        this.schedule();
      });
      this.entries.set(gologId, entry);
    }
    this.schedule();
  }

  wakeAll() {
    for (const entry of this.entries.values()) {
      entry.quiescent = false;
      entry.quietStepCount = 0;
    }
  }

  hasActiveEntry() {
    return [...this.entries.values()].some(
      (entry) => !entry.quiescent && entry.golog.state.spheres.size > 0,
    );
  }

  schedule() {
    if (
      this.disposed ||
      this.frameHandle ||
      this.entries.size === 0 ||
      !this.hasActiveEntry() ||
      this.settings().enabled === false ||
      !this.frameRef?.requestAnimationFrame
    ) {
      return;
    }
    this.frameHandle = this.frameRef.requestAnimationFrame((time) =>
      this.tick(time),
    );
  }

  tick(time = performance.now()) {
    this.frameHandle = null;
    if (this.disposed) {
      return;
    }
    this.stepAll(time);
    this.schedule();
  }

  stepAll(time = null) {
    const signature = this.settingsSignature();
    if (signature !== this.lastSettingsSignature) {
      for (const entry of this.entries.values()) {
        entry.controller = null;
        entry.topologySignature = null;
        entry.quiescent = false;
        entry.quietStepCount = 0;
      }
      this.lastSettingsSignature = signature;
    }
    if (this.settings().enabled === false) {
      return [];
    }
    return [...this.entries.values()]
      .map((entry) => {
        if (time !== null && time - entry.lastStepAt < stepIntervalMs(entry.golog.state, this.settings())) return null;
        const result = this.stepEntry(entry);
        if (result && time !== null) entry.lastStepAt = time;
        return result;
      })
      .filter(Boolean);
  }

  stepEntry(entry) {
    if (entry.quiescent || entry.golog.state.spheres.size === 0) {
      return null;
    }
    const store = entry.golog.state;
    const options = this.forceOptions(store);
    const signature = topologySignature(store);
    if (!entry.controller) {
      entry.controller = this.createForceLayout(entry.golog, {
        ...(this.origin ? { origin: resolveOrigin(this.origin) } : {}),
      });
    }
    if (entry.topologySignature !== signature) {
      entry.controller.reset(options);
      entry.topologySignature = signature;
    }

    const preStepPositions = positionSnapshot(store);
    const humanControlledIds = humanControlledSphereIds(store);
    const externalIntents =
      typeof this.externalIntentProvider === "function"
        ? this.externalIntentProvider({
            golog: entry.golog,
            store,
            entry,
            universe: this,
          })
        : [];
    const result = entry.controller.step({
      positionEvents: positionEventsForStore(store, humanControlledIds),
      externalIntents: [
        store.semanticConvergence?.intents?.({
          strength: this.settings().globalCoherence,
        }),
        externalIntents,
      ],
    });
    const previewResult = withoutHumanClaimedPositions(result, humanControlledIds);
    const movedVisibly = resultMovedSnapshot(
      previewResult,
      preStepPositions,
      FORCE_QUIESCENCE_MOVEMENT_SQ,
    );
    const maxForceMagnitude = maxForceMagnitudeSq(result);
    if (movedVisibly) {
      entry.applyingPreview = true;
      store.applyLayoutPreviewPositions?.(
        previewResult.positions,
        previewResult.edgeControls,
      );
      queueMicrotask(() => {
        entry.applyingPreview = false;
      });
    }
    if (maxForceMagnitude <= FORCE_QUIESCENCE_FORCE_SQ && !movedVisibly) {
      entry.quietStepCount += 1;
    } else {
      entry.quietStepCount = 0;
    }
    if (entry.quietStepCount >= FORCE_QUIESCENCE_TICKS) {
      entry.quiescent = true;
    }
    return result;
  }

  forceOptions(store) {
    return forceOptionsFor(store, this.settings());
  }

  dispose() {
    this.disposed = true;
    this.releaseSettingsListener?.();
    for (const entry of this.entries.values()) {
      entry.releaseStateListener?.();
    }
    this.entries.clear();
    if (this.frameHandle) {
      this.frameRef.cancelAnimationFrame?.(this.frameHandle);
      this.frameHandle = null;
    }
  }
}
