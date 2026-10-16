import * as THREE from "three";
import {
  evaluateBiquadraticBezierPatch,
  evaluateTriangularCubicBezierPatch,
  getBiquadraticInteriorControlForCenterPoint,
} from "./geometry-utils.js";

function surfaceControlNet(patch) {
  if (patch.controlNet) return patch.controlNet;
  const center = getBiquadraticInteriorControlForCenterPoint(patch);
  return [
    [patch.start, patch.firstControl, patch.end],
    [patch.start, center, patch.end],
    [patch.start, patch.secondControl, patch.end],
  ];
}

function samplePatch(patch, samples, points, triangles) {
  const grid = [];
  const triangular = Boolean(patch.triangleControlNet);
  const controlNet = triangular ? patch.triangleControlNet : surfaceControlNet(patch);
  for (let row = 0; row <= samples; row += 1) {
    grid[row] = [];
    const width = triangular ? samples - row : samples;
    for (let column = 0; column <= width; column += 1) {
      grid[row][column] = points.length;
      points.push(triangular
        ? evaluateTriangularCubicBezierPatch(controlNet, {
            a: 1 - (row + column) / samples,
            b: column / samples,
            c: row / samples,
          })
        : evaluateBiquadraticBezierPatch(controlNet, column / samples, row / samples));
    }
  }
  for (let row = 0; row < samples; row += 1) {
    const width = triangular ? samples - row : samples;
    for (let column = 0; column < width; column += 1) {
      triangles.push([grid[row][column], grid[row][column + 1], grid[row + 1][column]]);
      if (!triangular || column + 1 < width) {
        triangles.push([grid[row][column + 1], grid[row + 1][column + 1], grid[row + 1][column]]);
      }
    }
  }
}

function failure(reason, details = {}) {
  return { ok: false, reason, geometry: null, ...details };
}

// A rendered volume is the actual sampled boundary shell. We never replace an
// open or concave shell with its convex hull: that could fill outside its faces.
export function createVolumeGeometry(projection, { samples = 12, relativeTolerance = 1e-7 } = {}) {
  if (!projection?.boundarySurfaces?.length || projection.missingFaceIds?.length) {
    return failure("missing-boundary-surfaces", { missingFaceIds: projection?.missingFaceIds ?? [] });
  }
  const points = [];
  const rawTriangles = [];
  try {
    for (const face of projection.boundarySurfaces) {
      for (const patch of face.patches) samplePatch(patch, samples, points, rawTriangles);
    }
  } catch {
    return failure("invalid-boundary-patch");
  }
  if (!points.length || points.some((p) => ![p.x, p.y, p.z].every(Number.isFinite))) {
    return failure("nonfinite-boundary");
  }
  const bounds = new THREE.Box3().setFromPoints(points);
  const scale = bounds.getSize(new THREE.Vector3()).length();
  if (scale === 0) return failure("degenerate-boundary");
  const tolerance = Math.max(scale * relativeTolerance, Number.EPSILON * 64);
  const vertices = [];
  const buckets = new Map();
  const ids = points.map((point) => {
    const cell = point.toArray().map((value) => Math.floor(value / tolerance));
    // Adjacent buckets avoid cracks when equal samples straddle a rounded key.
    for (let x = -1; x <= 1; x += 1) for (let y = -1; y <= 1; y += 1) for (let z = -1; z <= 1; z += 1) {
      for (const id of buckets.get(`${cell[0] + x}:${cell[1] + y}:${cell[2] + z}`) ?? []) {
        if (vertices[id].distanceToSquared(point) <= tolerance ** 2) return id;
      }
    }
    const id = vertices.length;
    vertices.push(point);
    const key = cell.join(":");
    buckets.set(key, [...(buckets.get(key) ?? []), id]);
    return id;
  });
  const triangles = rawTriangles.map((triangle) => triangle.map((id) => ids[id])).filter(([a, b, c]) =>
    a !== b && b !== c && c !== a &&
    vertices[b].clone().sub(vertices[a]).cross(vertices[c].clone().sub(vertices[a])).lengthSq() > tolerance ** 4);
  if (triangles.length < 4) return failure("degenerate-boundary");

  const incidence = new Map();
  triangles.forEach((triangle, triangleId) => {
    triangle.forEach((a, index) => {
      const b = triangle[(index + 1) % 3];
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      const entries = incidence.get(key) ?? [];
      entries.push({ triangleId, direction: a < b ? 1 : -1 });
      incidence.set(key, entries);
    });
  });
  const openEdges = [...incidence.values()].filter((entries) => entries.length !== 2).length;
  if (openEdges) return failure("boundary-not-closed-manifold", { openEdges });
  const adjacent = triangles.map(() => []);
  for (const [first, second] of incidence.values()) {
    const sign = -first.direction * second.direction;
    adjacent[first.triangleId].push([second.triangleId, sign]);
    adjacent[second.triangleId].push([first.triangleId, sign]);
  }
  const orientation = new Map([[0, 1]]);
  const queue = [0];
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    for (const [neighbor, sign] of adjacent[current]) {
      const expected = orientation.get(current) * sign;
      if (orientation.has(neighbor)) {
        if (orientation.get(neighbor) !== expected) return failure("boundary-not-orientable");
      } else {
        orientation.set(neighbor, expected);
        queue.push(neighbor);
      }
    }
  }
  if (orientation.size !== triangles.length) return failure("disconnected-boundary");
  const oriented = triangles.map(([a, b, c], index) => orientation.get(index) === 1 ? [a, b, c] : [a, c, b]);
  const reference = bounds.getCenter(new THREE.Vector3());
  let signedVolume = 0;
  const centroid = new THREE.Vector3();
  for (const triangle of oriented) {
    const [a, b, c] = triangle.map((id) => vertices[id].clone().sub(reference));
    const v = a.dot(b.clone().cross(c)) / 6;
    signedVolume += v;
    centroid.addScaledVector(a.add(b).add(c).multiplyScalar(0.25), v);
  }
  if (Math.abs(signedVolume) <= scale ** 3 * relativeTolerance) return failure("zero-volume-boundary");
  centroid.divideScalar(signedVolume).add(reference);
  if (signedVolume < 0) for (const triangle of oriented) [triangle[1], triangle[2]] = [triangle[2], triangle[1]];
  for (const [a, b, c] of oriented) {
    const normal = vertices[b].clone().sub(vertices[a]).cross(vertices[c].clone().sub(vertices[a])).normalize();
    const origin = vertices[a];
    if (vertices.some((point) => normal.x * (point.x - origin.x) +
      normal.y * (point.y - origin.y) + normal.z * (point.z - origin.z) > tolerance * 8)) {
      return failure("nonconvex-boundary", { sampledVolume: Math.abs(signedVolume) });
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setFromPoints(vertices);
  geometry.setIndex(oriented.flat());
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return { ok: true, geometry, centroid, volume: Math.abs(signedVolume),
    triangleCount: oriented.length, vertexCount: vertices.length, samples,
    verification: "closed-oriented-convex-sampled-boundary" };
}
