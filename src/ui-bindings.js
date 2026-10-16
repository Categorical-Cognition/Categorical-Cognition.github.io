import { NestedGologPanelRenderer } from "./nested-golog-renderer.js";
import {
  codeLanguageFromType,
  codePayloadType,
  imagePayloadType,
  payloadAttachmentKey,
  payloadKind,
  PAYLOAD_TYPES,
} from "./payload-types.js";
import { buildPayloadRenderManifest } from "./payload-render-manifest.js";
import {
  sceneExpansionPayloadChoices,
  scenePresentablePayloadChoices,
  scenePresentationForPayload,
} from "./payload-scene-presenters.js";
import { HOSTED_WORKSPACE_CATALOG_PATH } from "./hosted-workspaces.js";
import { VIRTUAL_DOUBLE_ELEMENT_KINDS } from "./virtual-double-category-schema.js";
import { bindThetaVolumePanel } from "./theta-volume-panel.js";
import { appendPdfPreview, safePayloadPreviewUrl } from "./payload-preview.js";
import { STATIC_LATEX_COMPILE_MESSAGE } from "./runtime-config.js";

const PANEL_COLLAPSE_STORAGE_KEY = "jsgolog.ui.collapsedPanels.v1";
const LATEX_COMPILE_ENDPOINT = "/__golog/latex/compile";
const IPHONE_GESTURE_MODE_COPY = {
  inspect: {
    text: "I",
    label: "Inspect mode",
    title: "Inspect: drag orbits, pinch zooms the center point",
  },
  travel: {
    text: "T",
    label: "Travel mode",
    title: "Travel: pinch moves forward and back",
  },
  create: {
    text: "+",
    label: "Create mode",
    title: "Create: drag chains objects into shapes",
  },
};

function formatVector(vector) {
  return [vector.x, vector.y, vector.z]
    .map((component) => component.toFixed(1))
    .join(", ");
}

function labelAnchorForObject(object) {
  return (
    object?.label?.anchor ??
    object?.origin ??
    object?.position ??
    object?.controlPoint ??
    object?.midpoint ??
    null
  );
}

function titleForSelectedObject(object) {
  if (!object) {
    return "Object";
  }
  if (object.dimension === 0) {
    if (object.elementKind === VIRTUAL_DOUBLE_ELEMENT_KINDS.OBJECT) {
      return "Object";
    }
    return "Node";
  }
  if (object.dimension === 1) {
    if (object.elementKind === VIRTUAL_DOUBLE_ELEMENT_KINDS.PROARROW) {
      return "Proarrow";
    }
    if (object.elementKind === VIRTUAL_DOUBLE_ELEMENT_KINDS.TIGHT_ARROW) {
      return "Tight Arrow";
    }
    return "Edge";
  }
  if (object.elementKind === VIRTUAL_DOUBLE_ELEMENT_KINDS.CELL) {
    return "Virtual Cell";
  }
  if (object.dimension === 2 && object.type === "two-simplex") {
    return "2-Simplex";
  }
  if (object.dimension === 2) {
    return "2-Cell";
  }
  if (object.kind === "volume") return "Region";
  return object.kind ?? "Object";
}

function formatObjectAnchor(object) {
  const anchor = labelAnchorForObject(object);
  return anchor ? formatVector(anchor) : "unknown";
}

function openablePayloadUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return "";
  }
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw);
  const isRelative = raw.startsWith("/") || raw.startsWith("./") || raw.startsWith("../");
  const candidate = hasScheme || isRelative ? raw : `https://${raw}`;
  try {
    const url = new URL(candidate, globalThis.location?.href ?? "http://localhost/");
    if (["http:", "https:", "mailto:", "tel:"].includes(url.protocol)) {
      return url.href;
    }
    if (
      url.protocol === "data:" &&
      (/^data:image\//i.test(raw) || /^data:application\/pdf/i.test(raw))
    ) {
      return raw;
    }
    return "";
  } catch {
    return "";
  }
}

export function bindStatusPanel({
  workspace,
  operationOrigin,
  createGolog,
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
  liveForceLayout,
  agentApi = null,
  initialHostedWorkspaceId = null,
  serverWorkspaceSave = true,
  sharedWorkspaceLoad = false,
  serverWorkspaceCatalog = true,
  serverLatexCompile = true,
  documentRef,
}) {
  const gologTabs = documentRef.querySelector("#golog-tabs");
  bindThetaVolumePanel({ workspace, modeHead, documentRef, operationOrigin });
  const gologTabbar = documentRef.querySelector("#golog-tabbar");
  const iphoneTabsToggle = documentRef.querySelector("#iphone-tabs-toggle");
  const iphoneTabSwitcher = documentRef.querySelector("#iphone-tab-switcher");
  const iphoneTabList = documentRef.querySelector("#iphone-tab-list");
  const iphoneTabsClose = documentRef.querySelector("#iphone-tabs-close");
  const gologNavBack = documentRef.querySelector("#golog-nav-back");
  const gologNavForward = documentRef.querySelector("#golog-nav-forward");
  const openMetaGologButton = documentRef.querySelector("#open-meta-golog");
  const createGologButton = documentRef.querySelector("#create-golog");
  const newGologStructure = documentRef.querySelector("#new-golog-structure");
  const virtualDoubleTools = documentRef.querySelector("#virtual-double-tools");
  const virtualArrowButtons = [
    ...documentRef.querySelectorAll("[data-virtual-arrow-kind]"),
  ];
  const virtualCellCapture = documentRef.querySelector("#virtual-cell-capture");
  const toggleUiPanelsButton = documentRef.querySelector("#toggle-ui-panels");
  const iphoneDragModeToggle = documentRef.querySelector(
    "#iphone-drag-mode-toggle",
  );
  const shortcutHintsCollapse = documentRef.querySelector(
    "#shortcut-hints-collapse",
  );
  const statusPanel = documentRef.querySelector("#status-panel");
  const statusPanelCollapse = documentRef.querySelector("#status-panel-collapse");
  const iphoneSelectionPaneExpand = documentRef.querySelector(
    "#iphone-selection-pane-expand",
  );
  const iphoneSelectionPaneCollapse = documentRef.querySelector(
    "#iphone-selection-pane-collapse",
  );
  const debugPanel = documentRef.querySelector("#debug-panel");
  const debugPanelCollapse = documentRef.querySelector("#debug-panel-collapse");
  const selectedReadout = documentRef.querySelector("#selected-readout");
  const selectedObjectTitle = documentRef.querySelector(".selected-node-title");
  const volumeStatus = documentRef.createElement("p");
  volumeStatus.id = "theta-volume-status";
  volumeStatus.hidden = true;
  selectedObjectTitle?.parentElement?.append(volumeStatus);
  const selectedNodePosition = documentRef.querySelector(
    "#selected-node-position",
  );
  const selectedNodePayload = documentRef.querySelector(
    "#selected-node-payload",
  );
  const simplexNameInput = documentRef.querySelector("#simplex-name-input");
  const deletePanel = documentRef.querySelector("#delete-panel");
  const deleteObjectPlan = documentRef.querySelector("#delete-object-plan");
  const deleteObjectConfirm = documentRef.querySelector("#delete-object-confirm");
  const deleteObjectWarning = documentRef.querySelector("#delete-object-warning");
  const scenePanel = documentRef.querySelector("#scene-panel");
  const payloadPanel = documentRef.querySelector("#payload-panel");
  const expansionStatus = documentRef.createElement("p");
  expansionStatus.id = "payload-expansion-status";
  expansionStatus.className = "payload-expansion-menu";
  expansionStatus.setAttribute("role", "status");
  expansionStatus.style.top = "12px";
  expansionStatus.style.left = "50%";
  expansionStatus.style.transform = "translateX(-50%)";
  expansionStatus.style.display = "none";
  expansionStatus.hidden = true;
  scenePanel.append(expansionStatus);
  workspace.bus.on("expansion:failed", ({ message }) => {
    expansionStatus.textContent = `Expansion failed: ${message}`;
    expansionStatus.hidden = false;
    expansionStatus.style.display = "block";
  });
  workspace.bus.on("expansion:attached", () => {
    expansionStatus.hidden = true;
    expansionStatus.style.display = "none";
  });
  const payloadActions = documentRef.querySelector("#payload-actions");
  const payloadAddText = documentRef.querySelector("#payload-add-text");
  const payloadAddLatex = documentRef.querySelector("#payload-add-latex");
  const payloadAddCode = documentRef.querySelector("#payload-add-code");
  const payloadAddImage = documentRef.querySelector("#payload-add-image");
  const payloadAddUrl = documentRef.querySelector("#payload-add-url");
  const payloadAddGolog = documentRef.querySelector("#payload-add-golog");
  const payloadAssociateGolog = documentRef.querySelector(
    "#payload-associate-golog",
  );
  const payloadTextEditor = documentRef.querySelector("#payload-text-editor");
  const payloadLatexView = documentRef.querySelector("#payload-latex-view");
  const payloadLatexEditor = documentRef.querySelector("#payload-latex-editor");
  const payloadLatexPreview = documentRef.querySelector("#payload-latex-preview");
  const payloadCompileLatex = documentRef.querySelector("#payload-compile-latex");
  const payloadOpenLatexSource = documentRef.querySelector(
    "#payload-open-latex-source",
  );
  const payloadOpenLatexPdf = documentRef.querySelector("#payload-open-latex-pdf");
  const payloadLatexStatus = documentRef.querySelector("#payload-latex-status");
  const payloadCodeView = documentRef.querySelector("#payload-code-view");
  const payloadCodeLanguage = documentRef.querySelector("#payload-code-language");
  const payloadCodeEditor = documentRef.querySelector("#payload-code-editor");
  const payloadImageView = documentRef.querySelector("#payload-image-view");
  const payloadImagePreview = documentRef.querySelector("#payload-image-preview");
  const payloadImageAlt = documentRef.querySelector("#payload-image-alt");
  const payloadImageReplace = documentRef.querySelector("#payload-image-replace");
  const payloadImageInput = documentRef.querySelector("#payload-image-input");
  const payloadUrlView = documentRef.querySelector("#payload-url-view");
  const payloadUrlInput = documentRef.querySelector("#payload-url-input");
  const payloadUrlTitle = documentRef.querySelector("#payload-url-title");
  const payloadOpenUrl = documentRef.querySelector("#payload-open-url");
  const payloadGologView = documentRef.querySelector("#payload-golog-view");
  const payloadGologPreview = documentRef.querySelector("#payload-golog-preview");
  const payloadOpenGolog = documentRef.querySelector("#payload-open-golog");
  const workspaceLoadInput = documentRef.querySelector("#workspace-load-input");
  const workspaceIoStatus = documentRef.querySelector("#workspace-io-status");
  const workspaceLoadPopover = documentRef.querySelector(
    "#workspace-load-popover",
  );
  const hostedWorkspaceSelect = documentRef.querySelector(
    "#hosted-workspace-select",
  );
  const hostedWorkspaceLoad = documentRef.querySelector("#hosted-workspace-load");
  const workspaceLoadFile = documentRef.querySelector("#workspace-load-file");
  if (!serverWorkspaceCatalog) {
    if (hostedWorkspaceSelect) hostedWorkspaceSelect.hidden = true;
    if (hostedWorkspaceLoad) hostedWorkspaceLoad.hidden = true;
  }
  if (!serverLatexCompile) {
    payloadCompileLatex.disabled = true;
    payloadCompileLatex.title = STATIC_LATEX_COMPILE_MESSAGE;
  }
  if (sharedWorkspaceLoad && workspaceLoadFile) {
    workspaceLoadFile.textContent = "File — replace shared workspace";
    workspaceLoadFile.title = "Load a file for everyone connected to this shared workspace";
  }
  const workspaceSaveServer = documentRef.querySelector("#workspace-save-server");
  const devReloadRestore = documentRef.querySelector("#dev-reload-restore");
  const shortcutHints = documentRef.querySelector("#shortcut-hints");
  const forceDefaultsCommit = documentRef.querySelector(
    "#force-defaults-commit",
  );
  const forceControlsPanel = documentRef.querySelector("#force-controls");
  const forceDefaultsStatus = documentRef.querySelector(
    "#force-defaults-status",
  );
  const payloadExpandAllMedia = documentRef.querySelector(
    "#payload-expand-all-media",
  );
  const payloadRenderManifestStatus = documentRef.querySelector(
    "#payload-render-manifest-status",
  );
  const shortcutButtons = new Map(
    [...documentRef.querySelectorAll("[data-shortcut-action]")].map(
      (button) => [button.dataset.shortcutAction, button],
    ),
  );
  const forceControlInputs = [
    ...documentRef.querySelectorAll("[data-force-setting]"),
  ];
  const forceControlOutputs = new Map(
    [...documentRef.querySelectorAll("[data-force-value]")].map((output) => [
      output.dataset.forceValue,
      output,
    ]),
  );
  const appRoot = documentRef.querySelector("#app");
  let activeGologId = null;
  let bus = null;
  let state = null;
  let scene = null;
  let releaseActiveListeners = [];
  let selectedSimplexId = null;
  let labelsVisible = true;
  let editedLabelId = null;
  let sceneLabelEditor = null;
  let sceneLabelEditorFallbackPoint = null;
  let tabDrag = null;
  let iphoneTabsOpen = false;
  let virtualCellCaptureState = { active: false, edgeIds: [], valid: false };
  let payloadPreviewRenderer = null;
  let appliedModeCssVars = [];
  let currentHostedWorkspaceId = initialHostedWorkspaceId;
  let hostedWorkspaces = [];
  let allPayloadMediaExpanded = false;
  let selectedPayloadKey = null;
  let pendingDeletePlan = null;
  let payloadSelectorRow = null;
  let payloadSelector = null;
  let payloadExpansionMenu = null;
  const openTabIds = [];
  const panelCollapseState = loadPanelCollapseState();

  function readLocalStorage() {
    try {
      return documentRef.defaultView?.localStorage ?? null;
    } catch {
      return null;
    }
  }

  function loadPanelCollapseState() {
    const statusDefault = usesIphonePresentation();
    const fallback = { shortcuts: false, status: statusDefault, debug: false };
    try {
      const raw = documentRef.defaultView?.localStorage?.getItem(
        PANEL_COLLAPSE_STORAGE_KEY,
      );
      const parsed = raw ? JSON.parse(raw) : {};
      return {
        shortcuts: Boolean(parsed.shortcuts),
        status: "status" in parsed ? Boolean(parsed.status) : statusDefault,
        debug: Boolean(parsed.debug),
      };
    } catch {
      return fallback;
    }
  }

  function persistPanelCollapseState() {
    try {
      readLocalStorage()?.setItem(
        PANEL_COLLAPSE_STORAGE_KEY,
        JSON.stringify(panelCollapseState),
      );
    } catch {
      // UI collapse state is a convenience, not domain state.
    }
  }

  function applyPanelCollapseState() {
    if (shortcutHints) {
      shortcutHints.hidden =
        !modeHead.shouldShowPanel("shortcuts") || panelCollapseState.shortcuts;
    }
    if (debugPanel) {
      debugPanel.hidden =
        !modeHead.shouldShowPanel("debug") || panelCollapseState.debug;
    }
    const anyCollapsed = Object.values(panelCollapseState).some(Boolean);
    if (toggleUiPanelsButton) {
      toggleUiPanelsButton.textContent = anyCollapsed ? "UI+" : "UI";
      toggleUiPanelsButton.setAttribute("aria-pressed", String(!anyCollapsed));
      toggleUiPanelsButton.title = anyCollapsed
        ? "Restore UI panels"
        : "Collapse UI panels";
    }
    scheduleRightUiStackUpdate();
  }

  function usesIphonePresentation() {
    return (
      modeHead.presentationSnapshot?.().mode === "iphone" ||
      modeHead.snapshot?.().presentation?.mode === "iphone"
    );
  }

  function setStatusPanelVisibility(hasSelection) {
    const iphone = usesIphonePresentation();
    const expanded = hasSelection && !panelCollapseState.status;
    statusPanel.classList.toggle(
      "is-collapsed",
      Boolean(hasSelection && panelCollapseState.status),
    );
    statusPanel.classList.toggle("is-expanded", Boolean(expanded));
    statusPanel.hidden = !hasSelection || (!iphone && panelCollapseState.status);
    iphoneSelectionPaneExpand?.setAttribute("aria-expanded", String(expanded));
    iphoneSelectionPaneCollapse?.setAttribute(
      "aria-expanded",
      String(expanded),
    );
    if (expanded) {
      scheduleRightUiStackUpdate();
    }
  }

  function setPanelCollapsed(panelName, collapsed) {
    if (!(panelName in panelCollapseState)) {
      return;
    }
    panelCollapseState[panelName] = Boolean(collapsed);
    persistPanelCollapseState();
    applyPanelCollapseState();
    if (panelName === "status" && state) {
      applyStateSnapshot(state.snapshot());
    }
  }

  function toggleAllUiPanels() {
    const shouldRestore = Object.values(panelCollapseState).some(Boolean);
    for (const key of Object.keys(panelCollapseState)) {
      panelCollapseState[key] = !shouldRestore;
    }
    persistPanelCollapseState();
    applyPanelCollapseState();
    if (state) {
      applyStateSnapshot(state.snapshot());
    }
  }

  function updateRightUiStack() {
    if (!shortcutHints || !appRoot) {
      return;
    }
    const appRect = appRoot.getBoundingClientRect();
    const anchor =
      shortcutHints && !shortcutHints.hidden ? shortcutHints : gologTabbar;
    const anchorRect = anchor?.getBoundingClientRect?.();
    const top = anchorRect
      ? Math.max(0, Math.ceil(anchorRect.bottom - appRect.top + 10))
      : 64;
    appRoot.style.setProperty("--selected-panel-top", `${top}px`);
  }

  function scheduleRightUiStackUpdate() {
    requestAnimationFrame(updateRightUiStack);
  }

  function resizeSceneLabelEditor() {
    if (!sceneLabelEditor) {
      return;
    }

    const characterCount = sceneLabelEditor.value.length;
    sceneLabelEditor.style.width = `${Math.max(72, Math.min(360, characterCount * 12 + 34))}px`;
  }

  function closeSceneLabelEditor() {
    if (!sceneLabelEditor) {
      return;
    }

    editedLabelId = null;
    sceneLabelEditorFallbackPoint = null;
    sceneLabelEditor.hidden = true;
    scene?.releaseIphoneKeyboardViewport?.();
  }

  function focusSceneLabelEditor(editor) {
    scene?.prepareIphoneKeyboardViewport?.();
    try {
      editor.focus({ preventScroll: true });
    } catch {
      editor.focus();
    }
    editor.select();
  }

  function clampSceneLabelPoint(point) {
    if (!point || !sceneLabelEditor) {
      return point;
    }

    const rect = scene?.activeCanvasViewport?.() ?? {
      x: 0,
      y: 0,
      width: scenePanel.getBoundingClientRect().width,
      height: scenePanel.getBoundingClientRect().height,
    };
    const margin = 6;
    const editorWidth = sceneLabelEditor.offsetWidth || 72;
    const editorHeight = sceneLabelEditor.offsetHeight || 30;
    const minX = rect.x + margin;
    const maxX = rect.x + Math.max(margin, rect.width - editorWidth - margin);
    const minY = rect.y + editorHeight + margin;
    const maxY = rect.y + Math.max(editorHeight + margin, rect.height - margin);
    return {
      x: Math.min(Math.max(minX, point.x), maxX),
      y: Math.min(Math.max(minY, point.y), maxY),
    };
  }

  function disposePayloadPreviewRenderer() {
    payloadPreviewRenderer?.dispose();
    payloadPreviewRenderer = null;
  }

  function ensurePayloadPreviewRenderer() {
    if (!payloadPreviewRenderer) {
      payloadPreviewRenderer = new NestedGologPanelRenderer({
        container: payloadGologPreview,
      });
    }
    return payloadPreviewRenderer;
  }

  function bindPayloadPreview(gologId) {
    const renderer = ensurePayloadPreviewRenderer();
    renderer.setGolog(workspace.gologs.get(gologId) ?? null);
    requestAnimationFrame(() => renderer.render());
  }

  function payloadsForObject(objectId) {
    if (!state || !objectId) {
      return [];
    }
    if (typeof state.getPayloads === "function") {
      return state.getPayloads(objectId);
    }
    return [state.getPayload(objectId)].filter(Boolean);
  }

  function payloadKeyFor(payload) {
    return payloadAttachmentKey(payload);
  }

  function payloadChoiceLabel(payload) {
    const kind = payloadKind(payload);
    if (kind === "markdown") {
      return "Text";
    }
    if (kind === "latex") {
      return payload.title ? `LaTeX: ${payload.title}` : "LaTeX";
    }
    if (kind === "code") {
      return payload.language ? `Code: ${payload.language}` : "Code";
    }
    if (kind === "image") {
      return payload.name || payload.alt || "Image";
    }
    if (kind === "url") {
      return payload.title || payload.url || "URL";
    }
    if (kind === "nested-golog") {
      const title = workspace.gologs.get(payload.targetGologId)?.title;
      return title ? `Golog: ${title}` : "Golog";
    }

    return payload.type ?? "Payload";
  }

  function ensureSelectedPayloadKey(payloads) {
    if (payloads.length === 0) {
      selectedPayloadKey = null;
      return null;
    }
    const keys = payloads.map(payloadKeyFor);
    if (!selectedPayloadKey || !keys.includes(selectedPayloadKey)) {
      selectedPayloadKey = keys[0];
    }
    return selectedPayloadKey;
  }

  function activePayloadForObject(objectId) {
    const payloads = payloadsForObject(objectId);
    const key = ensureSelectedPayloadKey(payloads);
    return (
      payloads.find((payload) => payloadKeyFor(payload) === key) ??
      payloads[0] ??
      null
    );
  }

  function ensurePayloadSelector() {
    if (payloadSelectorRow) {
      return payloadSelector;
    }
    payloadSelectorRow = documentRef.createElement("label");
    payloadSelectorRow.className = "payload-selector-row";
    payloadSelectorRow.textContent = "Data";
    payloadSelector = documentRef.createElement("select");
    payloadSelector.id = "payload-selector";
    payloadSelector.setAttribute("aria-label", "Selected payload");
    payloadSelectorRow.append(payloadSelector);
    payloadPanel.prepend(payloadSelectorRow);
    payloadSelector.addEventListener("change", () => {
      selectedPayloadKey = payloadSelector.value;
      const selected = selectedSimplexId ? state?.getObject(selectedSimplexId) : null;
      renderPayloadPanel(selected);
    });
    return payloadSelector;
  }

  function renderPayloadSelector(payloads) {
    const selector = ensurePayloadSelector();
    selector.replaceChildren();
    const key = ensureSelectedPayloadKey(payloads);
    for (const payload of payloads) {
      const option = documentRef.createElement("option");
      option.value = payloadKeyFor(payload);
      option.textContent = payloadChoiceLabel(payload);
      selector.append(option);
    }
    selector.value = key ?? "";
    payloadSelectorRow.hidden = payloads.length <= 1;
  }

  function configurePayloadActions(selected, payloads) {
    const canAdd = Boolean(selected && canMutateSelectedData());
    const keys = new Set(payloads.map(payloadKeyFor));
    const setButton = (button, hidden) => {
      if (button) {
        button.hidden = hidden;
      }
    };
    setButton(payloadAddText, !canAdd || keys.has("markdown"));
    setButton(payloadAddLatex, !canAdd || keys.has("latex"));
    setButton(payloadAddCode, !canAdd || keys.has("code"));
    setButton(payloadAddImage, !canAdd || keys.has("image"));
    setButton(payloadAddUrl, !canAdd || keys.has("url"));
    setButton(
      payloadAddGolog,
      !canAdd || keys.has("nested-golog"),
    );
    setButton(
      payloadAssociateGolog,
      !canAdd || keys.has("nested-golog"),
    );
    const visibleButton = [
      payloadAddText,
      payloadAddLatex,
      payloadAddCode,
      payloadAddImage,
      payloadAddUrl,
      payloadAddGolog,
      payloadAssociateGolog,
    ].some((button) => button && !button.hidden);
    payloadActions.hidden = !visibleButton;
  }

  function closePayloadExpansionMenu() {
    payloadExpansionMenu?.remove();
    payloadExpansionMenu = null;
  }

  function presentPayloadChoice(selectable, payload) {
    closePayloadExpansionMenu();
    if (!bus || !payload) {
      return;
    }
    selectedPayloadKey = payloadKeyFor(payload);
    if (scenePresentationForPayload(payload, { workspace })) {
      bus.emit("payload:scene-present", {
        id: selectable.id,
        kind: selectable.kind,
        payload,
      });
    }
    if (state?.selectedSimplexId === selectable.id) {
      renderPayloadPanel(state.getObject(selectable.id));
    }
  }

  function scenePayloadChoices(selectable) {
    return sceneExpansionPayloadChoices(payloadsForObject(selectable?.id), {
      workspace,
    });
  }

  function payloadExpansionAnchor(selectable = {}) {
    const clientX = Number(selectable.clientX ?? selectable.client?.x);
    const clientY = Number(selectable.clientY ?? selectable.client?.y);
    if (Number.isFinite(clientX) && Number.isFinite(clientY)) {
      return { x: clientX, y: clientY };
    }
    const rect = scenePanel.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
  }

  function positionPayloadExpansionMenu(anchor) {
    if (!payloadExpansionMenu) {
      return;
    }
    const panelRect = scenePanel.getBoundingClientRect();
    const menuRect = payloadExpansionMenu.getBoundingClientRect();
    const margin = 8;
    const maxLeft = Math.max(margin, panelRect.width - menuRect.width - margin);
    const maxTop = Math.max(margin, panelRect.height - menuRect.height - margin);
    const left = Math.min(
      Math.max(margin, anchor.x - panelRect.left),
      maxLeft,
    );
    const top = Math.min(
      Math.max(margin, anchor.y - panelRect.top),
      maxTop,
    );
    payloadExpansionMenu.style.left = `${left}px`;
    payloadExpansionMenu.style.top = `${top}px`;
    payloadExpansionMenu.style.right = "auto";
  }

  function focusPayloadExpansionMenuButton(delta) {
    if (!payloadExpansionMenu) {
      return;
    }
    const buttons = [...payloadExpansionMenu.querySelectorAll("button")];
    if (buttons.length === 0) {
      return;
    }
    const activeIndex = buttons.indexOf(documentRef.activeElement);
    const nextIndex =
      activeIndex < 0
        ? 0
        : (activeIndex + delta + buttons.length) % buttons.length;
    buttons[nextIndex]?.focus();
  }

  function showPayloadExpansionMenu(selectable) {
    if (!selectable?.id || !bus) {
      return;
    }
    const choices = scenePayloadChoices(selectable);
    if (choices.length === 0) {
      closePayloadExpansionMenu();
      bus.emit("payload:scene-present", selectable);
      return;
    }
    if (choices.length === 1) {
      presentPayloadChoice(selectable, choices[0].payload);
      return;
    }

    closePayloadExpansionMenu();
    payloadExpansionMenu = documentRef.createElement("div");
    payloadExpansionMenu.className = "payload-expansion-menu";
    payloadExpansionMenu.setAttribute("role", "menu");
    payloadExpansionMenu.tabIndex = -1;
    const anchor = payloadExpansionAnchor(selectable);
    payloadExpansionMenu.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        focusPayloadExpansionMenuButton(1);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        focusPayloadExpansionMenuButton(-1);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        if (documentRef.activeElement?.tagName === "BUTTON") {
          documentRef.activeElement.click();
        } else {
          payloadExpansionMenu.querySelector("button")?.click();
        }
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closePayloadExpansionMenu();
      }
    });
    for (const choice of choices) {
      const button = documentRef.createElement("button");
      button.type = "button";
      button.setAttribute("role", "menuitem");
      button.textContent = payloadChoiceLabel(choice.payload);
      button.addEventListener("click", () =>
        presentPayloadChoice(selectable, choice.payload),
      );
      payloadExpansionMenu.append(button);
    }
    scenePanel.append(payloadExpansionMenu);
    positionPayloadExpansionMenu(anchor);
    requestAnimationFrame(() => {
      positionPayloadExpansionMenu(anchor);
      payloadExpansionMenu?.querySelector("button")?.focus();
    });
  }

  function positionSceneLabelEditor() {
    if (
      !sceneLabelEditor ||
      !editedLabelId ||
      sceneLabelEditor.hidden ||
      !state ||
      !scene
    ) {
      return;
    }

    const object = state.getObject(editedLabelId);
    const anchor = labelAnchorForObject(object);
    if (!anchor) {
      if (sceneLabelEditorFallbackPoint) {
        const point = clampSceneLabelPoint(sceneLabelEditorFallbackPoint);
        sceneLabelEditor.style.left = `${point.x}px`;
        sceneLabelEditor.style.top = `${point.y}px`;
        return;
      }
      if (documentRef.activeElement !== sceneLabelEditor) {
        closeSceneLabelEditor();
      }
      return;
    }

    sceneLabelEditorFallbackPoint = null;
    const point = clampSceneLabelPoint(scene.projectPointToCanvas(anchor));
    sceneLabelEditor.style.left = `${point.x}px`;
    sceneLabelEditor.style.top = `${point.y}px`;
  }

  function ensureSceneLabelEditor() {
    if (sceneLabelEditor) {
      return sceneLabelEditor;
    }

    sceneLabelEditor = documentRef.createElement("input");
    sceneLabelEditor.type = "text";
    sceneLabelEditor.autocomplete = "off";
    sceneLabelEditor.spellcheck = false;
    sceneLabelEditor.className = "scene-label-editor";
    sceneLabelEditor.setAttribute("aria-label", "Edit simplex label");
    sceneLabelEditor.hidden = true;
    scenePanel.appendChild(sceneLabelEditor);

    sceneLabelEditor.addEventListener("input", () => {
      resizeSceneLabelEditor();
      positionSceneLabelEditor();
      if (editedLabelId && bus) {
        bus.emit("simplex:rename", {
          id: editedLabelId,
          name: sceneLabelEditor.value,
        });
      }
    });
    sceneLabelEditor.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter" || event.key === "Escape") {
        event.preventDefault();
        closeSceneLabelEditor();
        scene?.renderer.domElement.focus();
      }
    });
    sceneLabelEditor.addEventListener("pointerdown", (event) =>
      event.stopPropagation(),
    );
    sceneLabelEditor.addEventListener("dblclick", (event) =>
      event.stopPropagation(),
    );
    sceneLabelEditor.addEventListener("blur", () => closeSceneLabelEditor());
    return sceneLabelEditor;
  }

  function scenePointFromClient(clientPoint) {
    if (
      !clientPoint ||
      !Number.isFinite(clientPoint.x) ||
      !Number.isFinite(clientPoint.y)
    ) {
      return null;
    }

    const rect = scenePanel.getBoundingClientRect();
    return {
      x: clientPoint.x - rect.left,
      y: clientPoint.y - rect.top,
    };
  }

  function openSceneLabelEditor(id, options = {}) {
    if (!state) {
      return;
    }

    const object = state.getObject(id);
    if (!object && !options.allowPending) {
      return;
    }

    const editor = ensureSceneLabelEditor();
    editedLabelId = id;
    sceneLabelEditorFallbackPoint = scenePointFromClient(options.clientPoint);
    editor.value = object?.name ?? "";
    editor.hidden = false;
    if (options.immediateFocus) {
      scene?.prepareIphoneKeyboardViewport?.();
    }
    resizeSceneLabelEditor();
    positionSceneLabelEditor();
    if (options.immediateFocus) {
      focusSceneLabelEditor(editor);
    }
    requestAnimationFrame(() => {
      positionSceneLabelEditor();
      focusSceneLabelEditor(editor);
    });
  }

  function resetPayloadPanel() {
    setPayloadMode("none");
    if (payloadSelectorRow) {
      payloadSelectorRow.hidden = true;
    }
    payloadActions.hidden = true;
    payloadTextEditor.value = "";
    payloadTextEditor.dataset.payloadType = "";
    payloadLatexEditor.value = "";
    payloadLatexPreview.replaceChildren();
    payloadLatexPreview.dataset.renderUrl = "";
    payloadLatexPreview.dataset.mediaType = "";
    payloadLatexPreview.dataset.emptyMessage = "";
    payloadLatexStatus.textContent = "";
    payloadCompileLatex.disabled = true;
    payloadOpenLatexSource.dataset.url = "";
    payloadOpenLatexPdf.dataset.url = "";
    payloadCodeEditor.value = "";
    payloadCodeLanguage.value = "javascript";
    payloadImagePreview.removeAttribute("src");
    payloadImageAlt.value = "";
    payloadUrlInput.value = "";
    payloadUrlTitle.value = "";
    payloadOpenUrl.dataset.url = "";
    payloadOpenGolog.dataset.gologId = "";
    disposePayloadPreviewRenderer();
  }

  function setPayloadMode(mode) {
    payloadPanel.hidden = mode === "none";
    payloadTextEditor.hidden = mode !== "text";
    payloadLatexView.hidden = mode !== "latex";
    payloadCodeView.hidden = mode !== "code";
    payloadImageView.hidden = mode !== "image";
    payloadUrlView.hidden = mode !== "url";
    payloadGologView.hidden = mode !== "golog";
    payloadOpenGolog.disabled = true;
    if (mode !== "golog") {
      disposePayloadPreviewRenderer();
    }
  }

  function setLatexStatus(text) {
    payloadLatexStatus.textContent = text ?? "";
  }

  function latexRenderedUrl(payload) {
    return String(
      payload?.imageDataUrl ||
        payload?.pngDataUrl ||
        payload?.previewDataUrl ||
        payload?.imageUrl ||
        payload?.pngUrl ||
        payload?.previewUrl ||
        payload?.pdfUrl ||
        "",
    );
  }

  function latexRenderedMediaType(payload) {
    return payload?.imageDataUrl ||
      payload?.pngDataUrl ||
      payload?.previewDataUrl ||
      payload?.imageUrl ||
      payload?.pngUrl ||
      payload?.previewUrl
      ? "image"
      : "pdf";
  }

  function renderLatexPreview(
    renderUrl,
    message = "Compile PNG to render.",
    { mediaType = "image" } = {},
  ) {
    const nextRenderUrl = safePayloadPreviewUrl(renderUrl, {
      mediaType, baseUrl: documentRef.baseURI,
    });
    const nextMessage = String(message ?? "");
    const nextMediaType = nextRenderUrl ? mediaType : "";
    if (
      payloadLatexPreview.dataset.renderUrl === nextRenderUrl &&
      payloadLatexPreview.dataset.emptyMessage === nextMessage &&
      payloadLatexPreview.dataset.mediaType === nextMediaType
    ) {
      payloadLatexPreview.hidden = false;
      return;
    }

    payloadLatexPreview.dataset.renderUrl = nextRenderUrl;
    payloadLatexPreview.dataset.emptyMessage = nextMessage;
    payloadLatexPreview.dataset.mediaType = nextMediaType;
    payloadLatexPreview.replaceChildren();
    payloadLatexPreview.hidden = false;
    if (!nextRenderUrl) {
      const empty = documentRef.createElement("span");
      empty.className = "latex-empty";
      empty.textContent = nextMessage;
      payloadLatexPreview.append(empty);
      return;
    }

    if (nextMediaType === "pdf") {
      appendPdfPreview(payloadLatexPreview, { url: nextRenderUrl,
        className: "payload-latex-pdf", title: "Compiled LaTeX PDF" });
      return;
    }

    const image = documentRef.createElement("img");
    image.className = "payload-latex-image";
    image.alt = "Compiled LaTeX PNG";
    image.src = nextRenderUrl;
    payloadLatexPreview.append(image);
  }

  function emitTypedPayload(payload) {
    if (!selectedSimplexId || !bus || !state || !modeHead.canEditPayload(state.gologId)) {
      return;
    }
    const key = payloadKeyFor(payload);
    const existing =
      state.getPayloadByKey?.(selectedSimplexId, key) ??
      (payloadKeyFor(state.getPayload(selectedSimplexId)) === key
        ? state.getPayload(selectedSimplexId)
        : null);
    bus.emit(existing ? "payload:typed-update" : "payload:typed-add", {
      id: selectedSimplexId,
      payload,
    });
  }

  function activePayloadRenderManifest() {
    return buildPayloadRenderManifest({ state, workspace });
  }

  function payloadRenderManifestText(manifest = activePayloadRenderManifest()) {
    const ready = manifest.renderableMediaCount;
    const uncompiled = manifest.uncompiledLatexCount;
    if (!ready && !uncompiled) {
      return "No PNG payloads.";
    }
    return `${ready} PNG${ready === 1 ? "" : "s"} ready; ${uncompiled} LaTeX uncompiled.`;
  }

  function updatePayloadRenderManifestControls() {
    const manifest = activePayloadRenderManifest();
    if (payloadRenderManifestStatus) {
      payloadRenderManifestStatus.textContent = payloadRenderManifestText(manifest);
    }
    if (payloadExpandAllMedia) {
      payloadExpandAllMedia.textContent = allPayloadMediaExpanded
        ? "Hide PNGs"
        : "Expand PNGs";
      payloadExpandAllMedia.disabled = !state || !modeHead.canEditPayload(state.gologId);
    }
    const shortcut = shortcutButtons.get("payload-media");
    if (shortcut) {
      shortcut.setAttribute("aria-pressed", String(allPayloadMediaExpanded));
      shortcut.disabled = !state || !modeHead.canEditPayload(state.gologId);
      shortcut.title = allPayloadMediaExpanded
        ? "Q to hide PNG payloads"
        : `Q to expand PNG payloads. ${payloadRenderManifestText(manifest)}`;
    }
    return manifest;
  }

  function compiledLatexPayload(payload, source, result) {
    return {
      ...payload,
      text: source,
      latexUrl: result.latexUrl,
      imageUrl: result.imageUrl ?? result.pngUrl ?? "",
      imageDataUrl:
        result.imageDataUrl ??
        result.pngDataUrl ??
        result.previewDataUrl ??
        "",
      pdfUrl: result.pdfUrl ?? "",
      renderContext:
        result.renderContext ??
        payload.renderContext ??
        payload.sourceProfile ??
        "",
    };
  }

  async function compileLatexPayloadSource(payload, source) {
    if (!serverLatexCompile) throw new Error(STATIC_LATEX_COMPILE_MESSAGE);
    const response = await fetch(LATEX_COMPILE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source,
        documentKind: payload.documentKind ?? "snippet",
        title: payload.title ?? "",
        renderContext: payload.renderContext ?? payload.sourceProfile ?? "",
      }),
    });
    const result = await readLatexCompileResult(response);
    if (!response.ok || !result.ok) {
      throw new Error(result.error ?? "LaTeX compile failed");
    }
    return compiledLatexPayload(payload, source, result);
  }

  async function compileLatexPayloadForObject(objectId, payload) {
    const nextPayload = await compileLatexPayloadSource(
      payload,
      String(payload.text ?? ""),
    );
    bus.emit("payload:typed-update", {
      id: objectId,
      payload: nextPayload,
    });
    return nextPayload;
  }

  async function expandAllPayloadMedia() {
    if (!state || !scene || !bus) {
      return;
    }
    if (allPayloadMediaExpanded) {
      scene.closePayloadBillboardPreviews();
      allPayloadMediaExpanded = false;
      updatePayloadRenderManifestControls();
      return;
    }
    if (!modeHead.canEditPayload(state.gologId)) {
      if (payloadRenderManifestStatus) {
        payloadRenderManifestStatus.textContent = "Payload editing is disabled.";
      }
      return;
    }

    if (payloadExpandAllMedia) {
      payloadExpandAllMedia.disabled = true;
    }
    try {
      let manifest = activePayloadRenderManifest();
      if (serverLatexCompile && manifest.uncompiledLatexCount > 0 && payloadRenderManifestStatus) {
        payloadRenderManifestStatus.textContent =
          `Compiling ${manifest.uncompiledLatexCount} LaTeX payload${manifest.uncompiledLatexCount === 1 ? "" : "s"}...`;
      }
      for (const entry of serverLatexCompile ? manifest.uncompiledLatex : []) {
        await compileLatexPayloadForObject(entry.objectId, entry.payload);
      }

      manifest = activePayloadRenderManifest();
      const shown = scene.showPayloadBillboardPreviews(manifest.renderableMedia);
      allPayloadMediaExpanded = shown > 0;
      if (payloadRenderManifestStatus) {
        payloadRenderManifestStatus.textContent =
          `${shown} PNG${shown === 1 ? "" : "s"} expanded; ${manifest.uncompiledLatexCount} LaTeX uncompiled.`;
      }
    } catch (error) {
      if (payloadRenderManifestStatus) {
        payloadRenderManifestStatus.textContent = error.message;
      }
    } finally {
      if (payloadExpandAllMedia) {
        payloadExpandAllMedia.disabled = false;
      }
      updatePayloadRenderManifestControls();
    }
  }

  function ensureCodeLanguageOption(language) {
    const value = String(language || "text");
    const exists = [...payloadCodeLanguage.options].some(
      (option) => option.value === value,
    );
    if (!exists) {
      const option = documentRef.createElement("option");
      option.value = value;
      option.textContent = value;
      payloadCodeLanguage.append(option);
    }
    return value;
  }

  function canMutateSelectedData() {
    return state ? modeHead.canAttachPayload(state.gologId) : false;
  }

  function renderPayloadPanel(selected) {
    if (!selected || !state) {
      resetPayloadPanel();
      return;
    }

    const payloads = payloadsForObject(selected.id);
    configurePayloadActions(selected, payloads);
    renderPayloadSelector(payloads);
    const payload = activePayloadForObject(selected.id);
    if (!payload) {
      if (!canMutateSelectedData()) {
        resetPayloadPanel();
        return;
      }
      payloadPanel.hidden = false;
      setPayloadMode("empty");
      payloadOpenGolog.dataset.gologId = "";
      disposePayloadPreviewRenderer();
      return;
    }

    if (payload.type === "text/markdown") {
      setPayloadMode("text");
      configurePayloadActions(selected, payloads);
      payloadTextEditor.disabled = !modeHead.canEditPayload(state.gologId);
      payloadTextEditor.dataset.payloadType = payload.type;
      if (payloadTextEditor.value !== payload.text) {
        payloadTextEditor.value = payload.text ?? "";
      }
      payloadOpenGolog.dataset.gologId = "";
      disposePayloadPreviewRenderer();
      return;
    }

    if (payload.type === PAYLOAD_TYPES.LATEX) {
      const renderUrl = latexRenderedUrl(payload);
      const renderMediaType = latexRenderedMediaType(payload);
      const latexUrl = payload.latexUrl ?? "";
      setPayloadMode("latex");
      configurePayloadActions(selected, payloads);
      payloadLatexEditor.disabled = !modeHead.canEditPayload(state.gologId);
      payloadCompileLatex.disabled = !serverLatexCompile || !modeHead.canEditPayload(state.gologId);
      if (payloadLatexEditor.value !== payload.text) {
        payloadLatexEditor.value = payload.text ?? "";
      }
      renderLatexPreview(
        renderUrl,
        payload.text ? "Uncompiled LaTeX source." : "Empty LaTeX source.",
        { mediaType: renderMediaType },
      );
      setLatexStatus(renderUrl ? "Compiled PNG ready." : serverLatexCompile ? "Press Compile PNG." : STATIC_LATEX_COMPILE_MESSAGE);
      payloadOpenLatexSource.disabled = !latexUrl;
      payloadOpenLatexSource.dataset.url = latexUrl;
      payloadOpenLatexPdf.disabled = !renderUrl;
      payloadOpenLatexPdf.dataset.url = renderUrl;
      payloadOpenGolog.dataset.gologId = "";
      disposePayloadPreviewRenderer();
      return;
    }

    if (payloadKind(payload) === "code") {
      setPayloadMode("code");
      configurePayloadActions(selected, payloads);
      payloadCodeEditor.disabled = !modeHead.canEditPayload(state.gologId);
      payloadCodeLanguage.disabled = !modeHead.canEditPayload(state.gologId);
      const language = ensureCodeLanguageOption(
        payload.language ?? codeLanguageFromType(payload.type),
      );
      if (payloadCodeLanguage.value !== language) {
        payloadCodeLanguage.value = language;
      }
      if (payloadCodeEditor.value !== payload.text) {
        payloadCodeEditor.value = payload.text ?? "";
      }
      payloadOpenGolog.dataset.gologId = "";
      disposePayloadPreviewRenderer();
      return;
    }

    if (payloadKind(payload) === "image") {
      setPayloadMode("image");
      configurePayloadActions(selected, payloads);
      payloadImageAlt.disabled = !modeHead.canEditPayload(state.gologId);
      payloadImageReplace.disabled = !modeHead.canEditPayload(state.gologId);
      if (payloadImagePreview.getAttribute("src") !== (payload.src ?? "")) {
        payloadImagePreview.src = payload.src ?? "";
      }
      if (payloadImageAlt.value !== (payload.alt ?? "")) {
        payloadImageAlt.value = payload.alt ?? "";
      }
      payloadOpenGolog.dataset.gologId = "";
      disposePayloadPreviewRenderer();
      return;
    }

    if (payloadKind(payload) === "url") {
      const openUrl = openablePayloadUrl(payload.url);
      setPayloadMode("url");
      configurePayloadActions(selected, payloads);
      payloadUrlInput.disabled = !modeHead.canEditPayload(state.gologId);
      payloadUrlTitle.disabled = !modeHead.canEditPayload(state.gologId);
      if (payloadUrlInput.value !== (payload.url ?? "")) {
        payloadUrlInput.value = payload.url ?? "";
      }
      if (payloadUrlTitle.value !== (payload.title ?? "")) {
        payloadUrlTitle.value = payload.title ?? "";
      }
      payloadOpenUrl.disabled = !openUrl;
      payloadOpenUrl.dataset.url = openUrl;
      payloadOpenGolog.dataset.gologId = "";
      disposePayloadPreviewRenderer();
      return;
    }

    if (payload.type === "nested-golog") {
      setPayloadMode("golog");
      configurePayloadActions(selected, payloads);
      payloadTextEditor.disabled = true;
      payloadOpenGolog.disabled = !workspace.gologs.has(payload.targetGologId);
      payloadOpenGolog.dataset.gologId = payload.targetGologId;
      bindPayloadPreview(payload.targetGologId);
      return;
    }

    resetPayloadPanel();
  }

  function payloadSummary(payload) {
    if (!payload) {
      return "none";
    }
    if (payload.type === "nested-golog") {
      return "golog";
    }
    if (payload.type === PAYLOAD_TYPES.LATEX) {
      return "LaTeX";
    }
    if (payload.type === "text/markdown") {
      return "text";
    }
    const kind = payloadKind(payload);
    if (kind === "code") {
      return payload.language ? `code/${payload.language}` : "code";
    }
    if (kind === "image") {
      return "image";
    }
    if (kind === "url") {
      return "URL";
    }
    return payload.type ?? "payload";
  }

  function payloadSummaryForObject(objectId) {
    const payloads = payloadsForObject(objectId);
    if (payloads.length === 0) {
      return "none";
    }
    if (payloads.length === 1) {
      return payloadSummary(payloads[0]);
    }
    return `${payloads.length} payloads`;
  }

  function setDeleteWarning(text = "") {
    if (deleteObjectWarning) {
      deleteObjectWarning.textContent = text;
    }
  }

  function resetDeletePanel() {
    pendingDeletePlan = null;
    if (deleteObjectConfirm) {
      deleteObjectConfirm.hidden = true;
    }
    setDeleteWarning("");
  }

  function renderDeletePanel(selected) {
    if (!deletePanel || !deleteObjectPlan) {
      return;
    }
    if (!selected || !state || !agentApi) {
      deletePanel.hidden = true;
      resetDeletePanel();
      return;
    }

    deletePanel.hidden = false;
    const canDelete = Boolean(modeHead.canDeleteObject?.(state.gologId));
    deleteObjectPlan.disabled = !canDelete;
    if (!canDelete) {
      resetDeletePanel();
      setDeleteWarning("Delete is disabled in this mode.");
      return;
    }
    if (pendingDeletePlan?.objectId !== selected.id) {
      resetDeletePanel();
    }
  }

  function hideNodeInspector() {
    statusPanel.hidden = true;
    statusPanel.classList.remove("is-collapsed", "is-expanded");
    if (selectedObjectTitle) {
      selectedObjectTitle.textContent = "Object";
    }
    selectedReadout.textContent = "none";
    selectedNodePosition.textContent = "unknown";
    selectedNodePayload.textContent = "none";
    simplexNameInput.disabled = true;
    simplexNameInput.placeholder = "Select an object";
    if (simplexNameInput.value !== "") {
      simplexNameInput.value = "";
    }
    if (deletePanel) {
      deletePanel.hidden = true;
    }
    resetDeletePanel();
    renderPayloadPanel(null);
  }

  function applyStateSnapshot(snapshot) {
    selectedSimplexId = snapshot.selectedSimplexId;
    const selected = selectedSimplexId
      ? state.getObject(selectedSimplexId)
      : null;
    updateVolumeStatus(selected);
    if (!selected) {
      hideNodeInspector();
    } else {
      setStatusPanelVisibility(true);
    }
    if (selectedObjectTitle) {
      selectedObjectTitle.textContent = titleForSelectedObject(selected);
    }
    selectedReadout.textContent = selected?.id ?? "none";
    selectedNodePosition.textContent = selected
      ? formatObjectAnchor(selected)
      : "unknown";
    selectedNodePayload.textContent = selected
      ? payloadSummaryForObject(selected.id)
      : "none";
    simplexNameInput.disabled =
      !selected || !modeHead.canRename(state.gologId);
    simplexNameInput.placeholder = selected ? "" : "Select an object";
    if (simplexNameInput.value !== (selected?.name ?? "")) {
      simplexNameInput.value = selected?.name ?? "";
    }
    renderDeletePanel(selected);
    renderPayloadPanel(selected);
    updatePayloadRenderManifestControls();
    if (editedLabelId) {
      const edited = state.getObject(editedLabelId);
      const editorFocused =
        sceneLabelEditor && documentRef.activeElement === sceneLabelEditor;
      if (!edited) {
        if (!editorFocused && !sceneLabelEditorFallbackPoint) {
          closeSceneLabelEditor();
        } else {
          positionSceneLabelEditor();
        }
      } else if (editedLabelId !== selectedSimplexId && !editorFocused) {
        closeSceneLabelEditor();
      } else if (
        sceneLabelEditor &&
        sceneLabelEditor.value !== (edited.name ?? "")
      ) {
        sceneLabelEditor.value = edited.name ?? "";
        resizeSceneLabelEditor();
      }
      positionSceneLabelEditor();
    }
  }

  function updateVolumeStatus(selected = state?.getObject(selectedSimplexId)) {
    const status = scene?.volumeRenderer?.diagnostics.get(selected?.id);
    volumeStatus.hidden = selected?.kind !== "volume" || !status || status.ok;
    const reasons = {
      "missing-boundary-surfaces": "A boundary surface is missing.",
      "boundary-not-closed-manifold": "The boundary has gaps or overlapping seams.",
      "nonconvex-boundary": "The current boundary is not convex.",
      "zero-volume-boundary": "The boundary is flat and encloses no volume.",
      "degenerate-boundary": "The boundary is too collapsed to enclose a region.",
      "disconnected-boundary": "The boundary has disconnected pieces.",
    };
    volumeStatus.textContent = status && !status.ok
      ? `Region hidden: ${reasons[status.reason] ?? "The boundary cannot enclose a valid region."}` : "";
  }

  function applyModeSnapshot(snapshot = modeHead.snapshot()) {
    const presentation = snapshot.presentation ?? { mode: snapshot.name, cssVars: {} };
    documentRef.body.dataset.runtimeMode = presentation.mode;
    for (const name of appliedModeCssVars) {
      documentRef.body.style.removeProperty(name);
    }
    appliedModeCssVars = Object.keys(presentation.cssVars ?? {});
    for (const [name, value] of Object.entries(presentation.cssVars ?? {})) {
      documentRef.body.style.setProperty(name, value);
    }

    if (state) {
      applyStateSnapshot(state.snapshot());
    }
    applyPanelCollapseState();
    updateForceLayoutControls();
    updateIphoneDragModeToggle();
    updateVirtualDoubleTools(snapshot);
    renderGologTabs();
    requestAnimationFrame(() => scene?.resize());
  }

  function updateVirtualDoubleTools(snapshot = modeHead.snapshot()) {
    if (!virtualDoubleTools) {
      return;
    }
    const active = snapshot.name === "virtual-double";
    virtualDoubleTools.hidden = !active;
    const selectedKind = modeHead.virtualArrowKind?.();
    for (const button of virtualArrowButtons) {
      const kind = button.dataset.virtualArrowKind === "tight"
        ? VIRTUAL_DOUBLE_ELEMENT_KINDS.TIGHT_ARROW
        : VIRTUAL_DOUBLE_ELEMENT_KINDS.PROARROW;
      button.setAttribute("aria-pressed", String(kind === selectedKind));
      button.disabled = !active || virtualCellCaptureState.active;
    }
    if (virtualCellCapture) {
      const count = virtualCellCaptureState.edgeIds?.length ?? 0;
      virtualCellCapture.hidden = !active;
      virtualCellCapture.disabled = !active;
      virtualCellCapture.setAttribute(
        "aria-pressed",
        String(Boolean(virtualCellCaptureState.active)),
      );
      virtualCellCapture.textContent = virtualCellCaptureState.active
        ? virtualCellCaptureState.valid
          ? "Create Cell"
          : `Cell ${count}`
        : "Cell";
      virtualCellCapture.title = virtualCellCaptureState.active
        ? "Click boundary arrows, then create the cell"
        : "Select a virtual-cell boundary";
    }
  }

  function clearActiveListeners() {
    for (const release of releaseActiveListeners) {
      release();
    }
    releaseActiveListeners = [];
  }

  function updateLabelToggle() {
    shortcutButtons
      .get("labels")
      ?.setAttribute("aria-pressed", String(labelsVisible));
  }

  function updateHistoryControls(summary = workspace.patchHistory.summary()) {
    return summary;
  }

  function updateGologNavigationControls(
    navigation = workspace.navigationState(),
  ) {
    if (!gologNavBack || !gologNavForward) {
      return;
    }
    gologNavBack.disabled = !navigation.canGoBack;
    gologNavForward.disabled = !navigation.canGoForward;
    gologNavBack.title = navigation.previousGologTitle
      ? `Back to ${navigation.previousGologTitle}`
      : "No previous golog";
    gologNavForward.title = navigation.nextGologTitle
      ? `Forward to ${navigation.nextGologTitle}`
      : "No next golog";
  }

  function updateForceLayoutControls(snapshot = liveForceLayout?.snapshot?.()) {
    const forceShortcut = shortcutButtons.get("force");
    if (!snapshot || !forceShortcut) {
      return;
    }
    const forceMode = modeHead.canRunForces();
    if (forceControlsPanel) {
      forceControlsPanel.hidden = !modeHead.shouldShowForceControls();
    }
    forceShortcut.disabled = !forceMode;
    forceShortcut.setAttribute("aria-pressed", String(snapshot.enabled));
    forceShortcut.title = snapshot.enabled
      ? "F to pause force layout"
      : "F to start force layout";
    if (forceDefaultsCommit) {
      forceDefaultsCommit.disabled =
        !liveForceLayout || !modeHead.shouldShowForceControls();
    }
    for (const input of forceControlInputs) {
      const setting = input.dataset.forceSetting;
      const value = Number(snapshot[setting] ?? input.value ?? 0);
      input.disabled = !liveForceLayout || !modeHead.shouldShowForceControls();
      if (documentRef.activeElement !== input) {
        input.value = String(value);
      }
      const output = forceControlOutputs.get(setting);
      if (output) {
        output.value = value.toFixed(value >= 1 ? 2 : 4);
        output.textContent = output.value;
      }
    }
  }

  function updateIphoneDragModeToggle(
    snapshot = scene?.iphoneTouchDragModeSnapshot?.(),
  ) {
    if (!iphoneDragModeToggle) {
      return;
    }
    const canToggle = Boolean(snapshot?.canToggle);
    iphoneDragModeToggle.hidden = !canToggle;
    iphoneDragModeToggle.disabled = !canToggle;
    const mode = snapshot?.mode ?? "inspect";
    const current =
      IPHONE_GESTURE_MODE_COPY[mode] ?? IPHONE_GESTURE_MODE_COPY.inspect;
    const next =
      IPHONE_GESTURE_MODE_COPY[snapshot?.nextMode] ??
      IPHONE_GESTURE_MODE_COPY.inspect;
    iphoneDragModeToggle.textContent = current.text;
    iphoneDragModeToggle.dataset.mode = mode;
    iphoneDragModeToggle.setAttribute("aria-pressed", String(mode !== "inspect"));
    iphoneDragModeToggle.setAttribute(
      "aria-label",
      `${current.label}. Tap for ${next.label}.`,
    );
    iphoneDragModeToggle.title = `${current.title}. Tap for ${next.label}.`;
  }

  function workspaceFilename() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    return `golog-workspace-${timestamp}.golog.json`;
  }

  function updateSaveShortcutTitle() {
    const saveShortcut = shortcutButtons.get("save");
    if (saveShortcut) {
      saveShortcut.title = serverWorkspaceSave && currentHostedWorkspaceId
        ? "Shift-S to save to server"
        : "Shift-S to save file";
    }
    if (workspaceSaveServer) {
      workspaceSaveServer.hidden = !serverWorkspaceSave;
      workspaceSaveServer.disabled = !serverWorkspaceSave;
      workspaceSaveServer.title = currentHostedWorkspaceId
        ? "Update this server-hosted golog"
        : "Create a server-hosted save for this golog";
    }
  }

  function downloadWorkspace(text) {
    const blob = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = documentRef.createElement("a");
    link.href = url;
    link.download = workspaceFilename();
    documentRef.body.appendChild(link);
    link.click();
    link.remove();
    globalThis.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function finishWorkspaceLoad(document, label = "workspace") {
    activeGologId = null;
    closeSceneLabelEditor();
    clearActiveListeners();
    openTabIds.length = 0;
    renderGologTabs();
    bindActiveGolog(workspace.activeGolog());
    workspaceIoStatus.textContent = `Loaded ${document.gologs.length} gologs from ${label}`;
    ensureActiveTabOpen();
    renderGologTabs();
    updateSaveShortcutTitle();
  }

  function toggleLabels() {
    if (!scene) {
      return false;
    }

    labelsVisible = !labelsVisible;
    scene.setLabelsVisible(labelsVisible);
    updateLabelToggle();
    return true;
  }

  function toggleForceLayout() {
    if (!liveForceLayout || !modeHead.canRunForces()) {
      return false;
    }
    updateForceLayoutControls(
      liveForceLayout.setEnabled(!liveForceLayout.snapshot().enabled),
    );
    return true;
  }

  function saveWorkspaceToFile() {
    try {
      downloadWorkspace(saveWorkspaceDocument());
      workspaceIoStatus.textContent = "Workspace saved";
      return true;
    } catch (error) {
      workspaceIoStatus.textContent = `Save failed: ${error.message}`;
      return false;
    }
  }

  async function saveWorkspaceToServer({ createIfMissing = false } = {}) {
    if (!serverWorkspaceSave) {
      return false;
    }
    if (!currentHostedWorkspaceId && !createIfMissing) {
      return false;
    }
    try {
      const endpoint = currentHostedWorkspaceId
        ? `/__golog/workspaces/${encodeURIComponent(currentHostedWorkspaceId)}/save`
        : "/__golog/workspaces/save-current";
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: saveWorkspaceDocument(),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.ok === false) {
        throw new Error(result.error ?? `Save failed with ${response.status}`);
      }
      if (!currentHostedWorkspaceId && result.id) {
        currentHostedWorkspaceId = result.id;
        updateSaveShortcutTitle();
        refreshHostedWorkspaceCatalog();
      }
      workspaceIoStatus.textContent = `Saved ${result.title ?? currentHostedWorkspaceId} to server`;
      return true;
    } catch (error) {
      workspaceIoStatus.textContent = `Server save failed: ${error.message}`;
      return false;
    }
  }

  function saveWorkspace() {
    if (serverWorkspaceSave && currentHostedWorkspaceId) {
      saveWorkspaceToServer();
      return true;
    }
    return saveWorkspaceToFile();
  }

  function renderHostedWorkspaceCatalog() {
    if (!hostedWorkspaceSelect) {
      return;
    }
    hostedWorkspaceSelect.textContent = "";
    if (hostedWorkspaces.length === 0) {
      const option = documentRef.createElement("option");
      option.value = "";
      option.textContent = "No Server Gologs";
      hostedWorkspaceSelect.append(option);
      hostedWorkspaceSelect.disabled = true;
      hostedWorkspaceLoad.disabled = true;
      return;
    }
    for (const entry of hostedWorkspaces) {
      const option = documentRef.createElement("option");
      option.value = entry.id;
      option.textContent = entry.sourceLabel
        ? `${entry.title} (${entry.sourceLabel})`
        : entry.title;
      hostedWorkspaceSelect.append(option);
    }
    hostedWorkspaceSelect.value =
      hostedWorkspaces.find((entry) => entry.id === currentHostedWorkspaceId)
        ?.id ?? hostedWorkspaces[0].id;
    hostedWorkspaceSelect.disabled = false;
    hostedWorkspaceLoad.disabled = false;
  }

  async function refreshHostedWorkspaceCatalog() {
    if (!serverWorkspaceCatalog) return;
    try {
      const response = await fetch(HOSTED_WORKSPACE_CATALOG_PATH, {
        cache: "no-store",
      });
      if (!response.ok) {
        throw new Error(`Catalog failed with ${response.status}`);
      }
      const catalog = await response.json();
      hostedWorkspaces = Array.isArray(catalog.workspaces)
        ? catalog.workspaces
        : [];
    } catch {
      hostedWorkspaces = [];
    }
    renderHostedWorkspaceCatalog();
  }

  async function loadHostedWorkspace(entry) {
    if (!serverWorkspaceCatalog || !entry?.workspaceUrl) {
      return false;
    }
    try {
      workspaceIoStatus.textContent = `Loading ${entry.title}`;
      const response = await fetch(entry.workspaceUrl, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`Load failed with ${response.status}`);
      }
      const document = await loadWorkspaceDocumentText(await response.text(), {
        activeGologTitle: entry.activeGologTitle,
      });
      currentHostedWorkspaceId = entry.id;
      workspaceLoadPopover.hidden = true;
      scheduleRightUiStackUpdate();
      finishWorkspaceLoad(document, entry.title);
      return true;
    } catch (error) {
      workspaceIoStatus.textContent = `Server load failed: ${error.message}`;
      return false;
    }
  }

  function openWorkspaceLoadChooser() {
    if (!serverWorkspaceCatalog || !workspaceLoadPopover) {
      return openWorkspaceFilePicker();
    }
    workspaceLoadPopover.hidden = !workspaceLoadPopover.hidden;
    if (!workspaceLoadPopover.hidden) {
      refreshHostedWorkspaceCatalog();
    }
    scheduleRightUiStackUpdate();
    return true;
  }

  function openWorkspaceFilePicker() {
    if (!workspaceLoadInput) {
      return false;
    }
    workspaceLoadInput.value = "";
    workspaceLoadInput.click();
    return true;
  }

  function isEditableShortcutTarget(target) {
    if (!target || target === documentRef.body) {
      return false;
    }
    if (target.isContentEditable) {
      return true;
    }
    return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
  }

  function handleShortcutKeyDown(event) {
    if (event.defaultPrevented || event.repeat) {
      return;
    }
    if (isEditableShortcutTarget(event.target)) {
      return;
    }

    const key = event.key.toLowerCase();
    let handled = false;
    if (event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
      if (key === "s") {
        handled = saveWorkspace();
      } else if (key === "l") {
        handled = openWorkspaceLoadChooser();
      }
    } else if (!event.ctrlKey && !event.metaKey && !event.altKey) {
      if (key === "f") {
        handled = toggleForceLayout();
      } else if (key === "l") {
        handled = toggleLabels();
      } else if (key === "q") {
        expandAllPayloadMedia();
        handled = true;
      }
    }

    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  function bindActiveGolog(golog) {
    if (!golog) {
      return;
    }
    const nextScene = golog.scene;
    if (
      activeGologId === golog.id &&
      bus === golog.bus &&
      state === golog.state &&
      scene === nextScene
    ) {
      return;
    }

    closeSceneLabelEditor();
    closePayloadExpansionMenu();
    resetPayloadPanel();
    clearActiveListeners();
    activeGologId = golog.id;
    bus = golog.bus;
    state = golog.state;
    scene = nextScene;
    allPayloadMediaExpanded = false;
    selectedSimplexId = null;
    labelsVisible = scene.labelsVisible;
    updateLabelToggle();

    releaseActiveListeners = [
      bus.on("state:changed", (snapshot) => applyStateSnapshot(snapshot)),
      bus.on("render:sphere-selected", () => applyStateSnapshot(state.snapshot())),
      bus.on("render:edge-selected", () => applyStateSnapshot(state.snapshot())),
      bus.on("render:surface-selected", () =>
        applyStateSnapshot(state.snapshot()),
      ),
      bus.on("render:volume-selected", () => applyStateSnapshot(state.snapshot())),
      bus.on("render:volume-status", () => updateVolumeStatus()),
      bus.on("camera:frame-changed", () => positionSceneLabelEditor()),
      bus.on("label:edit-requested", ({ id }) => openSceneLabelEditor(id)),
      bus.on("payload:scene-pick", (selectable) =>
        showPayloadExpansionMenu(selectable),
      ),
      bus.on("iphone:touch-drag-mode-changed", (snapshot) =>
        updateIphoneDragModeToggle(snapshot),
      ),
      bus.on("virtual-cell:capture-changed", (snapshot) => {
        virtualCellCaptureState = snapshot;
        updateVirtualDoubleTools();
      }),
    ];

    applyStateSnapshot(state.snapshot());
    updateIphoneDragModeToggle();
    virtualCellCaptureState = scene?.virtualCellCaptureSnapshot?.() ?? {
      active: false,
      edgeIds: [],
      valid: false,
    };
    updateVirtualDoubleTools();
  }

  scenePanel.addEventListener("golog:label-edit-requested", (event) => {
    const detail = event.detail ?? {};
    openSceneLabelEditor(detail.id, {
      allowPending: Boolean(detail.allowPending),
      immediateFocus: Boolean(detail.immediateFocus),
      clientPoint: {
        x: Number(detail.clientX),
        y: Number(detail.clientY),
      },
    });
  });

  documentRef.addEventListener("pointerdown", (event) => {
    if (
      payloadExpansionMenu &&
      !payloadExpansionMenu.contains(event.target)
    ) {
      closePayloadExpansionMenu();
    }
  });

  function ensureTabOpen(gologId = workspace.activeGologId) {
    if (!gologId || !workspace.gologs.has(gologId)) {
      return;
    }
    if (!openTabIds.includes(gologId)) {
      openTabIds.push(gologId);
    }
  }

  function ensureActiveTabOpen() {
    ensureTabOpen(workspace.activeGologId);
  }

  function closeGologTab(gologId) {
    if (!gologId || openTabIds.length <= 1) {
      return;
    }
    const index = openTabIds.indexOf(gologId);
    if (index < 0) {
      return;
    }
    openTabIds.splice(index, 1);
    if (workspace.activeGologId === gologId) {
      const fallbackId =
        openTabIds[Math.max(0, index - 1)] ?? openTabIds[0] ?? null;
      if (fallbackId) {
        openGolog(fallbackId);
        return;
      }
    }
    renderGologTabs();
  }

  function tabbedGologIdsForIphone() {
    return openTabIds.filter(
      (gologId) => workspace.gologs.has(gologId) && !modeHead.isMetaGolog(gologId),
    );
  }

  function gologTabSummary(golog) {
    const state = golog?.state ?? {};
    const nodeCount = state.spheres?.size ?? 0;
    const edgeCount = state.edges?.size ?? 0;
    const surfaceCount = state.surfaces?.size ?? 0;
    return `${nodeCount} nodes · ${edgeCount} edges · ${surfaceCount} surfaces`;
  }

  function setIphoneTabsOpen(open) {
    iphoneTabsOpen = Boolean(open) && usesIphonePresentation();
    renderIphoneTabSwitcher();
  }

  function renderIphoneTabSwitcher() {
    if (!iphoneTabsToggle || !iphoneTabSwitcher || !iphoneTabList) {
      return;
    }
    const iphone = usesIphonePresentation();
    const tabIds = tabbedGologIdsForIphone();
    iphoneTabsToggle.hidden = !iphone;
    iphoneTabsToggle.disabled = tabIds.length === 0;
    iphoneTabsToggle.setAttribute("aria-expanded", String(iphoneTabsOpen));
    iphoneTabsToggle.title =
      tabIds.length > 0 ? `Show ${tabIds.length} open gologs` : "No open golog tabs";
    if (!iphone) {
      iphoneTabsOpen = false;
    }
    iphoneTabSwitcher.hidden = !iphoneTabsOpen || !iphone;
    iphoneTabList.textContent = "";
    if (tabIds.length === 0) {
      const empty = documentRef.createElement("p");
      empty.className = "iphone-tab-empty";
      empty.textContent = "No ordinary gologs open.";
      iphoneTabList.appendChild(empty);
      return;
    }
    for (const gologId of tabIds) {
      const golog = workspace.gologs.get(gologId);
      if (!golog) {
        continue;
      }
      const isActive = golog.id === workspace.activeGologId;
      const entry = documentRef.createElement("button");
      entry.type = "button";
      entry.className = "iphone-tab-card";
      entry.dataset.gologId = golog.id;
      entry.setAttribute("aria-current", isActive ? "page" : "false");
      entry.setAttribute("aria-label", `Open ${golog.title}`);

      const picture = documentRef.createElement("span");
      picture.className = "iphone-tab-picture";
      picture.setAttribute("aria-hidden", "true");
      const nodeCount = Math.min(golog.state?.spheres?.size ?? 0, 9);
      const edgeCount = Math.min(golog.state?.edges?.size ?? 0, 9);
      const surfaceCount = Math.min(golog.state?.surfaces?.size ?? 0, 9);
      const dotPositions = [
        [22, 18],
        [54, 26],
        [36, 52],
        [72, 54],
        [18, 68],
        [64, 76],
        [78, 18],
        [40, 78],
        [16, 42],
      ];
      const linePositions = [
        [38, 23, 24],
        [47, 38, -28],
        [54, 62, 16],
        [30, 57, -38],
        [72, 38, 58],
        [28, 38, 4],
        [56, 78, -8],
        [72, 64, -48],
        [22, 75, 34],
      ];
      const facePositions = [
        [50, 52, -8],
        [33, 38, 22],
        [68, 64, -30],
        [68, 24, 34],
        [28, 70, -18],
        [48, 78, 12],
        [18, 28, -24],
        [78, 48, 18],
        [42, 20, -40],
      ];
      for (let index = 0; index < nodeCount; index += 1) {
        const dot = documentRef.createElement("span");
        dot.className = "iphone-tab-picture-dot";
        dot.style.left = `${dotPositions[index][0]}%`;
        dot.style.top = `${dotPositions[index][1]}%`;
        picture.appendChild(dot);
      }
      for (let index = 0; index < edgeCount; index += 1) {
        const line = documentRef.createElement("span");
        line.className = "iphone-tab-picture-line";
        line.style.left = `${linePositions[index][0]}%`;
        line.style.top = `${linePositions[index][1]}%`;
        line.style.transform = `translate(-50%, -50%) rotate(${linePositions[index][2]}deg)`;
        picture.appendChild(line);
      }
      for (let index = 0; index < surfaceCount; index += 1) {
        const face = documentRef.createElement("span");
        face.className = "iphone-tab-picture-face";
        face.style.left = `${facePositions[index][0]}%`;
        face.style.top = `${facePositions[index][1]}%`;
        face.style.transform = `translate(-50%, -50%) rotate(${facePositions[index][2]}deg)`;
        picture.appendChild(face);
      }

      const copy = documentRef.createElement("span");
      copy.className = "iphone-tab-card-copy";
      const title = documentRef.createElement("span");
      title.className = "iphone-tab-card-title";
      title.textContent = golog.title;
      const summary = documentRef.createElement("span");
      summary.className = "iphone-tab-card-summary";
      summary.textContent = gologTabSummary(golog);
      copy.append(title, summary);

      entry.addEventListener("click", () => {
        openGolog(golog.id);
        setIphoneTabsOpen(false);
      });
      entry.append(picture, copy);
      iphoneTabList.appendChild(entry);
    }
  }

  function renderGologTabs() {
    ensureActiveTabOpen();
    for (let index = openTabIds.length - 1; index >= 0; index -= 1) {
      if (!workspace.gologs.has(openTabIds[index])) {
        openTabIds.splice(index, 1);
      }
    }
    gologTabs.textContent = "";
    for (const gologId of openTabIds) {
      const golog = workspace.gologs.get(gologId);
      if (!golog) {
        continue;
      }
      const isActive = golog.id === workspace.activeGologId;
      const tab = documentRef.createElement("div");
      tab.className = "golog-tab";
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(isActive));
      tab.dataset.gologId = golog.id;
      const openButton = documentRef.createElement("button");
      openButton.type = "button";
      openButton.className = "golog-tab-main";
      openButton.textContent = golog.title;
      openButton.dataset.gologId = golog.id;
      const closeButton = documentRef.createElement("button");
      closeButton.type = "button";
      closeButton.className = "golog-tab-close";
      closeButton.textContent = "x";
      closeButton.setAttribute("aria-label", `Close ${golog.title}`);
      closeButton.disabled = openTabIds.length <= 1;
      tab.addEventListener("click", (event) => {
        if (gologTabs.dataset.dragScrolled === "true") {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        openGolog(golog.id);
      });
      closeButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        closeGologTab(golog.id);
      });
      tab.append(openButton, closeButton);
      gologTabs.appendChild(tab);
    }
    renderIphoneTabSwitcher();
  }

  function clearTabDrag() {
    tabDrag = null;
    gologTabs.classList.remove("is-dragging");
    window.setTimeout(() => {
      delete gologTabs.dataset.dragScrolled;
    }, 120);
  }

  gologTabs.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) {
      return;
    }

    tabDrag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startScrollLeft: gologTabs.scrollLeft,
      dragged: false,
    };
  });

  gologTabs.addEventListener("pointermove", (event) => {
    if (!tabDrag || event.pointerId !== tabDrag.pointerId) {
      return;
    }

    const deltaX = event.clientX - tabDrag.startX;
    if (!tabDrag.dragged && Math.abs(deltaX) < 4) {
      return;
    }

    event.preventDefault();
    tabDrag.dragged = true;
    if (!gologTabs.hasPointerCapture(event.pointerId)) {
      gologTabs.setPointerCapture(event.pointerId);
    }
    gologTabs.dataset.dragScrolled = "true";
    gologTabs.classList.add("is-dragging");
    gologTabs.scrollLeft = tabDrag.startScrollLeft - deltaX;
  });

  gologTabs.addEventListener("pointerup", (event) => {
    if (tabDrag?.pointerId !== event.pointerId) {
      return;
    }
    if (gologTabs.hasPointerCapture(event.pointerId)) {
      gologTabs.releasePointerCapture(event.pointerId);
    }
    clearTabDrag();
  });

  gologTabs.addEventListener("pointercancel", (event) => {
    if (tabDrag?.pointerId !== event.pointerId) {
      return;
    }
    clearTabDrag();
  });

  simplexNameInput.addEventListener("input", () => {
    if (selectedSimplexId && bus && state && modeHead.canRename(state.gologId)) {
      bus.emit("simplex:rename", {
        id: selectedSimplexId,
        name: simplexNameInput.value,
      });
      if (editedLabelId === selectedSimplexId && sceneLabelEditor) {
        sceneLabelEditor.value = simplexNameInput.value;
        resizeSceneLabelEditor();
        positionSceneLabelEditor();
      }
    }
  });

  payloadAddText.addEventListener("click", () => {
    if (selectedSimplexId && bus && modeHead.canAttachPayload(state.gologId)) {
      selectedPayloadKey = "markdown";
      bus.emit("payload:text-add", {
        id: selectedSimplexId,
        text: "",
      });
      requestAnimationFrame(() => payloadTextEditor.focus());
    }
  });

  payloadAddLatex.addEventListener("click", () => {
    if (selectedSimplexId && bus && state && modeHead.canAttachPayload(state.gologId)) {
      selectedPayloadKey = "latex";
      bus.emit("payload:typed-add", {
        id: selectedSimplexId,
        payload: {
          type: PAYLOAD_TYPES.LATEX,
          text: "",
          documentKind: "snippet",
          title: "",
          latexUrl: "",
          imageUrl: "",
          imageDataUrl: "",
          pdfUrl: "",
        },
      });
      requestAnimationFrame(() => payloadLatexEditor.focus());
    }
  });

  payloadAddCode.addEventListener("click", () => {
    if (selectedSimplexId && bus && state && modeHead.canAttachPayload(state.gologId)) {
      selectedPayloadKey = "code";
      bus.emit("payload:typed-add", {
        id: selectedSimplexId,
        payload: {
          type: codePayloadType("javascript"),
          language: "javascript",
          text: "",
        },
      });
      requestAnimationFrame(() => payloadCodeEditor.focus());
    }
  });

  payloadAddImage.addEventListener("click", () => {
    if (selectedSimplexId && state && modeHead.canAttachPayload(state.gologId)) {
      selectedPayloadKey = "image";
      payloadImageInput.value = "";
      payloadImageInput.click();
    }
  });

  payloadAddUrl.addEventListener("click", () => {
    if (selectedSimplexId && bus && state && modeHead.canAttachPayload(state.gologId)) {
      selectedPayloadKey = "url";
      bus.emit("payload:typed-add", {
        id: selectedSimplexId,
        payload: {
          type: PAYLOAD_TYPES.URL,
          url: "",
          title: "",
          description: "",
        },
      });
      requestAnimationFrame(() => payloadUrlInput.focus());
    }
  });

  payloadAddGolog.addEventListener("click", async () => {
    if (
      !selectedSimplexId ||
      !state ||
      !state.hasSelectableSimplex(selectedSimplexId) ||
      !modeHead.canAttachPayload(state.gologId)
    ) {
      return;
    }
    expansionStatus.hidden = true;
    expansionStatus.style.display = "none";
    const parentGologId = state.gologId;
    const objectId = selectedSimplexId;
    payloadAddGolog.disabled = true;
    try {
      const child = await (createChildGologForObject
        ? createChildGologForObject({ parentGologId, objectId })
        : createChildGologForSphere({ parentGologId, sphereId: objectId }));
      if (child && state?.gologId === parentGologId && selectedSimplexId === objectId) {
        selectedPayloadKey = "nested-golog";
        bindPayloadPreview(child.id);
        renderPayloadPanel(state.getObject(selectedSimplexId));
      }
    } catch (error) {
      expansionStatus.textContent = `Expansion failed: ${error.message}`;
      expansionStatus.hidden = false;
      expansionStatus.style.display = "block";
    } finally {
      payloadAddGolog.disabled = false;
    }
  });

  payloadAssociateGolog.addEventListener("click", () => {
    if (
      !selectedSimplexId ||
      !state ||
      !state.hasSelectableSimplex(selectedSimplexId) ||
      !modeHead.canAttachPayload(state.gologId)
    ) {
      return;
    }
    expansionStatus.hidden = true;
    expansionStatus.style.display = "none";
    startGologAssociation({
      sourceGologId: state.gologId,
      sourceObjectId: selectedSimplexId,
    });
  });

  deleteObjectPlan?.addEventListener("click", () => {
    if (
      !selectedSimplexId ||
      !state ||
      !agentApi ||
      !modeHead.canDeleteObject?.(state.gologId)
    ) {
      return;
    }
    try {
      pendingDeletePlan = agentApi.deleteObject({
        gologId: state.gologId,
        objectId: selectedSimplexId,
        cascade: "recursive",
      });
      setDeleteWarning(`${pendingDeletePlan.warning} Press Confirm Delete.`);
      if (deleteObjectConfirm) {
        deleteObjectConfirm.hidden = false;
      }
    } catch (error) {
      pendingDeletePlan = null;
      setDeleteWarning(`Delete preview failed: ${error.message}`);
      if (deleteObjectConfirm) {
        deleteObjectConfirm.hidden = true;
      }
    }
  });

  deleteObjectConfirm?.addEventListener("click", () => {
    if (
      !pendingDeletePlan ||
      !state ||
      !agentApi ||
      !modeHead.canDeleteObject?.(state.gologId)
    ) {
      return;
    }
    const { objectId, warning } = pendingDeletePlan;
    try {
      const result = agentApi.deleteObject({
        gologId: state.gologId,
        objectId,
        cascade: "recursive",
        dryRun: false,
        confirmed: true,
      });
      pendingDeletePlan = null;
      setDeleteWarning(result.warning ?? warning ?? "Deleted.");
      if (deleteObjectConfirm) {
        deleteObjectConfirm.hidden = true;
      }
    } catch (error) {
      setDeleteWarning(`Delete failed: ${error.message}`);
    }
  });

  payloadTextEditor.addEventListener("input", () => {
    if (selectedSimplexId && bus && modeHead.canEditPayload(state.gologId)) {
      if (payloadTextEditor.dataset.payloadType === PAYLOAD_TYPES.LATEX) {
        emitTypedPayload({
          type: PAYLOAD_TYPES.LATEX,
          text: payloadTextEditor.value,
        });
        return;
      }
      bus.emit("payload:text-update", {
        id: selectedSimplexId,
        text: payloadTextEditor.value,
      });
    }
  });

  payloadLatexEditor.addEventListener("input", () => {
    if (!selectedSimplexId || !state || !modeHead.canEditPayload(state.gologId)) {
      return;
    }
    const payload =
      state.getPayloadByKind?.(selectedSimplexId, "latex") ??
      activePayloadForObject(selectedSimplexId);
    if (payload?.type !== PAYLOAD_TYPES.LATEX) {
      return;
    }
    emitTypedPayload({
      ...payload,
      text: payloadLatexEditor.value,
      latexUrl: "",
      imageUrl: "",
      imageDataUrl: "",
      pdfUrl: "",
    });
    payloadOpenLatexSource.disabled = true;
    payloadOpenLatexSource.dataset.url = "";
    payloadOpenLatexPdf.disabled = true;
    payloadOpenLatexPdf.dataset.url = "";
    renderLatexPreview(
      "",
      payloadLatexEditor.value ? "Uncompiled changes." : "Empty LaTeX source.",
    );
    setLatexStatus(serverLatexCompile ? "Uncompiled changes." : STATIC_LATEX_COMPILE_MESSAGE);
  });

  async function readLatexCompileResult(response) {
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return response.json();
    }
    const text = (await response.text()).trim();
    return {
      ok: false,
      error: text || `LaTeX compile request failed with HTTP ${response.status}`,
    };
  }

  payloadCompileLatex.addEventListener("click", async () => {
    if (!serverLatexCompile) {
      setLatexStatus(STATIC_LATEX_COMPILE_MESSAGE);
      return;
    }
    if (!selectedSimplexId || !state || !modeHead.canEditPayload(state.gologId)) {
      return;
    }
    const payload =
      state.getPayloadByKind?.(selectedSimplexId, "latex") ??
      activePayloadForObject(selectedSimplexId);
    if (payload?.type !== PAYLOAD_TYPES.LATEX) {
      return;
    }

    const source = payloadLatexEditor.value;
    payloadCompileLatex.disabled = true;
    setLatexStatus("Compiling PNG...");
    try {
      const nextPayload = await compileLatexPayloadSource(payload, source);
      const renderUrl =
        nextPayload.imageDataUrl || nextPayload.imageUrl || nextPayload.pdfUrl || "";
      emitTypedPayload(nextPayload);
      payloadOpenLatexSource.disabled = !nextPayload.latexUrl;
      payloadOpenLatexSource.dataset.url = nextPayload.latexUrl ?? "";
      payloadOpenLatexPdf.disabled = !renderUrl;
      payloadOpenLatexPdf.dataset.url = renderUrl;
      renderLatexPreview(renderUrl);
      setLatexStatus("Compiled cropped PNG.");
    } catch (error) {
      setLatexStatus(error.message);
    } finally {
      if (serverLatexCompile && state && modeHead.canEditPayload(state.gologId)) {
        payloadCompileLatex.disabled = false;
      }
    }
  });

  function openPayloadUrl(button) {
    const url = openablePayloadUrl(button.dataset.url);
    if (!url) {
      return;
    }
    documentRef.defaultView?.open(url, "_blank", "noopener,noreferrer");
  }

  payloadOpenLatexSource.addEventListener("click", () => {
    openPayloadUrl(payloadOpenLatexSource);
  });

  payloadOpenLatexPdf.addEventListener("click", () => {
    openPayloadUrl(payloadOpenLatexPdf);
  });

  payloadCodeEditor.addEventListener("input", () => {
    emitTypedPayload({
      type: codePayloadType(payloadCodeLanguage.value),
      language: payloadCodeLanguage.value,
      text: payloadCodeEditor.value,
    });
  });

  payloadCodeLanguage.addEventListener("change", () => {
    emitTypedPayload({
      type: codePayloadType(payloadCodeLanguage.value),
      language: payloadCodeLanguage.value,
      text: payloadCodeEditor.value,
    });
  });

  payloadImageAlt.addEventListener("input", () => {
    const payload =
      selectedSimplexId && state
        ? (state.getPayloadByKind?.(selectedSimplexId, "image") ??
            activePayloadForObject(selectedSimplexId))
        : null;
    if (payloadKind(payload) !== "image") {
      return;
    }
    emitTypedPayload({
      ...payload,
      alt: payloadImageAlt.value,
    });
  });

  payloadImageReplace.addEventListener("click", () => {
    if (selectedSimplexId && state && modeHead.canEditPayload(state.gologId)) {
      payloadImageInput.value = "";
      payloadImageInput.click();
    }
  });

  payloadImageInput.addEventListener("change", () => {
    const file = payloadImageInput.files?.[0];
    if (!file || !selectedSimplexId || !bus || !state) {
      return;
    }
    const existing = state.getPayloadByKind?.(selectedSimplexId, "image") ?? null;
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      selectedPayloadKey = "image";
      const payload = {
        type: imagePayloadType(file.type || "image/png"),
        mimeType: file.type || "image/png",
        src: String(reader.result ?? ""),
        alt: existing?.alt ?? "",
        name: file.name,
      };
      bus.emit(existing ? "payload:typed-update" : "payload:typed-add", {
        id: selectedSimplexId,
        payload,
      });
    });
    reader.readAsDataURL(file);
  });

  function emitUrlPayload() {
    const payload =
      selectedSimplexId && state
        ? (state.getPayloadByKind?.(selectedSimplexId, "url") ??
            activePayloadForObject(selectedSimplexId))
        : null;
    if (payloadKind(payload) !== "url") {
      return;
    }
    const nextPayload = {
      ...payload,
      url: payloadUrlInput.value,
      title: payloadUrlTitle.value,
    };
    payloadOpenUrl.disabled = !openablePayloadUrl(nextPayload.url);
    payloadOpenUrl.dataset.url = openablePayloadUrl(nextPayload.url);
    emitTypedPayload(nextPayload);
  }

  payloadUrlInput.addEventListener("input", emitUrlPayload);
  payloadUrlTitle.addEventListener("input", emitUrlPayload);
  payloadOpenUrl.addEventListener("click", () => {
    openPayloadUrl(payloadOpenUrl);
  });

  payloadOpenGolog.addEventListener("click", () => {
    const gologId = payloadOpenGolog.dataset.gologId;
    if (gologId) {
      openGolog(gologId);
    }
  });

  payloadExpandAllMedia?.addEventListener("click", () => {
    expandAllPayloadMedia();
  });

  shortcutButtons.get("payload-media")?.addEventListener("click", () => {
    expandAllPayloadMedia();
  });

  shortcutButtons.get("force")?.addEventListener("click", () => {
    toggleForceLayout();
  });

  for (const input of forceControlInputs) {
    input.addEventListener("input", () => {
      const setting = input.dataset.forceSetting;
      if (!setting || !liveForceLayout) {
        return;
      }
      if (forceDefaultsStatus) {
        forceDefaultsStatus.value = "";
        forceDefaultsStatus.textContent = "";
      }
      updateForceLayoutControls(
        liveForceLayout.setSettings({ [setting]: Number(input.value) }),
      );
    });
  }

  forceDefaultsCommit?.addEventListener("click", () => {
    const result = liveForceLayout?.commitSettingsAsDefaults?.();
    if (!result) {
      return;
    }
    updateForceLayoutControls(result.snapshot ?? liveForceLayout.snapshot());
    if (forceDefaultsStatus) {
      forceDefaultsStatus.value = result.ok ? "Saved" : "Unavailable";
      forceDefaultsStatus.textContent = forceDefaultsStatus.value;
    }
  });

  shortcutHintsCollapse?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    setPanelCollapsed("shortcuts", true);
  });

  statusPanelCollapse?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    setPanelCollapsed("status", true);
  });

  iphoneSelectionPaneExpand?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    setPanelCollapsed("status", false);
  });

  iphoneSelectionPaneCollapse?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    setPanelCollapsed("status", true);
  });

  debugPanelCollapse?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    setPanelCollapsed("debug", true);
  });

  toggleUiPanelsButton?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleAllUiPanels();
  });

  iphoneDragModeToggle?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    updateIphoneDragModeToggle(scene?.toggleIphoneTouchDragMode?.());
  });

  iphoneTabsToggle?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    setIphoneTabsOpen(!iphoneTabsOpen);
  });

  iphoneTabsClose?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    setIphoneTabsOpen(false);
  });

  shortcutButtons.get("save")?.addEventListener("click", () => {
    saveWorkspace();
  });

  workspaceSaveServer?.addEventListener("click", () => {
    saveWorkspaceToServer({ createIfMissing: true });
  });

  devReloadRestore?.addEventListener("click", () => {
    devReloadWithRestore?.();
  });

  shortcutButtons.get("load")?.addEventListener("click", () => {
    openWorkspaceLoadChooser();
  });

  shortcutButtons.get("labels")?.addEventListener("click", () => {
    toggleLabels();
  });

  documentRef.addEventListener("keydown", handleShortcutKeyDown, {
    capture: true,
  });

  hostedWorkspaceLoad?.addEventListener("click", () => {
    const entry = hostedWorkspaces.find(
      (workspaceEntry) => workspaceEntry.id === hostedWorkspaceSelect.value,
    );
    loadHostedWorkspace(entry);
  });

  workspaceLoadFile?.addEventListener("click", () => {
    workspaceLoadPopover.hidden = true;
    scheduleRightUiStackUpdate();
    openWorkspaceFilePicker();
  });

  workspaceLoadInput.addEventListener("change", async () => {
    const file = workspaceLoadInput.files?.[0];
    if (!file) {
      return;
    }

    try {
      workspaceLoadInput.disabled = true;
      workspaceIoStatus.textContent = sharedWorkspaceLoad ? "Loading shared workspace for everyone…" : "Loading workspace…";
      const text = await file.text();
      const document = await loadWorkspaceDocumentText(text);
      currentHostedWorkspaceId = null;
      finishWorkspaceLoad(document, file.name);
    } catch (error) {
      workspaceIoStatus.textContent = `Load failed: ${error.message}`;
    } finally {
      workspaceLoadInput.disabled = false;
      workspaceLoadInput.value = "";
    }
  });

  createGologButton.addEventListener("click", async () => {
    const structureId = newGologStructure?.value ?? "hierarchical-theta-space";
    createGologButton.disabled = true;
    expansionStatus.hidden = true;
    expansionStatus.style.display = "none";
    try {
      await createGolog({
        activate: true,
        structureId,
        title:
          structureId === "virtual-double-category"
            ? "Virtual Double Category"
            : null,
      });
    } catch (error) {
      expansionStatus.textContent = `Create golog failed: ${error.message}`;
      expansionStatus.hidden = false;
      expansionStatus.style.display = "block";
    } finally {
      createGologButton.disabled = false;
    }
  });

  for (const button of virtualArrowButtons) {
    button.addEventListener("click", () => {
      modeHead.setVirtualArrowKind?.(
        button.dataset.virtualArrowKind === "tight"
          ? VIRTUAL_DOUBLE_ELEMENT_KINDS.TIGHT_ARROW
          : VIRTUAL_DOUBLE_ELEMENT_KINDS.PROARROW,
      );
    });
  }

  virtualCellCapture?.addEventListener("click", () => {
    bus?.emit("virtual-cell:capture-toggle", {});
  });

  openMetaGologButton.addEventListener("click", () => {
    openMetaGolog();
  });

  gologNavBack?.addEventListener("click", () => {
    navigateBackGolog();
  });

  gologNavForward?.addEventListener("click", () => {
    navigateForwardGolog();
  });

  workspace.bus.on("workspace:changed", (snapshot) => {
    if (workspace.gologs.size === 0) {
      openTabIds.length = 0;
    }
    renderGologTabs();
    updateGologNavigationControls();
  });
  workspace.bus.on("workspace:replaced", ({ document }) => finishWorkspaceLoad(document, "shared workspace"));
  workspace.bus.on("workspace:operation-rejected", ({ reason }) => {
    workspaceIoStatus.textContent = reason === "workspace-replacement-in-progress"
      ? "An edit was cancelled while the shared workspace was loading"
      : "An edit to the previous workspace was cancelled";
  });
  workspace.bus.on("workspace:active-changed", ({ golog }) => {
    ensureTabOpen(golog?.id);
    renderGologTabs();
    bindActiveGolog(golog);
  });
  workspace.bus.on("workspace:navigation-changed", (navigation) =>
    updateGologNavigationControls(navigation),
  );
  workspace.bus.on("workspace:history-changed", (summary) =>
    updateHistoryControls(summary),
  );
  workspace.bus.on("mode:changed", (snapshot) => applyModeSnapshot(snapshot));
  documentRef.defaultView?.addEventListener("resize", scheduleRightUiStackUpdate);

  applyPanelCollapseState();
  renderGologTabs();
  bindActiveGolog(workspace.activeGolog());
  applyModeSnapshot(modeHead.snapshot());
  updateForceLayoutControls();
  updateGologNavigationControls();
  updateHistoryControls();
  updateSaveShortcutTitle();
  scheduleRightUiStackUpdate();
}
