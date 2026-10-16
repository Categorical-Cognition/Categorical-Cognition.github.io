import {
  createDomainOperation,
  DOMAIN_OPERATION_APPLY_EVENT,
} from "./domain-operations.js";
import { createElementRegistry } from "./element-registry.js";
import { compileForceField } from "./force-field-compiler.js";
import { extractForceLayoutGraph } from "./layout-graph-extractor.js";
import { createForceLayoutSimulation } from "./force-layout-service.js";

export const FORCE_LAYOUT_PREVIEW_EVENT = "layout:force-preview";
export const FORCE_LAYOUT_COMMIT_REQUESTED_EVENT = "layout:commit-requested";
const LAYOUT_POSITION_EPSILON_SQ = 1e-12;

function serializePositionEntry(entry) {
  return {
    id: entry.id,
    position: entry.position?.clone?.() ?? entry.position,
  };
}

function serializeEdgeControlEntry(entry) {
  return {
    id: entry.id,
    midpoint: entry.midpoint?.clone?.() ?? entry.midpoint,
  };
}

function intentArray(value) {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function changedNodePositions(store, positions = []) {
  return positions
    .map(serializePositionEntry)
    .filter((entry) => {
      const sphere = store?.spheres?.get(entry.id);
      return (
        sphere &&
        sphere.position.distanceToSquared(entry.position) > LAYOUT_POSITION_EPSILON_SQ
      );
    });
}

function changedEdgeControls(store, edgeControls = []) {
  return edgeControls.filter((entry) => {
    const edge = store?.edges?.get(entry.id);
    if (!edge) return false;
    // Endpoints already determine the frame: its movement is not a bend edit.
    return entry.bend
      ? edge.bend.distanceToSquared(entry.bend) > LAYOUT_POSITION_EPSILON_SQ
      : edge.midpoint.distanceToSquared(entry.midpoint) > LAYOUT_POSITION_EPSILON_SQ;
  }).map(serializeEdgeControlEntry);
}

export class ForceLayoutController {
  constructor({
    store,
    bus = store?.bus,
    origin = { source: "force-layout" },
    graphOptions = {},
    fieldOptions = {},
    solverOptions = {},
    elementRegistry = null,
    forceSourceRegistry = null,
    externalIntentProvider = null,
  } = {}) {
    this.store = store;
    this.bus = bus;
    this.origin = origin;
    this.graphOptions = graphOptions;
    this.fieldOptions = fieldOptions;
    this.solverOptions = solverOptions;
    this.elementRegistry =
      elementRegistry ?? forceSourceRegistry ?? createElementRegistry();
    this.externalIntentProvider = externalIntentProvider;
    this.simulation = null;
  }

  extractGraph(options = {}) {
    return extractForceLayoutGraph(this.store, {
      ...this.graphOptions,
      ...options,
    });
  }

  reset(options = {}) {
    const graph = this.extractGraph(options.graphOptions);
    const sourceOptions = {
      ...this.solverOptions,
      ...this.fieldOptions,
      ...options.solverOptions,
      ...options.fieldOptions,
    };
    const elementDeclarations = this.elementRegistry.collect(
      graph,
      sourceOptions,
    );
    const forceField = compileForceField(elementDeclarations, sourceOptions);
    this.simulation = createForceLayoutSimulation(graph, {
      ...this.solverOptions,
      ...options.solverOptions,
      elementDeclarations,
      forceSources: elementDeclarations,
      forceField,
    });
    return this.simulation;
  }

  ensureSimulation(options = {}) {
    if (!this.simulation) {
      return this.reset(options);
    }
    return this.simulation;
  }

  step(options = {}) {
    const providedIntents =
      typeof this.externalIntentProvider === "function"
        ? this.externalIntentProvider({
            controller: this,
            store: this.store,
            options,
          })
        : [];
    const externalIntents = [
      ...intentArray(providedIntents),
      ...intentArray(options.externalIntents),
    ];
    const result = this.ensureSimulation(options).step({
      ...options,
      externalIntents,
    });
    this.bus?.emit(FORCE_LAYOUT_PREVIEW_EVENT, {
      gologId: this.store.gologId,
      tick: result.tick,
      positions: result.positions.map(serializePositionEntry),
      edgeControls: (result.edgeControls ?? []).map(serializeEdgeControlEntry),
      forceTotals: result.forceTotals.map((entry) => ({
        id: entry.id,
        force: entry.force?.clone?.() ?? entry.force,
      })),
      forceField: result.forceField,
      intentCount: result.intentCount,
    });
    return result;
  }

  run(steps = 1, options = {}) {
    let result = this.ensureSimulation(options).snapshot();
    for (let index = 0; index < steps; index += 1) {
      result = this.step(options);
    }
    return result;
  }

  createCommitOperation(result, options = {}) {
    const rawPositions = (result?.positions ?? result ?? []).map(serializePositionEntry);
    const rawEdgeControls = (result?.edgeControls ?? []).map(serializeEdgeControlEntry);
    const positions =
      options.filterUnchanged === false
        ? rawPositions
        : changedNodePositions(this.store, rawPositions);
    const edgeControls =
      options.filterUnchanged === false
        ? rawEdgeControls
        : changedEdgeControls(this.store, result?.edgeControls ?? []);
    return createDomainOperation(
      this.store,
      "layout:commit",
      {
        layoutId: options.layoutId ?? "force-layout",
        positions,
        edgeControls,
      },
      {
        origin: options.origin ?? this.origin,
      },
    );
  }

  commit(result = this.simulation?.snapshot(), options = {}) {
    const operation = this.createCommitOperation(result, options);
    return this.submitCommitOperation(operation);
  }

  submitCommitOperation(operation) {
    this.bus?.emit(FORCE_LAYOUT_COMMIT_REQUESTED_EVENT, {
      gologId: this.store.gologId,
      operationId: operation.id,
      positionCount: operation.payload.positions.length,
      edgeControlCount: operation.payload.edgeControls?.length ?? 0,
    });
    this.bus?.emit(DOMAIN_OPERATION_APPLY_EVENT, operation);
    return operation;
  }
}

export function createForceLayoutController(options = {}) {
  return new ForceLayoutController(options);
}
