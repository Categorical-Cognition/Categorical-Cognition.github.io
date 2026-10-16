import { VIRTUAL_DOUBLE_ELEMENT_KINDS } from "./virtual-double-category-schema.js";

export const GOLOG_MODES = Object.freeze({
  ORDINARY: "ordinary",
  IPHONE: "iphone",
  VIRTUAL_DOUBLE: "virtual-double",
  META: "meta",
  ASSOCIATION: "association",
});

const ORDINARY_PRESENTATION = {
  mode: GOLOG_MODES.ORDINARY,
  cssVars: {},
  renderScale: {},
};

const VIRTUAL_DOUBLE_PRESENTATION = {
  mode: GOLOG_MODES.VIRTUAL_DOUBLE,
  cssVars: {},
  renderScale: {},
};

const IPHONE_PRESENTATION = {
  mode: GOLOG_MODES.IPHONE,
  cssVars: {
    "--mode-inspector-padding-x": "12px", "--mode-inspector-padding-y": "10px",
    "--mode-ui-font-size": "12.5px", "--mode-readout-gap": "8px",
    "--mode-readout-label-size": "10.5px", "--mode-readout-value-size": "14px",
    "--mode-interaction-gap": "6px", "--mode-control-min-height": "36px",
    "--mode-control-padding-x": "8px", "--mode-tab-gap": "5px",
    "--mode-tab-height": "28px", "--mode-tab-padding-x": "6px",
    "--mode-tab-font-size": "12.5px", "--mode-tab-max-width": "50vw",
  },
  renderScale: {
    sphere: { radius: 1 },
    edge: { thickness: 1.45 },
    edgeHandle: { radius: 2.45, height: 2.2, pickRadius: 2.45 },
    surfaceControl: { radius: 2.15, pickRadius: 1.95 },
  },
};

const MODE_PROFILES = {
  [GOLOG_MODES.ORDINARY]: {
    ordinaryLike: true,
    presentation: ORDINARY_PRESENTATION,
    panels: { shortcuts: true, debug: true, forceControls: true },
    input: { touchGestures: false, doubleClick: "label-edit", labelEditRequest: "direct", emptySpaceDrag: "current", keyboardViewport: "resize", deleteEdgeFromKeyboard: true },
    force: { live: true },
  },
  [GOLOG_MODES.IPHONE]: {
    ordinaryLike: true,
    presentation: IPHONE_PRESENTATION,
    panels: { shortcuts: false, debug: false, forceControls: false },
    input: { touchGestures: true, touchGestureModeCycle: true, doubleClick: "creation", labelEditRequest: "dom-event", emptySpaceDrag: "orbit", keyboardViewport: "overlay", deleteEdgeFromKeyboard: false },
    force: { live: true },
  },
  [GOLOG_MODES.VIRTUAL_DOUBLE]: {
    ordinaryLike: true,
    presentation: VIRTUAL_DOUBLE_PRESENTATION,
    panels: { shortcuts: true, debug: true, forceControls: false },
    input: {
      touchGestures: false,
      doubleClick: "label-edit",
      labelEditRequest: "direct",
      emptySpaceDrag: "current",
      keyboardViewport: "resize",
      deleteEdgeFromKeyboard: true,
      creationGrammar: "virtual-double",
    },
    force: { live: false },
  },
  [GOLOG_MODES.META]: {
    ordinaryLike: false,
    presentation: ORDINARY_PRESENTATION,
    panels: { shortcuts: true, debug: true, forceControls: true },
    input: { doubleClick: "none", emptySpaceDrag: "current" },
    force: { live: false },
  },
  [GOLOG_MODES.ASSOCIATION]: {
    ordinaryLike: false,
    presentation: ORDINARY_PRESENTATION,
    panels: { shortcuts: true, debug: true, forceControls: false },
    input: { doubleClick: "none", emptySpaceDrag: "current" },
    force: { live: false },
  },
};

function clonePlain(value) {
  return JSON.parse(JSON.stringify(value ?? {}));
}

function cleanContext(context = {}) {
  return Object.fromEntries(
    Object.entries(context).filter(([, value]) => value !== undefined),
  );
}

function profileFor(name) {
  return MODE_PROFILES[name] ?? MODE_PROFILES[GOLOG_MODES.ORDINARY];
}

export class ModeHead {
  constructor({
    workspace,
    metaGologService,
    associateGologToObject,
    associateGologToSphere,
    defaultRuntimeMode = GOLOG_MODES.ORDINARY,
  }) {
    this.workspace = workspace;
    this.metaGologService = metaGologService;
    this.associateGologToObject = associateGologToObject ?? (({
      parentGologId, objectId, targetGologId,
    }) => associateGologToSphere({ parentGologId, sphereId: objectId, targetGologId }));
    this.associateGologToSphere = associateGologToSphere;
    this.pendingAssociation = null;
    this.defaultRuntimeMode = defaultRuntimeMode;
    this.current = {
      name: this.defaultRuntimeMode,
      context: {},
    };
  }

  snapshot() {
    return {
      name: this.current.name,
      context: { ...this.current.context },
      presentation: this.presentationSnapshot(),
      panels: clonePlain(this.deviceProfile().panels),
      input: clonePlain(this.deviceProfile().input),
      force: clonePlain(this.semanticProfile().force),
    };
  }

  presentationMode() {
    return this.defaultRuntimeMode === GOLOG_MODES.IPHONE
      ? GOLOG_MODES.IPHONE
      : this.current.name;
  }

  presentationSnapshot(mode = this.presentationMode()) {
    return clonePlain(profileFor(mode).presentation);
  }

  semanticProfile() { return profileFor(this.current.name); }
  deviceProfile() { return profileFor(this.presentationMode()); }

  defaultModeForGolog(gologId) {
    const metaId = this.metaGologService.metadata().gologId;
    const structureMode = this.workspace.gologs.get(gologId)?.structure
      ?.interactionMode;
    if (structureMode === GOLOG_MODES.VIRTUAL_DOUBLE) {
      return GOLOG_MODES.VIRTUAL_DOUBLE;
    }
    if (this.defaultRuntimeMode === GOLOG_MODES.IPHONE) {
      return GOLOG_MODES.IPHONE;
    }
    return gologId && gologId === metaId ? GOLOG_MODES.META : this.defaultRuntimeMode;
  }

  runtimeMode(name) {
    const requested = name ?? this.defaultRuntimeMode;
    if (
      this.defaultRuntimeMode === GOLOG_MODES.IPHONE &&
      requested === GOLOG_MODES.ORDINARY
    ) {
      return GOLOG_MODES.IPHONE;
    }
    return requested;
  }

  setMode(name, context = {}) {
    const next = {
      name: this.runtimeMode(name),
      context: cleanContext(context),
    };
    if (
      this.current.name === next.name &&
      JSON.stringify(this.current.context) === JSON.stringify(next.context)
    ) {
      return this.snapshot();
    }
    this.current = next;
    this.workspace.bus.emit("mode:changed", this.snapshot());
    return this.snapshot();
  }

  syncModeForActiveGolog(gologId = this.workspace.activeGologId) {
    return this.setMode(this.defaultModeForGolog(gologId));
  }

  openGolog(gologId, { mode = null, context = {} } = {}) {
    const golog = this.workspace.activateGolog(gologId);
    if (!golog) {
      return null;
    }
    this.setMode(mode ?? this.defaultModeForGolog(golog.id), context);
    return golog;
  }

  openMetaGolog({ mode = null, context = {} } = {}) {
    const meta = this.metaGologService.ensureMetaGolog();
    return this.openGolog(meta.id, { mode, context });
  }

  startAssociation({ sourceGologId, sourceObjectId }) {
    if (!sourceGologId || !sourceObjectId) {
      return null;
    }
    return this.openMetaGolog({
      mode: GOLOG_MODES.ASSOCIATION,
      context: { sourceGologId, sourceObjectId },
    });
  }

  isMode(...names) { return names.includes(this.current.name); }
  isOrdinaryLike() { return Boolean(this.semanticProfile().ordinaryLike); }
  canRunForces() { return Boolean(this.semanticProfile().force?.live); }
  shouldShowPanel(name) { return this.deviceProfile().panels?.[name] !== false; }
  shouldShowForceControls() { return this.shouldShowPanel("forceControls"); }
  usesTouchGestures() { return Boolean(this.deviceProfile().input?.touchGestures); }

  supportsTouchDragCreationToggle() {
    return this.supportsIphoneGestureModeCycle();
  }

  supportsIphoneGestureModeCycle() {
    return Boolean(
      this.deviceProfile().input?.touchGestureModeCycle ??
        this.deviceProfile().input?.touchDragCreationToggle,
    );
  }

  usesKeyboardOverlay() {
    return this.deviceProfile().input?.keyboardViewport === "overlay";
  }

  shouldDispatchLabelEditThroughDom() {
    return this.deviceProfile().input?.labelEditRequest === "dom-event";
  }

  shouldEditLabelOnDoubleClick() {
    return this.deviceProfile().input?.doubleClick === "label-edit";
  }

  emptySpaceDragMode(currentMode) {
    const mode = this.deviceProfile().input?.emptySpaceDrag;
    return mode && mode !== "current" ? mode : currentMode;
  }

  canDeleteEdgeFromKeyboard() {
    return Boolean(this.deviceProfile().input?.deleteEdgeFromKeyboard);
  }

  canCreateNode(gologId) {
    if (this.isMode(GOLOG_MODES.ASSOCIATION)) {
      return false;
    }
    return this.isOrdinaryLike() || this.isMetaGolog(gologId);
  }

  canCreateEdge() {
    return this.isOrdinaryLike() && !this.isMetaGolog(this.workspace.activeGologId);
  }

  canCreateSurface() {
    return this.isOrdinaryLike() && !this.isMetaGolog(this.workspace.activeGologId);
  }

  canRename(gologId) { return this.isOrdinaryLike() && !this.isMetaGolog(gologId); }

  canAttachPayload(gologId) { return this.canRename(gologId); }

  canEditPayload(gologId) { return this.canRename(gologId); }

  canDeleteObject(gologId) { return this.canRename(gologId); }

  canDragObject() { return !this.isMode(GOLOG_MODES.ASSOCIATION); }

  canEditLabels(gologId) { return this.canRename(gologId); }

  canInspectNestedGolog() { return !this.isMode(GOLOG_MODES.ASSOCIATION); }

  usesVirtualDoubleCreation() {
    return this.semanticProfile().input?.creationGrammar === "virtual-double";
  }

  virtualArrowKind() {
    const requested = this.current.context.virtualArrowKind;
    return requested === VIRTUAL_DOUBLE_ELEMENT_KINDS.TIGHT_ARROW
      ? VIRTUAL_DOUBLE_ELEMENT_KINDS.TIGHT_ARROW
      : VIRTUAL_DOUBLE_ELEMENT_KINDS.PROARROW;
  }

  setVirtualArrowKind(elementKind) {
    if (!this.usesVirtualDoubleCreation()) {
      return this.snapshot();
    }
    const virtualArrowKind =
      elementKind === VIRTUAL_DOUBLE_ELEMENT_KINDS.TIGHT_ARROW
        ? VIRTUAL_DOUBLE_ELEMENT_KINDS.TIGHT_ARROW
        : VIRTUAL_DOUBLE_ELEMENT_KINDS.PROARROW;
    return this.setMode(this.current.name, {
      ...this.current.context,
      virtualArrowKind,
    });
  }

  nodeElementKind() {
    return this.usesVirtualDoubleCreation()
      ? VIRTUAL_DOUBLE_ELEMENT_KINDS.OBJECT
      : "0-simplex";
  }

  edgeElementKind({ tight = false } = {}) {
    if (!this.usesVirtualDoubleCreation()) {
      return "1-simplex";
    }
    return tight
      ? VIRTUAL_DOUBLE_ELEMENT_KINDS.TIGHT_ARROW
      : this.virtualArrowKind();
  }

  isMetaGolog(gologId) {
    return Boolean(gologId && gologId === this.metaGologService.metadata().gologId);
  }

  handleSelectableClick({ gologId, selectable }) {
    if (!this.isMode(GOLOG_MODES.ASSOCIATION)) {
      return false;
    }
    if (!this.isMetaGolog(gologId)) {
      return true;
    }
    if (selectable?.kind !== "sphere") {
      return true;
    }
    if (this.pendingAssociation) return true;

    const targetGologId = this.metaGologService.gologIdForMetaNode(
      selectable.id,
    );
    const { sourceGologId, sourceObjectId } = this.current.context;
    if (!targetGologId || !sourceGologId || !sourceObjectId) {
      this.syncModeForActiveGolog();
      return true;
    }

    const finish = (attached) => {
      if (attached === null || attached === false) return;
      this.metaGologService.ensureExpansionEdgeForAttachment({
        parentGologId: sourceGologId,
        objectId: sourceObjectId,
        childGologId: targetGologId,
      });
      if (this.isMode(GOLOG_MODES.ASSOCIATION) &&
        this.current.context.sourceGologId === sourceGologId &&
        this.current.context.sourceObjectId === sourceObjectId) {
        this.syncModeForActiveGolog();
      }
    };
    const fail = (error) => {
      this.workspace.bus.emit("expansion:failed", {
        message: error.message,
        gologId: sourceGologId,
        objectId: sourceObjectId,
      });
    };
    try {
      const attached = this.associateGologToObject({
        parentGologId: sourceGologId,
        objectId: sourceObjectId,
        targetGologId,
      });
      if (attached?.then) {
        this.pendingAssociation = attached.then(finish).catch(fail).finally(() => {
          this.pendingAssociation = null;
        });
      } else {
        finish(attached);
      }
    } catch (error) {
      fail(error);
    }
    return true;
  }
}
