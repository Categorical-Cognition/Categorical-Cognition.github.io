import * as THREE from "three";
import {
  CONVERGENCE_KINDS,
  convergencePolicyForOperation,
} from "./operation-descriptors.js";
import { DOMAIN_OPERATION_APPLIED_EVENT } from "./domain-operations.js";
import { normalizePeerContext, peerHolderId } from "./peer-context.js";

export const SEMANTIC_CONVERGENCE_CHANGED_EVENT =
  "semantic-convergence:changed";
export const GLOBAL_COHERENCE_FORCE_SOURCE = "global-coherence";
export const DEFAULT_GLOBAL_COHERENCE_STRENGTH = 0.08;
export const GLOBAL_POSITION_AGREEMENT_MODE = "observer-latest-centroid";
export const SEMANTIC_CONVERGENCE_LAYOUT_OBSERVATION_TTL_MS = 8_000;
export const CONVERGENCE_OBSERVATION_SOURCES = Object.freeze({
  LOCAL_APPLIED: "local-applied",
  GLOBAL_COMMIT: "global-commit",
});

function finiteNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function optionalFiniteNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function vector3FromValue(value, fallback = [0, 0, 0]) {
  if (value?.isVector3) {
    return value.clone();
  }
  if (Array.isArray(value)) {
    return new THREE.Vector3(
      finiteNumber(value[0], fallback[0]),
      finiteNumber(value[1], fallback[1]),
      finiteNumber(value[2], fallback[2]),
    );
  }
  if (value && typeof value === "object") {
    return new THREE.Vector3(
      finiteNumber(value.x, fallback[0]),
      finiteNumber(value.y, fallback[1]),
      finiteNumber(value.z, fallback[2]),
    );
  }
  return new THREE.Vector3(...fallback);
}

function positionTargetsFromOperation(operation = {}) {
  const payload = operation.payload ?? {};
  if (
    (operation.type === "sphere:move" || operation.type === "sphere:create") &&
    payload.id &&
    payload.position
  ) {
    return [
      {
        id: String(payload.id),
        coordinate: "position",
        target: vector3FromValue(payload.position),
      },
    ];
  }

  if (operation.type === "layout:commit") {
    return [
      ...(payload.positions ?? [])
      .filter((entry) => entry?.id && entry.position)
      .map((entry) => ({
        id: String(entry.id),
        coordinate: "position",
        target: vector3FromValue(entry.position),
      })),
      ...(payload.edgeControls ?? [])
        .filter((entry) => entry?.id && entry.midpoint)
        .map((entry) => ({
          id: String(entry.id),
          coordinate: "midpoint",
          target: vector3FromValue(entry.midpoint),
        })),
    ];
  }

  return [];
}

export function convergenceTargetsFromOperation(operation = {}) {
  const policy = convergencePolicyForOperation(operation.type);
  if (policy.kind !== CONVERGENCE_KINDS.SMOOTH) {
    return [];
  }
  return positionTargetsFromOperation(operation);
}

function observerKeyForOperation(operation = {}, detail = {}, source = "unknown") {
  const candidates = [
    operation.origin,
    detail.peer,
    detail.commit?.peer,
    detail.commit?.origin,
  ];
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    const peer = normalizePeerContext(candidate);
    if (peer.isKnown) {
      return peerHolderId(peer);
    }
  }
  const fallback = operation.id ?? operation.origin?.source ?? operation.type ?? "unknown";
  return `${source}:${fallback}`;
}

function countObservationSources(observations) {
  const counts = {};
  for (const observation of observations.values()) {
    const source = observation.source ?? "unknown";
    counts[source] = (counts[source] ?? 0) + 1;
  }
  return counts;
}

function agreePositionTarget(observations) {
  const target = new THREE.Vector3();
  let totalWeight = 0;
  for (const observation of observations.values()) {
    const weight = Math.max(0, finiteNumber(observation.weight, 1));
    if (weight <= 0) {
      continue;
    }
    target.add(observation.target.clone().multiplyScalar(weight));
    totalWeight += weight;
  }
  if (totalWeight <= 0) {
    return null;
  }
  return target.multiplyScalar(1 / totalWeight);
}

function isStaleLayoutObservation(observation, now, ttlMs) {
  return (
    observation?.operationType === "layout:commit" &&
    Number.isFinite(ttlMs) &&
    ttlMs >= 0 &&
    now - Number(observation.observedAt ?? 0) > ttlMs
  );
}

function freshObservations(observations, now, ttlMs) {
  return new Map(
    [...observations.entries()].filter(
      ([, observation]) => !isStaleLayoutObservation(observation, now, ttlMs),
    ),
  );
}

function latestObservation(observations) {
  return [...observations.values()].sort(
    (first, second) => Number(second.observedAt ?? 0) - Number(first.observedAt ?? 0),
  )[0] ?? null;
}

function snapshotObservation(observation) {
  return {
    observerKey: observation.observerKey,
    source: observation.source,
    weight: observation.weight,
    target: observation.target.toArray(),
    operationId: observation.operationId,
    operationType: observation.operationType,
    observedAt: observation.observedAt,
  };
}

export class SemanticConvergenceService {
  constructor({
    store,
    bus = store?.bus,
    defaultStrength = DEFAULT_GLOBAL_COHERENCE_STRENGTH,
    localObservationWeight = 1,
    globalObservationWeight = 1,
    layoutObservationTtlMs = SEMANTIC_CONVERGENCE_LAYOUT_OBSERVATION_TTL_MS,
    now = () => Date.now(),
  } = {}) {
    this.store = store;
    this.bus = bus;
    this.defaultStrength = defaultStrength;
    this.localObservationWeight = localObservationWeight;
    this.globalObservationWeight = globalObservationWeight;
    this.layoutObservationTtlMs = layoutObservationTtlMs;
    this.now = now;
    this.positionTargets = new Map();
    this.registerBusHandlers();
  }

  ingestGlobalOperation(operation = {}, detail = {}) {
    return this.ingestOperationObservation(operation, {
      ...detail,
      source: CONVERGENCE_OBSERVATION_SOURCES.GLOBAL_COMMIT,
      weight: detail.weight ?? this.globalObservationWeight,
    });
  }

  ingestLocalOperation(operation = {}, detail = {}) {
    return this.ingestOperationObservation(operation, {
      ...detail,
      source: CONVERGENCE_OBSERVATION_SOURCES.LOCAL_APPLIED,
      weight: detail.weight ?? this.localObservationWeight,
    });
  }

  registerBusHandlers() {
    this.bus?.on(DOMAIN_OPERATION_APPLIED_EVENT, (result) => {
      if (!result?.ok || !result.operation) {
        return;
      }
      this.ingestLocalOperation(result.operation, { result });
    });
  }

  ingestOperationObservation(operation = {}, detail = {}) {
    const policy = convergencePolicyForOperation(operation.type);
    if (policy.kind !== CONVERGENCE_KINDS.SMOOTH) {
      return {
        ok: true,
        kind: policy.kind,
        globalMode: policy.globalMode,
        applyMode: "immediate",
        policy,
        targetCount: 0,
      };
    }

    const targets = convergenceTargetsFromOperation(operation);
    const updatedAt = this.now();
    for (const target of targets) {
      const previous = this.positionTargets.get(target.id);
      const observations = freshObservations(
        new Map(previous?.observations ?? []),
        updatedAt,
        this.layoutObservationTtlMs,
      );
      const observerKey = observerKeyForOperation(
        operation,
        detail,
        detail.source,
      );
      observations.set(observerKey, {
        observerKey,
        source: detail.source ?? "unknown",
        weight: finiteNumber(detail.weight, 1),
        target: target.target.clone(),
        operationId: operation.id ?? null,
        operationType: operation.type ?? null,
        observedAt: updatedAt,
      });
      const agreement = agreePositionTarget(observations);
      const latest = latestObservation(observations);
      this.positionTargets.set(target.id, {
        ...target,
        target: agreement ?? target.target.clone(),
        observedTarget: target.target.clone(),
        agreementMode: GLOBAL_POSITION_AGREEMENT_MODE,
        observationCount: observations.size,
        observations,
        observationSources: countObservationSources(observations),
        lastObservationSource: latest?.source ?? detail.source ?? "unknown",
        lastObserverKey: latest?.observerKey ?? observerKey,
        operationId: latest?.operationId ?? operation.id ?? null,
        operationType: latest?.operationType ?? operation.type ?? null,
        gologId: operation.gologId ?? this.store?.gologId ?? null,
        strength: optionalFiniteNumber(detail.strength ?? policy.strength),
        updatedAt,
      });
    }
    if (targets.length > 0) {
      this.emitChanged(operation, targets);
    }
    return {
      ok: true,
      kind: policy.kind,
      globalMode: policy.globalMode,
      applyMode: "attract",
      policy,
      targetCount: targets.length,
      targets: targets.map((target) => ({
        id: target.id,
        coordinate: target.coordinate,
        observedTarget: target.target.clone(),
        target: this.positionTargets.get(target.id)?.target.clone() ?? target.target.clone(),
      })),
    };
  }

  refreshPositionTargets(now = this.now()) {
    for (const [id, target] of this.positionTargets.entries()) {
      const observations = freshObservations(
        new Map(target.observations ?? []),
        now,
        this.layoutObservationTtlMs,
      );
      if (observations.size === 0) {
        this.positionTargets.delete(id);
        continue;
      }
      if (observations.size === target.observations?.size) {
        continue;
      }
      const latest = latestObservation(observations);
      const agreement = agreePositionTarget(observations);
      this.positionTargets.set(id, {
        ...target,
        target: agreement ?? latest?.target?.clone?.() ?? target.target.clone(),
        observationCount: observations.size,
        observations,
        observationSources: countObservationSources(observations),
        lastObservationSource: latest?.source ?? target.lastObservationSource,
        lastObserverKey: latest?.observerKey ?? target.lastObserverKey,
        operationId: latest?.operationId ?? target.operationId,
        operationType: latest?.operationType ?? target.operationType,
        updatedAt: now,
      });
    }
  }

  intents({ strength = this.defaultStrength } = {}) {
    this.refreshPositionTargets();
    const intents = [];
    for (const target of this.positionTargets.values()) {
      if (!this.store?.spheres?.has(target.id)) {
        continue;
      }
      intents.push({
        kind: "position",
        id: target.id,
        target: target.target.clone(),
        strength: finiteNumber(target.strength, strength),
        source: GLOBAL_COHERENCE_FORCE_SOURCE,
        agreementMode: target.agreementMode,
        observationCount: target.observationCount,
        observedTarget: target.observedTarget?.clone?.() ?? null,
        operationId: target.operationId,
        operationType: target.operationType,
        observationSources: { ...(target.observationSources ?? {}) },
        lastObservationSource: target.lastObservationSource,
        lastObserverKey: target.lastObserverKey,
      });
    }
    return intents;
  }

  snapshot() {
    this.refreshPositionTargets();
    return {
      targetCount: this.positionTargets.size,
      targets: [...this.positionTargets.values()].map((target) => ({
        id: target.id,
        coordinate: target.coordinate,
        target: target.target.toArray(),
        observedTarget: target.observedTarget?.toArray?.() ?? null,
        agreementMode: target.agreementMode,
        observationCount: target.observationCount,
        observationSources: { ...(target.observationSources ?? {}) },
        observations: [...(target.observations?.values?.() ?? [])].map(
          snapshotObservation,
        ),
        lastObservationSource: target.lastObservationSource,
        lastObserverKey: target.lastObserverKey,
        operationId: target.operationId,
        operationType: target.operationType,
        gologId: target.gologId,
        strength: target.strength,
        updatedAt: target.updatedAt,
      })),
    };
  }

  emitChanged(operation, targets) {
    this.bus?.emit(SEMANTIC_CONVERGENCE_CHANGED_EVENT, {
      gologId: operation.gologId ?? this.store?.gologId ?? null,
      operationId: operation.id ?? null,
      operationType: operation.type ?? null,
      targetCount: targets.length,
      targets: targets.map((target) => ({
        id: target.id,
        coordinate: target.coordinate,
        observedTarget: target.target.clone(),
        target: this.positionTargets.get(target.id)?.target.clone() ?? target.target.clone(),
      })),
    });
  }
}

export function createSemanticConvergenceService(options = {}) {
  return new SemanticConvergenceService(options);
}
