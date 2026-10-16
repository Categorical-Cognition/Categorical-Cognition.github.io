import * as THREE from "three";
import { appendPdfPreview, safePayloadPreviewUrl } from "./payload-preview.js";
import {
  makePlaneBasisFromNormal as calculatePlaneBasisFromNormal,
} from "./geometry-utils.js";
import { EdgeBatchRenderer } from "./edge-batch-renderer.js";
import { SurfaceBatchRenderer } from "./surface-batch-renderer.js";
import {
  EdgeRenderAdapter,
  LabelRenderAdapter,
  SphereRenderAdapter,
  SurfaceRenderAdapter,
  VolumeRenderAdapter,
} from "./scene-render-adapters.js";
import {
  disposeObject3D,
  NestedGologContentRenderer,
} from "./nested-golog-renderer.js";
import {
  ELEMENT_KINDS,
  VIRTUAL_DOUBLE_ELEMENT_KINDS,
} from "./element-registry.js";

const CAMERA_DISTANCE = 18;
const CAMERA_MOVE_SPEED = 27;
const CAMERA_MAX_FRAME_SECONDS = 0.1;
const CAMERA_ORBIT_SPEED_DEFAULT = 6.65;
const CAMERA_DRAG_SPEED_DEFAULT = 4.2;
const CAMERA_CONTROL_SPEED_MIN = 0.1;
const CAMERA_CONTROL_SPEED_MAX = 8;
const CAMERA_DRAG_MODE_LOOK = "look";
const CAMERA_DRAG_MODE_ORBIT = "orbit";
const CAMERA_DRAG_MODE_DEFAULT = CAMERA_DRAG_MODE_LOOK;
const IPHONE_TOUCH_DRAG_MODE_INSPECT = "inspect";
const IPHONE_TOUCH_DRAG_MODE_TRAVEL = "travel";
const IPHONE_TOUCH_DRAG_MODE_CREATE = "create";
const IPHONE_TOUCH_DRAG_MODE_VIEW = IPHONE_TOUCH_DRAG_MODE_INSPECT;
const IPHONE_TOUCH_DRAG_MODE_ORDER = [
  IPHONE_TOUCH_DRAG_MODE_INSPECT,
  IPHONE_TOUCH_DRAG_MODE_TRAVEL,
  IPHONE_TOUCH_DRAG_MODE_CREATE,
];
const MAX_CAMERA_PITCH = Math.PI / 2 - 0.04;
const CAMERA_MIN_FOCUS_DISTANCE = 0.8;
const SELECTION_SPHERE_RADIUS = 20;
const IPHONE_TWIST_CAMERA_SPEED = 1;
const NESTED_PREVIEW_RADIUS = 2.7;
const DRAG_RAYCAST_EPSILON = 1e-6;
const DRAG_SHALLOW_ANGLE_SIN = 0.08;
const EDGE_PLANE_SHALLOW_ANGLE_SIN = 0.16;
const POINTER_CLICK_DRAG_THRESHOLD = 4;
const IPHONE_DOUBLE_TAP_MS = 320;
const IPHONE_DOUBLE_TAP_RADIUS = 30;
const IPHONE_PINCH_ZOOM_SPEED = 0.025;
const IPHONE_TWO_FINGER_PAN_SPEED = 1;
const IPHONE_KEYBOARD_MIN_OCCLUSION = 80;
const IPHONE_KEYBOARD_OPEN_RATIO = 0.75;
const WORLD_UP = new THREE.Vector3(0, 0, 1);
const SELECTABLE_DISTANCE_EPSILON = 1e-6;
const DRAG_INTERACTION_AUTHORITY_TTL_MS = 12_000;
const DRAG_INTERACTION_AUTHORITY_RENEW_MS = 4_000;

const PAYLOAD_BILLBOARD_NODE_SCALE = 0.22;
const PAYLOAD_BILLBOARD_FALLBACK_WORLD_RADIUS = 1.2;
const PAYLOAD_BILLBOARD_MAX_PIXEL_WIDTH = 560;
const PAYLOAD_BILLBOARD_MAX_PIXEL_HEIGHT = 360;
const PAYLOAD_BILLBOARD_MAX_VIEWPORT_FRACTION = 0.42;
const PAYLOAD_BILLBOARD_Z_BASE = 12000;
const CENTER_INTEREST_MARKER_RADIUS = 0.08;

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function restoreVector3(vector, value) {
  if (!Array.isArray(value) || value.length !== 3) {
    return false;
  }
  const coordinates = value.map(Number);
  if (!coordinates.every(Number.isFinite)) {
    return false;
  }
  vector.set(...coordinates);
  return true;
}

export class GologScene {
  constructor({
    bus,
    state,
    container,
    client,
    modeHead = null,
    active = true,
    createPreviewForceUniverse = null,
  }) {
    this.bus = bus;
    this.state = state;
    this.modeHead = modeHead;
    this.container = container;
    this.active = active;
    this.client =
      client ??
      {
        id: globalThis.crypto?.randomUUID?.() ?? `client-${Date.now()}`,
        ip: "local-browser",
      };
    this.edgeBatchRenderer = null;
    this.surfaceBatchRenderer = null;
    this.sphereRenderer = null;
    this.labelRenderer = null;
    this.edgeRenderer = null;
    this.surfaceRenderer = null;
    this.volumeRenderer = null;
    this.nestedPreviews = new Map();
    this.nestedPreview = null;
    this.payloadBillboardPreview = null;
    this.payloadBillboardPreviews = new Map();
    this.nodeExpansionSequence = 0;
    this.nestedPreviewRenderer = new NestedGologContentRenderer();

    this.createPreviewForceUniverse = createPreviewForceUniverse;
    this.previewForceUniverse = null;
    this.selectionBuffer = [];
    this.virtualCellCapture = { active: false, edgeIds: [] };
    this.selectionPairActions = this.createSelectionPairActions();
    this.labelsVisible = true;
    this.drag = null;
    this.pendingPointer = null;
    this.lastIphoneTap = null;
    this.iphonePointers = new Map();
    this.iphoneMultiTouch = null;
    this.iphoneTouchDragMode = IPHONE_TOUCH_DRAG_MODE_INSPECT;
    this.iphoneModeBeforeNodeSelection = null;
    this.iphoneCreationDrag = null;
    this.iphoneCreationTrailOverlay = null;
    this.iphoneCreationTrailPolyline = null;
    this.centerInterestPoint = null;
    this.centerInterestMarker = null;
    this.disposed = false;
    this.lastAnimationTime = null;
    this.releaseInputListeners = [];
    this.iphoneStableRenderSize = null;
    this.iphoneKeyboardViewportIntent = false;
    this.iphoneKeyboardOpen = false;
    this.iphoneLastKeyboardOcclusion = 0;
    this.cameraViewportState = {
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      fullWidth: 1,
      fullHeight: 1,
      keyboardOcclusion: 0,
      keyboardPredicted: false,
      keyboardMeasured: false,
    };
    this.keys = new Set();
    this.pointer = new THREE.Vector2();
    this.lastPointerClient = null;
    this.raycaster = new THREE.Raycaster();
    this.cameraFrame = this.createCameraFrame();
    this.cameraAngles = {
      yaw: 0,
      pitch: Math.asin(-8 / Math.sqrt(CAMERA_DISTANCE ** 2 + 8 ** 2)),
    };
    this.cameraRoll = 0;
    this.cameraFocusDistance = CAMERA_DISTANCE;
    this.cameraOrbitSpeed = CAMERA_ORBIT_SPEED_DEFAULT;
    this.cameraDragSpeed = CAMERA_DRAG_SPEED_DEFAULT;
    this.cameraDragMode = CAMERA_DRAG_MODE_DEFAULT;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x111722);

    this.cameraRig = new THREE.Group();
    this.cameraRig.position.set(0, 0, 0);
    this.scene.add(this.cameraRig);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
    this.camera.up.copy(WORLD_UP);
    this.camera.position.set(0, -CAMERA_DISTANCE, 8);
    this.cameraFocusDistance = this.camera.position.length();
    this.updateCameraOrientation();
    this.cameraRig.add(this.camera);

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight, false);
    this.renderer.domElement.tabIndex = 0;
    this.renderer.domElement.dataset.gologId = state.gologId;
    this.renderer.domElement.hidden = !active;
    this.renderer.domElement.style.display = active ? "block" : "none";
    this.renderer.domElement.classList.toggle("golog-scene-hidden", !active);
    container.appendChild(this.renderer.domElement);
    this.createIphoneCreationTrailOverlay();

    this.scene.add(new THREE.HemisphereLight(0xd8f2ff, 0x1c2636, 2.3));
    const key = new THREE.DirectionalLight(0xffffff, 2.1);
    key.position.set(8, -10, 14);
    this.scene.add(key);

    this.scene.add(this.createOriginMarker());
    this.centerInterestMarker = this.createCenterInterestMarker();
    this.scene.add(this.centerInterestMarker);
    this.scene.add(this.createAxisLines());
    this.gologContent = new THREE.Group();
    this.gologContent.name = "golog-content";
    this.scene.add(this.gologContent);
    const getRenderProfile = () => this.currentRenderProfile();

    this.surfaceBatchRenderer = new SurfaceBatchRenderer({
      scene: this.gologContent,
    });
    this.edgeBatchRenderer = new EdgeBatchRenderer({
      scene: this.gologContent,
    });
    this.sphereRenderer = new SphereRenderAdapter({
      scene: this.gologContent,
      state: this.state,
      getRenderProfile,
    });
    this.labelRenderer = new LabelRenderAdapter({ scene: this.gologContent });
    this.edgeRenderer = new EdgeRenderAdapter({
      scene: this.gologContent,
      state: this.state,
      batchRenderer: this.edgeBatchRenderer,
      getRenderProfile,
    });
    this.surfaceRenderer = new SurfaceRenderAdapter({
      scene: this.gologContent,
      state: this.state,
      batchRenderer: this.surfaceBatchRenderer,
      getRenderProfile,
    });
    this.volumeRenderer = new VolumeRenderAdapter({
      scene: this.gologContent,
      state: this.state,
      onStatus: (status) => this.bus.emit("render:volume-status", status),
    });
    this.sphereMeshes = this.sphereRenderer.meshes;
    this.objectLabels = this.labelRenderer.labels;
    this.edgeGraphics = this.edgeRenderer.graphics;
    this.surfaceGraphics = this.surfaceRenderer.graphics;
    this.volumeGraphics = this.volumeRenderer.graphics;

    this.bus.on("render:sphere-created", ({ id, position }) => {
      this.sphereRenderer.add(id, position);
      if (this.state.selectedSphereId === id) {
        this.applyIphoneSphereSelectionState(id);
      }
    });
    this.bus.on("render:sphere-selected", ({ id }) => {
      this.sphereRenderer.updateSelection(id);
      this.applyIphoneSphereSelectionState(id);
    });
    this.bus.on("render:sphere-moved", ({ id, position }) =>
      this.moveSphereMesh(id, position),
    );
    this.bus.on("render:sphere-moved", ({ id }) =>
      {
        this.edgeRenderer.updateConnectedToSphere(id);

      },
    );
    this.bus.on("store:object-upserted", (record) => {
      this.labelRenderer.sync(record);
      if (record.kind === "volume") this.volumeRenderer.update(record.id);
      else this.volumeRenderer.updateDependingOn(record.id);
      this.updateNestedPreviewTransform();
      this.updateModeLabelFilter();
    });
    this.bus.on("store:object-deleted", (record) => {
      if (this.nestedPreviews.has(record.id)) {
        this.closeNestedGologPreview(record.id);
      }
      if (this.payloadBillboardPreview?.objectId === record.id) {
        this.closePayloadBillboardPreview();
      }
      for (const [key, batchBillboard] of this.payloadBillboardPreviews.entries()) {
        if (batchBillboard.objectId === record.id) {
          batchBillboard.element.remove();
          this.payloadBillboardPreviews.delete(key);
        }
      }
      this.labelRenderer.remove(record.id);
      if (record.kind === "volume") this.volumeRenderer.remove(record.id);
      else this.volumeRenderer.updateDependingOn(record.id);
      this.updateModeLabelFilter();
    });
    this.bus.on("render:edge-created", (edge) => {
      this.edgeRenderer.add(edge);
      this.updateModeLabelFilter();
    });
    this.bus.on("render:edge-deleted", ({ id }) => {
      this.edgeRenderer.remove(id);
      this.updateModeLabelFilter();
    });
    this.bus.on("render:edge-selected", ({ id }) => {
      this.updateConeSelection(id);
      this.updateModeLabelFilter();
    });
    this.bus.on("render:edge-midpoint-moved", (edge) => {
      this.edgeRenderer.updatePayload(edge);
      this.updateNestedPreviewTransform(edge.id);
      if (this.payloadBillboardPreview?.objectId === edge.id) {
        this.updatePayloadBillboardPreviewTransform();
      }

    });
    this.bus.on("render:surface-created", (surface) =>
      this.surfaceRenderer.add(surface),
    );
    this.bus.on("render:surface-deleted", ({ id }) =>
      this.surfaceRenderer.remove(id),
    );
    this.bus.on("render:surface-updated", (surface) => {
      this.surfaceRenderer.update(surface.id, surface);
      this.updateNestedPreviewTransform(surface.id);
      if (this.payloadBillboardPreview?.objectId === surface.id) {
        this.updatePayloadBillboardPreviewTransform();
      }
    });
    this.bus.on("render:surface-selected", ({ id }) => {
      this.updateSurfaceControlSelection(id);
      this.updateModeLabelFilter();
    });
    this.bus.on("render:volume-created", (volume) => this.volumeRenderer.add(volume));
    this.bus.on("render:volume-updated", (volume) => {
      this.volumeRenderer.update(volume.id);
      this.updateNestedPreviewTransform(volume.id);
      if (this.payloadBillboardPreview?.objectId === volume.id) {
        this.updatePayloadBillboardPreviewTransform();
      }
    });
    this.bus.on("render:volume-deleted", ({ id }) => this.volumeRenderer.remove(id));
    this.bus.on("render:volume-selected", ({ id }) => {
      this.volumeRenderer.updateSelection(id);
      this.updateModeLabelFilter();
    });
    this.bus.on("virtual-cell:capture-toggle", () =>
      this.toggleVirtualCellCapture(),
    );
    this.bus.on("virtual-cell:cancel", () => this.cancelVirtualCellCapture());

    this.hydrateFromState();
    this.attachInput();
    this.updateCameraFrame();
    this.resize();
    this.animate();
  }

  hydrateFromState() {
    const snapshot = this.state.snapshot();

    for (const sphere of snapshot.spheres) {
      this.sphereRenderer.add(sphere.id, sphere.position);
    }
    for (const edge of snapshot.edges) {
      this.edgeRenderer.add(edge);
    }
    for (const surface of snapshot.surfaces) {
      this.surfaceRenderer.add(surface);
    }
    for (const volume of snapshot.volumes ?? []) this.volumeRenderer.add(volume);
    for (const record of snapshot.objects) {
      this.labelRenderer.sync(record);
    }

    this.sphereRenderer.updateSelection(snapshot.selectedSphereId);
    this.edgeRenderer.updateSelection(snapshot.selectedSimplexId);
    this.surfaceRenderer.updateSelection(snapshot.selectedSimplexId);
    this.volumeRenderer.updateSelection(snapshot.selectedSimplexId);
    this.updateModeLabelFilter();
  }

  setActive(active) {
    if (this.active === active) {
      return;
    }

    this.active = active;
    this.renderer.domElement.hidden = !active;
    this.renderer.domElement.style.display = active ? "block" : "none";
    this.renderer.domElement.classList.toggle("golog-scene-hidden", !active);
    if (!active) {
      this.clearKeys();
      this.releaseDragAuthority(this.drag);
      this.drag = null;
      this.pendingPointer = null;
      this.cancelIphoneCreationDrag();
      this.clearIphoneTouchGesture();
      this.closeNestedGologPreview();
      this.closePayloadBillboardPreview();
      this.closePayloadBillboardPreviews();

      return;
    }

    this.resize();
    this.updateCameraFrame();
    this.emitCameraState();
    this.renderer.domElement.focus();
  }

  dispose() {
    this.disposed = true;
    this.clearKeys();
    this.releaseDragAuthority(this.drag);
    this.drag = null;
    this.pendingPointer = null;
    this.lastIphoneTap = null;
    this.cancelIphoneCreationDrag();
    this.clearIphoneTouchGesture();
    this.closeNestedGologPreview();
    this.closePayloadBillboardPreview();
    this.closePayloadBillboardPreviews();

    this.iphoneCreationTrailOverlay?.remove();
    this.iphoneCreationTrailOverlay = null;
    this.iphoneCreationTrailPolyline = null;
    this.previewForceUniverse?.dispose();
    this.previewForceUniverse = null;
    for (const release of this.releaseInputListeners) {
      release();
    }
    this.releaseInputListeners = [];
    this.sphereRenderer?.dispose();
    this.labelRenderer?.dispose();
    this.edgeRenderer?.dispose();
    this.surfaceRenderer?.dispose();
    this.volumeRenderer?.dispose();
    this.edgeBatchRenderer?.dispose();
    this.surfaceBatchRenderer?.dispose();
    this.renderer.domElement.remove();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }

  createCameraFrame() {
    return {
      origin: new THREE.Vector3(),
      right: new THREE.Vector3(1, 0, 0),
      up: new THREE.Vector3(0, 1, 0),
      forward: new THREE.Vector3(0, 0, -1),
    };
  }

  createOriginMarker() {
    const geometry = new THREE.TorusGeometry(0.72, 0.035, 10, 56);
    const material = new THREE.MeshBasicMaterial({ color: 0xf0e08a });
    const marker = new THREE.Mesh(geometry, material);
    marker.rotation.x = Math.PI / 2;
    marker.name = "origin-marker";
    return marker;
  }

  createCenterInterestMarker() {
    const geometry = new THREE.SphereGeometry(CENTER_INTEREST_MARKER_RADIUS, 16, 10);
    const material = new THREE.MeshBasicMaterial({
      color: 0xfff4a6,
      depthTest: true,
      depthWrite: true,
      transparent: true,
      opacity: 0.9,
    });
    const marker = new THREE.Mesh(geometry, material);
    marker.name = "center-interest-marker";
    marker.visible = false;
    marker.userData.nonInteractive = true;
    return marker;
  }

  createAxisLines() {
    const group = new THREE.Group();
    group.name = "visual-axis-lines";

    const axes = [
      {
        points: [
          new THREE.Vector3(-20, 0, 0),
          new THREE.Vector3(20, 0, 0),
        ],
        color: 0xe36b6b,
      },
      {
        points: [
          new THREE.Vector3(0, -20, 0),
          new THREE.Vector3(0, 20, 0),
        ],
        color: 0x70d17c,
      },
      {
        points: [
          new THREE.Vector3(0, 0, -20),
          new THREE.Vector3(0, 0, 20),
        ],
        color: 0x70a7ff,
      },
    ];

    for (const axis of axes) {
      const geometry = new THREE.BufferGeometry().setFromPoints(axis.points);
      const material = new THREE.LineBasicMaterial({ color: axis.color });
      group.add(new THREE.Line(geometry, material));
    }

    return group;
  }

  setLabelsVisible(visible) {
    this.labelsVisible = visible;
    this.labelRenderer.setVisible(visible);
  }

  selectedSphereLabelNeighborhoodIds() {
    if (!this.modeHead?.usesTouchGestures?.() || !this.state.selectedSphereId) {
      return null;
    }
    const selectedId = this.state.selectedSphereId;
    const visibleIds = new Set([selectedId]);
    for (const edge of this.state.connectedEdges?.(selectedId) ?? []) {
      if (this.state.spheres.has(edge.sourceId)) {
        visibleIds.add(edge.sourceId);
      }
      if (this.state.spheres.has(edge.targetId)) {
        visibleIds.add(edge.targetId);
      }
    }
    return visibleIds;
  }

  updateModeLabelFilter() {
    this.labelRenderer?.setVisibleIds(this.selectedSphereLabelNeighborhoodIds());
  }

  cameraSettingsSnapshot() {
    return {
      orbitSpeed: this.cameraOrbitSpeed,
      dragSpeed: this.cameraDragSpeed,
      dragMode: this.cameraDragMode,
    };
  }

  cameraSessionSnapshot() {
    return {
      format: "jsgolog.camera-session",
      version: 1,
      position: this.camera.position.toArray(),
      rigPosition: this.cameraRig.position.toArray(),
      angles: { ...this.cameraAngles },
      roll: this.cameraRoll,
      focusDistance: this.cameraFocusDistance,
      settings: this.cameraSettingsSnapshot(),
      iphoneTouchDragMode: this.iphoneTouchDragMode,
    };
  }

  restoreCameraSession(snapshot = {}) {
    restoreVector3(this.camera.position, snapshot.position);
    restoreVector3(this.cameraRig.position, snapshot.rigPosition);

    const angles = snapshot.angles ?? {};
    this.cameraAngles = {
      yaw: finiteNumber(angles.yaw, this.cameraAngles.yaw),
      pitch: THREE.MathUtils.clamp(
        finiteNumber(angles.pitch, this.cameraAngles.pitch),
        -MAX_CAMERA_PITCH,
        MAX_CAMERA_PITCH,
      ),
    };
    this.cameraRoll = finiteNumber(snapshot.roll, this.cameraRoll);
    this.cameraFocusDistance = finiteNumber(
      snapshot.focusDistance,
      this.camera.position.length(),
    );

    const settings = snapshot.settings ?? {};
    if (settings.orbitSpeed !== undefined) {
      this.setCameraOrbitSpeed(settings.orbitSpeed);
    }
    if (settings.dragSpeed !== undefined) {
      this.setCameraDragSpeed(settings.dragSpeed);
    }
    if (settings.dragMode !== undefined) {
      this.setCameraDragMode(settings.dragMode);
    }
    if (
      IPHONE_TOUCH_DRAG_MODE_ORDER.includes(snapshot.iphoneTouchDragMode)
    ) {
      this.iphoneTouchDragMode = snapshot.iphoneTouchDragMode;
      this.bus.emit(
        "iphone:touch-drag-mode-changed",
        this.iphoneTouchDragModeSnapshot(),
      );
    }

    this.updateCameraFrame();
    this.emitCameraState();
    return this.cameraSessionSnapshot();
  }

  setCameraOrbitSpeed(value) {
    const speed = THREE.MathUtils.clamp(
      Number(value),
      CAMERA_CONTROL_SPEED_MIN,
      CAMERA_CONTROL_SPEED_MAX,
    );
    this.cameraOrbitSpeed = Number.isFinite(speed)
      ? speed
      : CAMERA_ORBIT_SPEED_DEFAULT;
    this.bus.emit("camera:settings-changed", this.cameraSettingsSnapshot());
    return this.cameraSettingsSnapshot();
  }

  setCameraDragSpeed(value) {
    const speed = THREE.MathUtils.clamp(
      Number(value),
      CAMERA_CONTROL_SPEED_MIN,
      CAMERA_CONTROL_SPEED_MAX,
    );
    this.cameraDragSpeed = Number.isFinite(speed)
      ? speed
      : CAMERA_DRAG_SPEED_DEFAULT;
    this.bus.emit("camera:settings-changed", this.cameraSettingsSnapshot());
    return this.cameraSettingsSnapshot();
  }

  setCameraDragMode(mode) {
    this.cameraDragMode =
      mode === CAMERA_DRAG_MODE_ORBIT
        ? CAMERA_DRAG_MODE_ORBIT
        : CAMERA_DRAG_MODE_LOOK;
    this.bus.emit("camera:settings-changed", this.cameraSettingsSnapshot());
    return this.cameraSettingsSnapshot();
  }

  toggleCameraDragMode() {
    return this.setCameraDragMode(
      this.cameraDragMode === CAMERA_DRAG_MODE_LOOK
        ? CAMERA_DRAG_MODE_ORBIT
        : CAMERA_DRAG_MODE_LOOK,
    );
  }

  iphoneTouchDragModeSnapshot() {
    const modes = this.availableIphoneTouchDragModes();
    const mode = modes.includes(this.iphoneTouchDragMode)
      ? this.iphoneTouchDragMode
      : modes[0];
    const selectionLocked = this.isIphoneNodeSelectionInspecting();
    return {
      mode: selectionLocked ? IPHONE_TOUCH_DRAG_MODE_INSPECT : mode,
      modes,
      nextMode: this.nextIphoneTouchDragMode(mode, modes),
      canCreate: modes.includes(IPHONE_TOUCH_DRAG_MODE_CREATE),
      canToggle:
        !selectionLocked &&
        this.supportsIphoneGestureModeCycle() &&
        modes.length > 1,
      selectionLocked,
    };
  }

  supportsIphoneGestureModeCycle() {
    return Boolean(
      this.modeHead?.supportsIphoneGestureModeCycle?.() ??
        this.modeHead?.supportsTouchDragCreationToggle?.(),
    );
  }

  availableIphoneTouchDragModes() {
    if (!this.supportsIphoneGestureModeCycle()) {
      return [IPHONE_TOUCH_DRAG_MODE_INSPECT];
    }
    const canCreate = Boolean(
      this.modeHead?.canCreateEdge?.() || this.modeHead?.canCreateSurface?.(),
    );
    return IPHONE_TOUCH_DRAG_MODE_ORDER.filter(
      (mode) => mode !== IPHONE_TOUCH_DRAG_MODE_CREATE || canCreate,
    );
  }

  normalizeIphoneTouchDragMode(mode) {
    if (mode === "view") {
      return IPHONE_TOUCH_DRAG_MODE_INSPECT;
    }
    const modes = this.availableIphoneTouchDragModes();
    return modes.includes(mode) ? mode : modes[0];
  }

  nextIphoneTouchDragMode(
    mode = this.iphoneTouchDragMode,
    modes = this.availableIphoneTouchDragModes(),
  ) {
    const normalized = modes.includes(mode) ? mode : modes[0];
    const index = modes.indexOf(normalized);
    return modes[(index + 1) % modes.length] ?? normalized;
  }

  setIphoneTouchDragMode(mode) {
    this.iphoneTouchDragMode = this.normalizeIphoneTouchDragMode(mode);
    this.cancelIphoneCreationDrag();
    const snapshot = this.iphoneTouchDragModeSnapshot();
    this.bus.emit("iphone:touch-drag-mode-changed", snapshot);
    return snapshot;
  }

  toggleIphoneTouchDragMode() {
    if (this.isIphoneNodeSelectionInspecting()) {
      return this.iphoneTouchDragModeSnapshot();
    }
    return this.setIphoneTouchDragMode(this.iphoneTouchDragModeSnapshot().nextMode);
  }

  isIphoneNodeSelectionInspecting() {
    const selectedId = this.state?.selectedSphereId;
    return Boolean(
      this.modeHead?.usesTouchGestures?.() &&
        selectedId &&
        this.state?.spheres?.has?.(selectedId),
    );
  }

  iphoneSelectedSphereFocusPoint(id = this.state?.selectedSphereId) {
    if (!this.modeHead?.usesTouchGestures?.() || !id) {
      return null;
    }
    const position = this.state?.spheres?.get?.(id)?.position;
    if (!position) {
      return null;
    }
    const point = position.clone();
    if (!this.gologContent) {
      return point;
    }
    this.gologContent.updateMatrixWorld?.(true);
    return this.gologContent.localToWorld(point);
  }

  emitIphoneTouchDragModeChanged() {
    this.bus?.emit?.(
      "iphone:touch-drag-mode-changed",
      this.iphoneTouchDragModeSnapshot(),
    );
  }

  enterIphoneNodeInspection(id) {
    if (!this.modeHead?.usesTouchGestures?.() || !id) {
      return false;
    }
    if (this.iphoneModeBeforeNodeSelection === null) {
      this.iphoneModeBeforeNodeSelection = this.iphoneTouchDragMode;
    }
    this.iphoneTouchDragMode = IPHONE_TOUCH_DRAG_MODE_INSPECT;
    this.cancelIphoneCreationDrag();
    this.emitIphoneTouchDragModeChanged();
    return this.snapIphoneCameraToSphere(id);
  }

  exitIphoneNodeInspection() {
    if (this.iphoneModeBeforeNodeSelection === null) {
      return false;
    }
    this.iphoneTouchDragMode = this.normalizeIphoneTouchDragMode(
      this.iphoneModeBeforeNodeSelection,
    );
    this.iphoneModeBeforeNodeSelection = null;
    this.cancelIphoneCreationDrag();
    this.emitIphoneTouchDragModeChanged();
    return true;
  }

  handleIphoneSphereSelectionChanged(id) {
    if (!this.modeHead?.usesTouchGestures?.()) {
      this.iphoneModeBeforeNodeSelection = null;
      return;
    }
    if (!id) {
      this.exitIphoneNodeInspection();
      return;
    }
    this.enterIphoneNodeInspection(id);
  }

  applyIphoneSphereSelectionState(id) {
    this.handleIphoneSphereSelectionChanged(id);
    this.updateModeLabelFilter();
  }

  snapIphoneCameraToSphere(id) {
    const focus = this.iphoneSelectedSphereFocusPoint(id);
    if (!focus) {
      return false;
    }
    this.centerInterestPoint = focus.clone();
    const oriented = this.orientCameraToward(focus);
    this.updateCameraFrame();
    this.emitCameraState();
    return oriented;
  }

  updateLabelRenderOrder() {
    this.labelRenderer.updateRenderOrder(
      this.camera.getWorldPosition(new THREE.Vector3()),
    );
  }

  moveSphereMesh(id, position) {
    this.sphereRenderer.move(id, position);
    if (this.nestedPreviews.has(id)) {
      this.updateNestedPreviewTransform(id);
    }
    if (this.payloadBillboardPreview?.objectId === id) {
      this.updatePayloadBillboardPreviewTransform();
    }
    if (
      [...this.payloadBillboardPreviews.values()].some(
        (record) => record.objectId === id,
      )
    ) {
      this.updatePayloadBillboardPreviewTransform();
    }

  }

  hasNestedPreview(objectId) {
    return this.nestedPreviews.has(objectId);
  }

  nextNodeExpansionPreviewSequence() {
    this.nodeExpansionSequence += 1;
    return this.nodeExpansionSequence;
  }

  syncLatestNestedPreview() {
    this.nestedPreview = [...this.nestedPreviews.values()].at(-1) ?? null;
  }

  closeNodeExpansionPreview(objectId) {
    const closedNested = this.closeNestedGologPreview(objectId);
    const closedPayload = this.closePayloadBillboardPreview(objectId);
    return closedNested || closedPayload;
  }

  ensurePreviewForceUniverse() {
    if (
      !this.previewForceUniverse &&
      typeof this.createPreviewForceUniverse === "function"
    ) {
      this.previewForceUniverse = this.createPreviewForceUniverse();
    }
    return this.previewForceUniverse;
  }

  visiblePreviewForceGologs() {
    const gologs = [];
    for (const preview of this.nestedPreviews.values()) {
      if (preview.childGolog) {
        gologs.push(preview.childGolog);
      }
    }

    return gologs;
  }

  syncPreviewForceUniverses() {
    const gologs = this.visiblePreviewForceGologs();
    if (gologs.length > 0) {
      this.ensurePreviewForceUniverse()?.setVisibleGologs(gologs);
      return;
    }
    this.previewForceUniverse?.setVisibleGologs([]);
  }

  showEmptyNestedPreview({ objectId = null, sphereId = objectId }) {
    objectId ??= sphereId;
    const object = this.state.getObject(objectId);
    if (!object || !this.nestedPreviewAnchor(objectId)) {
      return false;
    }
    const sphere = object.dimension === 0 ? this.sphereMeshes.get(objectId) : null;

    const existing = this.nestedPreviews.get(objectId);
    if (existing && !existing.childGolog) {
      if (sphere) sphere.visible = false;
      this.rebuildNestedPreview(objectId);
      this.syncPreviewForceUniverses();
      return true;
    }

    this.closeNodeExpansionPreview(objectId);
    const shell = this.createNestedPreviewShell(objectId);
    const content = new THREE.Group();
    content.name = `${objectId}-empty-nested-preview-content`;
    content.userData.nonInteractive = true;
    this.scene.add(shell);
    this.scene.add(content);
    const previousSphereVisible = sphere?.visible ?? null;
    if (sphere) sphere.visible = false;

    const preview = {
      objectId,
      sphereId: sphere ? objectId : null,
      childGolog: null,
      shell,
      content,
      previousSphereVisible,
      releaseChildListener: null,
      sequence: this.nextNodeExpansionPreviewSequence(),
    };
    this.nestedPreviews.set(objectId, preview);
    this.syncLatestNestedPreview();
    this.updateNestedPreviewTransform(objectId);
    this.rebuildNestedPreview(objectId);
    this.syncPreviewForceUniverses();
    return true;
  }

  showNestedGologPreview({ objectId = null, sphereId = objectId, childGolog }) {
    objectId ??= sphereId;
    const object = this.state.getObject(objectId);
    if (!object || !this.nestedPreviewAnchor(objectId) || !childGolog) {
      return false;
    }
    const sphere = object.dimension === 0 ? this.sphereMeshes.get(objectId) : null;

    const existing = this.nestedPreviews.get(objectId);
    if (existing?.childGolog?.id === childGolog.id) {
      if (sphere) sphere.visible = false;
      this.rebuildNestedPreview(objectId);
      this.syncPreviewForceUniverses();
      return true;
    }

    this.closeNodeExpansionPreview(objectId);
    const shell = this.createNestedPreviewShell(objectId);
    const content = new THREE.Group();
    content.name = `${objectId}-nested-golog-preview-content`;
    content.userData.nonInteractive = true;
    this.scene.add(shell);
    this.scene.add(content);
    const previousSphereVisible = sphere?.visible ?? null;
    if (sphere) sphere.visible = false;

    const preview = {
      objectId,
      sphereId: sphere ? objectId : null,
      childGolog,
      shell,
      content,
      previousSphereVisible,
      releaseChildListener: childGolog.bus.on("state:changed", () =>
        this.rebuildNestedPreview(objectId),
      ),
      sequence: this.nextNodeExpansionPreviewSequence(),
    };
    this.nestedPreviews.set(objectId, preview);
    this.syncLatestNestedPreview();
    this.updateNestedPreviewTransform(objectId);
    this.rebuildNestedPreview(objectId);
    this.syncPreviewForceUniverses();
    return true;
  }

  createNestedPreviewShell(objectId) {
    const sphere = this.sphereMeshes.get(objectId);
    const color = sphere?.material?.color?.getHex?.() ?? 0xb6c7ff;
    const geometry = new THREE.SphereGeometry(NESTED_PREVIEW_RADIUS, 42, 28);
    const material = new THREE.MeshStandardMaterial({
      color,
      transparent: true,
      opacity: 0.2,
      roughness: 0.62,
      metalness: 0.02,
      depthWrite: false,
    });
    const shell = new THREE.Mesh(geometry, material);
    shell.name = `${objectId}-nested-golog-preview-shell`;
    shell.userData.nonInteractive = true;
    shell.renderOrder = 2;
    return shell;
  }

  closeNestedGologPreview(sphereId = null) {
    if (sphereId === null) {
      if (this.nestedPreviews.size === 0) {
        return false;
      }
      for (const id of [...this.nestedPreviews.keys()]) {
        this.closeNestedGologPreview(id);
      }
      return true;
    }

    const preview = this.nestedPreviews.get(sphereId);
    if (!preview) {
      return false;
    }

    const sphere = preview.sphereId ? this.sphereMeshes.get(preview.sphereId) : null;
    if (sphere) {
      sphere.visible = preview.previousSphereVisible;
    }
    preview.releaseChildListener?.();
    this.disposePreviewObject(preview.shell);
    this.disposePreviewObject(preview.content);
    this.scene.remove(preview.shell);
    this.scene.remove(preview.content);
    this.nestedPreviews.delete(sphereId);
    this.syncLatestNestedPreview();
    this.syncPreviewForceUniverses();
    return true;
  }

  showPayloadBillboardPreview({ objectId, objectKind, presentation }) {
    if (!objectId || !presentation?.src) {
      return false;
    }

    if (objectKind === "sphere") {
      return this.showPayloadBillboardNodePreview({
        objectId,
        objectKind,
        presentation,
      });
    }

    const anchor = this.payloadBillboardAnchor(objectId, objectKind);
    if (!anchor) {
      return false;
    }

    if (
      this.payloadBillboardPreview?.objectId === objectId &&
      this.payloadBillboardPreview?.src === presentation.src
    ) {
      this.updatePayloadBillboardPreviewTransform();
      return true;
    }

    this.closeNestedGologPreview();
    this.closePayloadBillboardPreview();

    const element = this.createPayloadBillboardElement(presentation, {
      onLoad: () => this.updatePayloadBillboardPreviewTransform(),
    });
    element.dataset.objectId = objectId;
    element.dataset.objectKind = objectKind;
    this.container.appendChild(element);

    const sphere = objectKind === "sphere" ? this.sphereMeshes.get(objectId) : null;
    const pickMesh = sphere
      ? this.createPayloadBillboardSpherePick(sphere, objectId)
      : null;
    if (pickMesh) {
      this.gologContent.add(pickMesh);
    }
    if (sphere) {
      sphere.scale.setScalar(PAYLOAD_BILLBOARD_NODE_SCALE);
    }

    const label = this.objectLabels.get(objectId);
    if (label) {
      label.visible = false;
    }

    this.payloadBillboardPreview = {
      objectId,
      objectKind,
      src: presentation.src,
      element,
      pickMesh,
      mode: "single",
    };
    this.updatePayloadBillboardPreviewTransform();
    return true;
  }

  showPayloadBillboardNodePreview({ objectId, objectKind, presentation }) {
    const anchor = this.payloadBillboardAnchor(objectId, objectKind);
    if (!anchor) {
      return false;
    }

    const existing = this.payloadBillboardPreviews.get(objectId);
    if (existing?.src === presentation.src) {
      this.updatePayloadBillboardPreviewTransform();
      return true;
    }

    this.closeNodeExpansionPreview(objectId);
    const element = this.createPayloadBillboardElement(presentation, {
      onLoad: () => this.updatePayloadBillboardPreviewTransform(),
    });
    element.dataset.objectId = objectId;
    element.dataset.objectKind = objectKind;
    element.dataset.nodeExpansion = "true";
    this.container.appendChild(element);
    const record = {
      objectId,
      objectKind,
      src: presentation.src,
      element,
      pickMesh: null,
      mode: "node",
      sequence: this.nextNodeExpansionPreviewSequence(),
    };
    this.payloadBillboardPreviews.set(objectId, record);
    const label = this.objectLabels.get(objectId);
    if (label) {
      label.visible = false;
    }
    this.updatePayloadBillboardPreviewTransform();
    return true;
  }

  showPayloadBillboardPreviews(items = []) {
    this.closePayloadBillboardPreviews();
    for (const item of items) {
      if (!item?.objectId || !item?.presentation?.src) {
        continue;
      }
      const anchor = this.payloadBillboardAnchor(item.objectId, item.objectKind);
      if (!anchor) {
        continue;
      }
      const element = this.createPayloadBillboardElement(item.presentation, {
        onLoad: () => this.updatePayloadBillboardPreviewTransform(),
      });
      element.dataset.batch = "true";
      element.dataset.objectId = item.objectId;
      element.dataset.objectKind = item.objectKind;
      this.container.appendChild(element);
      const record = {
        objectId: item.objectId,
        objectKind: item.objectKind,
        payloadKey: item.payloadKey ?? item.presentation.src,
        src: item.presentation.src,
        element,
        pickMesh: null,
        mode: "batch",
      };
      this.payloadBillboardPreviews.set(
        `${item.objectId}:${record.payloadKey}`,
        record,
      );
      const label = this.objectLabels.get(item.objectId);
      if (label) {
        label.visible = false;
      }
    }
    this.updatePayloadBillboardPreviewTransform();
    return this.payloadBillboardPreviews.size;
  }

  createPayloadBillboardSpherePick(sphere, sphereId) {
    const radius = sphere.geometry?.parameters?.radius ?? 0.5;
    const geometry = new THREE.SphereGeometry(radius, 18, 12);
    const material = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const pickMesh = new THREE.Mesh(geometry, material);
    pickMesh.name = `${sphereId}-payload-billboard-pick`;
    pickMesh.userData.objectId = sphereId;
    pickMesh.userData.sphereId = sphereId;
    pickMesh.position.copy(sphere.position);
    pickMesh.scale.copy(sphere.scale);
    pickMesh.updateMatrixWorld(true);
    return pickMesh;
  }

  createPayloadBillboardElement(presentation, { onLoad = null } = {}) {
    const documentRef = this.renderer.domElement.ownerDocument;
    const element = documentRef.createElement("div");
    element.className = "scene-payload-billboard";
    element.dataset.mediaType = presentation.mediaType ?? "media";
    element.dataset.aspectRatio = "1.333333";
    element.dataset.loadState = "loading";
    element.setAttribute("aria-label", presentation.title ?? "Payload preview");
    const previewUrl = safePayloadPreviewUrl(presentation.src, {
      mediaType: presentation.mediaType, baseUrl: documentRef.baseURI,
    });
    if (!previewUrl) {
      element.dataset.loadState = "error";
      element.textContent = "Preview unavailable";
      return element;
    }

    if (presentation.mediaType === "pdf") {
      appendPdfPreview(element, { url: previewUrl,
        className: "scene-payload-billboard-pdf", title: presentation.title ?? "PDF payload" });
      return element;
    }

    const image = documentRef.createElement("img");
    image.className = "scene-payload-billboard-image";
    image.src = previewUrl;
    image.alt = presentation.title ?? "";
    const fallback = documentRef.createElement("span");
    fallback.className = "scene-payload-billboard-fallback";
    fallback.textContent = "PNG unavailable";
    fallback.hidden = true;
    image.addEventListener("load", () => {
      if (image.naturalWidth > 0 && image.naturalHeight > 0) {
        element.dataset.loadState = "loaded";
        element.dataset.aspectRatio = String(
          image.naturalWidth / image.naturalHeight,
        );
      }
      fallback.hidden = true;
      onLoad?.();
    });
    image.addEventListener("error", () => {
      element.dataset.loadState = "error";
      element.dataset.aspectRatio = "2.4";
      fallback.hidden = false;
      onLoad?.();
    });
    if (image.complete && image.naturalWidth > 0 && image.naturalHeight > 0) {
      element.dataset.loadState = "loaded";
      element.dataset.aspectRatio = String(image.naturalWidth / image.naturalHeight);
      queueMicrotask(() => onLoad?.());
    }
    element.append(image);
    element.append(fallback);
    return element;
  }

  closePayloadBillboardPreview(objectId = null) {
    if (objectId !== null) {
      let closedBatchPreview = false;
      for (const [key, record] of this.payloadBillboardPreviews.entries()) {
        if (key === objectId || record.objectId === objectId) {
          record.element.remove();
          this.payloadBillboardPreviews.delete(key);
          closedBatchPreview = true;
        }
      }
      if (closedBatchPreview) {
        const label = this.objectLabels.get(objectId);
        if (label) {
          label.visible =
            !this.hasPayloadBillboardPreview(objectId) &&
            this.labelRenderer.visible &&
            Boolean(label.userData.labelText);
        }
        return true;
      }
    }

    if (
      objectId !== null &&
      this.payloadBillboardPreview?.objectId !== objectId
    ) {
      return false;
    }

    if (!this.payloadBillboardPreview) {
      return false;
    }

    const { objectId: previewObjectId, element, pickMesh } =
      this.payloadBillboardPreview;
    element.remove();
    if (pickMesh) {
      this.gologContent.remove(pickMesh);
      this.disposePreviewObject(pickMesh);
    }
    this.payloadBillboardPreview = null;

    this.sphereRenderer.updateSelection(this.state.selectedSphereId);
    const label = this.objectLabels.get(previewObjectId);
    if (label) {
      label.visible =
        !this.payloadBillboardPreviews.has(previewObjectId) &&
        this.labelRenderer.visible &&
        Boolean(label.userData.labelText);
    }
    return true;
  }

  closePayloadBillboardPreviews() {
    if (this.payloadBillboardPreviews.size === 0) {
      return false;
    }

    const objectIds = [...this.payloadBillboardPreviews.keys()];
    const previewObjectIds = [
      ...new Set(
        objectIds.map((key) => this.payloadBillboardPreviews.get(key)?.objectId),
      ),
    ].filter(Boolean);
    for (const objectId of previewObjectIds) {
      this.closePayloadBillboardPreview(objectId);
    }
    return true;
  }

  hasPayloadBillboardPreview(objectId) {
    return (
      this.payloadBillboardPreview?.objectId === objectId ||
      [...this.payloadBillboardPreviews.values()].some(
        (record) => record.objectId === objectId,
      )
    );
  }

  payloadBillboardAnchor(objectId, objectKind) {
    if (objectKind === "sphere") {
      return this.sphereMeshes.get(objectId)?.position?.clone() ?? null;
    }
    if (objectKind === "edge") {
      return this.edgeGraphics.get(objectId)?.midpoint?.clone() ?? null;
    }
    if (objectKind === "surface") {
      return this.surfaceGraphics.get(objectId)?.controlPoint?.clone() ?? null;
    }
    if (objectKind === "volume") {
      return this.volumeGraphics.get(objectId)?.centroid?.clone() ??
        this.state.getObject(objectId)?.origin?.clone() ?? null;
    }
    return null;
  }

  selectableAnchorPoint(selectable) {
    const normalized = this.normalizeSelectable(selectable);
    if (!normalized) {
      return null;
    }
    return this.payloadBillboardAnchor(normalized.id, normalized.kind);
  }

  createIphoneCreationTrailOverlay() {
    const documentRef = this.renderer.domElement.ownerDocument;
    if (!documentRef || this.iphoneCreationTrailOverlay) {
      return;
    }

    const svg = documentRef.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("iphone-creation-trail-overlay");
    svg.setAttribute("aria-hidden", "true");
    svg.hidden = true;

    const polyline = documentRef.createElementNS(
      "http://www.w3.org/2000/svg",
      "polyline",
    );
    polyline.classList.add("iphone-creation-trail-polyline");
    svg.appendChild(polyline);

    this.container.appendChild(svg);
    this.iphoneCreationTrailOverlay = svg;
    this.iphoneCreationTrailPolyline = polyline;
  }

  updatePayloadBillboardPreviewTransform() {
    if (this.payloadBillboardPreview) {
      if (!this.updatePayloadBillboardRecordTransform(this.payloadBillboardPreview)) {
        this.closePayloadBillboardPreview();
      }
    }

    for (const [previewId, record] of this.payloadBillboardPreviews.entries()) {
      if (!this.updatePayloadBillboardRecordTransform(record)) {
        record.element.remove();
        this.payloadBillboardPreviews.delete(previewId);
      }
    }
    this.updatePayloadBillboardZOrder();
  }

  updatePayloadBillboardRecordTransform(record) {
    const { objectId, objectKind, element } = record;
    const anchor = this.payloadBillboardAnchor(objectId, objectKind);
    if (!anchor) {
      return false;
    }

    if (record.mode === "single" && objectKind === "sphere") {
      const sphere = this.sphereMeshes.get(objectId);
      sphere?.scale.setScalar(PAYLOAD_BILLBOARD_NODE_SCALE);
      if (record.pickMesh && sphere) {
        record.pickMesh.position.copy(sphere.position);
        record.pickMesh.updateMatrixWorld(true);
      }
    }
    const label = this.objectLabels.get(objectId);
    if (label) {
      label.visible = false;
    }

    const worldPosition = this.gologContent.localToWorld(anchor.clone());
    record.cameraDistance = this.camera
      .getWorldPosition(new THREE.Vector3())
      .distanceTo(worldPosition);
    const projected = worldPosition.clone().project(this.camera);
    const visible =
      projected.z >= -1 &&
      projected.z <= 1 &&
      Math.abs(projected.x) <= 1.25 &&
      Math.abs(projected.y) <= 1.25;
    element.hidden = !visible;
    if (!visible) {
      return true;
    }

    const viewport = this.activeCanvasViewportClientRect();
    const containerRect = this.container.getBoundingClientRect();
    const size = this.payloadBillboardPixelSize(
      record,
      anchor,
      worldPosition,
      viewport,
    );
    const left =
      viewport.left +
      ((projected.x + 1) / 2) * viewport.width -
      containerRect.left;
    const top =
      viewport.top +
      ((1 - projected.y) / 2) * viewport.height -
      containerRect.top;
    element.style.width = `${size.width}px`;
    element.style.height = `${size.height}px`;
    element.style.transform = `translate(${left}px, ${top}px) translate(-50%, -50%)`;
    return true;
  }

  updatePayloadBillboardZOrder() {
    const records = [
      this.payloadBillboardPreview,
      ...this.payloadBillboardPreviews.values(),
    ].filter(
      (record) =>
        record?.element &&
        !record.element.hidden &&
        Number.isFinite(record.cameraDistance),
    );
    records.sort((a, b) => {
      const distanceDelta = b.cameraDistance - a.cameraDistance;
      if (Math.abs(distanceDelta) > SELECTABLE_DISTANCE_EPSILON) {
        return distanceDelta;
      }
      return String(a.objectId).localeCompare(String(b.objectId));
    });
    records.forEach((record, index) => {
      record.element.style.zIndex = String(PAYLOAD_BILLBOARD_Z_BASE + index);
    });
  }

  payloadBillboardWorldRadius(record, anchor) {
    const anchorPosition =
      record.objectKind === "sphere"
        ? this.sphereMeshes.get(record.objectId)?.position ?? anchor
        : anchor;
    let nearestDistance = Infinity;
    for (const [sphereId, sphere] of this.sphereMeshes.entries()) {
      if (record.objectKind === "sphere" && sphereId === record.objectId) {
        continue;
      }
      const distance = anchorPosition.distanceTo(sphere.position);
      if (distance > SELECTABLE_DISTANCE_EPSILON) {
        nearestDistance = Math.min(nearestDistance, distance);
      }
    }
    return Number.isFinite(nearestDistance)
      ? nearestDistance / 2
      : PAYLOAD_BILLBOARD_FALLBACK_WORLD_RADIUS;
  }

  payloadBillboardWorldSize(record, anchor) {
    const aspectRatio = Math.max(
      0.08,
      Math.min(16, Number(record.element.dataset.aspectRatio) || 4 / 3),
    );
    const diameter = this.payloadBillboardWorldRadius(record, anchor) * 2;
    if (aspectRatio >= 1) {
      return {
        width: diameter,
        height: diameter / aspectRatio,
      };
    }
    return {
      width: diameter * aspectRatio,
      height: diameter,
    };
  }

  payloadBillboardPixelsPerWorldUnit(worldPosition, viewport) {
    const cameraPosition = this.camera.getWorldPosition(new THREE.Vector3());
    const distance = Math.max(
      CAMERA_MIN_FOCUS_DISTANCE,
      cameraPosition.distanceTo(worldPosition),
    );
    if (this.camera.isPerspectiveCamera) {
      const fov = THREE.MathUtils.degToRad(this.camera.fov);
      return viewport.height / (2 * Math.tan(fov / 2) * distance);
    }
    if (this.camera.isOrthographicCamera) {
      return (
        viewport.height /
        ((this.camera.top - this.camera.bottom) / (this.camera.zoom || 1))
      );
    }
    return viewport.height / Math.max(CAMERA_MIN_FOCUS_DISTANCE, distance);
  }

  payloadBillboardPixelSize(record, anchor, worldPosition, viewport) {
    const worldSize = this.payloadBillboardWorldSize(record, anchor);
    const pixelsPerWorldUnit = this.payloadBillboardPixelsPerWorldUnit(
      worldPosition,
      viewport,
    );
    const width = worldSize.width * pixelsPerWorldUnit;
    const height = worldSize.height * pixelsPerWorldUnit;
    if (!Number.isFinite(width) || !Number.isFinite(height)) {
      return { width: 0, height: 0 };
    }
    const maxWidth = Math.min(
      PAYLOAD_BILLBOARD_MAX_PIXEL_WIDTH,
      viewport.width * PAYLOAD_BILLBOARD_MAX_VIEWPORT_FRACTION,
    );
    const maxHeight = Math.min(
      PAYLOAD_BILLBOARD_MAX_PIXEL_HEIGHT,
      viewport.height * PAYLOAD_BILLBOARD_MAX_VIEWPORT_FRACTION,
    );
    const scale = Math.min(1, maxWidth / width, maxHeight / height);
    return {
      width: Math.max(1, width * scale),
      height: Math.max(1, height * scale),
    };
  }

  closeNestedPreviewIfAway(selectable) {
    if (selectable) {
      return;
    }

    this.closeNestedGologPreview();
    this.closePayloadBillboardPreview();
    this.closePayloadBillboardPreviews();

  }

  disposePreviewObject(object) {
    disposeObject3D(object);
  }

  updateNestedPreviewTransform(sphereId = null) {
    if (sphereId === null) {
      for (const id of this.nestedPreviews.keys()) {
        this.updateNestedPreviewTransform(id);
      }
      return;
    }

    const preview = this.nestedPreviews.get(sphereId);
    if (!preview) {
      return;
    }

    const anchor = this.nestedPreviewAnchor(preview.objectId ?? preview.sphereId);
    if (!anchor) {
      this.closeNestedGologPreview(sphereId);
      return;
    }

    preview.shell.position.copy(anchor);
    preview.content.position.copy(anchor);
    preview.shell.updateMatrixWorld(true);
    preview.content.updateMatrixWorld(true);
  }

  nestedPreviewAnchor(objectId) {
    const object = this.state.getObject(objectId);
    if (!object) return null;
    if (object.dimension === 0) return this.sphereMeshes.get(objectId)?.position?.clone() ?? object.origin?.clone() ?? null;
    return object.origin?.clone() ?? this.payloadBillboardAnchor(objectId, object.kind);
  }

  rebuildNestedPreview(sphereId = null) {
    if (sphereId === null) {
      for (const id of this.nestedPreviews.keys()) {
        this.rebuildNestedPreview(id);
      }
      return;
    }

    const preview = this.nestedPreviews.get(sphereId);
    if (!preview) {
      return;
    }

    const { content, childGolog } = preview;
    this.nestedPreviewRenderer.rebuildContent(content, childGolog);
  }

  pickSurfaceControlHits() {
    const controls = this.surfaceRenderer.controls();
    return this.raycaster.intersectObjects(controls, false);
  }

  pickSurfaceControl() {
    return this.pickSurfaceControlHits()[0] ?? null;
  }

  pickVolumeControlHits() {
    return this.raycaster.intersectObjects(this.volumeRenderer.controls(), false);
  }

  pickEdgeConeHits() {
    const pickVolumes = [...this.edgeGraphics.values()]
      .map((edge) => edge.conePick)
      .filter(Boolean);
    return this.raycaster.intersectObjects(pickVolumes, false);
  }

  selectableSortPriority(candidate, preferSphere = false) {
    if (preferSphere && candidate.kind === "sphere") {
      return -1;
    }
    if (candidate.kind === "surface") {
      return 1;
    }
    if (candidate.kind === "edge") {
      return 2;
    }
    return 3;
  }

  pickSelectable({ preferSphere = false } = {}) {
    const candidates = [
      ...this.pickSphereHits({ far: Infinity }).map((sphereHit) => ({
        id: sphereHit.object.userData.sphereId,
        kind: "sphere",
        hit: sphereHit,
      })),
      ...this.pickSurfaceControlHits().map((surfaceHit) => ({
        id: surfaceHit.object.userData.surfaceId,
        kind: "surface",
        hit: surfaceHit,
      })),
      ...this.pickEdgeConeHits().map((edgeHit) => ({
        id: edgeHit.object.userData.edgeId,
        kind: "edge",
        hit: edgeHit,
      })),
      ...this.pickVolumeControlHits().map((volumeHit) => ({
        id: volumeHit.object.userData.volumeId,
        kind: "volume",
        hit: volumeHit,
      })),
    ].filter((candidate) => candidate.id);

    candidates.sort((left, right) => {
      const distanceDelta = left.hit.distance - right.hit.distance;
      if (Math.abs(distanceDelta) > SELECTABLE_DISTANCE_EPSILON) {
        return distanceDelta;
      }
      return (
        this.selectableSortPriority(left, preferSphere) -
        this.selectableSortPriority(right, preferSphere)
      );
    });

    return candidates[0] ?? null;
  }

  createSelectionPairActions() {
    return new Map([
      [
        "sphere:sphere",
        {
          canCreate: () => true,
          create: (source, target, event = null) => {
            const id = `edge-${this.state.nextEdgeId}`;
            this.bus.emit("element:create", {
              elementKind:
                this.modeHead?.edgeElementKind?.({
                  tight: Boolean(event?.altKey),
                }) ?? ELEMENT_KINDS.ONE_SIMPLEX,
              id,
              sourceId: source.id,
              targetId: target.id,
            });
            return { id, kind: "edge" };
          },
        },
      ],
      [
        "edge:edge",
        {
          canCreate: (source, target) =>
            !this.modeHead?.usesVirtualDoubleCreation?.() &&
            this.state.canCreateSurfaceBetweenEdges(
              this.state.edges.get(source.id),
              this.state.edges.get(target.id),
          ),
          create: (source, target) => {
            const id = `surface-${this.state.nextSurfaceId}`;
            this.bus.emit("element:create", {
              elementKind: ELEMENT_KINDS.TWO_CELL,
              id,
              firstEdgeId: source.id,
              secondEdgeId: target.id,
            });
            return { id, kind: "surface" };
          },
        },
      ],
    ]);
  }

  createTwoSimplexFromEdgeIds(edgeIds) {
    if (this.modeHead?.usesVirtualDoubleCreation?.()) {
      return false;
    }
    if (this.modeHead && !this.modeHead.canCreateSurface()) {
      return false;
    }
    if (!this.state.canCreateTwoSimplex(edgeIds)) {
      return false;
    }

    const id = `two-simplex-${this.state.nextSurfaceId}`;
    this.bus.emit("element:create", {
      elementKind: ELEMENT_KINDS.TWO_SIMPLEX,
      id,
      edgeIds,
    });
    return true;
  }

  createFromSelectionTriple(target, event = null) {
    if (target?.kind !== "edge") {
      return false;
    }

    const edgeIds = [
      ...this.selectionBuffer
        .filter((entry) => entry.kind === "edge")
        .map((entry) => entry.id),
      target.id,
    ];
    return this.createTwoSimplexFromEdgeIds(edgeIds);
  }

  selectionPairKey(source, target) {
    return `${source.kind}:${target.kind}`;
  }

  sameSelectable(first, second) {
    return Boolean(
      first &&
        second &&
        first.id === second.id &&
        first.kind === second.kind,
    );
  }

  normalizeSelectable(selectable) {
    return selectable
      ? {
          id: selectable.id,
          kind: selectable.kind,
        }
      : null;
  }

  currentSelectedSelectable() {
    const id = this.state.selectedSimplexId;
    const record = id ? this.state.getObject(id) : null;
    if (record?.kind === "sphere" || record?.kind === "edge") {
      return { id, kind: record.kind };
    }
    if (record?.kind === "volume") return { id, kind: "volume" };
    if (record?.kind === "surface" || record?.kind === "two-simplex") {
      return { id, kind: "surface" };
    }
    return null;
  }

  rememberSelection(selectable) {
    const normalized = this.normalizeSelectable(selectable);
    if (!normalized) {
      this.selectionBuffer = [];
      return;
    }

    this.selectionBuffer = [
      normalized,
      ...this.selectionBuffer.filter(
        (entry) => !this.sameSelectable(entry, normalized),
      ),
    ].slice(0, 2);
  }

  selectSelectable(selectable) {
    if (!selectable) {
      this.bus.emit("sphere:select", { id: null });
      this.updateConeSelection(null);
      this.updateSurfaceControlSelection(null);
      this.rememberSelection(null);
      return;
    }

    if (selectable.kind === "sphere") {
      this.bus.emit("sphere:select", { id: selectable.id });
    } else if (selectable.kind === "edge") {
      this.bus.emit("edge:select", { id: selectable.id });
    } else if (selectable.kind === "surface") {
      this.bus.emit("surface:select", { id: selectable.id });
    } else if (selectable.kind === "volume") {
      this.bus.emit("volume:select", { id: selectable.id });
    }
    this.rememberSelection(selectable);
  }

  requestLabelEdit(selectable, event = null, { allowPending = false } = {}) {
    if (!selectable?.id) {
      return false;
    }
    if (this.modeHead && !this.modeHead.canEditLabels(this.state.gologId)) {
      return false;
    }

    const payload = {
      id: selectable.id,
      kind: selectable.kind,
      allowPending,
    };
    if (event && this.modeHead?.shouldDispatchLabelEditThroughDom?.()) {
      this.renderer.domElement.dispatchEvent(
        new CustomEvent("golog:label-edit-requested", {
          bubbles: true,
          detail: {
            ...payload,
            clientX: event.clientX,
            clientY: event.clientY,
            immediateFocus: true,
          },
        }),
      );
      return true;
    }

    this.bus.emit("label:edit-requested", payload);
    return true;
  }

  createFromSelectionPair(source, target, event = null) {
    if (!source || !target || source.id === target.id) {
      return false;
    }
    if (
      this.modeHead &&
      source.kind === "sphere" &&
      target.kind === "sphere" &&
      !this.modeHead.canCreateEdge()
    ) {
      return false;
    }
    if (
      this.modeHead &&
      source.kind === "edge" &&
      target.kind === "edge" &&
      !this.modeHead.canCreateSurface()
    ) {
      return false;
    }

    const action = this.selectionPairActions.get(
      this.selectionPairKey(source, target),
    );
    if (!action?.canCreate(source, target)) {
      return false;
    }

    action.create(source, target, event);
    return true;
  }

  canCreateFromSelectionPair(source, target) {
    if (!source || !target || source.id === target.id) {
      return false;
    }
    if (
      this.modeHead &&
      source.kind === "sphere" &&
      target.kind === "sphere" &&
      !this.modeHead.canCreateEdge()
    ) {
      return false;
    }
    if (
      this.modeHead &&
      source.kind === "edge" &&
      target.kind === "edge" &&
      !this.modeHead.canCreateSurface()
    ) {
      return false;
    }

    const action = this.selectionPairActions.get(
      this.selectionPairKey(source, target),
    );
    return Boolean(action?.canCreate(source, target));
  }

  selectionSourceForTarget(target) {
    const latest = this.selectionBuffer[0] ?? this.currentSelectedSelectable();
    if (!latest) {
      return null;
    }

    if (this.canCreateFromSelectionPair(latest, target)) {
      return latest;
    }

    if (!this.sameSelectable(latest, target)) {
      return null;
    }

    const previous = this.selectionBuffer[1];
    if (this.canCreateFromSelectionPair(previous, target)) {
      return previous;
    }

    return null;
  }

  handleShiftSelectable(selectable, event = null) {
    if (!selectable) {
      if (this.modeHead && !this.modeHead.canCreateNode(this.state.gologId)) {
        return;
      }
      const position = this.intersectSelectionSphere();
      if (position) {
        const id = `sphere-${this.state.nextSphereId}`;
        this.bus.emit("element:create", {
          elementKind:
            this.modeHead?.nodeElementKind?.() ?? ELEMENT_KINDS.ZERO_SIMPLEX,
          id,
          position: this.worldPointToGologLocal(position),
        });
        this.rememberSelection({
          id,
          kind: "sphere",
        });
      }
      return;
    }

    if (this.createFromSelectionTriple(selectable, event)) {
      this.rememberSelection(selectable);
      return;
    }

    const source = this.selectionSourceForTarget(selectable);
    if (!source) {
      this.selectSelectable(selectable);
      return;
    }
    this.createFromSelectionPair(source, selectable, event);
    this.rememberSelection(selectable);
  }

  usesIphoneCreationDragMode() {
    if (this.isIphoneNodeSelectionInspecting()) {
      return false;
    }
    const snapshot = this.iphoneTouchDragModeSnapshot();
    return (
      snapshot.canToggle &&
      snapshot.mode === IPHONE_TOUCH_DRAG_MODE_CREATE
    );
  }

  usesIphoneTravelMode() {
    if (this.isIphoneNodeSelectionInspecting()) {
      return false;
    }
    const snapshot = this.iphoneTouchDragModeSnapshot();
    return snapshot.canToggle && snapshot.mode === IPHONE_TOUCH_DRAG_MODE_TRAVEL;
  }

  beginIphoneCreationDrag(event) {
    if (!this.isIphoneTouchPointer(event) || !this.usesIphoneCreationDragMode()) {
      return false;
    }

    const selectable = this.pickSelectable({ preferSphere: true });
    this.closeNestedPreviewIfAway(selectable);
    if (
      this.modeHead?.handleSelectableClick({
        gologId: this.state.gologId,
        selectable,
      })
    ) {
      return true;
    }

    this.releaseDragAuthority(this.drag);
    this.drag = null;
    this.pendingPointer = null;
    this.iphoneCreationDrag = {
      pointerId: event.pointerId,
      chain: [],
      kind: null,
      startScreen: new THREE.Vector2(event.clientX, event.clientY),
      currentClient: new THREE.Vector2(event.clientX, event.clientY),
    };
    this.recordIphoneCreationSelectable(selectable);
    this.updateIphoneCreationLine();
    return true;
  }

  updateIphoneCreationDrag(event) {
    if (!this.iphoneCreationDrag || this.iphoneCreationDrag.pointerId !== event.pointerId) {
      return false;
    }
    this.iphoneCreationDrag.currentClient.set(event.clientX, event.clientY);
    if (this.pointerMovedPastClickThreshold(event, this.iphoneCreationDrag)) {
      this.lastIphoneTap = null;
    }
    this.recordIphoneCreationSelectable(this.pickIphoneCreationSelectable());
    this.updateIphoneCreationLine();
    return true;
  }

  finishIphoneCreationDrag(event) {
    if (!this.iphoneCreationDrag || this.iphoneCreationDrag.pointerId !== event.pointerId) {
      return false;
    }

    const drag = this.iphoneCreationDrag;
    if (event.type === "pointercancel") {
      this.cancelIphoneCreationDrag();
      return true;
    }

    this.setPointerFromEvent(event);
    drag.currentClient.set(event.clientX, event.clientY);
    this.recordIphoneCreationSelectable(this.pickIphoneCreationSelectable(drag));
    const chain = [...drag.chain];
    const wasTap = !this.pointerMovedPastClickThreshold(event, drag);
    this.iphoneCreationDrag = null;
    this.clearIphoneCreationLine();
    if (wasTap && chain.length <= 1 && this.handleIphoneDoubleTap(event)) {
      return true;
    }
    if (chain.length === 0) {
      this.selectSelectable(null);
      return true;
    }
    if (!this.createFromIphoneCreationChain(chain, event)) {
      this.selectSelectable(chain.at(-1));
    }
    return true;
  }

  cancelIphoneCreationDrag() {
    this.iphoneCreationDrag = null;
    this.clearIphoneCreationLine();
  }

  updateIphoneCreationLine() {
    if (!this.iphoneCreationTrailOverlay || !this.iphoneCreationTrailPolyline) {
      return;
    }
    const drag = this.iphoneCreationDrag;
    const points = (drag?.chain ?? [])
      .map((entry) => this.selectableOverlayPoint(entry))
      .filter(Boolean);
    if (drag?.currentClient && points.length > 0) {
      points.push(this.clientPointToCreationTrailPoint(drag.currentClient));
    }
    if (points.length < 2) {
      if (this.iphoneCreationTrailOverlay) {
        this.iphoneCreationTrailOverlay.hidden = true;
      }
      if (this.iphoneCreationTrailPolyline) {
        this.iphoneCreationTrailPolyline.setAttribute("points", "");
      }
      return;
    }

    this.iphoneCreationTrailOverlay.hidden = false;
    this.iphoneCreationTrailPolyline.setAttribute(
      "points",
      points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" "),
    );
  }

  clearIphoneCreationLine() {
    if (this.iphoneCreationTrailPolyline) {
      this.iphoneCreationTrailPolyline.setAttribute("points", "");
    }
    if (this.iphoneCreationTrailOverlay) {
      this.iphoneCreationTrailOverlay.hidden = true;
    }
  }

  selectableOverlayPoint(selectable) {
    const anchor = this.selectableAnchorPoint(selectable);
    if (!anchor) {
      return null;
    }
    return this.localPointToCreationTrailPoint(anchor);
  }

  localPointToCreationTrailPoint(point) {
    const worldPoint = this.gologContent.localToWorld(point.clone());
    const projected = worldPoint.project(this.camera);
    if (
      !Number.isFinite(projected.x) ||
      !Number.isFinite(projected.y)
    ) {
      return null;
    }

    const viewport = this.activeCanvasViewportClientRect();
    const containerRect = this.container.getBoundingClientRect();
    return new THREE.Vector2(
      viewport.left + ((projected.x + 1) / 2) * viewport.width - containerRect.left,
      viewport.top + ((-projected.y + 1) / 2) * viewport.height - containerRect.top,
    );
  }

  clientPointToCreationTrailPoint(point) {
    const containerRect = this.container.getBoundingClientRect();
    return new THREE.Vector2(point.x - containerRect.left, point.y - containerRect.top);
  }

  pickSelectableOfKind(kind) {
    if (kind === "sphere") {
      const hit = this.pickSphereHits({ far: Infinity })[0];
      return hit?.object?.userData?.sphereId
        ? { id: hit.object.userData.sphereId, kind: "sphere", hit }
        : null;
    }
    if (kind === "edge") {
      const hit = this.pickEdgeCone();
      return hit?.object?.userData?.edgeId
        ? { id: hit.object.userData.edgeId, kind: "edge", hit }
        : null;
    }
    if (kind === "surface") {
      const hit = this.pickSurfaceControl();
      return hit?.object?.userData?.surfaceId
        ? { id: hit.object.userData.surfaceId, kind: "surface", hit }
        : null;
    }
    if (kind === "volume") {
      const hit = this.pickVolumeControlHits()[0];
      return hit ? { id: hit.object.userData.volumeId, kind, hit } : null;
    }
    return null;
  }

  pickIphoneCreationSelectable(drag = this.iphoneCreationDrag) {
    if (drag?.kind) {
      return this.pickSelectableOfKind(drag.kind);
    }
    return this.pickSelectable({ preferSphere: true });
  }

  recordIphoneCreationSelectable(selectable) {
    if (!this.iphoneCreationDrag || !selectable) {
      return false;
    }
    const normalized = this.normalizeSelectable(selectable);
    if (!normalized) {
      return false;
    }
    if (!this.iphoneCreationDrag.kind) {
      this.iphoneCreationDrag.kind = normalized.kind;
    }
    if (normalized.kind !== this.iphoneCreationDrag.kind) {
      return false;
    }
    const chain = this.iphoneCreationDrag.chain;
    if (this.sameSelectable(chain.at(-1), normalized)) {
      return false;
    }
    if (chain.some((entry) => this.sameSelectable(entry, normalized))) {
      return false;
    }
    chain.push(normalized);
    this.updateIphoneCreationLine();
    return true;
  }

  createFromIphoneCreationChain(chain, event = null) {
    const entries = (chain ?? []).filter(Boolean);
    if (entries.length < 2) {
      return false;
    }
    if (entries.every((entry) => entry.kind === "sphere")) {
      let createdAny = false;
      for (let index = 0; index < entries.length - 1; index += 1) {
        const created = this.createFromSelectionPair(
          entries[index],
          entries[index + 1],
          event,
        );
        createdAny = createdAny || created;
      }
      if (createdAny) {
        this.rememberSelection(entries.at(-1));
      }
      return createdAny;
    }
    if (entries.every((entry) => entry.kind === "edge")) {
      let createdAny = false;
      for (let index = 0; index <= entries.length - 3; index += 1) {
        const edgeIds = entries.slice(index, index + 3).map((entry) => entry.id);
        if (this.createTwoSimplexFromEdgeIds(edgeIds)) {
          createdAny = true;
        }
      }
      if (!createdAny) {
        for (let index = 0; index < entries.length - 1; index += 1) {
          const created = this.createFromSelectionPair(
            entries[index],
            entries[index + 1],
            event,
          );
          createdAny = createdAny || created;
        }
      }
      if (createdAny) {
        this.rememberSelection(entries.at(-1));
      }
      return createdAny;
    }
    return false;
  }

  pickEdgeCone() {
    return this.pickEdgeConeHits()[0] ?? null;
  }

  attachInput() {
    const canvas = this.renderer.domElement;
    this.listen(canvas, "pointerdown", (event) => this.onPointerDown(event));
    this.listen(canvas, "pointermove", (event) => this.onPointerMove(event));
    this.listen(canvas, "pointerup", (event) => this.onPointerUp(event));
    this.listen(canvas, "pointercancel", (event) => this.onPointerUp(event));
    this.listen(canvas, "dblclick", (event) => this.onDoubleClick(event));
    this.listen(canvas, "wheel", (event) => this.onWheel(event), {
      passive: false,
    });
    this.listen(window, "keydown", (event) => this.onKeyDown(event));
    this.listen(window, "keyup", (event) => this.onKeyUp(event));
    this.listen(window, "blur", () => this.clearKeys());
    this.listen(document, "visibilitychange", () => {
      if (document.hidden) {
        this.clearKeys();
      }
    });
    this.listen(window, "resize", () => this.resize());
    if (window.visualViewport) {
      this.listen(window.visualViewport, "resize", () =>
        this.handleVisualViewportChange(),
      );
      this.listen(window.visualViewport, "scroll", () =>
        this.handleVisualViewportChange(),
      );
    }
  }

  listen(target, type, handler, options = undefined) {
    target.addEventListener(type, handler, options);
    this.releaseInputListeners.push(() =>
      target.removeEventListener(type, handler, options),
    );
  }

  onDoubleClick(event) {
    if (this.usesIphoneCreationDragMode()) {
      event.preventDefault();
      event.stopPropagation();
      if (event.sourceCapabilities?.firesTouchEvents) {
        return;
      }
      if (!this.active) {
        return;
      }
      this.renderer.domElement.focus();
      this.syncModifierKeysFromPointer(event);
      this.setPointerFromEvent(event);
      const selectable =
        this.pickSelectable({ preferSphere: true }) ??
        this.selectedSelectable();
      this.closeNestedPreviewIfAway(selectable);
      if (
        this.modeHead?.handleSelectableClick({
          gologId: this.state.gologId,
          selectable,
        })
      ) {
        return;
      }
      this.handleShiftSelectable(selectable, event);
      return;
    }
    if (this.modeHead && !this.modeHead.shouldEditLabelOnDoubleClick()) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (!this.active) {
      return;
    }
    event.preventDefault();
    this.renderer.domElement.focus();
    this.syncModifierKeysFromPointer(event);
    this.setPointerFromEvent(event);
    const selectable = this.pickSelectable();
    if (!selectable) {
      return;
    }
    if (this.modeHead && !this.modeHead.canEditLabels(this.state.gologId)) {
      return;
    }

    this.selectSelectable(selectable);
    this.requestLabelEdit(selectable, event);
  }

  onPointerDown(event) {
    if (!this.active || (event.button != null && event.button !== 0)) {
      return;
    }
    this.renderer.domElement.focus();
    try {
      this.renderer.domElement.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic pointer events do not create a
      // browser-owned active pointer, so capture can legitimately be unavailable.
    }
    this.syncModifierKeysFromPointer(event);
    this.setPointerFromEvent(event);
    if (this.virtualCellCapture.active) {
      event.preventDefault();
      this.pendingPointer = null;
      const selectable = this.pickSelectable();
      if (selectable?.kind === "edge") {
        this.toggleVirtualCellBoundaryEdge(selectable.id);
      }
      return;
    }
    if (this.trackIphonePointerDown(event)) {
      return;
    }
    if (this.beginIphoneCreationDrag(event)) {
      return;
    }

    if (event.shiftKey) {
      this.pendingPointer = null;
      const selectable = this.pickSelectable({ preferSphere: true });
      this.closeNestedPreviewIfAway(selectable);
      if (
        this.modeHead?.handleSelectableClick({
          gologId: this.state.gologId,
          selectable,
        })
      ) {
        return;
      }
      this.handleShiftSelectable(selectable, event);
      return;
    }

    const selectable = this.pickSelectable();
    this.pendingPointer = {
      pointerId: event.pointerId,
      stagedDrag: this.createStagedDrag(selectable, event),
      startScreen: new THREE.Vector2(event.clientX, event.clientY),
    };
  }

  createStagedDrag(selectable, event) {
    // Volume geometry follows its boundary faces; its selection handle is not
    // a new independent geometric degree of freedom.
    if (selectable?.kind === "volume") return null;
    const iphoneSelectionFocus = this.isIphoneTouchPointer(event)
      ? this.iphoneSelectedSphereFocusPoint()
      : null;
    if (iphoneSelectionFocus) {
      return {
        kind: "camera-orbit",
        pointer: this.pointer.clone(),
        focus: iphoneSelectionFocus,
        focusDistance: Math.max(
          CAMERA_MIN_FOCUS_DISTANCE,
          this.camera.position.distanceTo(iphoneSelectionFocus),
        ),
        localFrameOrbit: true,
      };
    }

    if (selectable && this.modeHead && !this.modeHead.canDragObject()) {
      return null;
    }
    if (selectable?.kind === "surface") {
      const controlDrag = this.makeSurfaceControlDrag(
        this.surfaceGraphics.get(selectable.id),
        event,
      );
      return controlDrag
        ? {
            kind: "surface",
            id: selectable.id,
            drag: controlDrag,
          }
        : null;
    }

    if (selectable?.kind === "edge") {
      const midpointDrag = this.makeEdgeMidpointDrag(
        this.edgeGraphics.get(selectable.id),
        event,
      );
      return midpointDrag
        ? {
            kind: "edge",
            id: selectable.id,
            drag: midpointDrag,
          }
        : null;
    }

    if (selectable?.kind === "sphere") {
      const sphereDrag = this.makeSphereDrag(selectable.hit);
      return sphereDrag
        ? {
            kind: "sphere",
            id: selectable.id,
            drag: sphereDrag,
          }
        : null;
    }

    const emptyDragMode =
      this.modeHead?.emptySpaceDragMode?.(this.cameraDragMode) ??
      this.cameraDragMode;
    if (emptyDragMode === CAMERA_DRAG_MODE_LOOK) {
      return {
        kind: "camera-look",
        pointer: this.pointer.clone(),
      };
    }

    const localFrameOrbit = Boolean(this.modeHead?.usesTouchGestures?.());
    const focus = localFrameOrbit
      ? this.cameraCenterScreenOrbitPivot()
      : this.cameraOrbitFocusPoint();
    if (localFrameOrbit) {
      this.centerInterestPoint = focus.clone();
    }
    return {
      kind: "camera-orbit",
      pointer: this.pointer.clone(),
      focus,
      focusDistance: Math.max(
        CAMERA_MIN_FOCUS_DISTANCE,
        this.camera.position.distanceTo(focus),
      ),
      localFrameOrbit,
    };
  }

  isNodeInspectorOpen() {
    const panel =
      this.renderer.domElement.ownerDocument?.querySelector("#status-panel");
    return Boolean(panel && !panel.hidden);
  }

  usesKeyboardOverlay() {
    return Boolean(this.modeHead?.usesKeyboardOverlay?.());
  }

  releasePointerCapture(event) {
    if (!this.renderer.domElement.hasPointerCapture(event.pointerId)) {
      return;
    }
    try {
      this.renderer.domElement.releasePointerCapture(event.pointerId);
    } catch {}
  }

  isIphoneTouchPointer(event) {
    return (
      this.modeHead?.usesTouchGestures?.() &&
      (!event.pointerType || event.pointerType === "touch")
    );
  }

  trackIphonePointerDown(event) {
    if (!this.isIphoneTouchPointer(event)) {
      return false;
    }
    this.iphonePointers.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    if (this.iphonePointers.size < 2) {
      return false;
    }
    this.startIphoneMultiTouchGesture();
    return true;
  }

  updateIphoneTouchGesture(event) {
    if (!this.isIphoneTouchPointer(event)) {
      return false;
    }
    if (this.iphonePointers.has(event.pointerId)) {
      this.iphonePointers.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
      });
    }
    if (!this.iphoneMultiTouch) {
      return false;
    }
    this.updateIphoneMultiTouchCamera();
    return true;
  }

  finishIphoneTouchGesture(event) {
    const wasMultiTouch = Boolean(
      this.iphoneMultiTouch?.pointerIds.includes(event.pointerId),
    );
    this.forgetIphonePointer(event.pointerId);
    if (!wasMultiTouch) {
      return false;
    }
    if (this.iphonePointers.size >= 2) {
      this.startIphoneMultiTouchGesture();
    } else {
      this.iphoneMultiTouch = null;
    }
    return true;
  }

  forgetIphonePointer(pointerId) {
    this.iphonePointers.delete(pointerId);
  }

  clearIphoneTouchGesture() {
    this.iphonePointers.clear();
    this.iphoneMultiTouch = null;
  }

  cancelActiveInteractionForIphoneGesture() {
    this.releaseDragAuthority(this.drag);
    this.drag = null;
    this.pendingPointer = null;
    this.cancelIphoneCreationDrag();
    this.lastIphoneTap = null;
  }

  startIphoneMultiTouchGesture() {
    const entries = [...this.iphonePointers.entries()].slice(0, 2);
    if (entries.length < 2) {
      this.iphoneMultiTouch = null;
      return;
    }
    this.cancelActiveInteractionForIphoneGesture();
    this.iphoneMultiTouch = {
      pointerIds: entries.map(([pointerId]) => pointerId),
      lastAngle: this.iphonePointerPairAngle(entries),
      lastDistance: this.iphonePointerPairDistance(entries),
      lastCenter: this.iphonePointerPairCenter(entries),
      focus: this.cameraCenterScreenOrbitPivot(),
    };
    this.centerInterestPoint = this.iphoneMultiTouch.focus.clone();
    this.cameraFocusDistance = Math.max(
      CAMERA_MIN_FOCUS_DISTANCE,
      this.camera.position.distanceTo(this.iphoneMultiTouch.focus),
    );
    this.orientCameraToward(this.iphoneMultiTouch.focus);
    this.updateCameraFrame();
  }

  iphonePointerPairAngle(entries) {
    const first = entries[0][1];
    const second = entries[1][1];
    return Math.atan2(second.y - first.y, second.x - first.x);
  }

  iphonePointerPairDistance(entries) {
    const first = entries[0][1];
    const second = entries[1][1];
    return Math.hypot(second.x - first.x, second.y - first.y);
  }

  iphonePointerPairCenter(entries) {
    const first = entries[0][1];
    const second = entries[1][1];
    return new THREE.Vector2((first.x + second.x) / 2, (first.y + second.y) / 2);
  }

  updateIphoneMultiTouchCamera() {
    const entries = this.iphoneMultiTouch.pointerIds
      .map((pointerId) => [pointerId, this.iphonePointers.get(pointerId)])
      .filter(([, point]) => point);
    if (entries.length < 2) {
      return;
    }
    const currentAngle = this.iphonePointerPairAngle(entries);
    const angleDelta = Math.atan2(
      Math.sin(currentAngle - this.iphoneMultiTouch.lastAngle),
      Math.cos(currentAngle - this.iphoneMultiTouch.lastAngle),
    );
    this.cameraRoll -= angleDelta * IPHONE_TWIST_CAMERA_SPEED;
    this.updateCameraFrame();

    const currentDistance = this.iphonePointerPairDistance(entries);
    const pinchDelta = currentDistance - this.iphoneMultiTouch.lastDistance;
    const pinchTravel = pinchDelta * IPHONE_PINCH_ZOOM_SPEED;
    if (this.usesIphoneTravelMode()) {
      this.moveCameraAndFocusAlongForward(pinchTravel, this.iphoneMultiTouch.focus);
    } else {
      this.zoomCameraAlongForward(pinchTravel);
    }

    const currentCenter = this.iphonePointerPairCenter(entries);
    const centerDelta = currentCenter.clone().sub(this.iphoneMultiTouch.lastCenter);
    this.panCameraByScreenDelta(
      centerDelta.multiplyScalar(IPHONE_TWO_FINGER_PAN_SPEED),
      { focus: this.iphoneMultiTouch.focus },
    );
    this.cameraFocusDistance = Math.max(
      CAMERA_MIN_FOCUS_DISTANCE,
      this.camera.position.distanceTo(this.iphoneMultiTouch.focus),
    );
    this.centerInterestPoint ??= this.iphoneMultiTouch.focus.clone();
    this.centerInterestPoint.copy(this.iphoneMultiTouch.focus);

    this.iphoneMultiTouch.lastAngle = currentAngle;
    this.iphoneMultiTouch.lastDistance = currentDistance;
    this.iphoneMultiTouch.lastCenter.copy(currentCenter);
    this.updateCameraOrientation();
    this.updateCameraFrame();
    this.emitCameraState();
  }

  currentRenderProfile() {
    return this.modeHead?.snapshot?.().presentation?.renderScale ?? {};
  }

  pointerMovedPastClickThreshold(event, pending) {
    const dx = event.clientX - pending.startScreen.x;
    const dy = event.clientY - pending.startScreen.y;
    return dx * dx + dy * dy > POINTER_CLICK_DRAG_THRESHOLD ** 2;
  }

  interactionOrigin(objectId) {
    return (
      (typeof this.state.operationOrigin === "function"
        ? this.state.operationOrigin("interaction:control", { id: objectId })
        : this.state.operationOrigin) ?? {
        source: "human-interface",
        role: "author",
      }
    );
  }

  beginDragAuthority(staged) {
    const claimant = this.interactionOrigin(staged.id);
    const claim = this.state.beginInteractionControl?.(staged.id, claimant, {
      ttlMs: DRAG_INTERACTION_AUTHORITY_TTL_MS,
    }) ?? {
      ok: false,
      objectId: staged.id,
      claimant,
      resourceIds: [],
    };
    if (claim.resourceIds?.length > 0 && typeof globalThis.setInterval === "function") {
      claim.renewalTimer = globalThis.setInterval(() => {
        this.state.renewInteractionControl?.(claim, {
          ttlMs: DRAG_INTERACTION_AUTHORITY_TTL_MS,
        });
      }, DRAG_INTERACTION_AUTHORITY_RENEW_MS);
    }
    return claim;
  }

  releaseDragAuthority(drag = null) {
    if (!drag) {
      return;
    }
    if (drag.interactionClaim) {
      if (
        drag.interactionClaim.renewalTimer !== undefined &&
        typeof globalThis.clearInterval === "function"
      ) {
        globalThis.clearInterval(drag.interactionClaim.renewalTimer);
        drag.interactionClaim.renewalTimer = undefined;
      }
      this.state.endInteractionControl?.(drag.interactionClaim);
    }
    if (drag.lockIds) {
      this.state.releaseLocks(drag.lockIds, this.client);
    }
  }

  startDragFromPendingPointer(event) {
    const pending = this.pendingPointer;
    if (!pending || pending.pointerId !== event.pointerId) {
      return false;
    }

    this.pendingPointer = null;
    this.lastIphoneTap = null;
    const staged = pending.stagedDrag;
    if (!staged) {
      return false;
    }

    if (staged.kind === "camera-orbit") {
      this.drag = {
        cameraOrbit: true,
        pointerId: event.pointerId,
        pointer: staged.pointer,
        focus: staged.focus,
        focusDistance: staged.focusDistance,
        localFrameOrbit: Boolean(staged.localFrameOrbit),
      };
      return true;
    }

    if (staged.kind === "camera-look") {
      this.drag = {
        cameraLook: true,
        pointerId: event.pointerId,
        pointer: staged.pointer,
      };
      return true;
    }

    const lock = this.state.acquireInteractionLock(staged.id, this.client);
    if (!lock.ok) {
      return false;
    }
    const interactionClaim = this.beginDragAuthority(staged);

    if (staged.kind === "surface") {
      this.drag = {
        surfaceId: staged.id,
        pointerId: event.pointerId,
        lockIds: lock.lockIds,
        interactionClaim,
        ...staged.drag,
      };
      return true;
    }

    if (staged.kind === "edge") {
      this.drag = {
        edgeId: staged.id,
        pointerId: event.pointerId,
        lockIds: lock.lockIds,
        interactionClaim,
        ...staged.drag,
      };
      return true;
    }

    this.drag = {
      id: staged.id,
      pointerId: event.pointerId,
      lockIds: lock.lockIds,
      interactionClaim,
      ...staged.drag,
    };
    return true;
  }

  onPointerMove(event) {
    if (!this.active) {
      return;
    }
    this.syncModifierKeysFromPointer(event);
    this.setPointerFromEvent(event);
    if (this.updateIphoneTouchGesture(event)) {
      return;
    }
    if (this.updateIphoneCreationDrag(event)) {
      return;
    }

    if (!this.drag || this.drag.pointerId !== event.pointerId) {
      if (
        !this.pendingPointer ||
        this.pendingPointer.pointerId !== event.pointerId ||
        !this.pointerMovedPastClickThreshold(event, this.pendingPointer) ||
        !this.startDragFromPendingPointer(event)
      ) {
        return;
      }
    }

    this.updateActiveDrag(event);
  }

  updateActiveDrag(event) {
    if (!this.drag || this.drag.pointerId !== event.pointerId) {
      return;
    }

    if (this.drag.cameraOrbit) {
      this.updateCameraOrbitDrag();
      return;
    }

    if (this.drag.cameraLook) {
      this.updateCameraLookDrag();
      return;
    }

    if (this.drag.surfaceId) {
      const coordinate = this.surfaceControlCoordinateFromRay(this.drag);
      if (coordinate === null) {
        return;
      }

      this.bus.emit("surface:move-control", {
        id: this.drag.surfaceId,
        controlCoordinate:
          this.drag.controlCoordinate + coordinate - this.drag.rayCoordinate,
        clientId: this.client.id,
        clientIp: this.client.ip,
        origin: this.drag.interactionClaim?.claimant,
        interaction: {
          mode: "drag",
          token: this.drag.interactionClaim?.token ?? null,
        },
      });
      return;
    }

    if (this.drag.edgeId) {
      const midpoint = this.edgeMidpointFromRay(this.drag);
      if (!midpoint) {
        return;
      }
      this.bus.emit("edge:move-midpoint", {
        id: this.drag.edgeId,
        midpoint,
        clientId: this.client.id,
        clientIp: this.client.ip,
        origin: this.drag.interactionClaim?.claimant,
        interaction: {
          mode: "drag",
          token: this.drag.interactionClaim?.token ?? null,
        },
      });
      return;
    }

    const spherePoint = this.intersectSphereDragPlane(this.drag);
    if (!spherePoint) {
      return;
    }
    this.bus.emit("sphere:move", {
      id: this.drag.id,
      position: spherePoint.sub(this.drag.offset),
      clientId: this.client.id,
      clientIp: this.client.ip,
      origin: this.drag.interactionClaim?.claimant,
      interaction: {
        mode: "drag",
        token: this.drag.interactionClaim?.token ?? null,
      },
    });
  }

  onPointerUp(event) {
    if (!this.active) {
      return;
    }
    this.syncModifierKeysFromPointer(event);
    if (this.finishIphoneTouchGesture(event)) {
      this.releasePointerCapture(event);
      return;
    }
    if (this.finishIphoneCreationDrag(event)) {
      this.releasePointerCapture(event);
      return;
    }
    if (this.drag?.pointerId === event.pointerId) {
      this.releaseDragAuthority(this.drag);
      this.drag = null;
      this.lastIphoneTap = null;
    } else if (this.pendingPointer?.pointerId === event.pointerId) {
      const pending = this.pendingPointer;
      this.pendingPointer = null;
      if (
        event.type !== "pointercancel" &&
        !this.pointerMovedPastClickThreshold(event, pending)
      ) {
        this.setPointerFromEvent(event);
        if (!this.handleIphoneDoubleTap(event)) {
          const selectable = this.pickSelectable();
          this.closeNestedPreviewIfAway(selectable);
          if (
            this.modeHead?.handleSelectableClick({
              gologId: this.state.gologId,
              selectable,
            })
          ) {
            return;
          }
          this.selectSelectable(selectable);
        }
      }
    }
    this.forgetIphonePointer(event.pointerId);
    this.releasePointerCapture(event);
  }

  handleIphoneDoubleTap(event) {
    if (!this.isIphoneTouchTap(event)) {
      return false;
    }

    const now = Number.isFinite(event.timeStamp)
      ? event.timeStamp
      : performance.now();
    const point = new THREE.Vector2(event.clientX, event.clientY);
    const lastTap = this.lastIphoneTap;
    this.lastIphoneTap = { time: now, point };

    if (
      !lastTap ||
      now - lastTap.time > IPHONE_DOUBLE_TAP_MS ||
      point.distanceToSquared(lastTap.point) > IPHONE_DOUBLE_TAP_RADIUS ** 2
    ) {
      return false;
    }

    this.lastIphoneTap = null;
    const selectable = this.pickSelectable({ preferSphere: true });
    this.closeNestedPreviewIfAway(selectable);
    if (
      this.modeHead?.handleSelectableClick({
        gologId: this.state.gologId,
        selectable,
      })
    ) {
      return true;
    }
    this.handleShiftSelectable(selectable, event);
    return true;
  }

  isIphoneTouchTap(event) {
    return this.isIphoneTouchPointer(event);
  }

  onWheel(event) {
    if (!this.active) {
      return;
    }
    event.preventDefault();
    this.zoomCameraAlongForward(-Math.sign(event.deltaY) * 1.4);
    this.updateCameraFrame();
    this.emitCameraState();
  }

  zoomCameraAlongForward(travel) {
    if (!Number.isFinite(travel) || Math.abs(travel) < DRAG_RAYCAST_EPSILON) {
      return 0;
    }
    const nextDistance = Math.max(
      CAMERA_MIN_FOCUS_DISTANCE,
      this.cameraFocusDistance - travel,
    );
    const appliedTravel = this.cameraFocusDistance - nextDistance;
    this.cameraFocusDistance = nextDistance;
    this.camera.position.addScaledVector(this.cameraFrame.forward, appliedTravel);
    return appliedTravel;
  }

  moveCameraAndFocusAlongForward(travel, focus = null) {
    if (!Number.isFinite(travel) || Math.abs(travel) < DRAG_RAYCAST_EPSILON) {
      return 0;
    }
    this.camera.position.addScaledVector(this.cameraFrame.forward, travel);
    focus?.addScaledVector(this.cameraFrame.forward, travel);
    return Math.abs(travel);
  }

  panCameraByScreenDelta(screenDelta, { focus = null } = {}) {
    const rawPixelX = Number(screenDelta?.x ?? 0);
    const rawPixelY = Number(screenDelta?.y ?? 0);
    const pixelX = Number.isFinite(rawPixelX) ? rawPixelX : 0;
    const pixelY = Number.isFinite(rawPixelY) ? rawPixelY : 0;
    if (
      Math.abs(pixelX) < DRAG_RAYCAST_EPSILON &&
      Math.abs(pixelY) < DRAG_RAYCAST_EPSILON
    ) {
      return 0;
    }
    const viewportHeight = Math.max(1, this.activeCanvasViewport().height);
    const worldPerPixel =
      (2 *
        Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2) *
        this.cameraFocusDistance) /
      viewportHeight;
    const movement = new THREE.Vector3()
      .addScaledVector(this.cameraFrame.right, -pixelX * worldPerPixel)
      .addScaledVector(this.cameraFrame.up, pixelY * worldPerPixel);
    this.camera.position.add(movement);
    if (focus) {
      focus.add(movement);
    }
    return movement.length();
  }

  onKeyDown(event) {
    if (!this.active) {
      return;
    }
    if (event.key === "Escape" && this.virtualCellCapture.active) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.cancelVirtualCellCapture();
      return;
    }
    if (this.isEditableEventTarget(event.target)) {
      return;
    }
    if ((event.key === "r" || event.key === "R") &&
      !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!event.repeat) {
        this.toggleCameraDragMode();
      }
      return;
    }
    if (event.key === "Backspace" && this.deleteHoveredEdgeFromKeyboard()) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if ([" ", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
      event.preventDefault();
    }
    this.recordKey(event.key, true);
    if ((event.key === "e" || event.key === "E") &&
      !event.ctrlKey && !event.metaKey && !event.altKey) {
      if (this.modeHead && !this.modeHead.canInspectNestedGolog()) {
        return;
      }
      const selectable = this.pickSelectable({ preferSphere: true });
      if (!selectable || event.repeat) {
        if (!event.repeat) {
          event.preventDefault();
          event.stopImmediatePropagation();
          this.closeNestedGologPreview();
          this.closePayloadBillboardPreview();

        }
        return;
      }

      if (this.hasNestedPreview(selectable.id)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.bus.emit(selectable.kind === "sphere" ? "sphere:nested-golog-enter" : "object:nested-golog-enter", { id: selectable.id });
        return;
      }

      if (this.hasPayloadBillboardPreview(selectable.id)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.closePayloadBillboardPreview();
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation();
      const clientPoint = this.payloadPickClientPoint();
      this.bus.emit("payload:scene-pick", {
        id: selectable.id,
        kind: selectable.kind,
        clientX: clientPoint.x,
        clientY: clientPoint.y,
      });
    }
  }

  selectedSelectable() {
    const id = this.state?.selectedSimplexId;
    if (!id) {
      return null;
    }
    const object = this.state.getObject?.(id);
    if (!object) {
      return null;
    }
    if (object.dimension === 0) {
      return { id, kind: "sphere" };
    }
    if (object.dimension === 1) {
      return { id, kind: "edge" };
    }
    if (object.dimension === 2) {
      return { id, kind: "surface" };
    }
    if (object.kind === "volume") return { id, kind: "volume" };
    return null;
  }

  virtualCellCaptureSnapshot() {
    const edgeIds = [...this.virtualCellCapture.edgeIds];
    const boundary = this.state.inferVirtualCellBoundary?.(edgeIds) ?? null;
    return {
      active: Boolean(this.virtualCellCapture.active),
      edgeIds,
      valid: Boolean(boundary),
      boundary,
    };
  }

  emitVirtualCellCaptureChanged() {
    const snapshot = this.virtualCellCaptureSnapshot();
    this.edgeRenderer?.updateCapture?.(snapshot.edgeIds);
    this.bus.emit("virtual-cell:capture-changed", snapshot);
    return snapshot;
  }

  toggleVirtualCellBoundaryEdge(edgeId) {
    const edgeIds = this.virtualCellCapture.edgeIds;
    const index = edgeIds.indexOf(edgeId);
    if (index >= 0) {
      edgeIds.splice(index, 1);
    } else {
      edgeIds.push(edgeId);
    }
    return this.emitVirtualCellCaptureChanged();
  }

  cancelVirtualCellCapture() {
    this.virtualCellCapture = { active: false, edgeIds: [] };
    return this.emitVirtualCellCaptureChanged();
  }

  toggleVirtualCellCapture() {
    if (!this.modeHead?.usesVirtualDoubleCreation?.()) {
      return this.virtualCellCaptureSnapshot();
    }
    if (!this.virtualCellCapture.active) {
      this.virtualCellCapture = { active: true, edgeIds: [] };
      return this.emitVirtualCellCaptureChanged();
    }
    if (this.virtualCellCapture.edgeIds.length === 0) {
      return this.cancelVirtualCellCapture();
    }
    const boundary = this.state.inferVirtualCellBoundary?.(
      this.virtualCellCapture.edgeIds,
    );
    if (!boundary) {
      return this.emitVirtualCellCaptureChanged();
    }
    const id = `virtual-cell-${this.state.nextSurfaceId}`;
    this.bus.emit("element:create", {
      id,
      elementKind: VIRTUAL_DOUBLE_ELEMENT_KINDS.CELL,
      ...boundary,
    });
    this.virtualCellCapture = { active: false, edgeIds: [] };
    return this.emitVirtualCellCaptureChanged();
  }

  deleteHoveredEdgeFromKeyboard() {
    if (this.modeHead && !this.modeHead.canDeleteEdgeFromKeyboard()) {
      return false;
    }

    const selectable = this.pickSelectable();
    if (selectable?.kind !== "edge") {
      return false;
    }

    this.bus.emit("edge:delete", {
      id: selectable.id,
      clientId: this.client.id,
      clientIp: this.client.ip,
    });
    this.selectionBuffer = this.selectionBuffer.filter(
      (entry) => entry.id !== selectable.id,
    );
    return true;
  }

  onKeyUp(event) {
    if (!this.active) {
      return;
    }
    // A gesture may focus an editor before its modifier is released.
    // Releases must clear recorded keys regardless of the current target.
    this.recordKey(event.key, false);
  }

  isEditableEventTarget(target) {
    return Boolean(
      target?.closest?.("input, textarea, select, button, [contenteditable='true']"),
    );
  }

  recordKey(key, isDown) {
    this.setRecordedKey(key, isDown);
  }

  setRecordedKey(key, isDown) {
    const hadKey = this.keys.has(key);
    if (isDown) {
      this.keys.add(key);
    } else {
      this.keys.delete(key);
    }
    if (hadKey === isDown) {
      return;
    }
    this.bus.emit("input:keys-changed", { keys: [...this.keys].sort() });
  }

  syncModifierKeysFromPointer(event) {
    this.setRecordedKey("Shift", event.shiftKey);
    this.setRecordedKey("Alt", event.altKey);
    this.setRecordedKey("Control", event.ctrlKey);
    this.setRecordedKey("Meta", event.metaKey);
  }

  clearKeys() {
    if (this.keys.size === 0) {
      return;
    }
    this.keys.clear();
    this.bus.emit("input:keys-changed", { keys: [] });
  }

  activeCanvasViewport() {
    return this.cameraViewportState;
  }

  activeCanvasViewportClientRect() {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const viewport = this.activeCanvasViewport();
    const scaleX = rect.width / Math.max(1, viewport.fullWidth);
    const scaleY = rect.height / Math.max(1, viewport.fullHeight);
    const left = rect.left + viewport.x * scaleX;
    const top = rect.top + viewport.y * scaleY;
    const width = viewport.width * scaleX;
    const height = viewport.height * scaleY;
    return {
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
    };
  }

  setPointerFromEvent(event) {
    const viewport = this.activeCanvasViewportClientRect();
    this.lastPointerClient = new THREE.Vector2(event.clientX, event.clientY);
    this.pointer.x =
      ((event.clientX - viewport.left) / Math.max(1, viewport.width)) * 2 - 1;
    this.pointer.y =
      -(((event.clientY - viewport.top) / Math.max(1, viewport.height)) * 2 - 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    this.bus.emit("input:pointer-moved", {
      normalized: this.pointer.clone(),
      client: new THREE.Vector2(event.clientX, event.clientY),
    });
  }

  payloadPickClientPoint() {
    if (this.lastPointerClient) {
      return this.lastPointerClient.clone();
    }
    const viewport = this.activeCanvasViewportClientRect();
    return new THREE.Vector2(
      viewport.left + viewport.width / 2,
      viewport.top + viewport.height / 2,
    );
  }

  pickSphere({ far = this.raycaster.far } = {}) {
    return this.pickSphereHits({ far })[0] ?? null;
  }

  pickSphereHits({ far = this.raycaster.far } = {}) {
    const previousFar = this.raycaster.far;
    this.raycaster.far = far;
    try {
      const meshes = [...this.sphereMeshes.values()];
      if (this.payloadBillboardPreview?.pickMesh) {
        meshes.push(this.payloadBillboardPreview.pickMesh);
      }
      return this.raycaster.intersectObjects(meshes, false);
    } finally {
      this.raycaster.far = previousFar;
    }
  }

  updateConeSelection(selectedEdgeId) {
    this.edgeRenderer.updateSelection(selectedEdgeId);
  }

  updateSurfaceControlSelection(selectedSurfaceId) {
    this.surfaceRenderer.updateSelection(selectedSurfaceId);
  }

  makeEdgeMidpointDrag(edge, event) {
    if (!edge) {
      return null;
    }
    const source = this.sphereMeshes.get(edge.sourceId);
    const target = this.sphereMeshes.get(edge.targetId);
    if (!source || !target) {
      return null;
    }

    const normal = target.position.clone().sub(source.position).normalize();
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
      normal,
      edge.midpoint,
    );

    if (this.isRayShallowToPlane(normal, EDGE_PLANE_SHALLOW_ANGLE_SIN)) {
      const unstableDirection = this.projectRayDirectionToPlane(normal);
      if (!unstableDirection) {
        return null;
      }
      const lineDirection = normal.clone().cross(unstableDirection).normalize();
      const rayCoordinate = this.closestRayLineCoordinate({
        lineOrigin: edge.midpoint,
        lineDirection,
      });
      if (rayCoordinate === null) {
        return null;
      }
      return {
        edgeDragMode: "plane-stable-line",
        lineOrigin: edge.midpoint.clone(),
        lineDirection,
        midpoint: edge.midpoint.clone(),
        rayCoordinate,
      };
    }

    const rayPoint = this.gologLocalRay().intersectPlane(
      plane,
      new THREE.Vector3(),
    );
    if (!rayPoint) {
      return null;
    }

    return {
      edgeDragMode: "plane",
      plane,
      midpoint: edge.midpoint.clone(),
      rayPoint,
    };
  }

  makeSurfaceControlDrag(surface, event) {
    if (!surface) {
      return null;
    }

    const lineOrigin = surface.controlPoint
      .clone()
      .addScaledVector(surface.controlDirection, -surface.controlCoordinate);
    const rayCoordinate = this.closestRayLineCoordinate({
      lineOrigin,
      lineDirection: surface.controlDirection,
    });
    if (rayCoordinate === null) {
      return null;
    }

    return {
      lineOrigin,
      lineDirection: surface.controlDirection.clone(),
      controlCoordinate: surface.controlCoordinate,
      rayCoordinate,
    };
  }

  makeSphereDrag(sphereHit) {
    const planeNormal = this.worldDirectionToGologLocal(this.cameraFrame.forward);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
      planeNormal,
      sphereHit.object.position,
    );
    const point = this.intersectSphereDragPlane({ plane });
    if (!point) {
      return null;
    }
    return {
      plane,
      offset: point.sub(sphereHit.object.position),
    };
  }

  intersectSphereDragPlane(drag) {
    return this.gologLocalRay().intersectPlane(drag.plane, new THREE.Vector3());
  }

  isRayShallowToPlane(normal, threshold = DRAG_SHALLOW_ANGLE_SIN) {
    return (
      Math.abs(this.gologLocalRay().direction.dot(normal)) <
      threshold
    );
  }

  projectRayDirectionToPlane(normal) {
    const rayDirection = this.gologLocalRay().direction;
    const direction = rayDirection
      .clone()
      .addScaledVector(normal, -rayDirection.dot(normal));
    if (direction.lengthSq() < DRAG_RAYCAST_EPSILON) {
      return null;
    }
    return direction.normalize();
  }

  closestRayLineCoordinate({ lineOrigin, lineDirection }) {
    const ray = this.gologLocalRay();
    const rayDirection = ray.direction;
    const line = lineDirection.clone().normalize();
    const rayLineDot = rayDirection.dot(line);
    const denominator = 1 - rayLineDot ** 2;
    if (denominator < DRAG_SHALLOW_ANGLE_SIN ** 2) {
      return null;
    }

    const originDelta = ray.origin.clone().sub(lineOrigin);
    const rayOriginDot = rayDirection.dot(originDelta);
    const lineOriginDot = line.dot(originDelta);
    const rayDistance =
      (rayLineDot * lineOriginDot - rayOriginDot) / denominator;
    if (rayDistance < 0) {
      return null;
    }
    return (lineOriginDot - rayLineDot * rayOriginDot) / denominator;
  }

  surfaceControlCoordinateFromRay(drag) {
    return this.closestRayLineCoordinate({
      lineOrigin: drag.lineOrigin,
      lineDirection: drag.lineDirection,
    });
  }

  edgeMidpointFromRay(drag) {
    if (drag.edgeDragMode === "plane") {
      const point = this.gologLocalRay().intersectPlane(
        drag.plane,
        new THREE.Vector3(),
      );
      if (!point) {
        return null;
      }
      return drag.midpoint.clone().add(point.sub(drag.rayPoint));
    }

    const coordinate = this.closestRayLineCoordinate({
      lineOrigin: drag.lineOrigin,
      lineDirection: drag.lineDirection,
    });
    if (coordinate === null) {
      return null;
    }

    return drag.midpoint
      .clone()
      .addScaledVector(drag.lineDirection, coordinate - drag.rayCoordinate);
  }

  gologLocalRay() {
    return this.raycaster.ray.clone().applyMatrix4(this.gologWorldInverse());
  }

  worldDirectionToGologLocal(direction) {
    return direction.clone().transformDirection(this.gologWorldInverse());
  }

  worldPointToGologLocal(point) {
    return point.clone().applyMatrix4(this.gologWorldInverse());
  }

  gologWorldInverse() {
    this.gologContent.updateMatrixWorld(true);
    return new THREE.Matrix4().copy(this.gologContent.matrixWorld).invert();
  }

  cameraForwardFromAngles(angles = this.cameraAngles) {
    return new THREE.Vector3(
      Math.sin(angles.yaw) * Math.cos(angles.pitch),
      Math.cos(angles.yaw) * Math.cos(angles.pitch),
      Math.sin(angles.pitch),
    ).normalize();
  }

  cameraAnglesFromForward(direction) {
    const forward = direction.clone().normalize();
    return {
      yaw: Math.atan2(forward.x, forward.y),
      pitch: THREE.MathUtils.clamp(
        Math.asin(THREE.MathUtils.clamp(forward.z, -1, 1)),
        -MAX_CAMERA_PITCH,
        MAX_CAMERA_PITCH,
      ),
    };
  }

  orientCameraToward(focus) {
    const forward = focus.clone().sub(this.camera.position);
    const distance = forward.length();
    if (distance < CAMERA_MIN_FOCUS_DISTANCE) {
      return false;
    }
    this.cameraAngles = this.cameraAnglesFromForward(forward);
    this.cameraFocusDistance = distance;
    this.updateCameraOrientation();
    return true;
  }

  cameraOrbitFocusPoint() {
    return this.cameraFrame.origin
      .clone()
      .addScaledVector(this.cameraFrame.forward, this.cameraFocusDistance);
  }

  cameraCenterScreenOrbitPivot() {
    const selectedFocus = this.iphoneSelectedSphereFocusPoint();
    if (selectedFocus) {
      return selectedFocus;
    }
    return this.centerInterestPoint?.clone() ?? this.cameraOrbitFocusPoint();
  }

  activeCenterInterestPoint() {
    if (this.drag?.localFrameOrbit && this.drag.focus) {
      return this.drag.focus;
    }
    if (this.iphoneMultiTouch?.focus) {
      return this.iphoneMultiTouch.focus;
    }
    return this.cameraCenterScreenOrbitPivot();
  }

  updateCenterInterestMarker() {
    if (!this.centerInterestMarker) {
      return;
    }
    if (!this.modeHead?.usesTouchGestures?.()) {
      this.centerInterestMarker.visible = false;
      return;
    }
    const point = this.activeCenterInterestPoint();
    if (!point) {
      this.centerInterestMarker.visible = false;
      return;
    }
    this.centerInterestPoint = point.clone();
    this.centerInterestMarker.position.copy(point);
    this.centerInterestMarker.scale.setScalar(1);
    this.centerInterestMarker.visible = true;
  }

  pointerPerspectiveAngles(pointer) {
    const halfVerticalFov = THREE.MathUtils.degToRad(this.camera.fov) / 2;
    const halfHorizontalFov = Math.atan(
      Math.tan(halfVerticalFov) * this.camera.aspect,
    );
    return new THREE.Vector2(
      Math.atan(pointer.x * Math.tan(halfHorizontalFov)),
      Math.atan(pointer.y * Math.tan(halfVerticalFov)),
    );
  }

  cameraOrbitPointerDelta(startPointer, currentPointer = this.pointer) {
    return this.pointerPerspectiveAngles(currentPointer).sub(
      this.pointerPerspectiveAngles(startPointer),
    );
  }

  updateCameraOrbitDrag() {
    if (this.drag.localFrameOrbit) {
      this.updateCameraLocalFrameOrbitDrag();
      return;
    }
    const delta = this.cameraOrbitPointerDelta(this.drag.pointer).multiplyScalar(
      this.cameraOrbitSpeed,
    );
    const angles = {
      yaw: this.cameraAngles.yaw + delta.x,
      pitch: THREE.MathUtils.clamp(
        this.cameraAngles.pitch + delta.y,
        -MAX_CAMERA_PITCH,
        MAX_CAMERA_PITCH,
      ),
    };
    const distance = Math.max(
      CAMERA_MIN_FOCUS_DISTANCE,
      this.cameraFocusDistance,
    );
    const forward = this.cameraForwardFromAngles(angles);
    this.cameraAngles = angles;
    this.cameraFocusDistance = distance;
    this.camera.position.copy(this.drag.focus).addScaledVector(forward, -distance);
    this.drag.pointer.copy(this.pointer);
    this.drag.focusDistance = distance;
    this.updateCameraOrientation();
    this.updateCameraFrame();
    this.emitCameraState();
  }

  updateCameraLocalFrameOrbitDrag() {
    const delta = this.cameraOrbitPointerDelta(this.drag.pointer).multiplyScalar(
      this.cameraOrbitSpeed,
    );
    this.orbitCameraAroundFocusLocal(this.drag.focus, delta);
    this.drag.pointer.copy(this.pointer);
    this.drag.focusDistance = this.cameraFocusDistance;
    this.updateCameraFrame();
    this.emitCameraState();
  }

  orbitCameraAroundFocusLocal(focus, delta) {
    if (!focus) {
      return false;
    }
    const offset = this.camera.position.clone().sub(focus);
    const distance = offset.length();
    if (distance < CAMERA_MIN_FOCUS_DISTANCE) {
      return false;
    }
    const horizontalAxis = this.cameraFrame.up.clone().normalize();
    const verticalAxis = this.cameraFrame.right.clone().normalize();
    const horizontal = new THREE.Quaternion().setFromAxisAngle(
      horizontalAxis,
      -delta.x,
    );
    const vertical = new THREE.Quaternion().setFromAxisAngle(
      verticalAxis,
      delta.y,
    );
    offset.applyQuaternion(horizontal).applyQuaternion(vertical);
    this.camera.position.copy(focus).add(offset);
    return this.orientCameraToward(focus);
  }

  updateCameraLookDrag() {
    const delta = this.cameraOrbitPointerDelta(this.drag.pointer).multiplyScalar(
      this.cameraDragSpeed,
    );
    this.cameraAngles = {
      yaw: this.cameraAngles.yaw + delta.x,
      pitch: THREE.MathUtils.clamp(
        this.cameraAngles.pitch + delta.y,
        -MAX_CAMERA_PITCH,
        MAX_CAMERA_PITCH,
      ),
    };
    this.drag.pointer.copy(this.pointer);
    this.updateCameraOrientation();
    this.updateCameraFrame();
    this.emitCameraState();
  }

  makePlaneBasisFromNormal(normal) {
    return calculatePlaneBasisFromNormal(normal);
  }

  projectPointToCanvas(point) {
    const viewport = this.activeCanvasViewport();
    const projected = point.clone().project(this.camera);
    return new THREE.Vector2(
      viewport.x + ((projected.x + 1) / 2) * viewport.width,
      viewport.y + ((1 - projected.y) / 2) * viewport.height,
    );
  }

  intersectSelectionSphere() {
    const center = this.cameraFrame.origin;
    const offset = this.raycaster.ray.origin.clone().sub(center);
    const b = offset.dot(this.raycaster.ray.direction);
    const c = offset.lengthSq() - SELECTION_SPHERE_RADIUS ** 2;
    const discriminant = b ** 2 - c;
    if (discriminant < 0) {
      return null;
    }
    const sqrtDiscriminant = Math.sqrt(discriminant);
    const near = -b - sqrtDiscriminant;
    const far = -b + sqrtDiscriminant;
    const distance = near > 0 ? near : far;
    if (distance <= 0) {
      return null;
    }
    return this.raycaster.ray.at(distance, new THREE.Vector3());
  }

  updateCameraOrientation() {
    const forward = this.cameraForwardFromAngles();
    const right = forward.clone().cross(WORLD_UP).normalize();
    const up = right.clone().cross(forward).normalize();
    if (Math.abs(this.cameraRoll) > DRAG_RAYCAST_EPSILON) {
      up.applyQuaternion(
        new THREE.Quaternion().setFromAxisAngle(forward, this.cameraRoll),
      );
    }
    this.camera.up.copy(up);
    this.camera.lookAt(this.camera.position.clone().add(forward));
  }

  updateCameraFrame() {
    this.updateCameraOrientation();
    this.camera.updateMatrixWorld();
    this.camera.getWorldPosition(this.cameraFrame.origin);
    this.camera.getWorldDirection(this.cameraFrame.forward).normalize();
    this.cameraFrame.right
      .setFromMatrixColumn(this.camera.matrixWorld, 0)
      .normalize();
    this.cameraFrame.up
      .setFromMatrixColumn(this.camera.matrixWorld, 1)
      .normalize();
    this.emitCameraFrameChanged();
  }

  emitCameraFrameChanged() {
    this.bus.emit("camera:frame-changed", {
      origin: this.cameraFrame.origin.clone(),
      right: this.cameraFrame.right.clone(),
      up: this.cameraFrame.up.clone(),
      forward: this.cameraFrame.forward.clone(),
      selectionSphereRadius: SELECTION_SPHERE_RADIUS,
      viewport: { ...this.activeCanvasViewport() },
    });
  }

  updateCameraFromKeys(elapsedSeconds = 1 / 60) {
    const seconds = Number.isFinite(elapsedSeconds)
      ? THREE.MathUtils.clamp(elapsedSeconds, 0, CAMERA_MAX_FRAME_SECONDS)
      : 0;
    if (seconds === 0) {
      return;
    }
    const movement = new THREE.Vector3();
    if (this.keys.has("w") || this.keys.has("W")) {
      movement.add(this.cameraFrame.forward);
    }
    if (this.keys.has("s") || this.keys.has("S")) {
      movement.sub(this.cameraFrame.forward);
    }
    if (this.keys.has("d") || this.keys.has("D")) {
      movement.add(this.cameraFrame.right);
    }
    if (this.keys.has("a") || this.keys.has("A")) {
      movement.sub(this.cameraFrame.right);
    }
    if (this.keys.has(" ")) {
      movement.add(WORLD_UP);
    }
    if (this.keys.has("c") || this.keys.has("C")) {
      movement.sub(WORLD_UP);
    }

    if (movement.lengthSq() === 0) {
      return;
    }

    movement.normalize().multiplyScalar(CAMERA_MOVE_SPEED * seconds);
    this.camera.position.add(movement);
    if (this.drag?.cameraOrbit && this.drag.focus) {
      this.drag.focus.add(movement);
    }
    this.updateCameraFrame();
    this.emitCameraState();
  }

  emitCameraState() {
    this.bus.emit("camera:moved", { position: this.camera.position.clone() });
  }

  resize() {
    if (!this.active && this.renderer.domElement.hidden) {
      return;
    }
    const keyboardOpen = this.updateIphoneKeyboardOverlayState();
    if (this.usesKeyboardOverlay() && keyboardOpen && this.iphoneStableRenderSize) {
      this.emitCameraFrameChanged();
      return;
    }
    const { width, height } = this.renderSize();
    this.renderer.setSize(width, height, false);
    this.applyCameraViewport(width, height);
    this.emitCameraFrameChanged();
  }

  handleVisualViewportChange() {
    if (!this.usesKeyboardOverlay()) {
      this.resize();
      return;
    }

    const wasKeyboardOpen = this.iphoneKeyboardOpen;
    const keyboardOpen = this.updateIphoneKeyboardOverlayState();
    if (keyboardOpen) {
      this.emitCameraFrameChanged();
      return;
    }
    if (wasKeyboardOpen) {
      this.resize();
    }
  }

  renderSize() {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    if (!this.usesKeyboardOverlay()) {
      this.iphoneStableRenderSize = null;
      return { width, height };
    }

    const stableHeight = Math.max(height, this.iphoneStableSceneHeight());
    const visualViewport = window.visualViewport;
    const keyboardLikelyOpen = Boolean(
      visualViewport && visualViewport.height < window.innerHeight - 80,
    );
    if (
      !this.iphoneStableRenderSize ||
      this.iphoneStableRenderSize.width !== width ||
      (!keyboardLikelyOpen && stableHeight > this.iphoneStableRenderSize.height)
    ) {
      this.iphoneStableRenderSize = { width, height: stableHeight };
    }

    return this.iphoneStableRenderSize;
  }

  iphoneStableSceneHeight() {
    return Math.max(1, window.innerHeight);
  }

  updateIphoneKeyboardOverlayState() {
    const documentElement = this.renderer.domElement.ownerDocument?.documentElement;
    const body = this.renderer.domElement.ownerDocument?.body;
    if (!this.usesKeyboardOverlay()) {
      this.iphoneKeyboardOpen = false;
      this.iphoneKeyboardViewportIntent = false;
      this.iphoneLastKeyboardOcclusion = 0;
      documentElement?.style.removeProperty("--app-height");
      body?.style.removeProperty("--app-height");
      return false;
    }

    const stableHeight = Math.max(
      1,
      this.iphoneStableRenderSize?.height ?? 0,
      this.iphoneStableSceneHeight(),
    );
    const visualViewport = window.visualViewport;
    const visualHeight = Math.max(1, visualViewport?.height ?? stableHeight);
    const keyboardOpen =
      visualHeight < stableHeight * IPHONE_KEYBOARD_OPEN_RATIO ||
      stableHeight - visualHeight >= IPHONE_KEYBOARD_MIN_OCCLUSION;
    this.iphoneKeyboardOpen = keyboardOpen;
    this.iphoneLastKeyboardOcclusion = keyboardOpen
      ? Math.max(0, stableHeight - visualHeight)
      : 0;
    const appHeight = this.iphoneStableRenderSize?.height ?? stableHeight;
    documentElement?.style.setProperty("--app-height", `${appHeight}px`);
    body?.style.setProperty("--app-height", `${appHeight}px`);
    return keyboardOpen;
  }

  prepareIphoneKeyboardViewport() {
    if (!this.usesKeyboardOverlay()) {
      return;
    }
    this.iphoneKeyboardViewportIntent = true;
    this.updateIphoneKeyboardOverlayState();
  }

  releaseIphoneKeyboardViewport() {
    if (!this.iphoneKeyboardViewportIntent) {
      return;
    }
    this.iphoneKeyboardViewportIntent = false;
    this.updateIphoneKeyboardOverlayState();
  }

  applyCameraViewport(width, height) {
    const viewport = this.computeCameraViewport(width, height);
    this.cameraViewportState = viewport;
    this.camera.aspect = width / height;
    this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
  }

  computeCameraViewport(width, height) {
    const base = {
      x: 0,
      y: 0,
      width,
      height,
      fullWidth: width,
      fullHeight: height,
      keyboardOcclusion: 0,
      keyboardPredicted: false,
      keyboardMeasured: false,
    };
    if (!this.usesKeyboardOverlay()) {
      this.iphoneKeyboardViewportIntent = false;
      this.iphoneLastKeyboardOcclusion = 0;
      return base;
    }

    return {
      ...base,
      keyboardOcclusion: this.iphoneLastKeyboardOcclusion,
      keyboardMeasured: this.iphoneKeyboardOpen,
    };
  }

  renderFrame() {
    const viewport = this.activeCanvasViewport();
    const bottom = Math.max(
      0,
      viewport.fullHeight - viewport.y - viewport.height,
    );
    const cropped =
      viewport.x !== 0 ||
      viewport.y !== 0 ||
      viewport.width !== viewport.fullWidth ||
      viewport.height !== viewport.fullHeight;

    this.renderer.setScissorTest(false);
    this.renderer.setViewport(0, 0, viewport.fullWidth, viewport.fullHeight);
    this.renderer.clear();
    this.renderer.setViewport(
      viewport.x,
      bottom,
      viewport.width,
      viewport.height,
    );
    if (cropped) {
      this.renderer.setScissor(
        viewport.x,
        bottom,
        viewport.width,
        viewport.height,
      );
      this.renderer.setScissorTest(true);
    }
    this.renderer.render(this.scene, this.camera);
    if (cropped) {
      this.renderer.setScissorTest(false);
    }
  }

  animate(timestamp) {
    if (this.disposed) {
      return;
    }
    requestAnimationFrame((nextTimestamp) => this.animate(nextTimestamp));
    if (!this.active) {
      this.lastAnimationTime = null;
      return;
    }
    const elapsedSeconds = Number.isFinite(timestamp) && Number.isFinite(this.lastAnimationTime)
      ? (timestamp - this.lastAnimationTime) / 1000
      : 0;
    this.lastAnimationTime = timestamp;
    this.updateCameraFromKeys(elapsedSeconds);
    this.updateLabelRenderOrder();
    this.updatePayloadBillboardPreviewTransform();
    this.updateCenterInterestMarker();
    this.renderFrame();
  }
}
