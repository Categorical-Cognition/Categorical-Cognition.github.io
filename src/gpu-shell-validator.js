import * as THREE from "three";
import { layoutRenderWeights } from "./layout-schema.js";

const sharedValidators = new WeakMap();
export function acquireShellValidator(renderer, solver, geometries) {
  let contexts = sharedValidators.get(solver);
  if (!contexts) { contexts = new WeakMap(); sharedValidators.set(solver, contexts); }
  let cache = contexts.get(renderer);
  if (!cache) { cache = new Map(); contexts.set(renderer, cache); }
  const key = JSON.stringify(geometries.map((geometry) => geometry.userData.layoutShell.topologyKey));
  let entry = cache.get(key);
  if (!entry) {
    entry = { validator: new GPUShellValidator(renderer, solver, geometries), references: 0 };
    cache.set(key, entry);
  }
  entry.references++;
  let active = true;
  return { validator: entry.validator, release() {
    if (!active) return; active = false;
    if (--entry.references === 0) { entry.validator.dispose(); cache.delete(key); }
  } };
}

/** Fixed shell sampling, seam witnesses and a stackless binary support tree. */
export function compileShellOperators(geometries, weightsForSample) {
  const spans = [], weights = [], triangles = [], regions = [], nodes = [], leaves = [];
  let maxDepth = 0;
  geometries.forEach((geometry, region) => {
    const shell = geometry.userData.layoutShell, start = spans.length / 4, representatives = [];
    let anchor = Infinity;
    shell.samples.forEach((sample, i) => { representatives[sample.vertex] ??= start + i; });
    for (const sample of shell.samples) {
      const terms = weightsForSample(sample).slice().sort(([a], [b]) => a - b);
      spans.push(weights.length / 4, terms.length, representatives[sample.vertex], region);
      for (const [row, weight] of terms) {
        anchor = Math.min(anchor, row);
        weights.push(row, weight, 0, 0);
      }
    }
    const firstTriangle = triangles.length / 4;
    for (const triangle of shell.triangles) triangles.push(...triangle.map((i) => representatives[i]), region);
    const positions = geometry.getAttribute("position");
    const build = (ids, depth) => {
      const index = nodes.length / 4; nodes.push(0, 0, 0, depth); maxDepth = Math.max(maxDepth, depth);
      if (ids.length <= 8) {
        const offset = leaves.length / 4;
        ids.forEach((id) => leaves.push(representatives[id], 0, 0, 0));
        nodes.splice(index * 4, 4, offset, -ids.length, index + 1, depth);
      } else {
        const bounds = new THREE.Box3();
        for (const id of ids) bounds.expandByPoint(new THREE.Vector3().fromBufferAttribute(positions, id));
        const size = bounds.getSize(new THREE.Vector3());
        const axis = size.x >= size.y && size.x >= size.z ? 0 : size.y >= size.z ? 1 : 2;
        ids.sort((a, b) => positions.array[a * 3 + axis] - positions.array[b * 3 + axis]);
        const middle = ids.length >> 1;
        const left = build(ids.slice(0, middle), depth + 1), right = build(ids.slice(middle), depth + 1);
        nodes.splice(index * 4, 4, left, right, nodes.length / 4, depth);
      }
      return index;
    };
    const root = build(representatives.map((_, i) => i), 0);
    // Affine samples share one moving origin, keeping validation independent
    // of the shell's distance from the world origin in binary32 arithmetic.
    regions.push(start, shell.samples.length, firstTriangle, shell.triangles.length,
      root, shell.relativeTolerance, Number.isFinite(anchor) ? anchor : -1, 0);
  });
  return { spans, weights, triangles, regions, nodes, leaves, maxDepth, count: geometries.length };
}

const accessors = `
uniform sampler2D uSpans,uWeights,uWorld,uTriangles,uRegions,uNodes,uLeaves;
uniform sampler2D uPoints,uLower,uUpper,uTreeLower,uTreeUpper,uPlanes,uMeasure,uConvex;
uniform int uWidth,uCount,uDepth;
vec4 at(sampler2D image,int i) { int w=textureSize(image,0).x; return texelFetch(image,ivec2(i%w,i/w),0); }
int row() { return int(gl_FragCoord.x)+int(gl_FragCoord.y)*uWidth; }
bool finitePoint(vec3 p) { return !any(isnan(p))&&!any(isinf(p)); }
vec3 point(int i) { return at(uPoints,i).xyz; }
vec4 region(int i) { return at(uRegions,2*i); }
`;
const shaders = {
  sample: `out vec4 result;
void main(){int i=row();if(i>=uCount){result=vec4(0);return;}vec4 s=at(uSpans,i);vec3 p=vec3(0);
int anchor=int(at(uRegions,2*int(s.w)+1).z);vec3 origin=anchor<0?vec3(0):at(uWorld,anchor).xyz;
for(int k=0;k<int(s.y);k++){vec2 t=at(uWeights,int(s.x)+k).xy;p+=t.y*(at(uWorld,int(t.x)).xyz-origin);}
result=vec4(p,anchor>=0&&s.y>0.0&&finitePoint(p)?1.0:0.0);}`,
  bounds: `layout(location=0) out vec4 lower;layout(location=1) out vec4 upper;
void main(){int i=row();if(i>=uCount){lower=upper=vec4(0);return;}vec4 r=region(i);
vec3 lo=point(int(r.x)),hi=lo;float valid=1.0,seam=0.0;
for(int j=0;j<int(r.y);j++){int k=int(r.x)+j;vec4 p=at(uPoints,k);lo=min(lo,p.xyz);hi=max(hi,p.xyz);
valid=min(valid,p.w);vec3 d=p.xyz-point(int(at(uSpans,k).z));seam=max(seam,dot(d,d));}
lower=vec4(lo,valid);upper=vec4(hi,seam);}`,
  tree: `layout(location=0) out vec4 lower;layout(location=1) out vec4 upper;
void main(){int i=row();if(i>=uCount){lower=upper=vec4(0);return;}vec4 n=at(uNodes,i);
if(int(n.w)!=uDepth){lower=at(uTreeLower,i);upper=at(uTreeUpper,i);return;}
vec3 lo,hi;if(n.y<0.0){lo=hi=point(int(at(uLeaves,int(n.x)).x));
for(int j=1;j<int(-n.y);j++){vec3 p=point(int(at(uLeaves,int(n.x)+j).x));lo=min(lo,p);hi=max(hi,p);}}
else{lo=min(at(uTreeLower,int(n.x)).xyz,at(uTreeLower,int(n.y)).xyz);
hi=max(at(uTreeUpper,int(n.x)).xyz,at(uTreeUpper,int(n.y)).xyz);}
lower=vec4(lo,0);upper=vec4(hi,0);}`,
  plane: `out vec4 result;
void main(){int i=row();if(i>=uCount){result=vec4(0);return;}ivec4 t=ivec4(at(uTriangles,i));
vec3 lo=at(uLower,t.w).xyz,hi=at(uUpper,t.w).xyz,origin=(lo+hi)*0.5;float scale=length(hi-lo);
vec3 a=(point(t.x)-origin)/scale,b=(point(t.y)-origin)/scale,c=(point(t.z)-origin)/scale;
result=vec4(cross(b-a,c-a),dot(a,cross(b,c))/6.0);}`,
  measure: `out vec4 result;
void main(){int i=row();if(i>=uCount){result=vec4(0);return;}vec4 r=region(i),lo=at(uLower,i),hi=at(uUpper,i);
float scale=length(hi.xyz-lo.xyz),relative=at(uRegions,2*i+1).y,tolerance=max(scale*relative,1.4210854715202004e-14);
float volume=0.0,residue=0.0,valid=lo.w,relativeTolerance=tolerance/scale;
for(int j=0;j<int(r.w);j++){vec4 p=at(uPlanes,int(r.z)+j);float y=p.w-residue,sum=volume+y;
residue=(sum-volume)-y;volume=sum;if(dot(p.xyz,p.xyz)<=pow(relativeTolerance,4.0))valid=0.0;}
if(scale==0.0||hi.w>tolerance*tolerance||abs(volume)<=relative||isnan(volume)||isinf(volume))valid=0.0;
result=vec4(volume<0.0?-1.0:1.0,tolerance,abs(volume)*scale*scale*scale,valid);}`,
  convex: `out vec4 result;
void main(){int i=row();if(i>=uCount){result=vec4(0);return;}ivec4 t=ivec4(at(uTriangles,i));vec4 m=at(uMeasure,t.w);
if(m.w<0.5){result=vec4(0);return;}vec3 normal=normalize(at(uPlanes,i).xyz)*m.x,origin=point(t.x);
int root=int(at(uRegions,2*t.w+1).x),end=int(at(uNodes,root).z),node=root;float valid=1.0;
while(node<end){vec4 n=at(uNodes,node);vec3 lo=at(uTreeLower,node).xyz,hi=at(uTreeUpper,node).xyz;
vec3 farPoint=mix(lo,hi,greaterThanEqual(normal,vec3(0)));
if(dot(normal,farPoint-origin)<=m.y*8.0){node=int(n.z);continue;}
if(n.y<0.0){for(int j=0;j<int(-n.y);j++){
if(dot(normal,point(int(at(uLeaves,int(n.x)+j).x))-origin)>m.y*8.0){valid=0.0;break;}}
node=int(n.z);if(valid<0.5)break;}else node++;}
result=vec4(valid,0,0,0);}`,
  reduce: `out vec4 result;
void main(){int i=row();if(i>=uCount){result=vec4(0);return;}vec4 r=region(i),m=at(uMeasure,i);float valid=m.w;
for(int j=0;j<int(r.w)&&valid>0.5;j++)valid=min(valid,at(uConvex,int(r.z)+j).x);
result=vec4(valid,m.z,m.x,0);}`,
};

/** GPU numerical validity for fixed sampled shells; no coordinate readback. */
export class GPUShellValidator {
  constructor(renderer, solver, geometries) {
    this.renderer = renderer; this.solver = solver;
    this.operators = compileShellOperators(geometries, ({ faceId, vertex, ...sample }) => {
      const row = solver.rowForId(faceId);
      return row < 0 ? [] : layoutRenderWeights(solver.ledger, row, sample);
    });
    this.uniforms = {}; this.resources = []; this.materials = {};
    const size = (count) => {
      const width = Math.min(Math.max(1, count), renderer.capabilities.maxTextureSize);
      const height = Math.ceil(Math.max(1, count) / width);
      if (height > renderer.capabilities.maxTextureSize) throw new Error("Shell sampling exceeds GPU texture capacity");
      return [width, height];
    };
    for (const key of ["spans", "weights", "triangles", "regions", "nodes", "leaves"]) {
      const values = this.operators[key], [width, height] = size(values.length / 4);
      const data = new Float32Array(width * height * 4); data.set(values);
      const image = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.FloatType);
      image.minFilter = image.magFilter = THREE.NearestFilter; image.needsUpdate = true;
      this.resources.push(image); this.uniforms[`u${key[0].toUpperCase()}${key.slice(1)}`] = { value: image };
    }
    const target = (count, channels = 1) => {
      const [width, height] = size(count);
      const result = new THREE.WebGLRenderTarget(width, height, { count: channels, type: THREE.FloatType,
        format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
        depthBuffer: false, stencilBuffer: false });
      this.resources.push(result); return result;
    };
    this.points = target(this.operators.spans.length / 4);
    this.bounds = target(geometries.length, 2);
    this.tree = [target(this.operators.nodes.length / 4, 2), target(this.operators.nodes.length / 4, 2)];
    this.planes = target(this.operators.triangles.length / 4);
    this.measure = target(geometries.length); this.convex = target(this.operators.triangles.length / 4);
    this.validity = target(geometries.length);
    for (const [key, value] of Object.entries({ uWorld: solver.worldTexture, uPoints: this.points.texture,
      uLower: this.bounds.textures[0], uUpper: this.bounds.textures[1], uTreeLower: this.tree[0].textures[0],
      uTreeUpper: this.tree[0].textures[1], uPlanes: this.planes.texture, uMeasure: this.measure.texture,
      uConvex: this.convex.texture, uWidth: 1, uCount: 0, uDepth: 0 })) this.uniforms[key] = { value };
    this.scene = new THREE.Scene(); this.camera = new THREE.Camera();
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2)); this.quad.frustumCulled = false; this.scene.add(this.quad);
    for (const [name, body] of Object.entries(shaders)) this.materials[name] = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: "void main(){gl_Position=vec4(position.xy,0.0,1.0);}",
      fragmentShader: `${accessors}\n${body}`, uniforms: this.uniforms,
      depthTest: false, depthWrite: false, blending: THREE.NoBlending,
    });
    this.updateCount = 0; this.dispatchCount = 0;
  }

  update() {
    const version = this.solver.geometryVersion ?? this.solver.stepCount;
    if (this.version === version) return;
    this.solver.batch(() => {
      const run = (name, target, count) => {
        this.uniforms.uWidth.value = target.width; this.uniforms.uCount.value = count;
        this.renderer.setRenderTarget(target);
        this.quad.material = this.materials[name]; this.renderer.render(this.scene, this.camera); this.dispatchCount++;
      };
      const o = this.operators;
      run("sample", this.points, o.spans.length / 4); run("bounds", this.bounds, o.count);
      let index = 0;
      for (let depth = o.maxDepth; depth >= 0; depth--) {
        this.uniforms.uDepth.value = depth;
        this.uniforms.uTreeLower.value = this.tree[index].textures[0]; this.uniforms.uTreeUpper.value = this.tree[index].textures[1];
        index = 1 - index; run("tree", this.tree[index], o.nodes.length / 4);
      }
      this.uniforms.uTreeLower.value = this.tree[index].textures[0]; this.uniforms.uTreeUpper.value = this.tree[index].textures[1];
      run("plane", this.planes, o.triangles.length / 4); run("measure", this.measure, o.count);
      run("convex", this.convex, o.triangles.length / 4); run("reduce", this.validity, o.count);
    });
    this.version = version; this.updateCount++;
  }

  dispose() {
    this.resources.forEach((resource) => resource.dispose());
    Object.values(this.materials).forEach((material) => material.dispose());
    this.quad.geometry.dispose();
  }
}
