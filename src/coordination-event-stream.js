import {
  DOMAIN_OPERATION_APPLIED_EVENT,
  DOMAIN_OPERATION_REJECTED_EVENT,
} from "./domain-operations.js";
import {
  RESOURCE_CLAIM_GRANTED_EVENT,
  RESOURCE_CLAIM_REJECTED_EVENT,
  RESOURCE_CLAIM_RELEASED_EVENT,
} from "./resource-claim-manager.js";
import { AUTHORITY_DECIDED_EVENT } from "./resource-authority.js";
import { MUTATION_POLICY_DECIDED_EVENT } from "./mutation-policy.js";
import { normalizePeerContext } from "./peer-context.js";
import { scoreCapabilityProfile } from "./capability-profile.js";
import { cloneStoreValue } from "./store-utils.js";

export const COORDINATION_EVENT_RECORDED_EVENT = "coordination:event-recorded";
export const COORDINATION_EVENTS_CHANGED_EVENT = "coordination:events-changed";

const DEFAULT_MAX_EVENTS = 200;

function eventToken() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

function peerSummary(peerInput = {}) {
  const peer = normalizePeerContext(peerInput);
  return {
    peer,
    peerId: peer.peerId,
    sessionId: peer.sessionId,
    holderId: peer.sessionId ? `${peer.peerId}:${peer.sessionId}` : peer.peerId,
    capabilityScore: scoreCapabilityProfile(peer.capabilities),
  };
}

export class CoordinationEventStream {
  constructor({ bus, store = null, now = () => Date.now(), maxEvents = DEFAULT_MAX_EVENTS }) {
    this.bus = bus;
    this.store = store;
    this.now = now;
    this.maxEvents = maxEvents;
    this.events = [];
  }

  registerBusHandlers() {
    this.bus.on(DOMAIN_OPERATION_APPLIED_EVENT, (result) =>
      this.recordOperationEvent("operation", "applied", result),
    );
    this.bus.on(DOMAIN_OPERATION_REJECTED_EVENT, (result) =>
      this.recordOperationEvent("operation", "rejected", result),
    );
    this.bus.on(RESOURCE_CLAIM_GRANTED_EVENT, (result) =>
      this.recordClaimEvent("resource-claim", "granted", result),
    );
    this.bus.on(RESOURCE_CLAIM_REJECTED_EVENT, (result) =>
      this.recordClaimEvent("resource-claim", "rejected", result),
    );
    this.bus.on(RESOURCE_CLAIM_RELEASED_EVENT, (result) =>
      this.recordClaimEvent("resource-claim", "released", result),
    );
    this.bus.on(AUTHORITY_DECIDED_EVENT, (decision) =>
      this.recordDecisionEvent("authority", decision),
    );
    this.bus.on(MUTATION_POLICY_DECIDED_EVENT, (decision) =>
      this.recordDecisionEvent("mutation-policy", decision),
    );
  }

  recordOperationEvent(type, outcome, result = {}) {
    const operation = result.operation ?? {};
    const peer = peerSummary(operation.origin);
    return this.recordEvent({
      type,
      outcome,
      reason: result.reason ?? null,
      gologId: operation.gologId ?? this.store?.gologId ?? null,
      operationId: operation.id ?? null,
      operationType: operation.type ?? null,
      resourceIds: operation.resourceIds ?? [operation.resourceId].filter(Boolean),
      ...peer,
    });
  }

  recordClaimEvent(type, outcome, result = {}) {
    const peer = peerSummary(result.holder?.peer ?? result.holder);
    return this.recordEvent({
      type,
      outcome,
      reason: result.reason ?? null,
      gologId: this.store?.gologId ?? null,
      operationId: null,
      operationType: null,
      resourceIds: result.resourceIds ?? [],
      ...peer,
    });
  }

  recordDecisionEvent(type, decision = {}) {
    const peer = peerSummary(decision.peer);
    return this.recordEvent({
      type,
      outcome: decision.ok ? "accepted" : "rejected",
      reason: decision.reason ?? null,
      gologId: decision.gologId ?? this.store?.gologId ?? null,
      operationId: decision.operationId ?? null,
      operationType: decision.operationType ?? null,
      resourceIds: decision.resourceIds ?? [],
      decisionKind: decision.kind ?? type,
      checks: decision.checks ?? null,
      diagnostics: decision.diagnostics ?? null,
      ...peer,
    });
  }

  recordEvent(event) {
    const recorded = {
      id: event.id ?? eventToken(),
      at: event.at ?? this.now(),
      ...cloneStoreValue(event),
    };
    this.events.push(recorded);
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
    this.bus.emit(COORDINATION_EVENT_RECORDED_EVENT, cloneStoreValue(recorded));
    this.bus.emit(COORDINATION_EVENTS_CHANGED_EVENT, this.snapshot());
    return recorded;
  }

  snapshot() {
    return this.events.map((event) => cloneStoreValue(event));
  }
}
