import {
  EDGE_BEND_HANDLE_RENDER_SPEC,
  EDGE_RENDER_SPEC,
  SPHERE_RENDER_SPEC,
  SURFACE_CONTROL_HANDLE_RENDER_SPEC,
  SURFACE_RENDER_SPEC,
} from "./domain-object-definitions.js";
import { cloneStoreValue } from "./store-utils.js";

function scaledNumber(value, scale) {
  return typeof value === "number" && typeof scale === "number"
    ? value * scale
    : value;
}

function renderWithDefaults(record, defaults, renderScale = {}) {
  const render = {
    ...defaults,
    ...(record?.render ?? {}),
  };
  return {
    ...render,
    radius: scaledNumber(render.radius, renderScale.radius),
    height: scaledNumber(render.height, renderScale.height),
    pickRadius: scaledNumber(render.pickRadius, renderScale.pickRadius),
    thickness: scaledNumber(render.thickness, renderScale.thickness),
  };
}

export function projectObjectLabel(record) {
  const label = record?.label;
  const text = String(label?.text ?? "");
  if (!label?.anchor || !text) {
    return null;
  }

  return {
    id: record.id,
    kind: record.kind,
    name: `${record.id}-label`,
    text,
    size: label.size ?? 1,
    anchor: label.anchor.clone(),
  };
}

export function projectSphereMesh(
  record,
  { position = record?.position, renderScale = {} } = {},
) {
  if (!record || record.kind !== "sphere" || !position) {
    return null;
  }

  const render = renderWithDefaults(record, SPHERE_RENDER_SPEC, renderScale);
  return {
    id: record.id,
    name: record.id,
    position: position.clone(),
    radius: render.radius,
    color: render.color,
    selectedColor: render.selectedColor,
    render,
  };
}

export function projectSelectionStyle(
  record,
  { selected, selectedScale = 1.12, renderScale = {} } = {},
) {
  const render = renderWithDefaults(record, SPHERE_RENDER_SPEC, renderScale);
  return {
    color: selected ? render.selectedColor : render.color,
    scale: selected ? selectedScale : 1,
  };
}

export function projectEdgeHandleMesh(record, { renderScale = {} } = {}) {
  if (!record || record.kind !== "edge-bend-handle") {
    return null;
  }

  const render = renderWithDefaults(
    record,
    EDGE_BEND_HANDLE_RENDER_SPEC,
    renderScale,
  );
  return {
    id: record.id,
    edgeId: record.edgeId,
    name: `${record.edgeId}-midpoint-cone`,
    radius: render.radius,
    height: render.height,
    color: render.color,
    selectedColor: render.selectedColor,
    pickRadius: render.pickRadius,
    render,
  };
}

export function projectSurfaceControlMesh(record, { renderScale = {} } = {}) {
  if (!record || record.kind !== "surface-control-handle") {
    return null;
  }

  const render = renderWithDefaults(
    record,
    SURFACE_CONTROL_HANDLE_RENDER_SPEC,
    renderScale,
  );
  return {
    id: record.id,
    surfaceId: record.surfaceId,
    name: `${record.surfaceId}-surface-control`,
    radius: render.radius,
    color: render.color,
    selectedColor: render.selectedColor,
    pickRadius: render.pickRadius,
    position: record.position?.clone() ?? null,
    render,
  };
}

export function projectEdgeBatchRecord(record, { renderScale = {} } = {}) {
  if (!record || record.kind !== "edge") {
    return null;
  }

  return {
    id: record.id,
    start: record.sourcePosition.clone(),
    midpoint: record.midpoint.clone(),
    end: record.targetPosition.clone(),
    control: record.curveControlPoint.clone(),
    render: renderWithDefaults(record, EDGE_RENDER_SPEC, renderScale),
  };
}

export function projectSurfaceBatchRecord(record) {
  if (!record || (record.kind !== "surface" && record.kind !== "two-simplex")) {
    return null;
  }

  const base = {
    id: record.id,
    render: renderWithDefaults(record, SURFACE_RENDER_SPEC),
  };

  if (record.triangleControlNet) {
    return {
      ...base,
      triangleControlNet: cloneStoreValue(record.triangleControlNet),
    };
  }

  if (record.controlNet) {
    return {
      ...base,
      controlNet: cloneStoreValue(record.controlNet),
    };
  }

  return {
    ...base,
    start: record.sourcePosition.clone(),
    end: record.targetPosition.clone(),
    firstControl: record.firstControlPoint.clone(),
    secondControl: record.secondControlPoint.clone(),
    centerPoint: record.controlPoint.clone(),
  };
}

export function projectSurfaceBatchRecords(record) {
  if (!record?.patchControlNets) {
    const projected = projectSurfaceBatchRecord(record);
    return projected ? [projected] : [];
  }
  const render = renderWithDefaults(record, SURFACE_RENDER_SPEC);
  return record.patchControlNets.map((controlNet, index) => ({
    id: `${record.id}:patch:${index + 1}`,
    ownerId: record.id,
    controlNet: cloneStoreValue(controlNet),
    render,
  }));
}

export function projectVolumeRecord(record, { getObject } = {}) {
  if (record?.kind !== "volume") return null;
  const boundaryFaceIds = [...new Set(record.boundaryFaceIds ?? [])];
  const missingFaceIds = [];
  const boundarySurfaces = boundaryFaceIds.map((faceId) => {
    const face = getObject?.(faceId);
    const patches = face ? projectSurfaceBatchRecords(face) : [];
    if (!patches.length) missingFaceIds.push(faceId);
    return { faceId, patches };
  });
  return {
    id: record.id,
    name: record.name ?? record.label?.text ?? "",
    schemaRef: cloneStoreValue(record.schemaRef),
    boundaryFaceIds,
    boundarySurfaces,
    missingFaceIds,
    origin: record.origin?.clone() ?? record.label?.anchor?.clone() ?? null,
    render: {
      color: 0xe9b963,
      selectedColor: 0xffed95,
      opacity: 0.13,
      selectedOpacity: 0.29,
      pickRadius: 0.11,
      ...(record.render ?? {}),
    },
  };
}
