import * as THREE from "three";
import { DEFAULT_MATH_SCHEMA_REGISTRY, CORE_THETA_SCHEMA_ID,
  CORE_THETA_STRUCTURE_ID, schemaRefForElementKind } from "./mathematical-schema-registry.js";
import { createObjectLabel } from "./domain-object-definitions.js";
import { withCompletedThetaElements } from "./golog-presheaf.js";

export const THETA_VOLUME_KIND = "theta-volume";

export function thetaVolumeGraphicalBoundary(shapeId) {
  const schema = DEFAULT_MATH_SCHEMA_REGISTRY.schema(CORE_THETA_SCHEMA_ID);
  const shape = schema.objects.find((entry) => entry.id === shapeId);
  return shape?.graphics.graphicalBoundary ?? shape?.boundary ?? [];
}

export function thetaVolumeSchemaRef(payload = {}) {
  const objectId = payload.schemaRef?.objectId ?? payload.shapeId ??
    (payload.thetaIndex != null ? `theta3:o${payload.thetaIndex}` : null);
  const ref = schemaRefForElementKind(THETA_VOLUME_KIND, objectId);
  if (!ref || ["schemaId", "structureId", "objectId", "elementKind"].some(
    (key) => payload.schemaRef?.[key] != null && payload.schemaRef[key] !== ref[key],
  )) throw new Error("Theta volume requires a matching schema reference for a volume shape");
  return ref;
}

export function serializeThetaVolume(volume) {
  return { id: volume.id, name: volume.name, elementKind: THETA_VOLUME_KIND,
    schemaRef: { ...volume.schemaRef }, dimension: 3,
    boundary: { faces: { ...volume.faces } },
    ...(volume.render ? { render: { ...volume.render } } : {}) };
}

export function syncThetaVolumeObject(store, volume) {
  const origin = new THREE.Vector3();
  const positions = volume.boundaryFaceIds.map((id) => store.objects.get(id)?.origin).filter(Boolean);
  for (const position of positions) origin.add(position);
  if (positions.length) origin.multiplyScalar(1 / positions.length);
  store.upsertObject({ ...volume, kind: "volume", dimension: 3, lockable: true,
    origin, label: createObjectLabel(volume.name, origin, { size: 0.5 }),
    render: { color: 0x9ba9ff, opacity: 0.2, ...(volume.render ?? {}) } });
}

export function validateThetaVolumeElement(store, payload = {}) {
  if ((store.structure?.id ?? CORE_THETA_STRUCTURE_ID) !== CORE_THETA_STRUCTURE_ID) {
    throw new Error("Theta volumes require a hierarchical theta space");
  }
  const schemaRef = thetaVolumeSchemaRef(payload);
  const id = payload.id ?? `volume-${store.nextVolumeId}`;
  const faces = { ...(payload.faces ?? payload.boundary?.faces ?? {}) };
  if (typeof id !== "string" || !id) throw new Error("Volume id must be a nonempty string");
  if (store.objects.has(id)) {
    const existing = store.volumes.get(id);
    const sameFaces = existing && Object.keys(faces).length === Object.keys(existing.faces).length &&
      Object.entries(faces).every(([key, value]) => existing.faces[key] === value);
    if (existing?.schemaRef.objectId === schemaRef.objectId && sameFaces &&
      (payload.name == null || existing.name === String(payload.name)) &&
      (payload.render == null || JSON.stringify(existing.render) === JSON.stringify(payload.render))) {
      return { id, schemaRef, faces, existing: true };
    }
    throw new Error(`Element id already exists: ${id}`);
  }
  // Validate the exact restriction action before reserving ids or changing state.
  for (const faceId of Object.values(faces)) {
    if (!store.hasSelectableSimplex(faceId)) throw new Error(`Invalid restriction: missing stored face ${faceId}`);
  }
  withCompletedThetaElements(store.getPresheaf(), [{ id, shape: schemaRef.objectId, faces }]);
  return { id, schemaRef, faces, existing: false };
}

export function createThetaVolumeElement(store, payload = {}) {
  const { id, schemaRef, faces, existing } = validateThetaVolumeElement(store, payload);
  if (existing) return id;
  const boundaryFaceIds = [...new Set(thetaVolumeGraphicalBoundary(schemaRef.objectId)
    .filter((face) => store.surfaces.has(faces[face.id]))
    .map((face) => faces[face.id]))];
  const volume = { id, name: String(payload.name ?? ""), elementKind: THETA_VOLUME_KIND,
    schemaRef, faces, boundaryFaceIds,
    ...(payload.render ? { render: { ...payload.render } } : {}) };
  store.reserveNumericId(id, "volume-", "nextVolumeId");
  store.volumes.set(id, volume);
  syncThetaVolumeObject(store, volume);
  store.selectedSphereId = null;
  store.selectedSimplexId = id;
  store.emitStateChanged();
  store.events.sphereSelected(null);
  store.events.edgeSelected(null);
  store.events.surfaceSelected(null);
  store.events.volumeCreated(store.getObject(id));
  store.events.volumeSelected(id);
  return id;
}
