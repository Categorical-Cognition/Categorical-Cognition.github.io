import { layoutDescriptor, normalizeLayoutSettings, refreshLayoutFrames } from "./layout-schema.js";

export const FORCE_LAYOUT_GRAPH_FORMAT = "golog.coordinate-layout";
export const FORCE_LAYOUT_GRAPH_VERSION = 2;
const structures = new WeakMap();

function finiteCoordinates(values, id) {
  if (values.some((value) => !Number.isFinite(value) || !Number.isFinite(Math.fround(value)))) {
    throw new Error(`Nonfinite layout coordinates: ${id}`);
  }
  return values;
}

export function compileLayout(store, options = {}) {
  const revision = store.topologyRevision;
  let structure = structures.get(store);
  if (!structure || !Number.isInteger(revision) || structure.revision !== revision) {
    structure = compileLayoutStructure(store, structure);
    structure.revision = revision;
    Object.freeze(structure);
    structures.set(store, structure);
  }
  const count = structure.rows.length;
  const ledger = { ...structure, structure, gologId: store.gologId,
    rows: structure.rows.map((row) => ({ ...row, record: store[row.schema.collection].get(row.id) })),
    coordinates: new Float32Array(count * 4), velocities: new Float32Array(count * 4),
    worlds: new Float32Array(count * 4), frames: new Float32Array(count * 16),
    settings: normalizeLayoutSettings(options) };
  refreshLayoutCoordinates(ledger, store);
  return ledger;
}

// Incidence, multiplicities and sampling references change only with structure.
function compileLayoutStructure(store, previous) {
  const elements = store.getPresheaf().toJSON().elements;
  const byId = new Map(elements.map((element) => [element.id, element]));
  const rows = elements.flatMap((element) => {
    const descriptor = layoutDescriptor(store, element);
    return descriptor ? [{ id: element.id, shape: element.shape, ...descriptor,
      boundary: Object.entries(element.faces).sort(([a], [b]) => a.localeCompare(b))
        .map(([role, id]) => ({ role, id })) }] : [];
  }).sort((a, b) => {
    const left = previous?.idToIndex.get(a.id), right = previous?.idToIndex.get(b.id);
    if (left != null || right != null) return (left ?? Infinity) - (right ?? Infinity);
    return b.dof - a.dof || a.id.localeCompare(b.id);
  });
  const idToIndex = new Map(rows.map((row, index) => [row.id, index]));
  const peers = new Map(), peerGroups = [], groups = [], indices = [];
  const info = new Float32Array(rows.length * 12);
  const ledger = { format: FORCE_LAYOUT_GRAPH_FORMAT, version: FORCE_LAYOUT_GRAPH_VERSION,
    rows, idToIndex, peerGroups, groups, info, maxDepth: 3 };
  const boundaryClosure = (element) => {
    const visited = new Set(), roles = new Map();
    const queue = Object.entries(element.faces).map(([role, id]) => ({ id, role }));
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const { id, role } = queue[cursor];
      if (!roles.has(id)) roles.set(id, new Set());
      roles.get(id).add(role);
      if (visited.has(id)) continue;
      visited.add(id);
      for (const [nextRole, nextId] of Object.entries(byId.get(id)?.faces ?? {})) {
        queue.push({ id: nextId, role: `${role}/${nextRole}` });
      }
    }
    return { ids: [...visited].filter((id) => idToIndex.has(id)), roles };
  };
  for (const [index, row] of rows.entries()) {
    row.index = index; row.depth = 3 - row.dof; row.cofaceSources = [];
    row.frameRefs = row.frameIds.map((id) => idToIndex.get(id));
    if (row.frameRefs.some((value) => value == null)) throw new Error(`Unresolved layout frame: ${row.id}`);
    const closure = boundaryClosure(byId.get(row.id));
    row.support = closure.ids.map((id) => idToIndex.get(id));
    row.supportRoles = new Map(closure.ids.map((id) => [id, [...closure.roles.get(id)]]));
    row.peerKey = row.boundary.length ? JSON.stringify([row.shape, row.boundary]) : null;
    row.peerGroup = -1;
    if (row.peerKey && row.dof > 0) {
      if (!peers.has(row.peerKey)) { peers.set(row.peerKey, peerGroups.length); peerGroups.push([]); }
      row.peerGroup = peers.get(row.peerKey);
      peerGroups[row.peerGroup].push(index);
    }
  }
  for (const row of rows) if (row.law) for (const target of row.support) rows[target].cofaceSources.push(row.index);
  // Distinct witnesses remain distinct subscriptions. Equal pair laws can share
  // one evaluation, with multiplicity applied to both force and stiffness.
  const interactions = [], interactionRanges = new Float32Array(rows.length * 4);
  ledger.work = { peerPairs: peerGroups.reduce((sum, peers) => sum + peers.length * (peers.length - 1), 0),
    sourcePairs: 0, compiledPairs: 0, triangleContributions: 0 };
  for (const row of rows) {
    const pairs = new Map();
    row.triangleSources = [];
    const pair = (other, law) => {
      if (!pairs.has(other)) pairs.set(other, { other, springs: 0, repulsions: 0 });
      pairs.get(other)[law]++;
      ledger.work.sourcePairs++;
    };
    if (row.dof) for (const index of row.cofaceSources) {
      const source = rows[index];
      if (source.law === 1) {
        const other = source.frameRefs.find((value) => value !== row.index);
        if (other != null) pair(other, "springs");
      } else {
        for (const other of source.support) if (other !== row.index && rows[other].dof === row.dof) pair(other, "repulsions");
        if (source.law === 3 && source.frameRefs.includes(row.index)) row.triangleSources.push(index);
      }
    }
    row.interactions = [...pairs.values()].sort((a, b) => a.other - b.other);
    interactionRanges.set([interactions.length / 4, row.interactions.length, 0, row.triangleSources.length], row.index * 4);
    for (const { other, springs, repulsions } of row.interactions) interactions.push(other, springs, repulsions, 0);
    ledger.work.compiledPairs += row.interactions.length;
    ledger.work.triangleContributions += row.triangleSources.length;
  }
  ledger.interactions = new Float32Array(interactions);
  ledger.interactionRanges = interactionRanges;
  // Numerical dependencies are undirected for sleep scheduling, not force routing.
  const parents = rows.map((_, index) => index);
  const find = (index) => { while (parents[index] !== index) index = parents[index]; return index; };
  const join = (a, b) => { parents[find(b)] = find(a); };
  for (const row of rows) {
    for (const target of row.support) join(row.index, target);
    for (const peer of row.peerGroup < 0 ? [] : peerGroups[row.peerGroup]) join(row.index, peer);
  }
  const component = new Map();
  const span = (values) => { const start = indices.length; indices.push(...values); return [start, values.length]; };
  const peerSpans = peerGroups.map(span);
  for (const row of rows) {
    const root = find(row.index);
    if (!component.has(root)) { component.set(root, groups.length); groups.push([]); }
    row.group = component.get(root); groups[row.group].push(row.index);
    const frame = span(row.frameRefs), peer = row.peerGroup < 0 ? [0, 0] : peerSpans[row.peerGroup];
    const support = span(row.support), source = span(row.cofaceSources);
    info.set([row.frameKind, ...frame, row.group, ...peer, ...support, ...source, row.law, row.depth], row.index * 12);
    interactionRanges[row.index * 4 + 2] = span(row.triangleSources)[0];
  }
  ledger.indices = new Float32Array(indices);
  // Appends retain existing addresses; frame evaluation follows dependencies.
  // Deletion compacts the remaining addresses only during structural compilation.
  ledger.frameOrder = Object.freeze(rows.map((row) => row.index)
    .sort((a, b) => rows[a].depth - rows[b].depth || a - b));
  ledger.topologySignature = JSON.stringify(rows.map((row) => [row.id, row.shape, row.boundary]));
  for (const row of rows) {
    delete row.q; delete row.frame; delete row.record;
    Object.freeze(row);
  }
  Object.freeze(rows);
  return ledger;
}

export function refreshLayoutCoordinates(ledger, store, { ids = null, pinIds = [], resident = false } = {}) {
  const pinned = new Set(pinIds);
  const selected = ids == null ? ledger.rows
    : [...new Set(ids)].map((id) => ledger.rows[ledger.idToIndex.get(id)]).filter(Boolean);
  const updates = selected.map((row) => {
    const record = store[row.schema.collection].get(row.id);
    if (!record) throw new Error(`Layout topology changed: ${row.id}`);
    const frame = row.schema.frame(record, store);
    return { row, values: finiteCoordinates([...row.schema.coordinates(record), row.dof], row.id),
      frame: finiteCoordinates([frame.origin, ...frame.basis].flatMap((axis) => [...axis, 0]), row.id) };
  });
  for (const { row, values, frame } of updates) {
    ledger.coordinates.set(values, row.index * 4);
    ledger.frames.set(frame, row.index * 16);
  }
  for (const row of ledger.rows) ledger.velocities[row.index * 4 + 3] = pinned.has(row.id) ? 1 : 0;
  if (!resident) {
    refreshLayoutFrames(ledger);
    return packLayoutLedger(ledger);
  }
  return ledger;
}

export function packLayoutLedger(ledger) {
  const state = new Float32Array(ledger.rows.length * 12);
  for (const row of ledger.rows) {
    state.set(ledger.coordinates.subarray(row.index * 4, row.index * 4 + 4), row.index * 12);
    state.set(ledger.velocities.subarray(row.index * 4, row.index * 4 + 4), row.index * 12 + 4);
    state.set(ledger.worlds.subarray(row.index * 4, row.index * 4 + 4), row.index * 12 + 8);
  }
  ledger.gpu = { state, frames: ledger.frames, info: ledger.info, indices: ledger.indices };
  return ledger.gpu;
}

export function layoutSnapshot(ledger) {
  const result = { positions: [], edgeControls: [], surfaceControls: [] };
  for (const row of ledger.rows) {
    const entry = row.schema.snapshot(row, Array.from(ledger.coordinates.subarray(row.index * 4, row.index * 4 + 3)),
      Array.from(ledger.worlds.subarray(row.index * 4, row.index * 4 + 3)),
      Array.from(ledger.frames.subarray(row.index * 16, row.index * 16 + 16)));
    if (entry) result[entry[0]].push(entry[1]);
  }
  return result;
}

export const extractForceLayoutGraph = compileLayout;
