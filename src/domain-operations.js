import {
  applyOperationToStore,
  DOMAIN_OPERATION_TYPES,
  hasDomainOperationType,
  prepareOperationPayload,
  primaryResourceIdForOperation,
  writeResourceIdsForOperation,
} from "./operation-descriptors.js";
import { normalizeResourceId } from "./resource-ids.js";
import { normalizePeerContext } from "./peer-context.js";

export const DOMAIN_OPERATION_FORMAT = "golog.domain-operation";
export const DOMAIN_OPERATION_VERSION = 1;
export const DOMAIN_OPERATION_APPLY_EVENT = "operation:apply";
export const DOMAIN_OPERATION_APPLIED_EVENT = "operation:applied";
export const DOMAIN_OPERATION_REJECTED_EVENT = "operation:rejected";

export { DOMAIN_OPERATION_TYPES };

function operationToken() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

function prepareResourceIds(gologId, type, payload, resourceId, provided = null) {
  return [
    ...new Set([
      resourceId,
      ...(provided ??
        writeResourceIdsForOperation(gologId, type, payload, resourceId)),
    ].map((id) => normalizeResourceId(id))),
  ].filter(Boolean);
}

export function createDomainOperation(store, type, payload = {}, options = {}) {
  if (!hasDomainOperationType(type)) {
    throw new Error(`Unsupported domain operation type: ${type}`);
  }
  const operationPayload = prepareOperationPayload(store, type, payload);
  const gologId = options.gologId ?? store.gologId;
  const resourceId =
    options.resourceId ??
    primaryResourceIdForOperation(gologId, type, operationPayload);
  return {
    format: DOMAIN_OPERATION_FORMAT,
    version: DOMAIN_OPERATION_VERSION,
    id: options.id ?? operationToken(),
    gologId,
    type,
    resourceId,
    resourceIds: prepareResourceIds(
      gologId,
      type,
      operationPayload,
      resourceId,
      options.resourceIds,
    ),
    origin: normalizePeerContext(options.origin ?? { source: "local-bus" }),
    createdAt: options.createdAt ?? Date.now(),
    payload: operationPayload,
  };
}

export function normalizeDomainOperation(store, operation) {
  if (operation?.format === DOMAIN_OPERATION_FORMAT) {
    if (!hasDomainOperationType(operation.type)) {
      throw new Error(`Unsupported domain operation type: ${operation.type}`);
    }
    const gologId = operation.gologId ?? store.gologId;
    const payload = prepareOperationPayload(store, operation.type, operation.payload);
    const resourceId =
      operation.resourceId ??
      primaryResourceIdForOperation(gologId, operation.type, payload);
    return {
      ...operation,
      gologId,
      resourceId,
      resourceIds: prepareResourceIds(
        gologId,
        operation.type,
        payload,
        resourceId,
        operation.resourceIds,
      ),
      origin: normalizePeerContext(operation.origin ?? { source: "remote-replay" }),
      payload,
    };
  }
  return createDomainOperation(store, operation?.type, operation?.payload, operation);
}

export function applyDomainOperation(store, operation) {
  const normalized = normalizeDomainOperation(store, operation);
  if (normalized.gologId !== store.gologId) {
    return {
      ok: false,
      operation: normalized,
      reason: "wrong-golog",
    };
  }

  const result = applyOperationToStore(store, normalized);

  return {
    ok: result !== false && result !== null,
    operation: normalized,
    result,
    reason: result === false || result === null ? "operation-rejected" : null,
  };
}

export function applyAndEmitDomainOperation(store, bus, operation) {
  const normalized = normalizeDomainOperation(store, operation);
  const policyDecision = store.mutationPolicy?.evaluate(normalized);
  const result =
    policyDecision && !policyDecision.ok
      ? {
          ok: false,
          operation: normalized,
          reason: policyDecision.reason,
          policy: policyDecision,
        }
      : applyDomainOperation(store, normalized);
  bus.emit(
    result.ok ? DOMAIN_OPERATION_APPLIED_EVENT : DOMAIN_OPERATION_REJECTED_EVENT,
    result,
  );
  return result;
}
