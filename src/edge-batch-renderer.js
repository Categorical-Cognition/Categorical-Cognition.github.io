import * as THREE from "three";
import { BatchedGeometryRenderer } from "./batch-geometry.js";
import { getQuadraticControlPoint } from "./geometry-utils.js";

const DEFAULT_EDGE_CAPACITY = 1024;
const DEFAULT_EDGE_SAMPLES = 32;
const DEFAULT_EDGE_THICKNESS = 0.06;
const DEFAULT_EDGE_COLOR = 0xf28a8a;
const DEFAULT_EDGE_OPACITY = 0.86;

const vertexShader = `
attribute vec3 previousPosition;
attribute vec3 nextPosition;
attribute float side;
attribute vec3 edgeColor;
attribute float edgeOpacity;
attribute float edgeThickness;
attribute float edgeMarker;
attribute float curveParameter;

varying vec3 vColor;
varying float vOpacity;
varying float vMarker;
varying float vCurveParameter;

vec3 fallbackSide(vec3 tangent) {
  vec3 sideFromZ = cross(tangent, vec3(0.0, 0.0, 1.0));
  if (dot(sideFromZ, sideFromZ) > 0.000001) {
    return normalize(sideFromZ);
  }
  return normalize(cross(tangent, vec3(0.0, 1.0, 0.0)));
}

void main() {
  vec3 centerWorld = (modelMatrix * vec4(position, 1.0)).xyz;
  vec3 previousWorld = (modelMatrix * vec4(previousPosition, 1.0)).xyz;
  vec3 nextWorld = (modelMatrix * vec4(nextPosition, 1.0)).xyz;

  vec3 tangent = nextWorld - previousWorld;
  if (dot(tangent, tangent) < 0.000001) {
    tangent = vec3(1.0, 0.0, 0.0);
  }
  tangent = normalize(tangent);

  vec3 viewDirection = cameraPosition - centerWorld;
  if (dot(viewDirection, viewDirection) < 0.000001) {
    viewDirection = vec3(0.0, 0.0, 1.0);
  }
  viewDirection = normalize(viewDirection);

  vec3 sideDirection = cross(tangent, viewDirection);
  if (dot(sideDirection, sideDirection) < 0.000001) {
    sideDirection = fallbackSide(tangent);
  } else {
    sideDirection = normalize(sideDirection);
  }

  vec3 ribbonWorld = centerWorld + sideDirection * side * edgeThickness * 0.5;
  gl_Position = projectionMatrix * viewMatrix * vec4(ribbonWorld, 1.0);

  vColor = edgeColor;
  vOpacity = edgeOpacity;
  vMarker = edgeMarker;
  vCurveParameter = curveParameter;
}
`;

const fragmentShader = `
varying vec3 vColor;
varying float vOpacity;
varying float vMarker;
varying float vCurveParameter;

void main() {
  if (vOpacity <= 0.0) {
    discard;
  }
  float mark = 0.0;
  if (vMarker > 0.5) {
    mark = max(
      1.0 - smoothstep(0.012, 0.026, abs(vCurveParameter - 0.42)),
      1.0 - smoothstep(0.012, 0.026, abs(vCurveParameter - 0.58))
    );
  }
  vec3 color = mix(vColor, vec3(1.0), mark * 0.92);
  gl_FragColor = vec4(color, max(vOpacity, mark));
}
`;

function colorComponents(color) {
  const parsedColor = new THREE.Color(color ?? DEFAULT_EDGE_COLOR);
  return [parsedColor.r, parsedColor.g, parsedColor.b];
}

function cloneEdgeRecord(edge) {
  return {
    id: edge.id,
    start: edge.start.clone(),
    midpoint: edge.midpoint.clone(),
    end: edge.end.clone(),
    control: edge.control?.clone(),
    render: { ...(edge.render ?? {}) },
  };
}

export class EdgeBatchRenderer extends BatchedGeometryRenderer {
  constructor({
    scene,
    initialCapacity = DEFAULT_EDGE_CAPACITY,
    samples = DEFAULT_EDGE_SAMPLES,
  }) {
    super({
      scene,
      name: "batched-edge-ribbons",
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
    this.sampleCount = samples + 1;
    this.verticesPerEdge = this.sampleCount * 2;
    this.indicesPerEdge = samples * 6;
    this.indicesPerItem = this.indicesPerEdge;

    this.allocateBuffers(this.capacity);
  }

  upsertEdge(edge) {
    this.renderVersion = (this.renderVersion ?? 0) + 1;
    if (!this.records.has(edge.id)) this.topologyVersion = (this.topologyVersion ?? 0) + 1;
    const record = cloneEdgeRecord(edge);
    this.upsertRecord(record.id, record);
  }

  removeEdge(id) {
    if (this.records.has(id)) this.topologyVersion = (this.topologyVersion ?? 0) + 1;
    this.removeRecord(id);
  }

  getCenterPoint(id, sampleIndex) {
    const slot = this.slots.slotFor(id);
    if (slot === null) {
      return null;
    }

    const clampedSampleIndex = THREE.MathUtils.clamp(
      sampleIndex,
      0,
      this.sampleCount - 1,
    );
    const vertexIndex = slot * this.verticesPerEdge + clampedSampleIndex * 2;
    return new THREE.Vector3().fromBufferAttribute(
      this.geometry.attributes.position,
      vertexIndex,
    );
  }

  stats() {
    return {
      activeEdges: this.records.size,
      ...this.baseStats(),
      samplesPerEdge: this.samples,
      verticesPerEdge: this.verticesPerEdge,
      shaderBillboarded: true,
    };
  }

  allocateBuffers(capacity) {
    const vertexCount = capacity * this.verticesPerEdge;
    const indexCount = capacity * this.indicesPerEdge;
    this.positions = new Float32Array(vertexCount * 3);
    this.previousPositions = new Float32Array(vertexCount * 3);
    this.nextPositions = new Float32Array(vertexCount * 3);
    this.sides = new Float32Array(vertexCount);
    this.colors = new Float32Array(vertexCount * 3);
    this.opacities = new Float32Array(vertexCount);
    this.thicknesses = new Float32Array(vertexCount);
    this.markers = new Float32Array(vertexCount);
    this.curveParameters = new Float32Array(vertexCount);
    this.indices = new Uint32Array(indexCount);

    for (let slot = 0; slot < capacity; slot += 1) {
      this.writeIndicesForSlot(slot);
    }

    this.setAttribute(
      "position",
      this.positions,
      3,
    );
    this.setAttribute(
      "previousPosition",
      this.previousPositions,
      3,
    );
    this.setAttribute(
      "nextPosition",
      this.nextPositions,
      3,
    );
    this.setAttribute("side", this.sides, 1);
    this.setAttribute(
      "edgeColor",
      this.colors,
      3,
    );
    this.setAttribute(
      "edgeOpacity",
      this.opacities,
      1,
    );
    this.setAttribute(
      "edgeThickness",
      this.thicknesses,
      1,
    );
    this.setAttribute("edgeMarker", this.markers, 1);
    this.setAttribute("curveParameter", this.curveParameters, 1);
    this.geometry.setIndex(new THREE.BufferAttribute(this.indices, 1));
    this.geometry.setDrawRange(0, 0);
  }

  writeRecord(edge, slot) {
    this.writeEdge(edge, slot);
  }

  writeEdge(edge, slot) {
    if (slot === null) {
      return;
    }

    const samples = this.sampleEdge(edge);
    const [red, green, blue] = colorComponents(edge.render.color);
    const opacity = edge.render.opacity ?? DEFAULT_EDGE_OPACITY;
    const thickness = edge.render.thickness ?? DEFAULT_EDGE_THICKNESS;
    const marker = edge.render.marker === "proarrow" ? 1 : 0;

    for (let sampleIndex = 0; sampleIndex < this.sampleCount; sampleIndex += 1) {
      const previous = samples[Math.max(0, sampleIndex - 1)];
      const current = samples[sampleIndex];
      const next = samples[Math.min(this.sampleCount - 1, sampleIndex + 1)];

      for (let sideIndex = 0; sideIndex < 2; sideIndex++) {
        const vertex = slot * this.verticesPerEdge + sampleIndex * 2 + sideIndex;
        const offset = vertex * 3;
        this.positions[offset] = current.x;
        this.positions[offset + 1] = current.y;
        this.positions[offset + 2] = current.z;
        this.previousPositions[offset] = previous.x;
        this.previousPositions[offset + 1] = previous.y;
        this.previousPositions[offset + 2] = previous.z;
        this.nextPositions[offset] = next.x;
        this.nextPositions[offset + 1] = next.y;
        this.nextPositions[offset + 2] = next.z;
        this.colors[offset] = red;
        this.colors[offset + 1] = green;
        this.colors[offset + 2] = blue;
        this.sides[vertex] = sideIndex * 2 - 1;
        this.opacities[vertex] = opacity;
        this.thicknesses[vertex] = thickness;
        this.markers[vertex] = marker;
        this.curveParameters[vertex] = sampleIndex / this.samples;
      }
    }

    this.markSlotAttributesDirty(slot);
  }

  sampleEdge(edge) {
    const control =
      edge.control ?? getQuadraticControlPoint(edge.start, edge.midpoint, edge.end);
    const curve = new THREE.QuadraticBezierCurve3(edge.start, control, edge.end);
    return curve.getPoints(this.samples);
  }

  writeIndicesForSlot(slot) {
    const vertexOffset = slot * this.verticesPerEdge;
    const indexOffset = slot * this.indicesPerEdge;
    for (let segment = 0; segment < this.samples; segment += 1) {
      const left0 = vertexOffset + segment * 2;
      const right0 = left0 + 1;
      const left1 = left0 + 2;
      const right1 = left0 + 3;
      const base = indexOffset + segment * 6;
      this.indices[base] = left0;
      this.indices[base + 1] = right0;
      this.indices[base + 2] = left1;
      this.indices[base + 3] = right0;
      this.indices[base + 4] = right1;
      this.indices[base + 5] = left1;
    }
  }

  clearSlot(slot) {
    const firstVertex = slot * this.verticesPerEdge;
    const lastVertex = firstVertex + this.verticesPerEdge;
    this.opacities.fill(0, firstVertex, lastVertex);
    this.markAttributeRange("edgeOpacity", firstVertex, this.verticesPerEdge);
  }

  markSlotAttributesDirty(slot) {
    const firstVertex = slot * this.verticesPerEdge;
    const vertexCount = this.verticesPerEdge;
    this.markAttributeRange("position", firstVertex * 3, vertexCount * 3);
    this.markAttributeRange(
      "previousPosition",
      firstVertex * 3,
      vertexCount * 3,
    );
    this.markAttributeRange("nextPosition", firstVertex * 3, vertexCount * 3);
    this.markAttributeRange("side", firstVertex, vertexCount);
    this.markAttributeRange("edgeColor", firstVertex * 3, vertexCount * 3);
    this.markAttributeRange("edgeOpacity", firstVertex, vertexCount);
    this.markAttributeRange("edgeThickness", firstVertex, vertexCount);
    this.markAttributeRange("edgeMarker", firstVertex, vertexCount);
    this.markAttributeRange("curveParameter", firstVertex, vertexCount);
  }

}
