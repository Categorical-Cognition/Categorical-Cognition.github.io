import { cloneStoreValue } from "./store-utils.js";

export const RELAY_PROPOSAL_FORMAT = "golog.relay-proposal";
export const RELAY_COMMIT_FORMAT = "golog.local-sync-commit";
export const RELAY_REJECT_FORMAT = "golog.relay-reject";
export const RELAY_PROTOCOL_VERSION = 1;

export const RELAY_PROPOSAL_TYPES = Object.freeze({
  OPERATION: "operation",
  CLAIM_REQUEST: "claim-request",
  CLAIM_RELEASE: "claim-release",
  AUTHORITY_GOSSIP: "authority-gossip",
});

const VALID_PROPOSAL_TYPES = new Set(Object.values(RELAY_PROPOSAL_TYPES));

function defaultProposalId(peer, index = 0) {
  return `${peer?.peerId ?? "peer"}-${Date.now()}-${index}`;
}

export function createRelayProposal({
  id = null,
  type,
  gologId,
  peer,
  payload = null,
  operation = null,
  index = 0,
  createdAt = Date.now(),
} = {}) {
  if (!VALID_PROPOSAL_TYPES.has(type)) {
    throw new Error(`Unsupported relay proposal type: ${type ?? "missing"}`);
  }
  if (!gologId) {
    throw new Error("Relay proposal requires gologId");
  }
  if (!peer?.peerId) {
    throw new Error("Relay proposal requires peer.peerId");
  }
  if (type === RELAY_PROPOSAL_TYPES.OPERATION && !operation?.id) {
    throw new Error("Operation proposal requires operation.id");
  }
  if (type !== RELAY_PROPOSAL_TYPES.OPERATION && !payload) {
    throw new Error("Relay control proposal requires payload");
  }

  const proposal = {
    type,
    gologId,
    peer: cloneStoreValue(peer),
    payload: payload ? cloneStoreValue(payload) : null,
    operation: operation ? cloneStoreValue(operation) : null,
  };

  return {
    format: RELAY_PROPOSAL_FORMAT,
    version: RELAY_PROTOCOL_VERSION,
    id: id ?? defaultProposalId(peer, index),
    type: "proposal",
    senderId: peer.peerId,
    peer: cloneStoreValue(peer),
    proposal,
    createdAt,
  };
}

export function isRelayCommit(message) {
  return Boolean(message?.format === RELAY_COMMIT_FORMAT || message?.sequence);
}
