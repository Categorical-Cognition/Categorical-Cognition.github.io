import { normalizeControlDirection, normalizeFrameGauge, serializeFrameGauge } from "./frame-service.js";
import * as THREE from "three";
import {
  createObjectLabel,
  createSurfaceControlHandleRecord,
  SURFACE_TYPES,
} from "./domain-object-definitions.js";
import { getQuadraticControlPoint } from "./geometry-utils.js";
import { DEFAULT_MATH_SCHEMA_REGISTRY, schemaRefForElementKind } from "./mathematical-schema-registry.js";
import {
  VIRTUAL_DOUBLE_CATEGORY_SCHEMA_ID,
  VIRTUAL_DOUBLE_CATEGORY_STRUCTURE_ID,
  VIRTUAL_DOUBLE_ELEMENT_KINDS,
} from "./virtual-double-category-schema.js";

export {
  VIRTUAL_DOUBLE_CATEGORY_SCHEMA_ID,
  VIRTUAL_DOUBLE_CATEGORY_STRUCTURE_ID,
  VIRTUAL_DOUBLE_ELEMENT_KINDS,
};

const VIRTUAL_OBJECT_RENDER = Object.freeze({
  color: 0xc8d4ff,
  selectedColor: 0xffdf75,
  radius: 0.5,
});

const TIGHT_ARROW_RENDER = Object.freeze({
  color: 0x74b9ff,
  opacity: 0.92,
  thickness: 0.045,
  marker: "none",
});

const PROARROW_RENDER = Object.freeze({
  color: 0xe78bff,
  opacity: 0.98,
  thickness: 0.085,
  marker: "proarrow",
});

const VIRTUAL_CELL_RENDER = Object.freeze({
  color: 0x5eead4,
  opacity: 0.28,
  samples: 12,
});

const VIRTUAL_CELL_HANDLE_RENDER = Object.freeze({
  radius: 0.115,
  color: 0x76f4df,
  selectedColor: 0xffffff,
  pickRadius: 0.3,
});

function cloneArray(value) {
  return value?.toArray?.() ?? value;
}

function edgeKind(edge) {
  return edge?.elementKind ?? edge?.arrowKind ?? null;
}

export function isVirtualDoubleObject(record) {
  return record?.elementKind === VIRTUAL_DOUBLE_ELEMENT_KINDS.OBJECT;
}

export function isTightArrow(edge) {
  return edgeKind(edge) === VIRTUAL_DOUBLE_ELEMENT_KINDS.TIGHT_ARROW;
}

export function isProarrow(edge) {
  return edgeKind(edge) === VIRTUAL_DOUBLE_ELEMENT_KINDS.PROARROW;
}

export function normalizeVirtualDoubleElementKind(kind) {
  const resolved = DEFAULT_MATH_SCHEMA_REGISTRY.normalizeElementKind(kind);
  return Object.values(VIRTUAL_DOUBLE_ELEMENT_KINDS).includes(resolved) ? resolved : null;
}

function createVirtualObject(store, payload) {
  return store.createSphere(
    payload.position ?? store.findCompactNodePosition?.() ?? new THREE.Vector3(),
    {
      ...payload,
      render: { ...VIRTUAL_OBJECT_RENDER, ...(payload.render ?? {}) },
    },
  );
}

function createVirtualArrow(store, payload, elementKind) {
  return store.createEdge(payload.sourceId, payload.targetId, {
    ...payload,
    elementKind,
    arrowKind: elementKind,
    render: {
      ...(elementKind === VIRTUAL_DOUBLE_ELEMENT_KINDS.PROARROW
        ? PROARROW_RENDER
        : TIGHT_ARROW_RENDER),
      ...(payload.render ?? {}),
    },
  });
}

export function virtualDoubleElementDefinitions() {
  return [
    {
      elementKind: VIRTUAL_DOUBLE_ELEMENT_KINDS.OBJECT,
      createId: { prefix: "sphere-", counter: "nextSphereId" },
      selectableKind: "sphere",
      create: createVirtualObject,
    },
    {
      elementKind: VIRTUAL_DOUBLE_ELEMENT_KINDS.TIGHT_ARROW,
      createId: { prefix: "edge-", counter: "nextEdgeId" },
      selectableKind: "edge",
      resourceKey: (payload) => `${payload.sourceId}->${payload.targetId}`,
      create(store, payload) {
        return createVirtualArrow(
          store,
          payload,
          VIRTUAL_DOUBLE_ELEMENT_KINDS.TIGHT_ARROW,
        );
      },
    },
    {
      elementKind: VIRTUAL_DOUBLE_ELEMENT_KINDS.PROARROW,
      createId: { prefix: "edge-", counter: "nextEdgeId" },
      selectableKind: "edge",
      resourceKey: (payload) => `${payload.sourceId}~>${payload.targetId}`,
      create(store, payload) {
        return createVirtualArrow(
          store,
          payload,
          VIRTUAL_DOUBLE_ELEMENT_KINDS.PROARROW,
        );
      },
    },
    {
      elementKind: VIRTUAL_DOUBLE_ELEMENT_KINDS.CELL,
      createId: { prefix: "virtual-cell-", counter: "nextSurfaceId" },
      selectableKind: "surface",
      resourceKey: (payload) => [
        ...(payload.topPathIds ?? []),
        payload.bottomArrowId,
        payload.leftArrowId,
        payload.rightArrowId,
      ].filter(Boolean).join("+"),
      create: createVirtualCellElement,
    },
  ];
}

function orderedProarrowPath(edges) {
  if (edges.length === 0 || edges.some((edge) => !isProarrow(edge))) {
    return null;
  }
  const remaining = [...edges];
  const search = (path) => {
    if (remaining.length === 0) {
      return [...path];
    }
    const targetId = path.at(-1)?.targetId ?? null;
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index];
      if (targetId && candidate.sourceId !== targetId) {
        continue;
      }
      remaining.splice(index, 1);
      path.push(candidate);
      const resolved = search(path);
      if (resolved) {
        return resolved;
      }
      path.pop();
      remaining.splice(index, 0, candidate);
    }
    return null;
  };
  return search([]);
}

export function resolveVirtualCellBoundary(
  store,
  { topPathIds, bottomArrowId, leftArrowId, rightArrowId } = {},
) {
  const resolve = () => findVirtualCellBoundary(store, { topPathIds, bottomArrowId, leftArrowId, rightArrowId });
  return store.resolveBoundary
    ? store.resolveBoundary("virtual-cell", [topPathIds, bottomArrowId, leftArrowId, rightArrowId], resolve)
    : resolve();
}

function findVirtualCellBoundary(store, { topPathIds, bottomArrowId, leftArrowId, rightArrowId }) {
  const topPath = (topPathIds ?? []).map((id) => store.edges.get(id));
  const bottomArrow = store.edges.get(bottomArrowId);
  const leftArrow = store.edges.get(leftArrowId);
  const rightArrow = store.edges.get(rightArrowId);
  if (
    topPath.length === 0 ||
    topPath.some((edge) => !edge) ||
    !isProarrow(bottomArrow) ||
    !isTightArrow(leftArrow) ||
    !isTightArrow(rightArrow)
  ) {
    return null;
  }
  for (let index = 1; index < topPath.length; index += 1) {
    if (topPath[index - 1].targetId !== topPath[index].sourceId) {
      return null;
    }
  }
  if (
    leftArrow.sourceId !== topPath[0].sourceId ||
    leftArrow.targetId !== bottomArrow.sourceId ||
    rightArrow.sourceId !== topPath.at(-1).targetId ||
    rightArrow.targetId !== bottomArrow.targetId
  ) {
    return null;
  }
  const nodeIds = [
    topPath[0].sourceId,
    ...topPath.map((edge) => edge.targetId),
    bottomArrow.sourceId,
    bottomArrow.targetId,
  ];
  const nodes = nodeIds.map((id) => store.spheres.get(id));
  if (nodes.some((node) => !node || !isVirtualDoubleObject(node))) {
    return null;
  }
  return {
    topPath,
    bottomArrow,
    leftArrow,
    rightArrow,
    nodeIds,
  };
}

export function inferVirtualCellBoundary(store, edgeIds = []) {
  const edges = [...new Set(edgeIds)].map((id) => store.edges.get(id));
  if (edges.some((edge) => !edge)) {
    return null;
  }
  const tight = edges.filter(isTightArrow);
  const proarrows = edges.filter(isProarrow);
  if (tight.length !== 2 || proarrows.length < 2) {
    return null;
  }

  for (const bottomArrow of proarrows) {
    const topPath = orderedProarrowPath(
      proarrows.filter((edge) => edge !== bottomArrow),
    );
    if (!topPath) {
      continue;
    }
    for (const leftArrow of tight) {
      const rightArrow = tight.find((edge) => edge !== leftArrow);
      const boundary = {
        topPathIds: topPath.map((edge) => edge.id),
        bottomArrowId: bottomArrow.id,
        leftArrowId: leftArrow.id,
        rightArrowId: rightArrow.id,
      };
      if (resolveVirtualCellBoundary(store, boundary)) {
        return boundary;
      }
    }
  }
  return null;
}

function quadraticPoint(start, control, end, t) {
  const oneMinus = 1 - t;
  return start
    .clone()
    .multiplyScalar(oneMinus * oneMinus)
    .addScaledVector(control, 2 * oneMinus * t)
    .addScaledVector(end, t * t);
}

function quadraticDerivative(start, control, end, t) {
  return control
    .clone()
    .sub(start)
    .multiplyScalar(2 * (1 - t))
    .add(end.clone().sub(control).multiplyScalar(2 * t));
}

function quadraticSubcurve(start, control, end, from, to) {
  const subStart = quadraticPoint(start, control, end, from);
  const subEnd = quadraticPoint(start, control, end, to);
  const subControl = subStart
    .clone()
    .addScaledVector(
      quadraticDerivative(start, control, end, from),
      (to - from) / 2,
    );
  return [subStart, subControl, subEnd];
}

function patchCenterControl(controlNet, centerPoint) {
  const weights = [0.25, 0.5, 0.25];
  const contribution = new THREE.Vector3();
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      if (row === 1 && column === 1) {
        continue;
      }
      contribution.addScaledVector(
        controlNet[row][column],
        weights[row] * weights[column],
      );
    }
  }
  return centerPoint.clone().sub(contribution).multiplyScalar(4);
}

function edgeControl(store, edge) {
  const source = store.spheres.get(edge.sourceId);
  const target = store.spheres.get(edge.targetId);
  return getQuadraticControlPoint(source.position, edge.midpoint, target.position);
}

function virtualCellFrame(store, surface, boundary) {
  const topStart = store.spheres.get(boundary.topPath[0].sourceId).position;
  const topEnd = store.spheres.get(boundary.topPath.at(-1).targetId).position;
  const bottomStart = store.spheres.get(boundary.bottomArrow.sourceId).position;
  const bottomEnd = store.spheres.get(boundary.bottomArrow.targetId).position;
  const horizontal = topEnd.clone().sub(topStart);
  const vertical = bottomStart.clone().sub(topStart);
  let normal = horizontal.cross(vertical);
  if (normal.lengthSq() <= 1e-10) {
    normal = surface.controlDirection?.clone?.() ?? new THREE.Vector3(0, 0, 1);
  }
  normal.normalize();
  if (surface.controlDirection?.dot?.(normal) < 0) {
    normal.negate();
  }
  const origin = new THREE.Vector3()
    .add(topStart)
    .add(topEnd)
    .add(bottomStart)
    .add(bottomEnd)
    .multiplyScalar(0.25);
  return { origin, normal };
}

function virtualCellPatchControlNets(store, surface, boundary, frame) {
  const segmentCount = boundary.topPath.length;
  const bottomSource = store.spheres.get(boundary.bottomArrow.sourceId).position;
  const bottomTarget = store.spheres.get(boundary.bottomArrow.targetId).position;
  const bottomControl = edgeControl(store, boundary.bottomArrow);
  const leftControl = edgeControl(store, boundary.leftArrow);
  const rightControl = edgeControl(store, boundary.rightArrow);

  return boundary.topPath.map((topEdge, index) => {
    const topSource = store.spheres.get(topEdge.sourceId).position;
    const topTarget = store.spheres.get(topEdge.targetId).position;
    const topControl = edgeControl(store, topEdge);
    const bottom = quadraticSubcurve(
      bottomSource,
      bottomControl,
      bottomTarget,
      index / segmentCount,
      (index + 1) / segmentCount,
    );
    const leftMid = index === 0
      ? leftControl.clone()
      : topSource.clone().lerp(bottom[0], 0.5);
    const rightMid = index === segmentCount - 1
      ? rightControl.clone()
      : topTarget.clone().lerp(bottom[2], 0.5);
    const controlNet = [
      [topSource.clone(), topControl, topTarget.clone()],
      [leftMid, new THREE.Vector3(), rightMid],
      bottom,
    ];
    const topMid = quadraticPoint(topSource, topControl, topTarget, 0.5);
    const bottomMid = quadraticPoint(bottom[0], bottom[1], bottom[2], 0.5);
    const centerPoint = topMid
      .clone()
      .lerp(bottomMid, 0.5)
      .addScaledVector(frame.normal, surface.controlCoordinate);
    controlNet[1][1] = patchCenterControl(controlNet, centerPoint);
    return controlNet;
  });
}

export function createVirtualCellElement(
  store,
  payload = {},
) {
  const boundary = resolveVirtualCellBoundary(store, payload);
  if (!boundary) {
    return null;
  }
  const id = payload.id ?? `virtual-cell-${store.nextSurfaceId++}`;
  store.reserveNumericId(id, "virtual-cell-", "nextSurfaceId");
  if (store.surfaces.has(id)) {
    return id;
  }
  const surface = {
    id,
    name: String(payload.name ?? ""),
    type: SURFACE_TYPES.VIRTUAL_CELL,
    elementKind: VIRTUAL_DOUBLE_ELEMENT_KINDS.CELL,
    schemaRef:
      payload.schemaRef ??
      schemaRefForElementKind(VIRTUAL_DOUBLE_ELEMENT_KINDS.CELL),
    topPathIds: boundary.topPath.map((edge) => edge.id),
    bottomArrowId: boundary.bottomArrow.id,
    leftArrowId: boundary.leftArrow.id,
    rightArrowId: boundary.rightArrow.id,
    edgeIds: [
      ...boundary.topPath.map((edge) => edge.id),
      boundary.bottomArrow.id,
      boundary.leftArrow.id,
      boundary.rightArrow.id,
    ],
    nodeIds: [...boundary.nodeIds],
    controlCoordinate: Number(payload.controlCoordinate ?? 0),
    controlPoint: new THREE.Vector3(),
    controlDirection: normalizeControlDirection(payload.controlDirection) ?? new THREE.Vector3(0, 0, 1),
    render: { ...VIRTUAL_CELL_RENDER, ...(payload.render ?? {}) },
    handleRender: { ...VIRTUAL_CELL_HANDLE_RENDER },
  };
  store.surfaces.set(id, surface);
  syncVirtualCellElementObjects(store, surface);
  store.selectedSphereId = null;
  store.selectedSimplexId = id;
  store.emitStateChanged();
  store.events.sphereSelected(null);
  store.events.edgeSelected(null);
  store.events.surfaceCreated(store.surfaceRenderPayload(surface));
  store.events.surfaceSelected(id);
  return id;
}

export function syncVirtualCellElementObjects(store, surface) {
  const boundary = resolveVirtualCellBoundary(store, surface);
  if (!boundary) {
    return false;
  }
  const frame = virtualCellFrame(store, surface, boundary);
  surface.controlDirection.copy(frame.normal);
  surface.controlPoint.copy(
    frame.origin.clone().addScaledVector(frame.normal, surface.controlCoordinate),
  );
  surface.nodeIds = [...boundary.nodeIds];
  surface.edgeIds = [
    ...surface.topPathIds,
    surface.bottomArrowId,
    surface.leftArrowId,
    surface.rightArrowId,
  ];
  const handleId = store.surfaceControlHandleId(surface.id);
  store.upsertObject({
    id: surface.id,
    name: surface.name,
    kind: "surface",
    surfaceType: SURFACE_TYPES.VIRTUAL_CELL,
    elementKind: VIRTUAL_DOUBLE_ELEMENT_KINDS.CELL,
    schemaRef:
      surface.schemaRef ??
      schemaRefForElementKind(VIRTUAL_DOUBLE_ELEMENT_KINDS.CELL),
    dimension: 2,
    lockable: true,
    edgeIds: [...surface.edgeIds],
    nodeIds: [...surface.nodeIds],
    topPathIds: [...surface.topPathIds],
    bottomArrowId: surface.bottomArrowId,
    leftArrowId: surface.leftArrowId,
    rightArrowId: surface.rightArrowId,
    patchControlNets: virtualCellPatchControlNets(store, surface, boundary, frame),
    controlCoordinate: surface.controlCoordinate,
    controlPoint: surface.controlPoint.clone(),
    controlDirection: surface.controlDirection.clone(),
    controlHandleId: handleId,
    origin: surface.controlPoint.clone(),
    label: createObjectLabel(surface.name, surface.controlPoint, { size: 0.45 }),
    render: surface.render ?? VIRTUAL_CELL_RENDER,
  });
  store.upsertObject(
    createSurfaceControlHandleRecord({
      surface,
      handleId,
      controlPoint: surface.controlPoint,
      controlDirection: surface.controlDirection,
    }),
  );
  return true;
}

export function virtualCellControlLineForStore(store, surface) {
  const boundary = resolveVirtualCellBoundary(store, surface);
  if (!boundary) {
    return null;
  }
  const frame = virtualCellFrame(store, surface, boundary);
  return {
    origin: frame.origin,
    direction: frame.normal,
    defaultCoordinate: 0,
  };
}

export function serializeVirtualDoubleElements(state) {
  return [
    ...[...state.spheres.values()].map((object) => ({
      id: object.id,
      elementKind: VIRTUAL_DOUBLE_ELEMENT_KINDS.OBJECT,
      schemaRef: schemaRefForElementKind(VIRTUAL_DOUBLE_ELEMENT_KINDS.OBJECT),
      dimension: 0,
      name: object.name ?? "",
      position: cloneArray(object.position),
    })),
    ...[...state.edges.values()].map((arrow) => ({
      id: arrow.id,
      elementKind: arrow.elementKind,
      schemaRef: schemaRefForElementKind(arrow.elementKind),
      dimension: 1,
      name: arrow.name ?? "",
      boundary: { sourceId: arrow.sourceId, targetId: arrow.targetId },
      controlData: { bend: cloneArray(arrow.bend), frame: serializeFrameGauge(state.objects.get(arrow.frameId)) },
    })),
    ...[...state.surfaces.values()].map((cell) => ({
      id: cell.id,
      elementKind: VIRTUAL_DOUBLE_ELEMENT_KINDS.CELL,
      schemaRef: schemaRefForElementKind(VIRTUAL_DOUBLE_ELEMENT_KINDS.CELL),
      dimension: 2,
      name: cell.name ?? "",
      boundary: {
        topPathIds: [...cell.topPathIds],
        bottomArrowId: cell.bottomArrowId,
        leftArrowId: cell.leftArrowId,
        rightArrowId: cell.rightArrowId,
      },
      controlData: { controlCoordinate: cell.controlCoordinate, controlDirection: cloneArray(cell.controlDirection) },
    })),
  ];
}

export function normalizeSerializedVirtualDoubleElement(
  record,
  { vectorFromArray, vector2FromArray },
) {
  const elementKind = normalizeVirtualDoubleElementKind(record.elementKind);
  if (!elementKind) {
    throw new Error(`Unsupported virtual-double element: ${record.elementKind}`);
  }
  const base = {
    id: String(record.id),
    elementKind,
    schemaRef: schemaRefForElementKind(elementKind),
    dimension: Number(record.dimension ?? 0),
    name: String(record.name ?? ""),
  };
  if (elementKind === VIRTUAL_DOUBLE_ELEMENT_KINDS.OBJECT) {
    return {
      ...base,
      dimension: 0,
      position: vectorFromArray(record.position, `${record.id}.position`),
    };
  }
  if (
    elementKind === VIRTUAL_DOUBLE_ELEMENT_KINDS.TIGHT_ARROW ||
    elementKind === VIRTUAL_DOUBLE_ELEMENT_KINDS.PROARROW
  ) {
    return {
      ...base,
      dimension: 1,
      boundary: {
        sourceId: String(record.boundary?.sourceId ?? record.sourceId),
        targetId: String(record.boundary?.targetId ?? record.targetId),
      },
      controlData: {
        bend: vector2FromArray(
          record.controlData?.bend ?? record.bend ?? [0, 0],
          `${record.id}.bend`,
        ),
        frame: normalizeFrameGauge(record.controlData?.frame),
      },
    };
  }
  return {
    ...base,
    dimension: 2,
    boundary: {
      topPathIds: [...(record.boundary?.topPathIds ?? [])].map(String),
      bottomArrowId: String(record.boundary?.bottomArrowId ?? ""),
      leftArrowId: String(record.boundary?.leftArrowId ?? ""),
      rightArrowId: String(record.boundary?.rightArrowId ?? ""),
    },
    controlData: {
      controlCoordinate: Number(record.controlData?.controlCoordinate ?? 0),
      controlDirection: normalizeControlDirection(record.controlData?.controlDirection),
    },
  };
}

export function virtualDoubleCreationPayload(element) {
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
  return {
    id: element.id,
    elementKind: element.elementKind,
    schemaRef: element.schemaRef,
    name: element.name,
    ...element.boundary,
    controlCoordinate: element.controlData.controlCoordinate,
    controlDirection: element.controlData.controlDirection,
  };
}

export const VIRTUAL_DOUBLE_CATEGORY_DEFINITION = Object.freeze({
  id: VIRTUAL_DOUBLE_CATEGORY_STRUCTURE_ID,
  schema: VIRTUAL_DOUBLE_CATEGORY_SCHEMA_ID,
  interactionMode: "virtual-double",
  elementKinds: VIRTUAL_DOUBLE_ELEMENT_KINDS,
  normalizeElementKind: normalizeVirtualDoubleElementKind,
  normalizeSerializedElement: normalizeSerializedVirtualDoubleElement,
  serializeElements: serializeVirtualDoubleElements,
  creationPayload: virtualDoubleCreationPayload,
});
