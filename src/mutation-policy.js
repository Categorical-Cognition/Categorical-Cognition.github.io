import { scoreCapabilityProfile } from "./capability-profile.js";
import { DOMAIN_OPERATION_TYPES } from "./domain-operations.js";
import { compileOperationResourceManifest } from "./operation-resource-manifest.js";
import { normalizePeerContext } from "./peer-context.js";
import { cloneStoreValue } from "./store-utils.js";

export const MUTATION_POLICY_DECIDED_EVENT = "mutation-policy:decided";

const DEFAULT_MAX_FUTURE_SKEW_MS = 60_000;

export class MutationPolicy {
  constructor({
    bus,
    store,
    resourceAuthority,
    now = () => Date.now(),
    maxFutureSkewMs = DEFAULT_MAX_FUTURE_SKEW_MS,
  }) {
    this.bus = bus;
    this.store = store;
    this.resourceAuthority = resourceAuthority;
    this.now = now;
    this.maxFutureSkewMs = maxFutureSkewMs;
  }

  evaluate(operation, { emit = true } = {}) {
    const checks = [];
    const peer = normalizePeerContext(operation.origin);
    const manifest = compileOperationResourceManifest(operation);

    const typeCheck = {
      name: "operation-type",
      ok: DOMAIN_OPERATION_TYPES.has(operation.type),
      reason: DOMAIN_OPERATION_TYPES.has(operation.type)
        ? "supported-operation"
        : "unsupported-operation",
    };
    checks.push(typeCheck);

    const resourceIds = manifest.writeResources;
    const resourceCheck = {
      name: "resource-ids",
      ok: resourceIds.length > 0 && manifest.requiredClaimGroups.length > 0,
      reason:
        resourceIds.length > 0 && manifest.requiredClaimGroups.length > 0
          ? "resources-present"
          : "missing-resource-id",
    };
    checks.push(resourceCheck);

    const createdAt = Number(operation.createdAt ?? this.now());
    const freshnessCheck = {
      name: "freshness",
      ok: Number.isFinite(createdAt) && createdAt <= this.now() + this.maxFutureSkewMs,
      reason:
        Number.isFinite(createdAt) && createdAt <= this.now() + this.maxFutureSkewMs
          ? "fresh-enough"
          : "operation-from-future",
    };
    checks.push(freshnessCheck);

    const authority = this.resourceAuthority.evaluateOperationAuthority(operation, {
      emit,
      manifest,
    });
    checks.push({
      name: "resource-authority",
      ok: authority.ok,
      reason: authority.reason,
    });

    const failed = checks.find((check) => !check.ok);
    const decision = {
      ok: !failed,
      kind: "mutation-policy",
      reason: failed ? failed.reason : "mutation-policy-accepted",
      peer,
      capabilityScore: scoreCapabilityProfile(peer.capabilities),
      gologId: operation.gologId ?? this.store.gologId,
      operationId: operation.id ?? null,
      operationType: operation.type ?? null,
      resourceIds,
      requiredClaimGroups: manifest.requiredClaimGroups,
      manifest,
      authority,
      checks,
      diagnostics: failed ? { failedCheck: failed.name } : {},
    };

    if (emit) {
      this.bus.emit(MUTATION_POLICY_DECIDED_EVENT, cloneStoreValue(decision));
    }
    return decision;
  }
}
