import * as THREE from "three";
import {
  DOMAIN_OPERATION_APPLY_EVENT,
  DOMAIN_OPERATION_REJECTED_EVENT,
} from "./domain-operations.js";
import {
  RESOURCE_CLAIMS_CHANGED_EVENT,
  RESOURCE_CLAIM_RELEASE_EVENT,
  RESOURCE_CLAIM_REQUEST_EVENT,
  RESOURCE_CLAIM_REJECTED_EVENT,
} from "./resource-claim-manager.js";
import { AUTHORITY_GOSSIP_EVENT } from "./authority-gossip.js";
import { AUTHORITY_SOURCES } from "./authority-origins.js";
import { normalizePeerContext } from "./peer-context.js";
import { GOLOG_PATCHES_APPLIED_EVENT } from "./workspace-patches.js";
import {
  ACCEPTED_HISTORY_REPLAY_MARKER,
} from "./operation-pipeline.js";
import { createRelayCommitAdapter } from "./relay-commit-adapter.js";
import { appendGologPublication, gologPublication, publicationFingerprint,
  retractGologPublication } from "./golog-publication.js";
import {
  createRelayProposal,
  isRelayCommit,
  RELAY_COMMIT_FORMAT,
  RELAY_PROPOSAL_FORMAT,
  RELAY_PROPOSAL_TYPES,
  RELAY_PROTOCOL_VERSION,
} from "./relay-protocol.js";

export const LOCAL_SYNC_MESSAGE_FORMAT = RELAY_PROPOSAL_FORMAT;
export const LOCAL_SYNC_MESSAGE_VERSION = RELAY_PROTOCOL_VERSION;
export const LOCAL_SYNC_COMMIT_FORMAT = RELAY_COMMIT_FORMAT;

const SYNC_COMMIT_MARKER = "__syncCommitId";
const MAX_SEEN_COMMITS = 1000;
const VECTOR3_PAYLOAD_FIELDS = new Map([
  ["element:create", ["position"]],
  ["sphere:create", ["position"]],
  ["sphere:move", ["position"]],
  ["edge:move-midpoint", ["midpoint"]],
]);

function hasVector3Shape(value) {
  return (
    value &&
    typeof value === "object" &&
    Number.isFinite(Number(value.x)) &&
    Number.isFinite(Number(value.y)) &&
    Number.isFinite(Number(value.z))
  );
}

function serializeValue(value) {
  if (value?.isVector3 && typeof value.toArray === "function") {
    return value.toArray();
  }
  if (Array.isArray(value)) {
    return value.map((entry) => serializeValue(entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            key !== SYNC_COMMIT_MARKER &&
            key !== ACCEPTED_HISTORY_REPLAY_MARKER,
        )
        .map(([key, entry]) => [key, serializeValue(entry)]),
    );
  }
  return value;
}

function deserializeVector3(value) {
  if (value?.isVector3) {
    return value;
  }
  if (Array.isArray(value)) {
    return new THREE.Vector3(
      Number(value[0] ?? 0),
      Number(value[1] ?? 0),
      Number(value[2] ?? 0),
    );
  }
  if (hasVector3Shape(value)) {
    return new THREE.Vector3(Number(value.x), Number(value.y), Number(value.z));
  }
  return value;
}

function deserializePayload(type, payload = {}) {
  const copy = serializeValue(payload);
  if (type === "layout:commit") {
    copy.positions = (copy.positions ?? []).map((entry) => ({
      ...entry,
      position: deserializeVector3(entry.position),
    }));
    copy.edgeControls = (copy.edgeControls ?? []).map((entry) => ({
      ...entry,
      midpoint: deserializeVector3(entry.midpoint),
    }));
    return copy;
  }
  for (const field of VECTOR3_PAYLOAD_FIELDS.get(type) ?? []) {
    if (field in copy) {
      copy[field] = deserializeVector3(copy[field]);
    }
  }
  return copy;
}

function serializeOperation(operation) {
  return operation && typeof operation === "object" ? serializeValue(operation) : operation;
}

function deserializeOperation(operation) {
  if (!operation || typeof operation !== "object") {
    return operation;
  }
  return {
    ...serializeValue(operation),
    payload: deserializePayload(operation.type, operation.payload ?? {}),
  };
}

function isHumanSphereMove(operation = {}) {
  return (
    operation.type === "sphere:move" &&
    operation.origin?.source === AUTHORITY_SOURCES.HUMAN_INTERFACE &&
    operation.payload?.id &&
    operation.payload?.position
  );
}

function applyHumanMovePreview(golog, operation, detail = {}) {
  if (!isHumanSphereMove(operation)) {
    return;
  }
  golog.state.applyLayoutPreviewPositions?.([
    {
      id: operation.payload.id,
      position: operation.payload.position,
    },
  ]);
}

function applyHistoricalSmoothBaseline(golog, operation = {}) {
  if (operation.type === "layout:commit") {
    golog.state.applyLayoutPreviewPositions?.(operation.payload?.positions ?? []);
    return true;
  }
  if (operation.type === "sphere:move" && operation.payload?.id && operation.payload?.position) {
    golog.state.applyLayoutPreviewPositions?.([
      {
        id: operation.payload.id,
        position: operation.payload.position,
      },
    ]);
    return true;
  }
  return false;
}

function defaultMessageId(peer, index) {
  return `${peer.peerId}-${Date.now()}-${index}`;
}

function withCommitMarker(payload, commit) {
  return {
    ...serializeValue(payload ?? {}),
    [SYNC_COMMIT_MARKER]: commit.id,
  };
}

export function createLocalSyncClient({
  workspace,
  peerContext,
  url,
  WebSocketImpl = globalThis.WebSocket,
  logger = console,
  authorityHost = false,
  snapshotProvider = null,
  applyWorkspaceSnapshot = null,
} = {}) {
  const peer = normalizePeerContext(peerContext);
  const wrappedGologs = new Map();
  const seenCommits = new Set();
  const seenCommitOrder = [];
  const optimisticOperationIds = new Set();
  const knownPeers = new Map([[peer.peerId, peer]]);
  const outbox = [];
  let socket = null;
  let nextMessageIndex = 1;
  let lastSequence = 0;
  let baselineReplaySequence = 0;
  let authorityGossipSentCount = 0;
  let authorityGossipReceivedCount = 0;
  let workspaceSnapshotSentCount = 0;
  let workspaceSnapshotReceivedCount = 0;
  let lastWorkspaceSnapshotId = null;
  let workspaceEpoch = null;
  const snapshotReceipts = new Map();
  const snapshotWaiters = new Map();
  let lastRejectedWorkspaceOperation = null;
  let replacingWorkspace = false;
  let disposed = false;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let relayClientId = null;
  let electedAuthorityHostClientId = null;
  let relayElectionObserved = false;
  let pendingWorkspaceSnapshotReason = null;
  let connectionErrorCount = 0;
  let lastConnectionErrorAt = null;
  let applyingWorkspaceSnapshot = 0;
  let workspacePublicationScheduled = false;
  const pendingPublications = new Map();
  const ownedPublications = new Map();
  const acceptedPublications = new Map();

  function isElectedHost() {
    return Boolean(authorityHost && relayElectionObserved && relayClientId &&
      relayClientId === electedAuthorityHostClientId);
  }

  function requestGologPublication(message) {
    if (pendingPublications.has(message.requestId)) return pendingPublications.get(message.requestId).promise;
    let resolve, reject;
    const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
    const envelope = { type: "golog-publication", senderId: peer.peerId, peer, ...message };
    const retry = globalThis.setInterval(() => send(envelope), 5_000);
    const timer = globalThis.setTimeout(() => {
      globalThis.clearInterval(retry);
      pendingPublications.delete(message.requestId);
      reject(new Error("Golog publication acknowledgement timed out"));
    }, 30_000);
    pendingPublications.set(message.requestId, { promise, resolve, reject, timer, retry,
      publicationId: message.publicationId, gologId: message.publication?.record?.id ?? message.gologId });
    send(envelope);
    return promise;
  }

  function publishGolog(golog) {
    if (isElectedHost()) {
      publishWorkspaceSnapshot({ reason: "golog-published" });
      return true;
    }
    const existing = ownedPublications.get(golog.id);
    if (existing) return existing.ready;
    const publicationId = defaultMessageId(peer, nextMessageIndex++);
    const entry = { publicationId };
    ownedPublications.set(golog.id, entry);
    entry.ready = requestGologPublication({ action: "publish", requestId: publicationId,
      publicationId, publication: gologPublication(workspace, golog.id) }).catch((error) => {
      if (error.publicationRejected) ownedPublications.delete(golog.id);
      throw error;
    });
    return entry.ready;
  }

  function retractGolog(golog) {
    const entry = ownedPublications.get(golog.id);
    if (!entry) return true;
    return requestGologPublication({ action: "retract", requestId: `${entry.publicationId}:retract`,
      publicationId: entry.publicationId, gologId: golog.id }).then((result) => {
      ownedPublications.delete(golog.id);
      return result;
    });
  }

  function handleGologPublication(message) {
    if (!isElectedHost()) return;
    const publishResult = (result) => send({ type: "golog-publication-result",
      requestId: message.requestId, publicationId: message.publicationId, result,
      senderId: peer.peerId, peer });
    if (replacingWorkspace || (message.workspaceEpoch ?? null) !== workspaceEpoch) {
      publishResult({ ok: false, error: "Workspace was replaced" });
      return;
    }
    const owner = normalizePeerContext(message.peer);
    if (!owner.isKnown || !message.publicationId) {
      publishResult({ ok: false, error: "Golog publication requires a known peer and publication id" });
      return;
    }
    try {
      const accepted = acceptedPublications.get(message.publicationId);
      if (message.action === "retract") {
        if (!accepted || accepted.peerId !== owner.peerId || accepted.gologId !== message.gologId) {
          throw new Error("Publication cleanup blocked: the peer does not own this publication");
        }
        void retractGologPublication(workspace, accepted.gologId, accepted.fingerprint).then(() => {
          acceptedPublications.delete(message.publicationId);
          publishResult({ ok: true, gologId: accepted.gologId, retracted: true });
          publishWorkspaceSnapshot({ reason: "golog-publication-retracted" });
        }).catch((error) => publishResult({ ok: false, error: error.message }));
        return;
      }
      if (message.action !== "publish") throw new Error("Unsupported golog publication action");
      if (accepted) {
        if (accepted.peerId !== owner.peerId || accepted.requestFingerprint !== publicationFingerprint(message.publication)) {
          throw new Error("Golog publication id was reused with different data");
        }
        publishResult({ ok: true, gologId: accepted.gologId });
        return;
      }
      const golog = appendGologPublication(workspace, message.publication);
      acceptedPublications.set(message.publicationId, { peerId: owner.peerId, gologId: golog.id,
        fingerprint: publicationFingerprint(gologPublication(workspace, golog.id)),
        requestFingerprint: publicationFingerprint(message.publication) });
      // Creation queues catalog reconciliation, which queues its own workspace
      // snapshot. Send every birth snapshot before ACK: the publisher then
      // attaches the parent to the current, hydrated store. An older snapshot
      // after ACK would erase that optimistic attachment before its echo.
      queueMicrotask(() => queueMicrotask(() => {
        publishWorkspaceSnapshot({ reason: "golog-publication-accepted" });
        publishResult({ ok: true, gologId: golog.id });
      }));
    } catch (error) {
      publishResult({ ok: false, error: error.message });
    }
  }

  function rememberCommit(commit) {
    const key = commit.sequence ?? commit.id;
    if (!key || seenCommits.has(key)) {
      return false;
    }
    seenCommits.add(key);
    seenCommitOrder.push(key);
    while (seenCommitOrder.length > MAX_SEEN_COMMITS) {
      seenCommits.delete(seenCommitOrder.shift());
    }
    lastSequence = Math.max(lastSequence, Number(commit.sequence ?? 0));
    return true;
  }

  function updatePeerList(peers = []) {
    knownPeers.clear();
    for (const entry of peers) {
      const normalized = normalizePeerContext(entry);
      if (normalized.isKnown) {
        knownPeers.set(normalized.peerId, normalized);
      }
    }
    knownPeers.set(peer.peerId, peer);
  }

  function peerList() {
    return [...knownPeers.values()].sort((first, second) =>
      first.peerId.localeCompare(second.peerId),
    );
  }

  function flushOutbox() {
    if (!socket || socket.readyState !== WebSocketImpl.OPEN) {
      return;
    }
    while (outbox.length > 0) {
      socket.send(JSON.stringify(outbox.shift()));
    }
  }

  function send(body) {
    const serialized = serializeValue({ workspaceEpoch, ...body });
    if (socket && socket.readyState === WebSocketImpl.OPEN) {
      socket.send(JSON.stringify(serialized));
      return;
    }
    outbox.push(serialized);
  }

  function sendProposal(type, { gologId, payload = null, operation = null } = {}) {
    send(createRelayProposal({
      id: defaultMessageId(peer, nextMessageIndex++),
      type,
      gologId,
      peer,
      payload: payload ? serializeValue(payload) : null,
      operation: operation ? serializeOperation(operation) : null,
    }));
  }

  function publishWorkspaceSnapshot({ reason = "manual" } = {}) {
    if (!authorityHost || typeof snapshotProvider !== "function") {
      return false;
    }
    const isElected = isElectedHost();
    if (!isElected) {
      pendingWorkspaceSnapshotReason = reason;
      return false;
    }
    const workspace = snapshotProvider();
    if (!workspace) {
      return false;
    }
    pendingWorkspaceSnapshotReason = null;
    workspaceSnapshotSentCount += 1;
    send({
      format: "golog.local-sync-relay",
      version: LOCAL_SYNC_MESSAGE_VERSION,
      id: defaultMessageId(peer, nextMessageIndex++),
      type: "workspace-snapshot",
      senderId: peer.peerId,
      peer,
      reason,
      workspace: serializeValue(workspace),
      createdAt: new Date().toISOString(),
    });
    return true;
  }

  function updateRelayElection(message = {}) {
    const wasElected = isElectedHost();
    if (Object.hasOwn(message, "clientId")) {
      relayClientId = message.clientId ? String(message.clientId) : null;
    }
    if (Object.hasOwn(message, "authorityHostClientId")) {
      relayElectionObserved = true;
      electedAuthorityHostClientId = message.authorityHostClientId
        ? String(message.authorityHostClientId)
        : null;
    }
    if (
      pendingWorkspaceSnapshotReason &&
      relayClientId &&
      relayClientId === electedAuthorityHostClientId
    ) {
      publishWorkspaceSnapshot({ reason: pendingWorkspaceSnapshotReason });
    }
    if (wasElected !== isElectedHost()) {
      workspace.bus.emit("workspace:catalog-authority-changed", { authorityHost: isElectedHost() });
    }
  }

  function prepareClaimPayload(payload = {}) {
    return {
      ...serializeValue(payload),
      claimant: payload.claimant ?? payload.origin ?? peer,
    };
  }

  function shouldProposeClaim(type, payload) {
    if (payload?.[SYNC_COMMIT_MARKER]) {
      return false;
    }
    return type === RESOURCE_CLAIM_REQUEST_EVENT || type === RESOURCE_CLAIM_RELEASE_EVENT;
  }

  function shouldProposeAuthorityGossip(type, payload) {
    if (payload?.[SYNC_COMMIT_MARKER]) {
      return false;
    }
    return type === AUTHORITY_GOSSIP_EVENT;
  }

  function publishAuthorityGossip(golog) {
    const snapshot = golog.state.authorityFabric?.createGossipSnapshot?.({
      peer,
    });
    if (!snapshot) {
      return;
    }
    authorityGossipSentCount += 1;
    sendProposal(RELAY_PROPOSAL_TYPES.AUTHORITY_GOSSIP, {
      gologId: golog.id,
      payload: snapshot,
    });
  }

  function gologForCommit(commit) {
    if (commit.gologId && workspace.gologs.has(commit.gologId)) {
      return workspace.gologs.get(commit.gologId);
    }
    return null;
  }

  function isHistoricalReplayCommit(commit = {}) {
    return (
      Number(commit.sequence ?? 0) > 0 &&
      Number(commit.sequence ?? 0) <= baselineReplaySequence
    );
  }

  function applyCommit(commit) {
    if (!isRelayCommit(commit)) {
      return;
    }
    if (!rememberCommit(commit)) {
      return;
    }
    const golog = gologForCommit(commit);
    if (!golog) {
      return;
    }
    const wrapped = wrappedGologs.get(golog.id);
    const emit = wrapped?.originalEmit ?? golog.bus.emit.bind(golog.bus);
    const historicalReplay = isHistoricalReplayCommit(commit);

    if (commit.type === "claim-request") {
      if (historicalReplay) {
        return;
      }
      emit(RESOURCE_CLAIM_REQUEST_EVENT, withCommitMarker(commit.payload, commit));
      return;
    }
    if (commit.type === "claim-release") {
      if (historicalReplay) {
        return;
      }
      emit(RESOURCE_CLAIM_RELEASE_EVENT, withCommitMarker(commit.payload, commit));
      return;
    }
    if (commit.type === "authority-gossip") {
      if (historicalReplay) {
        return;
      }
      authorityGossipReceivedCount += 1;
      emit(AUTHORITY_GOSSIP_EVENT, withCommitMarker(commit.payload, commit));
      return;
    }
    if (commit.type === "operation") {
      const operation = deserializeOperation(commit.operation);
      if (operation?.id) {
        if (historicalReplay && applyHistoricalSmoothBaseline(golog, operation)) {
          return;
        }
        const convergence = golog.state.semanticConvergence?.ingestGlobalOperation?.(
          operation,
          { commit, peer },
        );
        golog.state.localSheafGlue?.observeOperation?.(operation, { commit, peer });
        const wasOptimistic = optimisticOperationIds.delete(operation.id);
        if (wasOptimistic || convergence?.applyMode === "attract") {
          if (!wasOptimistic) {
            applyHumanMovePreview(golog, operation, { commit, peer });
          }
          return;
        }
        emit(DOMAIN_OPERATION_APPLY_EVENT, {
          ...operation,
          [SYNC_COMMIT_MARKER]: commit.id,
          ...(historicalReplay
            ? { [ACCEPTED_HISTORY_REPLAY_MARKER]: true }
            : {}),
        });
      }
    }
  }

  function handleSocketMessage(message) {
    if (message?.type === "workspace-operation-rejected") {
      lastRejectedWorkspaceOperation = message.reason;
      const pending = pendingPublications.get(message.requestId);
      if (pending) {
        pendingPublications.delete(message.requestId);
        globalThis.clearTimeout(pending.timer);
        globalThis.clearInterval(pending.retry);
        pending.reject(new Error(message.reason));
      }
      const golog = workspace.gologs.get(message.gologId);
      if (message.operation) golog?.bus.emit(DOMAIN_OPERATION_REJECTED_EVENT,
        { ok: false, operation: message.operation, reason: message.reason });
      else if (message.payload) golog?.bus.emit(RESOURCE_CLAIM_REJECTED_EVENT,
        { ...message.payload, ok: false, reason: message.reason });
      workspace.bus.emit("workspace:operation-rejected", { reason: message.reason });
      return;
    }
    if (message?.type === "golog-publication") {
      handleGologPublication(message);
      return;
    }
    if (message?.type === "golog-publication-result") {
      const pending = pendingPublications.get(message.requestId);
      if (!pending || pending.publicationId !== message.publicationId) return;
      pendingPublications.delete(message.requestId);
      globalThis.clearTimeout(pending.timer);
      globalThis.clearInterval(pending.retry);
      if (message.result?.ok && message.result.gologId !== pending.gologId) {
        pending.reject(new Error("Golog publication acknowledgement names a different golog"));
      } else if (message.result?.ok) pending.resolve(message.result);
      else pending.reject(Object.assign(new Error(message.result?.error ?? "Golog publication was rejected"),
        { publicationRejected: true }));
      return;
    }
    if (isRelayCommit(message)) {
      applyCommit(message);
      return;
    }
    if (message?.type === "workspace-snapshot") {
      const nextEpoch = message.workspaceEpoch ?? null;
      const replaced = nextEpoch !== workspaceEpoch;
      if (replaced) {
        workspaceEpoch = nextEpoch;
        outbox.length = 0;
        optimisticOperationIds.clear();
        ownedPublications.clear();
        acceptedPublications.clear();
        for (const pending of pendingPublications.values()) {
          globalThis.clearTimeout(pending.timer);
          globalThis.clearInterval(pending.retry);
          pending.reject(new Error("Workspace was replaced"));
        }
        pendingPublications.clear();
        baselineReplaySequence = Math.max(baselineReplaySequence, Number(message.lastSequence ?? 0));
      }
      if (message.senderId === peer.peerId || message.peer?.peerId === peer.peerId) {
        return;
      }
      const snapshotId = message.snapshotId ?? message.id ?? null;
      if (snapshotId && snapshotId === lastWorkspaceSnapshotId) {
        return;
      }
      lastWorkspaceSnapshotId = snapshotId;
      workspaceSnapshotReceivedCount += 1;
      applyingWorkspaceSnapshot += 1;
      try {
        applyWorkspaceSnapshot?.(message.workspace ?? message.snapshot, {
          message,
          peer: message.peer ?? null,
          reason: message.reason ?? null,
          replacement: replaced,
        });
        if (snapshotId) {
          snapshotReceipts.set(snapshotId, { snapshotId, workspaceEpoch });
          while (snapshotReceipts.size > 128) snapshotReceipts.delete(snapshotReceipts.keys().next().value);
          for (const waiter of snapshotWaiters.get(snapshotId) ?? []) waiter.resolve(snapshotReceipts.get(snapshotId));
          snapshotWaiters.delete(snapshotId);
        }
      } finally {
        // Workspace events are queued by the project bus. Retain the receive
        // scope until those already-enqueued events have been delivered.
        queueMicrotask(() => { applyingWorkspaceSnapshot -= 1; });
      }
      return;
    }
    if (message?.type === "welcome") {
      updateRelayElection(message);
      lastSequence = Math.max(lastSequence, Number(message.lastSequence ?? 0));
      baselineReplaySequence = Math.max(
        baselineReplaySequence,
        Number(message.lastSequence ?? 0),
      );
      if (Array.isArray(message.peers)) {
        updatePeerList(message.peers);
      }
      if (message.workspaceSnapshot) {
        handleSocketMessage(message.workspaceSnapshot);
      }
      return;
    }
    if (message?.type === "peer-list") {
      updateRelayElection(message);
      updatePeerList(message.peers ?? []);
      return;
    }
    if (message?.type === "error") {
      logger?.warn?.("Local sync relay error", message.error);
    }
  }

  function attachGolog(golog) {
    if (!golog || workspace.gologs.get(golog.id) !== golog || wrappedGologs.has(golog.id)) {
      return;
    }

    const originalEmit = golog.bus.emit.bind(golog.bus);
    const originalCommit = golog.state.operationPipeline.commit;
    const releaseClaimsChanged = golog.bus.on(
      RESOURCE_CLAIMS_CHANGED_EVENT,
      () => publishAuthorityGossip(golog),
    );
    golog.state.operationPipeline.commit = createRelayCommitAdapter({
      peerContext: peer,
      sendProposal: send,
      isReplayOperation: (operation) => Boolean(operation?.[SYNC_COMMIT_MARKER]),
      optimisticOperation: () => true,
      onOptimisticOperation: (operation) => {
        if (operation?.id) {
          optimisticOperationIds.add(operation.id);
        }
      },
      nextProposalIndex: () => nextMessageIndex++,
    });

    const wrappedEmit = (type, payload = {}) => {
      if (shouldProposeAuthorityGossip(type, payload)) {
        sendProposal(RELAY_PROPOSAL_TYPES.AUTHORITY_GOSSIP, {
          gologId: golog.id,
          payload: serializeValue(payload),
        });
        return;
      }

      if (!shouldProposeClaim(type, payload)) {
        originalEmit(type, payload);
        return;
      }

      if (type === RESOURCE_CLAIM_REQUEST_EVENT) {
        sendProposal(RELAY_PROPOSAL_TYPES.CLAIM_REQUEST, {
          gologId: golog.id,
          payload: prepareClaimPayload(payload),
        });
        return;
      }

      if (type === RESOURCE_CLAIM_RELEASE_EVENT) {
        sendProposal(RELAY_PROPOSAL_TYPES.CLAIM_RELEASE, {
          gologId: golog.id,
          payload: prepareClaimPayload(payload),
        });
        return;
      }
    };

    golog.bus.emit = wrappedEmit;
    wrappedGologs.set(golog.id, {
      golog,
      originalEmit,
      originalCommit,
      restore: () => {
        releaseClaimsChanged();
        golog.bus.emit = originalEmit;
        golog.state.operationPipeline.commit = originalCommit;
      },
    });
  }

  function detachWrappedGolog(id, wrapped) {
    wrapped?.restore?.();
    wrappedGologs.delete(id);
  }

  function reconcileWrappedGologs() {
    for (const [id, wrapped] of wrappedGologs.entries()) {
      if (workspace.gologs.get(id) !== wrapped.golog) {
        detachWrappedGolog(id, wrapped);
      }
    }
    for (const golog of workspace.gologs.values()) {
      attachGolog(golog);
    }
  }

  function scheduleReconnect() {
    if (disposed || reconnectTimer || !url || !WebSocketImpl) {
      return;
    }
    const delayMs = Math.min(5_000, 250 * 2 ** reconnectAttempt);
    reconnectAttempt += 1;
    reconnectTimer = globalThis.setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delayMs);
  }

  function connect() {
    if (disposed || !url || !WebSocketImpl) {
      return;
    }
    if (
      socket &&
      (socket.readyState === WebSocketImpl.OPEN ||
        socket.readyState === WebSocketImpl.CONNECTING)
    ) {
      return;
    }
    const syncUrl = new URL(url, globalThis.location?.href);
    syncUrl.searchParams.set("since", String(lastSequence));
    const nextSocket = new WebSocketImpl(syncUrl.href);
    socket = nextSocket;
    nextSocket.addEventListener("open", () => {
      reconnectAttempt = 0;
      send({
        format: LOCAL_SYNC_MESSAGE_FORMAT,
        version: LOCAL_SYNC_MESSAGE_VERSION,
        id: defaultMessageId(peer, nextMessageIndex++),
        type: "hello",
        senderId: peer.peerId,
        peer,
        lastSequence,
        authorityHostCandidate: Boolean(authorityHost),
      });
      flushOutbox();
      for (const golog of workspace.gologs.values()) {
        publishAuthorityGossip(golog);
      }
    });
    nextSocket.addEventListener("message", (event) => {
      try {
        handleSocketMessage(JSON.parse(event.data));
      } catch (error) {
        logger?.warn?.("Local sync message rejected", error);
      }
    });
    nextSocket.addEventListener("close", () => {
      if (socket === nextSocket) {
        socket = null;
      }
      scheduleReconnect();
    });
    nextSocket.addEventListener("error", (event) => {
      connectionErrorCount += 1;
      lastConnectionErrorAt = new Date().toISOString();
    });
  }

  for (const golog of workspace.gologs.values()) {
    attachGolog(golog);
  }
  const releaseWorkspaceListener = workspace.bus.on(
    "workspace:golog-created",
    ({ golog }) => attachGolog(golog),
  );
  const releaseSynchronousCreation = workspace.observeGologCreation?.(attachGolog);
  const releaseDefaultIdFactory = workspace.setDefaultGologIdFactory?.(({ suggestedId }) => {
    if (isElectedHost()) return suggestedId;
    const namespace = String(peer.peerId).replace(/[^A-Za-z0-9._-]/g, "_");
    const token = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${nextMessageIndex++}`;
    return `golog-${namespace}-${token}`;
  });
  const releaseGologPublication = workspace.observeGologPublication?.(publishGolog);
  const releaseGologRetraction = workspace.observeGologRetraction?.(retractGolog);
  function scheduleWorkspacePublication(reason) {
    if (applyingWorkspaceSnapshot || workspacePublicationScheduled || !authorityHost) return;
    workspacePublicationScheduled = true;
    queueMicrotask(() => {
      workspacePublicationScheduled = false;
      if (!disposed) publishWorkspaceSnapshot({ reason });
    });
  }
  const releaseWorkspaceChangedListener = workspace.bus.on(
    "workspace:changed",
    () => {
      reconcileWrappedGologs();
      // Membership, hydration, and active-golog changes share one publication
      // boundary. Coalesce synchronous hydration and never echo received state.
      scheduleWorkspacePublication("workspace-changed");
    },
  );
  const releaseWorkspacePatchesListener = workspace.bus.on(
    GOLOG_PATCHES_APPLIED_EVENT,
    // Agent patches and undo/redo update domain state outside relay commits.
    // Publish their settled workspace through the same host snapshot boundary.
    () => scheduleWorkspacePublication("workspace-patches-applied"),
  );
  connect();

  return {
    peer,
    publishWorkspaceSnapshot,
    suspendWorkspacePublications() {
      replacingWorkspace = true;
      return () => { replacingWorkspace = false; };
    },
    waitForWorkspaceSnapshot(snapshotId, { timeoutMs = 15000 } = {}) {
      if (snapshotReceipts.has(snapshotId)) return Promise.resolve(snapshotReceipts.get(snapshotId));
      if (disposed) return Promise.reject(new Error("Workspace connection is disposed"));
      return new Promise((resolve, reject) => {
        const waiters = snapshotWaiters.get(snapshotId) ?? new Set();
        const finish = (callback, value) => {
          globalThis.clearTimeout(timer);
          waiters.delete(waiter);
          if (!waiters.size) snapshotWaiters.delete(snapshotId);
          callback(value);
        };
        const waiter = { resolve: (value) => finish(resolve, value), reject: (error) => finish(reject, error) };
        const timer = globalThis.setTimeout(() => waiter.reject(new Error("Waiting for the shared workspace timed out")), timeoutMs);
        waiters.add(waiter);
        snapshotWaiters.set(snapshotId, waiters);
      });
    },
    reconcileWorkspace: reconcileWrappedGologs,
    dispose() {
      disposed = true;
      if (reconnectTimer) {
        globalThis.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      releaseWorkspaceListener();
      releaseSynchronousCreation?.();
      releaseDefaultIdFactory?.();
      releaseGologPublication?.();
      releaseGologRetraction?.();
      releaseWorkspaceChangedListener();
      releaseWorkspacePatchesListener();
      for (const pending of pendingPublications.values()) {
        globalThis.clearTimeout(pending.timer);
        globalThis.clearInterval(pending.retry);
        pending.reject(new Error("Golog publication connection was disposed"));
      }
      pendingPublications.clear();
      for (const waiters of snapshotWaiters.values()) {
        for (const waiter of [...waiters]) waiter.reject(new Error("Workspace connection was disposed"));
      }
      snapshotWaiters.clear();
      for (const wrapped of wrappedGologs.values()) {
        wrapped.restore();
      }
      wrappedGologs.clear();
      socket?.close?.();
      socket = null;
    },
    status() {
      return {
        connected: Boolean(socket && socket.readyState === WebSocketImpl.OPEN),
        peer,
        peers: peerList(),
        attachedGologCount: wrappedGologs.size,
        queuedMessageCount: outbox.length,
        seenCommitCount: seenCommits.size,
        lastSequence,
        authorityGossipSentCount,
        authorityGossipReceivedCount,
        workspaceSnapshotSentCount,
        workspaceSnapshotReceivedCount,
        workspaceEpoch,
        lastWorkspaceSnapshotId,
        lastRejectedWorkspaceOperation,
        authorityHost:
          Boolean(authorityHost) &&
          relayElectionObserved &&
          relayClientId === electedAuthorityHostClientId,
        authorityHostCandidate: Boolean(authorityHost),
        relayClientId,
        electedAuthorityHostClientId,
        connectionErrorCount,
        lastConnectionErrorAt,
      };
    },
  };
}
