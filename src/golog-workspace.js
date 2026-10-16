import { MessageBus } from "./message-bus.js";
import { SharedDomainStore } from "./domain-state.js";
import { WorkspacePatchHistory } from "./workspace-patches.js";
import { structureDefinitionFor } from "./structure-definition-registry.js";

const MAX_NAVIGATION_HISTORY = 100;

function notifyGologObservers(workspace, gologId, observers) {
  const golog = workspace.gologs.get(gologId);
  if (!golog) throw new Error(`Golog does not exist: ${gologId}`);
  const pending = [...observers];
  const notify = (index = 0) => {
    for (let i = index; i < pending.length; i++) {
      const result = pending[i](golog);
      if (result?.then) return Promise.resolve(result).then(() => notify(i + 1));
    }
    return golog;
  };
  return notify();
}

export class GologWorkspace {
  constructor({
    createBus = () => new MessageBus(),
    createStore = (bus, context) => new SharedDomainStore(bus, context),
  } = {}) {
    this.createBus = createBus;
    this.createStore = createStore;
    this.bus = new MessageBus();
    this.gologs = new Map();
    this.activeGologId = null;
    this.navigationBackStack = [];
    this.navigationForwardStack = [];
    this.nextGologId = 1;
    this.gologCreationObservers = new Set();
    this.gologPublicationObservers = new Set();
    this.gologRetractionObservers = new Set();
    this.defaultGologIdFactories = new Set();
    this.metaGolog = {
      gologId: null,
      nodeByGologId: {},
      edgeByExpansionKey: {},
    };
    this.patchHistory = new WorkspacePatchHistory({ workspace: this });
  }

  createGolog({
    id = null,
    title = null,
    createdAt = null,
    structureId = null,
    schema = null,
  } = {}) {
    let resolvedId = id;
    if (resolvedId == null) {
      const sequence = this.nextGologId++;
      const suggestedId = `golog-${sequence}`;
      const factory = [...this.defaultGologIdFactories].at(-1)?.factory;
      resolvedId = factory?.({ suggestedId, sequence, workspace: this }) ?? suggestedId;
      if (typeof resolvedId !== "string" || !resolvedId) throw new Error("Default golog id factory must return a nonempty string");
    }
    if (this.gologs.has(resolvedId)) {
      throw new Error(`Golog already exists: ${resolvedId}`);
    }
    this.nextGologId = Math.max(this.nextGologId, nextGologIdAfter(resolvedId));
    const resolvedTitle = title ?? `Golog ${this.gologs.size + 1}`;
    const structureDefinition = structureDefinitionFor({
      structureId: structureId ?? (schema ? null : "hierarchical-theta-space"),
      schemaId: schema,
    });
    const structure = {
      id: structureDefinition.id,
      schema: structureDefinition.schema,
      interactionMode: structureDefinition.interactionMode ?? "ordinary",
    };
    const bus = this.createBus();
    const state = this.createStore(bus, {
      gologId: resolvedId,
      title: resolvedTitle,
      workspace: this,
      structure,
    });
    const golog = {
      id: resolvedId,
      title: resolvedTitle,
      bus,
      state,
      structure,
      createdAt: createdAt ?? Date.now(),
    };
    this.gologs.set(resolvedId, golog);
    // Install infrastructure on a new store before callers can submit domain
    // operations. User-facing bus notifications remain asynchronous.
    try {
      for (const observer of [...this.gologCreationObservers]) observer(golog);
    } catch (error) {
      this.gologs.delete(resolvedId);
      this.emitChanged();
      throw error;
    }
    this.bus.emit("workspace:golog-created", {
      golog,
      snapshot: this.snapshot(),
    });
    this.emitChanged();
    return golog;
  }

  observeGologCreation(observer) {
    if (typeof observer !== "function") throw new Error("Golog creation observer must be a function");
    this.gologCreationObservers.add(observer);
    return () => this.gologCreationObservers.delete(observer);
  }

  setDefaultGologIdFactory(factory) {
    if (typeof factory !== "function") throw new Error("Default golog id factory must be a function");
    const registration = { factory };
    this.defaultGologIdFactories.add(registration);
    return () => this.defaultGologIdFactories.delete(registration);
  }

  observeGologPublication(observer) {
    if (typeof observer !== "function") throw new Error("Golog publication observer must be a function");
    this.gologPublicationObservers.add(observer);
    return () => this.gologPublicationObservers.delete(observer);
  }

  publishGolog(gologId) {
    return notifyGologObservers(this, gologId, this.gologPublicationObservers);
  }

  observeGologRetraction(observer) {
    if (typeof observer !== "function") throw new Error("Golog retraction observer must be a function");
    this.gologRetractionObservers.add(observer);
    return () => this.gologRetractionObservers.delete(observer);
  }

  retractGolog(gologId) {
    return notifyGologObservers(this, gologId, this.gologRetractionObservers);
  }

  deleteGolog(id) {
    if (!this.gologs.has(id)) {
      return false;
    }
    const wasActive = this.activeGologId === id;
    const deleted = this.gologs.get(id);
    this.gologs.delete(id);
    this.navigationBackStack = this.navigationBackStack.filter(
      (gologId) => gologId !== id,
    );
    this.navigationForwardStack = this.navigationForwardStack.filter(
      (gologId) => gologId !== id,
    );
    if (this.metaGolog.gologId === id) {
      this.metaGolog.gologId = null;
    }
    delete this.metaGolog.nodeByGologId[id];

    if (wasActive) {
      this.activeGologId = null;
      const fallbackId = this.gologs.keys().next().value ?? null;
      if (fallbackId) {
        this.activateGolog(fallbackId, { recordNavigation: false });
      } else {
        const navigation = this.navigationState();
        this.bus.emit("workspace:active-changed", {
          activeGologId: null,
          previousGologId: id,
          golog: null,
          navigation,
          snapshot: this.snapshot(),
        });
        this.emitNavigationChanged(navigation);
      }
    }
    this.bus.emit("workspace:golog-deleted", {
      gologId: id,
      title: deleted?.title ?? null,
      snapshot: this.snapshot(),
    });
    this.emitNavigationChanged();
    this.emitChanged();
    return true;
  }

  clear() {
    this.gologs.clear();
    this.activeGologId = null;
    this.navigationBackStack = [];
    this.navigationForwardStack = [];
    this.nextGologId = 1;
    this.metaGolog = {
      gologId: null,
      nodeByGologId: {},
      edgeByExpansionKey: {},
    };
    this.patchHistory.clear();
    this.emitNavigationChanged();
    this.emitChanged();
  }

  activateGolog(id, { recordNavigation = true } = {}) {
    if (!this.gologs.has(id) || this.activeGologId === id) {
      return this.activeGolog();
    }

    const previousGologId = this.activeGologId;
    if (recordNavigation && previousGologId) {
      this.navigationBackStack.push(previousGologId);
      if (this.navigationBackStack.length > MAX_NAVIGATION_HISTORY) {
        this.navigationBackStack.shift();
      }
      this.navigationForwardStack = [];
    }

    this.activeGologId = id;
    const golog = this.activeGolog();
    const navigation = this.navigationState();
    this.bus.emit("workspace:active-changed", {
      activeGologId: id,
      previousGologId,
      golog,
      navigation,
      snapshot: this.snapshot(),
    });
    this.emitNavigationChanged(navigation);
    this.emitChanged();
    return golog;
  }

  canNavigateBack() {
    return this.navigationBackStack.some((gologId) => this.gologs.has(gologId));
  }

  canNavigateForward() {
    return this.navigationForwardStack.some((gologId) =>
      this.gologs.has(gologId),
    );
  }

  navigateBack() {
    return this.navigateStack({
      sourceStack: this.navigationBackStack,
      destinationStack: this.navigationForwardStack,
    });
  }

  navigateForward() {
    return this.navigateStack({
      sourceStack: this.navigationForwardStack,
      destinationStack: this.navigationBackStack,
    });
  }

  navigateStack({ sourceStack, destinationStack }) {
    if (!this.activeGologId) {
      return null;
    }

    let targetGologId = null;
    while (sourceStack.length > 0 && !targetGologId) {
      const candidate = sourceStack.pop();
      if (candidate && this.gologs.has(candidate)) {
        targetGologId = candidate;
      }
    }
    if (!targetGologId) {
      this.emitNavigationChanged();
      return this.activeGolog();
    }

    destinationStack.push(this.activeGologId);
    if (destinationStack.length > MAX_NAVIGATION_HISTORY) {
      destinationStack.shift();
    }
    return this.activateGolog(targetGologId, { recordNavigation: false });
  }

  navigationState() {
    const previousGologId = this.lastExistingGologId(this.navigationBackStack);
    const nextGologId = this.lastExistingGologId(this.navigationForwardStack);
    return {
      canGoBack: Boolean(previousGologId),
      canGoForward: Boolean(nextGologId),
      previousGologId,
      previousGologTitle: previousGologId
        ? this.gologs.get(previousGologId)?.title ?? null
        : null,
      nextGologId,
      nextGologTitle: nextGologId
        ? this.gologs.get(nextGologId)?.title ?? null
        : null,
      backCount: this.navigationBackStack.filter((gologId) =>
        this.gologs.has(gologId),
      ).length,
      forwardCount: this.navigationForwardStack.filter((gologId) =>
        this.gologs.has(gologId),
      ).length,
    };
  }

  lastExistingGologId(stack) {
    for (let index = stack.length - 1; index >= 0; index -= 1) {
      const gologId = stack[index];
      if (this.gologs.has(gologId)) {
        return gologId;
      }
    }
    return null;
  }

  activeGolog() {
    return this.gologs.get(this.activeGologId) ?? null;
  }

  listGologsFor(requesterId = null) {
    return [...this.gologs.values()].map((golog) => ({
      id: golog.id,
      title: golog.title,
      isActive: golog.id === this.activeGologId,
      isSelf: golog.id === requesterId,
      sphereCount: golog.state.spheres.size,
      edgeCount: golog.state.edges.size,
      surfaceCount: golog.state.surfaces.size,
      volumeCount: golog.state.volumes.size,
      objectCount: golog.state.objects.size,
      structure: { ...golog.structure },
    }));
  }

  getGologData(id, { requesterId = null } = {}) {
    const golog = this.gologs.get(id);
    if (!golog) {
      return null;
    }

    return {
      id: golog.id,
      title: golog.title,
      isActive: golog.id === this.activeGologId,
      isSelf: golog.id === requesterId,
      state: golog.state.snapshot(),
    };
  }

  snapshot() {
    return {
      activeGologId: this.activeGologId,
      gologCount: this.gologs.size,
      gologs: this.listGologsFor(null),
      navigation: this.navigationState(),
    };
  }

  emitNavigationChanged(navigation = this.navigationState()) {
    this.bus.emit("workspace:navigation-changed", navigation);
  }

  emitChanged() {
    this.bus.emit("workspace:changed", this.snapshot());
  }
}

function nextGologIdAfter(id) {
  const match = String(id).match(/^golog-(\d+)$/);
  return match ? Number(match[1]) + 1 : 1;
}
