import * as THREE from "three";
import {
  evaluateBiquadraticBezierPatch,
  evaluateTriangularCubicBezierPatch,
  getBiquadraticInteriorControlForCenterPoint,
  getQuadraticControlPoint,
  squareToTriangularBarycentric,
} from "./geometry-utils.js";
import { projectVolumeRecord } from "./object-projector.js";
import { VolumeRenderer } from "./volume-renderer.js";

export const DEFAULT_NESTED_PREVIEW_CONTENT_RADIUS = 1.85;

export function disposeObject3D(object) {
  object.traverse?.((child) => {
    child.geometry?.dispose?.();
    const materials = Array.isArray(child.material)
      ? child.material
      : [child.material];
    for (const material of materials) {
      material?.dispose?.();
    }
  });
}

export class NestedGologContentRenderer {
  constructor({ contentRadius = DEFAULT_NESTED_PREVIEW_CONTENT_RADIUS } = {}) {
    this.contentRadius = contentRadius;
  }

  rebuildContent(content, childGolog) {
    for (const child of [...content.children]) {
      content.remove(child);
      disposeObject3D(child);
    }
    content.userData.volumeDiagnostics = {};

    if (!childGolog) {
      content.userData.gologContentTransform = {
        center: new THREE.Vector3(),
        scale: 1,
      };
      content.add(this.createEmptyMarker());
      return;
    }

    const snapshot = childGolog.state.snapshot();
    const objects = new Map(
      snapshot.objects.map((object) => [object.id, object]),
    );
    const points = snapshot.spheres.map((sphere) => sphere.position.clone());
    for (const edge of snapshot.edges) {
      points.push(edge.midpoint.clone());
    }
    for (const surface of snapshot.surfaces) {
      points.push(...this.surfacePoints(objects.get(surface.id)));
    }
    const transform = this.transformForPoints(points);
    content.userData.gologContentTransform = {
      center: transform.center.clone(),
      scale: transform.scale,
    };

    if (snapshot.volumes?.length) {
      const volumes = new THREE.Group();
      volumes.name = "nested-preview-volumes";
      volumes.userData.nonInteractive = true;
      volumes.position.copy(transform.center).multiplyScalar(-transform.scale);
      volumes.scale.setScalar(transform.scale);
      const renderer = new VolumeRenderer({
        scene: volumes,
        interactive: false,
        onStatus: ({ id, ...status }) => { content.userData.volumeDiagnostics[id] = status; },
      });
      for (const volume of snapshot.volumes) {
        renderer.upsert(projectVolumeRecord(objects.get(volume.id), {
          getObject: (id) => objects.get(id),
        }));
      }
      // The preview owns this group. Its existing recursive disposal releases
      // the shared renderer's meshes and materials on every rebuild or close.
      content.add(volumes);
    }

    for (const surface of snapshot.surfaces) {
      const surfaceMesh = this.createSurface(objects.get(surface.id), transform);
      if (surfaceMesh) {
        content.add(surfaceMesh);
      }
    }

    for (const edge of snapshot.edges) {
      const source = snapshot.spheres.find((sphere) => sphere.id === edge.sourceId);
      const target = snapshot.spheres.find((sphere) => sphere.id === edge.targetId);
      if (!source || !target) {
        continue;
      }
      content.add(this.createEdge(edge, source, target, transform));
    }

    for (const sphere of snapshot.spheres) {
      content.add(this.createSphere(sphere, transform));
    }
  }

  createEmptyMarker() {
    const group = new THREE.Group();
    group.userData.nonInteractive = true;

    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.46, 0.018, 8, 36),
      new THREE.MeshBasicMaterial({
        color: 0xd7e2ff,
        transparent: true,
        opacity: 0.72,
      }),
    );
    ring.userData.nonInteractive = true;
    group.add(ring);

    const horizontal = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-0.3, 0, 0),
      new THREE.Vector3(0.3, 0, 0),
    ]);
    const vertical = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, -0.3, 0),
      new THREE.Vector3(0, 0.3, 0),
    ]);
    const material = new THREE.LineBasicMaterial({
      color: 0xd7e2ff,
      transparent: true,
      opacity: 0.58,
    });
    group.add(new THREE.Line(horizontal, material));
    group.add(new THREE.Line(vertical, material.clone()));
    return group;
  }

  transformForPoints(points) {
    if (points.length === 0) {
      return {
        center: new THREE.Vector3(),
        scale: 1,
      };
    }

    const box = new THREE.Box3().setFromPoints(points);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxExtent = Math.max(size.x, size.y, size.z, 1);
    return {
      center,
      scale: (this.contentRadius * 2) / maxExtent,
    };
  }

  mapPoint(point, transform) {
    return point.clone().sub(transform.center).multiplyScalar(transform.scale);
  }

  createSphere(sphere, transform) {
    const geometry = new THREE.SphereGeometry(0.16, 18, 12);
    const material = new THREE.MeshStandardMaterial({
      color: 0xd7e2ff,
      roughness: 0.48,
      metalness: 0.05,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `${sphere.id}-nested-preview-sphere`;
    mesh.userData.nonInteractive = true;
    mesh.position.copy(this.mapPoint(sphere.position, transform));
    return mesh;
  }

  createEdge(edge, source, target, transform) {
    const control = getQuadraticControlPoint(
      source.position,
      edge.midpoint,
      target.position,
    );
    const curve = new THREE.QuadraticBezierCurve3(
      this.mapPoint(source.position, transform),
      this.mapPoint(control, transform),
      this.mapPoint(target.position, transform),
    );
    const geometry = new THREE.BufferGeometry().setFromPoints(
      curve.getPoints(28),
    );
    const material = new THREE.LineBasicMaterial({
      color: 0xff8f8f,
      transparent: true,
      opacity: 0.88,
    });
    const line = new THREE.Line(geometry, material);
    line.name = `${edge.id}-nested-preview-edge`;
    line.userData.nonInteractive = true;
    return line;
  }

  surfacePoints(surface) {
    if (!surface) {
      return [];
    }
    if (surface.triangleControlNet) {
      return this.flattenPoints(surface.triangleControlNet);
    }
    if (surface.patchControlNets || surface.controlNet) {
      return this.flattenPoints(surface.patchControlNets ?? surface.controlNet);
    }
    return [
      surface.sourcePosition,
      surface.targetPosition,
      surface.firstControlPoint,
      surface.secondControlPoint,
      surface.controlPoint,
    ].filter(Boolean);
  }

  flattenPoints(value) {
    if (!Array.isArray(value)) {
      return value?.isVector3 ? [value] : [];
    }
    return value.flatMap((entry) => this.flattenPoints(entry));
  }

  createSurface(surface, transform) {
    if (!surface) {
      return null;
    }

    const controlNet = this.surfaceControlNet(surface);
    if (!controlNet) {
      return null;
    }

    const samples = Math.min(surface.render?.samples ?? 6, 8);
    const gridSize = samples + 1;
    const positions = [];
    const indices = [];
    for (let row = 0; row < gridSize; row += 1) {
      const v = row / samples;
      for (let column = 0; column < gridSize; column += 1) {
        const u = column / samples;
        const point = surface.triangleControlNet
          ? evaluateTriangularCubicBezierPatch(
              controlNet,
              squareToTriangularBarycentric(u, v),
            )
          : evaluateBiquadraticBezierPatch(controlNet, u, v);
        positions.push(...this.mapPoint(point, transform).toArray());
      }
    }

    for (let row = 0; row < samples; row += 1) {
      for (let column = 0; column < samples; column += 1) {
        const topLeft = row * gridSize + column;
        const topRight = topLeft + 1;
        const bottomLeft = topLeft + gridSize;
        const bottomRight = bottomLeft + 1;
        indices.push(topLeft, bottomLeft, topRight, topRight, bottomLeft, bottomRight);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(positions, 3),
    );
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    const material = new THREE.MeshBasicMaterial({
      color: surface.render?.color ?? 0x8fb9ff,
      transparent: true,
      opacity: Math.min(surface.render?.opacity ?? 0.26, 0.32),
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `${surface.id}-nested-preview-surface`;
    mesh.userData.nonInteractive = true;
    return mesh;
  }

  surfaceControlNet(surface) {
    if (surface.triangleControlNet) {
      return surface.triangleControlNet;
    }
    if (surface.controlNet) {
      return surface.controlNet;
    }
    if (
      !surface.sourcePosition ||
      !surface.targetPosition ||
      !surface.firstControlPoint ||
      !surface.secondControlPoint ||
      !surface.controlPoint
    ) {
      return null;
    }

    const patch = {
      start: surface.sourcePosition,
      end: surface.targetPosition,
      firstControl: surface.firstControlPoint,
      secondControl: surface.secondControlPoint,
      centerPoint: surface.controlPoint,
    };
    const interior = getBiquadraticInteriorControlForCenterPoint(patch);
    return [
      [patch.start, patch.firstControl, patch.end],
      [patch.start, interior, patch.end],
      [patch.start, patch.secondControl, patch.end],
    ];
  }
}

export class NestedGologPanelRenderer {
  constructor({ container }) {
    this.container = container;
    this.disposed = false;
    this.contentRenderer = new NestedGologContentRenderer({ contentRadius: 1.35 });
    this.releaseListener = null;
    this.golog = null;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0c121b);
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(0, -4.6, 2.6);
    this.camera.lookAt(0, 0, 0);

    this.group = new THREE.Group();
    this.scene.add(this.group);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const light = new THREE.DirectionalLight(0xffffff, 0.75);
    light.position.set(3, -4, 6);
    this.scene.add(light);

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
    });
    this.renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio ?? 1, 2));
    this.renderer.domElement.className = "payload-golog-canvas";
    this.container.appendChild(this.renderer.domElement);
  }

  setGolog(golog) {
    if (this.disposed) return;
    if (this.golog?.id === golog?.id) {
      this.rebuild();
      return;
    }

    this.releaseListener?.();
    this.releaseListener = null;
    this.golog = golog ?? null;
    if (this.golog) {
      this.releaseListener = this.golog.bus.on("state:changed", () => this.rebuild());
    }
    this.rebuild();
  }

  rebuild() {
    if (this.disposed) return;
    this.contentRenderer.rebuildContent(this.group, this.golog);
    this.render();
  }

  render() {
    if (this.disposed) return;
    const width = Math.max(this.container.clientWidth, 1);
    const height = Math.max(this.container.clientHeight, 1);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseListener?.();
    this.releaseListener = null;
    this.contentRenderer.rebuildContent(this.group, null);
    disposeObject3D(this.group);
    this.renderer.domElement.remove();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.golog = null;
  }
}
