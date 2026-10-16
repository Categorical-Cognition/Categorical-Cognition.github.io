import { SURFACE_TYPES } from "./domain-object-definitions.js";
import { PAYLOAD_TYPES } from "./payload-types.js";

export const FORCE_LAYOUT_GRAPH_FORMAT = "golog.force-layout-graph";
export const FORCE_LAYOUT_GRAPH_VERSION = 1;

function cloneVector(value) {
  return value?.clone?.() ?? value;
}

function clonePlain(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => clonePlain(entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, clonePlain(entry)]),
    );
  }
  return value;
}

function edgeRestLength(source, target, fallback) {
  const distance = source.position.distanceTo(target.position);
  return Number.isFinite(fallback) ? fallback : Math.max(distance, 1);
}

function orderedHomsetKey(edge) {
  return `${edge.sourceId}->${edge.targetId}`;
}

function unorderedEdgePlaneKey(edge) {
  return edge.frameId ?? [edge.sourceId, edge.targetId].sort().join("<->");
}

function edgePlaneCohortCounts(edges) {
  const counts = new Map();
  for (const edge of edges) {
    const key = unorderedEdgePlaneKey(edge);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function twoSimplexFaceCounts(surfaces = []) {
  const counts = new Map();
  const addFace = (edgeId, faceIndex) => {
    if (!edgeId) {
      return;
    }
    if (!counts.has(edgeId)) {
      counts.set(edgeId, [0, 0, 0]);
    }
    counts.get(edgeId)[faceIndex] += 1;
  };
  for (const surface of surfaces) {
    if (surface.type !== SURFACE_TYPES.TWO_SIMPLEX) {
      continue;
    }
    const edgeIds = [...(surface.edgeIds ?? [])];
    if (edgeIds.length < 3) {
      continue;
    }
    addFace(edgeIds[1], 0);
    addFace(edgeIds[2], 1);
    addFace(edgeIds[0], 2);
  }
  return counts;
}

function edgeControlVertex(store, edge, planeCohortCounts = new Map()) {
  const frame =
    store.objects.get(edge.frameId) ??
    store.syncNodePairFrame?.(edge.sourceId, edge.targetId);
  if (!frame) {
    return null;
  }
  const planeKey = unorderedEdgePlaneKey({ ...edge, frameId: frame.id });
  const orientationKey = orderedHomsetKey(edge);
  return {
    id: edge.id,
    name: edge.name ?? "",
    objectId: edge.id,
    layoutKind: "edge-control",
    edgeId: edge.id,
    sourceId: edge.sourceId,
    targetId: edge.targetId,
    frameId: frame.id,
    homsetKey: planeKey,
    cohortKey: planeKey,
    planeKey,
    orientationKey,
    homsetSize: planeCohortCounts.get(planeKey) ?? 1,
    planeCohortSize: planeCohortCounts.get(planeKey) ?? 1,
    position: cloneVector(edge.midpoint),
    bend: cloneVector(edge.bend),
    frame: {
      id: frame.id,
      origin: cloneVector(frame.origin),
      tangent: cloneVector(frame.tangent),
      u: cloneVector(frame.u),
      v: cloneVector(frame.v),
    },
    mass: 1,
    pinned: false,
  };
}

function objectForceSources(record) {
  return [
    ...(Array.isArray(record?.forceSources) ? record.forceSources : []),
    ...(Array.isArray(record?.layout?.forceSources)
      ? record.layout.forceSources
      : []),
  ].map((source, index) => ({
    ...clonePlain(source),
    objectId: source.objectId ?? record.id,
    id: source.id ?? `${record.id}:force-source-${index + 1}`,
  }));
}

function sourceBackedLatexSnippet(payload) {
  if (payload?.type !== PAYLOAD_TYPES.LATEX) {
    return false;
  }
  if ((payload.documentKind ?? "snippet") !== "snippet") {
    return false;
  }
  const text = String(payload.text ?? "");
  return (
    // Accept source annotations with an optional document label for old saves.
    /^[ \t]*%[ \t]*(?:[^\r\n:]+[ \t]+)?source[ \t]*:/im.test(text) ||
    Boolean(payload.latexUrl || payload.pdfUrl)
  );
}

function semanticLayoutWeight(payload) {
  return sourceBackedLatexSnippet(payload) ? 2 : 1;
}

export function extractForceLayoutGraph(
  store,
  {
    edgeStrength = 0.018,
    defaultRestLength = null,
    includeHigherConstraints = true,
  } = {},
) {
  const nodeVertices = [...store.spheres.values()].map((sphere) => {
    const payload = store.payloads?.get?.(sphere.id) ?? null;
    const layoutWeight = semanticLayoutWeight(payload);
    return {
      id: sphere.id,
      name: sphere.name ?? "",
      objectId: sphere.id,
      layoutKind: "node",
      position: cloneVector(sphere.position),
      mass: layoutWeight,
      chargeScale: layoutWeight,
      centerScale: layoutWeight,
      semanticLayoutWeight: layoutWeight,
      semanticLayoutKind:
        layoutWeight > 1 ? "source-backed-latex-snippet" : "ordinary",
      pinned: false,
    };
  });
  const edgeRecords = [...store.edges.values()];
  const planeCohortCounts = edgePlaneCohortCounts(edgeRecords);
  const surfaceRecords = [...store.surfaces.values()];
  const faceCountsByEdge = twoSimplexFaceCounts(surfaceRecords);
  const edgeControls = edgeRecords
    .map((edge) => edgeControlVertex(store, edge, planeCohortCounts))
    .filter(Boolean);
  const vertices = [...nodeVertices, ...edgeControls];
  const vertexIds = new Set(vertices.map((vertex) => vertex.id));
  const edges = edgeRecords
    .filter((edge) => vertexIds.has(edge.sourceId) && vertexIds.has(edge.targetId))
    .map((edge) => {
      const source = store.spheres.get(edge.sourceId);
      const target = store.spheres.get(edge.targetId);
      return {
        id: edge.id,
        sourceId: edge.sourceId,
        targetId: edge.targetId,
        restLength: edgeRestLength(source, target, defaultRestLength),
        strength: edgeStrength,
        twoSimplexFaceCounts: [...(faceCountsByEdge.get(edge.id) ?? [0, 0, 0])],
      };
    });

  const higherConstraints = includeHigherConstraints
    ? surfaceRecords.map((surface) => ({
        id: surface.id,
        type: surface.type,
        edgeIds: [...surface.edgeIds],
        nodeIds: surface.nodeIds ? [...surface.nodeIds] : null,
        strength: 0.004,
      }))
    : [];
  const forceSources = [...store.objects.values()].flatMap(objectForceSources);

  return {
    format: FORCE_LAYOUT_GRAPH_FORMAT,
    version: FORCE_LAYOUT_GRAPH_VERSION,
    gologId: store.gologId,
    structure: store.structure ? { ...store.structure } : null,
    vertices,
    edges,
    higherConstraints,
    forceSources,
    nodeIds: nodeVertices.map((vertex) => vertex.id),
    edgeControlIds: edgeControls.map((vertex) => vertex.id),
    edgeControls,
  };
}
