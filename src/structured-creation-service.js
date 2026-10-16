import * as THREE from "three";
import { ELEMENT_KINDS } from "./element-registry.js";

function vector3FromValue(value, fieldName = "position") {
  if (value?.isVector3) {
    return value.clone();
  }
  if (!Array.isArray(value) || value.length !== 3) {
    throw new Error(`${fieldName} must be a three-number array`);
  }
  return new THREE.Vector3(...value.map(Number));
}

function vector2FromValue(value, fieldName = "bend") {
  if (value?.isVector2) {
    return value.clone();
  }
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error(`${fieldName} must be a two-number array`);
  }
  return new THREE.Vector2(...value.map(Number));
}

export class StructuredCreationService {
  constructor({ workspace, createGolog }) {
    this.workspace = workspace;
    this.createGolog = createGolog;
  }

  gologOrThrow(gologId) {
    const resolvedId = gologId ?? this.workspace.activeGologId;
    const golog = this.workspace.gologs.get(resolvedId);
    if (!golog) {
      throw new Error(`Golog does not exist: ${resolvedId}`);
    }
    return golog;
  }

  createGologRecord({
    id = null,
    title = null,
    activate = false,
    structureId = null,
    schema = null,
  } = {}) {
    return this.createGolog({ id, title, activate, structureId, schema });
  }

  applyOperation(golog, type, payload) {
    const result = golog.state.operationPipeline.submit(type, payload, {
      origin: { source: "structured-creation-service", role: "system" },
    });
    if (!result.ok) {
      throw new Error(`Structured operation rejected: ${result.reason ?? type}`);
    }
    return result;
  }

  createNode({
    gologId,
    position = [0, 0, 0],
    name = "",
    payload = null,
  } = {}) {
    const golog = this.gologOrThrow(gologId);
    const state = golog.state;
    const id = `sphere-${state.nextSphereId}`;
    this.applyOperation(golog, "element:create", {
      elementKind: ELEMENT_KINDS.ZERO_SIMPLEX,
      id,
      position: vector3FromValue(position),
    });

    const sphere = state.spheres.get(id);
    if (!sphere) {
      throw new Error(`Node creation failed: ${id}`);
    }

    if (name) {
      this.applyOperation(golog, "simplex:rename", { id, name });
    }
    this.attachPayload({
      gologId: golog.id,
      objectId: id,
      payload,
    });
    return {
      golog,
      id,
      object: state.getObject(id),
      sphere,
    };
  }

  createEdge({
    gologId,
    sourceId,
    targetId,
    name = "",
    bend = null,
    payload = null,
  } = {}) {
    if (!sourceId || !targetId) {
      throw new Error("createEdge requires sourceId and targetId");
    }

    const golog = this.gologOrThrow(gologId);
    const state = golog.state;
    const id = `edge-${state.nextEdgeId}`;
    this.applyOperation(golog, "element:create", {
      elementKind: ELEMENT_KINDS.ONE_SIMPLEX,
      id,
      sourceId: String(sourceId),
      targetId: String(targetId),
    });

    const edge = state.edges.get(id);
    if (!edge) {
      throw new Error(`Edge creation failed: ${id}`);
    }

    if (name) {
      this.applyOperation(golog, "simplex:rename", { id, name });
    }
    if (bend) {
      const frame = state.syncNodePairFrame(edge.sourceId, edge.targetId);
      this.applyOperation(golog, "edge:move-midpoint", {
        id,
        midpoint: state.pointFromFrameBend(frame, vector2FromValue(bend)),
      });
    }
    this.attachPayload({
      gologId: golog.id,
      objectId: id,
      payload,
    });
    return {
      golog,
      id,
      object: state.getObject(id),
      edge,
    };
  }

  attachPayload({ gologId, objectId, payload }) {
    if (!payload) {
      return true;
    }

    const golog = this.gologOrThrow(gologId);
    if (payload.type === "text/markdown") {
      return this.applyOperation(golog, "payload:text-add", {
        id: objectId,
        text: payload.text ?? "",
      }).ok;
    }
    if (payload.type === "nested-golog") {
      return this.applyOperation(golog, "payload:golog-attach", {
        id: objectId,
        targetGologId: payload.targetGologId,
        rootObjectId: payload.rootObjectId,
      }).ok;
    }
    throw new Error(`Unsupported payload type: ${payload.type ?? "missing"}`);
  }
}
