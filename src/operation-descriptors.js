import {
  gologResourceId,
  normalizeResourceId,
  operationResourceId,
  payloadResourceId,
  simplexResourceId,
} from "./resource-ids.js";
import {
  createElementRegistry,
  ELEMENT_KINDS,
} from "./element-registry.js";
import { assertShapeExpansionDeletionAllowed, assertShapeExpansionBoundaryEditAllowed } from "./shape-expansion.js";

const OPERATION_ELEMENT_REGISTRY = createElementRegistry();

export const CONVERGENCE_KINDS = Object.freeze({
  DISCRETE: "discrete",
  SMOOTH: "smooth",
  HYBRID: "hybrid",
});

const DISCRETE_CONVERGENCE = Object.freeze({
  kind: CONVERGENCE_KINDS.DISCRETE,
  localMode: "optimistic",
  globalMode: "apply",
});

const SMOOTH_POSITION_CONVERGENCE = Object.freeze({
  kind: CONVERGENCE_KINDS.SMOOTH,
  localMode: "optimistic",
  globalMode: "attract",
  coordinate: "position",
});

const SMOOTH_LAYOUT_CONVERGENCE = Object.freeze({
  kind: CONVERGENCE_KINDS.SMOOTH,
  localMode: "optimistic",
  globalMode: "attract",
  coordinate: "layout-positions",
});

const SMOOTH_GEOMETRY_CONVERGENCE = Object.freeze({
  kind: CONVERGENCE_KINDS.SMOOTH,
  localMode: "optimistic",
  globalMode: "attract",
  coordinate: "geometry-control",
});

function normalizeIds(ids = []) {
  const entries = Array.isArray(ids) ? ids : [ids];
  return [
    ...new Set(
      entries
        .filter(Boolean)
        .map((resourceId) => normalizeResourceId(resourceId)),
    ),
  ];
}

function claimGroup(...resourceIds) {
  return normalizeIds(resourceIds);
}

function simplexClaim(gologId, objectId) {
  return objectId ? simplexResourceId(gologId, objectId) : null;
}

function payloadClaim(gologId, objectId, payloadType = null) {
  return objectId ? payloadResourceId(gologId, objectId, payloadType) : null;
}

function creationClaim({ gologId, payload }) {
  return claimGroup(simplexClaim(gologId, payload.id), gologResourceId(gologId));
}

function simplexClaimGroup({ gologId, payload }) {
  return [claimGroup(simplexClaim(gologId, payload.id))];
}

function simplexPrimaryResource({ gologId, type, payload }) {
  return payload.id
    ? simplexResourceId(gologId, payload.id)
    : operationResourceId(gologId, type);
}

function elementDefinitionForCreate({ descriptor, payload }) {
  return OPERATION_ELEMENT_REGISTRY.definitionFor(
    payload.elementKind ?? descriptor.elementKind,
  );
}

function elementCreateResourceKey(context) {
  const definition = elementDefinitionForCreate(context);
  return definition.resourceKey?.(context.payload) ?? context.payload.elementKind;
}

function elementCreatePrimaryResource(context) {
  const { gologId, type, payload } = context;
  return payload.id
    ? simplexResourceId(gologId, payload.id)
    : operationResourceId(gologId, type, elementCreateResourceKey(context));
}

function prepareElementCreatePayload(elementKind = null) {
  return (store, payload) =>
    OPERATION_ELEMENT_REGISTRY.prepareCreatePayload(store, {
      ...payload,
      elementKind: payload.elementKind ?? elementKind,
    });
}

function payloadPrimaryResource(payloadType = null) {
  return ({ gologId, type, payload }) =>
    payload.id
      ? payloadResourceId(gologId, payload.id, payloadType)
      : operationResourceId(gologId, type);
}

function typedPayloadFromOperationPayload(payload = {}) {
  return payload.payload ?? payload;
}

function typedPayloadType(payload = {}) {
  return typedPayloadFromOperationPayload(payload)?.type ?? null;
}

function typedPayloadPrimaryResource({ gologId, type, payload }) {
  return payload.id
    ? payloadResourceId(gologId, payload.id, typedPayloadType(payload))
    : operationResourceId(gologId, type);
}

function layoutPrimaryResource({ gologId, type, payload }) {
  return operationResourceId(gologId, type, payload.layoutId ?? "force-layout");
}

function defaultWriteResources(context) {
  return [context.primaryId ?? context.descriptor.primaryResourceId(context)];
}

function gologScopedWriteResources(context) {
  return [...defaultWriteResources(context), gologResourceId(context.gologId)];
}

function edgeDeleteWriteResources(context) {
  return [
    ...gologScopedWriteResources(context),
    ...(context.payload.surfaceIds ?? []).map((surfaceId) =>
      simplexResourceId(context.gologId, surfaceId),
    ),
    ...(context.payload.volumeIds ?? []).map((id) => simplexResourceId(context.gologId, id)),
  ];
}

function sphereDeleteWriteResources(context) {
  return [
    ...gologScopedWriteResources(context),
    ...(context.payload.edgeIds ?? []).map((edgeId) =>
      simplexResourceId(context.gologId, edgeId),
    ),
    ...(context.payload.surfaceIds ?? []).map((surfaceId) =>
      simplexResourceId(context.gologId, surfaceId),
    ),
    ...(context.payload.volumeIds ?? []).map((id) => simplexResourceId(context.gologId, id)),
  ];
}

function layoutWriteResources(context) {
  return [
    ...gologScopedWriteResources(context),
    ...(context.payload.positions ?? [])
      .map((entry) =>
        entry?.id ? simplexResourceId(context.gologId, entry.id) : null,
      )
      .filter(Boolean),
    ...(context.payload.edgeControls ?? [])
      .map((entry) =>
        entry?.id ? simplexResourceId(context.gologId, entry.id) : null,
      )
      .filter(Boolean),
  ];
}

function edgeDeleteClaimGroups({ gologId, payload }) {
  return [
    claimGroup(simplexClaim(gologId, payload.id)),
    ...(payload.surfaceIds ?? []).map((surfaceId) =>
      claimGroup(simplexClaim(gologId, surfaceId)),
    ),
    ...(payload.volumeIds ?? []).map((id) => claimGroup(simplexClaim(gologId, id))),
  ];
}

function sphereDeleteClaimGroups({ gologId, payload }) {
  return [
    claimGroup(simplexClaim(gologId, payload.id)),
    ...(payload.edgeIds ?? []).map((edgeId) =>
      claimGroup(simplexClaim(gologId, edgeId)),
    ),
    ...(payload.surfaceIds ?? []).map((surfaceId) =>
      claimGroup(simplexClaim(gologId, surfaceId)),
    ),
    ...(payload.volumeIds ?? []).map((id) => claimGroup(simplexClaim(gologId, id))),
  ];
}

function prepareSphereDeletePayload(store, payload) {
  payload = prepareVolumeSupportPayload(store, payload);
  if (payload.id && (!Array.isArray(payload.edgeIds) || !Array.isArray(payload.surfaceIds))) {
    const edgeIds = store.connectedEdges?.(payload.id).map((edge) => edge.id) ?? [];
    return {
      ...payload,
      edgeIds,
      surfaceIds: [
        ...new Set(
          edgeIds.flatMap((edgeId) =>
            store.surfacesForEdge?.(edgeId).map((surface) => surface.id) ?? [],
          ),
        ),
      ],
    };
  }
  return payload;
}

function textPayloadClaimGroups({ gologId, payload }) {
  return [
    claimGroup(payloadClaim(gologId, payload.id), simplexClaim(gologId, payload.id)),
  ];
}

function typedPayloadClaimGroups({ gologId, payload }) {
  return [
    claimGroup(
      payloadClaim(gologId, payload.id, typedPayloadType(payload)),
      simplexClaim(gologId, payload.id),
    ),
  ];
}

function nestedGologPayloadClaimGroups({ gologId, payload }) {
  return [
    claimGroup(
      payloadClaim(gologId, payload.id, "nested-golog"),
      simplexClaim(gologId, payload.id),
    ),
  ];
}

function layoutClaimGroups({ gologId, payload }) {
  return [
    ...(payload.positions ?? []),
    ...(payload.edgeControls ?? []),
  ].map((entry) => claimGroup(simplexClaim(gologId, entry?.id)));
}

function prepareEdgeDeletePayload(store, payload) {
  payload = prepareVolumeSupportPayload(store, payload);
  if (payload.id && !Array.isArray(payload.surfaceIds)) {
    return {
      ...payload,
      surfaceIds:
        store.surfacesForEdge?.(payload.id).map((surface) => surface.id) ?? [],
    };
  }
  return payload;
}

function prepareVolumeSupportPayload(store, payload) {
  if (!payload.id || !store.hasSelectableSimplex(payload.id)) return payload;
  assertShapeExpansionDeletionAllowed(store, payload.id);
  const volumeIds = store.getPresheaf().support([payload.id])
    .map(({ id }) => id).filter((id) => id !== payload.id && store.volumes?.has(id));
  return { ...payload, volumeIds };
}

function guardCommittedVolumeSupport(apply) {
  return (store, payload, operation) => {
    // A pending commit may outlive its support snapshot. Newly attached cofaces
    // require a new operation; never enlarge the accepted write set at apply.
    const declared = new Set(normalizeIds(operation.resourceIds ?? [operation.resourceId]));
    const volumes = store.dependentVolumeIds(payload.id);
    if (volumes.some((id) => !declared.has(simplexResourceId(operation.gologId, id)))) return false;
    return apply(store, payload);
  };
}

const OPERATION_DESCRIPTOR_DEFINITIONS = {
  "element:create": {
    convergence: DISCRETE_CONVERGENCE,
    primaryResourceId: elementCreatePrimaryResource,
    preparePayload: prepareElementCreatePayload(),
    writeResources: gologScopedWriteResources,
    requiredClaimGroups: (context) => [creationClaim(context)],
    apply: (store, payload) => store.createElement(payload),
  },
  "sphere:create": {
    convergence: DISCRETE_CONVERGENCE,
    elementKind: ELEMENT_KINDS.ZERO_SIMPLEX,
    primaryResourceId: elementCreatePrimaryResource,
    preparePayload: prepareElementCreatePayload(ELEMENT_KINDS.ZERO_SIMPLEX),
    writeResources: gologScopedWriteResources,
    requiredClaimGroups: (context) => [creationClaim(context)],
    apply: (store, payload) => store.createElement(payload),
  },
  "sphere:move": {
    convergence: SMOOTH_POSITION_CONVERGENCE,
    primaryResourceId: simplexPrimaryResource,
    requiredClaimGroups: simplexClaimGroup,
    apply: (store, payload) => store.moveSphere(payload.id, payload.position, payload),
  },
  "simplex:rename": {
    convergence: DISCRETE_CONVERGENCE,
    primaryResourceId: simplexPrimaryResource,
    requiredClaimGroups: simplexClaimGroup,
    apply: (store, payload) => store.renameSimplex(payload.id, payload.name),
  },
  "payload:text-add": {
    convergence: DISCRETE_CONVERGENCE,
    primaryResourceId: payloadPrimaryResource(),
    requiredClaimGroups: textPayloadClaimGroups,
    apply: (store, payload) => store.attachTextPayload(payload.id, payload.text),
  },
  "payload:text-update": {
    convergence: DISCRETE_CONVERGENCE,
    primaryResourceId: payloadPrimaryResource(),
    requiredClaimGroups: textPayloadClaimGroups,
    apply: (store, payload) => store.updateTextPayload(payload.id, payload.text),
  },
  "payload:typed-add": {
    convergence: DISCRETE_CONVERGENCE,
    primaryResourceId: typedPayloadPrimaryResource,
    preparePayload: (store, payload) => ({ ...payload,
      payload: store.normalizePayloadForObject(payload.id, typedPayloadFromOperationPayload(payload)) }),
    requiredClaimGroups: typedPayloadClaimGroups,
    apply: (store, payload) =>
      store.attachTypedPayload(payload.id, typedPayloadFromOperationPayload(payload)),
  },
  "payload:typed-update": {
    convergence: DISCRETE_CONVERGENCE,
    primaryResourceId: typedPayloadPrimaryResource,
    requiredClaimGroups: typedPayloadClaimGroups,
    apply: (store, payload) =>
      store.updateTypedPayload(payload.id, typedPayloadFromOperationPayload(payload)),
  },
  "payload:delete": {
    convergence: DISCRETE_CONVERGENCE,
    primaryResourceId: ({ gologId, type, payload }) =>
      payload.id
        ? payloadResourceId(gologId, payload.id, payload.key)
        : operationResourceId(gologId, type),
    requiredClaimGroups: ({ gologId, payload }) => [
      claimGroup(
        payloadClaim(gologId, payload.id, payload.key),
        simplexClaim(gologId, payload.id),
      ),
    ],
    apply: (store, payload) =>
      store.detachPayloadAttachment(payload.id, payload.key, payload),
  },
  "payload:golog-attach": {
    convergence: DISCRETE_CONVERGENCE,
    primaryResourceId: payloadPrimaryResource("nested-golog"),
    preparePayload: (store, payload) => ({ ...payload, ...store.normalizePayloadForObject(payload.id,
      { type: "nested-golog", targetGologId: payload.targetGologId, rootObjectId: payload.rootObjectId }) }),
    requiredClaimGroups: nestedGologPayloadClaimGroups,
    apply: (store, payload) =>
      store.attachChildGolog(payload.id, payload.targetGologId, payload.rootObjectId),
  },
  "edge:create": {
    convergence: DISCRETE_CONVERGENCE,
    elementKind: ELEMENT_KINDS.ONE_SIMPLEX,
    primaryResourceId: elementCreatePrimaryResource,
    preparePayload: prepareElementCreatePayload(ELEMENT_KINDS.ONE_SIMPLEX),
    writeResources: gologScopedWriteResources,
    requiredClaimGroups: (context) => [creationClaim(context)],
    apply: (store, payload) => store.createElement(payload),
  },
  "edge:delete": {
    convergence: DISCRETE_CONVERGENCE,
    primaryResourceId: simplexPrimaryResource,
    preparePayload: prepareEdgeDeletePayload,
    writeResources: edgeDeleteWriteResources,
    requiredClaimGroups: edgeDeleteClaimGroups,
    apply: guardCommittedVolumeSupport((store, payload) => store.deleteEdge(payload.id, payload)),
  },
  "edge:rebase": {
    convergence: DISCRETE_CONVERGENCE,
    primaryResourceId: simplexPrimaryResource,
    preparePayload: (store, payload) => {
      const edge = store.edges.get(payload.id);
      if (edge && (edge.sourceId !== payload.sourceId || edge.targetId !== payload.targetId)) {
        assertShapeExpansionBoundaryEditAllowed(store, payload.id);
      }
      return prepareEdgeDeletePayload(store, payload);
    },
    writeResources: edgeDeleteWriteResources,
    requiredClaimGroups: edgeDeleteClaimGroups,
    apply: guardCommittedVolumeSupport((store, payload) =>
      store.rebaseEdge(
        payload.id,
        payload.sourceId,
        payload.targetId,
        payload,
      )),
  },
  "edge:move-midpoint": {
    convergence: SMOOTH_GEOMETRY_CONVERGENCE,
    primaryResourceId: simplexPrimaryResource,
    requiredClaimGroups: simplexClaimGroup,
    apply: (store, payload) =>
      store.moveEdgeMidpoint(payload.id, payload.midpoint, payload),
  },
  "sphere:delete": {
    convergence: DISCRETE_CONVERGENCE,
    primaryResourceId: simplexPrimaryResource,
    preparePayload: prepareSphereDeletePayload,
    writeResources: sphereDeleteWriteResources,
    requiredClaimGroups: sphereDeleteClaimGroups,
    apply: guardCommittedVolumeSupport((store, payload) => store.deleteSphere(payload.id, payload)),
  },
  "surface:delete": {
    convergence: DISCRETE_CONVERGENCE,
    primaryResourceId: simplexPrimaryResource,
    preparePayload: prepareVolumeSupportPayload,
    writeResources: edgeDeleteWriteResources,
    requiredClaimGroups: edgeDeleteClaimGroups,
    apply: guardCommittedVolumeSupport((store, payload) => store.deleteSurface(payload.id, payload)),
  },
  "volume:delete": {
    convergence: DISCRETE_CONVERGENCE,
    primaryResourceId: simplexPrimaryResource,
    preparePayload: prepareVolumeSupportPayload,
    writeResources: edgeDeleteWriteResources,
    requiredClaimGroups: edgeDeleteClaimGroups,
    apply: guardCommittedVolumeSupport((store, payload) => store.deleteVolume(payload.id, payload)),
  },
  "surface:create": {
    convergence: DISCRETE_CONVERGENCE,
    elementKind: ELEMENT_KINDS.TWO_CELL,
    primaryResourceId: elementCreatePrimaryResource,
    preparePayload: prepareElementCreatePayload(ELEMENT_KINDS.TWO_CELL),
    writeResources: gologScopedWriteResources,
    requiredClaimGroups: (context) => [creationClaim(context)],
    apply: (store, payload) => store.createElement(payload),
  },
  "two-simplex:create": {
    convergence: DISCRETE_CONVERGENCE,
    elementKind: ELEMENT_KINDS.TWO_SIMPLEX,
    primaryResourceId: elementCreatePrimaryResource,
    preparePayload: prepareElementCreatePayload(ELEMENT_KINDS.TWO_SIMPLEX),
    writeResources: gologScopedWriteResources,
    requiredClaimGroups: (context) => [creationClaim(context)],
    apply: (store, payload) => store.createElement(payload),
  },
  "surface:move-control": {
    convergence: SMOOTH_GEOMETRY_CONVERGENCE,
    primaryResourceId: simplexPrimaryResource,
    requiredClaimGroups: simplexClaimGroup,
    apply: (store, payload) =>
      store.moveSurfaceControl(payload.id, payload.controlCoordinate, payload),
  },
  "layout:commit": {
    convergence: SMOOTH_LAYOUT_CONVERGENCE,
    primaryResourceId: layoutPrimaryResource,
    writeResources: layoutWriteResources,
    requiredClaimGroups: layoutClaimGroups,
    apply: (store, payload, operation) =>
      store.commitLayoutPositions(payload.positions, {
        ...payload,
        origin: operation.origin,
      }),
  },
};

export const OPERATION_DESCRIPTORS = Object.freeze(
  Object.fromEntries(
    Object.entries(OPERATION_DESCRIPTOR_DEFINITIONS).map(([type, descriptor]) => [
      type,
      Object.freeze({ type, ...descriptor }),
    ]),
  ),
);

export const DOMAIN_OPERATION_TYPES = new Set(Object.keys(OPERATION_DESCRIPTORS));

export function getDomainOperationDescriptor(type) {
  return OPERATION_DESCRIPTORS[type] ?? null;
}

export function convergencePolicyForOperation(type) {
  return getDomainOperationDescriptor(type)?.convergence ?? DISCRETE_CONVERGENCE;
}

export function hasDomainOperationType(type) {
  return DOMAIN_OPERATION_TYPES.has(type);
}

export function operationDescriptorForType(type) {
  const descriptor = getDomainOperationDescriptor(type);
  if (!descriptor) {
    throw new Error(`Unsupported domain operation type: ${type}`);
  }
  return descriptor;
}

export function prepareOperationPayload(store, type, payload = {}) {
  const descriptor = operationDescriptorForType(type);
  let prepared = { ...payload };
  if (descriptor.preparePayload) {
    prepared = descriptor.preparePayload(store, prepared);
  }
  return prepared;
}

export function primaryResourceIdForOperation(gologId, type, payload = {}) {
  const descriptor = operationDescriptorForType(type);
  return descriptor.primaryResourceId({ gologId, type, payload, descriptor });
}

export function writeResourceIdsForOperation(
  gologId,
  type,
  payload = {},
  primaryId = null,
) {
  const descriptor = operationDescriptorForType(type);
  const context = { gologId, type, payload, primaryId, descriptor };
  return normalizeIds(
    descriptor.writeResources
      ? descriptor.writeResources(context)
      : defaultWriteResources(context),
  );
}

export function requiredClaimGroupsForOperation(
  gologId,
  type,
  payload = {},
  writeResources = [],
) {
  const descriptor = getDomainOperationDescriptor(type);
  if (!descriptor) {
    return normalizeIds(writeResources).map((resourceId) => [resourceId]);
  }
  const context = { gologId, type, payload, descriptor };
  return (descriptor.requiredClaimGroups?.(context) ?? [])
    .map((group) => normalizeIds(group))
    .filter((group) => group.length > 0);
}

export function applyOperationToStore(store, operation) {
  const descriptor = operationDescriptorForType(operation.type);
  return descriptor.apply(store, operation.payload ?? {}, operation);
}
