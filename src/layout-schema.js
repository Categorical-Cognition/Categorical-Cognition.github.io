// Layout is a coordinate representation of the registered boundary presentation.
// These adapters own shape-dependent geometry; the solver only sees linear maps.
const EPSILON = 1e-10;
const vector = (value, count = 3) => Array.from({ length: count }, (_, i) =>
  Number(value?.toArray?.()[i] ?? value?.[i] ?? 0));
const add = (a, b) => a.map((x, i) => x + b[i]);
const sub = (a, b) => a.map((x, i) => x - b[i]);
const scale = (a, s) => a.map((x) => x * s);
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => Math.sqrt(dot(a, a));
const unit = (a, fallback = [1, 0, 0]) => {
  const sizeSquared = dot(a, a);
  return sizeSquared > EPSILON * EPSILON ? scale(a, 1 / Math.sqrt(sizeSquared)) : [...fallback];
};
const mean = (points) => points.length ? scale(points.reduce(add, [0, 0, 0]), 1 / points.length) : [0, 0, 0];
const orthogonal = (n) => unit(cross(n, Math.abs(n[2]) < 0.8 ? [0, 0, 1] : [0, 1, 0]));
const align = (n, previous) => dot(n, previous) < 0 ? scale(n, -1) : n;
const pointFrame = { origin: [0, 0, 0], basis: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] };

const node = { dof: 3, frameKind: 0, law: 0, collection: "spheres",
  coordinates: (record) => vector(record.position), refs: () => [], boundarySignature: () => "",
  frame: () => pointFrame,
  snapshot: (row, q) => ["positions", { id: row.id, position: q.slice(0, 3) }] };
const edge = { dof: 2, frameKind: 1, law: 1, collection: "edges",
  coordinates: (record) => [...vector(record.bend, 2), 0],
  refs: (record) => [record.sourceId, record.targetId].sort(),
  boundarySignature: (record) => JSON.stringify([record.sourceId, record.targetId]),
  frame: (record, store) => {
    const frame = store.objects.get(record.frameId) ?? store.syncNodePairFrame(record.sourceId, record.targetId);
    return { origin: vector(frame.origin), basis: [vector(frame.u), vector(frame.v), vector(frame.tangent)] };
  },
  snapshot: (row, q, world, frame) => ["edgeControls", { id: row.id, bend: q.slice(0, 2), midpoint: world.slice(0, 3),
    frame: { u: frame.slice(4, 7), tangent: frame.slice(12, 15) } }] };
const surface = { dof: 1, law: 2, collection: "surfaces",
  coordinates: (record) => [record.controlCoordinate, 0, 0],
  frame: (record) => {
    const direction = vector(record.controlDirection);
    return { origin: sub(vector(record.controlPoint), scale(direction, record.controlCoordinate)),
      basis: [direction, [0, 0, 0], [0, 0, 0]] };
  },
  snapshot: (row, q, world, frame) => ["surfaceControls", { id: row.id, controlCoordinate: q[0], controlDirection: frame.slice(4, 7) }] };
const bigon = { ...surface, frameKind: 2, boundarySignature: (record) => JSON.stringify(record.edgeIds), refs: (record) => [...record.edgeIds] };
const triangle = { ...surface, frameKind: 3, law: 3, boundarySignature: (record) => JSON.stringify(record.edgeIds),
  refs: (record, store) => {
    const boundary = store.resolveComposableEdgeTriple(record.edgeIds);
    return [boundary.source.id, boundary.middle.id, boundary.target.id];
  } };
const virtualCell = { ...surface, frameKind: 4,
  boundarySignature: (record) => JSON.stringify([record.topPathIds, record.bottomArrowId, record.leftArrowId, record.rightArrowId]),
  refs: (record, store) => [store.edges.get(record.topPathIds[0]).sourceId,
    store.edges.get(record.topPathIds.at(-1)).targetId,
    store.edges.get(record.bottomArrowId).sourceId, store.edges.get(record.bottomArrowId).targetId] };
const region = { dof: 0, frameKind: 5, law: 2, collection: "volumes",
  boundarySignature: (record) => JSON.stringify([record.schemaRef, record.faces]),
  coordinates: () => [0, 0, 0], refs: (record) => [...record.boundaryFaceIds],
  frame: (record, store) => ({ origin: vector(store.getObject(record.id).origin), basis: pointFrame.basis }),
  snapshot: () => null };

export const LAYOUT_SCHEMAS = Object.freeze({
  "0-simplex": node, "1-simplex": edge, "2-cell": bigon, "2-simplex": triangle,
  "theta-volume": region, "virtual-double-object": node,
  "virtual-double-tight-arrow": edge, "virtual-double-proarrow": edge,
  "virtual-double-cell": virtualCell,
});

export const DEFAULT_LAYOUT_SETTINGS = Object.freeze({
  restoringStrength: 0.035, peerRepulsionStrength: 0.04, boundaryRepulsionStrength: 0.008,
  edgeSpringStrength: 0.08, restLength: 2.4, minDistance: 0.2, minAltitude: 0.8,
  dt: 0.12, dampingRatio: 1, forceThreshold: 0.0001, velocityThreshold: 0.0001,
  sleepSteps: 8, wakeThreshold: 0.0003,
});
export function normalizeLayoutSettings(settings = {}) {
  return Object.fromEntries(Object.entries(DEFAULT_LAYOUT_SETTINGS).map(([key, fallback]) => {
    if (settings[key] === undefined) return [key, fallback];
    const value = Number(settings[key]);
    const positive = ["dt", "restLength", "minDistance", "sleepSteps"].includes(key);
    if (settings[key] === null || !Number.isFinite(value) || !Number.isFinite(Math.fround(value)) || value < 0 || (positive && value === 0) ||
        (key === "sleepSteps" && !Number.isInteger(value))) throw new Error(`Invalid layout setting: ${key}`);
    return [key, value];
  }));
}

export function layoutDescriptor(store, element) {
  const object = store.getObject(element.id);
  const schema = LAYOUT_SCHEMAS[object?.elementKind];
  if (!schema) return null;
  const record = store[schema.collection].get(element.id);
  return { schema, record, ...schema, q: schema.coordinates(record),
    frame: schema.frame(record, store), frameIds: schema.refs(record, store) };
}

export function layoutEntryCoordinates(entry) {
  const value = entry.bend ?? entry.position ?? entry.controlCoordinate ?? entry.midpoint;
  const coordinates = typeof value === "number" ? [value] : Array.from(value?.toArray?.() ?? value ?? []);
  if (entry.frame) coordinates.push(...vector(entry.frame.u), ...vector(entry.frame.tangent));
  if (entry.controlDirection) coordinates.push(...vector(entry.controlDirection));
  return coordinates;
}

export function layoutCoordinateSignature(row, store) {
  const record = store[row.schema.collection].get(row.id);
  if (!record) return null;
  const q = row.schema.coordinates(record), frame = row.schema.frame(record, store);
  const packedFrame = [frame.origin, ...frame.basis].flatMap((axis) => [...axis, 0]);
  const snapshot = row.schema.snapshot(row, q, [0, 0, 0], packedFrame);
  return snapshot ? layoutEntryCoordinates(snapshot[1]) : [];
}

const read3 = (array, index, stride = 4) => Array.from(array.slice(index * stride, index * stride + 3));
const frameColumn = (ledger, index, column) => read3(ledger.frames, index * 4 + column);
const basisAt = (ledger, index) => [1, 2, 3].map((column) => frameColumn(ledger, index, column));
const worldAt = (ledger, index) => read3(ledger.worlds, index);
function writeFrame(ledger, index, origin, basis) {
  [origin, ...basis].forEach((column, slot) => ledger.frames.set([...column, 0], index * 16 + slot * 4));
}
function worldFromFrame(ledger, index) {
  const q = read3(ledger.coordinates, index);
  return basisAt(ledger, index).reduce((world, axis, i) => add(world, scale(axis, q[i])),
    frameColumn(ledger, index, 0));
}

// Coordinates remain fixed in these transported frames when their boundary moves.
export function refreshLayoutFrames(ledger, activeGroups = null) {
  for (let position = 0; position < ledger.rows.length; position++) {
    const row = ledger.rows[ledger.frameOrder?.[position] ?? position];
    if (activeGroups && !activeGroups.has(row.group)) continue;
    const points = row.frameRefs.map((index) => worldAt(ledger, index));
    const previous = basisAt(ledger, row.index);
    let origin = mean(points), basis = previous;
    if (row.frameKind === 0) ({ origin, basis } = pointFrame);
    if (row.frameKind === 1) {
      const n = unit(sub(points[1], points[0]), previous[2]);
      const old = unit(previous[2], n), cosine = Math.max(-1, Math.min(1, dot(old, n)));
      const turn = cross(old, n);
      let u = previous[0];
      if (cosine > -1 + 1e-8) u = add(add(u, cross(turn, u)), scale(cross(turn, cross(turn, u)), 1 / (1 + cosine)));
      u = unit(sub(u, scale(n, dot(u, n))), orthogonal(n));
      basis = [u, unit(cross(n, u)), n];
    }
    if (row.frameKind === 2) {
      const tangent = frameColumn(ledger, row.frameRefs[0], 3);
      const normal = cross(tangent, sub(points[1], points[0]));
      const projected = sub(previous[0], scale(tangent, dot(previous[0], tangent)));
      const fallback = dot(projected, projected) > 1e-10 ? unit(projected) : frameColumn(ledger, row.frameRefs[0], 1);
      basis = [align(dot(normal, normal) > 1e-10 ? unit(normal) : fallback, previous[0]), [0, 0, 0], [0, 0, 0]];
    }
    if (row.frameKind === 3 || row.frameKind === 4) {
      const normal = cross(sub(points[1], points[0]), sub(points[2], points[0]));
      basis = [align(dot(normal, normal) > 1e-10 ? unit(normal) : previous[0], previous[0]), [0, 0, 0], [0, 0, 0]];
    }
    writeFrame(ledger, row.index, origin, basis);
    ledger.worlds.set([...worldFromFrame(ledger, row.index), 0], row.index * 4);
  }
  return ledger;
}

function separation(a, b, i, j, basis) {
  const delta = sub(a, b);
  if (dot(delta, delta) > 1e-12 * Math.max(1, dot(a, a), dot(b, b))) return delta;
  // Float32 reconstruction noise must not choose a full-strength direction.
  // An antisymmetric finite tie-break permits reordering through coincidence.
  const axis = unit(basis[0]);
  const pivot = axis.reduce((best, value, index) => Math.abs(value) > Math.abs(axis[best]) ? index : best, 0);
  return scale(axis, (axis[pivot] < 0 ? -1 : 1) * (i < j ? -1e-4 : 1e-4));
}
function repulsion(a, b, i, j, basis, strength, softening) {
  const delta = separation(a, b, i, j, basis);
  const radius = Math.max(norm(delta), softening, 1e-4);
  const coefficient = strength / (radius * radius * radius);
  return { force: scale(unit(delta), strength / (radius * radius)), stiffness: 3 * coefficient };
}
function triangleContribution(ledger, source, target, settings) {
  const [a, b, c] = source.frameRefs.map((index) => worldAt(ledger, index));
  const tangent = sub(c, a), lengthSquared = Math.max(dot(tangent, tangent), EPSILON);
  const fraction = dot(sub(b, a), tangent) / lengthSquared;
  const height = sub(sub(b, a), scale(tangent, fraction));
  const direction = unit(height, unit(cross(frameColumn(ledger, source.index, 1), unit(tangent))));
  const amount = settings.edgeSpringStrength * Math.max(settings.minAltitude - norm(height), 0);
  const role = source.frameRefs.indexOf(target);
  const weight = role === 0 ? fraction - 1 : role === 1 ? 1 : -fraction;
  return { force: scale(direction, amount * weight), stiffness: settings.edgeSpringStrength * (1 + weight * weight) };
}

export function evaluateLayoutForces(ledger, options = ledger.settings, activeGroups = null) {
  const settings = normalizeLayoutSettings(options);
  const forces = new Float32Array(ledger.rows.length * 3), stiffness = new Float32Array(ledger.rows.length);
  for (const row of ledger.rows) {
    if (!row.dof || (activeGroups && !activeGroups.has(row.group))) continue;
    const basis = basisAt(ledger, row.index), position = worldAt(ledger, row.index);
    let world = [0, 0, 0], local = [0, 0, 0], rate = 0;
    if (row.dof < 3) {
      local = scale(read3(ledger.coordinates, row.index), -settings.restoringStrength);
      rate += settings.restoringStrength;
    }
    const accumulate = (result) => { world = add(world, result.force); rate += result.stiffness; };
    if (row.peerGroup >= 0) for (const other of ledger.peerGroups[row.peerGroup]) {
      if (other !== row.index) accumulate(repulsion(position, worldAt(ledger, other), row.index, other,
        basis, settings.peerRepulsionStrength, settings.minDistance));
    }
    for (const { other, springs, repulsions } of row.interactions) {
      if (springs) {
        const delta = separation(position, worldAt(ledger, other), row.index, other, basis);
        const distance = norm(delta);
        const strength = settings.edgeSpringStrength * springs;
        accumulate({ force: scale(delta, -strength * (distance - settings.restLength) / Math.max(distance, 1e-4)),
          stiffness: strength });
      }
      if (repulsions) accumulate(repulsion(position, worldAt(ledger, other), row.index, other, basis,
        settings.boundaryRepulsionStrength * repulsions, settings.minDistance));
    }
    for (const source of row.triangleSources) accumulate(triangleContribution(ledger, ledger.rows[source], row.index, settings));
    for (let i = 0; i < row.dof; i++) local[i] += dot(world, basis[i]);
    forces.set(local, row.index * 3);
    stiffness[row.index] = rate;
  }
  return { forces, stiffness };
}

// The host supplies stateAt, frameAt, infoAt, indexAt and pair accessors.
// stateAt slots: local coordinate/dof, velocity/pin, derived world point.
export const LAYOUT_SCHEMA_GLSL = `
uniform vec4 uLayoutStrengths;
uniform vec4 uLayoutGeometry;
vec3 safeUnit(vec3 value, vec3 fallback) {
  float squared = dot(value,value); return squared > 1e-20 ? value * inversesqrt(squared) : fallback;
}
vec3 perpendicular(vec3 n) {
  return safeUnit(cross(n, abs(n.z) < .8 ? vec3(0,0,1) : vec3(0,1,0)), vec3(1,0,0));
}
vec3 aligned(vec3 n, vec3 previous) { return dot(n, previous) < 0.0 ? -n : n; }
int frameRef(int row, int offset) { return indexAt(int(infoAt(row,0).y) + offset); }
void schemaFrame(int row, out vec3 origin, out mat3 basis) {
  vec4 info = infoAt(row,0); int kind = int(info.x), count = int(info.z);
  basis = mat3(frameAt(row,1).xyz,frameAt(row,2).xyz,frameAt(row,3).xyz);
  origin = vec3(0);
  for (int i=0;i<count;i++) origin += stateAt(frameRef(row,i),2).xyz;
  if (count > 0) origin /= float(count);
  if (kind == 0) { basis=mat3(1); return; }
  vec3 a = count > 0 ? stateAt(frameRef(row,0),2).xyz : vec3(0);
  vec3 b = count > 1 ? stateAt(frameRef(row,1),2).xyz : a;
  if (kind == 1) {
    vec3 n=safeUnit(b-a,basis[2]), old=safeUnit(basis[2],n), turn=cross(old,n);
    float cosine=clamp(dot(old,n),-1.0,1.0); vec3 u=basis[0];
    if (cosine > -1.0+1e-8) u += cross(turn,u)+cross(turn,cross(turn,u))/(1.0+cosine);
    u=safeUnit(u-n*dot(u,n),perpendicular(n)); basis=mat3(u,safeUnit(cross(n,u),perpendicular(n)),n);
  }
  if (kind == 2) {
    vec3 tangent=frameAt(frameRef(row,0),3).xyz,n=cross(tangent,b-a);
    vec3 projected=basis[0]-tangent*dot(basis[0],tangent);
    vec3 fallback=dot(projected,projected)>1e-10 ? normalize(projected) : frameAt(frameRef(row,0),1).xyz;
    basis=mat3(aligned(dot(n,n)>1e-10 ? normalize(n) : fallback,basis[0]),vec3(0),vec3(0));
  }
  if (kind == 3 || kind == 4) {
    vec3 c=stateAt(frameRef(row,2),2).xyz;
    vec3 n=cross(b-a,c-a);
    basis=mat3(aligned(dot(n,n)>1e-10 ? normalize(n) : basis[0],basis[0]),vec3(0),vec3(0));
  }
}
vec3 pairDifference(vec3 a,vec3 b,int i,int j,vec3 fallback) {
  vec3 d=a-b; if(dot(d,d)>1e-12*max(1.0,max(dot(a,a),dot(b,b)))) return d;
  vec3 axis=safeUnit(fallback,vec3(1,0,0)); int pivot=0;
  if(abs(axis.y)>abs(axis.x)) pivot=1; if(abs(axis.z)>abs(axis[pivot])) pivot=2;
  return axis*(axis[pivot]<0.0?-1.0:1.0)*(i<j?-1e-4:1e-4);
}
vec3 repel(vec3 a,vec3 b,int i,int j,vec3 fallback,float strength,inout float stiffness) {
  vec3 d=pairDifference(a,b,i,j,fallback); float squared=dot(d,d);
  float radiusSquared=max(squared,max(uLayoutGeometry.y*uLayoutGeometry.y,1e-8));
  float inverseRadius=inversesqrt(radiusSquared), inverseSquared=inverseRadius*inverseRadius;
  stiffness+=3.0*strength*inverseSquared*inverseRadius;
  return d*(inversesqrt(squared)*strength*inverseSquared);
}
vec3 triangleForce(int source,int target,inout float stiffness) {
  int ia=frameRef(source,0),ib=frameRef(source,1),ic=frameRef(source,2);
  vec3 a=stateAt(ia,2).xyz,b=stateAt(ib,2).xyz,c=stateAt(ic,2).xyz,t=c-a;
  float s=dot(b-a,t)/max(dot(t,t),1e-10); vec3 h=b-a-s*t;
  vec3 direction=safeUnit(h,safeUnit(cross(frameAt(source,1).xyz,safeUnit(t,vec3(1,0,0))),vec3(1,0,0)));
  float weight=target==ia ? s-1.0 : target==ib ? 1.0 : -s;
  stiffness+=uLayoutStrengths.w*(1.0+weight*weight);
  return direction*uLayoutStrengths.w*max(uLayoutGeometry.z-length(h),0.0)*weight;
}
vec3 schemaForce(int row,out float stiffness) {
  vec4 q=stateAt(row,0); int dof=int(q.w); stiffness=0.0;
  if (dof==0) return vec3(0);
  mat3 basis=mat3(frameAt(row,1).xyz,frameAt(row,2).xyz,frameAt(row,3).xyz);
  vec3 p=stateAt(row,2).xyz, world=vec3(0), local=vec3(0);
  if (dof<3) { local=-uLayoutStrengths.x*q.xyz; stiffness+=uLayoutStrengths.x; }
  vec4 links=infoAt(row,1), pairs=pairRangeAt(row);
  for(int i=0;i<int(links.y);i++) {
    int other=indexAt(int(links.x)+i);
    if(other!=row) world+=repel(p,stateAt(other,2).xyz,row,other,basis[0],uLayoutStrengths.y,stiffness);
  }
  for(int i=0;i<int(pairs.y);i++) {
    vec4 pair=pairAt(int(pairs.x)+i); int other=int(pair.x);
    if(pair.y>0.0) {
      vec3 d=pairDifference(p,stateAt(other,2).xyz,row,other,basis[0]); float size=length(d);
      float strength=uLayoutStrengths.w*pair.y;
      world-=strength*(size-uLayoutGeometry.x)*d/max(size,1e-4); stiffness+=strength;
    }
    if(pair.z>0.0) world+=repel(p,stateAt(other,2).xyz,row,other,basis[0],uLayoutStrengths.z*pair.z,stiffness);
  }
  for(int i=0;i<int(pairs.w);i++) world+=triangleForce(indexAt(int(pairs.z)+i),row,stiffness);
  local+=transpose(basis)*world;
  for(int i=dof;i<3;i++) local[i]=0.0;
  return local;
}
`;

// Bezier evaluation is linear in its control points. These sparse stencils are
// compiled at topology/mesh changes and evaluated against GPU world coordinates.
const weighted = (...terms) => {
  const result = new Map();
  for (const [entries, multiplier] of terms) for (const [index, value] of entries) {
    result.set(index, (result.get(index) ?? 0) + value * multiplier);
  }
  return [...result].filter(([, value]) => Math.abs(value) > 1e-12);
};
const anchor = (index) => [[index, 1]];
const bernstein = (t) => [(1 - t) ** 2, 2 * t * (1 - t), t * t];
const patch = (net, u, v) => weighted(...net.flatMap((row, j) => row.map((point, i) =>
  [point, bernstein(u)[i] * bernstein(v)[j]])));
const patchWithCenter = (net, center) => {
  net[1][1] = weighted([center, 4], [patch(net, 0.5, 0.5), -4]);
  return net;
};
function edgeStencil(ledger, row) {
  return { a: anchor(ledger.idToIndex.get(row.record.sourceId)), b: anchor(ledger.idToIndex.get(row.record.targetId)),
    m: anchor(row.index) };
}
const curvePoint = ({ a, b, m }, t) => weighted([a, 1 - 3 * t + 2 * t * t],
  [m, 4 * t * (1 - t)], [b, 2 * t * t - t]);
const curveDerivative = ({ a, b, m }, t) => weighted([a, -3 + 4 * t], [m, 4 - 8 * t], [b, 4 * t - 1]);
const curveControl = ({ a, b, m }) => weighted([m, 2], [a, -0.5], [b, -0.5]);
const subcurve = (curve, start, end) => [curvePoint(curve, start),
  weighted([curvePoint(curve, start), 1], [curveDerivative(curve, start), (end - start) / 2]), curvePoint(curve, end)];

export function layoutRenderWeights(ledger, rowIndex, sample = {}) {
  const row = typeof rowIndex === "number" ? ledger.rows[rowIndex] : rowIndex;
  const own = anchor(row.index), { u = 0.5, v = 0.5, t = 0.5, patchIndex = 0 } = sample;
  const edgeFor = (id) => edgeStencil(ledger, ledger.rows[ledger.idToIndex.get(id)]);
  if (row.frameKind === 1) return curvePoint(edgeStencil(ledger, row), t);
  if (row.frameKind === 2) {
    const first = edgeFor(row.record.edgeIds[0]), second = edgeFor(row.record.edgeIds[1]);
    const net = [[first.a, curveControl(first), first.b], [first.a, [], first.b],
      [second.a, curveControl(second), second.b]];
    return patch(patchWithCenter(net, own), u, v);
  }
  if (row.frameKind === 3) {
    const [a, b, c] = row.frameRefs.map(anchor);
    const [ab, bc, ac] = row.record.edgeIds.map((id) => curveControl(edgeFor(id)));
    const boundary = (x, y, z) => weighted([a, x ** 3], [b, y ** 3], [c, z ** 3],
      [weighted([a, 1 / 3], [ab, 2 / 3]), 3 * x * x * y],
      [weighted([b, 1 / 3], [ab, 2 / 3]), 3 * x * y * y],
      [weighted([a, 1 / 3], [ac, 2 / 3]), 3 * x * x * z],
      [weighted([c, 1 / 3], [ac, 2 / 3]), 3 * x * z * z],
      [weighted([b, 1 / 3], [bc, 2 / 3]), 3 * y * y * z],
      [weighted([c, 1 / 3], [bc, 2 / 3]), 3 * y * z * z]);
    const barycentric = sample.barycentric ?? { a: 1 - u, b: u * (1 - v), c: u * v };
    const { a: x, b: y, c: z } = barycentric;
    const center = weighted([own, 4.5], [boundary(1 / 3, 1 / 3, 1 / 3), -4.5]);
    return weighted([boundary(x, y, z), 1], [center, 6 * x * y * z]);
  }
  if (row.frameKind === 4) {
    const count = row.record.topPathIds.length;
    const top = edgeFor(row.record.topPathIds[patchIndex]);
    const bottom = subcurve(edgeFor(row.record.bottomArrowId), patchIndex / count, (patchIndex + 1) / count);
    const left = patchIndex === 0 ? curveControl(edgeFor(row.record.leftArrowId))
      : weighted([top.a, 0.5], [bottom[0], 0.5]);
    const right = patchIndex === count - 1 ? curveControl(edgeFor(row.record.rightArrowId))
      : weighted([top.b, 0.5], [bottom[2], 0.5]);
    const origin = weighted(...row.frameRefs.map((index) => [anchor(index), 0.25]));
    const center = weighted([curvePoint(top, 0.5), 0.5],
      [weighted(...bottom.map((point, i) => [point, bernstein(0.5)[i]])), 0.5], [own, 1], [origin, -1]);
    return patch(patchWithCenter([[top.a, curveControl(top), top.b], [left, [], right], bottom], center), u, v);
  }
  return own;
}

export function layoutOrientationWeights(ledger, rowIndex) {
  const row = typeof rowIndex === "number" ? ledger.rows[rowIndex] : rowIndex;
  if (row.frameKind === 1) return [[ledger.idToIndex.get(row.record.targetId), 1],
    [ledger.idToIndex.get(row.record.sourceId), -1]];
  if (row.frameKind === 2) return [[ledger.idToIndex.get(row.record.edgeIds[1]), 1],
    [ledger.idToIndex.get(row.record.edgeIds[0]), -1]];
  return null;
}
