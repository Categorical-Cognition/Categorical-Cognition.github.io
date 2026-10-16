import {
  CAPABILITY_PROFILE_DEFAULTS,
  normalizeCapabilityProfile,
} from "./capability-profile.js";

export const PEER_CONTEXT_FORMAT = "golog.peer-context";
export const PEER_CONTEXT_VERSION = 1;

export const PEER_CAPABILITY_DEFAULTS = CAPABILITY_PROFILE_DEFAULTS;

function hasValue(value) {
  return value !== null && value !== undefined && value !== "";
}

function stableHash(input) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function canonicalIdentitySeed(input = {}) {
  const parts = [
    input.publicKey,
    input.deviceId,
    input.clientId,
    input.source,
    input.deviceLabel,
    input.label,
    input.name,
  ].filter(hasValue);
  return parts.length > 0 ? parts.map(String).join("|") : null;
}

export function derivePeerId(input = {}) {
  if (hasValue(input.peerId)) {
    return String(input.peerId);
  }
  const seed = input.identitySeed ?? canonicalIdentitySeed(input);
  return seed ? `peer-${stableHash(String(seed))}` : "peer-unknown";
}

export function normalizeCapabilities(capabilities = {}) {
  return normalizeCapabilityProfile(capabilities);
}

export function createPeerContext(input = {}) {
  const peerId = derivePeerId(input);
  const sessionId = hasValue(input.sessionId)
    ? String(input.sessionId)
    : hasValue(input.clientId)
      ? String(input.clientId)
      : null;
  const deviceId = hasValue(input.deviceId) ? String(input.deviceId) : null;
  const clientId = hasValue(input.clientId) ? String(input.clientId) : null;
  const deviceLabel =
    input.deviceLabel ?? input.label ?? input.name ?? input.source ?? null;

  return {
    format: PEER_CONTEXT_FORMAT,
    version: PEER_CONTEXT_VERSION,
    peerId,
    sessionId,
    clientId,
    deviceId,
    deviceLabel,
    source: input.source ?? null,
    role: input.role ?? "participant",
    capabilities: normalizeCapabilities(input.capabilities),
    isKnown: peerId !== "peer-unknown",
  };
}

export function normalizePeerContext(input = {}) {
  if (input?.format === PEER_CONTEXT_FORMAT) {
    return createPeerContext(input);
  }
  return createPeerContext(input);
}

export function peerHolderId(peerContext) {
  const peer = normalizePeerContext(peerContext);
  return peer.sessionId ? `${peer.peerId}:${peer.sessionId}` : peer.peerId;
}
