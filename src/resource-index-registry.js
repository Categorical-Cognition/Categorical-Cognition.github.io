import { normalizePeerContext, peerHolderId } from "./peer-context.js";
import { normalizeResourceId } from "./resource-ids.js";

export const NO_AUTHORITY_HOLDER_INDEX = 0;
export const NO_AUTHORITY_HOLDER_ID = "none";

function normalizeHolderId(input = {}) {
  if (input === null || input === undefined) {
    return null;
  }
  if (typeof input === "string") {
    return input;
  }
  if (input?.holderId) {
    return String(input.holderId);
  }
  const peer = normalizePeerContext(input);
  return peer.isKnown ? peerHolderId(peer) : null;
}

export class ResourceIndexRegistry {
  constructor() {
    this.resourceToIndex = new Map();
    this.indexToResource = [];
    this.holderToIndex = new Map([[NO_AUTHORITY_HOLDER_ID, NO_AUTHORITY_HOLDER_INDEX]]);
    this.indexToHolder = [NO_AUTHORITY_HOLDER_ID];
  }

  resourceIndex(resourceId) {
    const normalized = normalizeResourceId(resourceId);
    let index = this.resourceToIndex.get(normalized);
    if (index !== undefined) {
      return index;
    }
    index = this.indexToResource.length;
    this.resourceToIndex.set(normalized, index);
    this.indexToResource[index] = normalized;
    return index;
  }

  resourceIdFor(index) {
    return this.indexToResource[index] ?? null;
  }

  findResourceIndex(resourceId) {
    return this.resourceToIndex.get(normalizeResourceId(resourceId)) ?? null;
  }

  get resourceCount() {
    return this.indexToResource.length;
  }

  holderIndex(holder) {
    const holderId = normalizeHolderId(holder);
    if (!holderId) {
      return NO_AUTHORITY_HOLDER_INDEX;
    }
    let index = this.holderToIndex.get(holderId);
    if (index !== undefined) {
      return index;
    }
    index = this.indexToHolder.length;
    this.holderToIndex.set(holderId, index);
    this.indexToHolder[index] = holderId;
    return index;
  }

  holderIdFor(index) {
    return this.indexToHolder[index] ?? null;
  }

  normalizeHolder(holder, { create = true } = {}) {
    const holderId = normalizeHolderId(holder);
    const index = create
      ? this.holderIndex(holder)
      : this.holderToIndex.get(holderId) ?? NO_AUTHORITY_HOLDER_INDEX;
    return {
      holderId: holderId ?? NO_AUTHORITY_HOLDER_ID,
      holderIndex: index,
    };
  }

  snapshot() {
    return {
      resourceCount: this.indexToResource.length,
      holderCount: this.indexToHolder.length - 1,
      resources: [...this.indexToResource],
      holders: this.indexToHolder.slice(1),
    };
  }
}
