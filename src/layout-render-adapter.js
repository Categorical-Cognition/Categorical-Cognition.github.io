import * as THREE from "three";
import { layoutOrientationWeights, layoutRenderWeights } from "./layout-schema.js";
import { acquireShellValidator } from "./gpu-shell-validator.js";

const declarations = `
uniform sampler2D layoutWorld;
uniform float layoutWidth, layoutEnabled;
uniform vec3 layoutOrigin;
uniform float layoutScale;
uniform sampler2D layoutBounds;
uniform float layoutFitDiameter;
uniform vec4 layoutInverseMap;
uniform sampler2D layoutParentWorld;
uniform vec3 layoutParentBase;
uniform vec3 layoutParentReference;
vec3 layoutMapPoint(vec3 point) {
  vec3 origin=layoutOrigin; float scale=layoutScale;
  if (layoutFitDiameter > 0.0) {
    vec3 lower=texture2D(layoutBounds,vec2(0.25,0.5)).xyz;
    vec3 upper=texture2D(layoutBounds,vec2(0.75,0.5)).xyz;
    vec3 size=upper-lower;
    origin=(lower+upper)*0.5;
    scale=layoutFitDiameter/max(max(max(size.x,size.y),size.z),1.0);
  }
  return (point-origin)*scale*layoutInverseMap.w+layoutInverseMap.xyz;
}
vec3 layoutMapVector(vec3 offset) {
  float scale=layoutScale;
  if (layoutFitDiameter > 0.0) {
    vec3 size=texture2D(layoutBounds,vec2(0.75,0.5)).xyz-texture2D(layoutBounds,vec2(0.25,0.5)).xyz;
    scale=layoutFitDiameter/max(max(max(size.x,size.y),size.z),1.0);
  }
  return offset*scale*layoutInverseMap.w;
}
vec3 layoutMapPoint(vec3 point, vec3 offset) {
  // Map the anchor and direction separately so preview recentering retains
  // offsets smaller than one world-coordinate ULP across the fit branch.
  return layoutMapPoint(point)+layoutMapVector(offset);
}
vec3 layoutAnchor(float row) { return layoutMapPoint(texture2D(layoutWorld,vec2((row+0.5)/layoutWidth,0.5)).xyz); }
vec3 layoutParentOffset() {
  if (layoutParentReference.z < 0.5) return vec3(0.0);
  return texture2D(layoutParentWorld, vec2((layoutParentReference.x + 0.5) / layoutParentReference.y, 0.5)).xyz - layoutParentBase;
}
`;

const stencilShader = `
uniform sampler2D layoutWeights;
uniform vec2 layoutWeightsSize;
attribute vec2 layoutSpan;
vec3 layoutPoint(vec3 fallback, vec2 span) {
  if (layoutEnabled < 0.5 || span.y < 0.5) return fallback;
  vec3 point = vec3(0.0);
  for (int i = 0; i < int(span.y); i++) {
    float index = span.x + float(i);
    vec2 uv = (vec2(mod(index, layoutWeightsSize.x), floor(index / layoutWeightsSize.x)) + 0.5) / layoutWeightsSize;
    vec2 term = texture2D(layoutWeights, uv).xy;
    point += term.y * layoutAnchor(term.x);
  }
  return point;
}
`;

function makeTexture(values, width) {
  const height = Math.max(1, Math.ceil(values.length / 4 / width));
  const data = new Float32Array(width * height * 4); data.set(values);
  const result = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.FloatType);
  result.minFilter = result.magFilter = THREE.NearestFilter;
  result.needsUpdate = true;
  return result;
}

/** Render the schema's affine stencils directly from the resident world buffer. */
export class LayoutRenderAdapter {
  constructor(scene) {
    this.scene = scene;
    this.bindings = new Map();
    this.materialBindings = new Map();
    this.pointBindings = new WeakMap();
    this.sampleKeys = new WeakMap();
    this.sampleBindings = new Map();
    this.resourceVersion = null;
    this.shellMeshes = new Set();
    this.uniforms = { layoutWorld: { value: null }, layoutWidth: { value: 1 }, layoutEnabled: { value: 0 },
      layoutOrigin: { value: new THREE.Vector3() }, layoutScale: { value: 1 },
      layoutBounds: { value: null }, layoutFitDiameter: { value: 0 },
      layoutInverseMap: { value: new THREE.Vector4(0, 0, 0, 1) },
      layoutParentWorld: { value: null }, layoutParentBase: { value: new THREE.Vector3() },
      layoutParentReference: { value: new THREE.Vector3(0, 1, 0) } };
  }

  bind(solver) {
    if (solver === this.solver) return;
    this.clearStencils();
    this.solver = solver;
    this.uniforms.layoutWorld.value = solver?.worldTexture ?? null;
    this.uniforms.layoutWidth.value = Math.max(1, solver?.count ?? 0);
    this.uniforms.layoutBounds.value = solver?.boundsTexture ?? null;
    this.uniforms.layoutEnabled.value = solver ? 1 : 0;
    this.refresh();
  }

  invalidate() { this.resourceVersion = null; }

  patchMaterial(material, patch, extra = {}) {
    let entry = this.materialBindings.get(material);
    if (entry) {
      for (const [key, value] of Object.entries(extra)) {
        if (entry.uniforms[key]) entry.uniforms[key].value = value.value;
        else entry.uniforms[key] = value;
      }
      return entry;
    }
    const original = material.onBeforeCompile;
    entry = { original, originalKey: material.customProgramCacheKey, uniforms: { ...this.uniforms, ...extra } };
    material.onBeforeCompile = (shader, renderer) => {
      original.call(material, shader, renderer);
      Object.assign(shader.uniforms, entry.uniforms);
      shader.vertexShader = `${declarations}\n${patch(shader.vertexShader)
        .replace("#include <project_vertex>", THREE.ShaderChunk.project_vertex)
        .replace(/gl_Position = ([^;]+);/g, "$&\ngl_Position += projectionMatrix * viewMatrix * vec4(layoutParentOffset(), 0.0);")}`;
      if (entry.vertexPatch) shader.vertexShader = entry.vertexPatch(shader.vertexShader);
      if (entry.fragmentPatch) shader.fragmentShader = entry.fragmentPatch(shader.fragmentShader);
    };
    material.customProgramCacheKey = () => `${entry.originalKey.call(material)}:layout:${patch.name}:${entry.fragmentPatch ? "shell" : ""}`;
    material.needsUpdate = true;
    this.materialBindings.set(material, entry);
    entry.onDispose = () => this.materialBindings.delete(material);
    material.addEventListener("dispose", entry.onDispose);
    return entry;
  }

  bindPoint(object, id) {
    if (!object?.material || !this.solver) return;
    const row = this.solver.rowForId(id);
    if (row < 0) return;
    const cached = this.pointBindings.get(object);
    if (cached?.row === row && cached.material === object.material && cached.geometry === object.geometry) {
      if (!cached.rotation.equals(object.quaternion)) {
        cached.entry.uniforms.layoutDirectionBase.value.set(0, 1, 0).applyQuaternion(object.quaternion);
        cached.rotation.copy(object.quaternion);
      }
      return;
    }
    const orientation = object.geometry?.type === "ConeGeometry"
      ? layoutOrientationWeights(this.solver.ledger, row) : null;
    const extra = { layoutRow: { value: row }, layoutBase: { value: object.position },
      layoutDirected: { value: orientation ? 1 : 0 },
      layoutDirectionRows: { value: new THREE.Vector4(...(orientation ?? []).flat(), 0, 0, 0, 0) },
      layoutDirectionBase: { value: new THREE.Vector3(0, 1, 0).applyQuaternion(object.quaternion) } };
    const entry = this.patchMaterial(object.material, function pointPatch(source) {
      const offset = "mvPosition.xyz += (viewMatrix * vec4(layoutEnabled * (layoutAnchor(layoutRow) - layoutBase), 0.0)).xyz;\n";
      source = source.replace("#include <project_vertex>", THREE.ShaderChunk.project_vertex);
      const rotation = `
        if (layoutEnabled > 0.5 && layoutDirected > 0.5) {
          vec3 direction = layoutDirectionRows.y * layoutAnchor(layoutDirectionRows.x)
            + layoutDirectionRows.w * layoutAnchor(layoutDirectionRows.z);
          if (length(direction) > 1e-8) {
            vec3 a=normalize(layoutDirectionBase), b=normalize(direction);
            vec3 relative=(modelMatrix*vec4(transformed,0.0)).xyz;
            vec3 turn=cross(a,b); float cosine=clamp(dot(a,b),-1.0,1.0);
            vec3 rotated=relative;
            if (cosine > -0.99999) rotated += cross(turn,relative)+cross(turn,cross(turn,relative))/(1.0+cosine);
            else {
              vec3 axis=normalize(cross(a,abs(a.z)<0.8 ? vec3(0,0,1) : vec3(0,1,0)));
              rotated = -relative + 2.0*axis*dot(axis,relative);
            }
            mvPosition.xyz += (viewMatrix*vec4(rotated-relative,0.0)).xyz;
          }
        }
      `;
      return `uniform float layoutRow, layoutDirected; uniform vec3 layoutBase, layoutDirectionBase;
        uniform vec4 layoutDirectionRows;\n${source.replace("gl_Position = projectionMatrix * mvPosition;",
        `${source.includes("vec3 transformed") || source.includes("<begin_vertex>") ? rotation : ""}${offset}gl_Position = projectionMatrix * mvPosition;`)}`;
    }, extra);
    entry.uniforms.layoutRow.value = row;
    entry.uniforms.layoutBase.value = object.position;
    entry.uniforms.layoutDirected.value = orientation ? 1 : 0;
    entry.uniforms.layoutDirectionRows.value = extra.layoutDirectionRows.value;
    entry.uniforms.layoutDirectionBase.value = extra.layoutDirectionBase.value;
    this.pointBindings.set(object, { row, material: object.material, geometry: object.geometry,
      rotation: object.quaternion.clone(), entry });
    object.frustumCulled = false;
  }

  bindStencils(mesh, stencils, { previous = null, next = null, nativeCoordinates = false, cached = null } = {}) {
    const terms = [], append = (weights) => {
      if (!weights?.length) return [0, 0];
      const offset = terms.length / 4;
      for (const [row, weight] of weights) terms.push(row, weight, 0, 0);
      return [offset, weights.length];
    };
    const addSpans = (name, entries) => {
      const values = new Float32Array(entries.length * 2);
      entries.forEach((weights, index) => values.set(append(weights), index * 2));
      mesh.geometry.setAttribute(name, new THREE.BufferAttribute(values, 2));
    };
    let weights = cached?.texture;
    if (cached) {
      // Each geometry owns its GPU attribute buffer; only immutable CPU span
      // data is shared, so disposing another geometry cannot invalidate it.
      if (mesh.geometry.getAttribute("layoutSpan")?.array !== cached.spans) {
        mesh.geometry.setAttribute("layoutSpan", new THREE.BufferAttribute(cached.spans, 2));
      }
    } else {
      addSpans("layoutSpan", stencils);
      if (previous) { addSpans("layoutPreviousSpan", previous); addSpans("layoutNextSpan", next); }
      const width = Math.min(Math.max(1, terms.length / 4), this.scene.renderer.capabilities.maxTextureSize);
      weights = makeTexture(terms, width);
    }
    const extra = { layoutWeights: { value: weights },
      layoutWeightsSize: { value: new THREE.Vector2(weights.image.width, weights.image.height) } };
    if (nativeCoordinates && this.scene.content) {
      const transform = this.scene.content.userData.gologContentTransform;
      extra.layoutInverseMap = { value: new THREE.Vector4(...transform.center.toArray(), 1 / transform.scale) };
    }
    this.patchMaterial(mesh.material, previous ? function edgePatch(source) {
      return `${stencilShader}\nattribute vec2 layoutPreviousSpan; attribute vec2 layoutNextSpan;\n${source
        .replace("vec4(position, 1.0)", "vec4(layoutPoint(position, layoutSpan), 1.0)")
        .replace("vec4(previousPosition, 1.0)", "vec4(layoutPoint(previousPosition, layoutPreviousSpan), 1.0)")
        .replace("vec4(nextPosition, 1.0)", "vec4(layoutPoint(nextPosition, layoutNextSpan), 1.0)")}`;
    } : function surfacePatch(source) {
      source = source.replace("#include <begin_vertex>", "vec3 transformed = layoutPoint(position, layoutSpan);");
      return `${stencilShader}\n${source.replace("vec4(position, 1.0)", "vec4(layoutPoint(position, layoutSpan), 1.0)")}`;
    }, extra);
    return weights;
  }

  bindSampledMesh(mesh) {
    const geometry = mesh.geometry, samples = geometry?.userData?.layoutSamples;
    if (!samples) return;
    const previous = this.bindings.get(mesh);
    if (previous?.geometry === geometry) return;
    // Semantic shells keep this sample map through coordinate changes. A new
    // topology or solver row numbering requires a new sampling operator.
    let key = this.sampleKeys.get(geometry);
    if (key === undefined) { key = JSON.stringify(samples); this.sampleKeys.set(geometry, key); }
    let shared = this.sampleBindings.get(key);
    const options = { nativeCoordinates: geometry.userData.layoutNativeCoordinates };
    if (!shared) {
      const stencils = samples.map(({ objectId, faceId, ...sample }) => {
        const row = this.solver.rowForId(objectId ?? faceId);
        return row < 0 ? [] : layoutRenderWeights(this.solver.ledger, row, sample);
      });
      const texture = this.bindStencils(mesh, stencils, options);
      shared = { key, texture, spans: geometry.getAttribute("layoutSpan").array, references: 0 };
      this.sampleBindings.set(key, shared);
    } else this.bindStencils(mesh, null, { ...options, cached: shared });
    shared.references++;
    const onDispose = () => this.invalidate();
    geometry.addEventListener("dispose", onDispose);
    this.bindings.set(mesh, { geometry, texture: shared.texture, shared, onDispose });
    mesh.frustumCulled = false;
    this.releaseBinding(previous);
  }

  bindShells(meshes) {
    for (const mesh of this.shellMeshes) {
      mesh.userData.layoutResidentShell = false;
      mesh.visible = mesh.userData.layoutCpuVisible ?? true;
    }
    this.shellMeshes = new Set(meshes.filter((mesh) => mesh.geometry?.userData.layoutShell));
    const geometries = [...new Set([...this.shellMeshes].map((mesh) => mesh.geometry))];
    if (geometries.length !== this.shellGeometries?.length
      || geometries.some((geometry, index) => geometry !== this.shellGeometries[index])) {
      this.shellValidatorReference?.release();
      this.shellValidatorReference = geometries.length ? acquireShellValidator(this.scene.renderer, this.solver, geometries) : null;
      this.shellValidator = this.shellValidatorReference?.validator ?? null;
      this.shellGeometries = geometries;
    }
    if (!this.shellValidator) return;
    const rows = new Map(geometries.map((geometry, row) => [geometry, row]));
    const { texture, width, height } = this.shellValidator.validity;
    const points = this.shellValidator.points, operators = this.shellValidator.operators;
    for (const mesh of this.shellMeshes) {
      const entry = this.materialBindings.get(mesh.material), row = rows.get(mesh.geometry);
      const uniforms = {
        layoutShellValidity: { value: texture }, layoutShellEnabled: this.uniforms.layoutEnabled,
        layoutShellRow: { value: new THREE.Vector2((row % width + .5) / width, (Math.floor(row / width) + .5) / height) },
        layoutShellPoints: { value: points.texture }, layoutShellPointSize: { value: new THREE.Vector2(points.width, points.height) },
        layoutShellAnchor: { value: operators.regions[row * 8 + 6] },
      };
      for (const [key, uniform] of Object.entries(uniforms)) {
        if (entry.uniforms[key]) entry.uniforms[key].value = uniform.value;
        else entry.uniforms[key] = uniform;
      }
      if (!entry.fragmentPatch) {
        entry.fragmentPatch = (source) => `uniform sampler2D layoutShellValidity;
uniform vec2 layoutShellRow; uniform float layoutShellEnabled;
${source.replace(/void\s+main\s*\(\s*\)\s*\{/, "$&\nif(layoutShellEnabled>0.5&&texture2D(layoutShellValidity,layoutShellRow).x<0.5)discard;")}`;
        mesh.material.needsUpdate = true;
      }
      const first = operators.regions[row * 8];
      if (!mesh.geometry.hasAttribute("layoutShellSample") || mesh.geometry.userData.layoutShellFirst !== first) {
        const indices = new Float32Array(mesh.geometry.getAttribute("position").count);
        mesh.geometry.userData.layoutShell.samples.forEach((sample, i) => {
          indices[sample.vertex] = operators.spans[(first + i) * 4 + 2];
        });
        mesh.geometry.setAttribute("layoutShellSample", new THREE.BufferAttribute(indices, 1));
        mesh.geometry.userData.layoutShellFirst = first;
      }
      entry.vertexPatch = (source) => {
        const pointFunction = `vec3 layoutShellPoint() {
  vec2 uv=(vec2(mod(layoutShellSample,layoutShellPointSize.x),floor(layoutShellSample/layoutShellPointSize.x))+.5)/layoutShellPointSize;
  vec3 origin=texture2D(layoutWorld,vec2((layoutShellAnchor+.5)/layoutWidth,.5)).xyz;
  return layoutMapPoint(origin,texture2D(layoutShellPoints,uv).xyz);
}`;
        return `uniform sampler2D layoutShellPoints; uniform vec2 layoutShellPointSize;
uniform float layoutShellAnchor; attribute float layoutShellSample;
${source.replace(/void\s+main\s*\(\s*(?:void\s*)?\)\s*\{/, `${pointFunction}\n$&`)
  .replace("layoutPoint(position, layoutSpan)", "(layoutEnabled>0.5?layoutShellPoint():position)")}`;
      };
      mesh.userData.layoutResidentShell = true; mesh.visible = true;
    }
  }

  releaseBinding(binding) {
    if (!binding) return;
    if (binding.onDispose) binding.geometry.removeEventListener("dispose", binding.onDispose);
    if (binding.shared) {
      if (--binding.shared.references) return;
      this.sampleBindings.delete(binding.shared.key);
    }
    binding.texture.dispose();
  }

  refreshBatch(batch, samplesForRecord, edge = false) {
    if (!batch) return;
    const signature = `${batch.geometry.getAttribute("position").count}:${batch.topologyVersion}`;
    const existing = this.bindings.get(batch);
    if (existing?.signature === signature) return;
    existing?.texture.dispose();
    const count = batch.geometry.getAttribute("position").count;
    const stencils = Array(count), previous = edge ? Array(count) : null, next = edge ? Array(count) : null;
    for (const [id, record] of batch.records) {
      const owner = record.ownerId ?? id;
      const row = this.solver.rowForId(owner);
      if (row < 0) continue;
      const slot = batch.slots.slotFor(id), samples = samplesForRecord(record);
      samples.forEach((sample, index) => {
        const vertex = slot * samples.length + index;
        stencils[vertex] = layoutRenderWeights(this.solver.ledger, row, sample);
        if (edge) {
          previous[vertex] = layoutRenderWeights(this.solver.ledger, row, { t: Math.max(0, sample.t - 1 / batch.samples) });
          next[vertex] = layoutRenderWeights(this.solver.ledger, row, { t: Math.min(1, sample.t + 1 / batch.samples) });
        }
      });
    }
    const map = this.bindStencils(batch.mesh, stencils, { previous, next });
    this.bindings.set(batch, { signature, texture: map });
  }

  refresh() {
    if (!this.solver) return;
    const scene = this.scene;
    if (scene.content) return this.refreshContent();
    const version = [scene.sphereMeshes.size, scene.objectLabels.size, scene.edgeGraphics.size,
      scene.surfaceGraphics.size, scene.nestedPreviews?.size ?? 0, scene.volumeGraphics.size,
      scene.sphereRenderer?.resourceVersion, scene.labelRenderer?.resourceVersion,
      scene.edgeBatchRenderer?.topologyVersion, scene.surfaceBatchRenderer?.topologyVersion,
      scene.edgeBatchRenderer?.renderVersion, scene.surfaceBatchRenderer?.renderVersion,
      scene.volumeRenderer?.renderer?.resourceVersion ?? scene.volumeRenderer?.resourceVersion].join(":");
    if (version === this.resourceVersion) { this.shellValidator?.update(); return; }
    this.resourceVersion = version;
    this.refreshBatch(scene.edgeBatchRenderer, () => Array.from({ length: scene.edgeBatchRenderer.verticesPerEdge },
      (_, i) => ({ t: Math.floor(i / 2) / scene.edgeBatchRenderer.samples })), true);
    this.refreshBatch(scene.surfaceBatchRenderer, (record) => Array.from({ length: scene.surfaceBatchRenderer.verticesPerSurface },
      (_, i) => ({ u: (i % scene.surfaceBatchRenderer.gridSize) / scene.surfaceBatchRenderer.samples,
        v: Math.floor(i / scene.surfaceBatchRenderer.gridSize) / scene.surfaceBatchRenderer.samples,
        patchIndex: record.patchIndex ?? 0 })));
    for (const [id, mesh] of scene.sphereMeshes) this.bindPoint(mesh, id);
    for (const [id, label] of scene.objectLabels) this.bindPoint(label, id);
    for (const [id, edge] of scene.edgeGraphics) this.bindPoint(edge.cone, id);
    for (const [id, surface] of scene.surfaceGraphics) this.bindPoint(surface.control, id);
    for (const [id, preview] of scene.nestedPreviews ?? []) this.bindPoint(preview.shell, id);
    for (const [id, volume] of scene.volumeGraphics) {
      this.bindPoint(volume.handle, id);
      const mesh = volume.mesh;
      if (mesh) this.bindSampledMesh(mesh);
    }
    for (const [object, binding] of this.bindings) {
      if (object.isMesh && !object.parent) { this.releaseBinding(binding); this.bindings.delete(object); }
    }
    this.bindShells([...scene.volumeGraphics.values()].map((entry) => entry.mesh).filter(Boolean));
    this.shellValidator?.update();
  }

  setParent(solver, id, base) {
    const row = solver?.rowForId(id) ?? -1;
    this.uniforms.layoutParentWorld.value = solver?.worldTexture ?? null;
    this.uniforms.layoutParentReference.value.set(Math.max(0, row), Math.max(1, solver?.count ?? 0), row < 0 ? 0 : 1);
    this.uniforms.layoutParentBase.value = base;
  }

  refreshContent() {
    const content = this.scene.content, transform = content.userData.gologContentTransform;
    this.uniforms.layoutOrigin.value.copy(transform?.center ?? new THREE.Vector3());
    this.uniforms.layoutScale.value = transform?.scale ?? 1;
    this.uniforms.layoutFitDiameter.value = transform?.diameter ?? 0;
    const version = content.userData.layoutResourceVersion;
    if (version !== undefined && version === this.resourceVersion) { this.shellValidator?.update(); return; }
    this.resourceVersion = version;
    const shells = [];
    content.traverse((object) => {
      if (object.userData.layoutPointId) this.bindPoint(object, object.userData.layoutPointId);
      this.bindSampledMesh(object);
      if (object.geometry?.userData.layoutShell) shells.push(object);
    });
    for (const [object, binding] of this.bindings) if (!object.parent) {
      this.releaseBinding(binding); this.bindings.delete(object);
    }
    this.bindShells(shells);
    this.shellValidator?.update();
  }

  clearStencils() {
    this.resourceVersion = null;
    this.shellValidatorReference?.release(); this.shellValidatorReference = null; this.shellValidator = null;
    this.shellGeometries = null;
    for (const mesh of this.shellMeshes) {
      mesh.userData.layoutResidentShell = false;
      mesh.visible = mesh.userData.layoutCpuVisible ?? true;
    }
    this.shellMeshes.clear();
    for (const binding of this.bindings.values()) this.releaseBinding(binding);
    this.bindings.clear();
    this.pointBindings = new WeakMap();
    this.sampleKeys = new WeakMap();
    for (const binding of this.materialBindings.values()) for (const name of ["layoutWeights", "layoutShellPoints", "layoutShellValidity"]) {
      if (binding.uniforms[name]) binding.uniforms[name].value = null;
    }
  }

  dispose() {
    this.uniforms.layoutEnabled.value = 0;
    this.clearStencils();
    for (const [material, binding] of this.materialBindings) {
      material.removeEventListener("dispose", binding.onDispose);
      material.onBeforeCompile = binding.original;
      material.customProgramCacheKey = binding.originalKey;
      material.needsUpdate = true;
    }
    this.materialBindings.clear();
  }
}
