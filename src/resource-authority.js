import { scoreCapabilityProfile } from "./capability-profile.js";
import { compileOperationResourceManifest } from "./operation-resource-manifest.js";
import { normalizePeerContext, peerHolderId } from "./peer-context.js";
import {
  interactionResourceId,
  parseResourceId,
  RESOURCE_KINDS,
} from "./resource-ids.js";
import { cloneStoreValue } from "./store-utils.js";
import {
  AUTHORITY_SOURCES,
  isHumanInterfaceOrigin,
} from "./authority-origins.js";

export const AUTHORITY_DECIDED_EVENT = "authority:decided";

function activeClaim(record = {}, now = Date.now()) {
  return Number(record.expiresAt ?? 0) > now && record.status !== "released";
}

function isHumanInteractionClaim(record = {}) {
  return (
    record.source === AUTHORITY_SOURCES.HUMAN_INTERFACE ||
    record.peer?.source === AUTHORITY_SOURCES.HUMAN_INTERFACE
  );
}

function simplexIdsFromManifest(manifest = {}, gologId = null) {
  const ids = new Set();
  for (const resourceId of manifest.writeResources ?? []) {
    try {
      const descriptor = parseResourceId(resourceId);
      if (
        descriptor.kind === RESOURCE_KINDS.SIMPLEX &&
        (!gologId || descriptor.gologId === gologId) &&
        descriptor.objectId
      ) {
        ids.add(descriptor.objectId);
      }
    } catch {
      // Unknown resource ids are handled by the normal authority table path.
    }
  }
  return ids;
}

export class ResourceAuthority {
  constructor({ bus, store, authorityFabric = null, requireClaims = true } = {}) {
    this.bus = bus;
    this.store = store;
    this.authorityFabric = authorityFabric ?? store?.authorityFabric ?? null;
    this.requireClaims = requireClaims;
  }

  activeHumanInteractionConflict(operation, manifest) {
    const gologId = operation.gologId ?? this.store?.gologId;
    const objectIds = simplexIdsFromManifest(manifest, gologId);
    if (objectIds.size === 0) {
      return null;
    }

    const peer = normalizePeerContext(operation.origin);
    const holderId = peer.isKnown ? peerHolderId(peer) : null;
    const humanOrigin = isHumanInterfaceOrigin(peer);
    const records = [
      ...(this.store?.resourceClaims?.snapshot?.() ?? []),
      ...(this.authorityFabric?.activeRemoteClaims?.() ?? []),
    ];
    const now = this.store?.resourceClaims?.now?.() ?? Date.now();

    for (const objectId of objectIds) {
      const controlResourceId = interactionResourceId(gologId, objectId);
      const claim = records.find(
        (record) =>
          record.resourceId === controlResourceId &&
          activeClaim(record, now) &&
          isHumanInteractionClaim(record),
      );
      if (!claim) {
        continue;
      }
      if (!humanOrigin || claim.holderId !== holderId) {
        return {
          resourceId: controlResourceId,
          objectId,
          holderId,
          conflict: cloneStoreValue(claim),
        };
      }
    }
    return null;
  }

  evaluateOperationAuthority(operation, { emit = true, manifest = null } = {}) {
    const peer = normalizePeerContext(operation.origin);
    const resourceManifest = manifest ?? compileOperationResourceManifest(operation);
    const resourceIds = resourceManifest.writeResources;
    const interactionConflict = this.activeHumanInteractionConflict(
      operation,
      resourceManifest,
    );
    const claimCheck = interactionConflict
      ? {
          ok: false,
          reason: "active-human-interaction-control",
          conflict: interactionConflict.conflict,
          interactionResourceId: interactionConflict.resourceId,
          objectId: interactionConflict.objectId,
        }
      : this.authorityFabric
      ? this.authorityFabric.validateOperation(operation, {
          manifest: resourceManifest,
          requireClaims: this.requireClaims,
        })
      : this.store.resourceClaims?.canApplyOperation(operation, {
          manifest: resourceManifest,
          requireClaims: this.requireClaims,
        });
    const ok = !claimCheck || claimCheck.ok;
    const decision = {
      ok,
      kind: "resource-authority",
      reason: ok ? "authority-granted" : claimCheck.reason,
      peer,
      holderId: peer.isKnown ? peerHolderId(peer) : null,
      capabilityScore: scoreCapabilityProfile(peer.capabilities),
      gologId: operation.gologId ?? this.store.gologId,
      operationId: operation.id ?? null,
      operationType: operation.type ?? null,
      resourceIds,
      requiredClaimGroups: resourceManifest.requiredClaimGroups,
      requiredClaimResources: resourceManifest.requiredClaimResources,
      manifest: resourceManifest,
      diagnostics: ok
        ? {}
        : {
            conflict: claimCheck.conflict ?? null,
            missingClaimGroup: claimCheck.missingClaimGroup ?? null,
            claim: claimCheck,
            authorityBackend: claimCheck.backend ?? null,
          },
    };

    if (emit) {
      this.bus.emit(AUTHORITY_DECIDED_EVENT, cloneStoreValue(decision));
    }
    return decision;
  }
}
