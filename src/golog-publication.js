import { GologWorkspace } from "./golog-workspace.js";
import { normalizeWorkspaceDocument, serializeWorkspace } from "./workspace-serialization.js";
import { structureDefinitionFor } from "./structure-definition-registry.js";
import { PAYLOAD_TYPES } from "./payload-types.js";

export function gologPublication(workspace, gologId) {
  const golog = workspace.gologs.get(gologId);
  if (!golog) throw new Error(`Golog does not exist: ${gologId}`);
  const document = serializeWorkspace({ ...workspace, gologs: new Map([[golog.id, golog]]) });
  return { record: document.gologs[0], attachments: document.attachments };
}

function populate(golog, record, attachments) {
  const definition = structureDefinitionFor(record.structure.id);
  for (const element of [...record.elements].sort((a, b) => a.dimension - b.dimension)) {
    if (!golog.state.createElement(definition.creationPayload(element))) {
      throw new Error(`Unable to publish element: ${element.id}`);
    }
  }
  for (const { owner, payload } of attachments) {
    if (!golog.state.attachTypedPayload(owner.objectId, payload)) {
      throw new Error(`Unable to publish payload: ${owner.objectId}`);
    }
  }
  golog.state.selectedSphereId = null;
  golog.state.selectedSimplexId = null;
}

// Publications add one complete golog. They cannot overwrite another peer's
// document, its active golog, history, or an existing catalog entry.
export function appendGologPublication(workspace, publication) {
  const id = publication?.record?.id;
  if (!id || workspace.gologs.has(id)) throw new Error(`Golog publication id collision: ${id ?? "missing"}`);
  const attachments = publication.attachments ?? [];
  if (attachments.some(({ owner }) => owner?.gologId !== id)) {
    throw new Error("Golog publication may only carry its own attachments");
  }
  const current = serializeWorkspace(workspace);
  const document = normalizeWorkspaceDocument({ ...current,
    gologs: [...current.gologs, publication.record],
    attachments: [...current.attachments, ...attachments] });
  const record = document.gologs.find((entry) => entry.id === id);
  const normalizedAttachments = document.attachments.filter(({ owner }) => owner.gologId === id);
  // Run all handler validation against an isolated new store before membership
  // changes. Existing stores are available for read-only reference checks.
  const staged = new GologWorkspace();
  staged.gologs = new Map(workspace.gologs);
  const options = { id, title: record.title, createdAt: record.createdAt,
    structureId: record.structure.id, schema: record.structure.schema };
  populate(staged.createGolog(options), record, normalizedAttachments);
  const golog = workspace.createGolog(options);
  populate(golog, record, normalizedAttachments);
  return golog;
}

export function publicationFingerprint(publication) {
  return JSON.stringify(publication);
}

export function assertGologPublicationRetractionAllowed(workspace, gologId, fingerprint) {
  if (!workspace.gologs.has(gologId)) return false;
  if (publicationFingerprint(gologPublication(workspace, gologId)) !== fingerprint) {
    throw new Error("Publication cleanup blocked: the child has changed");
  }
  const meta = workspace.gologs.get(workspace.metaGolog?.gologId);
  const metaNodeId = workspace.metaGolog?.nodeByGologId?.[gologId];
  for (const golog of workspace.gologs.values()) {
    for (const [id] of golog.state.payloadAttachments) {
      for (const payload of golog.state.getPayloads(id)) {
        if (payload.type === PAYLOAD_TYPES.NESTED_GOLOG && payload.targetGologId === gologId) {
          if (golog === meta && id === metaNodeId) continue;
          throw new Error(`Publication cleanup blocked: ${golog.id}/${id} references the child`);
        }

      }
    }
  }
  if (meta?.state.spheres.has(metaNodeId)) {
    const node = meta.state.spheres.get(metaNodeId);
    const payloads = meta.state.getPayloads(metaNodeId);
    if (node.name !== workspace.gologs.get(gologId).title || payloads.length !== 1 ||
      payloads[0].type !== PAYLOAD_TYPES.NESTED_GOLOG || meta.state.connectedEdges(metaNodeId).length) {
      throw new Error("Publication cleanup blocked: its catalog node carries other work");
    }
  }
  return { meta, metaNodeId };
}

export async function retractGologPublication(workspace, gologId, fingerprint,
  { deleteGolog = (id) => workspace.deleteGolog(id) } = {}) {
  const details = assertGologPublicationRetractionAllowed(workspace, gologId, fingerprint);
  if (!details) return false;
  const { meta, metaNodeId } = details;
  if (meta?.state.spheres.has(metaNodeId)) {
    const result = await meta.state.operationPipeline.submit("sphere:delete", { id: metaNodeId },
      { origin: { source: "structured-creation-service", role: "system" } });
    if (!result.ok) throw new Error(`Publication cleanup blocked: ${result.reason}`);
  }
  assertGologPublicationRetractionAllowed(workspace, gologId, fingerprint);
  return deleteGolog(gologId);
}
