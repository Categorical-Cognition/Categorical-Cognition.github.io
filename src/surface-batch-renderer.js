import * as THREE from "three";
import { BatchedGeometryRenderer } from "./batch-geometry.js";
import {
  cloneTriangularCubicControlNet,
  evaluateBiquadraticBezierPatch,
  evaluateTriangularCubicBezierPatch,
  getBiquadraticInteriorControlForCenterPoint,
  squareToTriangularBarycentric,
} from "./geometry-utils.js";

const DEFAULT_SURFACE_CAPACITY = 1024;
const DEFAULT_SURFACE_SAMPLES = 10;
const DEFAULT_SURFACE_COLOR = 0x8fb9ff;
const DEFAULT_SURFACE_OPACITY = 0.26;

const vertexShader = `
attribute vec3 surfaceColor;
attribute float surfaceOpacity;

varying vec3 vColor;
varying float vOpacity;

void main() {
  vColor = surfaceColor;
  vOpacity = surfaceOpacity;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const fragmentShader = `
varying vec3 vColor;
varying float vOpacity;

void main() {
  if (vOpacity <= 0.0) {
    discard;
  }
  gl_FragColor = vec4(vColor, vOpacity);
}
`;

function colorComponents(color) {
  const parsedColor = new THREE.Color(color ?? DEFAULT_SURFACE_COLOR);
  return [parsedColor.r, parsedColor.g, parsedColor.b];
}

function cloneControlNet(controlNet) {
  return controlNet.map((row) => row.map((point) => point.clone()));
}

function cloneSurfaceRecord(surface) {
  const baseRecord = {
    id: surface.id,
    render: { ...(surface.render ?? {}) },
  };
  if (surface.triangleControlNet) {
    return {
      ...baseRecord,
      triangleControlNet: cloneTriangularCubicControlNet(surface.triangleControlNet),
    };
  }
  if (surface.controlNet) {
    return {
      ...baseRecord,
      controlNet: cloneControlNet(surface.controlNet),
    };
  }

  return {
    ...baseRecord,
    start: surface.start.clone(),
    end: surface.end.clone(),
    firstControl: surface.firstControl.clone(),
    secondControl: surface.secondControl.clone(),
    centerPoint: surface.centerPoint.clone(),
  };
}

export class SurfaceBatchRenderer extends BatchedGeometryRenderer {
  constructor({
    scene,
    initialCapacity = DEFAULT_SURFACE_CAPACITY,
    samples = DEFAULT_SURFACE_SAMPLES,
  }) {
    super({
      scene,
      name: "batched-biquadratic-surfaces",
      initialCapacity,
      frustumCulled: false,
      material: new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    });
    this.samples = samples;
    this.gridSize = samples + 1;
    this.verticesPerSurface = this.gridSize * this.gridSize;
    this.indicesPerSurface = samples * samples * 6;
    this.indicesPerItem = this.indicesPerSurface;

    this.allocateBuffers(this.capacity);
  }

  upsertSurface(surface) {
    const record = cloneSurfaceRecord(surface);
    this.upsertRecord(record.id, record);
  }

  removeSurface(id) {
    this.removeRecord(id);
  }

  getSurfacePoint(id, row, column) {
    const slot = this.slots.slotFor(id);
    if (slot === null) {
      return null;
    }

    const clampedRow = THREE.MathUtils.clamp(row, 0, this.gridSize - 1);
    const clampedColumn = THREE.MathUtils.clamp(column, 0, this.gridSize - 1);
    const vertexIndex =
      slot * this.verticesPerSurface + clampedRow * this.gridSize + clampedColumn;
    return new THREE.Vector3().fromBufferAttribute(
      this.geometry.attributes.position,
      vertexIndex,
    );
  }

  stats() {
    return {
      activeSurfaces: this.records.size,
      ...this.baseStats(),
      samplesPerSurface: this.samples,
      verticesPerSurface: this.verticesPerSurface,
      geometry: "biquadratic-bezier-patch",
    };
  }

  allocateBuffers(capacity) {
    const vertexCount = capacity * this.verticesPerSurface;
    const indexCount = capacity * this.indicesPerSurface;
    this.positions = new Float32Array(vertexCount * 3);
    this.colors = new Float32Array(vertexCount * 3);
    this.opacities = new Float32Array(vertexCount);
    this.indices = new Uint32Array(indexCount);

    for (let slot = 0; slot < capacity; slot += 1) {
      this.writeIndicesForSlot(slot);
    }

    this.setAttribute("position", this.positions, 3);
    this.setAttribute("surfaceColor", this.colors, 3);
    this.setAttribute("surfaceOpacity", this.opacities, 1);
    this.geometry.setIndex(new THREE.BufferAttribute(this.indices, 1));
    this.geometry.setDrawRange(0, 0);
  }

  writeRecord(surface, slot) {
    if (slot === null) {
      return;
    }

    const [red, green, blue] = colorComponents(surface.render.color);
    const opacity = surface.render.opacity ?? DEFAULT_SURFACE_OPACITY;
    const controlNet = this.createControlNet(surface);

    for (let row = 0; row < this.gridSize; row += 1) {
      const v = row / this.samples;
      for (let column = 0; column < this.gridSize; column += 1) {
        const u = column / this.samples;
        const point = surface.triangleControlNet
          ? evaluateTriangularCubicBezierPatch(
              controlNet,
              squareToTriangularBarycentric(u, v),
            )
          : evaluateBiquadraticBezierPatch(controlNet, u, v);
        const vertexIndex =
          slot * this.verticesPerSurface + row * this.gridSize + column;
        const vectorOffset = vertexIndex * 3;
        this.positions.set(point.toArray(), vectorOffset);
        this.colors.set([red, green, blue], vectorOffset);
        this.opacities[vertexIndex] = opacity;
      }
    }

    this.markSlotAttributesDirty(slot);
  }

  createControlNet(surface) {
    if (surface.triangleControlNet) {
      return cloneTriangularCubicControlNet(surface.triangleControlNet);
    }

    if (surface.controlNet) {
      return cloneControlNet(surface.controlNet);
    }

    const interiorControl = getBiquadraticInteriorControlForCenterPoint(surface);
    return [
      [surface.start, surface.firstControl, surface.end],
      [surface.start, interiorControl, surface.end],
      [surface.start, surface.secondControl, surface.end],
    ];
  }

  writeIndicesForSlot(slot) {
    const vertexOffset = slot * this.verticesPerSurface;
    const indexOffset = slot * this.indicesPerSurface;
    let writeIndex = indexOffset;

    for (let row = 0; row < this.samples; row += 1) {
      for (let column = 0; column < this.samples; column += 1) {
        const topLeft = vertexOffset + row * this.gridSize + column;
        const topRight = topLeft + 1;
        const bottomLeft = topLeft + this.gridSize;
        const bottomRight = bottomLeft + 1;
        this.indices[writeIndex] = topLeft;
        this.indices[writeIndex + 1] = bottomLeft;
        this.indices[writeIndex + 2] = topRight;
        this.indices[writeIndex + 3] = topRight;
        this.indices[writeIndex + 4] = bottomLeft;
        this.indices[writeIndex + 5] = bottomRight;
        writeIndex += 6;
      }
    }
  }

  clearSlot(slot) {
    const firstVertex = slot * this.verticesPerSurface;
    const lastVertex = firstVertex + this.verticesPerSurface;
    this.opacities.fill(0, firstVertex, lastVertex);
    this.markAttributeRange("surfaceOpacity", firstVertex, this.verticesPerSurface);
  }

  markSlotAttributesDirty(slot) {
    const firstVertex = slot * this.verticesPerSurface;
    const vertexCount = this.verticesPerSurface;
    this.markAttributeRange("position", firstVertex * 3, vertexCount * 3);
    this.markAttributeRange("surfaceColor", firstVertex * 3, vertexCount * 3);
    this.markAttributeRange("surfaceOpacity", firstVertex, vertexCount);
  }
}
