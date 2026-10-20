import * as THREE from "three";
import { serializeWorkspace, stringifyWorkspaceDocument } from "./workspace-serialization.js";
import {
  clonePatchValue,
  normalizePatchOperation,
  parseGologPatchPath,
} from "./workspace-patches.js";
import { createForceLayoutController } from "./force-layout-controller.js";
import {
  ELEMENT_KINDS,
  normalizeElementKind,
  VIRTUAL_DOUBLE_ELEMENT_KINDS,
} from "./element-registry.js";
import { VIRTUAL_DOUBLE_CATEGORY_STRUCTURE_ID } from "./virtual-double-category-schema.js";
import { DEFAULT_MATH_SCHEMA_REGISTRY } from "./mathematical-schema-registry.js";
import {
  codePayloadType,
  imagePayloadType,
  normalizePayload,
  payloadAttachmentKey,
  payloadHasText,
  payloadKind,
  payloadSearchText,
  PAYLOAD_TYPES,
} from "./payload-types.js";
import { renderLatexSnippetToHtml } from "./latex-renderer.js";
import { browserRuntimeConfig, STATIC_LATEX_COMPILE_MESSAGE } from "./runtime-config.js";
import { createShapeExpansion, inspectShapeExpansion, normalizeShapeExpansionPayload,
  assertShapeExpansionDeletionAllowed } from "./shape-expansion.js";
import { gologPublication, publicationFingerprint, retractGologPublication,
  assertGologPublicationRetractionAllowed } from "./golog-publication.js";

export const GOLOG_AGENT_API_FORMAT = "golog.agent-api";
export const GOLOG_AGENT_API_VERSION = 1;

const COLLECTION_KIND = {
  spheres: "0-simplex",
  edges: "1-simplex",
  surfaces: "2-simplex",
  volumes: "theta-volume",
};

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function numberArray(value, length) {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every((entry) => Number.isFinite(Number(entry)))
  );
}

function vector3FromAgent(value, fieldName) {
  if (!numberArray(value, 3)) {
    throw new Error(`${fieldName} must be a three-number array`);
  }
  return new THREE.Vector3(...value.map(Number));
}

function vector2FromAgent(value, fieldName) {
  if (!numberArray(value, 2)) {
    throw new Error(`${fieldName} must be a two-number array`);
  }
  return new THREE.Vector2(...value.map(Number));
}

function payloadSummary(
  payload,
  { includePayloadText = false, includePayloadData = false } = {},
) {
  if (!payload) {
    return null;
  }
  const kind = payloadKind(payload);
  if (kind === "markdown" || kind === "latex" || kind === "code") {
    return {
      type: payload.type,
      kind,
      ...(payload.language ? { language: payload.language } : {}),
      ...(kind === "latex"
        ? {
            documentKind: payload.documentKind ?? "snippet",
            title: payload.title ?? "",
            latexUrl: payload.latexUrl ?? "",
            preambleUrl: payload.preambleUrl ?? "",
            standaloneLatexUrl: payload.standaloneLatexUrl ?? "",
            imageUrl: payload.imageUrl ?? payload.pngUrl ?? payload.previewUrl ?? "",
            imageDataUrlLength: String(
              payload.imageDataUrl ??
                payload.pngDataUrl ??
                payload.previewDataUrl ??
                "",
            ).length,
            pdfUrl: payload.pdfUrl ?? "",
            sourcePngUrl: payload.sourcePngUrl ?? "",
            reconstructionStatus: payload.reconstructionStatus ?? "",
            ...(includePayloadData
              ? {
                  imageDataUrl:
                    payload.imageDataUrl ??
                    payload.pngDataUrl ??
                    payload.previewDataUrl ??
                    "",
                }
              : {}),
          }
        : {}),
      textLength: String(payload.text ?? "").length,
      ...(includePayloadText ? { text: payload.text ?? "" } : {}),
    };
  }
  if (kind === "image") {
    return {
      type: payload.type,
      kind,
      mimeType: payload.mimeType ?? payload.type,
      srcLength: String(payload.src ?? "").length,
      alt: payload.alt ?? "",
      name: payload.name ?? "",
      ...(includePayloadData ? { src: payload.src ?? "" } : {}),
    };
  }
  if (kind === "url") {
    return {
      type: payload.type,
      kind,
      url: payload.url ?? "",
      title: payload.title ?? "",
      descriptionLength: String(payload.description ?? "").length,
      ...(includePayloadText ? { description: payload.description ?? "" } : {}),
    };
  }
  if (kind === "nested-golog") {
    return {
      type: payload.type,
      kind,
      targetGologId: payload.targetGologId,
      ...(payload.rootObjectId ? { rootObjectId: payload.rootObjectId } : {}),
    };
  }

  return { type: payload.type ?? "unknown" };
}

function surfaceKind(surface) {
  return surface.type === "two-simplex" ? "2-simplex" : "2-cell";
}

function payloadSummariesForObject(golog, objectId, options = {}) {
  return (golog.state.getPayloads?.(objectId) ?? [
    golog.state.getPayload(objectId),
  ].filter(Boolean)).map((payload) => payloadSummary(payload, options));
}

function summarizeSphere(golog, sphere, options = {}) {
  const payload = golog.state.getPayload(sphere.id);
  const payloads = payloadSummariesForObject(golog, sphere.id, options);
  const objectRecord = golog.state.getObject(sphere.id);
  return {
    gologId: golog.id,
    objectId: sphere.id,
    kind: "0-simplex",
    elementKind: objectRecord?.elementKind ?? sphere.elementKind ?? "0-simplex",
    dimension: 0,
    schemaRef: objectRecord?.schemaRef ?? null,
    name: sphere.name ?? "",
    position: clonePatchValue(sphere.position),
    childGologId: sphere.childGologId ?? null,
    payload: payloadSummary(payload, options),
    payloads,
  };
}

function summarizeEdge(golog, edge, options = {}) {
  const objectRecord = golog.state.getObject(edge.id);
  const payload = golog.state.getPayload(edge.id);
  const payloads = payloadSummariesForObject(golog, edge.id, options);
  return {
    gologId: golog.id,
    objectId: edge.id,
    kind: "1-simplex",
    elementKind: objectRecord?.elementKind ?? edge.elementKind ?? "1-simplex",
    arrowKind: edge.arrowKind ?? edge.elementKind ?? "1-simplex",
    dimension: 1,
    schemaRef: objectRecord?.schemaRef ?? null,
    name: edge.name ?? "",
    sourceId: edge.sourceId,
    targetId: edge.targetId,
    bend: clonePatchValue(edge.bend),
    midpoint: clonePatchValue(edge.midpoint),
    payload: payloadSummary(payload, options),
    payloads,
  };
}

function summarizeSurface(golog, surface, options = {}) {
  const objectRecord = golog.state.getObject(surface.id);
  const payload = golog.state.getPayload(surface.id);
  const payloads = payloadSummariesForObject(golog, surface.id, options);
  return {
    gologId: golog.id,
    objectId: surface.id,
    kind: surfaceKind(surface),
    elementKind: objectRecord?.elementKind ?? surface.elementKind ?? surfaceKind(surface),
    dimension: 2,
    schemaRef: objectRecord?.schemaRef ?? null,
    name: surface.name ?? "",
    type: surface.type,
    edgeIds: [...surface.edgeIds],
    nodeIds: surface.nodeIds ? [...surface.nodeIds] : null,
    controlCoordinate: surface.controlCoordinate,
    controlPoint: clonePatchValue(surface.controlPoint),
    ...(surface.topPathIds
      ? {
          topPathIds: [...surface.topPathIds],
          bottomArrowId: surface.bottomArrowId,
          leftArrowId: surface.leftArrowId,
          rightArrowId: surface.rightArrowId,
        }
      : {}),
    payload: payloadSummary(payload, options),
    payloads,
  };
}

function collectGologObjects(golog, options = {}) {
  return [
    ...[...golog.state.spheres.values()].map((sphere) =>
      summarizeSphere(golog, sphere, options),
    ),
    ...[...golog.state.edges.values()].map((edge) =>
      summarizeEdge(golog, edge, options),
    ),
    ...[...golog.state.surfaces.values()].map((surface) =>
      summarizeSurface(golog, surface, options),
    ),
    ...[...(golog.state.volumes?.values() ?? [])].map((volume) => ({
      gologId: golog.id,
      objectId: volume.id,
      kind: "theta-volume",
      elementKind: "theta-volume",
      dimension: 3,
      schemaRef: volume.schemaRef,
      name: volume.name ?? "",
      faces: { ...volume.faces },
      boundaryFaceIds: [...volume.boundaryFaceIds],
      payload: payloadSummary(golog.state.getPayload(volume.id), options),
      payloads: payloadSummariesForObject(golog, volume.id, options),
    })),
  ];
}

export function exportWorkspaceForAgents(workspace, options = {}) {
  const gologs = [...workspace.gologs.values()].map((golog) => ({
    id: golog.id,
    title: golog.title,
    isActive: golog.id === workspace.activeGologId,
    createdAt: golog.createdAt ?? null,
    structure: golog.structure
      ? { id: golog.structure.id, schema: golog.structure.schema }
      : null,
    counts: {
      objects:
        golog.state.spheres.size +
        golog.state.edges.size +
        golog.state.surfaces.size + (golog.state.volumes?.size ?? 0),
      zero: golog.state.spheres.size,
      one: golog.state.edges.size,
      two: golog.state.surfaces.size,
      three: golog.state.volumes?.size ?? 0,
      payloads:
        typeof golog.state.getPayloads === "function"
          ? [...golog.state.objects.values()].reduce(
              (count, object) => count + golog.state.getPayloads(object.id).length,
              0,
            )
          : golog.state.payloads.size,
    },
    objects: collectGologObjects(golog, options),
  }));

  return {
    format: GOLOG_AGENT_API_FORMAT,
    version: GOLOG_AGENT_API_VERSION,
    schemas: DEFAULT_MATH_SCHEMA_REGISTRY.exportSchemas(),
    activeGologId: workspace.activeGologId,
    history: workspace.patchHistory.summary(),
    gologs,
    ...(options.includeSerializedWorkspace
      ? { serializedWorkspace: serializeWorkspace(workspace) }
      : {}),
    ...(options.includeTranscript
      ? { transcript: createOperationTranscript(workspace, options) }
      : {}),
  };
}

function matchesText(value, query) {
  return String(value ?? "").toLowerCase().includes(String(query).toLowerCase());
}

function objectMatches(object, criteria) {
  const payloads = object.payloads?.length
    ? object.payloads
    : [object.payload].filter(Boolean);
  if (criteria.gologId && object.gologId !== criteria.gologId) {
    return false;
  }
  if ((criteria.objectId ?? criteria.id) && object.objectId !== (criteria.objectId ?? criteria.id)) {
    return false;
  }
  if (criteria.kind && object.kind !== criteria.kind) {
    return false;
  }
  if (
    criteria.dimension !== undefined &&
    Number(object.dimension) !== Number(criteria.dimension)
  ) {
    return false;
  }
  if (criteria.name !== undefined && object.name !== criteria.name) {
    return false;
  }
  if (criteria.nameIncludes && !matchesText(object.name, criteria.nameIncludes)) {
    return false;
  }
  if (
    criteria.hasPayload !== undefined &&
    Boolean(payloads.length) !== Boolean(criteria.hasPayload)
  ) {
    return false;
  }
  if (
    criteria.payloadType &&
    !payloads.some((payload) => payload?.type === criteria.payloadType)
  ) {
    return false;
  }
  if (
    criteria.targetGologId &&
    !payloads.some((payload) => payload?.targetGologId === criteria.targetGologId) &&
    object.childGologId !== criteria.targetGologId
  ) {
    return false;
  }
  if (
    criteria.textIncludes &&
    !payloads.some((payload) =>
      matchesText(payloadSearchText(payload), criteria.textIncludes),
    )
  ) {
    return false;
  }
  return true;
}

export function queryWorkspaceForAgents(workspace, criteria = {}) {
  const limit = Math.max(0, Number(criteria.limit ?? 1000));
  const includePayloadText = Boolean(
    criteria.includePayloadText ?? criteria.textIncludes,
  );
  const matches = [];

  for (const golog of workspace.gologs.values()) {
    if (criteria.gologId && golog.id !== criteria.gologId) {
      continue;
    }
    for (const object of collectGologObjects(golog, { includePayloadText })) {
      if (objectMatches(object, criteria)) {
        matches.push(object);
      }
      if (matches.length >= limit) {
        return {
          format: GOLOG_AGENT_API_FORMAT,
          version: GOLOG_AGENT_API_VERSION,
          criteria: { ...criteria, limit },
          count: matches.length,
          truncated: true,
          matches,
        };
      }
    }
  }

  return {
    format: GOLOG_AGENT_API_FORMAT,
    version: GOLOG_AGENT_API_VERSION,
    criteria: { ...criteria, limit },
    count: matches.length,
    truncated: false,
    matches,
  };
}

function gologOrThrow(workspace, gologId) {
  const resolvedId = gologId ?? workspace.activeGologId;
  const golog = workspace.gologs.get(resolvedId);
  if (!golog) {
    throw new Error(`Golog does not exist: ${resolvedId}`);
  }
  return golog;
}

export function inspectObjectForAgents(workspace, { gologId = null, objectId }) {
  const golog = gologOrThrow(workspace, gologId);
  const object = collectGologObjects(golog, {
    includePayloadText: true,
    includePayloadData: true,
  }).find((entry) => entry.objectId === objectId);
  if (!object) {
    throw new Error(`Object does not exist: ${golog.id}:${objectId}`);
  }
  return {
    format: GOLOG_AGENT_API_FORMAT,
    version: GOLOG_AGENT_API_VERSION,
    object,
  };
}

function payloadSelectorFromRequest(request = {}) {
  const selector = request.selector ?? {};
  return {
    ...selector,
    ...(request.payloadId !== undefined ? { payloadId: request.payloadId } : {}),
    ...(request.key !== undefined ? { key: request.key } : {}),
    ...(request.kind !== undefined ? { kind: request.kind } : {}),
    ...(request.type !== undefined ? { type: request.type } : {}),
    ...(request.payloadType !== undefined ? { type: request.payloadType } : {}),
    ...(request.index !== undefined ? { index: request.index } : {}),
  };
}

function payloadKeyForSelector(selector = {}) {
  if (selector.key !== undefined) {
    return String(selector.key);
  }
  if (selector.kind !== undefined) {
    return String(selector.kind);
  }
  if (selector.type !== undefined) {
    return payloadAttachmentKey(String(selector.type));
  }
  return null;
}

function payloadRecordsForAgents(golog, objectId, options = {}) {
  if (!golog.state.hasSelectableSimplex(objectId)) {
    throw new Error(`Payload owner does not exist: ${golog.id}:${objectId}`);
  }
  return golog.state.getPayloads(objectId).map((payload, index) => {
    const key = payloadAttachmentKey(payload);
    return {
      index,
      key,
      primary: index === 0,
      ...payloadSummary(payload, options),
      ...(options.includePayloadData ? { payload: clonePatchValue(payload) } : {}),
    };
  });
}

function inspectPayloadsForAgents(workspace, request = {}) {
  const golog = gologOrThrow(workspace, request.gologId);
  const objectId = String(request.objectId ?? request.id ?? "");
  if (!objectId) {
    throw new Error("inspectPayloads requires objectId");
  }
  return {
    format: GOLOG_AGENT_API_FORMAT,
    version: GOLOG_AGENT_API_VERSION,
    gologId: golog.id,
    objectId,
    payloads: payloadRecordsForAgents(golog, objectId, {
      includePayloadText: Boolean(request.includePayloadText),
      includePayloadData: Boolean(request.includePayloadData),
    }),
  };
}

function selectPayloadForAgents(golog, objectId, selector = {}) {
  const payloads = golog.state.getPayloads(objectId);
  if (payloads.length === 0) {
    throw new Error(`Object has no payloads: ${golog.id}:${objectId}`);
  }

  if (selector.payloadId !== undefined) {
    throw new Error("Stable payload ids are not yet supported; select by key, kind, type, or index");
  }

  if (selector.index !== undefined) {
    const index = Number(selector.index);
    if (!Number.isInteger(index) || index < 0 || index >= payloads.length) {
      throw new Error(`Payload index is out of range: ${selector.index}`);
    }
    const payload = payloads[index];
    return {
      index,
      key: payloadAttachmentKey(payload),
      payload,
    };
  }

  const key = payloadKeyForSelector(selector);
  if (key) {
    const index = payloads.findIndex(
      (payload) => payloadAttachmentKey(payload) === key,
    );
    if (index < 0) {
      throw new Error(`Payload does not exist: ${golog.id}:${objectId}:${key}`);
    }
    return {
      index,
      key,
      payload: payloads[index],
    };
  }

  if (payloads.length === 1) {
    return {
      index: 0,
      key: payloadAttachmentKey(payloads[0]),
      payload: payloads[0],
    };
  }
  throw new Error("Payload selector is required when an object has multiple payloads");
}

function payloadMutationSummary(golog, objectId, selected, nextPayload, options = {}) {
  return {
    format: GOLOG_AGENT_API_FORMAT,
    version: GOLOG_AGENT_API_VERSION,
    gologId: golog.id,
    objectId,
    selected: {
      index: selected.index,
      key: selected.key,
    },
    before: {
      index: selected.index,
      key: selected.key,
      ...payloadSummary(selected.payload, options),
      ...(options.includePayloadData ? { payload: clonePatchValue(selected.payload) } : {}),
    },
    after: nextPayload
      ? {
          index: selected.index,
          key: payloadAttachmentKey(nextPayload),
          ...payloadSummary(nextPayload, options),
          ...(options.includePayloadData ? { payload: clonePatchValue(nextPayload) } : {}),
        }
      : null,
  };
}

function replacementPayloadForAgents(selectedPayload, request = {}) {
  const mode = request.mode ?? (request.payload ? "replace" : "merge");
  const patch = request.patch ?? request.changes ?? request.fields ?? {};
  const hasClearFields =
    Array.isArray(request.clearFields) && request.clearFields.length > 0;
  let nextPayload;
  if (mode === "replace") {
    if (!request.payload) {
      throw new Error("replace payload mode requires payload");
    }
    nextPayload = {
      ...request.payload,
    };
    for (const field of request.preserveFields ?? []) {
      if (Object.hasOwn(selectedPayload, field) && !Object.hasOwn(nextPayload, field)) {
        nextPayload[field] = selectedPayload[field];
      }
    }
  } else if (mode === "merge") {
    if (
      patch === null ||
      typeof patch !== "object" ||
      Array.isArray(patch) ||
      (Object.keys(patch).length === 0 && !hasClearFields)
    ) {
      throw new Error(
        "updatePayload merge requires a non-empty patch, changes, or fields object",
      );
    }
    nextPayload = {
      ...selectedPayload,
      ...patch,
    };
  } else if (mode === "clear-fields") {
    nextPayload = { ...selectedPayload };
  } else {
    throw new Error(`Unsupported payload update mode: ${mode}`);
  }

  for (const field of request.clearFields ?? []) {
    nextPayload[field] = "";
  }
  if (mode === "clear-fields") {
    const fieldsToClear = Array.isArray(request.fields)
      ? request.fields
      : request.clearFields ?? [];
    for (const field of fieldsToClear) {
      nextPayload[field] = "";
    }
  }
  return normalizePayload(nextPayload);
}

function updatePayloadForAgents(workspace, request = {}) {
  const golog = gologOrThrow(workspace, request.gologId);
  const objectId = String(request.objectId ?? request.id ?? "");
  if (!objectId) {
    throw new Error("updatePayload requires objectId");
  }
  if (!golog.state.hasSelectableSimplex(objectId)) {
    throw new Error(`Payload owner does not exist: ${golog.id}:${objectId}`);
  }

  const selected = selectPayloadForAgents(
    golog,
    objectId,
    payloadSelectorFromRequest(request),
  );
  const nextPayload = replacementPayloadForAgents(selected.payload, request);
  const nextKey = payloadAttachmentKey(nextPayload);
  if (nextKey !== selected.key && !request.allowKeyChange) {
    throw new Error(
      `Payload update would change attachment key from ${selected.key} to ${nextKey}`,
    );
  }
  validateNestedPayloadForAgents(workspace, golog.id, objectId, nextPayload);

  const summary = payloadMutationSummary(golog, objectId, selected, nextPayload, {
    includePayloadText: true,
    includePayloadData: Boolean(request.includePayloadData),
  });
  if (request.dryRun) {
    return {
      ...summary,
      dryRun: true,
    };
  }

  if (nextPayload.type === PAYLOAD_TYPES.NESTED_GOLOG) {
    applyAgentOperation(golog.state, "payload:golog-attach", {
      id: objectId,
      targetGologId: nextPayload.targetGologId,
      rootObjectId: nextPayload.rootObjectId,
    });
  } else {
    applyAgentOperation(golog.state, "payload:typed-update", {
      id: objectId,
      payload: nextPayload,
    });
  }
  return {
    ...summary,
    dryRun: false,
    object: inspectObjectForAgents(workspace, {
      gologId: golog.id,
      objectId,
    }).object,
  };
}

function replacePayloadForAgents(workspace, request = {}) {
  return updatePayloadForAgents(workspace, {
    ...request,
    mode: "replace",
  });
}

function deletePayloadForAgents(workspace, request = {}) {
  const golog = gologOrThrow(workspace, request.gologId);
  const objectId = String(request.objectId ?? request.id ?? "");
  if (!objectId) {
    throw new Error("deletePayload requires objectId");
  }
  const selected = selectPayloadForAgents(
    golog,
    objectId,
    payloadSelectorFromRequest(request),
  );
  const plan = payloadMutationSummary(golog, objectId, selected, null, {
    includePayloadText: true,
    includePayloadData: Boolean(request.includePayloadData),
  });
  const dryRun = request.dryRun !== false || !request.confirmed;
  if (dryRun) {
    return {
      ...plan,
      dryRun: true,
      destructive: true,
      requiresConfirmation: !request.confirmed,
    };
  }

  const result = applyAgentOperation(golog.state, "payload:delete", {
    id: objectId,
    key: selected.key,
  });
  return {
    ...plan,
    dryRun: false,
    destructive: true,
    deleted: true,
    result: result.result ?? null,
    object: inspectObjectForAgents(workspace, {
      gologId: golog.id,
      objectId,
    }).object,
  };
}

function addLink(adjacency, links, from, to, relation) {
  if (!from || !to) {
    return;
  }
  if (!adjacency.has(from)) {
    adjacency.set(from, new Set());
  }
  if (!adjacency.has(to)) {
    adjacency.set(to, new Set());
  }
  adjacency.get(from).add(to);
  adjacency.get(to).add(from);
  links.push({ from, to, relation });
}

function buildAdjacency(golog) {
  const adjacency = new Map();
  const links = [];
  for (const sphere of golog.state.spheres.values()) {
    adjacency.set(sphere.id, new Set());
  }
  for (const edge of golog.state.edges.values()) {
    adjacency.set(edge.id, new Set());
    addLink(adjacency, links, edge.sourceId, edge.id, "source boundary");
    addLink(adjacency, links, edge.id, edge.targetId, "target boundary");
  }
  for (const surface of golog.state.surfaces.values()) {
    adjacency.set(surface.id, new Set());
    for (const edgeId of surface.edgeIds) {
      addLink(adjacency, links, edgeId, surface.id, "surface boundary");
    }
  }
  for (const volume of golog.state.volumes?.values() ?? []) {
    for (const faceId of volume.boundaryFaceIds) {
      addLink(adjacency, links, faceId, volume.id, "volume boundary");
    }
  }
  return { adjacency, links };
}

export function neighborhoodForAgents(
  workspace,
  { gologId = null, objectId, depth = 1, includePayloadText = false },
) {
  const golog = gologOrThrow(workspace, gologId);
  if (!golog.state.hasSelectableSimplex(objectId)) {
    throw new Error(`Object does not exist: ${golog.id}:${objectId}`);
  }

  const maxDepth = Math.max(0, Number(depth ?? 1));
  const { adjacency, links } = buildAdjacency(golog);
  const seen = new Set([objectId]);
  const queue = [{ id: objectId, depth: 0 }];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current.depth >= maxDepth) {
      continue;
    }
    for (const next of adjacency.get(current.id) ?? []) {
      if (seen.has(next)) {
        continue;
      }
      seen.add(next);
      queue.push({ id: next, depth: current.depth + 1 });
    }
  }

  const objects = collectGologObjects(golog, { includePayloadText }).filter((object) =>
    seen.has(object.objectId),
  );
  return {
    format: GOLOG_AGENT_API_FORMAT,
    version: GOLOG_AGENT_API_VERSION,
    gologId: golog.id,
    objectId,
    depth: maxDepth,
    objects,
    links: links.filter((link) => seen.has(link.from) && seen.has(link.to)),
  };
}

function readPatchCurrentValue(workspace, target) {
  const golog = workspace.gologs.get(target.gologId);
  if (!golog) {
    throw new Error(`Patch target golog does not exist: ${target.gologId}`);
  }
  const state = golog.state;

  if (target.collection === "volumes" && target.property === "name") {
    const volume = state.volumes.get(target.objectId);
    if (!volume) throw new Error(`Patch target volume does not exist: ${target.objectId}`);
    return volume.name ?? "";
  }

  if (target.collection === "spheres") {
    const sphere = state.spheres.get(target.objectId);
    if (!sphere) {
      throw new Error(`Patch target sphere does not exist: ${target.objectId}`);
    }
    if (target.property === "name") {
      return sphere.name ?? "";
    }
    if (target.property === "position") {
      return clonePatchValue(sphere.position);
    }
    if (target.property === "childGologId") {
      return sphere.childGologId ?? null;
    }
  }

  if (target.collection === "edges") {
    const edge = state.edges.get(target.objectId);
    if (!edge) {
      throw new Error(`Patch target edge does not exist: ${target.objectId}`);
    }
    if (target.property === "name") {
      return edge.name ?? "";
    }
    if (target.property === "bend") {
      return clonePatchValue(edge.bend);
    }
  }

  if (target.collection === "surfaces") {
    const surface = state.surfaces.get(target.objectId);
    if (!surface) {
      throw new Error(`Patch target surface does not exist: ${target.objectId}`);
    }
    if (target.property === "name") {
      return surface.name ?? "";
    }
    if (target.property === "controlCoordinate") {
      return surface.controlCoordinate;
    }
  }

  if (target.collection === "payloads") {
    if (!state.hasSelectableSimplex(target.objectId)) {
      throw new Error(`Patch target payload owner does not exist: ${target.objectId}`);
    }
    if (target.property === null) {
      return state.getPayload(target.objectId);
    }
    if (target.property === "text") {
      const payload = (state.getPayloads?.(target.objectId) ?? [
        state.getPayload(target.objectId),
      ].filter(Boolean)).find(payloadHasText);
      if (!payloadHasText(payload)) {
        throw new Error(`Patch target text payload does not exist: ${target.objectId}`);
      }
      return payload.text ?? "";
    }
  }

  throw new Error(
    `Unsupported patch target: ${target.collection}/${target.property ?? ""}`,
  );
}

function validatePayloadValue(workspace, target, value) {
  if (value === null) {
    return;
  }
  if (!value || typeof value !== "object") {
    throw new Error("Payload replacement must be null or an object");
  }
  const normalized = normalizePayload(value);
  if (normalized.type === PAYLOAD_TYPES.NESTED_GOLOG) {
    normalizeShapeExpansionPayload(workspace, workspace.gologs.get(target.gologId)?.state, target.objectId, normalized);
  }

}

function validatePatchValue(workspace, target, value) {
  if (target.property === "name") {
    if (typeof value !== "string") {
      throw new Error("Name patch value must be a string");
    }
    return;
  }

  if (target.collection === "spheres" && target.property === "position") {
    if (!numberArray(value, 3)) {
      throw new Error("Sphere position patch value must be a three-number array");
    }
    return;
  }

  if (target.collection === "spheres" && target.property === "childGologId") {
    if (value !== null && !workspace.gologs.has(String(value))) {
      throw new Error(`Child golog target does not exist: ${value}`);
    }
    return;
  }

  if (target.collection === "edges" && target.property === "bend") {
    if (!numberArray(value, 2)) {
      throw new Error("Edge bend patch value must be a two-number array");
    }
    return;
  }

  if (
    target.collection === "surfaces" &&
    target.property === "controlCoordinate"
  ) {
    if (!finiteNumber(Number(value))) {
      throw new Error("Surface controlCoordinate patch value must be a number");
    }
    return;
  }

  if (target.collection === "payloads" && target.property === null) {
    validatePayloadValue(workspace, target, value);
    return;
  }

  if (target.collection === "payloads" && target.property === "text") {
    if (typeof value !== "string") {
      throw new Error("Payload text patch value must be a string");
    }
    return;
  }

  throw new Error(
    `Unsupported patch value target: ${target.collection}/${target.property ?? ""}`,
  );
}

export function validateAgentPatches(workspace, patches) {
  const patchList = Array.isArray(patches) ? patches : [patches];
  const errors = [];
  const validated = [];
  const inverse = [];

  patchList.forEach((patch, index) => {
    try {
      const operation = normalizePatchOperation(patch);
      if (operation.op !== "replace") {
        throw new Error(`Unsupported operation: ${operation.op}`);
      }
      const target = parseGologPatchPath(operation.path);
      readPatchCurrentValue(workspace, target);
      validatePatchValue(workspace, target, operation.value);
      validated.push(operation);
    } catch (error) {
      errors.push({
        index,
        path: patch?.path ?? null,
        message: error.message,
      });
    }
  });

  if (errors.length > 0) {
    return { ok: false, errors, patches: [], inverse: [] };
  }

  for (let index = validated.length - 1; index >= 0; index -= 1) {
    const operation = validated[index];
    const target = parseGologPatchPath(operation.path);
    inverse.push({
      op: "replace",
      path: operation.path,
      value: readPatchCurrentValue(workspace, target),
    });
  }

  return { ok: true, errors: [], patches: validated, inverse };
}

function summarizePatchOperation(operation) {
  const target = parseGologPatchPath(operation.path);
  return {
    op: operation.op,
    path: operation.path,
    gologId: target.gologId,
    collection: target.collection,
    objectId: target.objectId,
    property: target.property,
    value: clonePatchValue(operation.value),
  };
}

export function createOperationTranscript(workspace, options = {}) {
  const limit = Math.max(0, Number(options.limit ?? 50));
  const includeInverse = Boolean(options.includeInverse);
  const includeRedo = options.includeRedo !== false;
  const undo = workspace.patchHistory.undoStack
    .slice(-limit)
    .map((transaction) => ({
      id: transaction.id,
      revision: transaction.revision,
      createdAt: transaction.createdAt,
      label: transaction.label,
      patches: transaction.patches.map(summarizePatchOperation),
      ...(includeInverse
        ? { inverse: transaction.inverse.map(summarizePatchOperation) }
        : {}),
    }));
  const redo = includeRedo
    ? workspace.patchHistory.redoStack.slice(-limit).map((transaction) => ({
        id: transaction.id,
        revision: transaction.revision,
        createdAt: transaction.createdAt,
        label: transaction.label,
        patches: transaction.patches.map(summarizePatchOperation),
        ...(includeInverse
          ? { inverse: transaction.inverse.map(summarizePatchOperation) }
          : {}),
      }))
    : [];

  return {
    format: GOLOG_AGENT_API_FORMAT,
    version: GOLOG_AGENT_API_VERSION,
    history: workspace.patchHistory.summary(),
    undo,
    redo,
  };
}

function createGologForAgents(
  app,
  {
    id = null,
    title = null,
    activate = false,
    structureId = null,
    schema = null,
  } = {},
) {
  const workspace = app.workspace;
  const created = app.createGolog
    ? app.createGolog({ id, title, activate: false, publish: false, structureId, schema })
    : workspace.createGolog({ id, title, structureId, schema });
  const publish = (golog) => {
    const fingerprint = publicationFingerprint(gologPublication(workspace, golog.id));
    const finish = () => {
      const current = workspace.gologs.get(golog.id);
      if (!current) throw new Error(`Published golog disappeared: ${golog.id}`);
      if (activate) {
        if (app.openGolog) app.openGolog(current.id);
        else workspace.activateGolog(current.id);
      }
      return { id: current.id, title: current.title,
        structure: { id: current.structure?.id ?? null, schema: current.structure?.schema ?? null },
        activeGologId: workspace.activeGologId };
    };
    const cleanup = async (error) => {
      try {
        assertGologPublicationRetractionAllowed(workspace, golog.id, fingerprint);
        if (workspace.gologs.has(golog.id)) await workspace.retractGolog?.(golog.id);
        await retractGologPublication(workspace, golog.id, fingerprint, {
          deleteGolog: app.deleteGolog ? (gologId) => app.deleteGolog(gologId) : undefined,
        });
      } catch (failure) {
        const reason = String(failure.message ?? failure);
        throw new Error(`${error.message}; ${reason.startsWith("Publication cleanup blocked:")
          ? reason : `Publication cleanup blocked: ${reason}`}`, { cause: error });
      }
      throw error;
    };
    try {
      const published = workspace.publishGolog?.(golog.id);
      return published?.then ? Promise.resolve(published).then(finish).catch(cleanup) : finish();
    } catch (error) {
      return cleanup(error);
    }
  };
  return created?.then ? Promise.resolve(created).then(publish) : publish(created);
}

function activateGologForAgents(app, request = {}) {
  const gologId = String(request.gologId ?? request.id ?? "");
  if (!gologId) {
    throw new Error("activateGolog requires gologId");
  }
  const golog = app.openGolog
    ? app.openGolog(gologId, {
        recordNavigation: request.recordNavigation !== false,
      })
    : app.workspace.activateGolog(gologId, {
        recordNavigation: request.recordNavigation !== false,
      });
  if (!golog) {
    throw new Error(`Golog does not exist: ${gologId}`);
  }
  return {
    format: GOLOG_AGENT_API_FORMAT,
    version: GOLOG_AGENT_API_VERSION,
    activeGologId: app.workspace.activeGologId,
    title: golog.title,
  };
}

function applyAgentOperation(state, type, payload) {
  const result = state.operationPipeline.submit(type, payload, {
    origin: { source: "agent-api", role: "agent" },
  });
  if (!result.ok) {
    throw new Error(`Agent operation rejected: ${result.reason ?? type}`);
  }
  return result;
}

function setTextPayloadForAgents(state, objectId, text) {
  const existing = state.getPayloadByType?.(objectId, PAYLOAD_TYPES.MARKDOWN) ??
    state.getPayload(objectId);
  if (!existing) {
    return applyAgentOperation(state, "payload:text-add", {
      id: objectId,
      text: String(text ?? ""),
    });
  }
  if (existing.type === "text/markdown") {
    return applyAgentOperation(state, "payload:text-update", {
      id: objectId,
      text: String(text ?? ""),
    });
  }
  return applyAgentOperation(state, "payload:text-add", {
    id: objectId,
    text: String(text ?? ""),
  });
}

function latexRenderForAgents(payloadOrSource, options = {}) {
  const source =
    typeof payloadOrSource === "string"
      ? payloadOrSource
      : String(payloadOrSource?.text ?? payloadOrSource?.source ?? "");
  const payload =
    payloadOrSource && typeof payloadOrSource === "object" ? payloadOrSource : {};
  return {
    format: GOLOG_AGENT_API_FORMAT,
    version: GOLOG_AGENT_API_VERSION,
    renderer: "jsgolog.lightweight-latex-html",
    outputType: "text/html",
    documentKind: payload.documentKind ?? options.documentKind ?? "snippet",
    title: payload.title ?? options.title ?? "",
    source,
    html: renderLatexSnippetToHtml(source),
    note:
      "This is a lightweight HTML inspection preview, not the full server-side TeX-to-PDF compiler.",
  };
}

function renderLatexForAgents(workspace, request = {}) {
  if (request.objectId ?? request.id) {
    const golog = gologOrThrow(workspace, request.gologId);
    const objectId = String(request.objectId ?? request.id);
    const payload =
      golog.state.getPayloadByType?.(objectId, PAYLOAD_TYPES.LATEX) ??
      (!golog.state.getPayloadByType ? golog.state.getPayload(objectId) : null);
    if (payload?.type !== PAYLOAD_TYPES.LATEX) {
      throw new Error(`Object does not have a LaTeX payload: ${golog.id}:${objectId}`);
    }
    return {
      ...latexRenderForAgents(payload),
      gologId: golog.id,
      objectId,
    };
  }
  return latexRenderForAgents(request.text ?? request.source ?? "", request);
}

async function compileLatexSnippetForAgents(request = {}) {
  if (!browserRuntimeConfig().serverLatexCompile) {
    throw new Error(STATIC_LATEX_COMPILE_MESSAGE);
  }
  const source = String(request.text ?? request.source ?? "");
  const endpoint = request.endpoint ?? "/__golog/latex/compile";
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      source,
      documentKind: request.documentKind ?? "snippet",
      title: request.title ?? "",
      renderContext: request.renderContext ?? request.sourceProfile ?? "",
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) {
    throw new Error(body.error ?? `LaTeX compile failed with HTTP ${response.status}`);
  }
  return {
    format: GOLOG_AGENT_API_FORMAT,
    version: GOLOG_AGENT_API_VERSION,
    outputType: "compiled-latex-snippet",
    source,
    ...body,
  };
}

async function replaceLatexPayloadForAgents(workspace, request = {}) {
  const golog = gologOrThrow(workspace, request.gologId);
  const objectId = String(request.objectId ?? request.id ?? "");
  if (!objectId) {
    throw new Error("replaceLatexPayload requires objectId");
  }
  const existing =
    golog.state.getPayloadByType?.(objectId, PAYLOAD_TYPES.LATEX) ??
    (!golog.state.getPayloadByType ? golog.state.getPayload(objectId) : null);
  const text = String(
    request.text ?? request.source ?? existing?.text ?? "",
  );
  const compileRequested = Boolean(request.compile ?? request.renderSnippet);
  const compiled = compileRequested
    ? await compileLatexSnippetForAgents({
        ...request,
        source: text,
      })
    : null;
  const object = attachLatexForAgents(workspace, {
    ...request,
    gologId: golog.id,
    objectId,
    text,
    documentKind: request.documentKind ?? existing?.documentKind ?? "snippet",
    title: request.title ?? existing?.title ?? "",
    latexUrl: request.latexUrl ?? compiled?.latexUrl ?? existing?.latexUrl ?? "",
    imageUrl:
      request.imageUrl ??
      request.pngUrl ??
      compiled?.imageUrl ??
      compiled?.pngUrl ??
      existing?.imageUrl ??
      "",
    imageDataUrl:
      request.imageDataUrl ??
      compiled?.imageDataUrl ??
      existing?.imageDataUrl ??
      "",
    pdfUrl: request.pdfUrl ?? compiled?.pdfUrl ?? existing?.pdfUrl ?? "",
    renderContext:
      request.renderContext ??
      request.sourceProfile ??
      compiled?.renderContext ??
      existing?.renderContext ??
      "",
  });
  return {
    format: GOLOG_AGENT_API_FORMAT,
    version: GOLOG_AGENT_API_VERSION,
    object,
    compiled,
  };
}

function validateNestedPayloadForAgents(workspace, gologId, objectId, payload) {
  if (payload.type === PAYLOAD_TYPES.NESTED_GOLOG) {
    normalizeShapeExpansionPayload(workspace, workspace.gologs.get(gologId)?.state, objectId, payload);
  }

}

function setTypedPayloadForAgents(workspace, request = {}) {
  const golog = gologOrThrow(workspace, request.gologId);
  const objectId = String(request.objectId ?? request.id ?? "");
  if (!objectId) {
    throw new Error("attachPayload requires objectId");
  }
  const payloadRequest = request.payload ?? request;
  const payload = normalizePayload(payloadRequest);
  validateNestedPayloadForAgents(workspace, golog.id, objectId, payload);

  if (payload.type === PAYLOAD_TYPES.NESTED_GOLOG) {
    return attachGologForAgents(workspace, {
      gologId: golog.id,
      objectId,
      targetGologId: payload.targetGologId,
      rootObjectId: payload.rootObjectId,
    });
  }

  const key = payloadAttachmentKey(payload);
  const primaryPayload = golog.state.getPayload(objectId);
  const existing =
    golog.state.getPayloadByKey?.(objectId, key) ??
    (payloadAttachmentKey(primaryPayload) === key ? primaryPayload : null);
  applyAgentOperation(
    golog.state,
    existing ? "payload:typed-update" : "payload:typed-add",
    {
      id: objectId,
      payload,
    },
  );
  return inspectObjectForAgents(workspace, {
    gologId: golog.id,
    objectId,
  }).object;
}

function attachLatexForAgents(workspace, request = {}) {
  const object = setTypedPayloadForAgents(workspace, {
    ...request,
    payload: {
      type: PAYLOAD_TYPES.LATEX,
      text: request.text ?? request.source ?? "",
      documentKind: request.documentKind,
      title: request.title,
      renderContext: request.renderContext ?? request.sourceProfile,
      latexUrl: request.latexUrl ?? request.sourceUrl,
      imageUrl:
        request.imageUrl ??
        request.pngUrl ??
        request.previewUrl ??
        (String(request.renderedUrl ?? "").endsWith(".pdf")
          ? ""
          : request.renderedUrl),
      imageDataUrl:
        request.imageDataUrl ??
        request.pngDataUrl ??
        request.previewDataUrl ??
        "",
      pdfUrl:
        request.pdfUrl ??
        (String(request.renderedUrl ?? "").endsWith(".pdf")
          ? request.renderedUrl
          : ""),
    },
  });
  if (!request.includeRender && !request.render && !request.compile) {
    return object;
  }
  return {
    ...object,
    render: latexRenderForAgents(object.payload?.text ?? request.text ?? request.source ?? "", {
      documentKind: object.payload?.documentKind,
      title: object.payload?.title,
    }),
  };
}

function attachCodeForAgents(workspace, request = {}) {
  return setTypedPayloadForAgents(workspace, {
    ...request,
    payload: {
      type: codePayloadType(request.language ?? "text"),
      language: request.language ?? "text",
      text: request.text ?? request.code ?? request.source ?? "",
    },
  });
}

function attachImageForAgents(workspace, request = {}) {
  return setTypedPayloadForAgents(workspace, {
    ...request,
    payload: {
      type: imagePayloadType(request.mimeType ?? request.type ?? "image/png"),
      mimeType: request.mimeType ?? request.type ?? "image/png",
      src: request.src ?? request.dataUrl ?? request.url ?? "",
      alt: request.alt ?? "",
      name: request.name ?? "",
    },
  });
}

function attachUrlForAgents(workspace, request = {}) {
  return setTypedPayloadForAgents(workspace, {
    ...request,
    payload: {
      type: PAYLOAD_TYPES.URL,
      url: request.url ?? request.href ?? request.src ?? "",
      title: request.title ?? request.name ?? "",
      description: request.description ?? request.text ?? "",
    },
  });
}

function createNodeForAgents(workspace, request = {}) {
  const golog = gologOrThrow(workspace, request.gologId);
  const state = golog.state;
  const id = request.id ?? `sphere-${state.nextSphereId}`;
  if (request.id && request.id !== `sphere-${state.nextSphereId}`) {
    throw new Error("Explicit node ids must match the store's next sphere id");
  }

  applyAgentOperation(state, "element:create", {
    elementKind:
      request.elementKind ??
      (golog.structure?.id === VIRTUAL_DOUBLE_CATEGORY_STRUCTURE_ID
        ? VIRTUAL_DOUBLE_ELEMENT_KINDS.OBJECT
        : ELEMENT_KINDS.ZERO_SIMPLEX),
    id,
  });
  if (!state.spheres.has(id)) {
    throw new Error(`Node creation failed: ${id}`);
  }
  if (request.name !== undefined) {
    applyAgentOperation(state, "simplex:rename", {
      id,
      name: String(request.name),
    });
  }
  if (request.text !== undefined) {
    setTextPayloadForAgents(state, id, request.text);
  }
  return inspectObjectForAgents(workspace, { gologId: golog.id, objectId: id }).object;
}

function createNodesForAgents(workspace, request = {}) {
  const golog = gologOrThrow(workspace, request.gologId);
  const state = golog.state;
  const nodes = Array.isArray(request.nodes) ? request.nodes : [];
  const returnObjects = request.returnObjects !== false;
  const created = [];

  for (const node of nodes) {
    const id = node.id ?? `sphere-${state.nextSphereId}`;
    if (node.id && node.id !== `sphere-${state.nextSphereId}`) {
      throw new Error("Explicit node ids must match the store's next sphere id");
    }

    applyAgentOperation(state, "element:create", {
      elementKind:
        node.elementKind ??
        (golog.structure?.id === VIRTUAL_DOUBLE_CATEGORY_STRUCTURE_ID
          ? VIRTUAL_DOUBLE_ELEMENT_KINDS.OBJECT
          : ELEMENT_KINDS.ZERO_SIMPLEX),
      id,
    });
    const sphere = state.spheres.get(id);
    if (!sphere) {
      throw new Error(`Node creation failed: ${id}`);
    }
    if (node.name !== undefined) {
      applyAgentOperation(state, "simplex:rename", {
        id,
        name: String(node.name),
      });
    }
    if (node.text !== undefined) {
      setTextPayloadForAgents(state, id, node.text);
    }
    if (returnObjects) {
      created.push(summarizeSphere(golog, state.spheres.get(id), {
        includePayloadText: Boolean(request.includePayloadText),
      }));
    }
  }

  return {
    format: GOLOG_AGENT_API_FORMAT,
    version: GOLOG_AGENT_API_VERSION,
    gologId: golog.id,
    count: nodes.length,
    objects: returnObjects ? created : [],
  };
}

const MAX_AGENT_ELEMENT_BATCH = 2_000;

function elementBatchReference(value, availableRefs, exists, fieldName) {
  const reference = String(value ?? "");
  if (!reference) {
    throw new Error(`createElements requires ${fieldName}`);
  }
  if (availableRefs.has(reference) || exists(reference)) {
    return reference;
  }
  throw new Error(
    `createElements ${fieldName} must name an existing object or an earlier ref: ${reference}`,
  );
}

function preflightElementBatch(golog, elements) {
  const availableRefs = new Map();
  const prepared = [];
  for (const [index, element] of elements.entries()) {
    if (!element || typeof element !== "object" || Array.isArray(element)) {
      throw new Error(`createElements element ${index} must be an object`);
    }
    const elementKind = normalizeElementKind(element.elementKind ?? element.kind);
    if (!elementKind) {
      throw new Error(`createElements element ${index} requires a registered elementKind`);
    }
    const refValue = element.ref ?? element.key ?? element.id ?? null;
    const ref = refValue === null ? null : String(refValue);
    if (ref && availableRefs.has(ref)) {
      throw new Error(`createElements ref must be unique: ${ref}`);
    }

    if (
      [
        ELEMENT_KINDS.ONE_SIMPLEX,
        VIRTUAL_DOUBLE_ELEMENT_KINDS.TIGHT_ARROW,
        VIRTUAL_DOUBLE_ELEMENT_KINDS.PROARROW,
      ].includes(elementKind)
    ) {
      elementBatchReference(
        element.sourceId ?? element.source,
        availableRefs,
        (id) => golog.state.spheres.has(id),
        `element ${index} source`,
      );
      elementBatchReference(
        element.targetId ?? element.target,
        availableRefs,
        (id) => golog.state.spheres.has(id),
        `element ${index} target`,
      );
    } else if ([ELEMENT_KINDS.TWO_CELL, ELEMENT_KINDS.TWO_SIMPLEX].includes(elementKind)) {
      const edgeRefs = element.edgeIds ?? element.edges;
      const expectedCount = elementKind === ELEMENT_KINDS.TWO_CELL ? 2 : 3;
      if (!Array.isArray(edgeRefs) || edgeRefs.length !== expectedCount) {
        throw new Error(
          `createElements ${elementKind} requires exactly ${expectedCount} edge references`,
        );
      }
      for (const edgeRef of edgeRefs) {
        elementBatchReference(
          edgeRef,
          availableRefs,
          (id) => golog.state.edges.has(id),
          `element ${index} edge`,
        );
      }
    } else if (elementKind === "theta-volume") {
      if (!element.faces || typeof element.faces !== "object" || Array.isArray(element.faces)) {
        throw new Error("createElements theta-volume requires a faces map");
      }
      for (const faceRef of Object.values(element.faces)) {
        elementBatchReference(faceRef, availableRefs,
          (id) => golog.state.hasSelectableSimplex(id), `element ${index} face`);
      }
    } else if (elementKind === VIRTUAL_DOUBLE_ELEMENT_KINDS.CELL) {
      const topPathRefs = element.topPathIds ?? element.topPath;
      if (!Array.isArray(topPathRefs) || topPathRefs.length === 0) {
        throw new Error("createElements virtual cell requires a nonempty topPath");
      }
      for (const [fieldName, refs] of [
        ["topPath", topPathRefs],
        ["bottomArrow", [element.bottomArrowId ?? element.bottomArrow]],
        ["leftArrow", [element.leftArrowId ?? element.leftArrow]],
        ["rightArrow", [element.rightArrowId ?? element.rightArrow]],
      ]) {
        for (const edgeRef of refs) {
          elementBatchReference(
            edgeRef,
            availableRefs,
            (id) => golog.state.edges.has(id),
            `element ${index} ${fieldName}`,
          );
        }
      }
    } else if (
      ![ELEMENT_KINDS.ZERO_SIMPLEX, VIRTUAL_DOUBLE_ELEMENT_KINDS.OBJECT].includes(
        elementKind,
      )
    ) {
      throw new Error(`createElements does not yet adapt elementKind: ${elementKind}`);
    }

    prepared.push({ element, elementKind, ref });
    if (ref) {
      availableRefs.set(ref, elementKind);
    }
  }
  return prepared;
}

function createElementsForAgents(workspace, request = {}) {
  const golog = gologOrThrow(workspace, request.gologId);
  const elements = Array.isArray(request.elements) ? request.elements : [];
  if (elements.length === 0) {
    throw new Error("createElements requires a nonempty elements array");
  }
  if (elements.length > MAX_AGENT_ELEMENT_BATCH) {
    throw new Error(
      `createElements accepts at most ${MAX_AGENT_ELEMENT_BATCH} elements`,
    );
  }

  const prepared = preflightElementBatch(golog, elements);
  const refs = new Map();
  const objects = [];
  const counts = {};
  const resolveReference = (value) => refs.get(String(value)) ?? String(value);

  for (const { element, elementKind, ref } of prepared) {
    const common = {
      gologId: golog.id,
      ...(element.id ? { id: String(element.id) } : {}),
      ...(element.name !== undefined ? { name: element.name } : {}),
      ...(element.text !== undefined ? { text: element.text } : {}),
      ...(element.controlCoordinate !== undefined
        ? { controlCoordinate: element.controlCoordinate }
        : {}),
    };
    let object;
    if (
      [ELEMENT_KINDS.ZERO_SIMPLEX, VIRTUAL_DOUBLE_ELEMENT_KINDS.OBJECT].includes(
        elementKind,
      )
    ) {
      object = createNodeForAgents(workspace, { ...common, elementKind });
    } else if (
      [
        ELEMENT_KINDS.ONE_SIMPLEX,
        VIRTUAL_DOUBLE_ELEMENT_KINDS.TIGHT_ARROW,
        VIRTUAL_DOUBLE_ELEMENT_KINDS.PROARROW,
      ].includes(elementKind)
    ) {
      object = createEdgeForAgents(workspace, {
        ...common,
        elementKind,
        sourceId: resolveReference(element.sourceId ?? element.source),
        targetId: resolveReference(element.targetId ?? element.target),
        ...(element.bend !== undefined ? { bend: element.bend } : {}),
      });
    } else if (elementKind === ELEMENT_KINDS.TWO_SIMPLEX) {
      object = createTwoSimplexForAgents(workspace, {
        ...common,
        edgeIds: (element.edgeIds ?? element.edges).map(resolveReference),
      });
    } else if (elementKind === ELEMENT_KINDS.TWO_CELL) {
      object = createTwoCellForAgents(workspace, {
        ...common,
        edgeIds: (element.edgeIds ?? element.edges).map(resolveReference),
      });
    } else if (elementKind === "theta-volume") {
      object = createThetaVolumeForAgents(workspace, {
        ...common,
        schemaRef: element.schemaRef,
        shapeId: element.shapeId,
        thetaIndex: element.thetaIndex,
        faces: Object.fromEntries(Object.entries(element.faces).map(
          ([arrow, face]) => [arrow, resolveReference(face)],
        )),
      });
    } else {
      object = createVirtualCellForAgents(workspace, {
        ...common,
        topPathIds: (element.topPathIds ?? element.topPath).map(resolveReference),
        bottomArrowId: resolveReference(
          element.bottomArrowId ?? element.bottomArrow,
        ),
        leftArrowId: resolveReference(element.leftArrowId ?? element.leftArrow),
        rightArrowId: resolveReference(
          element.rightArrowId ?? element.rightArrow,
        ),
      });
    }

    if (ref) {
      refs.set(ref, object.objectId);
    }
    counts[elementKind] = (counts[elementKind] ?? 0) + 1;
    if (request.returnObjects === true) {
      objects.push(object);
    }
  }

  return {
    format: GOLOG_AGENT_API_FORMAT,
    version: GOLOG_AGENT_API_VERSION,
    gologId: golog.id,
    count: prepared.length,
    counts,
    refs: Object.fromEntries(refs),
    objects,
  };
}

function createEdgeForAgents(workspace, request = {}) {
  const golog = gologOrThrow(workspace, request.gologId);
  const state = golog.state;
  const id = request.id ?? `edge-${state.nextEdgeId}`;
  if (request.id && request.id !== `edge-${state.nextEdgeId}`) {
    throw new Error("Explicit edge ids must match the store's next edge id");
  }
  if (!request.sourceId || !request.targetId) {
    throw new Error("createEdge requires sourceId and targetId");
  }

  applyAgentOperation(state, "element:create", {
    elementKind:
      request.elementKind ??
      request.arrowKind ??
      (golog.structure?.id === VIRTUAL_DOUBLE_CATEGORY_STRUCTURE_ID
        ? VIRTUAL_DOUBLE_ELEMENT_KINDS.PROARROW
        : ELEMENT_KINDS.ONE_SIMPLEX),
    id,
    sourceId: String(request.sourceId),
    targetId: String(request.targetId),
  });
  const edge = state.edges.get(id);
  if (!edge) {
    throw new Error(`Edge creation failed: ${id}`);
  }
  if (request.name !== undefined) {
    applyAgentOperation(state, "simplex:rename", {
      id,
      name: String(request.name),
    });
  }
  if (request.bend !== undefined) {
    const bend = vector2FromAgent(request.bend, "bend");
    const frame = state.syncNodePairFrame(edge.sourceId, edge.targetId);
    applyAgentOperation(state, "edge:move-midpoint", {
      id,
      midpoint: state.pointFromFrameBend(frame, bend),
    });
  }
  if (request.text !== undefined) {
    setTextPayloadForAgents(state, id, request.text);
  }
  return inspectObjectForAgents(workspace, { gologId: golog.id, objectId: id }).object;
}

function createVirtualCellForAgents(workspace, request = {}) {
  const golog = gologOrThrow(workspace, request.gologId);
  if (golog.structure?.id !== VIRTUAL_DOUBLE_CATEGORY_STRUCTURE_ID) {
    throw new Error("createVirtualCell requires a virtual-double-category golog");
  }
  const state = golog.state;
  const id = request.id ?? `virtual-cell-${state.nextSurfaceId}`;
  const topPathIds = (request.topPathIds ?? []).map(String);
  const boundary = {
    topPathIds,
    bottomArrowId: String(request.bottomArrowId ?? ""),
    leftArrowId: String(request.leftArrowId ?? ""),
    rightArrowId: String(request.rightArrowId ?? ""),
  };
  if (
    topPathIds.length === 0 ||
    !boundary.bottomArrowId ||
    !boundary.leftArrowId ||
    !boundary.rightArrowId
  ) {
    throw new Error(
      "createVirtualCell requires topPathIds, bottomArrowId, leftArrowId, and rightArrowId",
    );
  }
  applyAgentOperation(state, "element:create", {
    id,
    elementKind: VIRTUAL_DOUBLE_ELEMENT_KINDS.CELL,
    ...boundary,
    ...(request.controlCoordinate !== undefined
      ? { controlCoordinate: Number(request.controlCoordinate) }
      : {}),
  });
  if (!state.surfaces.has(id)) {
    throw new Error(`Virtual-cell creation failed: ${id}`);
  }
  if (request.name !== undefined) {
    applyAgentOperation(state, "simplex:rename", {
      id,
      name: String(request.name),
    });
  }
  if (request.text !== undefined) {
    setTextPayloadForAgents(state, id, request.text);
  }
  return inspectObjectForAgents(workspace, { gologId: golog.id, objectId: id })
    .object;
}

function createTwoCellForAgents(workspace, request = {}) {
  const golog = gologOrThrow(workspace, request.gologId);
  const state = golog.state;
  const id = request.id ?? `surface-${state.nextSurfaceId}`;
  if (request.id && request.id !== `surface-${state.nextSurfaceId}`) {
    throw new Error("Explicit 2-cell ids must match the store's next surface id");
  }
  const firstEdgeId = String(request.firstEdgeId ?? request.edgeIds?.[0] ?? "");
  const secondEdgeId = String(request.secondEdgeId ?? request.edgeIds?.[1] ?? "");
  if (!firstEdgeId || !secondEdgeId) {
    throw new Error("createTwoCell requires firstEdgeId and secondEdgeId");
  }

  applyAgentOperation(state, "element:create", {
    elementKind: ELEMENT_KINDS.TWO_CELL,
    id,
    firstEdgeId,
    secondEdgeId,
    ...(request.controlCoordinate !== undefined
      ? { controlCoordinate: Number(request.controlCoordinate) }
      : {}),
  });
  const surface = state.surfaces.get(id);
  if (!surface) {
    throw new Error(`2-cell creation failed: ${id}`);
  }
  if (request.name !== undefined) {
    applyAgentOperation(state, "simplex:rename", {
      id,
      name: String(request.name),
    });
  }
  if (request.text !== undefined) {
    setTextPayloadForAgents(state, id, request.text);
  }
  return inspectObjectForAgents(workspace, { gologId: golog.id, objectId: id })
    .object;
}

function createTwoSimplexForAgents(workspace, request = {}) {
  const golog = gologOrThrow(workspace, request.gologId);
  const state = golog.state;
  const id = request.id ?? `two-simplex-${state.nextSurfaceId}`;
  if (request.id && request.id !== `two-simplex-${state.nextSurfaceId}`) {
    throw new Error(
      "Explicit 2-simplex ids must match the store's next surface id",
    );
  }
  const edgeIds = Array.isArray(request.edgeIds)
    ? request.edgeIds.map(String)
    : [];
  if (edgeIds.length !== 3) {
    throw new Error("createTwoSimplex requires exactly three edgeIds");
  }

  applyAgentOperation(state, "element:create", {
    elementKind: ELEMENT_KINDS.TWO_SIMPLEX,
    id,
    edgeIds,
    ...(request.controlCoordinate !== undefined
      ? { controlCoordinate: Number(request.controlCoordinate) }
      : {}),
  });
  const surface = state.surfaces.get(id);
  if (!surface) {
    throw new Error(`2-simplex creation failed: ${id}`);
  }
  if (request.name !== undefined) {
    applyAgentOperation(state, "simplex:rename", {
      id,
      name: String(request.name),
    });
  }
  if (request.text !== undefined) {
    setTextPayloadForAgents(state, id, request.text);
  }
  return inspectObjectForAgents(workspace, { gologId: golog.id, objectId: id })
    .object;
}

function createThetaVolumeForAgents(workspace, request = {}) {
  const golog = gologOrThrow(workspace, request.gologId);
  const state = golog.state;
  const id = request.id ?? `volume-${state.nextVolumeId}`;
  applyAgentOperation(state, "element:create", {
    elementKind: "theta-volume",
    id,
    name: String(request.name ?? ""),
    schemaRef: request.schemaRef,
    shapeId: request.shapeId,
    thetaIndex: request.thetaIndex,
    faces: request.faces,
  });
  if (!state.volumes.has(id)) throw new Error(`Volume creation failed: ${id}`);
  if (request.text !== undefined) setTextPayloadForAgents(state, id, request.text);
  return inspectObjectForAgents(workspace, { gologId: golog.id, objectId: id }).object;
}

function deleteEdgeForAgents(workspace, request = {}) {
  const golog = gologOrThrow(workspace, request.gologId);
  const state = golog.state;
  const id = request.objectId ?? request.id;
  if (!id) {
    throw new Error("deleteEdge requires objectId or id");
  }
  const edgeId = String(id);
  if (!state.edges.has(edgeId)) {
    throw new Error(`Edge does not exist: ${golog.id}:${edgeId}`);
  }

  const surfaceIds = state.surfacesForEdge(edgeId).map((surface) => surface.id);
  const result = applyAgentOperation(state, "edge:delete", {
    id: edgeId,
    surfaceIds,
  });
  return {
    format: GOLOG_AGENT_API_FORMAT,
    version: GOLOG_AGENT_API_VERSION,
    gologId: golog.id,
    objectId: edgeId,
    deleted: true,
    deletedSurfaceIds: result.result?.surfaceIds ?? surfaceIds,
  };
}

function compactObjectForDeletion(object, reason = "direct target", supportedBy = null) {
  return {
    objectId: object.objectId,
    kind: object.kind,
    dimension: object.dimension,
    name: object.name ?? "",
    reason,
    supportedBy,
  };
}

function supportReasonForDeletion(supportObject, candidate) {
  if (candidate.dimension === 1) {
    return "incident to deleted node";
  }
  if (candidate.dimension === 2 && supportObject?.dimension === 1) {
    return "uses supported edge as boundary";
  }
  if (candidate.dimension === 2 && supportObject?.dimension === 0) {
    return "uses supported node as face";
  }
  return "supported by deleted object";
}

function supportClosureForDeletion(golog, objectId) {
  const objects = collectGologObjects(golog, { includePayloadText: false });
  const byId = new Map(objects.map((object) => [object.objectId, object]));
  const root = byId.get(objectId);
  if (!root) {
    return null;
  }

  const mathematicalSupport = golog.state.getPresheaf().support([objectId]);
  const parents = new Map(mathematicalSupport.map(({ id, supportedBy }) => [id, supportedBy]));
  const storedParent = (id) => {
    while (id && !byId.has(id)) id = parents.get(id);
    return id;
  };
  const closure = mathematicalSupport.filter(({ id }) => byId.has(id))
    .map(({ id, supportedBy }) => ({ id, supportedBy: storedParent(supportedBy) }))
    .map(({ id, supportedBy }) =>
    compactObjectForDeletion(byId.get(id), supportedBy
      ? supportReasonForDeletion(byId.get(supportedBy), byId.get(id))
      : "direct target", supportedBy));

  const deletionOrder = [...closure].sort(
    (left, right) => Number(right.dimension ?? 0) - Number(left.dimension ?? 0),
  );
  return {
    root: compactObjectForDeletion(root),
    objects: closure,
    dependent: closure.slice(1),
    deletionOrder,
  };
}

function countBy(entries, keyForEntry) {
  const counts = new Map();
  for (const entry of entries) {
    const key = String(keyForEntry(entry) ?? "unknown");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, count]) => ({ key, count }));
}

function objectDeletionSummary(objects) {
  return {
    total: objects.length,
    byKind: countBy(objects, (object) => object.kind),
    byDimension: countBy(objects, (object) => `${object.dimension ?? "unknown"}`),
  };
}

function payloadRecordsForDeletion(golog, objects) {
  return objects.flatMap((object) =>
    payloadRecordsForAgents(golog, object.objectId).map((payload) => ({
      objectId: object.objectId,
      key: payload.key,
      kind: payload.kind,
      type: payload.type,
    })),
  );
}

function payloadDeletionSummary(payloads) {
  return {
    total: payloads.length,
    objectCount: new Set(payloads.map((payload) => payload.objectId)).size,
    byType: countBy(payloads, (payload) => payload.type),
    byKind: countBy(payloads, (payload) => payload.kind),
  };
}

function pluralDeletionLabel(label, count) {
  if (count === 1) {
    return label;
  }
  if (label.endsWith("simplex")) {
    return `${label}es`;
  }
  return `${label}s`;
}

function deletionSummaryText(summary, labelForKey = (key) => key) {
  return summary
    .map(({ key, count }) => `${count} ${pluralDeletionLabel(labelForKey(key), count)}`)
    .join(", ");
}

function deletionWarningText(objectSummary, payloadSummaryForPlan) {
  const objectText =
    deletionSummaryText(objectSummary.byKind, (kind) => kind) ||
    "no objects";
  const payloadText =
    payloadSummaryForPlan.total > 0
      ? deletionSummaryText(payloadSummaryForPlan.byKind, (kind) => `${kind} payload`)
      : "no payload data";
  return `Deletes ${objectSummary.total} object${objectSummary.total === 1 ? "" : "s"} (${objectText}) and ${payloadText}.`;
}

function blockedReasonsForDeletionPlan(object, dependent, cascade) {
  if (dependent.length === 0 || cascade !== "none") {
    return [];
  }
  if (object.dimension === 0) {
    return ["node has incident supported objects"];
  }
  if (object.dimension === 1) {
    return ["edge has dependent 2-cells or 2-simplexes"];
  }
  return ["object has supported graphical elements"];
}

function objectDeletionPlanForAgents(workspace, request = {}) {
  const golog = gologOrThrow(workspace, request.gologId);
  const objectId = String(request.objectId ?? request.id ?? "");
  if (!objectId) {
    throw new Error("deleteObject requires objectId");
  }
  const closure = supportClosureForDeletion(golog, objectId);
  if (!closure) {
    throw new Error(`Object does not exist: ${golog.id}:${objectId}`);
  }
  const cascade = request.cascade ?? "none";
  const direct = [closure.root];
  const dependent = closure.dependent;
  const detachedPayloads = payloadRecordsForDeletion(golog, closure.objects);
  const objectSummary = objectDeletionSummary(closure.objects);
  const payloadSummary = payloadDeletionSummary(detachedPayloads);
  const blockedReasons = blockedReasonsForDeletionPlan(
    closure.root,
    dependent,
    cascade,
  );
  try { assertShapeExpansionDeletionAllowed(golog.state, objectId); }
  catch (error) { blockedReasons.push(error.message); }

  return {
    format: GOLOG_AGENT_API_FORMAT,
    version: GOLOG_AGENT_API_VERSION,
    gologId: golog.id,
    objectId,
    cascade,
    destructive: true,
    ok: blockedReasons.length === 0,
    blocked: blockedReasons.length > 0,
    blockedReasons,
    direct,
    dependent,
    detachedPayloads,
    supportClosure: closure.objects,
    deletionOrder: closure.deletionOrder,
    objectSummary,
    payloadSummary,
    warning: deletionWarningText(objectSummary, payloadSummary),
  };
}

function supportedObjectsForAgents(workspace, request = {}) {
  const golog = gologOrThrow(workspace, request.gologId);
  const objectId = String(request.objectId ?? request.id ?? "");
  if (!objectId) {
    throw new Error("supportedObjects requires objectId");
  }
  const closure = supportClosureForDeletion(golog, objectId);
  if (!closure) {
    throw new Error(`Object does not exist: ${golog.id}:${objectId}`);
  }
  const detachedPayloads = payloadRecordsForDeletion(golog, closure.objects);
  const objectSummary = objectDeletionSummary(closure.objects);
  const payloadSummary = payloadDeletionSummary(detachedPayloads);
  return {
    format: GOLOG_AGENT_API_FORMAT,
    version: GOLOG_AGENT_API_VERSION,
    gologId: golog.id,
    objectId,
    objects: closure.objects,
    supportedObjects: closure.dependent,
    deletionOrder: closure.deletionOrder,
    detachedPayloads,
    objectSummary,
    payloadSummary,
    warning: deletionWarningText(objectSummary, payloadSummary),
  };
}

function deleteObjectForAgents(workspace, request = {}) {
  const plan = objectDeletionPlanForAgents(workspace, request);
  const dryRun = request.dryRun !== false || !request.confirmed;
  if (dryRun || plan.blocked) {
    return {
      ...plan,
      dryRun: true,
      requiresConfirmation: !request.confirmed,
    };
  }

  const golog = gologOrThrow(workspace, plan.gologId);
  const state = golog.state;
  let result = null;
  if (state.volumes?.has(plan.objectId)) {
    result = applyAgentOperation(state, "volume:delete", { id: plan.objectId }).result;
  } else if (state.surfaces.has(plan.objectId)) {
    result = applyAgentOperation(state, "surface:delete", {
      id: plan.objectId,
    }).result;
  } else if (state.edges.has(plan.objectId)) {
    result = applyAgentOperation(state, "edge:delete", {
      id: plan.objectId,
      surfaceIds: state.surfacesForEdge(plan.objectId).map((surface) => surface.id),
    }).result;
  } else if (state.spheres.has(plan.objectId)) {
    const edgeIds = state.connectedEdges(plan.objectId).map((edge) => edge.id);
    const surfaceIds = [
      ...new Set(
        edgeIds.flatMap((edgeId) =>
          state.surfacesForEdge(edgeId).map((surface) => surface.id),
        ),
      ),
    ];
    result = applyAgentOperation(state, "sphere:delete", {
      id: plan.objectId,
      cascadeEdges: plan.cascade !== "none",
      edgeIds,
      surfaceIds,
    }).result;
  }

  return {
    ...plan,
    dryRun: false,
    deleted: true,
    deletedObjects: plan.supportClosure,
    deletedObjectIds: plan.supportClosure.map((object) => object.objectId),
    deletedPayloads: plan.detachedPayloads,
    result,
  };
}

function deleteObjectsForAgents(workspace, request = {}) {
  const objectIds = [
    ...new Set(
      (request.objectIds ?? request.ids ?? [])
        .filter(Boolean)
        .map((objectId) => String(objectId)),
    ),
  ];
  if (objectIds.length === 0) {
    throw new Error("deleteObjects requires objectIds");
  }
  const dryRun = request.dryRun !== false || !request.confirmedBulk;
  if (dryRun) {
    return {
      format: GOLOG_AGENT_API_FORMAT,
      version: GOLOG_AGENT_API_VERSION,
      gologId: request.gologId ?? null,
      destructive: true,
      dryRun: true,
      requiresConfirmation: !request.confirmedBulk,
      count: objectIds.length,
      plans: objectIds.map((objectId) =>
        objectDeletionPlanForAgents(workspace, {
          ...request,
          objectId,
        }),
      ),
    };
  }
  const results = [];
  for (const objectId of objectIds) {
    results.push(
      deleteObjectForAgents(workspace, {
        ...request,
        objectId,
        dryRun: false,
        confirmed: true,
      }),
    );
  }
  return {
    format: GOLOG_AGENT_API_FORMAT,
    version: GOLOG_AGENT_API_VERSION,
    gologId: request.gologId ?? null,
    destructive: true,
    dryRun: false,
    count: results.length,
    results,
  };
}

function rebaseEdgeForAgents(workspace, request = {}) {
  const golog = gologOrThrow(workspace, request.gologId);
  const state = golog.state;
  const edgeId = String(request.edgeId ?? request.objectId ?? request.id ?? "");
  const sourceId = String(request.sourceId ?? "");
  const targetId = String(request.targetId ?? "");
  if (!edgeId || !sourceId || !targetId) {
    throw new Error("rebaseEdge requires edgeId, sourceId, and targetId");
  }
  const edge = state.edges.get(edgeId);
  if (!edge) {
    throw new Error(`Edge does not exist: ${golog.id}:${edgeId}`);
  }
  if (!state.spheres.has(sourceId) || !state.spheres.has(targetId)) {
    throw new Error("rebaseEdge endpoints must be existing nodes");
  }
  const cascade = request.cascade ?? "none";
  const dependentSurfaceIds = state.surfacesForEdge(edgeId).map((surface) => surface.id);
  const blockedReasons = [];
  if (dependentSurfaceIds.length > 0 && cascade === "none") {
    blockedReasons.push("edge has dependent 2-cells or 2-simplexes");
  }
  const plan = {
    format: GOLOG_AGENT_API_FORMAT,
    version: GOLOG_AGENT_API_VERSION,
    gologId: golog.id,
    objectId: edgeId,
    destructive: true,
    cascade,
    ok: blockedReasons.length === 0,
    blocked: blockedReasons.length > 0,
    blockedReasons,
    before: {
      sourceId: edge.sourceId,
      targetId: edge.targetId,
      bend: clonePatchValue(edge.bend),
    },
    after: {
      sourceId,
      targetId,
      preserveBend: request.preserveBend !== false,
    },
    dependentSurfaceIds,
  };
  const dryRun = request.dryRun !== false || !request.confirmed;
  if (dryRun || plan.blocked) {
    return {
      ...plan,
      dryRun: true,
      requiresConfirmation: !request.confirmed,
    };
  }

  const result = applyAgentOperation(state, "edge:rebase", {
    id: edgeId,
    sourceId,
    targetId,
    surfaceIds: dependentSurfaceIds,
    cascadeSurfaces: cascade !== "none",
    preserveBend: request.preserveBend !== false,
  });
  return {
    ...plan,
    dryRun: false,
    rebased: true,
    result: result.result ?? null,
    object: inspectObjectForAgents(workspace, {
      gologId: golog.id,
      objectId: edgeId,
    }).object,
  };
}

function gologReferencesForAgents(workspace, targetGologId) {
  const references = [];
  for (const golog of workspace.gologs.values()) {
    for (const object of collectGologObjects(golog, { includePayloadText: false })) {
      for (const payload of object.payloads ?? []) {
        if (
          payload.kind === "nested-golog" &&
          payload.targetGologId === targetGologId
        ) {
          references.push({
            gologId: golog.id,
            objectId: object.objectId,
            objectName: object.name ?? "",
            key: payload.key ?? "nested-golog",
          });
        }
      }
      if (object.childGologId === targetGologId) {
        references.push({
          gologId: golog.id,
          objectId: object.objectId,
          objectName: object.name ?? "",
          key: "childGologId",
        });
      }
    }
  }
  return references.filter(
    (reference, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.gologId === reference.gologId &&
          candidate.objectId === reference.objectId &&
          candidate.key === reference.key,
      ) === index,
  );
}

function deleteGologForAgents(app, request = {}) {
  const workspace = app.workspace;
  const gologId = String(request.gologId ?? request.id ?? "");
  if (!gologId) {
    throw new Error("deleteGolog requires gologId");
  }
  const golog = workspace.gologs.get(gologId);
  if (!golog) {
    throw new Error(`Golog does not exist: ${gologId}`);
  }
  const references = gologReferencesForAgents(workspace, gologId);
  const blockedReasons = [];
  if (references.length > 0) {
    blockedReasons.push("golog is still referenced by nested-golog payloads");
  }
  if (workspace.gologs.size <= 1) {
    blockedReasons.push("cannot delete the only golog in a workspace");
  }
  const plan = {
    format: GOLOG_AGENT_API_FORMAT,
    version: GOLOG_AGENT_API_VERSION,
    gologId,
    title: golog.title,
    destructive: true,
    ok: blockedReasons.length === 0,
    blocked: blockedReasons.length > 0,
    blockedReasons,
    references,
  };
  const dryRun = request.dryRun !== false || !request.confirmed;
  if (dryRun || plan.blocked) {
    return {
      ...plan,
      dryRun: true,
      requiresConfirmation: !request.confirmed,
    };
  }
  const deleted = app.deleteGolog
    ? app.deleteGolog(gologId)
    : workspace.deleteGolog(gologId);
  return {
    ...plan,
    dryRun: false,
    deleted,
    activeGologId: workspace.activeGologId,
  };
}

function attachTextForAgents(workspace, request = {}) {
  const golog = gologOrThrow(workspace, request.gologId);
  if (!request.objectId) {
    throw new Error("attachText requires objectId");
  }
  setTextPayloadForAgents(golog.state, String(request.objectId), request.text ?? "");
  return inspectObjectForAgents(workspace, {
    gologId: golog.id,
    objectId: String(request.objectId),
  }).object;
}

function attachGologForAgents(workspace, request = {}) {
  const golog = gologOrThrow(workspace, request.gologId);
  if (!request.objectId || !request.targetGologId) {
    throw new Error("attachGolog requires objectId and targetGologId");
  }
  if (!workspace.gologs.has(String(request.targetGologId))) {
    throw new Error(`Target golog does not exist: ${request.targetGologId}`);
  }
  applyAgentOperation(golog.state, "payload:golog-attach", {
    id: String(request.objectId),
    targetGologId: String(request.targetGologId),
    rootObjectId: request.rootObjectId,
  });
  return inspectObjectForAgents(workspace, {
    gologId: golog.id,
    objectId: String(request.objectId),
  }).object;
}

function runForceLayoutForAgents(app, request = {}) {
  const golog = gologOrThrow(app.workspace, request.gologId);
  const origin = { source: "agent-api-force-layout" };
  const controller =
    app.createForceLayout?.(golog, { origin }) ??
    createForceLayoutController({
      store: golog.state,
      bus: golog.bus,
      origin,
    });
  const steps = Math.max(0, Number(request.steps ?? 1));
  const result = controller.run(steps, request.options ?? {});
  const operation = request.commit
    ? controller.commit(result, { layoutId: request.layoutId ?? "agent-force-layout" })
    : null;
  controller.dispose();
  return {
    format: GOLOG_AGENT_API_FORMAT,
    version: GOLOG_AGENT_API_VERSION,
    gologId: golog.id,
    tick: result.tick,
    diagnostics: result.diagnostics,
    edgeControls: result.edgeControls.map((entry) => ({ ...entry, bend: entry.bend.toArray(), midpoint: entry.midpoint.toArray() })),
    surfaceControls: result.surfaceControls,
    committedOperationId: operation?.id ?? null,
    positions: result.positions.map((entry) => ({
      id: entry.id,
      position: entry.position.toArray(),
    })),
  };
}

function inspectPresheafForAgents(workspace, request = {}) {
  const golog = gologOrThrow(workspace, request.gologId);
  const presheaf = golog.state.getPresheaf();
  return {
    gologId: golog.id,
    categoryId: presheaf.category.id,
    status: "verified",
    scope: "finite sets and all equations in the declared boundary presentation",
    counts: Object.fromEntries(presheaf.category.objects.map((shape) =>
      [shape, presheaf.at(shape).length])),
    ...(golog.state.volumes.size ? { derivedRestrictionCount: presheaf.toJSON().elements
      .filter((element) => !golog.state.hasSelectableSimplex(element.id)).length } : {}),
    ...(request.includeCategory ? { category: presheaf.category.toJSON() } : {}),
    ...(request.objectId ? { element: presheaf.get(request.objectId) } : {}),
    ...(request.shape ? { elements: presheaf.at(request.shape) } : {}),
  };
}

export function createGologAgentApi(app) {
  const workspace = app.workspace;
  const api = {
    format: GOLOG_AGENT_API_FORMAT,
    version: GOLOG_AGENT_API_VERSION,
    exportWorkspace: (options = {}) =>
      exportWorkspaceForAgents(workspace, options),
    serializeWorkspace: () => serializeWorkspace(workspace),
    saveDocument: () => stringifyWorkspaceDocument(workspace),
    loadDocument: (text) => {
      if (!app.loadWorkspaceDocumentText) {
        throw new Error("Document loading is unavailable in this agent context");
      }
      const loaded = app.loadWorkspaceDocumentText(text);
      const finish = () => exportWorkspaceForAgents(workspace);
      return loaded?.then ? loaded.then(finish) : finish();
    },
    query: (criteria = {}) => queryWorkspaceForAgents(workspace, criteria),
    lookup: (criteria = {}) => queryWorkspaceForAgents(workspace, criteria),
    inspect: (request) => inspectObjectForAgents(workspace, request),
    inspectPresheaf: (request = {}) => inspectPresheafForAgents(workspace, request),
    restrictElement: (request = {}) => gologOrThrow(workspace, request.gologId)
      .state.getPresheaf().restrict(request.objectId, request.path ?? []),
    neighborhood: (request) => neighborhoodForAgents(workspace, request),
    createGolog: (request = {}) => createGologForAgents(app, request),
    activateGolog: (request = {}) => activateGologForAgents(app, request),
    createNode: (request = {}) => createNodeForAgents(workspace, request),
    createNodes: (request = {}) => createNodesForAgents(workspace, request),
    createElements: (request = {}) => createElementsForAgents(workspace, request),
    createEdge: (request = {}) => createEdgeForAgents(workspace, request),
    createTightArrow: (request = {}) =>
      createEdgeForAgents(workspace, {
        ...request,
        elementKind: VIRTUAL_DOUBLE_ELEMENT_KINDS.TIGHT_ARROW,
      }),
    createProarrow: (request = {}) =>
      createEdgeForAgents(workspace, {
        ...request,
        elementKind: VIRTUAL_DOUBLE_ELEMENT_KINDS.PROARROW,
      }),
    createVirtualCell: (request = {}) =>
      createVirtualCellForAgents(workspace, request),
    createTwoCell: (request = {}) => createTwoCellForAgents(workspace, request),
    createThetaVolume: (request = {}) => createThetaVolumeForAgents(workspace, request),
    createTwoSimplex: (request = {}) =>
      createTwoSimplexForAgents(workspace, request),
    deleteEdge: (request = {}) => deleteEdgeForAgents(workspace, request),
    supportedObjects: (request = {}) => supportedObjectsForAgents(workspace, request),
    deleteObject: (request = {}) => deleteObjectForAgents(workspace, request),
    deleteObjects: (request = {}) => deleteObjectsForAgents(workspace, request),
    deleteGolog: (request = {}) => deleteGologForAgents(app, request),
    rebaseEdge: (request = {}) => rebaseEdgeForAgents(workspace, request),
    inspectPayloads: (request = {}) => inspectPayloadsForAgents(workspace, request),
    updatePayload: (request = {}) => updatePayloadForAgents(workspace, request),
    replacePayload: (request = {}) => replacePayloadForAgents(workspace, request),
    deletePayload: (request = {}) => deletePayloadForAgents(workspace, request),
    attachText: (request = {}) => attachTextForAgents(workspace, request),
    attachPayload: (request = {}) => setTypedPayloadForAgents(workspace, request),
    attachLatex: (request = {}) => attachLatexForAgents(workspace, request),
    renderLatex: (request = {}) => renderLatexForAgents(workspace, request),
    compileLatexSnippet: (request = {}) => compileLatexSnippetForAgents(request),
    replaceLatexPayload: (request = {}) =>
      replaceLatexPayloadForAgents(workspace, request),
    attachCode: (request = {}) => attachCodeForAgents(workspace, request),
    attachImage: (request = {}) => attachImageForAgents(workspace, request),
    attachUrl: (request = {}) => attachUrlForAgents(workspace, request),
    attachGolog: (request = {}) => attachGologForAgents(workspace, request),
    createExpansion: (request = {}) => createShapeExpansion(app, request),
    inspectExpansion: (request = {}) => inspectShapeExpansion(workspace, request),
    runForceLayout: (request = {}) => runForceLayoutForAgents(app, request),
    transcript: (options = {}) => createOperationTranscript(workspace, options),
    validatePatches: (patches) => validateAgentPatches(workspace, patches),
    applyPatches: ({ patches, label = "Agent patch", dryRun = false }) => {
      const validation = validateAgentPatches(workspace, patches);
      if (!validation.ok || dryRun) {
        return {
          ok: validation.ok,
          dryRun: Boolean(dryRun),
          errors: validation.errors,
          patches: validation.patches,
          inverse: validation.inverse,
        };
      }

      workspace.patchHistory.applyOperations(validation.patches);
      const transaction = workspace.patchHistory.recordTransaction({
        label,
        patches: validation.patches,
        inverse: validation.inverse,
      });
      return {
        ok: true,
        transaction,
        history: workspace.patchHistory.summary(),
      };
    },
    undo: () => {
      const transaction = workspace.patchHistory.undo();
      return { ok: Boolean(transaction), transaction };
    },
    redo: () => {
      const transaction = workspace.patchHistory.redo();
      return { ok: Boolean(transaction), transaction };
    },
  };
  // Semantic reads and edits are explicit barriers for resident layout state.
  return Object.fromEntries(Object.entries(api).map(([key, value]) => [key,
    typeof value === "function" ? (...args) => {
      app.flushLayout?.();
      return value(...args);
    } : value,
  ]));
}
