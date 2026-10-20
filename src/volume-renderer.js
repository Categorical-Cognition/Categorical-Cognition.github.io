import * as THREE from "three";
import { createVolumeGeometry, createVolumeGeometryTemplate, updateVolumeGeometry, volumeGeometryTopologyKey } from "./volume-geometry-service.js";

function geometryKey(projection) {
  // Face identities also determine the resident layout stencils.
  return JSON.stringify([projection.missingFaceIds ?? [], (projection.boundarySurfaces ?? []).map((face) =>
    [face?.faceId, Array.isArray(face?.patches) ? face.patches.map((patch) => patch?.triangleControlNet ? { triangleControlNet: patch.triangleControlNet }
      : patch?.controlNet ? { controlNet: patch.controlNet }
        : { start: patch?.start, end: patch?.end, firstControl: patch?.firstControl,
          secondControl: patch?.secondControl, centerPoint: patch?.centerPoint }) : face?.patches])],
  (_key, value) => typeof value === "number" && !Number.isFinite(value) ? String(value) : value);
}

export class VolumeRenderer {
  constructor({ scene, onStatus = () => {}, interactive = true }) {
    this.scene = scene;
    this.onStatus = onStatus;
    this.interactive = interactive;
    this.graphics = new Map();
    this.diagnostics = new Map();
    this.geometryCache = new Map();
    this.geometryBuildCount = this.geometryCacheHitCount = 0;
    this.geometryUpdateCount = 0;
    this.selectedId = null;
    this.resourceVersion = 0;
  }

  upsert(projection) {
    if (!projection) return null;
    const structure = volumeGeometryTopologyKey(projection), coordinates = geometryKey(projection);
    const key = structure === null ? coordinates : `template:${structure}`;
    let cached = this.geometryCache.get(key);
    if (cached) this.geometryCacheHitCount++;
    else {
      const template = structure === null ? null : createVolumeGeometryTemplate(projection);
      cached = { template, result: template ? null : createVolumeGeometry(projection), references: 0 };
      this.geometryCache.set(key, cached); this.geometryBuildCount++;
    }
    if (cached.template && cached.coordinates !== coordinates) {
      cached.result = updateVolumeGeometry(cached.template, projection);
      cached.coordinates = coordinates;
      this.geometryUpdateCount++;
    }
    cached.references++;
    const previous = this.graphics.get(projection.id);
    const previousGeometry = previous?.mesh?.geometry;
    const result = cached.result;
    const { geometry, ...status } = result;
    if (status.centroid) status.centroid = status.centroid.clone();
    if (status.missingFaceIds) status.missingFaceIds = [...status.missingFaceIds];
    this.diagnostics.set(projection.id, status);
    this.onStatus({ id: projection.id, ...status });
    let mesh = previous?.mesh ?? null;
    const retainedGeometry = geometry ?? cached.template?.geometry;
    if (retainedGeometry) {
      mesh ??= new THREE.Mesh(retainedGeometry, new THREE.MeshBasicMaterial({
        color: projection.render.color,
        transparent: true,
        opacity: projection.render.opacity,
        depthWrite: false,
        side: THREE.DoubleSide,
      }));
      mesh.geometry = retainedGeometry;
      // Invalid deformations hide the shell without discarding its fixed GPU
      // sampling operator. The selection handle remains independently visible.
      mesh.userData.layoutCpuVisible = result.ok;
      mesh.visible = mesh.userData.layoutResidentShell || result.ok;
      mesh.name = projection.id;
      mesh.userData.objectId = projection.id;
      mesh.userData.volumeId = projection.id;
      mesh.userData.geometrySource = result.verification;
      mesh.userData.nonInteractive = !this.interactive;
      if (!mesh.parent) this.scene.add(mesh);
      mesh.updateMatrixWorld(true);
    } else if (mesh) {
      mesh.removeFromParent(); mesh.material.dispose(); mesh = null;
    }
    const handle = previous?.handle ?? new THREE.Mesh(
      new THREE.SphereGeometry(projection.render.pickRadius, 16, 10),
      new THREE.MeshBasicMaterial({ color: projection.render.color }),
    );
    if (previous && previous.render.pickRadius !== projection.render.pickRadius) {
      handle.geometry.dispose();
      handle.geometry = new THREE.SphereGeometry(projection.render.pickRadius, 16, 10);
    }
    handle.name = `${projection.id}-volume-selection-handle`;
    handle.userData.objectId = projection.id;
    handle.userData.volumeId = projection.id;
    handle.userData.nonInteractive = !this.interactive;
    handle.visible = this.interactive;
    // The semantic region remains selectable even when its sampled shell cannot
    // render. Its label and handle share the boundary-derived anchor, not the
    // solid centroid, and do not introduce a deformation coordinate.
    handle.position.copy(projection.origin ?? result.centroid ?? new THREE.Vector3());
    if (!handle.parent) this.scene.add(handle);
    const entry = { ...projection, mesh, handle, geometryKey: key,
      centroid: result.centroid?.clone() ?? null, volume: result.volume ?? null };
    this.graphics.set(projection.id, entry);
    if (!previous || previous.mesh !== mesh || previousGeometry !== retainedGeometry) this.resourceVersion++;
    if (previous) this.releaseGeometry(previous.geometryKey);
    handle.updateMatrixWorld(true);
    this.updateEntryStyle(projection.id);
    return entry;
  }

  updateEntryStyle(id) {
    const entry = this.graphics.get(id);
    if (!entry) return;
    const selected = id === this.selectedId;
    const color = selected ? entry.render.selectedColor : entry.render.color;
    if (entry.mesh) {
      entry.mesh.material.color.set(color);
      entry.mesh.material.opacity = selected ? entry.render.selectedOpacity : entry.render.opacity;
    }
    entry.handle.material.color.set(color);
    entry.handle.scale.setScalar(selected ? 1.3 : 1);
  }

  updateSelection(id) {
    if (id === this.selectedId) return;
    const previous = this.selectedId;
    this.selectedId = id;
    this.updateEntryStyle(previous);
    this.updateEntryStyle(id);
  }

  pickMeshes() {
    return this.interactive ? [...this.graphics.values()].map((entry) => entry.handle) : [];
  }

  remove(id, { preserveDiagnostic = false } = {}) {
    const entry = this.graphics.get(id);
    if (entry) {
      for (const object of [entry.mesh, entry.handle]) {
        if (!object) continue;
        object.removeFromParent();
        if (object === entry.handle) object.geometry.dispose();
        object.material.dispose();
      }
      this.releaseGeometry(entry.geometryKey);
      this.graphics.delete(id);
      this.resourceVersion++;
    }
    if (!preserveDiagnostic) this.diagnostics.delete(id);
    return Boolean(entry);
  }

  releaseGeometry(key) {
    const cached = this.geometryCache.get(key);
    if (cached && --cached.references === 0) {
      (cached.template?.geometry ?? cached.result.geometry)?.dispose();
      this.geometryCache.delete(key);
    }
  }

  dispose() {
    for (const id of this.graphics.keys()) this.remove(id);
    this.diagnostics.clear();
  }
}
