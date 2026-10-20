import * as THREE from "three";
import { evaluateLayoutForces, normalizeLayoutSettings, refreshLayoutFrames } from "./layout-schema.js";
import { layoutSnapshot } from "./layout-graph-extractor.js";

export const FORCE_LAYOUT_STEP_FORMAT = "golog.force-layout-step";
export const FORCE_LAYOUT_STEP_VERSION = 2;

// The public operation adapters still use vectors; packed solver state is numeric.
export function layoutResult(ledger, diagnostics = {}, forces = null) {
  const coordinates = Object.fromEntries(Object.entries(layoutSnapshot(ledger)).map(([key, entries]) =>
    [key, entries.map((entry) => Object.fromEntries(Object.entries(entry).map(([name, value]) =>
      [name, Array.isArray(value) && value.length === 3 ? new THREE.Vector3(...value)
        : Array.isArray(value) && value.length === 2 ? new THREE.Vector2(...value) : value])))]));
  return { format: FORCE_LAYOUT_STEP_FORMAT, version: FORCE_LAYOUT_STEP_VERSION,
    gologId: ledger.gologId, tick: diagnostics.stepCount ?? 0, ...coordinates, diagnostics,
    forceTotals: ledger.rows.filter((row) => row.dof).map((row) => ({ id: row.id,
      force: new THREE.Vector3(...(forces?.subarray(row.index * 3, row.index * 3 + 3) ?? [0, 0, 0])) })) };
}

const quantumValue = new Float32Array(1), quantumBits = new Uint32Array(quantumValue.buffer);
function coordinateQuantum(coordinate, increment) {
  quantumValue[0] = Math.max(Math.abs(coordinate), Math.abs(increment));
  const exponent = (quantumBits[0] >>> 23) & 255;
  quantumBits[0] = (Math.max(exponent, 24) - 23) << 23;
  return quantumValue[0];
}
function roundEven(value) {
  const lower = Math.floor(value), fraction = value - lower;
  return fraction < .5 ? lower : fraction > .5 ? lower + 1 : lower + Math.abs(lower % 2);
}

/** Reference executor for the same sparse coordinate ledger consumed by the GPU. */
export class ForceLayoutSimulation {
  constructor(ledger, options = {}) {
    this.ledger = ledger;
    this.options = normalizeLayoutSettings({ ...ledger.settings, ...options });
    this.activeGroups = new Set(ledger.groups.map((_, index) => index));
    this.quiet = new Uint32Array(ledger.groups.length);
    this.targets = new Float32Array(ledger.rows.length * 4);
    this.residue = new Float32Array(ledger.rows.length * 4);
    this.stepCount = this.dispatchCount = 0;
  }

  setOptions(options) { this.options = normalizeLayoutSettings({ ...this.options, ...options }); this.wake(); }
  setTargets(targets) { this.targets.set(targets); this.wake(); }
  setPins(ids = []) {
    const pins = new Set(ids);
    for (const row of this.ledger.rows) {
      const at = row.index * 4, pinned = pins.has(row.id);
      this.ledger.velocities[at + 3] = pinned ? 1 : 0;
      if (pinned) { this.ledger.velocities.fill(0, at, at + 3); this.residue.fill(0, at, at + 3); }
    }
  }
  updateCoordinates(ids = []) {
    for (const id of ids) {
      const row = this.ledger.rows[this.ledger.idToIndex.get(id)];
      if (row) {
        this.ledger.velocities.fill(0, row.index * 4, row.index * 4 + 3);
        this.residue.fill(0, row.index * 4, row.index * 4 + 3);
      }
    }
    refreshLayoutFrames(this.ledger);
    this.wake(ids);
  }
  wake(ids = null) {
    const groups = ids == null ? this.ledger.groups.map((_, index) => index)
      : [...ids].map((id) => this.ledger.rows[this.ledger.idToIndex.get(id)]?.group).filter((group) => group != null);
    for (const group of groups) { this.activeGroups.add(group); this.quiet[group] = 0; }
  }

  step(options = {}) {
    const count = typeof options === "number" ? options : 1;
    for (let iteration = 0; iteration < count && this.activeGroups.size; iteration++) {
      refreshLayoutFrames(this.ledger, this.activeGroups);
      const { forces, stiffness } = evaluateLayoutForces(this.ledger, this.options, this.activeGroups);
      const { coordinates: q, velocities: v, rows, groups } = this.ledger;
      const quiet = new Uint8Array(groups.length).fill(1);
      const o = this.options;
      for (const row of rows) {
        if (!this.activeGroups.has(row.group)) continue;
        const at = row.index * 4, forceAt = row.index * 3;
        if (!row.dof || v[at + 3]) { v.fill(0, at, at + 3); this.residue.fill(0, at, at + 3); continue; }
        const weight = this.targets[at + 3];
        for (let axis = 0; axis < row.dof; axis++) forces[forceAt + axis] += weight * (this.targets[at + axis] - q[at + axis]);
        const k = stiffness[row.index] + weight;
        const frequency = Math.sqrt(k), dt = Math.min(o.dt, 0.5 / Math.max(frequency, 1e-4));
        const damping = 2 * o.dampingRatio * frequency;
        const wdt = frequency * dt, decay = Math.exp(-wdt);
        const response = wdt < .01 ? wdt * wdt * (.5 - wdt / 3 + wdt * wdt / 8 - wdt * wdt * wdt / 30)
          : 1 - (1 + wdt) * decay;
        let forceSquared = 0, velocitySquared = 0;
        for (let axis = 0; axis < row.dof; axis++) forceSquared += forces[forceAt + axis] ** 2;
        const restingForce = forceSquared <= o.forceThreshold ** 2;
        for (let axis = 0; axis < row.dof; axis++) {
          const force = restingForce ? 0 : forces[forceAt + axis];
          const velocity = v[at + axis];
          let delta;
          if (o.dampingRatio === 1 && k > 1e-8) {
            delta = velocity * dt * decay + force / k * response;
            v[at + axis] = (velocity * (1 - wdt) + force * dt) * decay;
          } else if (k <= 1e-8) {
            delta = velocity * dt + force * dt * dt / 2;
            v[at + axis] += force * dt;
          } else {
            v[at + axis] = (velocity + dt * force) / (1 + dt * damping);
            delta = dt * v[at + axis];
          }
          // Retain sub-ULP motion with the same explicit rounding as the GPU.
          const increment = Math.fround(Math.fround(delta) + this.residue[at + axis]);
          const quantum = coordinateQuantum(q[at + axis], increment);
          const rounded = roundEven(increment / quantum) * quantum;
          this.residue[at + axis] = increment - rounded;
          q[at + axis] += rounded;
          velocitySquared += v[at + axis] ** 2;
        }
        if (!restingForce || velocitySquared > o.velocityThreshold ** 2) quiet[row.group] = 0;
      }
      for (const group of this.activeGroups) {
        this.quiet[group] = quiet[group] ? this.quiet[group] + 1 : 0;
        if (this.quiet[group] < o.sleepSteps) continue;
        this.activeGroups.delete(group);
        for (const index of groups[group]) {
          v.fill(0, index * 4, index * 4 + 3);
          this.residue.fill(0, index * 4, index * 4 + 3);
        }
      }
      this.lastForces = forces;
      this.stepCount++; this.dispatchCount++;
    }
    refreshLayoutFrames(this.ledger);
    return this.snapshot();
  }

  diagnostics() {
    return { backend: "cpu-reference", stepCount: this.stepCount, dispatchCount: this.dispatchCount,
      activeGroupCount: this.activeGroups.size, sleepingGroupCount: this.ledger.groups.length - this.activeGroups.size,
      bodyCount: this.ledger.rows.length, groupCount: this.ledger.groups.length,
      subscriptionCount: this.ledger.rows.reduce((n, row) => n + row.cofaceSources.length, 0),
      interactionWork: { ...this.ledger.work },
      topologyVersion: this.ledger.topologyVersion ?? 0 };
  }
  snapshot() { return layoutResult(this.ledger, this.diagnostics(), this.lastForces); }
  flush() { return this.snapshot(); }
  dispose() { this.activeGroups.clear(); }
}

export function createForceLayoutSimulation(ledger, options = {}) {
  return new ForceLayoutSimulation(ledger, options);
}
