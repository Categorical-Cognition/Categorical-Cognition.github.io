import * as THREE from "three";
import { schemaRefForElementKind } from "./mathematical-schema-registry.js";

const EDGE_BEND_SEARCH_STEPS = 24;
const EDGE_BEND_CLEARANCE_EPSILON = 1e-8;

export const SPHERE_RENDER_SPEC = Object.freeze({
  objectType: "mesh",
  geometry: "sphere",
  radius: 0.55,
  color: 0xb6c7ff,
  selectedColor: 0xf7d56f,
});

export const EDGE_RENDER_SPEC = Object.freeze({
  objectType: "batched-ribbon",
  geometry: "quadratic-bezier-ribbon",
  color: 0xf28a8a,
  opacity: 0.86,
  samples: 32,
  thickness: 0.06,
});

export const EDGE_BEND_HANDLE_RENDER_SPEC = Object.freeze({
  objectType: "mesh",
  geometry: "cone",
  radius: 0.08,
  height: 0.225,
  color: 0xf3a3a3,
  selectedColor: 0xffffff,
  pickRadius: 0.24,
});

export const SURFACE_RENDER_SPEC = Object.freeze({
  objectType: "batched-surface",
  geometry: "biquadratic-bezier-patch",
  color: 0x8fb9ff,
  opacity: 0.26,
  samples: 10,
});

export const TWO_SIMPLEX_RENDER_SPEC = Object.freeze({
  objectType: "batched-surface",
  geometry: "triangular-cubic-simplex-patch",
  color: 0x7bdc9a,
  opacity: 0.34,
  samples: 10,
});

export const SURFACE_CONTROL_HANDLE_RENDER_SPEC = Object.freeze({
  objectType: "mesh",
  geometry: "sphere",
  radius: 0.105,
  color: 0x9fe6ff,
  selectedColor: 0xffffff,
  pickRadius: 0.28,
});

export const TWO_SIMPLEX_CONTROL_HANDLE_RENDER_SPEC = Object.freeze({
  objectType: "mesh",
  geometry: "sphere",
  radius: 0.12,
  color: 0xb8f6c4,
  selectedColor: 0xffffff,
  pickRadius: 0.3,
});

export const SURFACE_TYPES = Object.freeze({
  TWO_CELL: "two-cell",
  TWO_SIMPLEX: "two-simplex",
  VIRTUAL_CELL: "virtual-cell",
});

export const EDGE_BEND_HANDLE_CLEARANCE =
  EDGE_BEND_HANDLE_RENDER_SPEC.radius * 3;

function hasBendClearance(candidate, existingBends, clearance) {
  return existingBends.every(
    (bend) =>
      candidate.distanceTo(bend) + EDGE_BEND_CLEARANCE_EPSILON >= clearance,
  );
}

function edgeBendCandidates(clearance, steps) {
  const candidates = [];
  for (let x = -steps; x <= steps; x += 1) {
    for (let y = -steps; y <= steps; y += 1) {
      candidates.push(new THREE.Vector2(x * clearance, y * clearance));
    }
  }
  return candidates.sort(
    (first, second) =>
      first.lengthSq() - second.lengthSq() ||
      first.y - second.y ||
      first.x - second.x,
  );
}

export function findNearestAvailableEdgeBend(
  existingBends,
  {
    clearance = EDGE_BEND_HANDLE_CLEARANCE,
    steps = EDGE_BEND_SEARCH_STEPS,
  } = {},
) {
  const bends = existingBends.filter(Boolean);
  const candidate = edgeBendCandidates(clearance, steps).find((bend) =>
    hasBendClearance(bend, bends, clearance),
  );

  return candidate ?? new THREE.Vector2((steps + 1) * clearance, 0);
}

export function nodePairEndpoints(sourceId, targetId) {
  return [sourceId, targetId].sort();
}

export function nodePairId(sourceId, targetId) {
  const [firstId, secondId] = nodePairEndpoints(sourceId, targetId);
  return `node-pair:${firstId}:${secondId}`;
}

export function nodePairFrameId(sourceId, targetId) {
  return `${nodePairId(sourceId, targetId)}:orthogonal-frame`;
}

export function edgeBendHandleId(edgeId) {
  return `${edgeId}:bend-handle`;
}

export function surfaceControlHandleId(surfaceId) {
  return `${surfaceId}:control-handle`;
}

export function createObjectLabel(name, anchor, { size = 1 } = {}) {
  return {
    text: String(name ?? ""),
    anchor: anchor.clone(),
    size,
  };
}

function schemaFieldsForElementKind(elementKind) {
  const schemaRef = schemaRefForElementKind(elementKind);
  return schemaRef
    ? {
        elementKind: schemaRef.elementKind,
        schemaRef,
        schemaObjectId: schemaRef.objectId,
      }
    : {};
}

function schemaFieldsForRecord(record, fallbackElementKind) {
  const schemaRef = record?.schemaRef ?? schemaRefForElementKind(
    record?.elementKind ?? fallbackElementKind,
  );
  return schemaRef
    ? {
        elementKind: record?.elementKind ?? schemaRef.elementKind,
        schemaRef,
        schemaObjectId: schemaRef.objectId,
      }
    : { elementKind: record?.elementKind ?? fallbackElementKind };
}

export function createSphereObjectRecord(sphere) {
  return {
    id: sphere.id,
    name: sphere.name,
    kind: "sphere",
    ...schemaFieldsForRecord(sphere, "0-simplex"),
    dimension: 0,
    lockable: true,
    origin: sphere.position.clone(),
    position: sphere.position.clone(),
    childGologId: sphere.childGologId ?? null,
    payloads: {
      nestedGologId: sphere.childGologId ?? null,
    },
    label: createObjectLabel(sphere.name, sphere.position),
    render: { ...SPHERE_RENDER_SPEC, ...(sphere.render ?? {}) },
  };
}

export function createNodePairFrameRecord({
  id,
  nodeIds,
  origin,
  tangent,
  u,
  v,
}) {
  return {
    id,
    kind: "node-pair-orthogonal-frame",
    nodeIds,
    lockable: true,
    origin: origin.clone(),
    tangent: tangent.clone(),
    u: u.clone(),
    v: v.clone(),
  };
}

export function createEdgeObjectRecord({
  edge,
  source,
  target,
  controlPoint,
  handleId,
}) {
  return {
    id: edge.id,
    name: edge.name,
    kind: "edge",
    ...schemaFieldsForRecord(edge, "1-simplex"),
    arrowKind: edge.arrowKind ?? edge.elementKind ?? "1-simplex",
    dimension: 1,
    lockable: true,
    sourceId: edge.sourceId,
    targetId: edge.targetId,
    sourcePosition: source.position.clone(),
    targetPosition: target.position.clone(),
    origin: edge.midpoint.clone(),
    midpoint: edge.midpoint.clone(),
    bend: edge.bend.clone(),
    curveControlPoint: controlPoint.clone(),
    frameId: edge.frameId,
    bendHandleId: handleId,
    label: createObjectLabel(edge.name, edge.midpoint, { size: 0.5 }),
    render: { ...EDGE_RENDER_SPEC, ...(edge.render ?? {}) },
  };
}

export function createEdgeBendHandleRecord({ edge, handleId, tangent }) {
  return {
    id: handleId,
    kind: "edge-bend-handle",
    edgeId: edge.id,
    frameId: edge.frameId,
    lockable: true,
    position: edge.midpoint.clone(),
    tangent: tangent.clone(),
    render: {
      ...EDGE_BEND_HANDLE_RENDER_SPEC,
      ...(edge.handleRender ?? {}),
      ...(edge.render?.color ? { color: edge.render.color } : {}),
    },
  };
}

export function createSurfaceObjectRecord({
  surface,
  source,
  target,
  firstEdge,
  secondEdge,
  firstControlPoint,
  secondControlPoint,
  controlPoint,
  controlDirection,
  handleId,
}) {
  return {
    id: surface.id,
    name: surface.name,
    kind: "surface",
    surfaceType: surface.type ?? SURFACE_TYPES.TWO_CELL,
    ...schemaFieldsForRecord(surface, "2-cell"),
    dimension: 2,
    lockable: true,
    edgeIds: [...surface.edgeIds],
    sourceId: source.id,
    targetId: target.id,
    frameId: surface.frameId,
    sourcePosition: source.position.clone(),
    targetPosition: target.position.clone(),
    firstEdgeMidpoint: firstEdge.midpoint.clone(),
    secondEdgeMidpoint: secondEdge.midpoint.clone(),
    firstControlPoint: firstControlPoint.clone(),
    secondControlPoint: secondControlPoint.clone(),
    controlCoordinate: surface.controlCoordinate,
    controlPoint: controlPoint.clone(),
    controlDirection: controlDirection.clone(),
    controlHandleId: handleId,
    origin: controlPoint.clone(),
    label: createObjectLabel(surface.name, controlPoint, { size: 0.45 }),
    render: { ...SURFACE_RENDER_SPEC, ...(surface.render ?? {}) },
  };
}

function cloneControlNet(controlNet) {
  return controlNet.map((entry) =>
    Array.isArray(entry)
      ? cloneControlNet(entry)
      : entry?.clone?.() ?? null,
  );
}

export function createTwoSimplexObjectRecord({
  surface,
  source,
  middle,
  target,
  firstEdge,
  secondEdge,
  compositeEdge,
  triangleControlNet,
  controlPoint,
  controlDirection,
  handleId,
}) {
  return {
    id: surface.id,
    name: surface.name,
    kind: "two-simplex",
    surfaceType: SURFACE_TYPES.TWO_SIMPLEX,
    ...schemaFieldsForRecord(surface, "2-simplex"),
    dimension: 2,
    lockable: true,
    edgeIds: [...surface.edgeIds],
    nodeIds: [source.id, middle.id, target.id],
    firstEdgeId: firstEdge.id,
    secondEdgeId: secondEdge.id,
    compositeEdgeId: compositeEdge.id,
    sourceId: source.id,
    middleId: middle.id,
    targetId: target.id,
    sourcePosition: source.position.clone(),
    middlePosition: middle.position.clone(),
    targetPosition: target.position.clone(),
    firstEdgeMidpoint: firstEdge.midpoint.clone(),
    secondEdgeMidpoint: secondEdge.midpoint.clone(),
    compositeEdgeMidpoint: compositeEdge.midpoint.clone(),
    triangleControlNet: cloneControlNet(triangleControlNet),
    controlCoordinate: surface.controlCoordinate,
    controlPoint: controlPoint.clone(),
    controlDirection: controlDirection.clone(),
    controlHandleId: handleId,
    origin: controlPoint.clone(),
    label: createObjectLabel(surface.name, controlPoint, { size: 0.45 }),
    render: { ...TWO_SIMPLEX_RENDER_SPEC, ...(surface.render ?? {}) },
  };
}

export function createSurfaceControlHandleRecord({
  surface,
  handleId,
  controlPoint,
  controlDirection,
}) {
  return {
    id: handleId,
    kind: "surface-control-handle",
    surfaceId: surface.id,
    frameId: surface.frameId,
    lockable: true,
    position: controlPoint.clone(),
    direction: controlDirection.clone(),
    render: {
      ...(surface.type === SURFACE_TYPES.TWO_SIMPLEX
        ? TWO_SIMPLEX_CONTROL_HANDLE_RENDER_SPEC
        : SURFACE_CONTROL_HANDLE_RENDER_SPEC),
      ...(surface.handleRender ?? {}),
    },
  };
}

export function createEdgeRenderPayload(edge) {
  return {
    id: edge.id,
    sourceId: edge.sourceId,
    targetId: edge.targetId,
    frameId: edge.frameId,
    bend: edge.bend.clone(),
    midpoint: edge.midpoint.clone(),
  };
}

export function createSurfaceRenderPayload(surface) {
  return {
    id: surface.id,
    surfaceType: surface.type ?? SURFACE_TYPES.TWO_CELL,
    edgeIds: [...surface.edgeIds],
    frameId: surface.frameId,
    controlCoordinate: surface.controlCoordinate,
    controlPoint: surface.controlPoint.clone(),
    controlDirection: surface.controlDirection.clone(),
  };
}
