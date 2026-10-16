import {
  NO_AUTHORITY_HOLDER_INDEX,
  ResourceIndexRegistry,
} from "./resource-index-registry.js";
import { cloneStoreValue } from "./store-utils.js";
import { normalizeResourceId } from "./resource-ids.js";

export const AUTHORITY_TABLE_FORMAT = "golog.compiled-authority-table";
export const AUTHORITY_TABLE_VERSION = 1;

export const AUTHORITY_TABLE_BACKENDS = Object.freeze({
  CPU_TYPED_ARRAY: "cpu-typed-array",
  WEBGPU_BUFFER: "webgpu-buffer",
});

function emptyDecision({
  ok = true,
  reason = "authority-granted",
  manifest = null,
  holderId = null,
  holderIndex = NO_AUTHORITY_HOLDER_INDEX,
  backend = AUTHORITY_TABLE_BACKENDS.CPU_TYPED_ARRAY,
  resourceCount = 0,
  conflict = null,
  missingClaimGroup = null,
} = {}) {
  return {
    ok,
    reason,
    backend,
    holderId,
    holderIndex,
    resourceCount,
    manifest,
    conflict,
    missingClaimGroup,
  };
}

export class CompiledAuthorityTable {
  constructor({
    registry = new ResourceIndexRegistry(),
    backend = AUTHORITY_TABLE_BACKENDS.CPU_TYPED_ARRAY,
    initialCapacity = 64,
  } = {}) {
    this.format = AUTHORITY_TABLE_FORMAT;
    this.version = AUTHORITY_TABLE_VERSION;
    this.registry = registry;
    this.backend = backend;
    this.owners = new Int32Array(Math.max(1, Number(initialCapacity) || 1));
  }

  ensureCapacity(index) {
    if (index < this.owners.length) {
      return;
    }
    let capacity = this.owners.length;
    while (capacity <= index) {
      capacity *= 2;
    }
    const next = new Int32Array(capacity);
    next.set(this.owners);
    this.owners = next;
  }

  setAuthority(resourceId, holder) {
    const resourceIndex = this.registry.resourceIndex(resourceId);
    const holderIndex = this.registry.holderIndex(holder);
    this.ensureCapacity(resourceIndex);
    this.owners[resourceIndex] = holderIndex;
    return {
      resourceId: this.registry.resourceIdFor(resourceIndex),
      resourceIndex,
      holderId: this.registry.holderIdFor(holderIndex),
      holderIndex,
    };
  }

  clearAuthority(resourceId, holder = null) {
    const resourceIndex = this.registry.findResourceIndex(resourceId);
    if (resourceIndex === null) {
      return false;
    }
    const expectedHolderIndex =
      holder === null ? null : this.registry.normalizeHolder(holder, { create: false }).holderIndex;
    if (
      expectedHolderIndex !== null &&
      this.owners[resourceIndex] !== expectedHolderIndex
    ) {
      return false;
    }
    this.owners[resourceIndex] = NO_AUTHORITY_HOLDER_INDEX;
    return true;
  }

  rebuildFromClaims(claims = []) {
    this.owners.fill(NO_AUTHORITY_HOLDER_INDEX);
    for (const claim of claims) {
      if (claim?.resourceId && claim?.holderId) {
        this.setAuthority(claim.resourceId, claim.holderId);
      }
    }
    return this.snapshot();
  }

  ownerFor(resourceId) {
    const resourceIndex = this.registry.findResourceIndex(resourceId);
    const holderIndex = resourceIndex === null
      ? NO_AUTHORITY_HOLDER_INDEX
      : this.owners[resourceIndex] ?? NO_AUTHORITY_HOLDER_INDEX;
    return {
      resourceId: normalizeResourceId(resourceId),
      resourceIndex,
      holderId: this.registry.holderIdFor(holderIndex),
      holderIndex,
    };
  }

  validateManifest(manifest = {}, holder = {}) {
    const { holderId, holderIndex } = this.registry.normalizeHolder(holder, { create: false });
    const decision = (detail = {}) => emptyDecision({
      manifest,
      holderId,
      holderIndex,
      backend: this.backend,
      resourceCount: this.registry.resourceCount,
      ...detail,
    });
    for (const resourceId of manifest?.writeResources ?? []) {
      const owner = this.ownerFor(resourceId);
      if (
        owner.holderIndex !== NO_AUTHORITY_HOLDER_INDEX &&
        owner.holderIndex !== holderIndex
      ) {
        return decision({
          ok: false,
          reason: "resource-claim-conflict",
          conflict: cloneStoreValue({
            resourceId: owner.resourceId,
            holderId: owner.holderId,
            holderIndex: owner.holderIndex,
          }),
        });
      }
    }

    for (const group of manifest?.requiredClaimGroups ?? []) {
      const satisfied = holderIndex !== NO_AUTHORITY_HOLDER_INDEX && group.some((resourceId) => {
        const owner = this.ownerFor(resourceId);
        return owner.holderIndex === holderIndex;
      });
      if (!satisfied) {
        return decision({
          ok: false,
          reason: "missing-resource-claim",
          missingClaimGroup: cloneStoreValue(group),
        });
      }
    }

    return decision();
  }

  validateBatch(entries = []) {
    return entries.map((entry) =>
      this.validateManifest(entry.manifest, entry.holder ?? entry.origin),
    );
  }

  toBackendBuffers() {
    const registry = this.registry.snapshot();
    return {
      format: AUTHORITY_TABLE_FORMAT,
      version: AUTHORITY_TABLE_VERSION,
      backend: this.backend,
      ownerByResourceIndex: this.owners.slice(0, registry.resourceCount),
      registry,
    };
  }

  snapshot() {
    const registry = this.registry.snapshot();
    const entries = registry.resources.map((resourceId, resourceIndex) => {
      const holderIndex =
        this.owners[resourceIndex] ?? NO_AUTHORITY_HOLDER_INDEX;
      return {
        resourceId,
        resourceIndex,
        holderId: this.registry.holderIdFor(holderIndex),
        holderIndex,
      };
    });
    return {
      format: AUTHORITY_TABLE_FORMAT,
      version: AUTHORITY_TABLE_VERSION,
      backend: this.backend,
      resourceCount: registry.resourceCount,
      holderCount: registry.holderCount,
      entries,
    };
  }
}
