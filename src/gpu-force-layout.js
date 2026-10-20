import * as THREE from "three";
import { LAYOUT_SCHEMA_GLSL, normalizeLayoutSettings } from "./layout-schema.js";
import { packLayoutLedger } from "./layout-graph-extractor.js";

const vertexShader = `
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

function texture(data, width, height = 1, type = THREE.FloatType) {
  if (type === THREE.HalfFloatType) data = Uint16Array.from(data, THREE.DataUtils.toHalfFloat);
  const result = new THREE.DataTexture(data, Math.max(1, width), height,
    THREE.RGBAFormat, type);
  result.minFilter = result.magFilter = THREE.NearestFilter;
  result.needsUpdate = true;
  return result;
}

function target(width, count = 1, types = []) {
  const result = new THREE.WebGLRenderTarget(Math.max(1, width), 1, {
    count, type: THREE.FloatType, format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
    depthBuffer: false, stencilBuffer: false,
  });
  result.textures.forEach((image, index) => { image.type = types[index] ?? THREE.FloatType; });
  return result;
}

const mixedFrameSupport = new WeakMap();
function supportsMixedFrames(renderer) {
  if (mixedFrameSupport.has(renderer)) return mixedFrameSupport.get(renderer);
  const previous = renderer.getRenderTarget(), probe = target(1, 4,
    [THREE.FloatType, THREE.FloatType, THREE.HalfFloatType, THREE.FloatType]);
  const viewport = renderer.getViewport(new THREE.Vector4()), scissor = renderer.getScissor(new THREE.Vector4());
  const scissorTest = renderer.getScissorTest();
  let supported = false;
  try {
    renderer.setRenderTarget(probe);
    const gl = renderer.getContext();
    supported = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  } catch { supported = false; }
  finally {
    renderer.setViewport(viewport); renderer.setScissor(scissor);
    renderer.setScissorTest(scissorTest); renderer.setRenderTarget(previous); probe.dispose();
  }
  mixedFrameSupport.set(renderer, supported);
  return supported;
}

function channel(data, count, stride, slot) {
  const out = new Float32Array(Math.max(1, count) * 4);
  for (let row = 0; row < count; row++) {
    out.set(data.subarray(row * stride + slot * 4, row * stride + slot * 4 + 4), row * 4);
  }
  return out;
}

const accessors = `
uniform sampler2D uQ, uVelocity, uActivity;
uniform sampler2D uTargets;
uniform sampler2D uFrame0, uFrame1, uFrame2, uFrame3;
uniform sampler2D uInfo0, uInfo1, uInfo2, uIndices, uPairs, uPairRanges, uWorld;
uniform sampler2D uGroups, uGroupRanges, uGroupMembers;
uniform vec4 uIntegration;
uniform float uDampingRatio;
uniform int uCount, uGroupCount, uDepth;
vec4 rawFrameAt(int row, int slot) {
  if (slot == 0) return texelFetch(uFrame0, ivec2(row, 0), 0);
  if (slot == 1) return texelFetch(uFrame1, ivec2(row, 0), 0);
  if (slot == 2) return texelFetch(uFrame2, ivec2(row, 0), 0);
  return texelFetch(uFrame3, ivec2(row, 0), 0);
}
mat3 basisAt(int row) {
  mat3 basis = mat3(rawFrameAt(row, 1).xyz, rawFrameAt(row, 2).xyz, rawFrameAt(row, 3).xyz);
#ifdef LAYOUT_HALF_FRAME
  if (dot(basis[2], basis[2]) > 0.0) {
    basis[1] = normalize(cross(basis[2], basis[0]));
  }
#endif
  return basis;
}
vec4 frameAt(int row, int slot) {
  if (slot == 0) return rawFrameAt(row, 0);
  return vec4(basisAt(row)[slot - 1], 0.0);
}
vec4 stateAt(int row, int slot) {
  if (slot == 0) return texelFetch(uQ, ivec2(row, 0), 0);
  if (slot == 1) return texelFetch(uVelocity, ivec2(row, 0), 0);
#ifdef LAYOUT_CACHED_WORLD
  return texelFetch(uWorld, ivec2(row, 0), 0);
#else
  return vec4(frameAt(row, 0).xyz + basisAt(row) * texelFetch(uQ, ivec2(row, 0), 0).xyz, 0.0);
#endif
}
vec4 infoAt(int row, int slot) {
  if (slot == 0) return texelFetch(uInfo0, ivec2(row, 0), 0);
  if (slot == 1) return texelFetch(uInfo1, ivec2(row, 0), 0);
  return texelFetch(uInfo2, ivec2(row, 0), 0);
}
vec4 indexed(sampler2D image, int index) {
  int width = textureSize(image, 0).x;
  return texelFetch(image, ivec2(index % width, index / width), 0);
}
int indexAt(int index) { return int(indexed(uIndices, index).x); }
vec4 pairAt(int index) { return indexed(uPairs, index); }
vec4 pairRangeAt(int row) { return texelFetch(uPairRanges, ivec2(row, 0), 0); }
`;

const frameShader = `
layout(location=0) out vec4 outOrigin;
layout(location=1) out vec4 outU;
layout(location=2) out vec4 outV;
layout(location=3) out vec4 outNormal;
void main() {
  int row = int(gl_FragCoord.x);
  vec3 origin; mat3 basis;
  int group = int(infoAt(row, 0).w);
  if (int(infoAt(row, 2).w) == uDepth && texelFetch(uGroups, ivec2(group, 0), 0).x > 0.5) schemaFrame(row, origin, basis);
  else { origin = rawFrameAt(row, 0).xyz;
    basis = mat3(rawFrameAt(row, 1).xyz, rawFrameAt(row, 2).xyz, rawFrameAt(row, 3).xyz); }
  outOrigin = vec4(origin, 0.0);
  outU = vec4(basis[0], 0.0);
  outV = vec4(basis[1], 0.0);
  outNormal = vec4(basis[2], 0.0);
}
`;

const forceShader = `
layout(location=0) out vec4 outQ;
layout(location=1) out vec4 outVelocity;
layout(location=2) out vec4 outActivity;
void main() {
  int row = int(gl_FragCoord.x);
  vec4 q = stateAt(row, 0), velocity = stateAt(row, 1);
  int group = int(infoAt(row, 0).w);
  bool awake = texelFetch(uGroups, ivec2(group, 0), 0).x > 0.5;
  vec3 force = vec3(0.0), deltaQ = vec3(0.0); float stiffness = 0.0;
  vec3 residue = texelFetch(uActivity, ivec2(row, 0), 0).xyz;
  if (awake && q.w > 0.0 && velocity.w < 0.5) {
    force = schemaForce(row, stiffness);
    vec4 target = texelFetch(uTargets, ivec2(row, 0), 0);
    // A negative target weight encodes a world-space target without another sampler.
    if (target.w < 0.0)
      target.xyz = transpose(basisAt(row)) * (target.xyz - frameAt(row, 0).xyz);
    target.w = abs(target.w);
    force += target.w * (target.xyz - q.xyz);
    stiffness += target.w;
    for (int axis = 0; axis < 3; axis++) if (float(axis) >= q.w) force[axis] = 0.0;
    float frequency = sqrt(max(stiffness, 0.0));
    float dt = min(uIntegration.x, 0.5 / max(frequency, 1e-4));
    vec3 appliedForce = dot(force, force) <= uIntegration.y*uIntegration.y ? vec3(0.0) : force;
    if (abs(uDampingRatio - 1.0) < 1e-6) {
      if (stiffness < 1e-8) {
        deltaQ = velocity.xyz * dt + 0.5 * appliedForce * dt * dt;
        velocity.xyz += dt * appliedForce;
      } else {
        float x = frequency * dt, decay = exp(-x);
        float response = x < 0.01 ? x*x*(0.5-x/3.0+x*x/8.0-x*x*x/30.0)
          : 1.0-(1.0+x)*decay;
        deltaQ = velocity.xyz * dt * decay + appliedForce * response / stiffness;
        velocity.xyz = (velocity.xyz * (1.0-x) + appliedForce * dt) * decay;
      }
    } else {
      velocity.xyz = (velocity.xyz + dt * appliedForce) / (1.0 + dt * 2.0 * uDampingRatio * frequency);
      deltaQ = dt * velocity.xyz;
    }
    // Retain sub-ULP motion; explicit rounding survives shader reassociation.
    vec3 increment = deltaQ + residue;
    uvec3 exponent = (floatBitsToUint(max(abs(q.xyz), abs(increment))) >> 23u) & uvec3(255u);
    vec3 quantum = uintBitsToFloat((max(exponent, uvec3(24u)) - 23u) << 23u);
    vec3 rounded = roundEven(increment / quantum) * quantum;
    residue = increment - rounded;
    q.xyz += rounded;
  } else { velocity.xyz = vec3(0.0); residue = vec3(0.0); }
  bool resting = dot(force, force) <= uIntegration.y*uIntegration.y && dot(velocity.xyz, velocity.xyz) <= uIntegration.z*uIntegration.z;
  outQ = q;
  outVelocity = velocity;
  outActivity = vec4(residue, resting ? 0.0 : 1.0);
}
`;

const groupShader = `
out vec4 outGroup;
void main() {
  int group = int(gl_FragCoord.x);
  vec4 previous = texelFetch(uGroups, ivec2(group, 0), 0);
  if (previous.x < 0.5) { outGroup = previous; return; }
  vec2 range = texelFetch(uGroupRanges, ivec2(group, 0), 0).xy;
  float activity = 0.0;
  for (int i = 0; i < int(range.y); i++) {
    int row = int(texelFetch(uGroupMembers, ivec2(int(range.x) + i, 0), 0).x);
    activity = max(activity, texelFetch(uActivity, ivec2(row, 0), 0).w);
    if (activity > 0.5) break;
  }
  float quiet = activity > 0.5 ? 0.0 : previous.y + 1.0;
  outGroup = vec4(quiet >= uIntegration.w ? 0.0 : 1.0, quiet, 0.0, 0.0);
}
`;

const worldShader = `
out vec4 outWorld;
void main() { outWorld = stateAt(int(gl_FragCoord.x), 2); }
`;

const boundsShader = `
out vec4 outBounds;
void main() {
  bool lower = gl_FragCoord.x < 1.0;
  vec3 bound = uCount > 0 ? stateAt(0, 2).xyz : vec3(0.0);
  for (int row = 1; row < uCount; row++) {
    vec3 point = stateAt(row, 2).xyz;
    bound = lower ? min(bound, point) : max(bound, point);
  }
  outBounds = vec4(bound, 0.0);
}
`;

const summaryShader = `
out vec4 outSummary;
void main() {
  float activeCount = 0.0;
  for (int group = 0; group < uGroupCount; group++) {
    activeCount += texelFetch(uGroups, ivec2(group, 0), 0).x;
  }
  outSummary = vec4(activeCount, 0.0, 0.0, 0.0);
}
`;

const inputShader = `
uniform sampler2D uInputQ, uInputVelocity, uInputMask;
layout(location=0) out vec4 outQ;
layout(location=1) out vec4 outVelocity;
layout(location=2) out vec4 outActivity;
void main() {
  int row = int(gl_FragCoord.x);
  vec4 mask = texelFetch(uInputMask, ivec2(row, 0), 0);
  outQ = mask.x > 0.5 ? texelFetch(uInputQ, ivec2(row, 0), 0) : stateAt(row, 0);
  outVelocity = stateAt(row, 1);
  if (mask.y > 0.5) outVelocity.w = texelFetch(uInputVelocity, ivec2(row, 0), 0).w;
  bool reset = mask.x > 0.5 || outVelocity.w > 0.5;
  if (reset) outVelocity.xyz = vec3(0.0);
  outActivity = reset ? vec4(0.0) : texelFetch(uActivity, ivec2(row, 0), 0);
}
`;

const dragShader = `
uniform vec4 uDrag;
layout(location=0) out vec4 outQ;
layout(location=1) out vec4 outVelocity;
layout(location=2) out vec4 outActivity;
void main() {
  int row = int(gl_FragCoord.x);
  outQ = stateAt(row, 0); outVelocity = stateAt(row, 1);
  outActivity = texelFetch(uActivity, ivec2(row, 0), 0);
  if (row == int(uDrag.w) && outQ.w > 0.0) {
    vec3 coordinate = transpose(basisAt(row)) * (uDrag.xyz - frameAt(row, 0).xyz);
    for (int axis = 0; axis < 3; axis++) if (float(axis) >= outQ.w) coordinate[axis] = 0.0;
    outQ.xyz = coordinate; outVelocity = vec4(0.0, 0.0, 0.0, 1.0); outActivity = vec4(0.0);
  }
}
`;

const settleShader = `
layout(location=0) out vec4 outQ;
layout(location=1) out vec4 outVelocity;
layout(location=2) out vec4 outActivity;
void main() {
  int row = int(gl_FragCoord.x), group = int(infoAt(row, 0).w);
  outQ = stateAt(row, 0); outVelocity = stateAt(row, 1);
  if (texelFetch(uGroups, ivec2(group, 0), 0).x < 0.5) outVelocity.xyz = vec3(0.0);
  outActivity = texelFetch(uGroups, ivec2(group, 0), 0).x < 0.5 ? vec4(0.0) : texelFetch(uActivity, ivec2(row, 0), 0);
}
`;

const frameInputShader = `
uniform sampler2D uInputMask, uInputFrame0, uInputFrame1, uInputFrame2, uInputFrame3;
layout(location=0) out vec4 outOrigin;
layout(location=1) out vec4 outU;
layout(location=2) out vec4 outV;
layout(location=3) out vec4 outNormal;
void main() {
  int row = int(gl_FragCoord.x);
  bool selected = texelFetch(uInputMask, ivec2(row, 0), 0).x > 0.5;
  outOrigin = selected ? texelFetch(uInputFrame0, ivec2(row, 0), 0) : rawFrameAt(row, 0);
  outU = selected ? texelFetch(uInputFrame1, ivec2(row, 0), 0) : rawFrameAt(row, 1);
  outV = selected ? texelFetch(uInputFrame2, ivec2(row, 0), 0) : rawFrameAt(row, 2);
  outNormal = selected ? texelFetch(uInputFrame3, ivec2(row, 0), 0) : rawFrameAt(row, 3);
}
`;

const wakeShader = `
uniform sampler2D uWake;
out vec4 outGroup;
void main() {
  int group = int(gl_FragCoord.x);
  outGroup = texelFetch(uWake, ivec2(group, 0), 0).x > 0.5
    ? vec4(1.0, 0.0, 0.0, 0.0) : texelFetch(uGroups, ivec2(group, 0), 0);
}
`;

/** GPU execution of the schema's coordinate ledger; no shape cases live here. */
export class GPUForceLayout {
  static supported(renderer) {
    return Boolean(renderer?.capabilities?.isWebGL2 && renderer.extensions.has("EXT_color_buffer_float"));
  }

  constructor(renderer, ledger, options = {}) {
    if (!GPUForceLayout.supported(renderer)) throw new Error("Floating-point WebGL2 layout is unavailable");
    this.mixedFrames = options.precision !== "float32" && supportsMixedFrames(renderer);
    options = normalizeLayoutSettings({ ...ledger.settings, ...options });
    this.renderer = renderer;
    this.ledger = ledger;
    this.count = ledger.rows.length;
    if (this.count > renderer.capabilities.maxTextureSize) throw new Error("Layout exceeds GPU row capacity");
    this.rowIndices = new Map(ledger.rows.map((row, index) => [row.id, index]));
    this.gpu = packLayoutLedger(ledger);
    this.frameDepths = [...new Set(ledger.rows.filter((row) => row.depth > 0).map((row) => row.depth))].sort();
    this.ownedTextures = [];
    const upload = (data, width, type = THREE.FloatType) => {
      const w = Math.min(Math.max(1, width), renderer.capabilities.maxTextureSize);
      const h = Math.ceil(Math.max(1, width) / w);
      const padded = new Float32Array(w * h * 4); padded.set(data);
      const result = texture(padded, w, h, type); this.ownedTextures.push(result); return result;
    };
    const frameType = (slot) => this.mixedFrames && slot === 2 ? THREE.HalfFloatType : THREE.FloatType;
    const packed = (data, count, stride, slot, type) => upload(channel(data, count, stride, slot), count, type);
    this.uniforms = Object.fromEntries([
      ["uQ", packed(this.gpu.state, this.count, 12, 0)],
      ["uVelocity", packed(this.gpu.state, this.count, 12, 1)],
      ["uActivity", upload(new Float32Array(Math.max(1, this.count) * 4), this.count)],
      ...Array.from({ length: 4 }, (_, i) => [`uFrame${i}`, packed(this.gpu.frames, this.count, 16, i, frameType(i))]),
      ...Array.from({ length: 3 }, (_, i) => [`uInfo${i}`, packed(this.gpu.info, this.count, 12, i)]),
    ].map(([key, value]) => [key, { value }]));
    const indices = new Float32Array(Math.max(1, this.gpu.indices.length) * 4);
    this.gpu.indices.forEach((value, i) => { indices[i * 4] = value; });
    this.uniforms.uIndices = { value: upload(indices, this.gpu.indices.length) };
    this.uniforms.uPairs = { value: upload(ledger.interactions ?? new Float32Array(0), (ledger.interactions?.length ?? 0) / 4) };
    this.uniforms.uPairRanges = { value: upload(ledger.interactionRanges ?? new Float32Array(this.count * 4), this.count) };
    this.groups = ledger.groups ?? [];
    const groupRanges = new Float32Array(Math.max(1, this.groups.length) * 4);
    const groupMembers = new Float32Array(Math.max(1, this.count) * 4);
    const groupState = new Float32Array(Math.max(1, this.groups.length) * 4);
    let memberOffset = 0;
    this.groups.forEach((members, group) => {
      groupRanges.set([memberOffset, members.length, 0, 0], group * 4);
      groupState[group * 4] = 1;
      members.forEach((row) => { groupMembers[memberOffset++ * 4] = row; });
    });
    Object.assign(this.uniforms, {
      uGroups: { value: upload(groupState, this.groups.length) },
      uGroupRanges: { value: upload(groupRanges, this.groups.length) },
      uGroupMembers: { value: upload(groupMembers, this.count) },
      uCount: { value: this.count }, uGroupCount: { value: this.groups.length },
      uDepth: { value: 0 }, uLayoutStrengths: { value: new THREE.Vector4() },
      uLayoutGeometry: { value: new THREE.Vector4() }, uIntegration: { value: new THREE.Vector4() },
      uDampingRatio: { value: 1 },
      uTargets: { value: upload(new Float32Array(Math.max(1, this.count) * 4), this.count) },
      uDrag: { value: new THREE.Vector4() },
    });
    this.inputData = Object.fromEntries(["Q", "Velocity", "Mask"].map((name) => {
      const data = new Float32Array(Math.max(1, this.count) * 4);
      this.uniforms[`uInput${name}`] = { value: upload(data, this.count) };
      return [name, this.uniforms[`uInput${name}`].value.image.data];
    }));
    this.inputFrames = Array.from({ length: 4 }, (_, slot) => {
      const image = upload(channel(ledger.frames, this.count, 16, slot), this.count);
      this.uniforms[`uInputFrame${slot}`] = { value: image };
      return image.image.data;
    });
    this.uniforms.uWake = { value: upload(new Float32Array(Math.max(1, this.groups.length) * 4), this.groups.length) };
    this.inputRows = new Set();
    this.pinIds = new Set();
    this.dragIds = new Set();
    this.stateTargets = [target(this.count, 3), target(this.count, 3)];
    const frameTypes = Array.from({ length: 4 }, (_, slot) => frameType(slot));
    this.frameTargets = [target(this.count, 4, frameTypes), target(this.count, 4, frameTypes)];
    this.groupTargets = [target(this.groups.length), target(this.groups.length)];
    this.worldTarget = target(this.count);
    this.uniforms.uWorld = { value: this.worldTarget.texture };
    this.boundsTarget = target(2);
    this.summaryTarget = target(1);
    this.scene = new THREE.Scene();
    this.camera = new THREE.Camera();
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
    const shader = (body, schema = false, cachedWorld = false) => new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader,
      fragmentShader: `${this.mixedFrames ? "#define LAYOUT_HALF_FRAME\n" : ""}${cachedWorld ? "#define LAYOUT_CACHED_WORLD\n" : ""}${accessors}\n${schema ? LAYOUT_SCHEMA_GLSL : ""}\n${body}`,
      uniforms: this.uniforms, depthTest: false, depthWrite: false, blending: THREE.NoBlending,
    });
    this.materials = { frame: shader(frameShader, true), force: shader(forceShader, true, true),
      group: shader(groupShader), world: shader(worldShader), summary: shader(summaryShader),
      input: shader(inputShader), frameInput: shader(frameInputShader), drag: shader(dragShader),
      wake: shader(wakeShader), settle: shader(settleShader) };
    this.materials.bounds = shader(boundsShader, false, true);
    for (const [name, material] of Object.entries(this.materials)) material.name = name;
    const images = [...this.ownedTextures, ...[...this.stateTargets, ...this.frameTargets, ...this.groupTargets,
      this.worldTarget, this.boundsTarget, this.summaryTarget].flatMap((value) => value.textures)];
    this.textureBytes = images.reduce((sum, image) => sum + image.image.width * image.image.height *
      (image.type === THREE.HalfFloatType ? 8 : 16), 0);
    this.fullPrecisionBytes = images.reduce((sum, image) => sum + image.image.width * image.image.height * 16, 0);
    this.subscriptionCount = ledger.rows.reduce((count, row) => count + row.cofaceSources.length, 0);
    this.stateIndex = this.frameIndex = this.groupIndex = -1;
    this.dispatchCount = this.stepCount = this.readbackCount = 0;
    this.coordinateReadbackCount = this.summaryReadbackCount = this.readbackBytes = 0;
    this.synchronousReadbackCount = 0;
    this.batchCount = 0;
    this.dispatches = {}; this.fragmentCount = this.outputBytes = 0;
    this.activeGroupCount = this.groups.length;
    this.generation = 0;
    this.geometryVersion = 0;
    this.disposed = false;
    try { this.setOptions(options); this.uploadInputs(); }
    catch (error) { this.dispose(); throw error; }
  }

  setOptions(options = {}) {
    const previous = this.options;
    this.options = normalizeLayoutSettings({ ...this.options, ...options });
    const o = this.options;
    this.uniforms.uLayoutStrengths.value.set(o.restoringStrength ?? 0.035,
      o.peerRepulsionStrength, o.boundaryRepulsionStrength, o.edgeSpringStrength);
    this.uniforms.uLayoutGeometry.value.set(o.restLength ?? 2.4,
      o.minDistance ?? 0.12, o.minAltitude ?? 0.4, 0);
    this.uniforms.uIntegration.value.set(o.dt ?? 1 / 60,
      o.forceThreshold ?? 1e-4, o.velocityThreshold ?? 1e-4, o.sleepSteps ?? 3);
    this.uniforms.uDampingRatio.value = o.dampingRatio ?? 1;
    if (previous && Object.keys(o).some((key) => o[key] !== previous[key])) this.wake();
  }

  uploadInputs({ ids = [], pinIds = null } = {}) {
    return this.batch(() => this.applyInputs(ids, pinIds));
  }

  applyInputs(ids, pinIds) {
    const selected = new Set(ids);
    if (pinIds != null) this.pinIds = new Set(pinIds);
    const pins = pinIds == null ? null : new Set([...this.pinIds, ...this.dragIds]);
    const { Q: q, Velocity: velocity, Mask: mask } = this.inputData;
    for (const index of this.inputRows) mask[index * 4] = 0;
    this.inputRows.clear();
    for (const id of selected) {
      const row = this.ledger.rows[this.rowForId(id)];
      if (!row) continue;
      const offset = row.index * 4;
      q.set(this.ledger.coordinates.subarray(offset, offset + 4), offset);
      mask[offset] = 1; this.inputRows.add(row.index);
      for (let slot = 0; slot < 4; slot++) this.inputFrames[slot].set(
        this.ledger.frames.subarray(row.index * 16 + slot * 4, row.index * 16 + slot * 4 + 4), offset);
    }
    // Pin changes are infrequent; ordinary coordinate edits touch only their rows.
    if (pins || this.inputPinsChanged) for (const row of this.ledger.rows) {
      mask[row.index * 4 + 1] = pins ? 1 : 0;
      if (pins) velocity[row.index * 4 + 3] = pins.has(row.id) ? 1 : 0;
    }
    this.inputPinsChanged = Boolean(pins);
    for (const key of ["uInputQ", "uInputVelocity", "uInputMask"]) this.uniforms[key].value.needsUpdate = true;
    this.stateIndex = (this.stateIndex + 1) % 2;
    const next = this.stateTargets[this.stateIndex];
    this.dispatch(this.materials.input, next);
    ["uQ", "uVelocity", "uActivity"].forEach((key, i) => { this.uniforms[key].value = next.textures[i]; });
    if (selected.size) {
      for (let slot = 0; slot < 4; slot++) this.uniforms[`uInputFrame${slot}`].value.needsUpdate = true;
      this.frameIndex = (this.frameIndex + 1) % 2;
      const frames = this.frameTargets[this.frameIndex];
      this.dispatch(this.materials.frameInput, frames);
      for (let slot = 0; slot < 4; slot++) this.uniforms[`uFrame${slot}`].value = frames.textures[slot];
    }
    this.wake(pins ? null : ids);
    if (selected.size || this.frameIndex < 0) {
      this.refreshFrames();
      this.dispatch(this.materials.world, this.worldTarget);
      this.geometryVersion++;
      this.dispatch(this.materials.bounds, this.boundsTarget);
    }
  }

  moveHandle(id, target) {
    const row = this.rowForId(id), point = target?.toArray?.() ?? target;
    if (row < 0 || !this.ledger.rows[row].dof || !Array.isArray(point)
      || point.length < 3 || !point.slice(0, 3).every(Number.isFinite)) return false;
    this.dragIds.add(id);
    return this.batch(() => {
      this.uniforms.uDrag.value.set(point[0], point[1], point[2], row);
      this.stateIndex = (this.stateIndex + 1) % 2;
      const next = this.stateTargets[this.stateIndex];
      this.dispatch(this.materials.drag, next);
      ["uQ", "uVelocity", "uActivity"].forEach((key, slot) => { this.uniforms[key].value = next.textures[slot]; });
      this.wake([id]); this.refreshFrames();
      this.dispatch(this.materials.world, this.worldTarget); this.geometryVersion++;
      this.dispatch(this.materials.bounds, this.boundsTarget);
      return true;
    });
  }

  releaseHandle(id) {
    if (!this.dragIds.delete(id)) return false;
    this.uploadInputs({ pinIds: [...this.pinIds] });
    return true;
  }

  readPosition(id) {
    const row = this.rowForId(id);
    return row < 0 ? null : Array.from(this.read(this.worldTarget, 0, true, { row, count: 1 }).slice(0, 3));
  }

  readHandle(id) {
    const row = this.rowForId(id);
    if (row < 0) return null;
    const sample = (target, attachment = 0) => this.read(target, attachment, true, { row, count: 1 });
    const q = sample(this.stateTargets[this.stateIndex]);
    const position = sample(this.worldTarget);
    const columns = Array.from({ length: 4 }, (_, slot) => Array.from(sample(this.frameTargets[this.frameIndex], slot).slice(0, 3)));
    if (this.mixedFrames && columns[3].some((value) => value !== 0)) {
      columns[2] = new THREE.Vector3().fromArray(columns[3]).cross(new THREE.Vector3().fromArray(columns[1])).normalize().toArray();
    }
    return { id, dof: q[3], coordinates: Array.from(q.slice(0, 3)), position: Array.from(position.slice(0, 3)),
      frame: { origin: columns[0], basis: columns.slice(1) } };
  }

  wake(ids = null) {
    const data = this.uniforms.uWake.value.image.data;
    data.fill(0);
    if (ids == null) for (let group = 0; group < this.groups.length; group++) data[group * 4] = 1;
    else for (const id of ids) {
      const row = this.ledger.rows[this.rowForId(id)];
      if (row) data[row.group * 4] = 1;
    }
    this.uniforms.uWake.value.needsUpdate = true;
    this.groupIndex = (this.groupIndex + 1) % 2;
    const next = this.groupTargets[this.groupIndex];
    this.dispatch(this.materials.wake, next);
    this.uniforms.uGroups.value = next.texture;
    this.generation++;
    this.activeGroupCount = this.groups.length;
  }

  setTargets(values, worldIds = []) {
    const previous = this.uniforms.uTargets.value.image.data;
    const worldRows = new Set(worldIds.map((id) => this.rowForId(id)));
    const ids = [];
    for (const row of this.ledger.rows) {
      const offset = row.index * 4;
      let changed = false;
      for (let axis = 0; axis < 4; axis++) {
        const value = (values[offset + axis] ?? 0) * (axis === 3 && worldRows.has(row.index) ? -1 : 1);
        if (Math.abs(previous[offset + axis] - value) > (this.options.wakeThreshold ?? 0)) changed = true;
        previous[offset + axis] = value;
      }
      if (changed) ids.push(row.id);
    }
    this.uniforms.uTargets.value.needsUpdate = true;
    if (ids.length) this.wake(ids);
  }

  batch(run) {
    if (this.batching) return run();
    const renderer = this.renderer;
    const oldTarget = renderer.getRenderTarget();
    const viewport = renderer.getViewport(new THREE.Vector4());
    const scissor = renderer.getScissor(new THREE.Vector4());
    const scissorTest = renderer.getScissorTest();
    const autoClear = renderer.autoClear;
    const shaderError = renderer.debug.onShaderError;
    try {
      this.batching = true;
      this.batchCount++;
      renderer.debug.onShaderError = (gl, program, vertex, fragment) => {
        throw new Error(`GPU layout shader failed: ${gl.getProgramInfoLog(program)} ${gl.getShaderInfoLog(vertex)} ${gl.getShaderInfoLog(fragment)}`);
      };
      renderer.autoClear = false;
      renderer.setScissorTest(false);
      return run();
    } finally {
      this.batching = false;
      renderer.setViewport(viewport);
      renderer.setScissor(scissor);
      renderer.setScissorTest(scissorTest);
      renderer.setRenderTarget(oldTarget);
      renderer.autoClear = autoClear;
      renderer.debug.onShaderError = shaderError;
    }
  }

  dispatch(material, destination) {
    if (!this.batching) return this.batch(() => this.dispatch(material, destination));
    const renderer = this.renderer;
    renderer.setRenderTarget(destination);
    // Render-target viewports are physical pixels; setViewport would apply DPR.
    this.quad.material = material;
    renderer.render(this.scene, this.camera);
    this.dispatchCount++;
    this.dispatches[material.name] = (this.dispatches[material.name] ?? 0) + 1;
    this.fragmentCount += destination.width * destination.height;
    this.outputBytes += destination.width * destination.height * destination.textures.reduce((sum, image) =>
      sum + (image.type === THREE.HalfFloatType ? 8 : 16), 0);
  }

  refreshFrames() {
    for (const depth of this.frameIndex < 0 ? [0, ...this.frameDepths] : this.frameDepths) {
      this.uniforms.uDepth.value = depth;
      this.frameIndex = (this.frameIndex + 1) % 2;
      const next = this.frameTargets[this.frameIndex];
      this.dispatch(this.materials.frame, next);
      for (let slot = 0; slot < 4; slot++) this.uniforms[`uFrame${slot}`].value = next.textures[slot];
    }
  }

  step(steps = 1) {
    if (this.error) throw this.error;
    if (this.disposed || !this.count || !this.activeGroupCount) return this.diagnostics();
    return this.batch(() => this.integrate(steps));
  }

  integrate(steps) {
    for (let i = 0; i < steps; i++) {
      if (i > 0) { this.refreshFrames(); this.dispatch(this.materials.world, this.worldTarget); }
      this.stateIndex = (this.stateIndex + 1) % 2;
      const state = this.stateTargets[this.stateIndex];
      this.dispatch(this.materials.force, state);
      ["uQ", "uVelocity", "uActivity"].forEach((key, slot) => { this.uniforms[key].value = state.textures[slot]; });
      this.groupIndex = (this.groupIndex + 1) % 2;
      const groups = this.groupTargets[this.groupIndex];
      this.dispatch(this.materials.group, groups);
      this.uniforms.uGroups.value = groups.texture;
      this.stepCount++;
    }
    // Sleeping rows are cleared by the next force pass, or once at this barrier.
    this.stateIndex = (this.stateIndex + 1) % 2;
    const settled = this.stateTargets[this.stateIndex];
    this.dispatch(this.materials.settle, settled);
    ["uQ", "uVelocity", "uActivity"].forEach((key, slot) => { this.uniforms[key].value = settled.textures[slot]; });
    this.refreshFrames();
    this.dispatch(this.materials.world, this.worldTarget);
    this.geometryVersion++;
    this.dispatch(this.materials.bounds, this.boundsTarget);
    this.pollActivity();
    return this.diagnostics();
  }

  pollActivity() {
    if (this.activityPending || this.disposed) return;
    this.dispatch(this.materials.summary, this.summaryTarget);
    const generation = this.generation;
    this.activityPending = this.read(this.summaryTarget).then((data) => {
      if (generation === this.generation) this.activeGroupCount = Math.round(data[0]);
    }).catch((error) => { if (!this.disposed) { this.error = error; this.activeGroupCount = 0; } })
      .finally(() => { this.activityPending = null; });
  }

  /** A barrier copies completed output; routine integration and rendering do not. */
  read(renderTarget, attachment = 0, synchronous = false, { row = 0, count = renderTarget.width } = {}) {
    const renderer = this.renderer, gl = renderer.getContext();
    const oldTarget = renderer.getRenderTarget();
    const oldReadBuffer = gl.getParameter(gl.READ_BUFFER), oldPackBuffer = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING);
    const data = new Float32Array(count * 4);
    this.readbackCount++;
    if (synchronous) this.synchronousReadbackCount++;
    this.readbackBytes += data.byteLength;
    if (renderTarget === this.summaryTarget) this.summaryReadbackCount++;
    else this.coordinateReadbackCount++;
    const buffer = synchronous ? null : gl.createBuffer();
    let fence;
    try {
      renderer.setRenderTarget(renderTarget);
      gl.readBuffer(gl.COLOR_ATTACHMENT0 + attachment);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
      if (buffer) gl.bufferData(gl.PIXEL_PACK_BUFFER, data.byteLength, gl.STREAM_READ);
      gl.readPixels(row, 0, count, 1, gl.RGBA, gl.FLOAT, synchronous ? data : 0);
      if (!synchronous) { fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0); gl.flush(); }
    } catch (error) { if (buffer) gl.deleteBuffer(buffer); throw error; }
    finally {
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, oldPackBuffer);
      renderer.setRenderTarget(oldTarget);
      gl.readBuffer(oldReadBuffer);
    }
    if (synchronous) return data;
    return new Promise((resolve, reject) => {
        const poll = () => {
          if (this.disposed) { reject(new Error("GPU layout has been disposed")); return; }
          const status = gl.clientWaitSync(fence, 0, 0);
          if (status === gl.WAIT_FAILED) reject(new Error("GPU layout synchronization failed"));
          else if (status === gl.TIMEOUT_EXPIRED) setTimeout(poll, 4);
          else resolve();
        };
        poll();
      }).then(() => {
      const previous = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING);
      try { gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer); gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, data); }
      finally { gl.bindBuffer(gl.PIXEL_PACK_BUFFER, previous); }
      return data;
    }).finally(() => { gl.deleteBuffer(buffer); gl.deleteSync(fence); });
  }

  async snapshot() {
    if (this.disposed) throw new Error("GPU layout has been disposed");
    if (this.stateIndex < 0) this.step(1);
    const state = this.stateTargets[this.stateIndex];
    const frames = this.frameTargets[this.frameIndex];
    const [q, velocity, world, ...basis] = await Promise.all([
      this.read(state, 0), this.read(state, 1), this.read(this.worldTarget),
      ...Array.from({ length: 4 }, (_, slot) => this.read(frames, slot)),
    ]);
    return this.unpackSnapshot(q, velocity, world, basis);
  }

  flush() {
    if (this.disposed) throw new Error("GPU layout has been disposed");
    if (this.stateIndex < 0) this.uploadInputs();
    const state = this.stateTargets[this.stateIndex], frames = this.frameTargets[this.frameIndex];
    return this.unpackSnapshot(this.read(state, 0, true), this.read(state, 1, true),
      this.read(this.worldTarget, 0, true), Array.from({ length: 4 }, (_, slot) => this.read(frames, slot, true)));
  }

  unpackSnapshot(q, velocity, world, basis) {
    const coordinates = q.slice(0, this.count * 4);
    const velocities = velocity.slice(0, this.count * 4);
    const worlds = world.slice(0, this.count * 4);
    const frameValues = new Float32Array(this.count * 16);
    for (let row = 0; row < this.count; row++) {
      basis.forEach((values, slot) => frameValues.set(values.subarray(row * 4, row * 4 + 4), row * 16 + slot * 4));
      if (this.mixedFrames) {
        const at = row * 16;
        const u = new THREE.Vector3().fromArray(frameValues, at + 4);
        const n = new THREE.Vector3().fromArray(frameValues, at + 12);
        if (n.lengthSq()) {
          new THREE.Vector3().crossVectors(n, u).normalize().toArray(frameValues, at + 8);
        }
      }
    }
    return { coordinates, velocities, worlds, frames: frameValues, diagnostics: this.diagnostics() };
  }

  get worldTexture() { return this.worldTarget.texture; }
  get boundsTexture() { return this.boundsTarget.texture; }
  rowForId(id) { return this.rowIndices.get(id) ?? -1; }

  diagnostics() {
    return { backend: "webgl2-compute", dispatchCount: this.dispatchCount,
      stepCount: this.stepCount, readbackCount: this.readbackCount,
      coordinateReadbackCount: this.coordinateReadbackCount, summaryReadbackCount: this.summaryReadbackCount,
      synchronousReadbackCount: this.synchronousReadbackCount,
      rendererStateBatches: this.batchCount,
      readbackBytes: this.readbackBytes, error: this.error?.message ?? null,
      dispatches: { ...this.dispatches }, fragmentInvocations: this.fragmentCount,
      renderTargetWriteBytes: this.outputBytes,
      residentTextureBytes: this.textureBytes,
      fullPrecisionTextureBytes: this.fullPrecisionBytes,
      precision: { frameBasis: this.mixedFrames ? "mixed" : "float32", independentFrameDirections: "float32",
        derivedFrameDirection: this.mixedFrames ? "float16" : "float32", coordinates: "float32",
        velocity: "float32", remainder: "float32", accumulation: "float32" },
      work: this.ledger.work ?? null,
      activeGroupCount: this.activeGroupCount, sleepingGroupCount: this.groups.length - this.activeGroupCount,
      bodyCount: this.count, groupCount: this.groups.length,
      subscriptionCount: this.subscriptionCount,
      topologyVersion: this.ledger.topologyVersion ?? 0, geometryVersion: this.geometryVersion };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    for (const value of [...this.ownedTextures, ...this.stateTargets, ...this.frameTargets,
      ...this.groupTargets, this.worldTarget, this.boundsTarget, this.summaryTarget, ...Object.values(this.materials), this.quad.geometry]) value.dispose();
  }
}
