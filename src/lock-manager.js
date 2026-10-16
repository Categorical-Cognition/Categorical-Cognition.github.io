import { cloneStoreValue, normalizeClient } from "./store-utils.js";

export class LockManager {
  constructor({ store, events }) {
    this.store = store;
    this.events = events;
  }

  acquireInteractionLock(objectId, client = {}) {
    return this.acquireLocks(this.getLockScopeForObject(objectId), client);
  }

  acquireLocks(objectIds, client = {}) {
    const owner = normalizeClient(client);
    const uniqueObjectIds = [...new Set(objectIds.filter(Boolean))];
    if (!owner.clientId) {
      return this.denyLock(uniqueObjectIds, owner, "missing-client-id");
    }

    const missingObjectId = uniqueObjectIds.find(
      (id) => !this.store.objects.has(id),
    );
    if (missingObjectId) {
      return this.denyLock(uniqueObjectIds, owner, "missing-object", {
        objectId: missingObjectId,
      });
    }

    const conflict = uniqueObjectIds
      .map((id) => this.store.locks.get(id))
      .find((lock) => lock && lock.ownerId !== owner.clientId);
    if (conflict) {
      return this.denyLock(uniqueObjectIds, owner, "locked-by-other-client", {
        conflict,
      });
    }

    const acquiredAt = Date.now();
    for (const objectId of uniqueObjectIds) {
      this.store.locks.set(objectId, {
        objectId,
        ownerId: owner.clientId,
        ownerIp: owner.clientIp,
        acquiredAt,
      });
    }

    const result = { ok: true, lockIds: uniqueObjectIds, owner };
    this.events.locksAcquired(result);
    this.events.locksChanged(this.snapshotLocks());
    this.store.emitStateChanged();
    return result;
  }

  releaseLocks(objectIds, client = {}) {
    const owner = normalizeClient(client);
    const explicitIds = [...new Set(objectIds.filter(Boolean))];
    const releaseIds =
      explicitIds.length > 0
        ? explicitIds
        : [...this.store.locks.values()]
            .filter((lock) => lock.ownerId === owner.clientId)
            .map((lock) => lock.objectId);

    const released = [];
    for (const objectId of releaseIds) {
      const lock = this.store.locks.get(objectId);
      if (!lock) {
        continue;
      }
      if (owner.clientId && lock.ownerId !== owner.clientId) {
        continue;
      }
      this.store.locks.delete(objectId);
      released.push(objectId);
    }

    if (released.length > 0) {
      this.events.locksReleased({ lockIds: released, owner });
      this.events.locksChanged(this.snapshotLocks());
      this.store.emitStateChanged();
    }
    return { ok: true, lockIds: released, owner };
  }

  getLockScopeForObject(objectId) {
    const object = this.store.objects.get(objectId);
    if (!object) {
      return [objectId];
    }

    if (object.kind === "sphere") {
      return [
        object.id,
        ...this.store.connectedEdges(object.id).flatMap((edge) =>
          this.edgeLockScope(edge.id, {
            includeFrame: true,
            includeSurfaces: true,
          }),
        ),
      ];
    }

    if (object.kind === "edge" || object.kind === "edge-bend-handle") {
      return this.edgeLockScope(object.edgeId ?? object.id, {
        includeSurfaces: true,
      });
    }

    if (
      object.kind === "surface" ||
      object.kind === "two-simplex" ||
      object.kind === "surface-control-handle"
    ) {
      return this.surfaceLockScope(object.surfaceId ?? object.id);
    }

    if (object.kind === "node-pair-orthogonal-frame") {
      return this.frameLockScope(object.id);
    }

    return [object.id];
  }

  edgeLockScope(edgeId, { includeFrame = false, includeSurfaces = false } = {}) {
    const edge = this.store.edges.get(edgeId);
    return [
      edgeId,
      this.store.edgeBendHandleId(edgeId),
      includeFrame ? edge?.frameId : null,
      ...(includeSurfaces
        ? this.store
            .surfacesForEdge(edgeId)
            .flatMap((surface) => this.surfaceLockScope(surface.id))
        : []),
    ].filter((id) => id && this.store.objects.has(id));
  }

  surfaceLockScope(surfaceId) {
    return [
      surfaceId,
      this.store.surfaceControlHandleId(surfaceId),
    ].filter((id) => id && this.store.objects.has(id));
  }

  frameLockScope(frameId) {
    return [
      frameId,
      ...this.store.edgesForFrame(frameId).flatMap((edge) =>
        this.edgeLockScope(edge.id, { includeSurfaces: true }),
      ),
    ];
  }

  canMutateObjects(objectIds, client = {}, operation = "mutation") {
    const owner = normalizeClient(client);
    const conflict = objectIds
      .map((objectId) => this.store.locks.get(objectId))
      .find((lock) => lock && lock.ownerId !== owner.clientId);
    if (!conflict) {
      return true;
    }

    this.events.mutationDenied({
      operation,
      objectIds,
      owner,
      conflict: cloneStoreValue(conflict),
    });
    return false;
  }

  denyLock(objectIds, owner, reason, detail = {}) {
    const result = {
      ok: false,
      lockIds: objectIds,
      owner,
      reason,
      ...cloneStoreValue(detail),
    };
    this.events.lockDenied(result);
    return result;
  }

  snapshotLocks() {
    return [...this.store.locks.values()].map((lock) => cloneStoreValue(lock));
  }
}
