import * as THREE from "three";
import { cloneMetaGologState } from "./meta-golog-service.js";
import { normalizePatchHistory } from "./workspace-patches.js";
import { normalizePayload, PAYLOAD_TYPES } from "./payload-types.js";
import {
  HIERARCHICAL_THETA_SPACE_DEFINITION,
  HIERARCHICAL_THETA_SPACE_SCHEMA,
  hierarchicalThetaCellsFromElements,
  hierarchicalThetaElementsFromCells,
} from "./hierarchical-theta-space-definition.js";
import { DEFAULT_MATH_SCHEMA_REGISTRY } from "./mathematical-schema-registry.js";
import { structureDefinitionFor } from "./structure-definition-registry.js";
import { presheafFromElements } from "./golog-presheaf.js";
import { validateWorkspaceShapeExpansions } from "./shape-expansion.js";

export const GOLOG_WORKSPACE_FORMAT = "golog.workspace";
export const GOLOG_WORKSPACE_VERSION = 1;
export const THETA_SCHEMA = HIERARCHICAL_THETA_SPACE_SCHEMA;

function vectorFromArray(value, fieldName) {
  if (value?.isVector3) {
    return value.clone();
  }
  if (!Array.isArray(value) || value.length !== 3 || !value.every((n) => Number.isFinite(Number(n)))) {
    throw new Error(`${fieldName} must be a three-number array`);
  }
  return new THREE.Vector3(...value.map(Number));
}

function vector2FromArray(value, fieldName) {
  if (value?.isVector2) {
    return value.clone();
  }
  if (!Array.isArray(value) || value.length !== 2 || !value.every((n) => Number.isFinite(Number(n)))) {
    throw new Error(`${fieldName} must be a two-number array`);
  }
  return new THREE.Vector2(...value.map(Number));
}

function serializeGolog(golog, { includeLegacyCells = false } = {}) {
  const definition = structureDefinitionFor({
    structureId: golog.structure?.id ?? golog.state.structure?.id,
    schemaId: golog.structure?.schema ?? golog.state.structure?.schema,
  });
  const elements = definition.serializeElements(golog.state);
  const schema = DEFAULT_MATH_SCHEMA_REGISTRY.schema(definition.schema);
  const record = {
    id: golog.id,
    title: golog.title,
    schema: schema?.id ?? THETA_SCHEMA,
    structure: {
      id: schema?.structureId ?? definition.id,
      schema: schema?.id ?? definition.schema,
      schemaRef: {
        schemaId: schema?.id ?? definition.schema,
      },
    },
    createdAt: golog.createdAt ?? null,
    elements,
  };
  if (includeLegacyCells && definition.id === HIERARCHICAL_THETA_SPACE_DEFINITION.id) {
    record.cells = hierarchicalThetaCellsFromElements(elements);
  }
  return record;
}

function serializeAttachments(workspace) {
  const attachments = [];
  for (const golog of workspace.gologs.values()) {
    for (const record of golog.state.objects.values()) {
      const objectId = record.id;
      const objectRecord = golog.state.getObject(objectId);
      if (!objectRecord) {
        continue;
      }

      for (const payload of golog.state.getPayloads(objectId)) {
        if (!payload?.type) {
          continue;
        }
        const serializedPayload = normalizePayload(payload);
        attachments.push({
          owner: {
            gologId: golog.id,
            objectId,
            kind: serializedOwnerKind(objectRecord),
          },
          payload: serializedPayload,
        });
      }
    }
  }
  return attachments;
}

function serializedOwnerKind(object) {
  if (object.dimension === 0) {
    return "0-cell";
  }
  if (object.dimension === 1) {
    return "1-cell";
  }
  if (object.dimension === 2) {
    return "2-cell";
  }
  return object.kind ?? "object";
}

export function serializeWorkspace(workspace, options = {}) {
  return {
    format: GOLOG_WORKSPACE_FORMAT,
    version: GOLOG_WORKSPACE_VERSION,
    schemas: DEFAULT_MATH_SCHEMA_REGISTRY.exportSchemas(),
    activeGologId: workspace.activeGologId,
    metaGolog: cloneMetaGologState(workspace.metaGolog),
    gologs: [...workspace.gologs.values()].map((golog) =>
      serializeGolog(golog, options),
    ),
    attachments: serializeAttachments(workspace),
    patchHistory: workspace.patchHistory.snapshot(),
  };
}

export function stringifyWorkspaceDocument(workspace) {
  return `${JSON.stringify(serializeWorkspace(workspace), null, 2)}\n`;
}

export function parseWorkspaceDocument(text) {
  let document;
  try {
    document = JSON.parse(text);
  } catch (error) {
    throw new Error(`Unable to parse golog JSON: ${error.message}`);
  }
  return normalizeWorkspaceDocument(document);
}

export function normalizeWorkspaceDocument(document) {
  if (document?.format !== GOLOG_WORKSPACE_FORMAT) {
    throw new Error(`Unsupported golog format: ${document?.format ?? "missing"}`);
  }
  if (document.version !== GOLOG_WORKSPACE_VERSION) {
    throw new Error(`Unsupported golog version: ${document.version ?? "missing"}`);
  }
  if (!Array.isArray(document.gologs)) {
    throw new Error("Serialized workspace must contain a gologs array");
  }
  if (document.gologs.length === 0) {
    throw new Error("Serialized workspace must contain at least one golog");
  }

  const gologIds = new Set();
  for (const golog of document.gologs) {
    if (typeof golog?.id !== "string" || !golog.id) {
      throw new Error("Every serialized golog must have a nonempty string id");
    }
    if (gologIds.has(golog.id)) {
      throw new Error(`Duplicate serialized golog id: ${golog.id}`);
    }
    gologIds.add(golog.id);
  }

  const normalized = {
    format: GOLOG_WORKSPACE_FORMAT,
    version: GOLOG_WORKSPACE_VERSION,
    schemas:
      Array.isArray(document.schemas) && document.schemas.length > 0
        ? document.schemas
        : DEFAULT_MATH_SCHEMA_REGISTRY.exportSchemas(),
    activeGologId: document.activeGologId ?? null,
    metaGolog: cloneMetaGologState(document.metaGolog),
    gologs: document.gologs.map(normalizeGologRecord),
    attachments: (document.attachments ?? []).map(normalizeAttachment),
    patchHistory: normalizePatchHistory(document.patchHistory),
  };
  const byId = new Map(normalized.gologs.map((g) => [g.id, g]));
  const elementIds = new Map(normalized.gologs.map((g) => [g.id,
    new Set(g.elements.map((e) => e.id))]));
  for (const { owner, payload } of normalized.attachments) {
    if (!elementIds.get(owner.gologId)?.has(owner.objectId)) {
      throw new Error(`Attachment owner does not exist: ${owner.gologId}/${owner.objectId}`);
    }
    if (payload.type === PAYLOAD_TYPES.NESTED_GOLOG && !byId.has(payload.targetGologId)) {
      throw new Error(`Nested golog does not exist: ${payload.targetGologId}`);
    }
  }
  validateWorkspaceShapeExpansions(normalized.gologs, normalized.attachments);
  return normalized;
}

function normalizeGologRecord(record) {
  const hasElements = Object.hasOwn(record, "elements");
  if (hasElements && (!Array.isArray(record.elements) &&
    (typeof record.elements !== "object" || record.elements === null))) {
    throw new Error(`Elements must be an array or object map: ${record.id}`);
  }
  const schemaId = record.structure?.schema ?? record.schema;
  const schema = DEFAULT_MATH_SCHEMA_REGISTRY.schema(schemaId);
  if (!schema) {
    throw new Error(`Unsupported golog schema: ${schemaId ?? "missing"}`);
  }

  const definition = structureDefinitionFor({
    structureId: record.structure?.id ?? schema.structureId,
    schemaId: schema.id,
  });
  if (definition.schema !== schema.id) throw new Error(`Structure/schema mismatch: ${record.id}`);
  const serializedElements = Array.isArray(record.elements)
    ? record.elements
    : record.elements && typeof record.elements === "object"
      ? Object.values(record.elements)
      : [];
  const sourceElements = hasElements ? serializedElements
    : Object.values(record.cells ?? {}).flat();
  for (const element of sourceElements) {
    if (!element || typeof element.id !== "string" || !element.id) {
      throw new Error(`Every element in ${record.id} requires a nonempty string id`);
    }
    if (element.schemaRef?.schemaId && element.schemaRef.schemaId !== schema.id) {
      throw new Error(`Element schema mismatch: ${element.id}`);
    }
    const kind = definition.normalizeElementKind(element.elementKind ?? element.kind ?? element.type);
    const expectedRef = DEFAULT_MATH_SCHEMA_REGISTRY.schemaRefForElementKind(kind, element.schemaRef?.objectId);
    const expectedShape = DEFAULT_MATH_SCHEMA_REGISTRY.objectForElementKind(kind, element.schemaRef?.objectId);
    if (kind === "theta-volume" && !expectedShape) throw new Error(`Invalid theta volume shape: ${element.id}`);
    if (expectedRef && Object.keys(expectedRef).some((key) =>
      element.schemaRef?.[key] != null && element.schemaRef[key] !== expectedRef[key])) {
      throw new Error(`Element schema reference mismatch: ${element.id}`);
    }
    if (expectedShape && element.dimension != null && Number(element.dimension) !== expectedShape.dimension) {
      throw new Error(`Element dimension mismatch: ${element.id}`);
    }
  }
  const elements =
    hasElements
      ? serializedElements.map((element) =>
          definition.normalizeSerializedElement(element, {
            vectorFromArray,
            vector2FromArray,
          }),
        )
      : definition.id === HIERARCHICAL_THETA_SPACE_DEFINITION.id
        ? hierarchicalThetaElementsFromCells(normalizeLegacyThetaCells(record.cells ?? {}))
        : [];

  // Check the entire mathematical instance before hydration clears live state.
  presheafFromElements(definition.id, elements);
  for (const element of elements) {
    const expected = DEFAULT_MATH_SCHEMA_REGISTRY.objectForElementKind(element.elementKind, element.schemaRef?.objectId);
    if (element.dimension !== expected.dimension) throw new Error(`Element dimension mismatch: ${element.id}`);
    if (element.dimension === 1 && element.boundary.sourceId === element.boundary.targetId) {
      throw new Error(`The current renderer does not support loop arrows: ${element.id}`);
    }
    if (element.boundary?.edgeIds && new Set(element.boundary.edgeIds).size !== element.boundary.edgeIds.length) {
      throw new Error(`The current renderer requires distinct boundary edges: ${element.id}`);
    }
    if (element.dimension === 2 && !Number.isFinite(element.controlData.controlCoordinate)) {
      throw new Error(`Nonfinite surface coordinate: ${element.id}`);
    }
  }

  return {
    id: String(record.id),
    title: String(record.title ?? record.id),
    schema: schema.id,
    structure: {
      id: definition.id,
      schema: schema.id,
      schemaRef: {
        schemaId: schema.id,
      },
    },
    createdAt: record.createdAt ?? null,
    elements,
  };
}

function normalizeLegacyThetaCells(cells = {}) {
  return {
    zero: (cells.zero ?? []).map((cell) => ({
      id: String(cell.id),
      name: String(cell.name ?? ""),
      position: vectorFromArray(cell.position, `${cell.id}.position`),
    })),
    one: (cells.one ?? []).map((cell) => ({
      id: String(cell.id),
      name: String(cell.name ?? ""),
      sourceId: String(cell.sourceId),
      targetId: String(cell.targetId),
      bend: vector2FromArray(cell.bend ?? [0, 0], `${cell.id}.bend`),
    })),
    two: (cells.two ?? []).map((cell) => ({
      id: String(cell.id),
      name: String(cell.name ?? ""),
      type: cell.type ?? "two-cell",
      edgeIds: [...(cell.edgeIds ?? [])].map(String),
      controlCoordinate: Number(cell.controlCoordinate ?? 0),
    })),
  };
}

function normalizeAttachment(attachment) {
  return {
    owner: {
      gologId: String(attachment.owner?.gologId),
      objectId: String(attachment.owner?.objectId),
      kind: String(attachment.owner?.kind ?? "0-cell"),
    },
    payload: normalizePayload(attachment?.payload),
  };
}

export function hydrateWorkspaceFromDocument({
  workspace,
  document,
  createGolog,
}) {
  const normalized = normalizeWorkspaceDocument(document);
  workspace.patchHistory.suspend(() => {
    workspace.clear();
    workspace.metaGolog = cloneMetaGologState(normalized.metaGolog);

    const gologsById = new Map();
    for (const gologRecord of normalized.gologs) {
      const golog = createGolog({
        id: gologRecord.id,
        title: gologRecord.title,
        createdAt: gologRecord.createdAt,
        structureId: gologRecord.structure.id,
        schema: gologRecord.structure.schema,
        activate: false,
      });
      gologsById.set(golog.id, golog);
    }

    for (const gologRecord of normalized.gologs) {
      hydrateGologState(gologsById.get(gologRecord.id).state, gologRecord);
    }

    applyWorkspaceAttachments(gologsById, normalized.attachments);

    const firstGologId = normalized.gologs[0]?.id ?? null;
    const activeGologId = gologsById.has(normalized.activeGologId)
      ? normalized.activeGologId
      : firstGologId;
    if (activeGologId) {
      workspace.activateGolog(activeGologId);
    } else {
      workspace.emitChanged();
    }
  });
  workspace.patchHistory.restore(normalized.patchHistory);

  return normalized;
}

export function hydrateGologState(state, record) {
  state.spheres.clear();
  state.edges.clear();
  state.surfaces.clear();
  state.volumes.clear();
  state.payloads.clear();
  state.payloadAttachments?.clear?.();
  state.objects.clear();
  state.locks.clear();
  state.selectedSphereId = null;
  state.selectedSimplexId = null;
  state.title = record.title;

  const definition = structureDefinitionFor({
    structureId: record.structure.id,
    schemaId: record.structure.schema,
  });
  state.structure = {
    id: definition.id,
    schema: definition.schema,
    interactionMode: definition.interactionMode ?? "ordinary",
  };
  const elements = [...record.elements].sort(
    (left, right) => Number(left.dimension) - Number(right.dimension),
  );
  for (const element of elements) {
    const created = state.createElement(definition.creationPayload(element));
    if (!created) {
      throw new Error(`Unable to hydrate ${definition.id} element: ${element.id}`);
    }
  }
  state.selectedSphereId = null;
  state.selectedSimplexId = null;
  state.emitStateChanged();
  state.events.selectSphere(null);
  state.events.selectEdge(null);
  state.events.selectSurface(null);
}

function applyWorkspaceAttachments(gologsById, attachments) {
  for (const attachment of attachments) {
    const ownerGolog = gologsById.get(attachment.owner.gologId);
    if (!ownerGolog) {
      continue;
    }

    ownerGolog.state.attachTypedPayload(
      attachment.owner.objectId,
      attachment.payload,
    );
  }
}
