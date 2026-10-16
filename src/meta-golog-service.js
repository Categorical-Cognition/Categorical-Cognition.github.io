const META_GOLOG_ID = "meta-golog";
const META_GOLOG_TITLE = "Meta Golog";
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

function emptyMetaState() {
  return {
    gologId: null,
    nodeByGologId: {},
    edgeByExpansionKey: {},
  };
}

export function normalizeMetaGologState(value) {
  const state = emptyMetaState();
  if (!value || typeof value !== "object") {
    return state;
  }
  state.gologId = value.gologId ? String(value.gologId) : null;
  for (const [gologId, nodeId] of Object.entries(value.nodeByGologId ?? {})) {
    if (gologId && nodeId) {
      state.nodeByGologId[String(gologId)] = String(nodeId);
    }
  }
  for (const [key, edgeId] of Object.entries(value.edgeByExpansionKey ?? {})) {
    if (key && edgeId) {
      state.edgeByExpansionKey[String(key)] = String(edgeId);
    }
  }
  return state;
}

export function cloneMetaGologState(value) {
  return normalizeMetaGologState(value);
}

function expansionKey(parentGologId, objectId, childGologId) {
  return `${parentGologId}:${objectId}->${childGologId}`;
}

function metaNodePosition(index) {
  if (index === 0) {
    return [0, 0, 0];
  }
  const radius = 3 + Math.sqrt(index) * 2.4;
  const angle = index * GOLDEN_ANGLE;
  return [Math.cos(angle) * radius, Math.sin(angle) * radius, 0];
}

function expansionName(parentGolog, sphere, childGolog) {
  const parentTitle = parentGolog.title || parentGolog.id;
  const childTitle = childGolog.title || childGolog.id;
  const nodeName = String(sphere?.name ?? "").trim();
  return nodeName
    ? `${parentTitle} ${nodeName} -> ${childTitle}`
    : `${parentTitle} -> ${childTitle}`;
}

function expansionText(parentGolog, sphere, childGolog) {
  const parentTitle = parentGolog.title || parentGolog.id;
  const childTitle = childGolog.title || childGolog.id;
  const nodeName = String(sphere?.name ?? sphere?.id ?? "").trim();
  return nodeName
    ? `${parentTitle} has object ${nodeName}, whose nested-golog payload expands to ${childTitle}.`
    : `${parentTitle} has an object whose nested-golog payload expands to ${childTitle}.`;
}

export class MetaGologService {
  constructor({ workspace, creation, canCreateCatalogEntries = () => true }) {
    this.workspace = workspace;
    this.creation = creation;
    this.canCreateCatalogEntries = canCreateCatalogEntries;
    this.releaseWorkspaceListener = null;
    this.releaseAuthorityListener = null;
    this.gologListeners = new Map();
    this.suspendCount = 0;
    this.installed = false;
  }

  install() {
    if (this.installed) {
      return () => this.dispose();
    }
    this.installed = true;
    this.releaseWorkspaceListener = this.workspace.bus.on(
      "workspace:golog-created",
      ({ golog }) => this.handleGologCreated(golog),
    );
    this.releaseAuthorityListener = this.workspace.bus.on("workspace:catalog-authority-changed", () => this.reconcile());
    this.reconcile();
    return () => this.dispose();
  }

  dispose() {
    this.releaseWorkspaceListener?.();
    this.releaseWorkspaceListener = null;
    this.releaseAuthorityListener?.();
    this.releaseAuthorityListener = null;
    for (const listener of this.gologListeners.values()) {
      listener.release();
    }
    this.gologListeners.clear();
    this.installed = false;
  }

  suspend(callback) {
    this.suspendCount += 1;
    try {
      return callback();
    } finally {
      this.suspendCount -= 1;
    }
  }

  metadata() {
    if (!this.workspace.metaGolog || typeof this.workspace.metaGolog !== "object") {
      this.workspace.metaGolog = emptyMetaState();
    }
    const metadata = this.workspace.metaGolog;
    metadata.gologId = metadata.gologId ? String(metadata.gologId) : null;
    if (!metadata.nodeByGologId || typeof metadata.nodeByGologId !== "object") {
      metadata.nodeByGologId = {};
    }
    if (
      !metadata.edgeByExpansionKey ||
      typeof metadata.edgeByExpansionKey !== "object"
    ) {
      metadata.edgeByExpansionKey = {};
    }
    return metadata;
  }

  ensureMetaGolog() {
    const metadata = this.metadata();
    let meta = metadata.gologId
      ? this.workspace.gologs.get(metadata.gologId)
      : null;
    if (!meta) {
      meta =
        this.workspace.gologs.get(META_GOLOG_ID) ??
        [...this.workspace.gologs.values()].find(
          (golog) => golog.title === META_GOLOG_TITLE,
        ) ??
        this.creation.createGologRecord({
          id: META_GOLOG_ID,
          title: META_GOLOG_TITLE,
          activate: false,
        });
      metadata.gologId = meta.id;
    }
    return meta;
  }

  openMetaGolog() {
    const meta = this.ensureMetaGolog();
    this.workspace.activateGolog(meta.id);
    return meta;
  }

  reconcile() {
    if (this.suspendCount > 0) {
      return;
    }

    const meta = this.ensureMetaGolog();
    this.pruneGologListeners();
    for (const golog of this.workspace.gologs.values()) {
      this.listenToGolog(golog);
      this.ensureGologNode(golog);
    }
    for (const golog of this.workspace.gologs.values()) {
      if (golog.id !== meta.id) {
        this.syncExpansionEdgesForGolog(golog);
      }
    }
  }

  handleGologCreated(golog) {
    if (this.suspendCount > 0 || !golog || this.workspace.gologs.get(golog.id) !== golog) {
      return;
    }
    this.listenToGolog(golog);
    this.ensureGologNode(golog);
    this.syncExpansionEdgesForGolog(golog);
  }

  listenToGolog(golog) {
    if (!golog) {
      return;
    }
    const existing = this.gologListeners.get(golog.id);
    if (existing?.bus === golog.bus) {
      return;
    }
    existing?.release();

    const releaseChildListener = golog.bus.on(
      "sphere:child-golog-attached",
      (payload) => this.handleChildGologAttached(payload),
    );
    const releaseMetaNodeListener = golog.bus.on(
      "render:sphere-created",
      ({ id }) => this.handleMaybeMetaNodeCreated(golog, id),
    );
    this.gologListeners.set(golog.id, {
      bus: golog.bus,
      release: () => {
        releaseChildListener();
        releaseMetaNodeListener();
      },
    });
  }

  pruneGologListeners() {
    for (const [gologId, listener] of this.gologListeners.entries()) {
      const current = this.workspace.gologs.get(gologId);
      if (current?.bus === listener.bus) {
        continue;
      }
      listener.release();
      this.gologListeners.delete(gologId);
    }
  }

  handleChildGologAttached({ parentGologId, id, childGologId }) {
    if (this.suspendCount > 0 || !parentGologId || !id || !childGologId) {
      return;
    }
    const meta = this.ensureMetaGolog();
    if (parentGologId === meta.id) {
      return;
    }
    const parentGolog = this.workspace.gologs.get(parentGologId);
    const childGolog = this.workspace.gologs.get(childGologId);
    if (!parentGolog || !childGolog) {
      return;
    }
    this.ensureGologNode(parentGolog);
    this.ensureGologNode(childGolog);
    this.ensureExpansionEdge({
      parentGolog,
      objectId: id,
      childGolog,
    });
  }

  handleMaybeMetaNodeCreated(golog, sphereId) {
    if (this.suspendCount > 0 || !golog || !sphereId || !this.canCreateCatalogEntries()) {
      return;
    }
    const meta = this.ensureMetaGolog();
    if (golog.id !== meta.id) {
      return;
    }

    const sphere = meta.state.spheres.get(sphereId);
    if (!sphere || meta.state.getPayload(sphereId)) {
      return;
    }

    const child = this.creation.createGologRecord({
      title: null,
      activate: false,
    });
    this.metadata().nodeByGologId[child.id] = sphereId;
    meta.state.operationPipeline.submit(
      "simplex:rename",
      { id: sphereId, name: child.title },
      { origin: { source: "meta-golog-service", role: "system" } },
    );
    meta.state.operationPipeline.submit(
      "payload:golog-attach",
      { id: sphereId, targetGologId: child.id },
      { origin: { source: "meta-golog-service", role: "system" } },
    );
    this.listenToGolog(child);
  }

  ensureGologNode(golog) {
    const meta = this.ensureMetaGolog();
    const metadata = this.metadata();
    const existingId = metadata.nodeByGologId[golog.id];
    if (this.metaNodeRepresentsGolog(meta, existingId, golog.id)) {
      return meta.state.spheres.get(existingId);
    }

    const foundId = this.findMetaNodeForGolog(meta, golog.id);
    if (foundId) {
      metadata.nodeByGologId[golog.id] = foundId;
      return meta.state.spheres.get(foundId);
    }
    if (!this.canCreateCatalogEntries()) return null;

    const index = Object.keys(metadata.nodeByGologId).length;
    const created = this.creation.createNode({
      gologId: meta.id,
      position: metaNodePosition(index),
      name: golog.title,
      payload: {
        type: "nested-golog",
        targetGologId: golog.id,
      },
    });
    metadata.nodeByGologId[golog.id] = created.id;
    return created.sphere;
  }

  metaNodeRepresentsGolog(meta, nodeId, gologId) {
    if (!nodeId || !meta.state.spheres.has(nodeId)) {
      return false;
    }
    const payload = meta.state.getPayload(nodeId);
    return payload?.type === "nested-golog" && payload.targetGologId === gologId;
  }

  findMetaNodeForGolog(meta, gologId) {
    for (const sphere of meta.state.spheres.values()) {
      if (this.metaNodeRepresentsGolog(meta, sphere.id, gologId)) {
        return sphere.id;
      }
    }
    return null;
  }

  gologIdForMetaNode(nodeId) {
    if (!nodeId) {
      return null;
    }
    const metadata = this.metadata();
    for (const [gologId, mappedNodeId] of Object.entries(
      metadata.nodeByGologId,
    )) {
      if (mappedNodeId === nodeId) {
        return gologId;
      }
    }

    const meta = this.ensureMetaGolog();
    const payload = meta.state.getPayload(nodeId);
    return payload?.type === "nested-golog" ? payload.targetGologId : null;
  }

  syncExpansionEdgesForGolog(parentGolog) {
    if (!parentGolog) {
      return;
    }
    const meta = this.ensureMetaGolog();
    if (parentGolog.id === meta.id) {
      return;
    }

    for (const object of parentGolog.state.objects.values()) {
      const payload = parentGolog.state.getPayloadByType(object.id, "nested-golog");
      if (payload?.type !== "nested-golog") {
        continue;
      }
      const childGolog = this.workspace.gologs.get(payload.targetGologId);
      if (!childGolog) {
        continue;
      }
      this.ensureExpansionEdge({
        parentGolog,
        objectId: object.id,
        childGolog,
      });
    }
  }

  ensureExpansionEdge({ parentGolog, objectId, childGolog }) {
    const meta = this.ensureMetaGolog();
    const metadata = this.metadata();
    const source = this.ensureGologNode(parentGolog);
    const target = this.ensureGologNode(childGolog);
    if (!source || !target || source.id === target.id) {
      return null;
    }

    const key = expansionKey(parentGolog.id, objectId, childGolog.id);
    const existingId = metadata.edgeByExpansionKey[key];
    if (existingId && meta.state.edges.has(existingId)) {
      return meta.state.edges.get(existingId);
    }
    if (!this.canCreateCatalogEntries()) return null;

    const sphere = parentGolog.state.getObject(objectId);
    const created = this.creation.createEdge({
      gologId: meta.id,
      sourceId: source.id,
      targetId: target.id,
      name: expansionName(parentGolog, sphere, childGolog),
      payload: {
        type: "text/markdown",
        text: expansionText(parentGolog, sphere, childGolog),
      },
    });
    metadata.edgeByExpansionKey[key] = created.id;
    return created.edge;
  }

  ensureExpansionEdgeForAttachment({
    parentGologId,
    objectId,
    childGologId,
  }) {
    const parentGolog = this.workspace.gologs.get(parentGologId);
    const childGolog = this.workspace.gologs.get(childGologId);
    if (!parentGolog || !childGolog || !objectId) {
      return null;
    }
    return this.ensureExpansionEdge({
      parentGolog,
      objectId,
      childGolog,
    });
  }
}
