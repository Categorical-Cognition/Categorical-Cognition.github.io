import { cloneStoreValue } from "./store-utils.js";
import { compileOperationResourceManifest } from "./operation-resource-manifest.js";
import { normalizeResourceId } from "./resource-ids.js";
import { normalizePeerContext, peerHolderId } from "./peer-context.js";
import {
  AUTHORITY_SOURCES,
  isBrowserRuntimeOrigin,
  isHumanInterfaceOrigin,
} from "./authority-origins.js";

export const RESOURCE_CLAIM_REQUEST_EVENT = "resource:claim-request";
export const RESOURCE_CLAIM_RELEASE_EVENT = "resource:claim-release";
export const RESOURCE_CLAIM_GRANTED_EVENT = "resource:claim-granted";
export const RESOURCE_CLAIM_REJECTED_EVENT = "resource:claim-rejected";
export const RESOURCE_CLAIM_RELEASED_EVENT = "resource:claim-released";
export const RESOURCE_CLAIMS_CHANGED_EVENT = "resource:claims-changed";

const DEFAULT_LEASE_MS = 30_000;
const SYNC_COMMIT_MARKER = "__syncCommitId";

function claimToken() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

export function normalizeClaimant(input = {}) {
  const origin = input.claimant ?? input.origin ?? input;
  const peer = normalizePeerContext(origin);
  const holderId = origin.holderId
    ? String(origin.holderId)
    : peer.isKnown
      ? peerHolderId(peer)
      : null;
  return {
    holderId,
    peerId: peer.peerId,
    sessionId: peer.sessionId,
    clientId: peer.clientId,
    deviceId: peer.deviceId,
    label: peer.deviceLabel,
    source: peer.source ?? origin.source ?? null,
    peer,
  };
}

function claimSource(claim = {}) {
  return claim.source ?? claim.peer?.source ?? null;
}

function browserMustYieldToClaim(claimant, claim) {
  return (
    isBrowserRuntimeOrigin(claimant) &&
    claimSource(claim) === AUTHORITY_SOURCES.HUMAN_INTERFACE
  );
}

const BROWSER_RUNTIME_PREEMPTABLE_SOURCES = new Set([
  AUTHORITY_SOURCES.AUTHORITY_HTTP_API,
  AUTHORITY_SOURCES.AGENT_API,
  "agent-api-force-layout",
]);

function claimantCanPreemptClaim(claimant, claim) {
  const source = claimSource(claim);
  if (isHumanInterfaceOrigin(claimant)) {
    return source !== AUTHORITY_SOURCES.HUMAN_INTERFACE;
  }
  if (isBrowserRuntimeOrigin(claimant)) {
    return BROWSER_RUNTIME_PREEMPTABLE_SOURCES.has(source);
  }
  return false;
}

function preemptionReason(claimant) {
  if (isHumanInterfaceOrigin(claimant)) {
    return "preempted-by-human-interface";
  }
  if (isBrowserRuntimeOrigin(claimant)) {
    return "preempted-by-browser-runtime";
  }
  return "preempted";
}

function normalizeResourceIds(input = {}) {
  const resourceIds = input.resourceIds ?? input.resourceId ?? [];
  return [
    ...new Set(
      (Array.isArray(resourceIds) ? resourceIds : [resourceIds])
        .filter(Boolean)
        .map((resourceId) => normalizeResourceId(resourceId)),
    ),
  ];
}

function releaseMatchesClaim(request, claim) {
  const fence = claim.fence ?? claim.fencingToken ?? claim.epoch;
  return (request.token === undefined || String(request.token) === String(claim.token)) &&
    (request.epoch === undefined || Number(request.epoch) === claim.epoch) &&
    (request.fence === undefined || Number(request.fence) === fence) &&
    (request.fencingToken === undefined || Number(request.fencingToken) === fence);
}

export class ResourceClaimManager {
  constructor({ bus, store, now = () => Date.now() }) {
    this.bus = bus;
    this.store = store;
    this.now = now;
    this.claims = new Map();
    this.epochs = new Map();
    this.revision = 0;
  }

  registerBusHandlers() {
    this.bus.on(RESOURCE_CLAIM_REQUEST_EVENT, (payload) => {
      if (payload?.localApplied && !payload?.[SYNC_COMMIT_MARKER]) {
        return null;
      }
      return this.claimResources(payload);
    });
    this.bus.on(RESOURCE_CLAIM_RELEASE_EVENT, (payload) => {
      if (payload?.localApplied && !payload?.[SYNC_COMMIT_MARKER]) {
        return null;
      }
      return this.releaseResources(payload);
    });
  }

  claimResources(payload = {}) {
    const resourceIds = normalizeResourceIds(payload);
    const claimant = normalizeClaimant(payload);
    if (!claimant.holderId) {
      return this.reject(resourceIds, claimant, "missing-holder-id");
    }
    if (resourceIds.length === 0) {
      return this.reject(resourceIds, claimant, "missing-resource-id");
    }
    const ttlMs = Number(payload.ttlMs ?? DEFAULT_LEASE_MS);
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      return this.reject(resourceIds, claimant, "invalid-lease-duration");
    }
    if (resourceIds.some((id) => (this.epochs.get(id) ?? 0) >= Number.MAX_SAFE_INTEGER)) {
      return this.reject(resourceIds, claimant, "authority-generation-exhausted");
    }

    this.pruneExpired();
    const conflicts = resourceIds
      .map((resourceId) => this.claims.get(resourceId))
      .filter((claim) => claim && claim.holderId !== claimant.holderId);
    const conflict = conflicts.find(
      (claim) => !claimantCanPreemptClaim(claimant, claim),
    );
    if (conflict) {
      return this.reject(resourceIds, claimant, "claimed-by-other-holder", {
        conflict,
        yieldToHuman: browserMustYieldToClaim(claimant, conflict),
      });
    }

    const preempted = conflicts.map((claim) => cloneStoreValue(claim));
    for (const claim of preempted) {
      this.claims.delete(claim.resourceId);
    }

    const acquiredAt = this.now();
    const token = payload.token ?? claimToken();
    let renewedCount = 0;
    const granted = resourceIds.map((resourceId) => {
      const existing = this.claims.get(resourceId);
      const renewing = existing?.holderId === claimant.holderId;
      if (renewing) {
        renewedCount += 1;
      }
      const epoch = Math.max(this.epochs.get(resourceId) ?? 0, existing?.epoch ?? 0) + 1;
      this.epochs.set(resourceId, epoch);
      const claim = {
        resourceId,
        holderId: claimant.holderId,
        peerId: claimant.peerId,
        clientId: claimant.clientId,
        sessionId: claimant.sessionId,
        deviceId: claimant.deviceId,
        label: claimant.label,
        source: claimant.source,
        token: payload.token ?? existing?.token ?? token,
        epoch,
        acquiredAt: renewing ? existing.acquiredAt : acquiredAt,
        expiresAt: acquiredAt + ttlMs,
        action: renewing ? "renewed" : "acquired",
      };
      this.claims.set(resourceId, claim);
      return cloneStoreValue(claim);
    });
    const action =
      renewedCount === 0
        ? "acquired"
        : renewedCount === granted.length
          ? "renewed"
          : "mixed";

    const result = {
      ok: true,
      resourceIds,
      holder: claimant,
      claims: granted,
      preempted,
      action,
      acquiredCount: granted.length - renewedCount,
      renewedCount,
    };
    if (preempted.length > 0) {
      this.store?.authorityFabric?.recordReleaseTombstones(preempted);
      this.bus.emit(
        RESOURCE_CLAIM_RELEASED_EVENT,
        cloneStoreValue({
          ok: true,
          resourceIds: preempted.map((claim) => claim.resourceId),
          holder: claimant,
          claims: preempted,
          reason: preemptionReason(claimant),
        }),
      );
    }
    this.bus.emit(RESOURCE_CLAIM_GRANTED_EVENT, cloneStoreValue(result));
    this.emitChanged();
    return result;
  }

  releaseResources(payload = {}) {
    const resourceIds = normalizeResourceIds(payload);
    const claimant = normalizeClaimant(payload);
    if (!claimant.holderId) {
      return this.reject(resourceIds, claimant, "missing-holder-id");
    }
    this.pruneExpired();
    const releaseIds =
      resourceIds.length > 0
        ? resourceIds
        : [...this.claims.values()]
            .filter((claim) => claim.holderId === claimant.holderId)
            .map((claim) => claim.resourceId);

    // Check the entire release before removing anything. A delayed release may
    // name the same holder but an earlier lease; it must not release its successor.
    const stale = releaseIds.map((id) => this.claims.get(id)).find((claim) =>
      claim?.holderId === claimant.holderId && !releaseMatchesClaim(payload, claim));
    if (stale) {
      return this.reject(resourceIds, claimant, "stale-resource-claim", { conflict: stale });
    }

    const released = [];
    for (const resourceId of releaseIds) {
      const claim = this.claims.get(resourceId);
      if (!claim) {
        continue;
      }
      if (claimant.holderId && claim.holderId !== claimant.holderId) {
        continue;
      }
      this.claims.delete(resourceId);
      released.push(cloneStoreValue(claim));
    }

    const result = {
      ok: true,
      resourceIds: released.map((claim) => claim.resourceId),
      holder: claimant,
      claims: released,
    };
    if (released.length > 0) {
      this.store?.authorityFabric?.recordReleaseTombstones(released);
      this.bus.emit(RESOURCE_CLAIM_RELEASED_EVENT, cloneStoreValue(result));
      this.emitChanged();
    }
    return result;
  }

  claimFor(resourceId) {
    this.pruneExpired();
    return this.claims.get(normalizeResourceId(resourceId)) ?? null;
  }

  observeAuthority(records = []) {
    for (const record of records) {
      const resourceId = normalizeResourceId(record.resourceId);
      const epoch = Math.max(Number(record.epoch) || 0, Number(record.fence ?? record.fencingToken) || 0);
      this.epochs.set(resourceId, Math.max(this.epochs.get(resourceId) ?? 0, epoch));
    }
  }

  claimIsHeldBy(resourceId, claimant) {
    const claim = this.claimFor(resourceId);
    return Boolean(claim && claim.holderId === claimant.holderId);
  }

  canApplyOperation(operation, { manifest = null, requireClaims = false } = {}) {
    this.pruneExpired();
    const resourceManifest = manifest ?? compileOperationResourceManifest(operation);
    const resourceIds = resourceManifest.writeResources ?? [];
    const claimant = normalizeClaimant(operation.origin);
    const conflicts = resourceIds
      .map((resourceId) => this.claims.get(resourceId))
      .filter((claim) => claim && claim.holderId !== claimant.holderId);

    if (conflicts.length > 0) {
      return {
        ok: false,
        resourceIds,
        holder: claimant,
        manifest: resourceManifest,
        reason: "resource-claim-conflict",
        conflict: cloneStoreValue(conflicts[0]),
      };
    }

    if (!requireClaims) {
      return { ok: true, resourceIds, holder: claimant, manifest: resourceManifest };
    }

    for (const group of resourceManifest.requiredClaimGroups ?? []) {
      const satisfied = group.some((resourceId) =>
        this.claimIsHeldBy(resourceId, claimant),
      );
      if (!satisfied) {
        return {
          ok: false,
          resourceIds,
          holder: claimant,
          manifest: resourceManifest,
          reason: "missing-resource-claim",
          missingClaimGroup: cloneStoreValue(group),
        };
      }
    }

    return { ok: true, resourceIds, holder: claimant, manifest: resourceManifest };
  }

  snapshot() {
    this.pruneExpired();
    return [...this.claims.values()].map((claim) => cloneStoreValue(claim));
  }

  reject(resourceIds, holder, reason, detail = {}) {
    const result = {
      ok: false,
      resourceIds,
      holder,
      reason,
      ...cloneStoreValue(detail),
    };
    this.bus.emit(RESOURCE_CLAIM_REJECTED_EVENT, cloneStoreValue(result));
    return result;
  }

  pruneExpired() {
    const now = this.now();
    const expired = [];
    for (const [resourceId, claim] of this.claims) {
      if (claim.expiresAt <= now) {
        this.claims.delete(resourceId);
        expired.push(claim);
      }
    }
    if (expired.length) {
      this.store?.authorityFabric?.recordReleaseTombstones(expired);
      this.emitChanged();
    }
    return expired.length > 0;
  }

  emitChanged() {
    this.revision += 1;
    this.bus.emit(RESOURCE_CLAIMS_CHANGED_EVENT, this.snapshot());
    this.store?.emitStateChanged?.();
  }
}
