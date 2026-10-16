import { normalizePeerContext } from "./peer-context.js";
import {
  createRelayProposal,
  RELAY_PROPOSAL_TYPES,
} from "./relay-protocol.js";
import { cloneStoreValue } from "./store-utils.js";

function knownOperationPeer(peer) {
  if (!peer?.peerId && !peer?.deviceId && !peer?.clientId && !peer?.publicKey) {
    return null;
  }
  const normalized = normalizePeerContext(peer);
  if (!normalized.isKnown || normalized.source === "local-bus") {
    return null;
  }
  return normalized;
}

export function createRelayCommitAdapter({
  peerContext,
  sendProposal,
  isReplayOperation = () => false,
  optimisticOperation = () => false,
  onOptimisticOperation = () => {},
  nextProposalIndex = () => 0,
} = {}) {
  const peer = normalizePeerContext(peerContext);
  if (!peer.isKnown) {
    throw new Error("Relay commit adapter requires a known peer");
  }
  if (typeof sendProposal !== "function") {
    throw new Error("Relay commit adapter requires sendProposal");
  }

  return function relayCommit(operation) {
    if (isReplayOperation(operation)) {
      return {
        ok: true,
        operation,
        relay: { replay: true },
      };
    }

    const origin = knownOperationPeer(operation.origin) ?? peer;
    const proposal = createRelayProposal({
      type: RELAY_PROPOSAL_TYPES.OPERATION,
      gologId: operation.gologId,
      peer,
      index: nextProposalIndex(),
      operation: {
        ...cloneStoreValue(operation),
        origin,
      },
    });
    sendProposal(proposal);
    if (optimisticOperation(operation)) {
      const optimistic = {
        ...cloneStoreValue(operation),
        origin,
      };
      onOptimisticOperation(optimistic, proposal);
      return {
        ok: true,
        operation: optimistic,
        relay: { optimistic: true, proposal },
      };
    }
    return {
      ok: false,
      pending: true,
      reason: "relay-commit-pending",
      proposal,
    };
  };
}
