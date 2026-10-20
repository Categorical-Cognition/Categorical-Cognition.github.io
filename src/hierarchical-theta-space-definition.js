import { normalizeControlDirection, normalizeFrameGauge, serializeFrameGauge } from "./frame-service.js";
import {
  createSurfaceControlHandleRecord,
  createSurfaceObjectRecord,
  createTwoSimplexObjectRecord,
  SURFACE_TYPES,
} from "./domain-object-definitions.js";
import {
  createTwoCellControlLine,
  createTwoSimplexControlLine,
  createTwoSimplexControlNet,
} from "./surface-geometry-service.js";
import {
  DEFAULT_MATH_SCHEMA_REGISTRY,
  CORE_THETA_SCHEMA_ID,
  CORE_THETA_STRUCTURE_ID,
  schemaRefForElementKind,
} from "./mathematical-schema-registry.js";
import * as THREE from "three";
import { THETA_VOLUME_KIND, createThetaVolumeElement, serializeThetaVolume,
  thetaVolumeSchemaRef } from "./theta-volume-definition.js";

export const HIERARCHICAL_THETA_SPACE_STRUCTURE_ID =
  CORE_THETA_STRUCTURE_ID;
export const HIERARCHICAL_THETA_SPACE_SCHEMA = CORE_THETA_SCHEMA_ID;

export const ELEMENT_KINDS = Object.freeze({
  ZERO_SIMPLEX: "0-simplex",
  ONE_SIMPLEX: "1-simplex",
  TWO_CELL: "2-cell",
  TWO_SIMPLEX: "2-simplex",
  THETA_VOLUME: THETA_VOLUME_KIND,
});

function arrayFromVector(value) {
  return value?.toArray?.() ?? value;
}

export function normalizeHierarchicalThetaElementKind(kind) {
  const resolved = DEFAULT_MATH_SCHEMA_REGISTRY.normalizeElementKind(kind);
  return Object.values(ELEMENT_KINDS).includes(resolved) ? resolved : null;
}

export function defaultElementDefinitions() {
  return [
    {
      elementKind: THETA_VOLUME_KIND,
      createId: { prefix: "volume-", counter: "nextVolumeId" },
      selectableKind: "volume",
      create: createThetaVolumeElement,
    },
    {
      elementKind: ELEMENT_KINDS.ZERO_SIMPLEX,
      createId: { prefix: "sphere-", counter: "nextSphereId" },
      selectableKind: "sphere",
      create(store, payload) {
        return store.createSphere(
          payload.position ?? store.findCompactNodePosition?.() ?? new THREE.Vector3(),
          payload,
        );
      },
    },
    {
      elementKind: ELEMENT_KINDS.ONE_SIMPLEX,
      createId: { prefix: "edge-", counter: "nextEdgeId" },
      selectableKind: "edge",
      resourceKey: (payload) => `${payload.sourceId}->${payload.targetId}`,
      create(store, payload) {
        return store.createEdge(payload.sourceId, payload.targetId, payload);
      },
    },
    {
      elementKind: ELEMENT_KINDS.TWO_CELL,
      createId: { prefix: "surface-", counter: "nextSurfaceId" },
      selectableKind: "surface",
      resourceKey: (payload) => `${payload.firstEdgeId}+${payload.secondEdgeId}`,
      create(store, payload) {
        return createTwoCellElement(
          store,
          payload.firstEdgeId,
          payload.secondEdgeId,
          payload,
        );
      },
    },
    {
      elementKind: ELEMENT_KINDS.TWO_SIMPLEX,
      createId: { prefix: "two-simplex-", counter: "nextSurfaceId" },
      selectableKind: "surface",
      resourceKey: (payload) => (payload.edgeIds ?? []).join("+"),
      create(store, payload) {
        return createTwoSimplexElement(store, payload.edgeIds, payload);
      },
    },
  ];
}

export function canCreateTwoCellElement(firstEdge, secondEdge) {
  return Boolean(
    firstEdge &&
      secondEdge &&
      firstEdge.id !== secondEdge.id &&
      firstEdge.sourceId === secondEdge.sourceId &&
      firstEdge.targetId === secondEdge.targetId,
  );
}

export function createTwoCellControlLineForStore(store, surface, frame = null) {
  const firstEdge = store.edges.get(surface.edgeIds[0]);
  const secondEdge = store.edges.get(surface.edgeIds[1]);
  const activeFrame =
    frame ?? store.syncNodePairFrame(firstEdge.sourceId, firstEdge.targetId);
  return createTwoCellControlLine({
    firstEdge,
    secondEdge,
    frame: activeFrame,
    previousDirection: surface.controlDirection,
  });
}

export function createTwoSimplexControlLineForStore(
  store,
  surface,
  resolved = null,
) {
  const active = resolved ?? store.resolveComposableEdgeTriple(surface.edgeIds);
  if (!active) {
    return null;
  }

  return createTwoSimplexControlLine({
    source: active.source,
    middle: active.middle,
    target: active.target,
    previousDirection: surface.controlDirection,
  });
}

export function createTwoSimplexControlNetForStore(
  store,
  surface,
  resolved = null,
) {
  const active = resolved ?? store.resolveComposableEdgeTriple(surface.edgeIds);
  if (!active) {
    return null;
  }

  return createTwoSimplexControlNet({
    surfacePoint: surface.controlPoint,
    source: active.source,
    middle: active.middle,
    target: active.target,
    firstEdge: active.firstEdge,
    secondEdge: active.secondEdge,
    compositeEdge: active.compositeEdge,
  });
}

export function createTwoCellElement(
  store,
  firstEdgeId,
  secondEdgeId,
  {
    id: requestedId = null,
    name = "",
    controlCoordinate = null,
    controlDirection = null,
    schemaRef = null,
    render = null,
  } = {},
) {
  if (firstEdgeId === secondEdgeId) {
    return null;
  }

  const firstEdge = store.edges.get(firstEdgeId);
  const secondEdge = store.edges.get(secondEdgeId);
  if (!canCreateTwoCellElement(firstEdge, secondEdge)) {
    return null;
  }

  const id = requestedId ?? `surface-${store.nextSurfaceId++}`;
  store.reserveNumericId(id, "surface-", "nextSurfaceId");
  if (store.surfaces.has(id)) {
    return id;
  }
  const frame = store.syncNodePairFrame(firstEdge.sourceId, firstEdge.targetId);
  const surface = {
    id,
    name: String(name ?? ""),
    type: SURFACE_TYPES.TWO_CELL,
    elementKind: ELEMENT_KINDS.TWO_CELL,
    schemaRef: schemaRef ?? schemaRefForElementKind(ELEMENT_KINDS.TWO_CELL),
    edgeIds: [firstEdgeId, secondEdgeId],
    frameId: frame.id,
    controlCoordinate: controlCoordinate ?? 0,
    controlPoint: frame.origin.clone(),
    controlDirection: normalizeControlDirection(controlDirection) ?? frame.u.clone(),
    ...(render ? { render: { ...render } } : {}),
  };

  const initialLine = createTwoCellControlLineForStore(store, surface);
  if (controlCoordinate === null) {
    surface.controlCoordinate = initialLine.defaultCoordinate;
  }
  surface.controlDirection.copy(initialLine.direction);
  surface.controlPoint.copy(
    initialLine.origin
      .clone()
      .addScaledVector(initialLine.direction, surface.controlCoordinate),
  );

  store.surfaces.set(id, surface);
  store.syncSurfaceObjects(surface);
  store.selectedSphereId = null;
  store.selectedSimplexId = id;
  store.emitStateChanged();
  store.events.sphereSelected(null);
  store.events.edgeSelected(null);
  store.events.surfaceCreated(store.surfaceRenderPayload(surface));
  store.events.surfaceSelected(id);
  store.events.volumeSelected(null);
  return id;
}

export function createTwoSimplexElement(
  store,
  edgeIds,
  {
    id: requestedId = null,
    name = "",
    controlCoordinate = null,
    controlDirection = null,
    schemaRef = null,
    render = null,
  } = {},
) {
  const resolved = store.resolveComposableEdgeTriple(edgeIds);
  if (!resolved) {
    return null;
  }

  const id = requestedId ?? `two-simplex-${store.nextSurfaceId++}`;
  store.reserveNumericId(id, "two-simplex-", "nextSurfaceId");
  if (store.surfaces.has(id)) {
    return id;
  }
  const surface = {
    id,
    name: String(name ?? ""),
    type: SURFACE_TYPES.TWO_SIMPLEX,
    elementKind: ELEMENT_KINDS.TWO_SIMPLEX,
    schemaRef: schemaRef ?? schemaRefForElementKind(ELEMENT_KINDS.TWO_SIMPLEX),
    edgeIds: [
      resolved.firstEdge.id,
      resolved.secondEdge.id,
      resolved.compositeEdge.id,
    ],
    nodeIds: [resolved.source.id, resolved.middle.id, resolved.target.id],
    controlCoordinate: controlCoordinate ?? 0,
    controlPoint: resolved.source.position.clone().set(0, 0, 0),
    controlDirection: normalizeControlDirection(controlDirection) ?? resolved.source.position.clone().set(0, 0, 1),
    ...(render ? { render: { ...render } } : {}),
  };

  const initialLine = createTwoSimplexControlLineForStore(store, surface, resolved);
  if (controlCoordinate === null) {
    surface.controlCoordinate = initialLine.defaultCoordinate;
  }
  surface.controlDirection.copy(initialLine.direction);
  surface.controlPoint.copy(
    initialLine.origin
      .clone()
      .addScaledVector(initialLine.direction, surface.controlCoordinate),
  );

  store.surfaces.set(id, surface);
  store.syncSurfaceObjects(surface);
  store.selectedSphereId = null;
  store.selectedSimplexId = id;
  store.emitStateChanged();
  store.events.sphereSelected(null);
  store.events.edgeSelected(null);
  store.events.surfaceCreated(store.surfaceRenderPayload(surface));
  store.events.surfaceSelected(id);
  store.events.volumeSelected(null);
  return id;
}

export function syncSurfaceElementObjects(store, surface) {
  if (surface.type === SURFACE_TYPES.TWO_SIMPLEX) {
    syncTwoSimplexElementObjects(store, surface);
    return;
  }

  const firstEdge = store.edges.get(surface.edgeIds[0]);
  const secondEdge = store.edges.get(surface.edgeIds[1]);
  if (!canCreateTwoCellElement(firstEdge, secondEdge)) {
    return;
  }

  const source = store.spheres.get(firstEdge.sourceId);
  const target = store.spheres.get(firstEdge.targetId);
  const frame = store.syncNodePairFrame(firstEdge.sourceId, firstEdge.targetId);
  if (!source || !target || !frame) {
    return;
  }

  surface.frameId = frame.id;
  const line = createTwoCellControlLineForStore(store, surface, frame);
  surface.controlDirection.copy(line.direction);
  surface.controlPoint.copy(
    line.origin.clone().addScaledVector(line.direction, surface.controlCoordinate),
  );

  const handleId = store.surfaceControlHandleId(surface.id);
  const firstControlPoint = store.getQuadraticControlPoint(
    source.position,
    firstEdge.midpoint,
    target.position,
  );
  const secondControlPoint = store.getQuadraticControlPoint(
    source.position,
    secondEdge.midpoint,
    target.position,
  );

  store.upsertObject(
    createSurfaceObjectRecord({
      surface,
      source,
      target,
      firstEdge,
      secondEdge,
      firstControlPoint,
      secondControlPoint,
      controlPoint: surface.controlPoint,
      controlDirection: surface.controlDirection,
      handleId,
    }),
  );
  store.upsertObject(
    createSurfaceControlHandleRecord({
      surface,
      handleId,
      controlPoint: surface.controlPoint,
      controlDirection: surface.controlDirection,
    }),
  );
}

export function syncTwoSimplexElementObjects(store, surface) {
  const resolved = store.resolveComposableEdgeTriple(surface.edgeIds);
  if (!resolved) {
    return;
  }

  surface.edgeIds = [
    resolved.firstEdge.id,
    resolved.secondEdge.id,
    resolved.compositeEdge.id,
  ];
  surface.nodeIds = [
    resolved.source.id,
    resolved.middle.id,
    resolved.target.id,
  ];

  const line = createTwoSimplexControlLineForStore(store, surface, resolved);
  surface.controlDirection.copy(line.direction);
  surface.controlPoint.copy(
    line.origin.clone().addScaledVector(line.direction, surface.controlCoordinate),
  );

  const triangleControlNet = createTwoSimplexControlNetForStore(
    store,
    surface,
    resolved,
  );
  const handleId = store.surfaceControlHandleId(surface.id);
  store.upsertObject(
    createTwoSimplexObjectRecord({
      surface,
      source: resolved.source,
      middle: resolved.middle,
      target: resolved.target,
      firstEdge: resolved.firstEdge,
      secondEdge: resolved.secondEdge,
      compositeEdge: resolved.compositeEdge,
      triangleControlNet,
      controlPoint: surface.controlPoint,
      controlDirection: surface.controlDirection,
      handleId,
    }),
  );
  store.upsertObject(
    createSurfaceControlHandleRecord({
      surface,
      handleId,
      controlPoint: surface.controlPoint,
      controlDirection: surface.controlDirection,
    }),
  );
}

export function serializeHierarchicalThetaElements(state) {
  return [...hierarchicalThetaElementsFromCells({
    zero: [...state.spheres.values()].map((cell) => ({
      ...cell, position: arrayFromVector(cell.position),
    })),
    one: [...state.edges.values()].map((cell) => ({
      ...cell, bend: arrayFromVector(cell.bend), frame: serializeFrameGauge(state.objects.get(cell.frameId)),
    })),
    two: [...state.surfaces.values()],
  }), ...[...(state.volumes?.values() ?? [])].map(serializeThetaVolume)];
}

export function hierarchicalThetaElementsFromCells(cells) {
  return [
    ...(cells?.zero ?? []).map((cell) => ({
      id: cell.id,
      elementKind: ELEMENT_KINDS.ZERO_SIMPLEX,
      schemaRef: schemaRefForElementKind(ELEMENT_KINDS.ZERO_SIMPLEX),
      dimension: 0,
      name: cell.name,
      position: cell.position,
    })),
    ...(cells?.one ?? []).map((cell) => ({
      id: cell.id,
      elementKind: ELEMENT_KINDS.ONE_SIMPLEX,
      schemaRef: schemaRefForElementKind(ELEMENT_KINDS.ONE_SIMPLEX),
      dimension: 1,
      name: cell.name,
      boundary: {
        sourceId: cell.sourceId,
        targetId: cell.targetId,
      },
      controlData: {
        bend: cell.bend,
        ...(cell.frame ? { frame: cell.frame } : {}),
      },
    })),
    ...(cells?.two ?? []).map((cell) => ({
      id: cell.id,
      elementKind:
        cell.type === SURFACE_TYPES.TWO_SIMPLEX
          ? ELEMENT_KINDS.TWO_SIMPLEX
          : ELEMENT_KINDS.TWO_CELL,
      schemaRef: schemaRefForElementKind(
        cell.type === SURFACE_TYPES.TWO_SIMPLEX
          ? ELEMENT_KINDS.TWO_SIMPLEX
          : ELEMENT_KINDS.TWO_CELL,
      ),
      dimension: 2,
      name: cell.name,
      boundary: {
        edgeIds: [...cell.edgeIds],
      },
      controlData: {
        controlCoordinate: cell.controlCoordinate,
        ...(cell.controlDirection ? { controlDirection: arrayFromVector(cell.controlDirection) } : {}),
      },
    })),
  ];
}

export function hierarchicalThetaCellsFromElements(elements = []) {
  return {
    zero: elements
      .filter((element) => element.elementKind === ELEMENT_KINDS.ZERO_SIMPLEX)
      .map((element) => ({
        id: element.id,
        name: element.name ?? "",
        position: element.position,
      })),
    one: elements
      .filter((element) => element.elementKind === ELEMENT_KINDS.ONE_SIMPLEX)
      .map((element) => ({
        id: element.id,
        name: element.name ?? "",
        sourceId: element.boundary?.sourceId,
        targetId: element.boundary?.targetId,
        bend: element.controlData?.bend,
        ...(element.controlData?.frame ? { frame: element.controlData.frame } : {}),
      })),
    two: elements
      .filter((element) => element.dimension === 2)
      .map((element) => ({
        id: element.id,
        name: element.name ?? "",
        type:
          element.elementKind === ELEMENT_KINDS.TWO_SIMPLEX
            ? SURFACE_TYPES.TWO_SIMPLEX
            : SURFACE_TYPES.TWO_CELL,
        edgeIds: [...(element.boundary?.edgeIds ?? [])],
        controlCoordinate: Number(element.controlData?.controlCoordinate ?? 0),
        ...(element.controlData?.controlDirection ? { controlDirection: element.controlData.controlDirection } : {}),
      })),
  };
}

function normalizeElementKindForRecord(record) {
  return (
    normalizeHierarchicalThetaElementKind(
      record.elementKind ?? record.kind ?? record.type,
    ) ??
    (Number(record.dimension) === 0
      ? ELEMENT_KINDS.ZERO_SIMPLEX
      : Number(record.dimension) === 1
        ? ELEMENT_KINDS.ONE_SIMPLEX
        : Number(record.dimension) === 2
          ? ELEMENT_KINDS.TWO_CELL
          : null)
  );
}

export function normalizeSerializedHierarchicalThetaElement(
  record,
  { vectorFromArray, vector2FromArray },
) {
  const elementKind = normalizeElementKindForRecord(record);
  if (!elementKind) {
    throw new Error(
      `Unsupported serialized element kind: ${record.elementKind ?? record.kind}`,
    );
  }
  if (elementKind === THETA_VOLUME_KIND) {
    return { id: String(record.id), name: String(record.name ?? ""), elementKind,
      dimension: 3, schemaRef: thetaVolumeSchemaRef(record),
      boundary: { faces: { ...(record.boundary?.faces ?? record.faces ?? {}) } },
      ...(record.render ? { render: { ...record.render } } : {}) };
  }
  const dimension = Number(
    record.dimension ??
      (elementKind === ELEMENT_KINDS.ZERO_SIMPLEX
        ? 0
        : elementKind === ELEMENT_KINDS.ONE_SIMPLEX
          ? 1
          : 2),
  );
  if (elementKind === ELEMENT_KINDS.ZERO_SIMPLEX) {
    return {
      id: String(record.id),
      elementKind,
      schemaRef: schemaRefForElementKind(elementKind),
      dimension,
      name: String(record.name ?? ""),
      position: vectorFromArray(
        record.position ?? record.data?.position,
        `${record.id}.position`,
      ),
    };
  }
  if (elementKind === ELEMENT_KINDS.ONE_SIMPLEX) {
    return {
      id: String(record.id),
      elementKind,
      schemaRef: schemaRefForElementKind(elementKind),
      dimension,
      name: String(record.name ?? ""),
      boundary: {
        sourceId: String(record.boundary?.sourceId ?? record.sourceId),
        targetId: String(record.boundary?.targetId ?? record.targetId),
      },
      controlData: {
        bend: vector2FromArray(
          record.controlData?.bend ?? record.bend ?? [0, 0],
          `${record.id}.bend`,
        ),
        frame: normalizeFrameGauge(record.controlData?.frame ?? record.frame),
      },
    };
  }
  return {
    id: String(record.id),
    elementKind:
      elementKind === ELEMENT_KINDS.TWO_SIMPLEX
        ? ELEMENT_KINDS.TWO_SIMPLEX
        : ELEMENT_KINDS.TWO_CELL,
    schemaRef: schemaRefForElementKind(elementKind),
    dimension,
    name: String(record.name ?? ""),
    boundary: {
      edgeIds: [...(record.boundary?.edgeIds ?? record.edgeIds ?? [])].map(String),
    },
    controlData: {
      controlCoordinate: Number(
        record.controlData?.controlCoordinate ?? record.controlCoordinate ?? 0,
      ),
      controlDirection: normalizeControlDirection(record.controlData?.controlDirection ?? record.controlDirection),
    },
  };
}

export function hierarchicalThetaCreationPayload(element) {
  if (element.elementKind === THETA_VOLUME_KIND) {
    return { id: element.id, name: element.name, elementKind: element.elementKind,
      schemaRef: element.schemaRef, faces: { ...element.boundary.faces }, render: element.render };
  }
  if (element.dimension === 0) {
    return {
      id: element.id,
      elementKind: element.elementKind,
      schemaRef: element.schemaRef,
      name: element.name,
      position: element.position,
    };
  }
  if (element.dimension === 1) {
    return {
      id: element.id,
      elementKind: element.elementKind,
      schemaRef: element.schemaRef,
      name: element.name,
      sourceId: element.boundary.sourceId,
      targetId: element.boundary.targetId,
      bend: element.controlData.bend,
      frame: element.controlData.frame,
    };
  }
  if (element.elementKind === ELEMENT_KINDS.TWO_SIMPLEX) {
    return {
      id: element.id,
      elementKind: element.elementKind,
      schemaRef: element.schemaRef,
      name: element.name,
      edgeIds: [...element.boundary.edgeIds],
      controlCoordinate: element.controlData.controlCoordinate,
      controlDirection: element.controlData.controlDirection,
    };
  }
  return {
    id: element.id,
    elementKind: element.elementKind,
    schemaRef: element.schemaRef,
    name: element.name,
    firstEdgeId: element.boundary.edgeIds[0],
    secondEdgeId: element.boundary.edgeIds[1],
    controlCoordinate: element.controlData.controlCoordinate,
      controlDirection: element.controlData.controlDirection,
  };
}

export const HIERARCHICAL_THETA_SPACE_DEFINITION = Object.freeze({
  id: HIERARCHICAL_THETA_SPACE_STRUCTURE_ID,
  schema: HIERARCHICAL_THETA_SPACE_SCHEMA,
  interactionMode: "ordinary",
  elementKinds: ELEMENT_KINDS,
  normalizeElementKind: normalizeHierarchicalThetaElementKind,
  normalizeSerializedElement: normalizeSerializedHierarchicalThetaElement,
  serializeElements: serializeHierarchicalThetaElements,
  elementsFromLegacyCells: hierarchicalThetaElementsFromCells,
  creationPayload: hierarchicalThetaCreationPayload,
});
