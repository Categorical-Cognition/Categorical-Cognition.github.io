import {
  applyDomainOperation,
  createDomainOperation,
  DOMAIN_OPERATION_APPLIED_EVENT,
  DOMAIN_OPERATION_REJECTED_EVENT,
  normalizeDomainOperation,
} from "./domain-operations.js";
import { compileOperationResourceManifest } from "./operation-resource-manifest.js";
import { normalizeClaimant } from "./resource-claim-manager.js";
import { cloneStoreValue } from "./store-utils.js";
import { AUTHORITY_SOURCES } from "./authority-origins.js";

export const OPERATION_PIPELINE_EVENT = "operation:pipeline-event";
export const OPERATION_PIPELINE_PROPOSED_EVENT = "operation:proposed";
export const OPERATION_PIPELINE_PENDING_EVENT = "operation:pending";
export const OPERATION_PIPELINE_COMMITTED_EVENT = "operation:committed";
export const OPERATION_HISTORY_REPLAY_SKIPPED_EVENT = "operation:history-replay-skipped";
export const ACCEPTED_HISTORY_REPLAY_MARKER = "__acceptedHistoryReplay";

const LOCAL_AUTO_CLAIM_SOURCES = new Set([
  AUTHORITY_SOURCES.AGENT_API,
  "agent-api-force-layout",
  "app-init",
  AUTHORITY_SOURCES.BROWSER_RUNTIME,
  AUTHORITY_SOURCES.HUMAN_INTERFACE,
  "force-layout",
  "local-bus",
  "meta-golog-service",
  "structured-creation-service",
]);

const LOCAL_AUTO_CLAIM_TTL_MS = new Map([
  [AUTHORITY_SOURCES.BROWSER_RUNTIME, 500],
  [AUTHORITY_SOURCES.HUMAN_INTERFACE, 750],
  ["agent-api-force-layout", 500],
  ["force-layout", 500],
]);

function localAutoClaimTtl(operation) {
  return LOCAL_AUTO_CLAIM_TTL_MS.get(operation.origin?.source) ?? null;
}

function pipelineEvent(stage, detail = {}) {
  return {
    stage,
    at: Date.now(),
    ...cloneStoreValue(detail),
  };
}

export class OperationPipeline {
  constructor({
    store,
    bus,
    policy = store?.mutationPolicy ?? null,
    commit = (operation) => ({ ok: true, operation }),
  }) {
    this.store = store;
    this.bus = bus;
    this.policy = policy;
    this.commit = commit;
  }

  submit(type, payload = {}, options = {}) {
    return this.submitOperation(
      createDomainOperation(this.store, type, payload, options),
    );
  }

  submitOperation(operation) {
    const normalized = normalizeDomainOperation(this.store, operation);
    this.emitStage(OPERATION_PIPELINE_PROPOSED_EVENT, {
      operation: normalized,
    });
    const autoClaims = normalized[ACCEPTED_HISTORY_REPLAY_MARKER]
      ? null
      : this.ensureLocalClaims(normalized);

    const policyDecision = normalized[ACCEPTED_HISTORY_REPLAY_MARKER]
      ? null
      : this.policy?.evaluate(normalized);
    if (policyDecision && !policyDecision.ok) {
      const result = this.reject(normalized, policyDecision.reason, {
        policy: policyDecision,
      });
      this.releaseAutoClaims(autoClaims, normalized);
      return result;
    }

    const commitDecision = this.commit(normalized);
    if (commitDecision?.then) {
      return commitDecision
        .then((decision) => {
          const result = this.finishCommit(normalized, decision);
          this.releaseAutoClaims(autoClaims, normalized);
          return result;
        })
        .catch((error) => {
          const result = this.reject(normalized, error?.message ?? "commit-rejected", {
            error: error?.message ?? String(error),
          });
          this.releaseAutoClaims(autoClaims, normalized);
          return result;
        });
    }

    const result = this.finishCommit(normalized, commitDecision);
    this.releaseAutoClaims(autoClaims, normalized);
    return result;
  }

  finishCommit(normalized, commitDecision) {
    if (commitDecision?.pending) {
      const result = {
        ok: false,
        pending: true,
        operation: normalized,
        reason: commitDecision.reason ?? "commit-pending",
        commit: commitDecision,
      };
      this.emitStage(OPERATION_PIPELINE_PENDING_EVENT, result);
      return result;
    }

    if (commitDecision && commitDecision.ok === false) {
      return this.reject(normalized, commitDecision.reason ?? "commit-rejected", {
        commit: commitDecision,
      });
    }

    const committed = commitDecision?.operation ?? normalized;
    this.emitStage(OPERATION_PIPELINE_COMMITTED_EVENT, {
      operation: committed,
      commit: commitDecision ?? null,
    });

    const result = applyDomainOperation(this.store, committed);
    const eventType = result.ok
      ? DOMAIN_OPERATION_APPLIED_EVENT
      : committed[ACCEPTED_HISTORY_REPLAY_MARKER]
        ? OPERATION_HISTORY_REPLAY_SKIPPED_EVENT
        : DOMAIN_OPERATION_REJECTED_EVENT;
    this.bus.emit(eventType, result);
    return result;
  }

  reject(operation, reason, detail = {}) {
    const result = {
      ok: false,
      operation,
      reason,
      ...detail,
    };
    this.bus.emit(DOMAIN_OPERATION_REJECTED_EVENT, cloneStoreValue(result));
    return result;
  }

  emitStage(type, detail) {
    const event = pipelineEvent(type, detail);
    this.bus.emit(type, event);
    this.bus.emit(OPERATION_PIPELINE_EVENT, event);
  }

  ensureLocalClaims(operation) {
    if (
      !this.store?.resourceClaims ||
      !LOCAL_AUTO_CLAIM_SOURCES.has(operation.origin?.source)
    ) {
      return null;
    }

    const claimant = normalizeClaimant(operation.origin);
    const manifest = compileOperationResourceManifest(operation);
    const missingClaims = [];
    for (const group of manifest.requiredClaimGroups) {
      const satisfied = group.some((resourceId) =>
        this.store.resourceClaims.claimIsHeldBy(resourceId, claimant),
      );
      if (!satisfied && group[0]) {
        missingClaims.push(group[0]);
      }
    }
    if (missingClaims.length === 0) {
      return null;
    }
    const ttlMs = localAutoClaimTtl(operation);
    return this.store.resourceClaims.claimResources({
      resourceIds: [...new Set(missingClaims)],
      claimant: operation.origin,
      ...(ttlMs ? { ttlMs } : {}),
    });
  }

  releaseAutoClaims(claimResult, operation) {
    if (!claimResult?.ok || !Array.isArray(claimResult.claims)) {
      return null;
    }
    const holder = claimResult.holder?.holderId ?? normalizeClaimant(operation.origin).holderId;
    const resourceIds = claimResult.claims
      .filter((claim) => {
        const current = this.store.resourceClaims.claimFor(claim.resourceId);
        return (
          current &&
          current.holderId === holder &&
          current.token === claim.token
        );
      })
      .map((claim) => claim.resourceId);
    if (resourceIds.length === 0) {
      return null;
    }
    return this.store.resourceClaims.releaseResources({
      resourceIds,
      claimant: operation.origin,
    });
  }
}
