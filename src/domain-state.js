import {
  createEdgeBendHandleRecord,
  createEdgeObjectRecord,
  createEdgeRenderPayload,
  createNodePairFrameRecord,
  createSphereObjectRecord,
  createSurfaceRenderPayload,
  edgeBendHandleId as makeEdgeBendHandleId,
  findNearestAvailableEdgeBend,
  nodePairEndpoints as makeNodePairEndpoints,
  nodePairFrameId as makeNodePairFrameId,
  nodePairId as makeNodePairId,
  surfaceControlHandleId as makeSurfaceControlHandleId,
} from "./domain-object-definitions.js";
import * as THREE from "three";
import {
  bendFromFramePoint as calculateBendFromFramePoint,
  createNodePairFrameGeometry,
  normalizeControlDirection, normalizeFrameGauge, assertFrameTangent, frameGaugesEqual,
  pointFromFrameBend as calculatePointFromFrameBend,
} from "./frame-service.js";
import {
  elevateQuadraticBezierToCubic as calculateElevatedQuadraticBezier,
  getQuadraticControlPoint as calculateQuadraticControlPoint,
  getBiquadraticInteriorControlForSurfacePoint,
  getTriangularCubicInteriorControlForSurfacePoint,
  makePlaneBasisFromNormal as calculatePlaneBasisFromNormal,
  transportPlaneBasis as calculateTransportedPlaneBasis,
} from "./geometry-utils.js";
import { DomainEventsAdapter } from "./domain-events-adapter.js";
import { createElementRegistry } from "./element-registry.js";
import { structureDefinitionFor } from "./structure-definition-registry.js";
import { presheafFromElements } from "./golog-presheaf.js";
import { createThetaVolumeElement, syncThetaVolumeObject } from "./theta-volume-definition.js";
import {
  canCreateTwoCellElement,
  createTwoCellControlLineForStore,
  createTwoCellElement,
  createTwoSimplexControlLineForStore,
  createTwoSimplexControlNetForStore,
  createTwoSimplexElement,
  syncSurfaceElementObjects,
  syncTwoSimplexElementObjects,
} from "./hierarchical-theta-space-definition.js";
import {
  inferVirtualCellBoundary,
  syncVirtualCellElementObjects,
  virtualCellControlLineForStore,
} from "./virtual-double-category-definition.js";
import { SURFACE_TYPES } from "./domain-object-definitions.js";
import { LockManager } from "./lock-manager.js";
import { registerDomainMessageHandlers } from "./domain-message-handlers.js";
import { ResourceClaimManager } from "./resource-claim-manager.js";
import { AuthorityFabric } from "./authority-fabric.js";
import { CoordinationEventStream } from "./coordination-event-stream.js";
import { ResourceAuthority } from "./resource-authority.js";
import { MutationPolicy } from "./mutation-policy.js";
import { SemanticConvergenceService } from "./semantic-convergence-service.js";
import { LocalSheafGlueService } from "./local-sheaf-glue-service.js";
import {
  RESOURCE_CLAIM_RELEASE_EVENT,
  RESOURCE_CLAIM_REQUEST_EVENT,
} from "./resource-claim-manager.js";
import { interactionResourceId, simplexResourceId } from "./resource-ids.js";
import { findCompactNodePosition } from "./node-placement-service.js";
import { cloneStoreValue } from "./store-utils.js";
import { clonePatchValue, patchValuesEqual } from "./workspace-patches.js";
import { normalizeShapeExpansionPayload, assertShapeExpansionDeletionAllowed,
  assertShapeExpansionBoundaryEditAllowed } from "./shape-expansion.js";
import {
  normalizePayload,
  payloadAttachmentKey,
  payloadHasText,
  payloadKind,
  PAYLOAD_TYPES,
} from "./payload-types.js";

function coerceVector3Array(value, fieldName) {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new Error(`${fieldName} must be a three-number array`);
  }
  return value.map(Number);
}

function vector3FromStoreValue(value, fieldName) {
  if (value?.isVector3 && value.toArray().every(Number.isFinite)) {
    return value.clone();
  }
  if (Array.isArray(value) && value.length === 3) {
    const coordinates = value.map(Number);
    if (coordinates.every(Number.isFinite)) {
      return new THREE.Vector3(...coordinates);
    }
  }
  if (value && typeof value === "object") {
    const coordinates = [value.x, value.y, value.z].map(Number);
    if (coordinates.every(Number.isFinite)) {
      return new THREE.Vector3(...coordinates);
    }
  }
  throw new Error(`${fieldName} must be a Vector3-compatible value`);
}

function payloadPrimaryPriority(payload) {
  const kind = payloadAttachmentKey(payload);
  if (kind === "nested-golog") {
    return 0;
  }
  return 1;
}

function coerceVector2Array(value, fieldName) {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error(`${fieldName} must be a two-number array`);
  }
  return value.map(Number);
}

function structuralSignature(record) {
  if (!record?.elementKind || !Number.isInteger(record.dimension)) return null;
  const schema = record.schemaRef;
  return JSON.stringify([record.elementKind, record.dimension, record.surfaceType, record.arrowKind,
    schema && [schema.schemaId, schema.structureId, schema.objectId, schema.elementKind],
    record.dimension === 1 ? [record.sourceId, record.targetId]
      : record.dimension === 2 ? [record.edgeIds, record.topPathIds,
        record.bottomArrowId, record.leftArrowId, record.rightArrowId]
        : record.dimension === 3 ? Object.entries(record.faces ?? {}).sort(([a], [b]) => a.localeCompare(b)) : []]);
}

class IndexedObjectMap extends Map {
  constructor() {
    super();
    this.boundary = new Map();
    this.frame = new Map();
    this.surface = new Map();
    this.order = new Map();
    this.nextOrder = 0;
    this.topologyRevision = 0;
    this.scopeRevision = 0;
    this.signatures = new Map();
  }

  references(record) {
    return [
      record?.dimension === 1 ? [record.sourceId, record.targetId]
        : record?.dimension === 2 ? record.edgeIds ?? [] : [],
      record?.dimension === 1 ? [record.frameId] : [],
      record?.dimension === 3 ? record.boundaryFaceIds ?? [] : [],
    ];
  }

  updateReferences(id, previous, next) {
    const before = this.references(previous), after = this.references(next);
    [this.boundary, this.frame, this.surface].forEach((index, i) => {
      for (const key of before[i]) if (key != null && !after[i].includes(key)) {
        const ids = index.get(key);
        if (!ids) continue;
        ids.delete(id);
        if (!ids.size) index.delete(key);
      }
      for (const key of after[i]) if (key != null && !before[i].includes(key)) {
        if (!index.has(key)) index.set(key, new Set());
        index.get(key).add(id);
      }
    });
  }

  set(id, record) {
    const previous = this.get(id);
    if (!this.has(id) || ["kind", "edgeId", "surfaceId", "frameId"].some((key) => previous?.[key] !== record?.[key])) {
      this.scopeRevision++;
    }
    const signature = structuralSignature(record);
    if ((this.signatures.get(id) ?? null) !== signature) this.topologyRevision++;
    if (signature == null) this.signatures.delete(id);
    else this.signatures.set(id, signature);
    this.updateReferences(id, this.get(id), record);
    if (!this.has(id)) this.order.set(id, this.nextOrder++);
    return super.set(id, record);
  }

  delete(id) {
    if (this.has(id)) this.scopeRevision++;
    if (this.signatures.delete(id)) this.topologyRevision++;
    this.updateReferences(id, this.get(id), null);
    this.order.delete(id);
    return super.delete(id);
  }

  clear() {
    this.topologyRevision++;
    this.scopeRevision++;
    super.clear();
    for (const index of [this.boundary, this.frame, this.surface, this.order, this.signatures]) index.clear();
    this.nextOrder = 0;
  }

  incident(index, ids, collection) {
    const selected = new Set();
    for (const id of ids) for (const dependent of index.get(id) ?? []) selected.add(dependent);
    // Rebased records retain their original collection order; union queries do too.
    return [...selected].sort((a, b) => this.order.get(a) - this.order.get(b))
      .map((id) => collection.get(id)).filter(Boolean);
  }
}

export class SharedDomainStore {
  constructor(
    bus,
    {
      gologId = "golog-1",
      title = "Golog 1",
      workspace = null,
      operationOrigin = null,
      structure = null,
    } = {},
  ) {
    this.bus = bus;
    this.events = new DomainEventsAdapter(bus);
    this.gologId = gologId;
    this.title = title;
    this.workspace = workspace;
    this.operationOrigin = operationOrigin;
    this.structure = structure;
    this.spheres = new Map();
    this.edges = new Map();
    this.surfaces = new Map();
    this.volumes = new Map();
    this.payloads = new Map();
    this.payloadAttachments = new Map();
    this.objects = new IndexedObjectMap();
    this.elementRegistry = createElementRegistry();
    this.locks = new Map();
    this.lockManager = new LockManager({ store: this, events: this.events });
    this.resourceClaims = new ResourceClaimManager({ bus, store: this });
    this.authorityFabric = new AuthorityFabric({ bus, store: this });
    this.semanticConvergence = new SemanticConvergenceService({
      bus,
      store: this,
    });
    this.localSheafGlue = new LocalSheafGlueService({
      bus,
      store: this,
    });
    this.resourceAuthority = new ResourceAuthority({
      bus,
      store: this,
      authorityFabric: this.authorityFabric,
    });
    this.mutationPolicy = new MutationPolicy({
      bus,
      store: this,
      resourceAuthority: this.resourceAuthority,
    });
    this.coordinationEvents = new CoordinationEventStream({ bus, store: this });
    this.selectedSphereId = null;
    this.selectedSimplexId = null;
    this.nextSphereId = 1;
    this.nextEdgeId = 1;
    this.nextSurfaceId = 1;
    this.nextVolumeId = 1;

    registerDomainMessageHandlers(this, bus, {
      operationOrigin: (type, payload) =>
        typeof this.operationOrigin === "function"
          ? this.operationOrigin(type, payload)
          : this.operationOrigin,
    });
    this.authorityFabric.registerBusHandlers();
    this.resourceClaims.registerBusHandlers();
    this.coordinationEvents.registerBusHandlers();
  }

  reserveNumericId(id, prefix, counterName) {
    if (typeof id !== "string" || !id.startsWith(prefix)) {
      return;
    }
    const numeric = Number(id.slice(prefix.length));
    if (Number.isInteger(numeric) && numeric >= this[counterName]) {
      this[counterName] = numeric + 1;
    }
  }

  getPresheaf() {
    const definition = structureDefinitionFor(this.structure?.id ?? "hierarchical-theta-space");
    if (this.presheafCache?.revision !== this.topologyRevision) {
      this.presheafCache = { revision: this.topologyRevision,
        value: presheafFromElements(definition.id, definition.serializeElements(this)) };
    }
    return this.presheafCache.value;
  }

  get topologyRevision() { return this.objects.topologyRevision; }

  get structure() { return this._structure; }
  set structure(value) {
    if (this.objects && (this._structure?.id !== value?.id || this._structure?.schema !== value?.schema)) {
      this.objects.topologyRevision++;
    }
    this._structure = value;
  }

  resolveBoundary(kind, ids, resolve) {
    if (this.boundaryCache?.revision !== this.topologyRevision) {
      this.boundaryCache = { revision: this.topologyRevision, values: new Map() };
    }
    const key = JSON.stringify([kind, ids]), values = this.boundaryCache.values;
    if (!values.has(key)) values.set(key, resolve());
    return values.get(key);
  }

  createElement(payload = {}) {
    return this.elementRegistry.createElement(this, payload);
  }

  findCompactNodePosition(options = {}) {
    return findCompactNodePosition(
      [...this.spheres.values()].map((sphere) => sphere.position),
      options,
    );
  }

  beginInteractionControl(objectId, claimant = {}, { ttlMs = 5_000 } = {}) {
    if (!objectId) {
      return { ok: false, reason: "missing-object-id" };
    }
    const resourceIds = [
      interactionResourceId(this.gologId, objectId),
      simplexResourceId(this.gologId, objectId),
    ];
    const token =
      globalThis.crypto?.randomUUID?.() ?? `interaction-${Date.now()}-${Math.random()}`;
    const payload = {
      resourceIds,
      claimant,
      ttlMs,
      token,
      mode: "human-control",
      localApplied: true,
    };
    const local = this.resourceClaims.claimResources(payload);
    this.bus.emit(RESOURCE_CLAIM_REQUEST_EVENT, payload);
    return {
      ok: Boolean(local?.ok),
      objectId,
      resourceIds,
      claimant,
      token,
      local,
    };
  }

  renewInteractionControl(claim = {}, { ttlMs = 5_000 } = {}) {
    const resourceIds = claim.resourceIds ?? [];
    if (resourceIds.length === 0) {
      return { ok: false, reason: "missing-resource-id" };
    }
    const payload = {
      resourceIds,
      claimant: claim.claimant,
      ttlMs,
      token: claim.token,
      mode: "human-control",
      localApplied: true,
    };
    const local = this.resourceClaims.claimResources(payload);
    this.bus.emit(RESOURCE_CLAIM_REQUEST_EVENT, payload);
    return {
      ok: Boolean(local?.ok),
      objectId: claim.objectId,
      resourceIds,
      claimant: claim.claimant,
      token: claim.token,
      local,
    };
  }

  endInteractionControl(claim = {}) {
    const resourceIds = claim.resourceIds ?? [];
    if (resourceIds.length === 0) {
      return { ok: false, reason: "missing-resource-id" };
    }
    const payload = {
      resourceIds,
      claimant: claim.claimant,
      mode: "human-control",
      localApplied: true,
    };
    const local = this.resourceClaims.releaseResources(payload);
    this.bus.emit(RESOURCE_CLAIM_RELEASE_EVENT, payload);
    return {
      ok: true,
      resourceIds,
      local,
    };
  }

  createSphere(position, options = {}) {
    const { id: requestedId = null } = options;
    const id = requestedId ?? `sphere-${this.nextSphereId++}`;
    this.reserveNumericId(id, "sphere-", "nextSphereId");
    if (this.spheres.has(id)) {
      return id;
    }
    const sphere = {
      id,
      name: String(options.name ?? ""),
      position: position.clone(),
      childGologId: null,
      elementKind: options.elementKind ?? "0-simplex",
      schemaRef: options.schemaRef ?? null,
      render: options.render ? { ...options.render } : undefined,
    };
    this.spheres.set(id, sphere);
    this.syncSphereObject(sphere);
    this.selectedSphereId = id;
    this.selectedSimplexId = id;
    this.emitStateChanged();
    this.events.sphereCreated({ id, position });
    this.events.edgeSelected(null);
    this.events.surfaceSelected(null);
    this.events.volumeSelected(null);
    return id;
  }

  selectSphere(id) {
    this.selectedSphereId = this.spheres.has(id) ? id : null;
    this.selectedSimplexId = this.selectedSphereId;
    this.emitStateChanged();
    this.events.selectSphere(this.selectedSphereId);
  }

  selectEdge(id) {
    const selectedId = this.edges.has(id) ? id : null;
    this.selectedSphereId = null;
    this.selectedSimplexId = selectedId;
    this.emitStateChanged();
    this.events.selectEdge(selectedId);
  }

  selectSurface(id) {
    const selectedId = this.surfaces.has(id) ? id : null;
    this.selectedSphereId = null;
    this.selectedSimplexId = selectedId;
    this.emitStateChanged();
    this.events.selectSurface(selectedId);
  }

  renameSimplex(id, name) {
    const sphere = this.spheres.get(id);
    if (sphere) {
      const previousName = sphere.name;
      sphere.name = String(name ?? "");
      this.syncSphereObject(sphere);
      this.emitStateChanged();
      this.events.simplexRenamed({ id, name: sphere.name });
      this.recordPatchChanges({
        label: `Rename ${id}`,
        coalesceKey: `${this.gologId}:${id}:name`,
        changes: [
          {
            collection: "spheres",
            objectId: id,
            property: "name",
            before: previousName,
            after: sphere.name,
          },
        ],
      });
      return true;
    }

    const edge = this.edges.get(id);
    if (edge) {
      const previousName = edge.name;
      edge.name = String(name ?? "");
      this.syncEdgeObjects(edge);
      this.emitStateChanged();
      this.events.simplexRenamed({ id, name: edge.name });
      this.recordPatchChanges({
        label: `Rename ${id}`,
        coalesceKey: `${this.gologId}:${id}:name`,
        changes: [
          {
            collection: "edges",
            objectId: id,
            property: "name",
            before: previousName,
            after: edge.name,
          },
        ],
      });
      return true;
    }

    const surface = this.surfaces.get(id);
    if (surface) {
      const previousName = surface.name;
      surface.name = String(name ?? "");
      this.syncSurfaceObjects(surface);
      this.emitStateChanged();
      this.events.simplexRenamed({ id, name: surface.name });
      this.recordPatchChanges({
        label: `Rename ${id}`,
        coalesceKey: `${this.gologId}:${id}:name`,
        changes: [
          {
            collection: "surfaces",
            objectId: id,
            property: "name",
            before: previousName,
            after: surface.name,
          },
        ],
      });
      return true;
    }

    const volume = this.volumes.get(id);
    if (volume) {
      const previousName = volume.name;
      volume.name = String(name ?? "");
      syncThetaVolumeObject(this, volume);
      this.emitStateChanged();
      this.events.simplexRenamed({ id, name: volume.name });
      this.events.volumeUpdated(this.getObject(id));
      this.recordPatchChanges({ label: `Rename ${id}`, coalesceKey: `${this.gologId}:${id}:name`,
        changes: [{ collection: "volumes", objectId: id, property: "name", before: previousName, after: volume.name }] });
      return true;
    }
    return false;
  }

  attachChildGologToSphere(id, childGologId) {
    if (!this.spheres.has(id)) return false;
    return this.attachChildGolog(id, childGologId);
  }

  attachChildGolog(id, targetGologId, rootObjectId = null) {
    if (!this.hasSelectableSimplex(id) || !targetGologId) return false;
    return this.attachTypedPayload(id, { type: PAYLOAD_TYPES.NESTED_GOLOG,
      targetGologId: String(targetGologId), ...(rootObjectId ? { rootObjectId } : {}) });
  }

  canAttachPayload(id) {
    return this.hasSelectableSimplex(id);
  }

  hasSelectableSimplex(id) {
    return this.spheres.has(id) || this.edges.has(id) || this.surfaces.has(id) || this.volumes.has(id);
  }

  primaryPayloadForObject(id) {
    this.syncPrimaryPayload(id);
    const payload = this.payloads.get(id);
    return payload ?? null;
  }

  syncPrimaryPayload(id) {
    const attachments = this.payloadAttachments.get(id) ?? [];
    if (attachments.length > 0) {
      this.payloads.set(id, attachments[0]);
      return;
    }

    const sphere = this.spheres.get(id);
    if (sphere?.childGologId) {
      const payload = {
        type: "nested-golog",
        targetGologId: sphere.childGologId,
      };
      this.payloadAttachments.set(id, [payload]);
      this.payloads.set(id, payload);
      return;
    }

    this.payloads.delete(id);
  }

  getPayloads(id) {
    this.syncPrimaryPayload(id);
    return (this.payloadAttachments.get(id) ?? []).map((payload) =>
      cloneStoreValue(payload),
    );
  }

  getPayload(id, selector = {}) {
    if (selector?.type) {
      return this.getPayloadByType(id, selector.type);
    }
    if (selector?.kind) {
      return this.getPayloadByKind(id, selector.kind);
    }
    const payload = this.primaryPayloadForObject(id);
    return payload ? cloneStoreValue(payload) : null;
  }

  getPayloadByType(id, type) {
    const key = payloadAttachmentKey(type);
    return this.getPayloadByKey(id, key);
  }

  getPayloadByKind(id, kind) {
    return this.getPayloadByKey(id, kind);
  }

  getPayloadByKey(id, key) {
    this.syncPrimaryPayload(id);
    const payload = (this.payloadAttachments.get(id) ?? []).find(
      (entry) => payloadAttachmentKey(entry) === key,
    );
    return payload ? cloneStoreValue(payload) : null;
  }

  rawPayloadByKey(id, key) {
    this.syncPrimaryPayload(id);
    return (this.payloadAttachments.get(id) ?? []).find(
      (entry) => payloadAttachmentKey(entry) === key,
    ) ?? null;
  }

  rawPayloadByType(id, type) {
    return this.rawPayloadByKey(id, payloadAttachmentKey(type));
  }

  deletePayloadsForObject(id) {
    this.payloadAttachments.delete(id);
    this.payloads.delete(id);
    const sphere = this.spheres.get(id);
    if (sphere) {
      sphere.childGologId = null;
      this.syncSphereObject(sphere);
    }
  }

  deletePayloadAttachment(id, key) {
    const attachments = this.payloadAttachments.get(id) ?? [];
    const next = attachments.filter(
      (payload) => payloadAttachmentKey(payload) !== key,
    );
    if (next.length === 0) {
      this.payloadAttachments.delete(id);
    } else {
      this.payloadAttachments.set(id, next);
    }
    if (key === payloadAttachmentKey(PAYLOAD_TYPES.NESTED_GOLOG)) {
      const sphere = this.spheres.get(id);
      if (sphere) {
        sphere.childGologId = null;
        this.syncSphereObject(sphere);
      }
    }
    this.syncPrimaryPayload(id);
  }

  detachPayloadAttachment(id, key, client = {}) {
    if (!this.hasSelectableSimplex(id)) {
      return false;
    }
    const resolvedKey = payloadAttachmentKey(key);
    const previousPayload = this.getPayloadByKey(id, resolvedKey);
    if (!previousPayload) {
      return false;
    }
    const lockIds = this.getLockScopeForObject(id);
    if (!this.canMutateObjects(lockIds, client, "payload:delete")) {
      return false;
    }

    this.deletePayloadAttachment(id, resolvedKey);
    this.emitStateChanged();
    this.recordPatchChanges({
      label: `Delete ${resolvedKey} payload from ${id}`,
      changes: [
        {
          collection: "payloads",
          objectId: id,
          property: null,
          before: previousPayload,
          after: this.getPayloadByKey(id, resolvedKey),
        },
      ],
    });
    return {
      id,
      key: resolvedKey,
      previousPayload,
    };
  }

  attachTextPayload(id, text = "") {
    return this.attachTypedPayload(id, {
      type: PAYLOAD_TYPES.MARKDOWN,
      text,
    });
  }

  updateTextPayload(id, text = "") {
    const payload = this.rawPayloadByType(id, PAYLOAD_TYPES.MARKDOWN);
    if (payload?.type !== PAYLOAD_TYPES.MARKDOWN) {
      return false;
    }

    const previousText = payload.text ?? "";
    payload.text = String(text ?? "");
    this.emitStateChanged();
    this.recordPatchChanges({
      label: `Update text on ${id}`,
      coalesceKey: `${this.gologId}:${id}:payload-text`,
      changes: [
        {
          collection: "payloads",
          objectId: id,
          property: "text",
          before: previousText,
          after: payload.text,
        },
      ],
    });
    return true;
  }

  normalizePayloadForObject(id, payload) {
    const normalized = normalizePayload(payload);
    if (normalized.type === PAYLOAD_TYPES.NESTED_GOLOG) {
      return normalizeShapeExpansionPayload(this.workspace, this, id, normalized);
    }

    return normalized;
  }

  writeNormalizedPayload(id, payload) {
    const normalized = this.normalizePayloadForObject(id, payload);
    const sphere = this.spheres.get(id);
    if (normalized.type === PAYLOAD_TYPES.NESTED_GOLOG) {
      if (sphere) {
        sphere.childGologId = normalized.targetGologId;
        this.syncSphereObject(sphere);
      }
      this.events.childGologAttached({
        id,
        childGologId: normalized.targetGologId,
        rootObjectId: normalized.rootObjectId ?? null,
        parentGologId: this.gologId,
      });
    }

    const key = payloadAttachmentKey(normalized);
    const attachments = this.payloadAttachments.get(id) ?? [];
    const existingIndex = attachments.findIndex(
      (entry) => payloadAttachmentKey(entry) === key,
    );
    if (existingIndex >= 0) {
      attachments[existingIndex] = normalized;
    } else {
      attachments.push(normalized);
    }
    attachments.sort(
      (left, right) => payloadPrimaryPriority(left) - payloadPrimaryPriority(right),
    );
    this.payloadAttachments.set(id, attachments);
    this.syncPrimaryPayload(id);
    return normalized;
  }

  attachTypedPayload(id, payload) {
    if (!this.canAttachPayload(id)) {
      return false;
    }

    const key = payloadAttachmentKey(payload);
    const previousPayload = this.getPayloadByKey(id, key);
    const normalized = this.writeNormalizedPayload(id, payload);
    this.emitStateChanged();
    this.recordPatchChanges({
      label: `Attach ${normalized.type} to ${id}`,
      changes: [
        {
          collection: "payloads",
          objectId: id,
          property: null,
          before: previousPayload,
          after: this.getPayloadByKey(id, key),
        },
      ],
    });
    return true;
  }

  updateTypedPayload(id, payload) {
    if (!this.hasSelectableSimplex(id)) {
      return false;
    }
    const key = payloadAttachmentKey(payload);
    const previousPayload = this.getPayloadByKey(id, key);
    if (!previousPayload) {
      return false;
    }
    const normalized = this.normalizePayloadForObject(id, payload);
    if (
      payloadKind(previousPayload) === "nested-golog" ||
      payloadKind(normalized) === "nested-golog" ||
      payloadKind(previousPayload) !== payloadKind(normalized)
    ) {
      return false;
    }

    this.writeNormalizedPayload(id, normalized);
    this.emitStateChanged();
    this.recordPatchChanges({
      label: `Update ${normalized.type} on ${id}`,
      coalesceKey: `${this.gologId}:${id}:payload:${payloadKind(normalized)}`,
      changes: [
        {
          collection: "payloads",
          objectId: id,
          property: null,
          before: previousPayload,
          after: this.getPayloadByKey(id, key),
        },
      ],
    });
    return true;
  }

  moveSphere(id, position, client = {}) {
    const sphere = this.spheres.get(id);
    if (!sphere) {
      return false;
    }

    const lockIds = this.getLockScopeForObject(id);
    if (!this.canMutateObjects(lockIds, client, "sphere:move")) {
      return false;
    }

    sphere.position.copy(position);
    this.syncSphereObject(sphere);

    const changedEdges = this.connectedEdges(id);
    this.syncFramesForSphere(id);
    for (const edge of changedEdges) {
      this.syncEdgeObjects(edge);
    }
    const changedSurfaces = this.syncSurfacesForEdges(changedEdges);

    this.emitStateChanged();
    this.events.sphereMoved({ id, position });
    for (const edge of changedEdges) {
      this.events.edgeMidpointMoved(this.edgeRenderPayload(edge));
    }
    for (const surface of changedSurfaces) {
      this.events.surfaceUpdated(this.surfaceRenderPayload(surface));
    }
    return true;
  }

  commitLayoutPositions(positions = [], client = {}) {
    return this.applyLayoutCoordinates(positions, client.edgeControls, client.surfaceControls, client);
  }

  applyLayoutPreviewPositions(positions = [], edgeControls = [], surfaceControls = []) {
    return this.applyLayoutCoordinates(positions, edgeControls, surfaceControls);
  }

  applyLayoutCoordinates(positions = [], edgeControls = [], surfaceControls = [], client = null) {
    // Validate the whole coordinate patch before changing any part of the store.
    const entries = positions.map((entry) => ({
      id: String(entry.id),
      position: vector3FromStoreValue(entry.position, "layout position"),
    })).filter((entry) => this.spheres.has(entry.id));
    const edgeEntries = edgeControls.map((entry) => {
      const bend = entry.bend == null ? null : new THREE.Vector2(
        Number(entry.bend.x ?? entry.bend[0]), Number(entry.bend.y ?? entry.bend[1]),
      );
      if (bend && !bend.toArray().every(Number.isFinite)) {
        throw new TypeError("Layout bend must contain finite coordinates");
      }
      return {
        id: String(entry.id), bend, frame: normalizeFrameGauge(entry.frame),
        midpoint: bend ? null : vector3FromStoreValue(entry.midpoint, "layout edge midpoint"),
      };
    }).filter((entry) => this.edges.has(entry.id));
    const surfaceEntries = surfaceControls.map((entry) => {
      const controlCoordinate = Number(entry.controlCoordinate);
      if (!Number.isFinite(controlCoordinate)) {
        throw new TypeError("Layout surface coordinate must be finite");
      }
      return { id: String(entry.id), controlCoordinate,
        controlDirection: normalizeControlDirection(entry.controlDirection) };
    }).filter((entry) => this.surfaces.has(entry.id));
    const futurePositions = new Map(entries.map((entry) => [entry.id, entry.position]));
    const pairGauges = new Map();
    for (const entry of edgeEntries) if (entry.frame) {
      const edge = this.edges.get(entry.id);
      // A coordinate publication may omit small endpoint motion. Transport its
      // valid gauge to this store's boundary when restoring the shared frame.
      const previous = pairGauges.get(edge.frameId);
      if (previous && !frameGaugesEqual(previous.frame, entry.frame)) throw new TypeError("Conflicting shared-pair frames");
      pairGauges.set(edge.frameId, { ...entry, edge });
    }
    const explicitEdges = new Set(edgeEntries.map((entry) => entry.id));
    for (const { edge, frame } of pairGauges.values()) {
      this.assertPairGaugePreservesPeers(edge.sourceId, edge.targetId, frame, futurePositions, explicitEdges);
    }
    if (client) {
      const lockIds = [...new Set([...entries, ...edgeEntries, ...surfaceEntries]
        .flatMap((entry) => this.getLockScopeForObject(entry.id)))];
      if (!this.canMutateObjects(lockIds, client, "layout:commit")) return false;
    }

    const moved = [], edgeMoved = [], surfaceMoved = [];
    const changedEdges = new Map(), changedSurfaces = new Map();
    this.batchLayoutObjectUpdates(() => {
      for (const entry of entries) {
        const sphere = this.spheres.get(entry.id);
        if (sphere.position.distanceToSquared(entry.position) <= 1e-12) continue;
        sphere.position.copy(entry.position);
        this.syncSphereObject(sphere);
        moved.push({ id: entry.id, position: entry.position.clone() });
        for (const edge of this.connectedEdges(entry.id)) changedEdges.set(edge.id, edge);
      }
      for (const entry of moved) this.syncFramesForSphere(entry.id);
      for (const edge of changedEdges.values()) this.syncEdgeObjects(edge);
      for (const { edge, frame } of pairGauges.values()) {
        for (const peer of this.restoreNodePairFrameGauge(edge.sourceId, edge.targetId, frame)) changedEdges.set(peer.id, peer);
      }
      for (const entry of edgeEntries) {
        const edge = this.edges.get(entry.id);
        const frame = this.syncNodePairFrame(edge.sourceId, edge.targetId);
        const bend = entry.bend ?? this.bendFromFramePoint(frame, entry.midpoint);
        if (edge.bend.distanceToSquared(bend) <= 1e-12) continue;
        edge.bend.copy(bend);
        this.syncEdgeObjects(edge);
        changedEdges.set(edge.id, edge);
        edgeMoved.push({ id: edge.id, bend: edge.bend.clone(), midpoint: edge.midpoint.clone() });
      }
      for (const entry of surfaceEntries) if (entry.controlDirection) {
        const surface = this.surfaces.get(entry.id);
        if (surface.controlDirection.distanceToSquared(entry.controlDirection) > 1e-12) {
          surface.controlDirection.copy(entry.controlDirection);
          changedSurfaces.set(surface.id, surface);
        }
      }
      for (const surface of this.surfacesForEdges([...changedEdges.values()])) {
        changedSurfaces.set(surface.id, surface);
      }
      for (const entry of surfaceEntries) {
        const surface = this.surfaces.get(entry.id);
        if (Math.abs(surface.controlCoordinate - entry.controlCoordinate) <= 1e-12 && !changedSurfaces.has(surface.id)) continue;
        surface.controlCoordinate = entry.controlCoordinate;
        changedSurfaces.set(surface.id, surface);
        surfaceMoved.push({ ...entry });
      }
      for (const surface of changedSurfaces.values()) this.syncSurfaceObjects(surface);
    });
    if (moved.length || changedEdges.size || changedSurfaces.size) {
      this.emitStateChanged();
      for (const entry of moved) this.events.sphereMoved(entry);
      for (const edge of changedEdges.values()) this.events.edgeMidpointMoved(this.edgeRenderPayload(edge));
      for (const surface of changedSurfaces.values()) this.events.surfaceUpdated(this.surfaceRenderPayload(surface));
    }
    return { moved, edgeMoved, surfaceMoved };
  }

  createEdge(sourceId, targetId, options = {}) {
    const { id: requestedId = null } = options;
    if (
      sourceId === targetId ||
      !this.spheres.has(sourceId) ||
      !this.spheres.has(targetId)
    ) {
      return null;
    }

    const gauge = normalizeFrameGauge(options.frame);
    if (gauge) {
      assertFrameTangent(gauge, ...this.nodePairEndpoints(sourceId, targetId).map((id) => this.spheres.get(id).position));
      this.assertPairGaugePreservesPeers(sourceId, targetId, gauge);
      this.restoreNodePairFrameGauge(sourceId, targetId, gauge);
    }
    const frame = this.syncNodePairFrame(sourceId, targetId);
    const id = requestedId ?? `edge-${this.nextEdgeId++}`;
    this.reserveNumericId(id, "edge-", "nextEdgeId");
    if (this.edges.has(id)) {
      return id;
    }
    const bend = options.bend?.clone?.() ??
      this.findAvailableEdgeBendForPair(sourceId, targetId);
    const midpoint = this.pointFromFrameBend(frame, bend);
    const edge = {
      id,
      name: String(options.name ?? ""),
      sourceId,
      targetId,
      frameId: frame.id,
      bend,
      midpoint,
      elementKind: options.elementKind ?? "1-simplex",
      arrowKind: options.arrowKind ?? options.elementKind ?? "1-simplex",
      schemaRef: options.schemaRef ?? null,
      render: options.render ? { ...options.render } : undefined,
      handleRender: options.handleRender
        ? { ...options.handleRender }
        : undefined,
    };
    this.edges.set(id, edge);
    this.syncEdgeObjects(edge);
    this.selectedSphereId = targetId;
    this.selectedSimplexId = targetId;
    this.emitStateChanged();
    this.events.edgeCreated(this.edgeRenderPayload(edge));
    this.events.selectSphere(targetId);
    return id;
  }

  deleteEdge(id, client = {}) {
    const edge = this.edges.get(id);
    if (!edge) {
      return false;
    }
    assertShapeExpansionDeletionAllowed(this, id);

    const lockIds = this.edgeLockScope(id, {
      includeFrame: true,
      includeSurfaces: true,
    });
    if (!this.canMutateObjects(lockIds, client, "edge:delete")) {
      return false;
    }

    const frameId = edge.frameId;
    const deletedSurfaces = this.surfacesForEdge(id)
      .map((surface) => this.deleteSurfaceRecord(surface.id))
      .filter(Boolean);
    const handleId = this.edgeBendHandleId(id);
    this.edges.delete(id);
    this.deletePayloadsForObject(id);
    this.removeObject(id);
    this.removeObject(handleId);
    this.locks.delete(id);
    this.locks.delete(handleId);
    this.deleteFrameIfUnused(frameId);

    const deletedSelectableIds = new Set([
      id,
      ...deletedSurfaces.map((surface) => surface.id),
    ]);
    const selectionCleared = deletedSelectableIds.has(this.selectedSimplexId);
    if (selectionCleared) {
      this.selectedSphereId = null;
      this.selectedSimplexId = null;
    }

    this.emitStateChanged();
    for (const surface of deletedSurfaces) {
      this.events.surfaceDeleted(surface);
    }
    this.events.edgeDeleted({
      id,
      handleId,
      surfaceIds: deletedSurfaces.map((surface) => surface.id),
    });
    if (selectionCleared) {
      this.events.selectSphere(null);
    }
    return {
      id,
      surfaceIds: deletedSurfaces.map((surface) => surface.id),
    };
  }

  rebaseEdge(id, sourceId, targetId, client = {}) {
    const edge = this.edges.get(id);
    if (!edge || !this.spheres.has(sourceId) || !this.spheres.has(targetId)) {
      return false;
    }
    if (sourceId === targetId) {
      return false;
    }
    if (sourceId !== edge.sourceId || targetId !== edge.targetId) {
      assertShapeExpansionBoundaryEditAllowed(this, id);
    }

    const dependentSurfaces = this.surfacesForEdge(id);
    const cascadeSurfaces = Boolean(client.cascadeSurfaces);
    if (dependentSurfaces.length > 0 && !cascadeSurfaces) {
      return false;
    }

    const lockIds = this.edgeLockScope(id, {
      includeFrame: true,
      includeSurfaces: true,
    });
    if (!this.canMutateObjects(lockIds, client, "edge:rebase")) {
      return false;
    }

    const previous = {
      sourceId: edge.sourceId,
      targetId: edge.targetId,
      frameId: edge.frameId,
      bend: edge.bend.clone(),
      midpoint: edge.midpoint.clone(),
    };
    const deletedSurfaces = cascadeSurfaces
      ? dependentSurfaces.map((surface) => this.deleteSurfaceRecord(surface.id))
      : [];

    edge.sourceId = sourceId;
    edge.targetId = targetId;
    const frame = this.syncNodePairFrame(sourceId, targetId);
    edge.frameId = frame.id;
    if (client.preserveBend === false) {
      edge.bend.copy(
        this.findAvailableEdgeBendForPair(sourceId, targetId),
      );
    }
    edge.midpoint.copy(this.pointFromFrameBend(frame, edge.bend));
    this.syncEdgeObjects(edge);
    this.deleteFrameIfUnused(previous.frameId);
    this.emitStateChanged();
    for (const surface of deletedSurfaces) {
      this.events.surfaceDeleted(surface);
    }
    this.events.edgeMidpointMoved(this.edgeRenderPayload(edge));
    return {
      id,
      previous,
      sourceId,
      targetId,
      deletedSurfaceIds: deletedSurfaces.map((surface) => surface.id),
    };
  }

  edgeBendsForOrderedPair(sourceId, targetId) {
    return [...this.edges.values()]
      .filter((edge) => edge.sourceId === sourceId && edge.targetId === targetId)
      .map((edge) => edge.bend);
  }

  connectedEdges(sphereId) {
    return this.objects.incident(this.objects.boundary, [sphereId], this.edges);
  }

  edgesForFrame(frameId) {
    return this.objects.incident(this.objects.frame, [frameId], this.edges);
  }

  findAvailableEdgeBendForPair(sourceId, targetId) {
    return findNearestAvailableEdgeBend(
      this.edgeBendsForOrderedPair(sourceId, targetId),
    );
  }

  moveEdgeMidpoint(id, midpoint, client = {}) {
    const edge = this.edges.get(id);
    if (!edge) {
      return false;
    }

    const lockIds = this.getLockScopeForObject(id);
    if (!this.canMutateObjects(lockIds, client, "edge:move-midpoint")) {
      return false;
    }

    const frame = this.syncNodePairFrame(edge.sourceId, edge.targetId);
    edge.bend.copy(this.bendFromFramePoint(frame, midpoint));
    edge.midpoint.copy(this.pointFromFrameBend(frame, edge.bend));
    this.syncEdgeObjects(edge);
    const changedSurfaces = this.syncSurfacesForEdges([edge]);
    this.emitStateChanged();
    this.events.edgeMidpointMoved(this.edgeRenderPayload(edge));
    for (const surface of changedSurfaces) {
      this.events.surfaceUpdated(this.surfaceRenderPayload(surface));
    }
    return true;
  }

  createSurface(firstEdgeId, secondEdgeId, options = {}) {
    return createTwoCellElement(this, firstEdgeId, secondEdgeId, options);
  }

  canCreateSurfaceBetweenEdges(firstEdge, secondEdge) {
    return canCreateTwoCellElement(firstEdge, secondEdge);
  }

  createTwoSimplex(edgeIds, options = {}) {
    return createTwoSimplexElement(this, edgeIds, options);
  }

  createThetaVolume(options = {}) {
    return createThetaVolumeElement(this, options);
  }

  selectVolume(id) {
    if (id != null && !this.volumes.has(id)) return false;
    this.selectedSphereId = null;
    this.selectedSimplexId = id;
    this.emitStateChanged();
    this.events.sphereSelected(null);
    this.events.edgeSelected(null);
    this.events.surfaceSelected(null);
    this.events.volumeSelected(id);
    return true;
  }

  dependentVolumeIds(objectId) {
    if (!this.volumes.size || !this.hasSelectableSimplex(objectId)) return [];
    return this.getPresheaf().support([objectId]).map((entry) => entry.id)
      .filter((id) => this.volumes.has(id));
  }

  deleteVolumeRecord(id) {
    const volume = this.volumes.get(id);
    if (!volume) return null;
    assertShapeExpansionDeletionAllowed(this, id);
    this.volumes.delete(id);
    this.deletePayloadsForObject(id);
    this.removeObject(id);
    this.locks.delete(id);
    if (this.selectedSimplexId === id) {
      this.selectedSimplexId = null;
      this.selectedSphereId = null;
      this.events.volumeSelected(null);
    }
    const result = { id, boundaryFaceIds: [...volume.boundaryFaceIds] };
    this.events.volumeDeleted(result);
    return result;
  }

  deleteDependentVolumes(objectId) {
    return this.dependentVolumeIds(objectId).reverse().map((id) => this.deleteVolumeRecord(id));
  }

  deleteVolume(id, client = {}) {
    if (!this.volumes.has(id)) return false;
    assertShapeExpansionDeletionAllowed(this, id);
    const ids = this.dependentVolumeIds(id);
    if (!this.canMutateObjects(ids, client, "volume:delete")) return false;
    const deleted = ids.reverse().map((volumeId) => this.deleteVolumeRecord(volumeId));
    this.emitStateChanged();
    return deleted.find((entry) => entry.id === id);
  }

  canCreateTwoSimplex(edgeIds) {
    return Boolean(this.resolveComposableEdgeTriple(edgeIds));
  }

  inferVirtualCellBoundary(edgeIds) {
    return inferVirtualCellBoundary(this, edgeIds);
  }

  canCreateVirtualCell(edgeIds) {
    return Boolean(this.inferVirtualCellBoundary(edgeIds));
  }

  resolveComposableEdgeTriple(edgeIds) {
    return this.resolveBoundary("triangle", edgeIds, () => this.findComposableEdgeTriple(edgeIds));
  }

  findComposableEdgeTriple(edgeIds) {
    const uniqueIds = [...new Set((edgeIds ?? []).filter(Boolean))];
    if (uniqueIds.length !== 3) {
      return null;
    }

    const edges = uniqueIds.map((id) => this.edges.get(id));
    if (edges.some((edge) => !edge)) {
      return null;
    }

    for (const firstEdge of edges) {
      for (const secondEdge of edges) {
        if (secondEdge === firstEdge) {
          continue;
        }
        for (const compositeEdge of edges) {
          if (compositeEdge === firstEdge || compositeEdge === secondEdge) {
            continue;
          }
          if (
            firstEdge.targetId === secondEdge.sourceId &&
            compositeEdge.sourceId === firstEdge.sourceId &&
            compositeEdge.targetId === secondEdge.targetId
          ) {
            const source = this.spheres.get(firstEdge.sourceId);
            const middle = this.spheres.get(firstEdge.targetId);
            const target = this.spheres.get(secondEdge.targetId);
            if (!source || !middle || !target) {
              return null;
            }
            return {
              firstEdge,
              secondEdge,
              compositeEdge,
              source,
              middle,
              target,
            };
          }
        }
      }
    }

    return null;
  }

  moveSurfaceControl(id, controlCoordinate, client = {}) {
    const surface = this.surfaces.get(id);
    if (!surface) {
      return false;
    }

    const lockIds = this.getLockScopeForObject(id);
    if (!this.canMutateObjects(lockIds, client, "surface:move-control")) {
      return false;
    }

    surface.controlCoordinate = Number(controlCoordinate);
    this.syncSurfaceObjects(surface);
    this.emitStateChanged();
    this.events.surfaceUpdated(this.surfaceRenderPayload(surface));
    return true;
  }

  surfacesForEdge(edgeId) {
    return this.objects.incident(this.objects.boundary, [edgeId], this.surfaces);
  }

  surfacesForEdges(edges) {
    return this.objects.incident(this.objects.boundary, edges.map((edge) => edge.id), this.surfaces);
  }

  volumesForSurface(surfaceId) {
    return this.volumesForSurfaces([surfaceId]);
  }

  volumesForSurfaces(surfaceIds) {
    return this.objects.incident(this.objects.surface, surfaceIds, this.volumes);
  }

  syncSurfacesForEdges(edges) {
    const changedSurfaces = this.surfacesForEdges(edges);
    for (const surface of changedSurfaces) {
      this.syncSurfaceObjects(surface);
    }
    return changedSurfaces;
  }

  deleteSurfaceRecord(surfaceId) {
    const surface = this.surfaces.get(surfaceId);
    if (!surface) {
      return null;
    }

    this.deleteDependentVolumes(surfaceId);

    const handleId = this.surfaceControlHandleId(surfaceId);
    this.surfaces.delete(surfaceId);
    this.deletePayloadsForObject(surfaceId);
    this.removeObject(surfaceId);
    this.removeObject(handleId);
    this.locks.delete(surfaceId);
    this.locks.delete(handleId);
    return {
      id: surfaceId,
      type: surface.type,
      handleId,
      edgeIds: [...surface.edgeIds],
    };
  }

  deleteSurface(id, client = {}) {
    const surface = this.surfaces.get(id);
    if (!surface) {
      return false;
    }
    assertShapeExpansionDeletionAllowed(this, id);
    const lockIds = this.getLockScopeForObject(id);
    if (!this.canMutateObjects(lockIds, client, "surface:delete")) {
      return false;
    }

    const deleted = this.deleteSurfaceRecord(id);
    const selectionCleared = this.selectedSimplexId === id;
    if (selectionCleared) {
      this.selectedSphereId = null;
      this.selectedSimplexId = null;
    }
    this.emitStateChanged();
    this.events.surfaceDeleted(deleted);
    if (selectionCleared) {
      this.events.selectSphere(null);
    }
    return deleted;
  }

  deleteSphere(id, client = {}) {
    const sphere = this.spheres.get(id);
    if (!sphere) {
      return false;
    }
    assertShapeExpansionDeletionAllowed(this, id);
    const connectedEdges = this.connectedEdges(id);
    const cascadeEdges = Boolean(client.cascadeEdges);
    if (connectedEdges.length > 0 && !cascadeEdges) {
      return false;
    }

    const lockIds = [
      ...new Set(
        [
          ...this.getLockScopeForObject(id),
          ...connectedEdges.flatMap((edge) =>
            this.edgeLockScope(edge.id, {
              includeFrame: true,
              includeSurfaces: true,
            }),
          ),
        ],
      ),
    ];
    if (!this.canMutateObjects(lockIds, client, "sphere:delete")) {
      return false;
    }

    const deletedEdges = [];
    for (const edge of [...connectedEdges]) {
      const deleted = this.deleteEdge(edge.id, client);
      if (deleted) {
        deletedEdges.push(deleted);
      }
    }

    const previousPayloads = this.getPayloads(id);
    this.spheres.delete(id);
    this.deletePayloadsForObject(id);
    this.removeObject(id);
    this.locks.delete(id);
    const selectionCleared =
      this.selectedSimplexId === id || this.selectedSphereId === id;
    if (selectionCleared) {
      this.selectedSphereId = null;
      this.selectedSimplexId = null;
    }

    this.emitStateChanged();
    if (selectionCleared) {
      this.events.selectSphere(null);
    }
    return {
      id,
      deletedEdgeIds: deletedEdges.map((edge) => edge.id),
      deletedSurfaceIds: deletedEdges.flatMap((edge) => edge.surfaceIds ?? []),
      previousPayloads,
      childGologId: sphere.childGologId ?? null,
    };
  }

  deleteFrameIfUnused(frameId) {
    if (frameId && this.edgesForFrame(frameId).length === 0) {
      this.removeObject(frameId);
      this.locks.delete(frameId);
    }
  }

  acquireInteractionLock(objectId, client = {}) {
    const result = this.lockManager.acquireLocks(this.getLockScopeForObject(objectId), client);
    if (result.ok) {
      this.workspace?.patchHistory?.beginInteraction(this, objectId);
    }
    return result;
  }

  acquireLocks(objectIds, client = {}) {
    return this.lockManager.acquireLocks(objectIds, client);
  }

  releaseLocks(objectIds, client = {}) {
    const result = this.lockManager.releaseLocks(objectIds, client);
    if (result.ok) {
      this.workspace?.patchHistory?.endInteractionsForReleased(
        this,
        result.lockIds,
      );
    }
    return result;
  }

  getLockScopeForObject(objectId) {
    // Helper membership affects lock scopes without changing mathematical topology.
    return this.resolveBoundary("lock-scope", [this.objects.scopeRevision, objectId],
      () => this.lockManager.getLockScopeForObject(objectId)).slice();
  }

  edgeLockScope(edgeId, { includeFrame = false, includeSurfaces = false } = {}) {
    return this.lockManager.edgeLockScope(edgeId, {
      includeFrame,
      includeSurfaces,
    });
  }

  surfaceLockScope(surfaceId) {
    return this.lockManager.surfaceLockScope(surfaceId);
  }

  frameLockScope(frameId) {
    return this.lockManager.frameLockScope(frameId);
  }

  canMutateObjects(objectIds, client = {}, operation = "mutation") {
    const ids = new Set(objectIds);
    const scope = this.resolveBoundary("mutation-scope", [...ids], () => {
      if (this.volumes.size) {
        const seeds = [...ids].filter((id) => this.hasSelectableSimplex(id));
        if (seeds.length) {
          for (const { id } of this.getPresheaf().support(seeds)) {
            if (this.volumes.has(id)) ids.add(id);
          }
        }
      }
      return [...ids];
    });
    return this.lockManager.canMutateObjects(scope, client, operation);
  }

  denyLock(objectIds, owner, reason, detail = {}) {
    return this.lockManager.denyLock(objectIds, owner, reason, detail);
  }

  recordPatchChanges({ label, changes, coalesceKey = null }) {
    return this.workspace?.patchHistory?.recordChanges({
      gologId: this.gologId,
      label,
      changes,
      coalesceKey,
    });
  }

  capturePatchSnapshot(objectId) {
    const sphere = this.spheres.get(objectId);
    if (sphere) {
      return {
        objectId,
        collection: "spheres",
        properties: {
          position: clonePatchValue(sphere.position),
        },
      };
    }

    const edge = this.edges.get(objectId);
    if (edge) {
      return {
        objectId,
        collection: "edges",
        properties: {
          bend: clonePatchValue(edge.bend),
        },
      };
    }

    const surface = this.surfaces.get(objectId);
    if (surface) {
      return {
        objectId,
        collection: "surfaces",
        properties: {
          controlCoordinate: surface.controlCoordinate,
        },
      };
    }

    return null;
  }

  diffPatchSnapshot(snapshot) {
    const current = this.capturePatchSnapshot(snapshot?.objectId);
    if (!snapshot || !current || current.collection !== snapshot.collection) {
      return [];
    }

    const changes = [];
    for (const [property, before] of Object.entries(snapshot.properties ?? {})) {
      const after = current.properties[property];
      if (!patchValuesEqual(before, after)) {
        changes.push({
          collection: snapshot.collection,
          objectId: snapshot.objectId,
          property,
          before,
          after,
        });
      }
    }
    return changes;
  }

  applyPatchOperation(operation) {
    if (operation.collection === "volumes" && operation.property === "name") {
      return this.renameSimplex(operation.objectId, operation.value);
    }
    if (operation.collection === "spheres") {
      return this.applySpherePatch(operation);
    }
    if (operation.collection === "edges") {
      return this.applyEdgePatch(operation);
    }
    if (operation.collection === "surfaces") {
      return this.applySurfacePatch(operation);
    }
    if (operation.collection === "payloads") {
      return this.applyPayloadPatch(operation);
    }
    throw new Error(`Unsupported patch collection: ${operation.collection}`);
  }

  applySpherePatch({ objectId, property, value }) {
    const sphere = this.spheres.get(objectId);
    if (!sphere) {
      throw new Error(`Patch target sphere does not exist: ${objectId}`);
    }

    if (property === "name") {
      return this.renameSimplex(objectId, value);
    }

    if (property === "childGologId") {
      sphere.childGologId = value ? String(value) : null;
      this.syncSphereObject(sphere);
      this.emitStateChanged();
      this.events.childGologAttached({
        id: objectId,
        childGologId: sphere.childGologId,
        parentGologId: this.gologId,
      });
      return true;
    }

    if (property !== "position") {
      throw new Error(`Unsupported sphere patch property: ${property}`);
    }

    const [x, y, z] = coerceVector3Array(value, `${objectId}.position`);
    sphere.position.set(x, y, z);
    this.syncSphereObject(sphere);

    const changedEdges = this.connectedEdges(objectId);
    this.syncFramesForSphere(objectId);
    for (const edge of changedEdges) {
      this.syncEdgeObjects(edge);
    }
    const changedSurfaces = this.syncSurfacesForEdges(changedEdges);

    this.emitStateChanged();
    this.events.sphereMoved({ id: objectId, position: sphere.position.clone() });
    for (const edge of changedEdges) {
      this.events.edgeMidpointMoved(this.edgeRenderPayload(edge));
    }
    for (const surface of changedSurfaces) {
      this.events.surfaceUpdated(this.surfaceRenderPayload(surface));
    }
    return true;
  }

  applyEdgePatch({ objectId, property, value }) {
    const edge = this.edges.get(objectId);
    if (!edge) {
      throw new Error(`Patch target edge does not exist: ${objectId}`);
    }

    if (property === "name") {
      return this.renameSimplex(objectId, value);
    }

    if (property !== "bend") {
      throw new Error(`Unsupported edge patch property: ${property}`);
    }

    const [x, y] = coerceVector2Array(value, `${objectId}.bend`);
    edge.bend.set(x, y);
    const frame = this.syncNodePairFrame(edge.sourceId, edge.targetId);
    edge.midpoint.copy(this.pointFromFrameBend(frame, edge.bend));
    this.syncEdgeObjects(edge);
    const changedSurfaces = this.syncSurfacesForEdges([edge]);
    this.emitStateChanged();
    this.events.edgeMidpointMoved(this.edgeRenderPayload(edge));
    for (const surface of changedSurfaces) {
      this.events.surfaceUpdated(this.surfaceRenderPayload(surface));
    }
    return true;
  }

  applySurfacePatch({ objectId, property, value }) {
    const surface = this.surfaces.get(objectId);
    if (!surface) {
      throw new Error(`Patch target surface does not exist: ${objectId}`);
    }

    if (property === "name") {
      return this.renameSimplex(objectId, value);
    }

    if (property !== "controlCoordinate") {
      throw new Error(`Unsupported surface patch property: ${property}`);
    }

    surface.controlCoordinate = Number(value);
    this.syncSurfaceObjects(surface);
    this.emitStateChanged();
    this.events.surfaceUpdated(this.surfaceRenderPayload(surface));
    return true;
  }

  applyPayloadPatch({ objectId, property, value }) {
    if (!this.hasSelectableSimplex(objectId)) {
      throw new Error(`Patch target payload owner does not exist: ${objectId}`);
    }

    if (property === null) {
      this.setPayloadFromPatch(objectId, value);
      this.emitStateChanged();
      return true;
    }

    if (property !== "text") {
      throw new Error(`Unsupported payload patch property: ${property}`);
    }

    const payload = this.getPayloads(objectId).find(payloadHasText);
    if (!payloadHasText(payload)) {
      throw new Error(`Patch target text payload does not exist: ${objectId}`);
    }
    this.updateTypedPayload(objectId, {
      ...payload,
      text: String(value ?? ""),
    });
    this.emitStateChanged();
    return true;
  }

  setPayloadFromPatch(objectId, value) {
    const payload = value ? clonePatchValue(value) : null;
    if (!payload) {
      this.deletePayloadsForObject(objectId);
      return;
    }

    this.writeNormalizedPayload(objectId, payload);
  }

  syncSphereObject(sphere) {
    this.upsertObject(createSphereObjectRecord(sphere));
  }

  syncFramesForSphere(sphereId) {
    const pairIds = new Set();
    for (const edge of this.connectedEdges(sphereId)) {
      if (pairIds.has(edge.frameId)) {
        continue;
      }
      pairIds.add(edge.frameId);
      this.syncNodePairFrame(edge.sourceId, edge.targetId);
    }
  }

  assertPairGaugePreservesPeers(sourceId, targetId, gauge, positions = new Map(), excluded = new Set()) {
    const frameId = this.nodePairFrameId(sourceId, targetId);
    let oldFrame, nextFrame;
    for (const edge of this.edgesForFrame(frameId)) if (!excluded.has(edge.id)) {
      if (!oldFrame) {
        const [firstPosition, secondPosition] = this.nodePairEndpoints(sourceId, targetId)
          .map((id) => positions.get(id) ?? this.spheres.get(id).position);
        oldFrame = createNodePairFrameGeometry({ firstPosition, secondPosition, existingFrame: this.objects.get(frameId) });
        nextFrame = createNodePairFrameGeometry({ firstPosition, secondPosition, existingFrame: gauge });
      }
      const offset = this.pointFromFrameBend(oldFrame, edge.bend).sub(nextFrame.origin);
      if (Math.abs(offset.dot(nextFrame.tangent)) > 1e-10 * (1 + offset.length())) {
        throw new TypeError("A shared-pair gauge must preserve unlisted arrow geometry");
      }
    }
  }

  restoreNodePairFrameGauge(sourceId, targetId, gauge) {
    const frameId = this.nodePairFrameId(sourceId, targetId);
    const previous = this.objects.get(frameId);
    if (previous && frameGaugesEqual(previous, gauge)) return [];
    const peers = this.edgesForFrame(frameId);
    const midpoints = peers.map((edge) => edge.midpoint.clone());
    const frame = this.syncNodePairFrame(sourceId, targetId, gauge);
    // Changing a shared gauge must not move other arrows sharing the pair.
    peers.forEach((edge, index) => {
      edge.bend.copy(this.bendFromFramePoint(frame, midpoints[index]));
      this.syncEdgeObjects(edge);
    });
    return peers;
  }

  syncNodePairFrame(sourceId, targetId, gauge = null) {
    const [firstId, secondId] = this.nodePairEndpoints(sourceId, targetId);
    const first = this.spheres.get(firstId);
    const second = this.spheres.get(secondId);
    if (!first || !second) {
      return null;
    }

    const frameId = this.nodePairFrameId(sourceId, targetId);
    const cached = this.layoutObjectBatch?.frames.get(frameId);
    if (!gauge && cached) return cached;
    const geometry = createNodePairFrameGeometry({
      firstPosition: first.position,
      secondPosition: second.position,
      existingFrame: gauge ?? this.objects.get(frameId),
    });
    const frame = createNodePairFrameRecord({
      id: frameId,
      nodeIds: [firstId, secondId],
      ...geometry,
    });
    this.upsertObject(frame);
    this.layoutObjectBatch?.frames.set(frameId, frame);
    return frame;
  }

  syncEdgeObjects(edge) {
    const source = this.spheres.get(edge.sourceId);
    const target = this.spheres.get(edge.targetId);
    const frame = this.syncNodePairFrame(edge.sourceId, edge.targetId);
    if (!source || !target || !frame) {
      return;
    }

    edge.frameId = frame.id;
    edge.midpoint.copy(this.pointFromFrameBend(frame, edge.bend));

    const batch = this.layoutObjectBatch;
    if (batch) {
      batch.edges.set(edge.id, edge);
      for (const id of [edge.id, this.edgeBendHandleId(edge.id)]) {
        if (!batch.records.has(id)) batch.records.set(id, null);
      }
      return;
    }
    this.projectEdgeObjects(edge);
  }

  projectEdgeObjects(edge) {
    const source = this.spheres.get(edge.sourceId);
    const target = this.spheres.get(edge.targetId);
    const handleId = this.edgeBendHandleId(edge.id);
    const tangent = target.position.clone().sub(source.position).normalize();
    const controlPoint = this.getQuadraticControlPoint(
      source.position,
      edge.midpoint,
      target.position,
    );

    this.upsertObject(
      createEdgeObjectRecord({
        edge,
        source,
        target,
        controlPoint,
        handleId,
      }),
    );
    this.upsertObject(createEdgeBendHandleRecord({ edge, handleId, tangent }));
  }

  syncSurfaceObjects(surface) {
    if (surface.type === SURFACE_TYPES.VIRTUAL_CELL) {
      return syncVirtualCellElementObjects(this, surface);
    }
    return syncSurfaceElementObjects(this, surface);
  }

  syncTwoSimplexObjects(surface) {
    return syncTwoSimplexElementObjects(this, surface);
  }

  surfaceControlLine(surface, frame = null) {
    if (surface.type === SURFACE_TYPES.VIRTUAL_CELL) {
      return virtualCellControlLineForStore(this, surface);
    }
    return createTwoCellControlLineForStore(this, surface, frame);
  }

  twoSimplexControlLine(surface, resolved = null) {
    return createTwoSimplexControlLineForStore(this, surface, resolved);
  }

  twoSimplexControlNet(surface, resolved = null) {
    return createTwoSimplexControlNetForStore(this, surface, resolved);
  }

  edgeRenderPayload(edge) {
    return createEdgeRenderPayload(edge);
  }

  surfaceRenderPayload(surface) {
    return createSurfaceRenderPayload(surface);
  }

  listPeerGologs() {
    return this.workspace?.listGologsFor(this.gologId) ?? [];
  }

  getGologData(gologId) {
    return (
      this.workspace?.getGologData(gologId, {
        requesterId: this.gologId,
      }) ?? null
    );
  }

  pointFromFrameBend(frame, bend) {
    return calculatePointFromFrameBend(frame, bend);
  }

  bendFromFramePoint(frame, point) {
    return calculateBendFromFramePoint(frame, point);
  }

  nodePairEndpoints(sourceId, targetId) {
    return makeNodePairEndpoints(sourceId, targetId);
  }

  nodePairId(sourceId, targetId) {
    return makeNodePairId(sourceId, targetId);
  }

  nodePairFrameId(sourceId, targetId) {
    return makeNodePairFrameId(sourceId, targetId);
  }

  edgeFrameId(edgeId) {
    return this.edges.get(edgeId)?.frameId ?? null;
  }

  edgeBendHandleId(edgeId) {
    return makeEdgeBendHandleId(edgeId);
  }

  surfaceControlHandleId(surfaceId) {
    return makeSurfaceControlHandleId(surfaceId);
  }

  upsertObject(record) {
    const clonedRecord = cloneStoreValue(record);
    this.objects.set(record.id, clonedRecord);
    if (this.layoutObjectBatch) {
      this.layoutObjectBatch.records.set(record.id, clonedRecord);
      if (record.dimension === 2) this.layoutObjectBatch.surfaceIds.add(record.id);
      return;
    }
    this.events.objectUpserted(clonedRecord);
    if (record.dimension === 2 && this.volumes.size) {
      for (const volume of this.volumesForSurface(record.id)) {
        syncThetaVolumeObject(this, volume);
        this.events.volumeUpdated(this.getObject(volume.id));
      }
    }
  }

  batchLayoutObjectUpdates(update) {
    if (this.layoutObjectBatch) return update();
    // All endpoint positions are installed before frames are read. Publish each
    // derived object once, after its complete boundary has reached the new state.
    const batch = { records: new Map(), surfaceIds: new Set(), frames: new Map(), edges: new Map() };
    this.layoutObjectBatch = batch;
    const volumes = [];
    try { return update(); }
    finally {
      try {
        for (const edge of batch.edges.values()) this.projectEdgeObjects(edge);
        for (const volume of this.volumesForSurfaces(batch.surfaceIds)) {
          syncThetaVolumeObject(this, volume);
          volumes.push(volume.id);
        }
      } finally { this.layoutObjectBatch = null; }
      for (const record of batch.records.values()) this.events.objectUpserted(record);
      for (const id of volumes) this.events.volumeUpdated(this.getObject(id));
    }
  }

  removeObject(id) {
    const record = this.objects.get(id);
    if (!record) {
      return false;
    }
    this.objects.delete(id);
    this.events.objectDeleted(record);
    return true;
  }

  getObject(id) {
    const object = this.objects.get(id);
    return object ? cloneStoreValue(object) : null;
  }

  getQuadraticControlPoint(start, midpoint, end) {
    return calculateQuadraticControlPoint(start, midpoint, end);
  }

  getBiquadraticInteriorControlForSurfacePoint(options) {
    return getBiquadraticInteriorControlForSurfacePoint(options);
  }

  getTriangularCubicInteriorControlForSurfacePoint(options) {
    return getTriangularCubicInteriorControlForSurfacePoint(options);
  }

  elevateQuadraticBezierToCubic(start, control, end) {
    return calculateElevatedQuadraticBezier(start, control, end);
  }

  makePlaneBasisFromNormal(normal) {
    return calculatePlaneBasisFromNormal(normal);
  }

  transportPlaneBasis(frame, newTangent) {
    return calculateTransportedPlaneBasis(frame, newTangent);
  }

  emitStateChanged() {
    if (this.stateChangeDeferrals) {
      this.stateChangePending = true;
      return;
    }
    this.events.stateChanged(this.snapshot());
  }

  deferStateChanges() {
    this.stateChangeDeferrals = (this.stateChangeDeferrals ?? 0) + 1;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.stateChangeDeferrals--;
      if (!this.stateChangeDeferrals && this.stateChangePending) {
        this.stateChangePending = false;
        this.emitStateChanged();
      }
    };
  }

  snapshotObjects() {
    return [...this.objects.values()].map((object) => cloneStoreValue(object));
  }

  snapshotLocks() {
    return this.lockManager.snapshotLocks();
  }

  snapshotResourceClaims() {
    return this.resourceClaims.snapshot();
  }

  snapshotCoordinationEvents() {
    return this.coordinationEvents.snapshot();
  }

  snapshot() {
    return {
      gologId: this.gologId,
      title: this.title,
      selectedSimplexId: this.selectedSimplexId,
      selectedSphereId: this.selectedSphereId,
      sphereCount: this.spheres.size,
      edgeCount: this.edges.size,
      surfaceCount: this.surfaces.size,
      volumeCount: this.volumes.size,
      objectCount: this.objects.size,
      lockCount: this.locks.size,
      resourceClaimCount: this.resourceClaims.claims.size,
      coordinationEventCount: this.coordinationEvents.events.length,
      payloads: [...this.payloads.entries()].map(([objectId, payload]) => ({
        objectId,
        ...cloneStoreValue(payload),
      })),
      payloadAttachments: [...this.objects.keys()].flatMap((objectId) =>
        this.getPayloads(objectId).map((payload) => ({
          objectId,
          ...payload,
        })),
      ),
      spheres: [...this.spheres.values()].map((sphere) => ({
        id: sphere.id,
        name: sphere.name,
        childGologId: sphere.childGologId ?? null,
        position: sphere.position.clone(),
      })),
      edges: [...this.edges.values()].map((edge) => ({
        ...edge,
        bend: edge.bend.clone(),
        midpoint: edge.midpoint.clone(),
      })),
      surfaces: [...this.surfaces.values()].map((surface) => ({
        ...surface,
        edgeIds: [...surface.edgeIds],
        nodeIds: surface.nodeIds ? [...surface.nodeIds] : undefined,
        controlPoint: surface.controlPoint.clone(),
        controlDirection: surface.controlDirection.clone(),
      })),
      volumes: [...this.volumes.values()].map((volume) => cloneStoreValue(volume)),
      objects: this.snapshotObjects(),
      locks: this.snapshotLocks(),
      resourceClaims: this.snapshotResourceClaims(),
      coordinationEvents: this.snapshotCoordinationEvents(),
    };
  }
}

export class RenderState extends SharedDomainStore {}
