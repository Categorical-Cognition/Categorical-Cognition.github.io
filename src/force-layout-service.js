import * as THREE from "three";
import { compileForceField, forceSpecsFromCompiledField } from "./force-field-compiler.js";
import { nodePairEndpoints } from "./domain-object-definitions.js";
import { createElementRegistry } from "./element-registry.js";
import { createNodePairFrameGeometry } from "./frame-service.js";

export const FORCE_LAYOUT_STEP_FORMAT = "golog.force-layout-step";
export const FORCE_LAYOUT_STEP_VERSION = 1;
const DEFAULT_FORCE_DEADBAND = 0.0015;
const DEFAULT_VELOCITY_DEADBAND = 0.0015;

function finiteVector(value, fallback, Vector) {
  const coordinates = Array.isArray(value) ? value : fallback.map(
    (coordinate, index) => value?.[["x", "y", "z"][index]] ?? coordinate,
  );
  if (coordinates.length !== fallback.length || !coordinates.map(Number).every(Number.isFinite)) {
    throw new TypeError("Layout coordinates must be finite numbers");
  }
  return new Vector(...coordinates.map(Number));
}

function vector3(value, fallback = [0, 0, 0]) {
  return finiteVector(value, fallback, THREE.Vector3);
}

function vector2(value, fallback = [0, 0]) {
  return finiteVector(value, fallback, THREE.Vector2);
}

function solverNumber(value, fallback, name, maximum = Infinity) {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number) || number < 0 || number > maximum) {
    throw new RangeError(`Invalid force solver ${name}: ${value}`);
  }
  return number;
}

function clampVectorLength(vector, maxLength) {
  if (Number.isFinite(maxLength) && vector.lengthSq() > maxLength * maxLength) {
    vector.setLength(maxLength);
  }
  return vector;
}

function integrate(position, velocity, force, pinned, options) {
  if (pinned) {
    velocity.multiplyScalar(0);
    return;
  }
  velocity.multiplyScalar(options.damping).addScaledVector(force, options.dt);
  clampVectorLength(velocity, options.maxVelocity);
  zeroBelowDeadband(velocity, options.velocityDeadband);
  position.addScaledVector(velocity, options.dt);
}

function deadbandThreshold(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function positiveScale(value, fallback = 1) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function zeroBelowDeadband(vector, threshold) {
  return threshold > 0 && vector.lengthSq() <= threshold * threshold
    ? vector.set(0, 0, 0)
    : vector;
}

function flattenIntents(value) {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value.flatMap(flattenIntents) : [value];
}

function forceTargetIds(force, context) {
  return Array.isArray(force.targetIds)
    ? [...new Set(force.targetIds)].filter((id) => context.positions.has(id))
    : context.vertexIds;
}

function bodyScale(context, id, scaleKey, explicitScales = null) {
  const explicit = explicitScales?.[id];
  if (explicit !== undefined) {
    return positiveScale(explicit);
  }
  const body = context.bodiesById?.get(id);
  const vertex = context.verticesById?.get(id);
  return positiveScale(
    body?.[scaleKey] ?? vertex?.[scaleKey] ?? body?.mass ?? vertex?.mass,
    1,
  );
}

function chargeScale(context, force, id) {
  return bodyScale(context, id, "chargeScale", force.chargeScales);
}

function centerScale(context, force, id) {
  return bodyScale(context, id, "centerScale", force.centerScales);
}

function edgeControlPoint(control, bend) {
  return vector3(control?.frame?.origin)
    .addScaledVector(vector3(control?.frame?.u, [1, 0, 0]), bend.x)
    .addScaledVector(vector3(control?.frame?.v, [0, 1, 0]), bend.y);
}

function bendFromEdgeControlPoint(control, point) {
  const origin = vector3(control?.frame?.origin);
  const u = vector3(control?.frame?.u, [1, 0, 0]);
  const v = vector3(control?.frame?.v, [0, 1, 0]);
  const offset = vector3(point).sub(origin);
  return new THREE.Vector2(offset.dot(u), offset.dot(v));
}

function edgeControlVectorToWorld(control, bendVector) {
  return new THREE.Vector3()
    .addScaledVector(vector3(control?.frame?.u, [1, 0, 0]), bendVector.x)
    .addScaledVector(vector3(control?.frame?.v, [0, 1, 0]), bendVector.y);
}

// Antisymmetric, identity-based directions separate coincident bodies without
// randomness or dependence on the peer's iteration order.
function separationDirection(firstId, secondId, dimensions = 3) {
  const forward = firstId < secondId;
  const key = JSON.stringify(forward ? [firstId, secondId] : [secondId, firstId]);
  let hash = 2166136261;
  for (let index = 0; index < key.length; index += 1) {
    hash = Math.imul(hash ^ key.charCodeAt(index), 16777619);
  }
  const angle = (hash >>> 0) / 0x100000000 * Math.PI * 2;
  const direction = dimensions === 2
    ? new THREE.Vector2(Math.cos(angle), Math.sin(angle))
    : new THREE.Vector3(Math.cos(angle), Math.sin(angle), Math.sin(angle * 7)).normalize();
  return direction.multiplyScalar(forward ? 1 : -1);
}

function repulsionVector(first, second, strength, minDistance, firstId, secondId) {
  const delta = first.clone().sub(second);
  const distanceSq = delta.lengthSq();
  const direction = distanceSq > 0
    ? delta.normalize()
    : separationDirection(firstId, secondId, delta.isVector2 ? 2 : 3);
  return direction.multiplyScalar(strength / Math.max(distanceSq, minDistance * minDistance));
}

function addPair(context, firstId, secondId, vector, coordinate = "world") {
  context.add(firstId, vector, coordinate);
  context.add(secondId, vector.clone().multiplyScalar(-1), coordinate);
}

function evaluateSpringForce(force, context) {
  const source = context.positions.get(force.sourceId);
  const target = context.positions.get(force.targetId);
  if (!source || !target || force.sourceId === force.targetId) return;
  const delta = target.clone().sub(source);
  const distance = delta.length();
  const direction = distance > 0
    ? delta.multiplyScalar(1 / distance)
    : separationDirection(force.targetId, force.sourceId);
  addPair(context, force.sourceId, force.targetId,
    direction.multiplyScalar((distance - Number(force.restLength ?? 1)) * Number(force.strength ?? 0)));
}

function evaluateChargeForce(force, context) {
  const ids = forceTargetIds(force, context);
  const strength = Number(force.strength ?? 1);
  const minDistance = positiveScale(force.minDistance, 0.1);
  for (let firstIndex = 0; firstIndex < ids.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < ids.length; secondIndex += 1) {
      const firstId = ids[firstIndex];
      const secondId = ids[secondIndex];
      addPair(context, firstId, secondId, repulsionVector(
        context.positions.get(firstId), context.positions.get(secondId),
        strength * chargeScale(context, force, firstId) * chargeScale(context, force, secondId),
        minDistance, firstId, secondId,
      ));
    }
  }
}

function createSpatialChargeCells(force, context) {
  const cellSize = positiveScale(force.cellSize, 6);
  const cells = new Map();
  for (const id of forceTargetIds(force, context)) {
    const position = context.positions.get(id);
    const index = position.toArray().map((value) => Math.floor(value / cellSize));
    const key = index.join(":");
    if (!cells.has(key)) {
      cells.set(key, { key, index, ids: [], centroid: new THREE.Vector3(), charge: 0 });
    }
    const cell = cells.get(key);
    const scale = chargeScale(context, force, id);
    cell.ids.push(id);
    cell.charge += scale;
    cell.centroid.addScaledVector(position, scale);
  }
  for (const cell of cells.values()) cell.centroid.multiplyScalar(1 / cell.charge);
  return [...cells.values()];
}

function evaluateSpatialChargeForce(force, context) {
  const cells = createSpatialChargeCells(force, context);
  const strength = Number(force.strength ?? 1);
  const minDistance = positiveScale(force.minDistance, 0.1);
  const radius = Math.max(0, Number(force.nearCellRadius ?? 1));
  // Visit each cell pair once. Far-cell forces are shared by charge, preserving
  // equal-and-opposite total force just like the exact near-cell calculation.
  for (let firstIndex = 0; firstIndex < cells.length; firstIndex += 1) {
    const first = cells[firstIndex];
    evaluateChargeForce({ ...force, targetIds: first.ids }, context);
    for (let secondIndex = firstIndex + 1; secondIndex < cells.length; secondIndex += 1) {
      const second = cells[secondIndex];
      const near = first.index.every((value, axis) => Math.abs(value - second.index[axis]) <= radius);
      if (near) {
        for (const firstId of first.ids) {
          for (const secondId of second.ids) {
            addPair(context, firstId, secondId, repulsionVector(
              context.positions.get(firstId), context.positions.get(secondId),
              strength * chargeScale(context, force, firstId) * chargeScale(context, force, secondId),
              minDistance, firstId, secondId,
            ));
          }
        }
      } else {
        const vector = repulsionVector(first.centroid, second.centroid,
          strength * first.charge * second.charge, minDistance, first.key, second.key);
        for (const id of first.ids) {
          context.add(id, vector.clone().multiplyScalar(chargeScale(context, force, id) / first.charge));
        }
        for (const id of second.ids) {
          context.add(id, vector.clone().multiplyScalar(-chargeScale(context, force, id) / second.charge));
        }
      }
    }
  }
}

function evaluateCenterForce(force, context) {
  const center = vector3(force.center);
  for (const id of forceTargetIds(force, context)) {
    context.add(id, center.clone().sub(context.positions.get(id))
      .multiplyScalar(Number(force.strength ?? 0) * centerScale(context, force, id)));
  }
}

function evaluateEdgePlaneGravityForce(force, context) {
  const bend = context.edgeControlBends.get(force.targetId);
  if (bend) context.add(force.targetId, bend.clone().multiplyScalar(-Number(force.strength ?? 0)), "edge-bend");
}

function evaluateEdgeControlRepulsionForce(force, context) {
  const controls = (force.controls ?? []).filter((control) => context.edgeControlBends.has(control.id));
  const strength = Number(force.strength ?? 0);
  const minDistance = positiveScale(force.minDistance, 0.18);
  if (strength === 0) return;
  for (let firstIndex = 0; firstIndex < controls.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < controls.length; secondIndex += 1) {
      const first = controls[firstIndex];
      const second = controls[secondIndex];
      if (force.oppositeOnly && !(first.sourceId === second.targetId && first.targetId === second.sourceId)) continue;
      addPair(context, first.id, second.id, repulsionVector(
        context.edgeControlBends.get(first.id), context.edgeControlBends.get(second.id),
        strength, minDistance, first.id, second.id,
      ), "edge-bend");
    }
  }
}

function evaluateTwoSimplexBarycenterForce(force, context) {
  const nodeIds = [...new Set(force.nodeIds ?? [])].filter(
    (id) => context.positions.has(id) && !context.edgeControlsById.has(id),
  );
  if (nodeIds.length < 3) return;
  const barycenter = nodeIds.reduce((sum, id) => sum.add(context.positions.get(id)), new THREE.Vector3())
    .multiplyScalar(1 / nodeIds.length);
  const nodeStrength = Number(force.nodeStrength ?? force.strength ?? 0);
  const edgeStrength = Number(force.edgeStrength ?? force.strength ?? 0);
  if (nodeStrength !== 0) {
    for (const id of nodeIds) context.add(id,
      barycenter.clone().sub(context.positions.get(id)).multiplyScalar(nodeStrength));
  }
  if (edgeStrength !== 0) {
    for (const id of new Set(force.edgeIds ?? [])) {
      const control = context.edgeControlsById.get(id);
      if (control) context.add(id,
        bendFromEdgeControlPoint(control, barycenter).sub(context.edgeControlBends.get(id))
          .multiplyScalar(edgeStrength), "edge-bend");
    }
  }
}

const FORCE_EVALUATORS = {
  spring: evaluateSpringForce,
  charge: evaluateChargeForce,
  "spatial-charge": evaluateSpatialChargeForce,
  center: evaluateCenterForce,
  "edge-plane-gravity": evaluateEdgePlaneGravityForce,
  "edge-control-repulsion": evaluateEdgeControlRepulsionForce,
  "two-simplex-barycenter": evaluateTwoSimplexBarycenterForce,
};

function addIntents(intents, context) {
  for (const intent of flattenIntents(intents)) {
    const normalized = vectorIntent(intent, context);
    if (normalized) context.add(normalized.id, normalized.vector, normalized.coordinate);
  }
}

function vectorIntent(intent, context) {
  if (intent.kind === "edge-bend-vector") {
    return {
      id: intent.id,
      vector: vector2(intent.vector),
      coordinate: "edge-bend",
      source: intent.source ?? "edge-force",
    };
  }
  if (intent.kind === "vector") {
    return {
      id: intent.id,
      vector: vector3(intent.vector),
      coordinate: "world",
      source: intent.source ?? "force",
    };
  }
  if (intent.kind === "position") {
    const current = context.positions.get(intent.id);
    if (!current) {
      return null;
    }
    return {
      id: intent.id,
      vector: vector3(intent.target).sub(current).multiplyScalar(intent.strength ?? 1),
      coordinate: "world",
      source: intent.source ?? "position-intent",
    };
  }
  return null;
}

export class ForceLayoutSimulation {
  constructor(graph, options = {}) {
    this.graph = graph;
    this.vertices = graph.vertices ?? [];
    this.vertexIds = this.vertices.map((vertex) => vertex.id);
    this.nodeIds =
      graph.nodeIds ??
      this.vertices
        .filter((vertex) => vertex.layoutKind !== "edge-control")
        .map((vertex) => vertex.id);
    this.edgeControlIds =
      graph.edgeControlIds ??
      this.vertices
        .filter((vertex) => vertex.layoutKind === "edge-control")
        .map((vertex) => vertex.id);
    const edgeControls =
      graph.edgeControls ??
      this.vertices.filter((vertex) => vertex.layoutKind === "edge-control");
    this.edgeControlsById = new Map(
      edgeControls.map((control) => [control.id, control]),
    );
    this.edgeControlBends = new Map(
      edgeControls.map((control) => [control.id, vector2(control.bend)]),
    );
    this.edgeControlVelocities = new Map(
      edgeControls.map((control) => [control.id, new THREE.Vector2()]),
    );
    this.positions = new Map(
      this.vertices.map((vertex) => [vertex.id, vector3(vertex.position)]),
    );
    this.verticesById = new Map(
      this.vertices.map((vertex) => [vertex.id, vertex]),
    );
    this.velocities = new Map(
      this.vertices.map((vertex) => [vertex.id, new THREE.Vector3()]),
    );
    this.pinned = new Set(
      this.vertices.filter((vertex) => vertex.pinned).map((vertex) => vertex.id),
    );
    this.options = {
      ...options,
      dt: solverNumber(options.dt, 0.6, "dt"),
      damping: solverNumber(options.damping, 0.82, "damping", 1),
      maxVelocity: solverNumber(options.maxVelocity, 1.2, "maxVelocity"),
      forceDeadband: deadbandThreshold(
        options.forceDeadband,
        DEFAULT_FORCE_DEADBAND,
      ),
      velocityDeadband: deadbandThreshold(
        options.velocityDeadband,
        DEFAULT_VELOCITY_DEADBAND,
      ),
    };
    this.elementRegistry =
      options.elementRegistry ??
      options.forceSourceRegistry ??
      createElementRegistry();
    this.elementDeclarations =
      options.elementDeclarations ??
      options.forceSources ??
      this.elementRegistry.collect(graph, options);
    this.forceSources = this.elementDeclarations;
    this.forceField =
      options.forceField ?? compileForceField(this.elementDeclarations, options);
    this.bodiesById = new Map(
      (this.forceField?.bodies ?? []).map((body) => [body.id, body]),
    );
    this.forces = options.forces ?? forceSpecsFromCompiledField(this.forceField);
    this.lastForceTotals = new Map();
    this.tick = 0;
    this.syncEdgeControlWorldPositions();
  }

  syncEdgeControlWorldPositions() {
    for (const id of this.edgeControlIds) {
      const control = this.edgeControlsById.get(id);
      const bend = this.edgeControlBends.get(id);
      if (!control || !bend) {
        continue;
      }
      this.positions.set(id, edgeControlPoint(control, bend));
    }
  }

  refreshEdgeControlFrames() {
    for (const id of this.edgeControlIds) {
      const control = this.edgeControlsById.get(id);
      if (!control) {
        continue;
      }
      const [firstId, secondId] = nodePairEndpoints(
        control.sourceId,
        control.targetId,
      );
      const firstPosition = this.positions.get(firstId);
      const secondPosition = this.positions.get(secondId);
      if (!firstPosition || !secondPosition) {
        continue;
      }
      const geometry = createNodePairFrameGeometry({
        firstPosition,
        secondPosition,
        existingFrame: control.frame,
      });
      control.frame = {
        ...control.frame,
        ...geometry,
      };
    }
  }

  applyPositionEvents(events = []) {
    const edgeEvents = [];
    const pinnedForStep = new Set();
    for (const event of events) {
      if (!this.positions.has(event.id)) {
        continue;
      }
      if (event.pinned || event.pin || event.holdPosition) {
        pinnedForStep.add(event.id);
      }
      if (this.edgeControlsById.has(event.id)) {
        edgeEvents.push(event);
        continue;
      }
      this.positions.set(event.id, vector3(event.position));
      if (event.resetVelocity !== false || pinnedForStep.has(event.id)) {
        this.velocities.set(event.id, new THREE.Vector3());
      }
    }
    this.refreshEdgeControlFrames();
    for (const event of edgeEvents) {
      const control = this.edgeControlsById.get(event.id);
      const point = event.midpoint ?? event.position;
      if (point || event.bend) {
        this.edgeControlBends.set(
          event.id,
          event.bend ? vector2(event.bend) : bendFromEdgeControlPoint(control, point),
        );
        this.positions.set(
          event.id,
          edgeControlPoint(control, this.edgeControlBends.get(event.id)),
        );
      }
      if (event.resetVelocity !== false || pinnedForStep.has(event.id)) {
        this.edgeControlVelocities.set(event.id, new THREE.Vector2());
      }
    }
    this.syncEdgeControlWorldPositions();
    return pinnedForStep;
  }

  context() {
    return {
      graph: this.graph,
      vertexIds: this.vertexIds,
      nodeIds: this.nodeIds,
      edgeControlIds: this.edgeControlIds,
      edgeControlBends: this.edgeControlBends,
      edgeControlsById: this.edgeControlsById,
      positions: this.positions,
      velocities: this.velocities,
      verticesById: this.verticesById,
      bodiesById: this.bodiesById,
      tick: this.tick,
    };
  }

  step({ externalIntents = [], positionEvents = [] } = {}) {
    const pinnedForStep = this.applyPositionEvents(positionEvents);
    const context = this.context();
    const accumulators = new Map(
      this.vertexIds.map((id) => [id, new THREE.Vector3()]),
    );
    const edgeBendAccumulators = new Map(
      this.edgeControlIds.map((id) => [id, new THREE.Vector2()]),
    );
    let intentCount = 0;
    context.add = (id, vector, coordinate = "world") => {
      if (!accumulators.has(id)) return;
      if (![vector.x, vector.y, ...(vector.isVector2 ? [] : [vector.z])].every(Number.isFinite)) {
        throw new TypeError(`Non-finite force for ${id}`);
      }
      const control = this.edgeControlsById.get(id);
      if (control) {
        // All forces on a control meet in its bend plane before deadbanding.
        const bendVector = coordinate === "edge-bend" ? vector : new THREE.Vector2(
          vector.dot(vector3(control.frame.u)), vector.dot(vector3(control.frame.v)),
        );
        edgeBendAccumulators.get(id).add(bendVector);
      } else if (coordinate === "world") {
        accumulators.get(id).add(vector);
      } else return;
      intentCount += 1;
    };
    for (const force of this.forces) {
      if (typeof force.evaluate === "function") addIntents(force.evaluate(context), context);
      else FORCE_EVALUATORS[force.kind]?.(force, context);
    }
    addIntents(externalIntents, context);
    for (const vector of accumulators.values()) {
      zeroBelowDeadband(vector, this.options.forceDeadband);
    }
    for (const vector of edgeBendAccumulators.values()) {
      zeroBelowDeadband(vector, this.options.forceDeadband);
    }
    this.lastForceTotals = new Map(
      [...accumulators.entries()].map(([id, vector]) => [id, vector.clone()]),
    );
    for (const [id, vector] of edgeBendAccumulators.entries()) {
      this.lastForceTotals.set(
        id,
        edgeControlVectorToWorld(this.edgeControlsById.get(id), vector),
      );
    }

    for (const id of this.nodeIds) {
      integrate(this.positions.get(id), this.velocities.get(id), accumulators.get(id),
        this.pinned.has(id) || pinnedForStep.has(id), this.options);
    }
    this.refreshEdgeControlFrames();
    for (const id of this.edgeControlIds) {
      integrate(this.edgeControlBends.get(id), this.edgeControlVelocities.get(id), edgeBendAccumulators.get(id),
        this.pinned.has(id) || pinnedForStep.has(id), this.options);
    }
    this.syncEdgeControlWorldPositions();

    this.tick += 1;
    return this.snapshot({ intentCount });
  }

  run(steps = 1, options = {}) {
    let result = this.snapshot();
    for (let index = 0; index < steps; index += 1) {
      result = this.step(options);
    }
    return result;
  }

  snapshot({ intentCount = 0 } = {}) {
    const edgeControlIdSet = new Set(this.edgeControlIds);
    const nodeIdSet = new Set(this.nodeIds);
    return {
      format: FORCE_LAYOUT_STEP_FORMAT,
      version: FORCE_LAYOUT_STEP_VERSION,
      gologId: this.graph.gologId,
      tick: this.tick,
      forceField: {
        format: this.forceField?.format ?? null,
        sourceCount: this.forceField?.sourceCount ?? 0,
        statistics: { ...(this.forceField?.statistics ?? {}) },
      },
      forceTotals: this.vertexIds.map((id) => ({
        id,
        force: (this.lastForceTotals.get(id) ?? new THREE.Vector3()).clone(),
      })),
      positions: this.vertexIds
        .filter((id) => nodeIdSet.has(id))
        .map((id) => ({
          id,
          position: this.positions.get(id).clone(),
        })),
      edgeControls: this.vertexIds
        .filter((id) => edgeControlIdSet.has(id))
        .map((id) => ({
          id,
          midpoint: this.positions.get(id).clone(),
          bend: this.edgeControlBends.get(id)?.clone?.() ?? new THREE.Vector2(),
        })),
      intentCount,
    };
  }
}

export function createForceLayoutSimulation(graph, options = {}) {
  return new ForceLayoutSimulation(graph, options);
}
