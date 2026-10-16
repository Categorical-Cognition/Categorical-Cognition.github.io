import { MessageBus } from "./message-bus.js";
import { SharedDomainStore } from "./domain-state.js";
import { GologWorkspace } from "./golog-workspace.js";
import { GologScene } from "./three-scene.js";
import { bindStatusPanel } from "./ui-bindings.js";
import { createGologAgentApi } from "./agent-api.js";
import { MetaGologService } from "./meta-golog-service.js";
import { GOLOG_MODES, ModeHead } from "./mode_head.js";
import { StructuredCreationService } from "./structured-creation-service.js";
import { createLocalSyncClient } from "./local-sync-client.js";
import { createPeerContext } from "./peer-context.js";
import {
  findHostedWorkspace,
  hostedWorkspaceIdFromPath,
  hostedWorkspaceStartupConfig,
  hostedWorkspaceStartupConfigForId,
} from "./hosted-workspaces.js";
import {
  createBrowserRuntimeOrigin,
  createHumanInterfaceOrigin,
} from "./authority-origins.js";
import { createForceLayoutController } from "./force-layout-controller.js";
import {
  PreviewForceUniverse,
  createLiveForceLayoutService,
} from "./live-force-layout.js";
import {
  hydrateWorkspaceFromDocument,
  normalizeWorkspaceDocument,
  parseWorkspaceDocument,
  serializeWorkspace,
  stringifyWorkspaceDocument,
} from "./workspace-serialization.js";
import { PAYLOAD_TYPES } from "./payload-types.js";
import { createShapeExpansion } from "./shape-expansion.js";
import { browserRuntimeConfig } from "./runtime-config.js";
import {
  PAYLOAD_SCENE_PRESENTATION_TYPES,
  sceneExpansionPayloadChoices,
  scenePresentationForPayload,
} from "./payload-scene-presenters.js";

export function createLocalClient() {
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `browser-${Date.now()}`,
    ip: "local-browser",
  };
}

function defaultRuntimeModeForDevice() {
  return runtimeModeForDevice();
}

function runtimeModeForDevice() {
  const navigatorRef = globalThis.navigator;
  const platform = navigatorRef?.platform ?? "";
  const userAgent = navigatorRef?.userAgent ?? "";
  return /iPhone/i.test(`${platform} ${userAgent}`)
    ? GOLOG_MODES.IPHONE
    : GOLOG_MODES.ORDINARY;
}

function isIphoneRuntime() {
  return runtimeModeForDevice() === GOLOG_MODES.IPHONE;
}

function syncFlagEnabled(params) {
  const raw = params.get("localSync") ?? params.get("sync");
  return raw !== null && raw !== "0" && raw !== "false";
}

function defaultUrlParams() {
  const defaults = globalThis.__GOLOG_DEFAULT_URL_PARAMS;
  if (!defaults || typeof defaults !== "object") {
    return new URLSearchParams();
  }
  return new URLSearchParams(
    Object.entries(defaults)
      .filter(([, value]) => value !== null && value !== undefined)
      .map(([key, value]) => [key, String(value)]),
  );
}

function urlParamsWithDefaults(search = "") {
  const params = new URLSearchParams(search);
  const defaults = defaultUrlParams();
  for (const [key, value] of defaults.entries()) {
    if (!params.has(key)) {
      params.set(key, value);
    }
  }
  return params;
}

function numberParam(params, key) {
  const raw = params.get(key);
  if (raw === null || raw === "") {
    return undefined;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function stringParam(params, key) {
  const value = params.get(key);
  return value === null || value === "" ? undefined : value;
}

function capabilityProfileFromParams(params) {
  const capabilities = {
    deviceClass: stringParam(params, "deviceClass"),
    renderClass: stringParam(params, "renderClass"),
    memoryClass: stringParam(params, "memoryClass"),
    batteryState: stringParam(params, "batteryState"),
    availability: stringParam(params, "availability"),
    computeScore: numberParam(params, "computeScore"),
    latencyMs: numberParam(params, "latencyMs"),
    load: numberParam(params, "load"),
  };
  const entries = Object.entries(capabilities).filter(([, value]) => value !== undefined);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function localSyncConfigFromLocation(locationRef, client, runtimeConfig = browserRuntimeConfig()) {
  if (runtimeConfig.staticHosting) return null;
  if (!runtimeConfig.developmentTools) {
    const peer = runtimeConfig.peer;
    if (!runtimeConfig.shared || !locationRef?.host || !peer?.peerId || !peer?.sessionId) {
      return null;
    }
    const protocol = locationRef.protocol === "https:" ? "wss:" : "ws:";
    return {
      url: `${protocol}//${locationRef.host}/__golog_sync`,
      peerContext: createPeerContext({ ...peer, clientId: client.id,
        deviceLabel: isIphoneRuntime() ? "iPhone" : "Browser", role: "participant" }),
      authorityHost: false,
    };
  }
  const params = urlParamsWithDefaults(locationRef?.search ?? "");
  const explicitPeerId = params.get("peerId") ?? params.get("peer");
  const peerId =
    explicitPeerId && explicitPeerId !== "auto" ? explicitPeerId : client.id;
  const capabilities = capabilityProfileFromParams(params);
  const authorityHostRaw =
    params.get("authorityHost") ?? params.get("syncHost") ?? "auto";
  const authorityHost =
    authorityHostRaw === "auto" || authorityHostRaw === ""
      ? !isIphoneRuntime()
      : !["0", "false", "no", "client"].includes(
          authorityHostRaw.toLowerCase(),
        );
  const deviceLabel =
    params.get("deviceLabel") ?? (isIphoneRuntime() ? "iPhone" : "Browser");
  const role = params.get("role") ?? (authorityHost ? "author" : "participant");

  if (!locationRef?.search || !locationRef?.host) {
    if (!syncFlagEnabled(params) || !locationRef?.host) {
      return null;
    }
    const protocol = locationRef?.protocol === "https:" ? "wss:" : "ws:";
    return {
      url:
        params.get("localSyncUrl") ??
        params.get("syncUrl") ??
        `${protocol}//${locationRef.host}/__golog_sync?peerId=${encodeURIComponent(
          peerId,
        )}`,
      peerContext: createPeerContext({
        peerId,
        sessionId: params.get("sessionId") ?? peerId,
        clientId: client.id,
        deviceLabel,
        role,
        ...(capabilities ? { capabilities } : {}),
      }),
      authorityHost,
    };
  }
  if (!syncFlagEnabled(params)) {
    return null;
  }
  const protocol = locationRef.protocol === "https:" ? "wss:" : "ws:";
  const url =
    params.get("localSyncUrl") ??
    params.get("syncUrl") ??
    `${protocol}//${locationRef.host}/__golog_sync?peerId=${encodeURIComponent(
      peerId,
    )}`;
  return {
    url,
    peerContext: createPeerContext({
      peerId,
      sessionId: params.get("sessionId") ?? peerId,
      clientId: client.id,
      deviceLabel,
      role,
      ...(capabilities ? { capabilities } : {}),
    }),
    authorityHost,
  };
}

const DEFAULT_STARTUP_WORKSPACE_PRESET = "blank";
const DEFAULT_BROWSER_TITLE = "JSGoLog";
const DEV_RELOAD_SESSION_STORAGE_KEY = "jsgolog.devReloadSession.v1";
const DEV_RELOAD_SESSION_QUERY_PARAM = "devReloadSessionKey";
const DEV_RELOAD_INDEXED_DB_NAME = "jsgolog-dev-reload";
const DEV_RELOAD_INDEXED_DB_STORE = "reloadSessions";

export function browserTitleForGolog(golog, fallbackTitle = DEFAULT_BROWSER_TITLE) {
  const title = String(golog?.title ?? "").trim();
  return title || fallbackTitle;
}

function devReloadSessionId() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `dev-reload-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

function openDevReloadDb() {
  const indexedDb = globalThis.indexedDB;
  if (!indexedDb) {
    return Promise.reject(new Error("IndexedDB is unavailable"));
  }
  return new Promise((resolve, reject) => {
    const request = indexedDb.open(DEV_RELOAD_INDEXED_DB_NAME, 1);
    request.addEventListener("upgradeneeded", () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DEV_RELOAD_INDEXED_DB_STORE)) {
        db.createObjectStore(DEV_RELOAD_INDEXED_DB_STORE);
      }
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () =>
      reject(request.error ?? new Error("Unable to open reload snapshot store")),
    );
  });
}

async function withDevReloadStore(mode, callback) {
  const db = await openDevReloadDb();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(DEV_RELOAD_INDEXED_DB_STORE, mode);
      const store = transaction.objectStore(DEV_RELOAD_INDEXED_DB_STORE);
      let result;
      try {
        result = callback(store);
      } catch (error) {
        reject(error);
        return;
      }
      transaction.addEventListener("complete", () => resolve(result));
      transaction.addEventListener("abort", () =>
        reject(transaction.error ?? new Error("Reload snapshot transaction aborted")),
      );
      transaction.addEventListener("error", () =>
        reject(transaction.error ?? new Error("Reload snapshot transaction failed")),
      );
    });
  } finally {
    db.close();
  }
}

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () =>
      reject(request.error ?? new Error("Reload snapshot request failed")),
    );
  });
}

async function putDevReloadIndexedDbSession(key, session) {
  await withDevReloadStore("readwrite", (store) =>
    idbRequest(store.put(session, key)),
  );
}

async function takeDevReloadIndexedDbSession(key) {
  const db = await openDevReloadDb();
  const session = await new Promise((resolve, reject) => {
    const transaction = db.transaction(DEV_RELOAD_INDEXED_DB_STORE, "readwrite");
    const store = transaction.objectStore(DEV_RELOAD_INDEXED_DB_STORE);
    let value = null;
    const getRequest = store.get(key);
    getRequest.addEventListener("success", () => {
      value = getRequest.result ?? null;
      store.delete(key);
    });
    getRequest.addEventListener("error", () =>
      reject(getRequest.error ?? new Error("Unable to read reload snapshot")),
    );
    transaction.addEventListener("complete", () => resolve(value));
    transaction.addEventListener("abort", () =>
      reject(transaction.error ?? new Error("Reload snapshot transaction aborted")),
    );
    transaction.addEventListener("error", () =>
      reject(transaction.error ?? new Error("Reload snapshot transaction failed")),
    );
  });
  db.close();
  return session?.format === "jsgolog.dev-reload-session" ? session : null;
}

function devReloadSessionKeyFromUrl(locationRef = globalThis.location) {
  if (!locationRef?.href) {
    return null;
  }
  return new URL(locationRef.href).searchParams.get(
    DEV_RELOAD_SESSION_QUERY_PARAM,
  );
}

function clearDevReloadSessionKeyFromUrl(locationRef = globalThis.location) {
  if (!locationRef?.href || !globalThis.history?.replaceState) {
    return;
  }
  const url = new URL(locationRef.href);
  if (!url.searchParams.has(DEV_RELOAD_SESSION_QUERY_PARAM)) {
    return;
  }
  url.searchParams.delete(DEV_RELOAD_SESSION_QUERY_PARAM);
  globalThis.history.replaceState(globalThis.history.state, "", url.href);
}

export function startupConfigFromLocation(locationRef = globalThis.location) {
  if (!locationRef || browserRuntimeConfig().staticHosting) {
    return null;
  }
  const params = urlParamsWithDefaults(locationRef?.search ?? "");
  const explicitParams = new URLSearchParams(locationRef?.search ?? "");
  const hasExplicitWorkspaceUrl = explicitParams.has("startupWorkspaceUrl");
  const hasExplicitStartup =
    explicitParams.has("startup") || explicitParams.has("defaultStartup");
  const { hostedWorkspaces } = browserRuntimeConfig();

  const hostedPathId = hostedWorkspaceIdFromPath(locationRef.pathname ?? "");
  const hostedPathEntry = findHostedWorkspace(hostedPathId, hostedWorkspaces);
  if (hostedPathEntry) {
    return {
      ...hostedWorkspaceStartupConfig(hostedPathEntry),
    };
  }
  if (hostedPathId) {
    return {
      ...hostedWorkspaceStartupConfigForId(hostedPathId),
    };
  }

  if (
    params.has("startupWorkspaceUrl") &&
    (hasExplicitWorkspaceUrl || !hasExplicitStartup)
  ) {
    return {
      url: params.get("startupWorkspaceUrl"),
      activeGologTitle: params.get("startupGologTitle") ?? null,
      ...(params.has("startupHostedWorkspaceId")
        ? { hostedWorkspaceId: params.get("startupHostedWorkspaceId") }
        : {}),
    };
  }

  const startup = (
    params.get("startup") ??
    params.get("defaultStartup") ??
    DEFAULT_STARTUP_WORKSPACE_PRESET
  ).toLowerCase();
  if (["blank", "empty", "new", "none"].includes(startup)) {
    return null;
  }
  const preset = findHostedWorkspace(startup, hostedWorkspaces);
  if (!preset) {
    return null;
  }
  return {
    ...hostedWorkspaceStartupConfig(preset),
  };
}

export function createGologApp({
  container,
  documentRef = globalThis.document,
  client = createLocalClient(),
  developmentTools = browserRuntimeConfig().developmentTools,
} = {}) {
  developmentTools = developmentTools && !browserRuntimeConfig().staticHosting;
  const humanInterfaceOrigin = createHumanInterfaceOrigin(client);
  const browserRuntimeOrigin = createBrowserRuntimeOrigin(client);
  const browserForceLayoutOrigin = createBrowserRuntimeOrigin(client, {
    subsystem: "force-layout",
  });
  const localSyncConfig = localSyncConfigFromLocation(globalThis.location, client, {
    ...browserRuntimeConfig(), developmentTools,
  });
  let localSync = null;
  let receivedAuthorityWorkspace = false;
  function currentHumanInterfaceOrigin() {
    const peer = localSync?.status?.().peer ?? localSyncConfig?.peerContext ?? null;
    if (!peer?.peerId) {
      return humanInterfaceOrigin;
    }
    return createHumanInterfaceOrigin(client, {
      peerId: peer.peerId,
      sessionId: peer.sessionId ?? peer.peerId,
      clientId: peer.clientId ?? client.id,
      deviceId: peer.deviceId,
      deviceLabel: peer.deviceLabel,
      capabilities: peer.capabilities,
      role: peer.role ?? "author",
    });
  }
  const workspace = new GologWorkspace({
    createBus: () => new MessageBus(),
    createStore: (bus, context) =>
      new SharedDomainStore(bus, {
        ...context,
        operationOrigin: () => currentHumanInterfaceOrigin(),
      }),
  });
  const scenes = new Map();
  const pendingChildGologCreations = new Map();
  let creation = null;
  let liveForceLayout = null;
  let metaGologService = null;
  let modeHead = null;

  function syncDocumentTitle(golog = workspace.activeGolog()) {
    if (documentRef && "title" in documentRef) {
      documentRef.title = browserTitleForGolog(golog);
    }
  }

  function ensureGologScene(golog) {
    if (!golog) {
      return null;
    }
    if (golog.scene) {
      return golog.scene;
    }

    const scene = new GologScene({
      bus: golog.bus,
      state: golog.state,
      client,
      container,
      active: false,
      modeHead,
      createPreviewForceUniverse: ({ externalIntentProvider = null } = {}) =>
        new PreviewForceUniverse({
          createForceLayout,
          settingsProvider: () => liveForceLayout?.settings ?? {},
          settingsBus: workspace.bus,
          externalIntentProvider,
          frameRef: globalThis,
          origin: browserForceLayoutOrigin,
        }),
    });
    golog.scene = scene;
    scenes.set(golog.id, scene);
    golog.releaseNestedGologPreviewListener = golog.bus.on(
      "sphere:nested-golog-preview",
      ({ id }) => previewSphereGolog(golog, id),
    );
    golog.releaseNestedGologEnterListener = golog.bus.on(
      "sphere:nested-golog-enter",
      ({ id }) => enterObjectGolog(golog, id),
    );
    golog.releaseObjectGologPreviewListener = golog.bus.on(
      "object:nested-golog-preview",
      ({ id }) => previewObjectGolog(golog, id),
    );
    golog.releaseObjectGologEnterListener = golog.bus.on(
      "object:nested-golog-enter",
      ({ id }) => enterObjectGolog(golog, id),
    );
    golog.releaseNestedGologStateListener = golog.bus.on("state:changed", () => {
      for (const [objectId, preview] of scene.nestedPreviews) {
        const child = childGologForObject(golog, objectId);
        if (child && preview.childGolog?.id !== child.id) {
          scene.showNestedGologPreview({ objectId, childGolog: child });
        } else if (preview.childGolog && !child) {
          scene.closeNestedGologPreview(objectId);
        }
      }
    });
    golog.releasePayloadScenePresentationListener = golog.bus.on(
      "payload:scene-present",
      (selectable) => previewPayloadForSelectable(golog, selectable),
    );

    return scene;
  }

  function setActiveScene(activeGologId) {
    ensureGologScene(workspace.gologs.get(activeGologId));
    for (const [id, scene] of scenes.entries()) {
      scene.setActive(id === activeGologId);
    }
  }

  function childGologForObject(parentGolog, objectId) {
    const payload = parentGolog.state.getPayloadByType?.(
      objectId,
      PAYLOAD_TYPES.NESTED_GOLOG,
    ) ?? parentGolog.state.getPayload(objectId);
    if (payload?.type !== "nested-golog") {
      return null;
    }
    return workspace.gologs.get(payload.targetGologId) ?? null;
  }

  function previewObjectGolog(parentGolog, objectId) {
    const scene = ensureGologScene(parentGolog);

    const child = childGologForObject(parentGolog, objectId);
    if (!child) {
      scene.showEmptyNestedPreview({ objectId });
      return null;
    }

    scene.showNestedGologPreview({
      objectId,
      childGolog: child,
    });
    return child;
  }

  function previewSphereGolog(parentGolog, sphereId) {
    return previewObjectGolog(parentGolog, sphereId);
  }

  function firstScenePresentablePayload(parentGolog, selectable) {
    if (!parentGolog || !selectable?.id) {
      return null;
    }
    const payloads = typeof parentGolog.state.getPayloads === "function"
      ? parentGolog.state.getPayloads(selectable.id)
      : [parentGolog.state.getPayload(selectable.id)].filter(Boolean);
    const expansionPayload =
      sceneExpansionPayloadChoices(payloads, { workspace })[0]?.payload ?? null;
    if (expansionPayload) {
      return expansionPayload;
    }
    return null;
  }

  function previewPayloadForSelectable(parentGolog, selectable) {
    const payload =
      selectable?.payload ??
      firstScenePresentablePayload(parentGolog, selectable);
    const scene = ensureGologScene(parentGolog);
    if (!payload || !scene) {
      if (selectable?.id && scene) {
        scene.showEmptyNestedPreview({ objectId: selectable.id });
      }
      return null;
    }

    const presentation = scenePresentationForPayload(payload, { workspace });
    if (!presentation) {
      return null;
    }

    if (
      presentation.type === PAYLOAD_SCENE_PRESENTATION_TYPES.MEDIA_BILLBOARD
    ) {
      scene.showPayloadBillboardPreview({
        objectId: selectable.id,
        objectKind: selectable.kind,
        presentation,
      });
      return payload;
    }

    if (
      presentation.type === PAYLOAD_SCENE_PRESENTATION_TYPES.NESTED_GOLOG
    ) {
      if (!presentation.childGolog) {
        scene.showEmptyNestedPreview({ objectId: selectable.id });
        return null;
      }
      scene.showNestedGologPreview({
        objectId: selectable.id,
        childGolog: presentation.childGolog,
      });
      return presentation.childGolog;
    }

    return null;
  }

  async function enterObjectGolog(parentGolog, objectId) {
    try {
      const child = childGologForObject(parentGolog, objectId) ??
        await createChildGologForObject({ parentGologId: parentGolog.id, objectId });
      if (!child) return null;
      const currentParent = workspace.gologs.get(parentGolog.id);
      if (!currentParent || workspace.activeGologId !== parentGolog.id ||
          !modeHead.canInspectNestedGolog()) return child;
      ensureGologScene(currentParent)?.closeNestedGologPreview();
      openGolog(child.id);
      return child;
    } catch (error) {
      workspace.bus.emit("expansion:failed", { message: error.message });
      return null;
    }
  }

  function createChildGologForObject({ parentGologId, objectId }) {
    const key = JSON.stringify([parentGologId, objectId]);
    if (pendingChildGologCreations.has(key)) return pendingChildGologCreations.get(key);
    const parentGolog = workspace.gologs.get(parentGologId);
    if (
      !parentGolog ||
      parentGolog.state.getPayloadByType?.(objectId, PAYLOAD_TYPES.NESTED_GOLOG)
    ) {
      return null;
    }
    const result = createShapeExpansion({ workspace, createGolog, deleteGolog }, {
      gologId: parentGologId,
      objectId,
      activate: false,
    });
    const finish = (completed) => {
      workspace.bus.emit("expansion:attached", { parentGologId, objectId });
      return workspace.gologs.get(completed.targetGologId) ?? null;
    };
    if (!result?.then) return finish(result);
    const pending = result.then(finish).finally(() => pendingChildGologCreations.delete(key));
    pendingChildGologCreations.set(key, pending);
    return pending;
  }

  function createChildGologForSphere({ parentGologId, sphereId }) {
    return createChildGologForObject({ parentGologId, objectId: sphereId });
  }

  function associateGologToObject({ parentGologId, objectId, targetGologId, rootObjectId = null }) {
    const parentGolog = workspace.gologs.get(parentGologId);
    if (
      !parentGolog ||
      !objectId ||
      !targetGologId ||
      !workspace.gologs.has(targetGologId)
    ) {
      return null;
    }
    const result = parentGolog.state.operationPipeline.submit(
      "payload:golog-attach",
      {
        id: objectId,
        targetGologId,
        rootObjectId,
      },
      { origin: { source: "app-init", role: "system" } },
    );
    const finish = (completed) => {
      if (!completed.ok) throw new Error(completed.reason ?? "Could not attach this golog expansion.");
      workspace.bus.emit("expansion:attached", { parentGologId, objectId, targetGologId });
      return workspace.gologs.get(targetGologId);
    };
    return result?.then ? result.then(finish) : finish(result);
  }

  function associateGologToSphere({ parentGologId, sphereId, targetGologId }) {
    return associateGologToObject({ parentGologId, objectId: sphereId, targetGologId });
  }

  function openGolog(gologId, options = {}) {
    const golog = modeHead.openGolog(gologId, options);
    if (golog) {
      setActiveScene(golog.id);
    }
    return golog;
  }

  function openMetaGolog(options = {}) {
    const golog = modeHead.openMetaGolog(options);
    if (golog) {
      setActiveScene(golog.id);
    }
    return golog;
  }

  function navigateBackGolog() {
    const golog = workspace.navigateBack();
    if (golog) {
      modeHead?.syncModeForActiveGolog(golog.id);
      setActiveScene(golog.id);
    }
    return golog;
  }

  function navigateForwardGolog() {
    const golog = workspace.navigateForward();
    if (golog) {
      modeHead?.syncModeForActiveGolog(golog.id);
      setActiveScene(golog.id);
    }
    return golog;
  }

  function startGologAssociation({ sourceGologId, sourceObjectId }) {
    return modeHead.startAssociation({
      sourceGologId,
      sourceObjectId,
    });
  }

  function disposeGolog(golog) {
    golog.releaseNestedGologPreviewListener?.();
    golog.releaseNestedGologEnterListener?.();
    golog.releaseObjectGologPreviewListener?.();
    golog.releaseObjectGologEnterListener?.();
    golog.releaseNestedGologStateListener?.();
    golog.releasePayloadScenePresentationListener?.();

    golog.scene?.dispose?.();
    golog.scene = null;
  }

  function disposeAllGologs() {
    for (const golog of workspace.gologs.values()) {
      disposeGolog(golog);
    }
    scenes.clear();
  }

  function deleteGolog(gologId) {
    const golog = workspace.gologs.get(gologId);
    if (!golog) {
      return false;
    }
    for (const scene of scenes.values()) {
      for (const [objectId, preview] of scene.nestedPreviews) {
        if (preview.childGolog?.id === gologId) scene.closeNestedGologPreview(objectId);
      }

    }
    disposeGolog(golog);
    scenes.delete(gologId);
    return workspace.deleteGolog(gologId);
  }

  function createGolog({
    id = null,
    title = null,
    createdAt = null,
    activate = true,
    structureId = null,
    schema = null,
  } = {}) {
    const golog = workspace.createGolog({
      id,
      title,
      createdAt,
      structureId,
      schema,
    });
    if (activate) {
      ensureGologScene(golog);
      if (modeHead) {
        openGolog(golog.id);
      } else {
        workspace.activateGolog(golog.id);
        setActiveScene(golog.id);
      }
    }
    return golog;
  }

  function saveWorkspaceDocument() {
    return stringifyWorkspaceDocument(workspace);
  }

  function createGologForUI(options = {}) {
    const previousActiveGologId = workspace.activeGologId;
    const result = app.agentApi.createGolog({ ...options, activate: false });
    const finish = ({ id }) => {
      const golog = workspace.gologs.get(id);
      if (golog && options.activate && workspace.activeGologId === previousActiveGologId) openGolog(id);
      return golog ?? null;
    };
    return result?.then ? result.then(finish) : finish(result);
  }

  function loadWorkspaceDocumentData(
    document,
    { activeGologTitle = null } = {},
  ) {
    const validatedDocument = normalizeWorkspaceDocument(document);
    disposeAllGologs();
    const normalized = metaGologService.suspend(() =>
      hydrateWorkspaceFromDocument({
        workspace,
        document: validatedDocument,
        createGolog,
      }),
    );
    localSync?.reconcileWorkspace?.();
    metaGologService.reconcile();
    const requestedActiveGolog = activeGologTitle
      ? [...workspace.gologs.values()].find(
          (golog) => golog.title === activeGologTitle,
        )
      : null;
    if (requestedActiveGolog) {
      openGolog(requestedActiveGolog.id);
    } else if (workspace.activeGologId) {
      openGolog(workspace.activeGologId);
    } else {
      setActiveScene(workspace.activeGologId);
    }
    return normalized;
  }

  function loadWorkspaceDocumentText(
    text,
    { activeGologTitle = null, publishSnapshot = true } = {},
  ) {
    if (publishSnapshot && browserRuntimeConfig().sharedWorkspaceLoad) {
      return replaceSharedWorkspaceDocument(text);
    }
    return loadWorkspaceDocumentData(parseWorkspaceDocument(text), {
      activeGologTitle,
      publishSnapshot,
    });
  }

  async function replaceSharedWorkspaceDocument(text) {
    if (!localSync?.status().connected) throw new Error("Connect to the shared workspace before loading a file");
    const requestId = globalThis.crypto?.randomUUID?.() ?? `load-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const response = await fetch("/__golog/workspace/load", {
      method: "POST", credentials: "same-origin", redirect: "error",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, requestId }),
    });
    const result = await response.json();
    if (!response.ok || !result.ok || !result.snapshotId) throw new Error(result.error ?? "Shared workspace load failed");
    await localSync.waitForWorkspaceSnapshot(result.snapshotId);
    return serializeWorkspace(workspace);
  }

  function cameraSessionsSnapshot() {
    ensureGologScene(workspace.activeGolog());
    return Object.fromEntries(
      [...scenes.entries()]
        .map(([gologId, scene]) => [
          gologId,
          scene.cameraSessionSnapshot?.() ?? null,
        ])
        .filter(([, snapshot]) => snapshot),
    );
  }

  function loadAuthorityWorkspaceSnapshot(document, { replacement = false } = {}) {
    // Domain hydration must retain this peer's view after its first snapshot.
    // A catalog addition should not clear the inspector or move its camera.
    const view = receivedAuthorityWorkspace && !replacement ? {
      activeGologId: workspace.activeGologId,
      selections: [...workspace.gologs.values()].map(({ id, state }) => [id, state.selectedSimplexId]),
      cameras: cameraSessionsSnapshot(),
      mode: modeHead.snapshot(),
      back: [...workspace.navigationBackStack],
      forward: [...workspace.navigationForwardStack],
    } : null;
    const normalized = loadWorkspaceDocumentData(document);
    receivedAuthorityWorkspace = true;
    if (replacement) workspace.bus.emit("workspace:replaced", { document: normalized });
    if (!view) return normalized;
    workspace.navigationBackStack = view.back.filter((id) => workspace.gologs.has(id));
    workspace.navigationForwardStack = view.forward.filter((id) => workspace.gologs.has(id));
    if (workspace.gologs.has(view.activeGologId)) {
      workspace.activateGolog(view.activeGologId, { recordNavigation: false });
      modeHead.setMode(view.mode.name, view.mode.context);
      setActiveScene(view.activeGologId);
    }
    for (const [gologId, objectId] of view.selections) {
      const state = workspace.gologs.get(gologId)?.state;
      if (!objectId || !state?.hasSelectableSimplex(objectId)) continue;
      if (state.spheres.has(objectId)) state.selectSphere(objectId);
      else if (state.edges.has(objectId)) state.selectEdge(objectId);
      else if (state.surfaces.has(objectId)) state.selectSurface(objectId);
      else if (state.volumes.has(objectId)) state.selectVolume(objectId);
    }
    for (const [gologId, camera] of Object.entries(view.cameras)) {
      const golog = workspace.gologs.get(gologId);
      if (!golog) continue;
      const scene = ensureGologScene(golog);
      scene.restoreCameraSession(camera);
      scene.resize();
    }
    return normalized;
  }

  async function writeDevReloadSession() {
    const activeGolog = workspace.activeGolog();
    const session = {
      format: "jsgolog.dev-reload-session",
      version: 1,
      createdAt: new Date().toISOString(),
      activeGologId: workspace.activeGologId,
      activeGologTitle: activeGolog?.title ?? null,
      mode: modeHead?.snapshot?.() ?? null,
      cameraSessions: cameraSessionsSnapshot(),
      workspaceDocument: saveWorkspaceDocument(),
    };
    const storage = globalThis.sessionStorage;
    if (!storage) {
      throw new Error("Session storage is unavailable");
    }
    try {
      storage.setItem(
        DEV_RELOAD_SESSION_STORAGE_KEY,
        JSON.stringify({
          format: "jsgolog.dev-reload-descriptor",
          version: 1,
          storage: "session",
          session,
        }),
      );
      return { storage: "session", session };
    } catch (error) {
      console.warn("Session storage reload snapshot failed; falling back to IndexedDB", error);
      storage.removeItem(DEV_RELOAD_SESSION_STORAGE_KEY);
    }

    const key = devReloadSessionId();
    await putDevReloadIndexedDbSession(key, session);
    try {
      storage.setItem(
        DEV_RELOAD_SESSION_STORAGE_KEY,
        JSON.stringify({
          format: "jsgolog.dev-reload-descriptor",
          version: 1,
          storage: "indexeddb",
          key,
        }),
      );
    } catch (error) {
      console.warn("Unable to store reload snapshot pointer in session storage", error);
    }
    return { storage: "indexeddb", key, session };
  }

  async function takeDevReloadSession() {
    const storage = globalThis.sessionStorage;
    const urlKey = devReloadSessionKeyFromUrl();
    clearDevReloadSessionKeyFromUrl();
    if (!storage && !urlKey) {
      return null;
    }
    if (!storage) {
      return takeDevReloadIndexedDbSession(urlKey);
    }
    let raw = null;
    try {
      raw = storage.getItem(DEV_RELOAD_SESSION_STORAGE_KEY);
    } catch (error) {
      console.warn("Unable to read dev reload session", error);
      return null;
    }
    if (!raw) {
      return urlKey ? takeDevReloadIndexedDbSession(urlKey) : null;
    }
    try {
      storage.removeItem(DEV_RELOAD_SESSION_STORAGE_KEY);
    } catch (error) {
      console.warn("Unable to clear dev reload session", error);
    }
    try {
      const session = JSON.parse(raw);
      if (session?.format === "jsgolog.dev-reload-session") {
        return session;
      }
      if (
        session?.format === "jsgolog.dev-reload-descriptor" &&
        session.storage === "session"
      ) {
        return session.session?.format === "jsgolog.dev-reload-session"
          ? session.session
          : null;
      }
      const descriptorKey =
        session?.format === "jsgolog.dev-reload-descriptor" &&
        session.storage === "indexeddb"
          ? session.key
          : null;
      const key = descriptorKey ?? urlKey;
      return key ? takeDevReloadIndexedDbSession(key) : null;
    } catch (error) {
      console.warn("Unable to parse dev reload session", error);
      return urlKey ? takeDevReloadIndexedDbSession(urlKey) : null;
    }
  }

  function restoreDevReloadSession(session) {
    if (!session?.workspaceDocument) {
      return null;
    }
    const normalized = loadWorkspaceDocumentText(session.workspaceDocument, {
      activeGologTitle: session.activeGologTitle,
      publishSnapshot: false,
    });
    const activeGologId = workspace.gologs.has(session.activeGologId)
      ? session.activeGologId
      : workspace.activeGologId;
    const mode = session.mode?.name ?? undefined;
    const context = session.mode?.context ?? {};
    const activeGolog = activeGologId
      ? openGolog(activeGologId, { mode, context })
      : workspace.activeGolog();
    const activeScene = ensureGologScene(activeGolog);
    const cameraSession =
      session.cameraSessions?.[activeGolog?.id] ??
      session.cameraSessions?.[workspace.activeGologId] ??
      null;
    if (cameraSession && activeScene?.restoreCameraSession) {
      activeScene.restoreCameraSession(cameraSession);
      activeScene.resize();
    }
    return {
      ok: true,
      activeGologId: workspace.activeGologId,
      activeGologTitle: workspace.activeGolog()?.title ?? null,
      restoredGologs: normalized.gologs?.length ?? workspace.gologs.size,
    };
  }

  async function devReloadWithRestore() {
    if (!developmentTools) {
      return false;
    }
    let descriptor = null;
    try {
      descriptor = await writeDevReloadSession();
    } catch (error) {
      globalThis.alert?.(error.message);
      return null;
    }
    if (!globalThis.location?.href) {
      return false;
    }
    const url = new URL(globalThis.location.href);
    if (descriptor?.storage === "indexeddb" && descriptor.key) {
      url.searchParams.set(DEV_RELOAD_SESSION_QUERY_PARAM, descriptor.key);
    } else {
      url.searchParams.delete(DEV_RELOAD_SESSION_QUERY_PARAM);
    }
    if (url.href !== globalThis.location.href) {
      globalThis.location.assign(url.href);
    } else {
      globalThis.location.reload();
    }
    return true;
  }

  function createForceLayout(golog = workspace.activeGolog(), options = {}) {
    if (!golog) {
      throw new Error("No active golog for force layout");
    }
    return createForceLayoutController({
      store: golog.state,
      bus: golog.bus,
      origin: options.origin ?? browserRuntimeOrigin,
    });
  }

  async function loadStartupWorkspace(config) {
    if (!config) {
      return { ok: true, skipped: true, reason: "blank startup requested" };
    }
    try {
      const response = await fetch(config.url, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }
      const text = await response.text();
      // A fresh peer may receive current authority state while the saved
      // startup file is still downloading. Do not replace it with that file.
      if (receivedAuthorityWorkspace) {
        return { ok: true, skipped: true, reason: "authority workspace already hydrated" };
      }
      loadWorkspaceDocumentText(text, {
        activeGologTitle: config.activeGologTitle,
        publishSnapshot: false,
      });

      return {
        ok: true,
        url: config.url,
        activeGologId: workspace.activeGologId,
        activeGologTitle: workspace.activeGolog()?.title ?? null,
      };
    } catch (error) {
      console.error("Unable to load startup golog workspace", error);
      return {
        ok: false,
        url: config.url,
        error: error.message,
        fallbackActiveGologId: workspace.activeGologId,
      };
    }
  }

  creation = new StructuredCreationService({
    workspace,
    createGolog,
  });
  metaGologService = new MetaGologService({
    workspace,
    creation,
    canCreateCatalogEntries: () => !localSyncConfig || localSync?.status().authorityHost === true,
  });
  modeHead = new ModeHead({
    workspace,
    metaGologService,
    associateGologToObject,
    associateGologToSphere,
    defaultRuntimeMode: defaultRuntimeModeForDevice(),
  });

  workspace.bus.on("workspace:active-changed", ({ activeGologId }) => {
    if (!modeHead?.isMode(GOLOG_MODES.ASSOCIATION)) {
      modeHead?.syncModeForActiveGolog(activeGologId);
    }
    syncDocumentTitle(workspace.gologs.get(activeGologId) ?? null);
    setActiveScene(activeGologId);
  });
  workspace.bus.on("workspace:changed", (snapshot) => {
    if (!snapshot.activeGologId) {
      syncDocumentTitle(null);
    }
  });

  const firstGolog = createGolog({
    title: "Golog 1",
    activate: true,
  });
  metaGologService.install();

  const app = {
    workspace,
    client,
    creation,
    metaGologService,
    modeHead,
    createGolog,
    deleteGolog,
    createChildGologForObject,
    createChildGologForSphere,
    associateGologToObject,
    associateGologToSphere,
    startGologAssociation,
    openGolog,
    openMetaGolog,
    navigateBackGolog,
    navigateForwardGolog,
    createForceLayout,
    saveWorkspaceDocument,
    loadWorkspaceDocumentText,
    devReloadWithRestore,
    get activeGolog() {
      return workspace.activeGolog();
    },
    get bus() {
      return workspace.activeGolog()?.bus ?? firstGolog.bus;
    },
    get state() {
      return workspace.activeGolog()?.state ?? firstGolog.state;
    },
    get scene() {
      return (
        ensureGologScene(workspace.activeGolog()) ?? ensureGologScene(firstGolog)
      );
    },
    get localSync() {
      return localSync;
    },
  };
  if (localSyncConfig) {
    localSync = createLocalSyncClient({
      workspace,
      peerContext: localSyncConfig.peerContext,
      url: localSyncConfig.url,
      authorityHost: localSyncConfig.authorityHost,
      snapshotProvider: () => serializeWorkspace(workspace),
      applyWorkspaceSnapshot: (document, context) => {
        if (!document) {
          return null;
        }
        return loadAuthorityWorkspaceSnapshot(document, context);
      },
    });
  }
  liveForceLayout = createLiveForceLayoutService({
    workspace,
    modeHead,
    createForceLayout,
    origin: browserForceLayoutOrigin,
    peerProvider: () => localSync?.status?.().peers ?? [],
    localPeerProvider: () => localSync?.status?.().peer ?? localSyncConfig?.peerContext ?? null,
  });
  app.liveForceLayout = liveForceLayout;
  app.agentApi = createGologAgentApi(app);
  const startupConfig = startupConfigFromLocation(globalThis.location);
  app.startup = (developmentTools ? takeDevReloadSession() : Promise.resolve(null)).catch((error) => {
    console.warn("Unable to restore pending dev reload session", error);
    return null;
  }).then(async (devReloadSession) => {
    const result = devReloadSession
      ? {
          ok: true,
          skipped: true,
          reason: "dev reload restore pending",
        }
      : await loadStartupWorkspace(startupConfig);
    const devReloadRestore = devReloadSession
      ? restoreDevReloadSession(devReloadSession)
      : null;
    localSync?.publishWorkspaceSnapshot?.({ reason: "startup" });
    return devReloadRestore
      ? { ...result, devReloadRestore }
      : result;
  });

  bindStatusPanel({
    workspace,
    operationOrigin: currentHumanInterfaceOrigin,
    createGolog: createGologForUI,
    createChildGologForObject,
    createChildGologForSphere,
    startGologAssociation,
    modeHead,
    openGolog,
    openMetaGolog,
    navigateBackGolog,
    navigateForwardGolog,
    saveWorkspaceDocument,
    loadWorkspaceDocumentText,
    devReloadWithRestore,
    liveForceLayout: app.liveForceLayout,
    agentApi: app.agentApi,
    initialHostedWorkspaceId: startupConfig?.hostedWorkspaceId ?? null,
    serverWorkspaceSave: developmentTools && browserRuntimeConfig().serverWorkspaceSave,
    sharedWorkspaceLoad: browserRuntimeConfig().sharedWorkspaceLoad,
    serverWorkspaceCatalog: browserRuntimeConfig().serverWorkspaceCatalog,
    serverLatexCompile: browserRuntimeConfig().serverLatexCompile,
    documentRef,
  });

  return app;
}
