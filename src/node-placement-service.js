import * as THREE from "three";

export const DEFAULT_COMPACT_NODE_SPACING = 1.35;

function vectorFromValue(value) {
  if (value?.isVector3) {
    return value;
  }
  if (Array.isArray(value) && value.length === 3) {
    return new THREE.Vector3(...value.map(Number));
  }
  if (
    value &&
    Number.isFinite(value.x) &&
    Number.isFinite(value.y) &&
    Number.isFinite(value.z)
  ) {
    return new THREE.Vector3(value.x, value.y, value.z);
  }
  return null;
}

function shellCandidates(shell, spacing) {
  if (shell === 0) {
    return [new THREE.Vector3(0, 0, 0)];
  }
  const candidates = [];
  for (let x = -shell; x <= shell; x += 1) {
    for (let y = -shell; y <= shell; y += 1) {
      for (let z = -shell; z <= shell; z += 1) {
        if (Math.max(Math.abs(x), Math.abs(y), Math.abs(z)) !== shell) {
          continue;
        }
        candidates.push(new THREE.Vector3(x * spacing, y * spacing, z * spacing));
      }
    }
  }
  candidates.sort((first, second) => {
    const radiusDelta = first.lengthSq() - second.lengthSq();
    if (Math.abs(radiusDelta) > 1e-12) {
      return radiusDelta;
    }
    return first.z - second.z || first.y - second.y || first.x - second.x;
  });
  return candidates;
}

function isAvailable(candidate, occupied, minDistanceSq) {
  return occupied.every(
    (position) => candidate.distanceToSquared(position) >= minDistanceSq,
  );
}

export function findCompactNodePosition(
  existingPositions = [],
  {
    spacing = DEFAULT_COMPACT_NODE_SPACING,
    minDistance = spacing * 0.92,
    maxShell = 64,
  } = {},
) {
  const occupied = existingPositions
    .map((position) => vectorFromValue(position))
    .filter(Boolean);
  const minDistanceSq = minDistance * minDistance;

  for (let shell = 0; shell <= maxShell; shell += 1) {
    for (const candidate of shellCandidates(shell, spacing)) {
      if (isAvailable(candidate, occupied, minDistanceSq)) {
        return candidate;
      }
    }
  }

  return new THREE.Vector3((maxShell + 1) * spacing, 0, 0);
}
