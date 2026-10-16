import { normalizePeerContext } from "./peer-context.js";
import { scoreCapabilityProfile } from "./capability-profile.js";

export const FORCE_LAYOUT_SHARD_FORMAT = "golog.force-layout-shard";
export const FORCE_LAYOUT_SHARD_VERSION = 1;

function stableHash(input) {
  let hash = 0x811c9dc5;
  for (const character of String(input)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function normalizePeers(peers = []) {
  return peers
    .map((peer) => {
      const context = normalizePeerContext(peer);
      return {
        peer: context,
        peerId: context.peerId,
        weight: Math.max(scoreCapabilityProfile(context.capabilities), 0.01),
      };
    })
    .sort((first, second) => first.peerId.localeCompare(second.peerId));
}

function assignPeer(vertexId, peers) {
  const totalWeight = peers.reduce((sum, peer) => sum + peer.weight, 0);
  const target = (stableHash(vertexId) / 0xffffffff) * totalWeight;
  let cursor = 0;
  for (const peer of peers) {
    cursor += peer.weight;
    if (target <= cursor) {
      return peer.peerId;
    }
  }
  return peers.at(-1)?.peerId ?? null;
}

function weightedTargetCounts(vertexCount, peers) {
  const totalWeight = peers.reduce((sum, peer) => sum + peer.weight, 0);
  const entries = peers.map((peer) => {
    const ideal = totalWeight > 0 ? (peer.weight / totalWeight) * vertexCount : 0;
    return {
      peerId: peer.peerId,
      count: vertexCount >= peers.length ? 1 : 0,
      ideal,
    };
  });

  let remaining = vertexCount - entries.reduce((sum, entry) => sum + entry.count, 0);
  while (remaining > 0) {
    const target = entries
      .slice()
      .sort((first, second) => {
        const firstNeed = first.ideal - first.count;
        const secondNeed = second.ideal - second.count;
        return secondNeed - firstNeed || first.peerId.localeCompare(second.peerId);
      })[0];
    target.count += 1;
    remaining -= 1;
  }
  return entries;
}

function balancedAssignments(vertices, peers) {
  if (vertices.length === 0) {
    return {};
  }
  if (vertices.length < peers.length) {
    return Object.fromEntries(
      vertices.map((vertex) => [vertex.id, assignPeer(vertex.id, peers)]),
    );
  }

  const slots = weightedTargetCounts(vertices.length, peers).flatMap((entry) =>
    Array.from({ length: entry.count }, () => entry.peerId),
  );
  return Object.fromEntries(
    vertices
      .slice()
      .sort(
        (first, second) =>
          stableHash(first.id) - stableHash(second.id) ||
          first.id.localeCompare(second.id),
      )
      .map((vertex, index) => [
        vertex.id,
        slots[index] ?? assignPeer(vertex.id, peers),
      ]),
  );
}

export function partitionForceLayoutGraph(graph, peers = []) {
  const normalizedPeers = normalizePeers(peers);
  const partitionVertices = (graph.vertices ?? []).filter(
    (vertex) => vertex.layoutKind !== "edge-control",
  );
  if (normalizedPeers.length === 0) {
    return {
      format: FORCE_LAYOUT_SHARD_FORMAT,
      version: FORCE_LAYOUT_SHARD_VERSION,
      gologId: graph.gologId,
      peers: [],
      assignments: {},
    };
  }

  const assignments = balancedAssignments(partitionVertices, normalizedPeers);
  // Controls in the same unordered endpoint plane share its first node's owner.
  // The partition proposes work; exact resource claims still authorize commits.
  for (const control of graph.edgeControls ?? (graph.vertices ?? []).filter(
    (vertex) => vertex.layoutKind === "edge-control",
  )) {
    const endpointId = [control.sourceId, control.targetId].sort()[0];
    assignments[control.id] = assignments[endpointId] ?? assignPeer(control.id, normalizedPeers);
  }
  return {
    format: FORCE_LAYOUT_SHARD_FORMAT,
    version: FORCE_LAYOUT_SHARD_VERSION,
    gologId: graph.gologId,
    peers: normalizedPeers.map(({ peer, peerId, weight }) => ({ peer, peerId, weight })),
    assignments,
  };
}

