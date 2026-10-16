import { createPeerContext } from "./peer-context.js";

export const AUTHORITY_SOURCES = Object.freeze({
  HUMAN_INTERFACE: "human-interface",
  BROWSER_RUNTIME: "browser-runtime",
  AUTHORITY_HTTP_API: "authority-http-api",
  AGENT_API: "agent-api",
  LOCAL_BUS: "local-bus",
});

function stableClientId(client = {}, fallback = "local-browser") {
  return String(client.id ?? client.clientId ?? client.sessionId ?? fallback);
}

function cleanActorId(value) {
  return String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function localAuthorityPeerId(prefix, clientId, detail = {}) {
  return (
    detail.peerId ??
    `${cleanActorId(prefix) || prefix}-${cleanActorId(clientId) || "local"}`
  );
}

export function createHumanInterfaceOrigin(client = {}, detail = {}) {
  const clientId = stableClientId({ ...client, ...detail });
  return createPeerContext({
    clientId,
    sessionId: String(detail.sessionId ?? client.sessionId ?? clientId),
    peerId: localAuthorityPeerId("human-interface", clientId, detail),
    deviceId: detail.deviceId ?? client.deviceId ?? null,
    deviceLabel: detail.deviceLabel ?? "human interface",
    source: AUTHORITY_SOURCES.HUMAN_INTERFACE,
    role: detail.role ?? "author",
    capabilities: detail.capabilities ?? client.capabilities,
  });
}

export function createBrowserRuntimeOrigin(client = {}, detail = {}) {
  const clientId = stableClientId({ ...client, ...detail });
  const subsystem = cleanActorId(detail.subsystem ?? "runtime");
  return createPeerContext({
    clientId,
    sessionId: String(detail.sessionId ?? client.sessionId ?? clientId),
    peerId: localAuthorityPeerId(`browser-${subsystem}`, clientId, detail),
    deviceId: detail.deviceId ?? client.deviceId ?? null,
    deviceLabel: detail.deviceLabel ?? `browser ${subsystem}`,
    source: AUTHORITY_SOURCES.BROWSER_RUNTIME,
    role: detail.role ?? "automation",
    capabilities: detail.capabilities ?? client.capabilities,
  });
}

export function isHumanInterfaceOrigin(origin = {}) {
  return origin?.source === AUTHORITY_SOURCES.HUMAN_INTERFACE;
}

export function isBrowserRuntimeOrigin(origin = {}) {
  return origin?.source === AUTHORITY_SOURCES.BROWSER_RUNTIME;
}

export function isAuthorityHttpApiOrigin(origin = {}) {
  return origin?.source === AUTHORITY_SOURCES.AUTHORITY_HTTP_API;
}
