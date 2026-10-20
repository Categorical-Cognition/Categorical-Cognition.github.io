import * as THREE from "three";
function samplePatch(patch, samples, points, triangles, locations, faceId, patchIndex) {
  const kind = patchKind(patch), sampler = patchSampler(kind, samples), controls = patchControls(patch, kind, []);
  const offset = points.length;
  sampler.weights.forEach((weights, index) => {
    const point = new THREE.Vector3();
    for (let i = 0; i < weights.length; i++) point.addScaledVector(controls[i], weights[i]);
    points.push(point); locations.push({ faceId, patchIndex, ...sampler.locations[index] });
  });
  for (const triangle of sampler.triangles) triangles.push(triangle.map((i) => i + offset));
}

function failure(reason, details = {}) {
  return { ok: false, reason, geometry: null, ...details };
}

function pointHierarchy(points) {
  const bounds = new THREE.Box3().setFromPoints(points);
  if (points.length <= 8) return { bounds, points };
  const size = bounds.getSize(new THREE.Vector3());
  const axis = size.x >= size.y && size.x >= size.z ? "x" : size.y >= size.z ? "y" : "z";
  const ordered = [...points].sort((a, b) => a[axis] - b[axis]), middle = ordered.length >> 1;
  return { bounds, left: pointHierarchy(ordered.slice(0, middle)), right: pointHierarchy(ordered.slice(middle)) };
}

function hasPointBeyondPlane(tree, normal, origin, tolerance) {
  const { min, max } = tree.bounds;
  // This support bound uses the same arithmetic as the leaf test. A rejected
  // box cannot contain a violating vertex; uncertain boxes are subdivided.
  const bound = normal.x * ((normal.x >= 0 ? max.x : min.x) - origin.x)
    + normal.y * ((normal.y >= 0 ? max.y : min.y) - origin.y)
    + normal.z * ((normal.z >= 0 ? max.z : min.z) - origin.z);
  if (bound <= tolerance) return false;
  if (tree.points) return tree.points.some((point) => normal.x * (point.x - origin.x)
    + normal.y * (point.y - origin.y) + normal.z * (point.z - origin.z) > tolerance);
  return hasPointBeyondPlane(tree.left, normal, origin, tolerance)
    || hasPointBeyondPlane(tree.right, normal, origin, tolerance);
}

// A rendered volume is the actual sampled boundary shell. We never replace an
// open or concave shell with its convex hull: that could fill outside its faces.
export function createVolumeGeometry(projection, { samples = 12, relativeTolerance = 1e-7 } = {}) {
  if (volumeGeometryTopologyKey(projection, { samples, relativeTolerance })) {
    const template = createVolumeGeometryTemplate(projection, { samples, relativeTolerance });
    const result = updateVolumeGeometry(template, projection);
    if (!result.ok) template.geometry?.dispose();
    return result;
  }
  if (!projection?.boundarySurfaces?.length || projection.missingFaceIds?.length) {
    return failure("missing-boundary-surfaces", { missingFaceIds: projection?.missingFaceIds ?? [] });
  }
  const points = [];
  const locations = [];
  const rawTriangles = [];
  try {
    for (const face of projection.boundarySurfaces) {
      face.patches.forEach((patch, index) => samplePatch(patch, samples, points, rawTriangles, locations, face.faceId, index));
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
  const vertexLocations = [];
  const buckets = new Map();
  const ids = points.map((point, pointIndex) => {
    const cell = point.toArray().map((value) => Math.floor(value / tolerance));
    // Adjacent buckets avoid cracks when equal samples straddle a rounded key.
    for (let x = -1; x <= 1; x += 1) {
      const column = buckets.get(cell[0] + x);
      if (!column) continue;
      for (let y = -1; y <= 1; y += 1) {
        const row = column.get(cell[1] + y);
        if (!row) continue;
        for (let z = -1; z <= 1; z += 1) for (const id of row.get(cell[2] + z) ?? []) {
          if (vertices[id].distanceToSquared(point) <= tolerance ** 2) return id;
        }
      }
    }
    const id = vertices.length;
    vertices.push(point);
    vertexLocations.push(locations[pointIndex]);
    if (!buckets.has(cell[0])) buckets.set(cell[0], new Map());
    const column = buckets.get(cell[0]);
    if (!column.has(cell[1])) column.set(cell[1], new Map());
    const row = column.get(cell[1]);
    if (!row.has(cell[2])) row.set(cell[2], []);
    row.get(cell[2]).push(id);
    return id;
  });
  const triangles = rawTriangles.map((triangle) => triangle.map((id) => ids[id])).filter(([a, b, c]) =>
    a !== b && b !== c && c !== a &&
    vertices[b].clone().sub(vertices[a]).cross(vertices[c].clone().sub(vertices[a])).lengthSq() > tolerance ** 4);
  if (triangles.length < 4) return failure("degenerate-boundary");

  const oriented = orientTriangles(triangles);
  if (oriented.geometry === null) return oriented;
  return evaluateShell({ vertices, triangles: oriented.triangles, locations: vertexLocations,
    relativeTolerance, samples, bounds, winding: 1, scratch: Array.from({ length: 5 }, () => new THREE.Vector3()) }, scale, tolerance);
}

const samplers = new Map();
const patchKind = (patch) => patch.triangleControlNet ? "triangle" : patch.controlNet ? "quadrilateral" : "bigon";
const quadratic = (t) => [(1 - t) ** 2, 2 * t * (1 - t), t * t];

function patchSampler(kind, samples) {
  const key = `${kind}:${samples}`;
  if (samplers.has(key)) return samplers.get(key);
  const triangular = kind === "triangle", locations = [], weights = [], triangles = [], grid = [];
  for (let row = 0; row <= samples; row++) {
    grid[row] = [];
    for (let column = 0; column <= (triangular ? samples - row : samples); column++) {
      grid[row][column] = locations.length;
      const u = column / samples, v = row / samples;
      const location = { u, v };
      if (triangular) {
        const a = 1 - (row + column) / samples, b = u, c = v;
        location.barycentric = { a, b, c };
        weights.push([a ** 3, 3 * a * a * b, 3 * a * b * b, b ** 3,
          3 * a * a * c, 3 * a * c * c, c ** 3, 3 * b * b * c, 3 * b * c * c, 6 * a * b * c]);
      } else {
        const bu = quadratic(u), bv = quadratic(v);
        if (kind === "bigon") {
          const center = bu[1] * bv[1];
          weights.push([bu[0] - center, bu[2] - center, bu[1] * bv[0] - center / 2,
            bu[1] * bv[2] - center / 2, 4 * center]);
        } else weights.push(bv.flatMap((y) => bu.map((x) => x * y)));
      }
      locations.push(location);
    }
  }
  for (let row = 0; row < samples; row++) for (let column = 0; column < (triangular ? samples - row : samples); column++) {
    triangles.push([grid[row][column], grid[row][column + 1], grid[row + 1][column]]);
    if (!triangular || column + 1 < samples - row) {
      triangles.push([grid[row][column + 1], grid[row + 1][column + 1], grid[row + 1][column]]);
    }
  }
  const sampler = { locations, weights, triangles };
  samplers.set(key, sampler);
  return sampler;
}

function patchControls(patch, kind, controls) {
  if (kind === "triangle") {
    const n = patch.triangleControlNet;
    [n[3][0][0], n[2][1][0], n[1][2][0], n[0][3][0], n[2][0][1], n[1][0][2],
      n[0][0][3], n[0][2][1], n[0][1][2], n[1][1][1]].forEach((p, i) => { controls[i] = p; });
  } else if (kind === "quadrilateral") {
    for (let row = 0; row < 3; row++) for (let column = 0; column < 3; column++) controls[row * 3 + column] = patch.controlNet[row][column];
  } else {
    controls[0] = patch.start; controls[1] = patch.end; controls[2] = patch.firstControl;
    controls[3] = patch.secondControl; controls[4] = patch.centerPoint;
  }
  return controls;
}

/** A topology key contains semantic seams and sampling, never coordinates. */
export function volumeGeometryTopologyKey(projection, { samples = 12, relativeTolerance = 1e-7 } = {}) {
  if (!Number.isInteger(samples) || samples < 1 || !projection?.boundarySurfaces?.length || projection.missingFaceIds?.length) return null;
  const faces = [];
  for (const face of projection.boundarySurfaces) {
    if (!face?.patches?.length) return null;
    const patches = [];
    for (const patch of face.patches) {
      const kind = patchKind(patch), boundary = patch.boundary, count = kind === "triangle" ? 3 : 4;
      if (!boundary || boundary.corners?.length !== count || boundary.edges?.length !== count
        || boundary.corners.some((id) => typeof id !== "string" || !id)) return null;
      for (let side = 0; side < count; side++) {
        if (boundary.corners[side] === boundary.corners[(side + 1) % count]) continue;
        const edge = boundary.edges[side];
        if (typeof edge?.id !== "string" || !edge.id || !Number.isFinite(edge.start) || !Number.isFinite(edge.end)) return null;
      }
      patches.push([kind, boundary]);
    }
    faces.push([face.faceId, patches]);
  }
  return JSON.stringify([samples, relativeTolerance, faces]);
}

function sampleIdentity(faceId, patchIndex, patch, location) {
  const { corners, edges } = patch.boundary, { u, v, barycentric } = location;
  let corner = -1, side = -1, t = 0;
  if (barycentric) {
    const { a, b, c } = barycentric;
    corner = a === 1 ? 0 : b === 1 ? 1 : c === 1 ? 2 : -1;
    if (c === 0) { side = 0; t = b; }
    else if (a === 0) { side = 1; t = c; }
    else if (b === 0) { side = 2; t = a; }
  } else {
    corner = u === 0 && v === 0 ? 0 : u === 1 && v === 0 ? 1 : u === 1 && v === 1 ? 2 : u === 0 && v === 1 ? 3 : -1;
    if (v === 0) { side = 0; t = u; }
    else if (u === 1) { side = 1; t = v; }
    else if (v === 1) { side = 2; t = 1 - u; }
    else if (u === 0) { side = 3; t = 1 - v; }
  }
  if (corner >= 0) return JSON.stringify(["vertex", corners[corner]]);
  if (side >= 0) {
    if (corners[side] === corners[(side + 1) % corners.length]) return JSON.stringify(["vertex", corners[side]]);
    const edge = edges[side];
    // Parameters come from a fixed rational grid; this removes only arithmetic
    // noise in reversed/partial edge parameterizations, never spatial distance.
    return JSON.stringify(["edge", edge.id, Number((edge.start + (edge.end - edge.start) * t).toPrecision(14))]);
  }
  return JSON.stringify(["interior", faceId, patchIndex, u, v]);
}

function orientTriangles(triangles) {
  const incidence = new Map();
  triangles.forEach((triangle, triangleId) => triangle.forEach((a, index) => {
    const b = triangle[(index + 1) % 3], key = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (!incidence.has(key)) incidence.set(key, []);
    incidence.get(key).push({ triangleId, direction: a < b ? 1 : -1 });
  }));
  const openEdges = [...incidence.values()].filter((entries) => entries.length !== 2).length;
  if (openEdges) return failure("boundary-not-closed-manifold", { openEdges });
  const adjacent = triangles.map(() => []);
  for (const [first, second] of incidence.values()) {
    const sign = -first.direction * second.direction;
    adjacent[first.triangleId].push([second.triangleId, sign]);
    adjacent[second.triangleId].push([first.triangleId, sign]);
  }
  const orientation = new Int8Array(triangles.length), queue = [0];
  orientation[0] = 1;
  for (let i = 0; i < queue.length; i++) for (const [neighbor, sign] of adjacent[queue[i]]) {
    const expected = orientation[queue[i]] * sign;
    if (orientation[neighbor] && orientation[neighbor] !== expected) return failure("boundary-not-orientable");
    if (!orientation[neighbor]) { orientation[neighbor] = expected; queue.push(neighbor); }
  }
  if (queue.length !== triangles.length) return failure("disconnected-boundary");
  return { triangles: triangles.map(([a, b, c], i) => orientation[i] === 1 ? [a, b, c] : [a, c, b]) };
}

/** Compile semantic seams once. Geometric coincidences never create incidence. */
export function createVolumeGeometryTemplate(projection, { samples = 12, relativeTolerance = 1e-7 } = {}) {
  const template = { key: volumeGeometryTopologyKey(projection, { samples, relativeTolerance }), samples, relativeTolerance,
    patches: [], points: [], vertices: [], locations: [], geometry: null, hierarchy: null, winding: 1,
    bounds: new THREE.Box3(), scratch: Array.from({ length: 5 }, () => new THREE.Vector3()) };
  if (!template.key) { template.error = failure("invalid-boundary-topology"); return template; }
  const vertexIds = new Map(), triangles = [];
  projection.boundarySurfaces.forEach((face, faceIndex) => face.patches.forEach((patch, patchIndex) => {
    const kind = patchKind(patch), sampler = patchSampler(kind, samples), ids = [];
    const offset = template.points.length;
    sampler.locations.forEach((location) => {
      const key = sampleIdentity(face.faceId, patchIndex, patch, location);
      let id = vertexIds.get(key);
      if (id === undefined) {
        id = template.vertices.length; vertexIds.set(key, id);
        template.vertices.push(new THREE.Vector3());
        template.locations.push({ faceId: face.faceId, patchIndex, ...location });
      }
      ids.push(id); template.points.push(new THREE.Vector3());
    });
    for (const triangle of sampler.triangles) {
      const [a, b, c] = triangle.map((id) => ids[id]);
      if (a !== b && b !== c && c !== a) triangles.push([a, b, c]);
    }
    template.patches.push({ faceId: face.faceId, faceIndex, patchIndex, kind, sampler, ids, offset, controls: [] });
  }));
  if (triangles.length < 4) template.error = failure("degenerate-boundary");
  else {
    const oriented = orientTriangles(triangles);
    if (oriented.geometry === null) template.error = oriented;
    else template.triangles = oriented.triangles;
  }
  if (template.error) return template;
  allocateShellGeometry(template);
  template.seen = new Uint8Array(template.vertices.length);
  return template;
}

function allocateShellGeometry(template) {
  const geometry = new THREE.BufferGeometry();
  geometry.userData.layoutSamples = template.locations;
  geometry.userData.layoutNativeCoordinates = true;
  if (template.patches) geometry.userData.layoutShell = {
    topologyKey: template.key,
    samples: template.patches.flatMap((entry) => entry.sampler.locations.map((sample, i) => ({
      // A seam has several witnesses; retain each incident face's evaluation.
      ...sample, vertex: entry.ids[i], faceId: entry.faceId, patchIndex: entry.patchIndex,
    }))),
    triangles: template.triangles,
    relativeTolerance: template.relativeTolerance,
  };
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(template.vertices.length * 3), 3));
  geometry.setIndex(template.triangles.flat());
  template.geometry = geometry;
  return geometry;
}

function refitHierarchy(tree) {
  if (tree.points) tree.bounds.setFromPoints(tree.points);
  else tree.bounds.copy(refitHierarchy(tree.left)).union(refitHierarchy(tree.right));
  return tree.bounds;
}

/** Update coordinates and current validity without reconstructing the shell. */
export function updateVolumeGeometry(template, projection) {
  if (template.key !== volumeGeometryTopologyKey(projection, template)) return failure("incompatible-boundary-topology");
  if (template.error) return template.error;
  const { points, vertices, bounds, relativeTolerance, scratch } = template;
  try {
    for (const entry of template.patches) {
      const patch = projection.boundarySurfaces[entry.faceIndex].patches[entry.patchIndex];
      const controls = patchControls(patch, entry.kind, entry.controls);
      if (controls.some((p) => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z))) return failure("nonfinite-boundary");
      entry.sampler.weights.forEach((weights, index) => {
        const point = points[entry.offset + index].set(0, 0, 0);
        for (let i = 0; i < weights.length; i++) point.addScaledVector(controls[i], weights[i]);
      });
    }
  } catch { return failure("invalid-boundary-patch"); }
  if (points.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z))) return failure("nonfinite-boundary");
  bounds.setFromPoints(points);
  const scale = bounds.getSize(scratch[0]).length();
  if (scale === 0) return failure("degenerate-boundary");
  const tolerance = Math.max(scale * relativeTolerance, Number.EPSILON * 64);
  template.seen.fill(0);
  for (const entry of template.patches) for (let i = 0; i < entry.ids.length; i++) {
    const id = entry.ids[i], point = points[entry.offset + i];
    if (template.seen[id]) {
      if (vertices[id].distanceToSquared(point) > tolerance ** 2) return failure("incompatible-boundary-seam");
    } else { vertices[id].copy(point); template.seen[id] = 1; }
  }
  return evaluateShell(template, scale, tolerance);
}

function evaluateShell(template, scale, tolerance) {
  const { vertices, triangles, bounds, relativeTolerance, scratch } = template;
  const [a, b, c, normal, reference] = scratch;
  bounds.getCenter(reference);
  let signedVolume = 0;
  const centroid = new THREE.Vector3();
  for (const [i, j, k] of triangles) {
    a.copy(vertices[i]).sub(reference); b.copy(vertices[j]).sub(reference); c.copy(vertices[k]).sub(reference);
    const v = a.dot(normal.crossVectors(b, c)) / 6;
    signedVolume += v; centroid.addScaledVector(a.add(b).add(c), v / 4);
  }
  if (Math.abs(signedVolume) <= scale ** 3 * relativeTolerance) return failure("zero-volume-boundary");
  centroid.divideScalar(signedVolume).add(reference);
  const winding = signedVolume < 0 ? -1 : 1;
  if (template.hierarchy) refitHierarchy(template.hierarchy);
  else template.hierarchy = pointHierarchy(vertices);
  for (const [i, j, k] of triangles) {
    a.copy(vertices[j]).sub(vertices[i]); b.copy(vertices[k]).sub(vertices[i]); normal.crossVectors(a, b);
    if (normal.lengthSq() <= tolerance ** 4) return failure("degenerate-boundary");
    normal.normalize().multiplyScalar(winding);
    if (hasPointBeyondPlane(template.hierarchy, normal, vertices[i], tolerance * 8)) {
      return failure("nonconvex-boundary", { sampledVolume: Math.abs(signedVolume) });
    }
  }
  const geometry = template.geometry ?? allocateShellGeometry(template);
  const position = geometry.getAttribute("position");
  vertices.forEach((p, i) => position.setXYZ(i, p.x, p.y, p.z));
  position.needsUpdate = true;
  if (winding !== template.winding) {
    const indices = geometry.getIndex();
    for (let i = 0; i < triangles.length; i++) {
      const [a, b, c] = triangles[i];
      indices.array[i * 3] = a; indices.array[i * 3 + 1] = winding === 1 ? b : c; indices.array[i * 3 + 2] = winding === 1 ? c : b;
    }
    indices.needsUpdate = true; template.winding = winding;
  }
  geometry.computeVertexNormals(); geometry.computeBoundingSphere();
  return { ok: true, geometry, centroid, volume: Math.abs(signedVolume), triangleCount: triangles.length,
    vertexCount: vertices.length, samples: template.samples, verification: "closed-oriented-convex-sampled-boundary" };
}
