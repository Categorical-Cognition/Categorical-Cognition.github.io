import * as THREE from "three";
import { createVolumeGeometry } from "./volume-geometry-service.js";

export class VolumeRenderer {
  constructor({ scene, onStatus = () => {}, interactive = true }) {
    this.scene = scene;
    this.onStatus = onStatus;
    this.interactive = interactive;
    this.graphics = new Map();
    this.diagnostics = new Map();
    this.selectedId = null;
  }

  upsert(projection) {
    if (!projection) return null;
    this.remove(projection.id, { preserveDiagnostic: true });
    const result = createVolumeGeometry(projection);
    const { geometry, ...status } = result;
    this.diagnostics.set(projection.id, status);
    this.onStatus({ id: projection.id, ...status });
    if (!result.ok) return null;
    const material = new THREE.MeshBasicMaterial({
      color: projection.render.color,
      transparent: true,
      opacity: projection.render.opacity,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = projection.id;
    mesh.userData.objectId = projection.id;
    mesh.userData.volumeId = projection.id;
    mesh.userData.geometrySource = result.verification;
    mesh.userData.nonInteractive = !this.interactive;
    const handle = new THREE.Mesh(
      new THREE.SphereGeometry(projection.render.pickRadius, 16, 10),
      new THREE.MeshBasicMaterial({ color: projection.render.color }),
    );
    handle.name = `${projection.id}-volume-selection-handle`;
    handle.userData.objectId = projection.id;
    handle.userData.volumeId = projection.id;
    handle.userData.nonInteractive = !this.interactive;
    handle.visible = this.interactive;
    handle.position.copy(result.centroid);
    this.scene.add(mesh, handle);
    const entry = { ...projection, mesh, handle, centroid: result.centroid, volume: result.volume };
    this.graphics.set(projection.id, entry);
    mesh.updateMatrixWorld(true);
    handle.updateMatrixWorld(true);
    this.updateSelection(this.selectedId);
    return entry;
  }

  updateSelection(id) {
    this.selectedId = id;
    for (const [volumeId, entry] of this.graphics) {
      const selected = id === volumeId;
      entry.mesh.material.color.set(selected ? entry.render.selectedColor : entry.render.color);
      entry.mesh.material.opacity = selected ? entry.render.selectedOpacity : entry.render.opacity;
      entry.handle.material.color.copy(entry.mesh.material.color);
      entry.handle.scale.setScalar(selected ? 1.3 : 1);
    }
  }

  pickMeshes() {
    return [...this.graphics.values()].map((entry) => entry.handle);
  }

  remove(id, { preserveDiagnostic = false } = {}) {
    const entry = this.graphics.get(id);
    if (entry) {
      for (const object of [entry.mesh, entry.handle]) {
        object.removeFromParent();
        object.geometry.dispose();
        object.material.dispose();
      }
      this.graphics.delete(id);
    }
    if (!preserveDiagnostic) this.diagnostics.delete(id);
    return Boolean(entry);
  }

  dispose() {
    for (const id of this.graphics.keys()) this.remove(id);
    this.diagnostics.clear();
  }
}
