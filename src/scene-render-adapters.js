import * as THREE from "three";
import {
  createLabelSprite,
  disposeLabelSprite,
  positionLabelSprite,
  updateLabelSprite,
} from "./label-sprites.js";
import {
  projectEdgeBatchRecord,
  projectEdgeHandleMesh,
  projectObjectLabel,
  projectSelectionStyle,
  projectSphereMesh,
  projectSurfaceBatchRecords,
  projectSurfaceControlMesh,
  projectVolumeRecord,
} from "./object-projector.js";
import { VolumeRenderer } from "./volume-renderer.js";

const LABEL_RENDER_ORDER_BASE = 10_000;

function emptyRenderProfile() {
  return {};
}

function renderScale(getRenderProfile, key) {
  return getRenderProfile?.()?.[key] ?? {};
}

function projectionSource(state, id) {
  // Projectors copy their outputs. Read the replaced domain record directly
  // instead of cloning it again before projection.
  return state.objects ? state.objects.get(id) ?? null : state.getObject(id);
}

export class SphereRenderAdapter {
  constructor({ scene, state, getRenderProfile = emptyRenderProfile }) {
    this.scene = scene;
    this.state = state;
    this.getRenderProfile = getRenderProfile;
    this.meshes = new Map();
    this.resourceVersion = 0;
  }

  add(id, position) {
    const existing = this.meshes.get(id);
    if (existing) {
      this.move(id, position);
      this.updateSelection(this.state.selectedSphereId);
      return existing;
    }

    const projection = projectSphereMesh(this.state.getObject(id), {
      position,
      renderScale: renderScale(this.getRenderProfile, "sphere"),
    });
    if (!projection) {
      return null;
    }

    const geometry = new THREE.SphereGeometry(projection.radius, 32, 20);
    const material = new THREE.MeshStandardMaterial({
      color: projection.color,
      roughness: 0.48,
      metalness: 0.08,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = projection.name;
    mesh.userData.objectId = projection.id;
    mesh.userData.sphereId = projection.id;
    mesh.position.copy(projection.position);
    this.scene.add(mesh);
    this.meshes.set(projection.id, mesh);
    this.resourceVersion++;
    mesh.updateMatrixWorld(true);
    this.updateSelection(projection.id);
    return mesh;
  }

  move(id, position) {
    const mesh = this.meshes.get(id);
    if (!mesh) {
      return false;
    }

    mesh.position.copy(position);
    mesh.updateMatrixWorld(true);
    return true;
  }

  updateSelection(selectedId) {
    for (const [id, mesh] of this.meshes.entries()) {
      const style = projectSelectionStyle(this.state.getObject(id), {
        selected: id === selectedId,
        renderScale: renderScale(this.getRenderProfile, "sphere"),
      });
      mesh.material.color.set(style.color);
      mesh.scale.setScalar(style.scale);
    }
  }

  get(id) {
    return this.meshes.get(id) ?? null;
  }

  dispose() {
    for (const mesh of this.meshes.values()) {
      this.scene.remove(mesh);
      disposeObject3D(mesh);
    }
    this.meshes.clear();
    this.resourceVersion++;
  }
}

export class LabelRenderAdapter {
  constructor({ scene }) {
    this.scene = scene;
    this.labels = new Map();
    this.visible = true;
    this.visibleIds = null;
    this.orderPositions = new Map();
    this.orderCamera = new THREE.Vector3(NaN, NaN, NaN);
    this.resourceVersion = 0;
  }

  labelShouldBeVisible(label) {
    return (
      this.visible &&
      Boolean(label.userData.labelText) &&
      (!this.visibleIds || this.visibleIds.has(label.userData.objectId))
    );
  }

  applyLabelVisibility(label) {
    label.visible = this.labelShouldBeVisible(label);
  }

  sync(record) {
    const projection = projectObjectLabel(record);
    const label = this.labels.get(record.id);
    if (!projection) {
      this.remove(record.id);
      return;
    }

    if (!label) {
      this.add(projection);
      return;
    }

    updateLabelSprite(label, projection.text, projection.size);
    this.resourceVersion++;
    positionLabelSprite(label, projection.anchor);
    this.applyLabelVisibility(label);
  }

  add(projection) {
    const label = createLabelSprite(projection.text, projection.size);
    label.name = projection.name;
    label.userData.objectId = projection.id;
    label.userData.kind = projection.kind;
    positionLabelSprite(label, projection.anchor);
    this.applyLabelVisibility(label);
    this.scene.add(label);
    this.labels.set(projection.id, label);
    this.resourceVersion++;
  }

  remove(id) {
    const label = this.labels.get(id);
    if (!label) {
      return;
    }
    this.scene.remove(label);
    disposeLabelSprite(label);
    this.labels.delete(id);
    this.resourceVersion++;
  }

  setVisible(visible) {
    this.visible = visible;
    for (const label of this.labels.values()) {
      this.applyLabelVisibility(label);
    }
  }

  setVisibleIds(ids = null) {
    const next = ids ? new Set(ids) : null;
    if (next === this.visibleIds || (next && this.visibleIds && next.size === this.visibleIds.size
      && [...next].every((id) => this.visibleIds.has(id)))) return;
    this.visibleIds = next;
    for (const label of this.labels.values()) {
      this.applyLabelVisibility(label);
    }
  }

  updateRenderOrder(cameraPosition) {
    const labelPosition = new THREE.Vector3();
    const labels = [...this.labels.values()].filter((label) => label.visible);
    let changed = !this.orderCamera.equals(cameraPosition) || labels.length !== this.orderPositions.size;
    const distances = new Map();
    for (const label of labels) {
      label.getWorldPosition(labelPosition);
      const previous = this.orderPositions.get(label);
      if (!previous?.equals(labelPosition)) changed = true;
      distances.set(label, labelPosition.distanceToSquared(cameraPosition));
      if (previous) previous.copy(labelPosition);
      else this.orderPositions.set(label, labelPosition.clone());
    }
    if (!changed) return;
    this.orderCamera.copy(cameraPosition);
    for (const label of this.orderPositions.keys()) if (!distances.has(label)) this.orderPositions.delete(label);
    labels.sort((first, second) => distances.get(second) - distances.get(first));
    labels.forEach((label, index) => { label.renderOrder = LABEL_RENDER_ORDER_BASE + index; });
  }

  dispose() {
    for (const id of [...this.labels.keys()]) {
      this.remove(id);
    }
    this.orderPositions.clear();
  }
}

export class EdgeRenderAdapter {
  constructor({ scene, state, batchRenderer, getRenderProfile = emptyRenderProfile }) {
    this.scene = scene;
    this.state = state;
    this.batchRenderer = batchRenderer;
    this.getRenderProfile = getRenderProfile;
    this.graphics = new Map();
    this.captureIds = new Set();
  }

  add(edge) {
    if (this.graphics.has(edge.id)) {
      this.updatePayload(edge);
      return this.graphics.get(edge.id);
    }

    const cone = this.createCone(edge.id);
    const conePick = this.createConePick(edge.id);
    if (!cone || !conePick) {
      return null;
    }

    this.scene.add(cone);
    this.scene.add(conePick);
    this.graphics.set(edge.id, {
      ...edge,
      bend: edge.bend?.clone(),
      midpoint: edge.midpoint.clone(),
      cone,
      conePick,
    });
    this.update(edge.id);
    return this.graphics.get(edge.id);
  }

  createCone(edgeId) {
    const projection = this.projectHandle(edgeId);
    if (!projection) {
      return null;
    }

    const geometry = new THREE.ConeGeometry(
      projection.radius,
      projection.height,
      24,
    );
    const material = new THREE.MeshStandardMaterial({
      color: projection.color,
      roughness: 0.52,
      metalness: 0.04,
    });
    const cone = new THREE.Mesh(geometry, material);
    cone.name = projection.name;
    cone.userData.objectId = projection.id;
    cone.userData.edgeId = projection.edgeId;
    return cone;
  }

  createConePick(edgeId) {
    const projection = this.projectHandle(edgeId);
    if (!projection) {
      return null;
    }

    const geometry = new THREE.SphereGeometry(projection.pickRadius, 16, 10);
    const material = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const pickMesh = new THREE.Mesh(geometry, material);
    pickMesh.name = `${projection.edgeId}-midpoint-cone-pick-volume`;
    pickMesh.userData.objectId = projection.id;
    pickMesh.userData.edgeId = projection.edgeId;
    pickMesh.visible = false;
    return pickMesh;
  }

  updatePayload({ id, midpoint, bend, frameId }) {
    const edge = this.graphics.get(id);
    if (!edge) {
      return;
    }
    edge.midpoint.copy(midpoint);
    if (bend) {
      edge.bend = bend.clone();
    }
    if (frameId) {
      edge.frameId = frameId;
    }
    this.update(id);
  }

  update(edgeId) {
    const edge = this.graphics.get(edgeId);
    const projection = projectEdgeBatchRecord(projectionSource(this.state, edgeId), {
      renderScale: renderScale(this.getRenderProfile, "edge"),
    });
    if (!edge || !projection) {
      return;
    }

    edge.midpoint.copy(projection.midpoint);
    edge.control = projection.control.clone();
    this.batchRenderer.upsertEdge(projection);
    edge.cone.position.copy(projection.midpoint);
    edge.conePick.position.copy(projection.midpoint);
    alignConeToEdge(edge.cone, projection.start, projection.end);
    edge.cone.updateMatrixWorld(true);
    edge.conePick.updateMatrixWorld(true);
  }

  updateSelection(selectedEdgeId) {
    for (const [edgeId, edge] of this.graphics.entries()) {
      const projection = this.projectHandle(edgeId);
      if (!projection) {
        continue;
      }

      edge.cone.material.color.set(
        this.captureIds.has(edgeId)
          ? 0x5eead4
          : edgeId === selectedEdgeId
            ? projection.selectedColor
            : projection.color,
      );
      edge.cone.scale.setScalar(
        this.captureIds.has(edgeId) || edgeId === selectedEdgeId ? 1.18 : 1,
      );
    }
  }

  updateCapture(edgeIds = []) {
    this.captureIds = new Set(edgeIds);
    this.updateSelection(this.state.selectedSimplexId);
  }

  remove(edgeId) {
    const edge = this.graphics.get(edgeId);
    if (!edge) {
      return false;
    }

    this.scene.remove(edge.cone);
    this.scene.remove(edge.conePick);
    disposeObject3D(edge.cone);
    disposeObject3D(edge.conePick);
    this.batchRenderer.removeEdge(edgeId);
    this.graphics.delete(edgeId);
    return true;
  }

  pickRadius(edgeId) {
    return this.projectHandle(edgeId)?.pickRadius ?? 0.24;
  }

  get(edgeId) {
    return this.graphics.get(edgeId) ?? null;
  }

  projectHandle(edgeId) {
    return projectEdgeHandleMesh(
      projectionSource(this.state, this.state.edgeBendHandleId(edgeId)),
      {
        renderScale: renderScale(this.getRenderProfile, "edgeHandle"),
      },
    );
  }

  dispose() {
    for (const edgeId of [...this.graphics.keys()]) {
      this.remove(edgeId);
    }
  }
}

export class SurfaceRenderAdapter {
  constructor({ scene, state, batchRenderer, getRenderProfile = emptyRenderProfile }) {
    this.scene = scene;
    this.state = state;
    this.batchRenderer = batchRenderer;
    this.getRenderProfile = getRenderProfile;
    this.graphics = new Map();
  }

  add(surface) {
    if (this.graphics.has(surface.id)) {
      this.update(surface.id, surface);
      return this.graphics.get(surface.id);
    }

    const control = this.createControl(surface.id);
    const controlPick = this.createControlPick(surface.id);
    if (!control || !controlPick) {
      return null;
    }

    this.scene.add(control);
    this.scene.add(controlPick);
    this.graphics.set(surface.id, {
      ...surface,
      controlPoint: surface.controlPoint.clone(),
      controlDirection: surface.controlDirection.clone(),
      control,
      controlPick,
      batchIds: [],
    });
    this.update(surface.id, surface);
    return this.graphics.get(surface.id);
  }

  createControl(surfaceId) {
    const projection = this.projectControl(surfaceId);
    if (!projection) {
      return null;
    }

    const geometry = createSurfaceControlGeometry(projection);
    const material = new THREE.MeshStandardMaterial({
      color: projection.color,
      roughness: 0.42,
      metalness: 0.03,
    });
    const control = new THREE.Mesh(geometry, material);
    control.name = projection.name;
    control.userData.objectId = projection.id;
    control.userData.surfaceId = projection.surfaceId;
    return control;
  }

  createControlPick(surfaceId) {
    const projection = this.projectControl(surfaceId);
    if (!projection) {
      return null;
    }

    const geometry = new THREE.SphereGeometry(projection.pickRadius, 16, 10);
    const material = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const pickMesh = new THREE.Mesh(geometry, material);
    pickMesh.name = `${projection.surfaceId}-control-pick-volume`;
    pickMesh.userData.objectId = projection.id;
    pickMesh.userData.surfaceId = projection.surfaceId;
    pickMesh.visible = false;
    return pickMesh;
  }

  update(surfaceId, payload = null) {
    const surface = this.graphics.get(surfaceId);
    if (!surface) {
      return;
    }

    if (payload?.controlPoint) {
      surface.controlPoint.copy(payload.controlPoint);
    }
    if (payload?.controlDirection) {
      surface.controlDirection.copy(payload.controlDirection);
    }
    if (payload?.controlCoordinate !== undefined) {
      surface.controlCoordinate = payload.controlCoordinate;
    }
    if (payload?.frameId) {
      surface.frameId = payload.frameId;
    }

    const record = projectionSource(this.state, surfaceId);
    const batchRecords = projectSurfaceBatchRecords(record);
    if (!record || batchRecords.length === 0) {
      return;
    }

    const nextBatchIds = new Set(batchRecords.map((entry) => entry.id));
    for (const batchId of surface.batchIds ?? []) {
      if (!nextBatchIds.has(batchId)) {
        this.batchRenderer.removeSurface(batchId);
      }
    }
    for (const batchRecord of batchRecords) {
      this.batchRenderer.upsertSurface(batchRecord);
    }
    surface.batchIds = [...nextBatchIds];
    const projection = this.projectControl(surfaceId, record);
    if (!projection) return;
    const geometryType = projection.direction ? "ConeGeometry" : "SphereGeometry";
    if (surface.control.geometry.type !== geometryType) {
      surface.control.geometry.dispose();
      surface.control.geometry = createSurfaceControlGeometry(projection);
    }
    surface.control.quaternion.identity();
    if (projection.direction) {
      surface.control.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 1, 0), projection.direction,
      );
    }
    surface.control.position.copy(projection.position);
    surface.controlPick.position.copy(projection.position);
    surface.control.updateMatrixWorld(true);
    surface.controlPick.updateMatrixWorld(true);
  }

  updateSelection(selectedSurfaceId) {
    for (const [surfaceId, surface] of this.graphics.entries()) {
      const projection = this.projectControl(surfaceId);
      if (!projection) {
        continue;
      }

      surface.control.material.color.set(
        surfaceId === selectedSurfaceId
          ? projection.selectedColor
          : projection.color,
      );
      surface.control.scale.setScalar(surfaceId === selectedSurfaceId ? 1.2 : 1);
      surface.controlPick.scale.setScalar(
        surfaceId === selectedSurfaceId ? 1.2 : 1,
      );
    }
  }

  remove(surfaceId) {
    const surface = this.graphics.get(surfaceId);
    if (!surface) {
      return false;
    }

    this.scene.remove(surface.control);
    this.scene.remove(surface.controlPick);
    disposeObject3D(surface.control);
    disposeObject3D(surface.controlPick);
    for (const batchId of surface.batchIds?.length
      ? surface.batchIds
      : [surfaceId]) {
      this.batchRenderer.removeSurface(batchId);
    }
    this.graphics.delete(surfaceId);
    return true;
  }

  controls() {
    return [...this.graphics.values()].map((surface) => surface.controlPick);
  }

  get(surfaceId) {
    return this.graphics.get(surfaceId) ?? null;
  }

  projectControl(surfaceId, surface = projectionSource(this.state, surfaceId)) {
    return projectSurfaceControlMesh(
      projectionSource(this.state, this.state.surfaceControlHandleId(surfaceId)),
      {
        surface,
        renderScale: renderScale(this.getRenderProfile, "surfaceControl"),
      },
    );
  }

  dispose() {
    for (const surfaceId of [...this.graphics.keys()]) {
      this.remove(surfaceId);
    }
  }
}

export class VolumeRenderAdapter {
  constructor({ scene, state, onStatus }) {
    this.state = state;
    this.renderer = new VolumeRenderer({ scene, onStatus });
    this.graphics = this.renderer.graphics;
    this.diagnostics = this.renderer.diagnostics;
    this.projectionSignatures = new Map();
    this.projectionSources = new Map();
  }

  add(volume) { return this.update(volume.id); }

  update(id) {
    // Domain object records are replaced on upsert. Duplicate notifications can
    // reuse their projection without cloning every boundary control net again.
    if (this.state.objects) {
      const record = this.state.objects.get(id);
      const sources = [record, ...(record?.boundaryFaceIds ?? []).map((faceId) => this.state.objects.get(faceId))];
      const previous = this.projectionSources.get(id);
      if (previous?.length === sources.length && sources.every((source, index) => source === previous[index])) {
        return this.graphics.get(id) ?? null;
      }
      this.projectionSources.set(id, sources);
    }
    const projection = projectVolumeRecord(projectionSource(this.state, id), {
      getObject: (faceId) => projectionSource(this.state, faceId),
    });
    if (!projection) return this.remove(id);
    const signature = JSON.stringify(projection);
    if (this.projectionSignatures.get(id) === signature) return this.graphics.get(id) ?? null;
    this.projectionSignatures.set(id, signature);
    return this.renderer.upsert(projection);
  }

  updateDependingOn(faceId) {
    for (const volume of this.state.volumesForSurface(faceId)) this.update(volume.id);
  }

  updateSelection(id) { this.renderer.updateSelection(id); }
  controls() { return this.renderer.pickMeshes(); }
  remove(id) {
    this.projectionSignatures.delete(id);
    this.projectionSources.delete(id);
    return this.renderer.remove(id);
  }
  dispose() {
    this.projectionSignatures.clear();
    this.projectionSources.clear();
    this.renderer.dispose();
  }
}

function createSurfaceControlGeometry(projection) {
  return projection.direction
    ? new THREE.ConeGeometry(projection.radius, projection.height, 24)
    : new THREE.SphereGeometry(projection.radius, 18, 12);
}

function alignConeToEdge(cone, start, end) {
  const tangent = end.clone().sub(start).normalize();
  cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tangent);
}

function disposeObject3D(object) {
  object.traverse?.((child) => {
    child.geometry?.dispose?.();
    if (Array.isArray(child.material)) {
      child.material.forEach((material) => material.dispose?.());
    } else {
      child.material?.dispose?.();
    }
  });
}
