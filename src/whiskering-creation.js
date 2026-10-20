import { inferWhiskeringBoundary } from "./whiskering-boundary-inference.js";
import { DomainEventsAdapter } from "./domain-events-adapter.js";
import { presheafFromElements, withCompletedThetaElements } from "./golog-presheaf.js";
import { hierarchicalThetaElementsFromCells } from "./hierarchical-theta-space-definition.js";
import { CORE_THETA_STRUCTURE_ID, schemaRefForElementKind } from "./mathematical-schema-registry.js";

function sameValue(left, right) {
  const canonical = (value) => JSON.stringify(value, (_key, entry) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(Object.keys(entry).sort().map((key) => [key, entry[key]])) : entry);
  return canonical(left) === canonical(right);
}

function boundaryElements(presheaf, roots) {
  const records = new Map();
  const visit = (id) => {
    if (records.has(id)) return;
    const element = presheaf.get(id);
    records.set(id, { id, shape: element.shape,
      faces: Object.fromEntries(Object.entries(element.faces).sort(([a], [b]) => a.localeCompare(b))) });
    Object.values(element.faces).forEach(visit);
  };
  roots.forEach(visit);
  return [...records.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function requireId(value) {
  if (typeof value !== "string" || !value) throw new Error("Whiskering ids must be nonempty strings");
  return value;
}

function assertPreparedBoundary(store, plan, roots) {
  // Async commits recheck their own live records, including unsynchronized edits.
  // This closure is small and does not invalidate the store's topology cache.
  const selected = (collection) => plan.boundary.flatMap(({ id }) =>
    store[collection].has(id) ? [store[collection].get(id)] : []);
  try {
    const current = presheafFromElements(CORE_THETA_STRUCTURE_ID, hierarchicalThetaElementsFromCells({
      zero: selected("spheres"), one: selected("edges"), two: selected("surfaces"),
    }));
    if (sameValue(plan.boundary, boundaryElements(current, roots))) return;
  } catch { /* A malformed or missing live face also invalidates the prepared boundary. */ }
  throw new Error("Whiskering boundary changed after preparation");
}

// Normalize and validate the whole witness before claims, id reservation or writes.
export function prepareWhiskeringPayload(store, payload = {}) {
  if ((store.structure?.id ?? CORE_THETA_STRUCTURE_ID) !== CORE_THETA_STRUCTURE_ID) {
    throw new Error("Whiskering requires a hierarchical theta space");
  }
  const { inputId, edgeId, outputId } = payload;
  [inputId, edgeId, outputId].forEach(requireId);
  if (payload.plan) assertPreparedBoundary(store, payload.plan, [inputId, edgeId, outputId]);
  const presheaf = store.getPresheaf();
  const inferred = inferWhiskeringBoundary(presheaf, { inputId, edgeId, outputId });
  if (inferred.status !== "matched") {
    throw new Error(`Whiskering boundary is ${inferred.status}: ${inferred.reason}`);
  }
  const id = requireId(payload.id ?? `volume-${store.nextVolumeId}`);
  const sourceTriangleId = requireId(payload.sourceTriangleId ?? `two-simplex-${store.nextSurfaceId}`);
  const targetTriangleId = requireId(payload.targetTriangleId ?? `two-simplex-${store.nextSurfaceId + 1}`);
  const generatedIds = [sourceTriangleId, targetTriangleId, id,
    store.surfaceControlHandleId(sourceTriangleId), store.surfaceControlHandleId(targetTriangleId)];
  if (new Set(generatedIds).size !== generatedIds.length) {
    throw new Error("Whiskering generated ids must be distinct");
  }
  const match = inferred.match;
  const triangles = match.triangles.map((triangle) => ({ ...triangle,
    edgeIds: [...triangle.edgeIds], id: triangle.role === "source" ? sourceTriangleId : targetTriangleId }));
  const faces = { ...match.faces, ...Object.fromEntries(triangles.map((triangle) => [triangle.faceId, triangle.id])) };
  const boundary = boundaryElements(presheaf, [inputId, edgeId, outputId]);
  const plan = { shapeId: match.shapeId, faces, triangles, boundary };
  if (payload.plan && !sameValue(payload.plan, plan)) {
    throw new Error("Whiskering boundary changed after preparation");
  }
  const present = generatedIds.filter((objectId) => store.objects.has(objectId));
  if (present.length) {
    const region = store.volumes.get(id);
    const exact = present.length === generatedIds.length &&
      region?.schemaRef.objectId === match.shapeId && sameValue(region.faces, faces) &&
      triangles.every((triangle) => {
        const existing = store.surfaces.get(triangle.id);
        return existing?.elementKind === "2-simplex" && sameValue(existing.edgeIds, triangle.edgeIds);
      });
    if (!exact) throw new Error("Whiskering element id already exists or witness is incomplete");
  } else {
    const mathematicalIds = new Set(presheaf.toJSON().elements.map((element) => element.id));
    if (generatedIds.some((objectId) => mathematicalIds.has(objectId))) {
      throw new Error("Whiskering element id already names a restriction term");
    }
    for (const triangle of triangles) {
      if (!store.resolveComposableEdgeTriple(triangle.edgeIds)) {
        throw new Error("Whiskering triangle is not a supported composable boundary");
      }
    }
    withCompletedThetaElements(presheaf, [
      ...triangles.map((triangle) => ({ id: triangle.id, shape: schemaRefForElementKind("2-simplex").objectId, faces: {
        "theta3:face:9": triangle.edgeIds[1], "theta3:face:10": triangle.edgeIds[2],
        "theta3:face:11": triangle.edgeIds[0],
      } })),
      { id, shape: match.shapeId, faces },
    ]);
  }
  return { inputId, edgeId, outputId, id, sourceTriangleId, targetTriangleId, plan };
}

export function whiskeringObjectIds(payload) {
  return [payload.id, payload.sourceTriangleId, payload.targetTriangleId,
    ...payload.plan.boundary.map((element) => element.id)];
}

export function createWhiskering(store, payload, operation = {}) {
  const prepared = prepareWhiskeringPayload(store, payload);
  if (store.volumes.has(prepared.id)) return prepared.id;
  const lockIds = prepared.plan.boundary.flatMap(({ id }) => store.getLockScopeForObject(id));
  if (!store.canMutateObjects(lockIds, operation.origin, "whiskering:create")) return false;

  // Native constructors are synchronous. Stage only their owned maps and events,
  // then publish the completed witness without exposing half-created boundaries.
  const staged = Object.create(store);
  for (const key of ["surfaces", "volumes", "objects"]) staged[key] = new Map(store[key]);
  const events = [];
  staged.events = new DomainEventsAdapter({ emit: (type, data) => {
    if (!type.endsWith("-selected")) events.push({ type, data });
  } });
  staged.emitStateChanged = () => {};
  for (const triangle of prepared.plan.triangles) {
    if (!staged.createElement({ elementKind: "2-simplex", id: triangle.id, edgeIds: triangle.edgeIds })) {
      throw new Error("Whiskering triangle creation failed");
    }
  }
  const volumeId = staged.createElement({ elementKind: "theta-volume", id: prepared.id,
    shapeId: prepared.plan.shapeId, faces: prepared.plan.faces });
  if (volumeId !== prepared.id) throw new Error("Whiskering region creation failed");
  for (const key of ["surfaces", "volumes", "objects"]) {
    for (const [id, value] of staged[key]) if (!store[key].has(id)) store[key].set(id, value);
  }
  store.nextSurfaceId = staged.nextSurfaceId;
  store.nextVolumeId = staged.nextVolumeId;
  store.selectedSphereId = null;
  store.selectedSimplexId = prepared.id;
  for (const { type, data } of events) store.events.emit(type, data);
  store.emitStateChanged();
  store.events.selectVolume(prepared.id);
  return prepared.id;
}
