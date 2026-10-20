import { createDomainOperation, DOMAIN_OPERATION_APPLY_EVENT } from "./domain-operations.js";
import { compileLayout, refreshLayoutCoordinates } from "./layout-graph-extractor.js";
import { createForceLayoutSimulation, layoutResult } from "./force-layout-service.js";
import { layoutEntryCoordinates, layoutCoordinateSignature, normalizeLayoutSettings } from "./layout-schema.js";
import { GPUForceLayout } from "./gpu-force-layout.js";

export const FORCE_LAYOUT_PREVIEW_EVENT = "layout:force-preview";
export const FORCE_LAYOUT_COMMIT_REQUESTED_EVENT = "layout:commit-requested";
export const LAYOUT_COORDINATE_FIELDS = Object.freeze(["positions", "edgeControls", "surfaceControls"]);
const array = (value) => value?.toArray?.() ?? (Array.isArray(value) ? value : [value]);

export function coordinateSnapshot(result = {}) {
  return new Map(LAYOUT_COORDINATE_FIELDS.flatMap((field) => (result[field] ?? []).map((entry) =>
    [entry.id, layoutEntryCoordinates(entry)])));
}
export function filterLayoutResult(result, predicate) {
  return { ...result, ...Object.fromEntries(LAYOUT_COORDINATE_FIELDS.map((field) =>
    [field, (result?.[field] ?? []).filter(predicate)])) };
}
export function changedLayoutResult(result, previous, epsilon = 1e-6) {
  const next = coordinateSnapshot(result);
  return filterLayoutResult(result, (entry) => {
    const before = previous.get(entry.id), after = next.get(entry.id);
    return !before || before.length !== after.length || Math.hypot(...after.map((value, i) => value - before[i])) > epsilon;
  });
}
export function layoutResultSize(result) {
  return LAYOUT_COORDINATE_FIELDS.reduce((sum, key) => sum + (result?.[key]?.length ?? 0), 0);
}

export class ForceLayoutController {
  constructor({ store, bus = store?.bus, origin = { source: "force-layout" },
    renderer = null, renderAdapter = null, solverOptions = {}, externalIntentProvider = null } = {}) {
    Object.assign(this, { store, bus, origin, renderer, renderAdapter, solverOptions, externalIntentProvider });
    this.simulation = null;
    this.topologyVersion = 0;
  }
  extractGraph() { return this.ledger ?? compileLayout(this.store, this.solverOptions); }
  reset(options = {}) {
    this.simulation?.dispose();
    this.targets = null;
    this.targetSignature = null;
    this.pinSignature = null;
    const settings = { ...this.solverOptions, ...options.settings, ...options.solverOptions };
    this.ledger = compileLayout(this.store, settings);
    this.ledger.topologyVersion = ++this.topologyVersion;
    this.simulation = GPUForceLayout.supported(this.renderer) && this.ledger.rows.length <= this.renderer.capabilities.maxTextureSize
      ? new GPUForceLayout(this.renderer, this.ledger, this.ledger.settings)
      : createForceLayoutSimulation(this.ledger, this.ledger.settings);
    this.renderAdapter?.(this.simulation instanceof GPUForceLayout ? this.simulation : null, () => this.flush(), this);
    return this.simulation;
  }
  ensureSimulation(options = {}) { return this.simulation ?? this.reset(options); }
  get resident() { return this.simulation instanceof GPUForceLayout; }
  diagnostics() { return this.ensureSimulation().diagnostics(); }
  wake(ids = null) { this.simulation?.wake(ids); }
  setOptions(settings = {}) {
    this.solverOptions = normalizeLayoutSettings({ ...this.solverOptions, ...settings });
    if (this.ledger) this.ledger.settings = this.solverOptions;
    this.simulation?.setOptions(this.solverOptions);
  }
  readHandle(id) {
    const current = this.refreshInputs?.() ?? this;
    return current.resident ? current.simulation.readHandle(id) : null;
  }
  readPosition(id) {
    const current = this.refreshInputs?.() ?? this;
    return current.resident ? current.simulation.readPosition(id) : null;
  }
  moveHandle(id, target) {
    const current = this.refreshInputs?.() ?? this;
    if (!current.localInteraction || !current.resident) return false;
    const moved = current.simulation.moveHandle(id, target);
    if (moved) current.onResidentMotion?.();
    return moved;
  }
  releaseHandle(id) {
    const current = this.refreshInputs?.() ?? this;
    const released = current.resident ? current.simulation.releaseHandle(id) : false;
    if (released) current.onResidentMotion?.();
    return released;
  }

  syncInputs({ ids = [], pinIds = [], externalIntents = [] } = {}) {
    const simulation = this.ensureSimulation();
    const pinSignature = [...pinIds].sort().join("\0");
    const pinsChanged = pinSignature !== this.pinSignature;
    if (ids.length || pinsChanged) refreshLayoutCoordinates(this.ledger, this.store, { ids, pinIds, resident: this.resident });
    if (this.resident && (ids.length || pinsChanged)) simulation.uploadInputs({ ids, pinIds: pinsChanged ? pinIds : null });
    else if (!this.resident) {
      if (ids.length) simulation.updateCoordinates(ids);
      if (pinsChanged) { simulation.setPins(pinIds); simulation.wake(); }
    }
    this.pinSignature = pinSignature;
    const intents = externalIntents.flat(Infinity).filter(Boolean);
    const signature = JSON.stringify(intents.map(({ id, coordinate, target, strength }) =>
      [id, coordinate, target && array(target), strength]));
    if (signature === this.targetSignature) return;
    this.targetSignature = signature;
    if (!intents.length && !this.targets) return;
    const targets = this.targets ?? new Float32Array(this.ledger.rows.length * 4), worldIds = [];
    targets.fill(0);
    for (const intent of intents) {
      const row = this.ledger.rows[this.ledger.idToIndex.get(intent.id)];
      if (!row || !row.dof || !intent.target) continue;
      const target = array(intent.target), at = row.index * 4;
      const frame = row.index * 16;
      for (let axis = 0; axis < row.dof; axis++) {
        targets[at + axis] = intent.coordinate === "local" || this.resident ? Number(target[axis] ?? 0)
          : [0, 1, 2].reduce((sum, j) => sum + (target[j] - this.ledger.frames[frame + j])
            * this.ledger.frames[frame + (axis + 1) * 4 + j], 0);
      }
      if (this.resident && intent.coordinate !== "local") {
        targets.set(target.slice(0, 3), at); worldIds.push(intent.id);
      }
      targets[at + 3] = Math.max(0, Number(intent.strength ?? 0));
    }
    simulation.setTargets(targets, worldIds); this.targets = targets;
  }

  step(options = {}) {
    const simulation = this.ensureSimulation(options);
    if (options.positionEvents) this.syncInputs({ ids: options.positionEvents.map((event) => event.id),
      pinIds: options.positionEvents.filter((event) => event.pinned).map((event) => event.id),
      externalIntents: options.externalIntents });
    simulation.step(options.steps ?? 1);
    if (this.resident && options.resident) return { resident: true, diagnostics: simulation.diagnostics() };
    const result = this.flush();
    this.bus?.emit(FORCE_LAYOUT_PREVIEW_EVENT, result);
    return result;
  }
  flush() {
    const simulation = this.ensureSimulation();
    if (!this.resident) return simulation.snapshot();
    const snapshot = simulation.flush();
    for (const key of ["coordinates", "velocities", "worlds", "frames"]) this.ledger[key].set(snapshot[key]);
    return layoutResult(this.ledger, snapshot.diagnostics);
  }
  async snapshot() {
    const simulation = this.ensureSimulation(), ledger = this.ledger;
    if (!this.resident) return simulation.snapshot();
    const snapshot = await simulation.snapshot();
    // A delayed publication never overwrites the executor's current inputs.
    return layoutResult({ ...ledger, ...snapshot }, snapshot.diagnostics);
  }
  run(steps = 1, options = {}) {
    this.ensureSimulation(options);
    for (let i = 0; i < steps; i++) this.step({ ...options, resident: true });
    return this.flush();
  }
  createCommitOperation(result, options = {}) {
    this.ensureSimulation();
    let patch = Array.isArray(result) ? { positions: result } : result ?? this.flush();
    if (options.filterUnchanged !== false) patch = changedLayoutResult(patch,
      new Map(this.ledger.rows.filter((row) => row.dof).map((row) =>
        [row.id, layoutCoordinateSignature(row, this.store)])));
    return createDomainOperation(this.store, "layout:commit", {
      layoutId: options.layoutId ?? "force-layout",
      ...Object.fromEntries(LAYOUT_COORDINATE_FIELDS.map((key) => [key, patch[key] ?? []])),
    }, { origin: options.origin ?? this.origin });
  }
  commit(result = this.flush(), options = {}) { return this.submitCommitOperation(this.createCommitOperation(result, options)); }
  submitCommitOperation(operation) {
    this.bus?.emit(FORCE_LAYOUT_COMMIT_REQUESTED_EVENT, {
      gologId: this.store.gologId, operationId: operation.id,
      coordinateCount: layoutResultSize(operation.payload),
    });
    this.bus?.emit(DOMAIN_OPERATION_APPLY_EVENT, operation);
    return operation;
  }
  dispose() { this.renderAdapter?.(null); this.simulation?.dispose(); this.simulation = null; }
}
export function createForceLayoutController(options = {}) { return new ForceLayoutController(options); }
