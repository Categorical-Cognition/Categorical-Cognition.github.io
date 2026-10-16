import {
  getDomainOperationDescriptor,
  requiredClaimGroupsForOperation,
  writeResourceIdsForOperation,
} from "./operation-descriptors.js";
import { normalizeResourceId } from "./resource-ids.js";

export const OPERATION_RESOURCE_MANIFEST_FORMAT =
  "golog.operation-resource-manifest";
export const OPERATION_RESOURCE_MANIFEST_VERSION = 1;

function normalizeIds(ids = []) {
  const entries = Array.isArray(ids) ? ids : [ids];
  return [
    ...new Set(
      entries
        .filter(Boolean)
        .map((resourceId) => normalizeResourceId(resourceId)),
    ),
  ];
}

export function compileOperationResourceManifest(operation = {}) {
  const gologId = operation.gologId;
  const payload = operation.payload ?? {};
  const descriptor = getDomainOperationDescriptor(operation.type);
  const providedResources = operation.resourceIds ?? operation.resourceId ?? null;
  const writeResources = normalizeIds(
    providedResources ??
      (descriptor
        ? writeResourceIdsForOperation(
            gologId,
            operation.type,
            payload,
            operation.resourceId ?? null,
          )
        : []),
  );
  const requiredClaimGroups = requiredClaimGroupsForOperation(
    gologId,
    operation.type,
    payload,
    writeResources,
  );

  const normalizedGroups = requiredClaimGroups.filter((group) => group.length > 0);
  return {
    format: OPERATION_RESOURCE_MANIFEST_FORMAT,
    version: OPERATION_RESOURCE_MANIFEST_VERSION,
    gologId,
    operationId: operation.id ?? null,
    operationType: operation.type ?? null,
    writeResources,
    requiredClaimGroups: normalizedGroups,
    requiredClaimResources: normalizeIds(normalizedGroups.flat()),
  };
}
