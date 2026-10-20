import { AUTHORITY_GOSSIP_MERGED_EVENT } from "./authority-gossip.js";
import { AUTHORITY_SOURCES } from "./authority-origins.js";
import { convergenceTargetsFromOperation } from "./semantic-convergence-service.js";
import {
  RESOURCE_CLAIMS_CHANGED_EVENT,
  RESOURCE_CLAIM_RELEASED_EVENT,
} from "./resource-claim-manager.js";
import { interactionResourceId, simplexResourceId } from "./resource-ids.js";
import { normalizePeerContext, peerHolderId } from "./peer-context.js";
import { cloneStoreValue } from "./store-utils.js";

export const LOCAL_SHEAF_GLUE_CHANGED_EVENT = "local-sheaf-glue:changed";
export const HUMAN_INTERACTION_OBSERVATION_TTL_MS = 1_500;

function isHumanAuthority(record = {}) {
  return (
    record.source === AUTHORITY_SOURCES.HUMAN_INTERFACE ||
    record.peer?.source === AUTHORITY_SOURCES.HUMAN_INTERFACE
  );
}

function activeClaim(record = {}, now = Date.now()) {
  return Number(record.expiresAt ?? 0) > now && record.status !== "released";
}

function holderIdForOrigin(origin = {}) {
  const peer = normalizePeerContext(origin);
  return peer.isKnown ? peerHolderId(peer) : null;
}

export class LocalSheafGlueService {
  constructor({
    store,
    bus = store?.bus,
    now = () => Date.now(),
    observationTtlMs = HUMAN_INTERACTION_OBSERVATION_TTL_MS,
  } = {}) {
    this.store = store;
    this.bus = bus;
    this.now = now;
    this.observationTtlMs = observationTtlMs;
    this.observedInteractions = new Map();
    this.registerBusHandlers();
  }

  registerBusHandlers() {
    this.bus?.on(RESOURCE_CLAIMS_CHANGED_EVENT, () => this.emitChanged("claims"));
    this.bus?.on(RESOURCE_CLAIM_RELEASED_EVENT, () => this.emitChanged("claim-release"));
    this.bus?.on(AUTHORITY_GOSSIP_MERGED_EVENT, () => this.emitChanged("authority-gossip"));
  }

  pruneObservedInteractions() {
    const now = this.now();
    let changed = false;
    for (const [id, observation] of this.observedInteractions.entries()) {
      if (Number(observation.expiresAt ?? 0) <= now) {
        this.observedInteractions.delete(id);
        changed = true;
      }
    }
    return changed;
  }

  observeOperation(operation = {}, detail = {}) {
    if (operation.origin?.source !== AUTHORITY_SOURCES.HUMAN_INTERFACE) {
      return { ok: true, observed: 0 };
    }
    const targets = convergenceTargetsFromOperation(operation);
    if (targets.length === 0) {
      return { ok: true, observed: 0 };
    }

    const now = this.now();
    const holderId = holderIdForOrigin(operation.origin);
    for (const target of targets) {
      this.observedInteractions.set(target.id, {
        id: target.id,
        resourceId: interactionResourceId(
          operation.gologId ?? this.store?.gologId,
          target.id,
        ),
        targetResourceId: simplexResourceId(
          operation.gologId ?? this.store?.gologId,
          target.id,
        ),
        mode: "human-control",
        source: AUTHORITY_SOURCES.HUMAN_INTERFACE,
        holderId,
        peerId: operation.origin?.peerId ?? null,
        sessionId: operation.origin?.sessionId ?? null,
        operationId: operation.id ?? null,
        operationType: operation.type ?? null,
        observedAt: now,
        expiresAt: now + this.observationTtlMs,
        detail: cloneStoreValue(detail),
      });
    }
    this.emitChanged("human-observation");
    return { ok: true, observed: targets.length };
  }

  activeAuthorityRecords({ localOnly = false } = {}) {
    const now = this.now();
    const localClaims = this.store?.resourceClaims?.snapshot?.() ?? [];
    const remoteClaims = localOnly ? [] : this.store?.authorityFabric?.activeRemoteClaims?.() ?? [];
    const byKey = new Map();
    for (const claim of [...localClaims, ...remoteClaims]) {
      if (!activeClaim(claim, now)) {
        continue;
      }
      const key = `${claim.resourceId}:${claim.holderId ?? ""}`;
      byKey.set(key, claim);
    }
    return [...byKey.values()];
  }

  activeInteractionRecords(options) {
    const changed = this.pruneObservedInteractions();
    if (changed) {
      this.emitChanged("observation-expired");
    }
    const authorityRecords = this.activeAuthorityRecords(options)
      .filter(isHumanAuthority)
      .map((record) => ({
        ...cloneStoreValue(record),
        mode: "human-control",
        recordKind: "authority-claim",
      }));
    const observedRecords = [...this.observedInteractions.values()].map((record) => ({
      ...cloneStoreValue(record),
      recordKind: "recent-observation",
    }));
    return [...authorityRecords, ...observedRecords];
  }

  activeHumanSphereIds() {
    const resources = new Set(
      this.activeInteractionRecords().flatMap((record) => [
        record.resourceId,
        record.targetResourceId,
      ]),
    );
    return new Set(
      [...(this.store?.spheres?.keys?.() ?? [])].filter((id) =>
        resources.has(simplexResourceId(this.store.gologId, id)) ||
        resources.has(interactionResourceId(this.store.gologId, id)),
      ),
    );
  }

  snapshot() {
    const interactions = this.activeInteractionRecords();
    return {
      format: "golog.local-sheaf-glue",
      version: 1,
      gologId: this.store?.gologId ?? null,
      activeInteractionCount: interactions.length,
      activeHumanSphereIds: [...this.activeHumanSphereIds()],
      interactions,
    };
  }

  emitChanged(reason) {
    this.bus?.emit(LOCAL_SHEAF_GLUE_CHANGED_EVENT, {
      gologId: this.store?.gologId ?? null,
      reason,
      activeHumanSphereIds: [...this.activeHumanSphereIds()],
      activeInteractionCount: this.observedInteractions.size,
    });
  }
}

export function createLocalSheafGlueService(options = {}) {
  return new LocalSheafGlueService(options);
}
