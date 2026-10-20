import * as THREE from "three";

/** Pick the rendered controls, including their resident coordinate displacement. */
export class LayoutPicker {
  constructor(renderer, adapter) {
    this.renderer = renderer;
    this.adapter = adapter;
    this.scene = new THREE.Scene();
    this.entries = new Map();
    this.target = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: true });
    this.pixel = new Uint8Array(4);
    this.readCount = 0;
  }

  pick(candidates, camera, pointer) {
    const present = new Set(candidates.map(({ object }) => object));
    for (const [object, entry] of this.entries) if (!present.has(object)) {
      this.scene.remove(entry.mesh);
      entry.mesh.material.dispose();
      this.entries.delete(object);
    }
    candidates.forEach(({ object, id, kind }, index) => {
      let entry = this.entries.get(object);
      if (!entry || entry.mesh.geometry !== object.geometry) {
        if (entry) { this.scene.remove(entry.mesh); entry.mesh.material.dispose(); }
        const color = { value: new THREE.Vector3() };
        const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, toneMapped: false });
        material.onBeforeCompile = (shader) => {
          shader.uniforms.pickColor = color;
          shader.fragmentShader = "uniform vec3 pickColor; void main() { gl_FragColor = vec4(pickColor, 1.0); }";
        };
        const mesh = new THREE.Mesh(object.geometry, material);
        mesh.matrixAutoUpdate = false;
        mesh.frustumCulled = false;
        this.scene.add(mesh);
        entry = { mesh, color };
        this.entries.set(object, entry);
      }
      object.updateWorldMatrix(true, false);
      entry.mesh.position.copy(object.position);
      entry.mesh.quaternion.copy(object.quaternion);
      entry.mesh.matrix.copy(object.matrixWorld);
      entry.mesh.renderOrder = index;
      const code = index + 1;
      entry.color.value.set((code & 255) / 255, ((code >> 8) & 255) / 255, ((code >> 16) & 255) / 255);
      this.adapter.bindPoint(entry.mesh, id);
      entry.id = id; entry.kind = kind;
    });
    const renderer = this.renderer, target = renderer.getRenderTarget();
    const viewport = renderer.getViewport(new THREE.Vector4()), scissor = renderer.getScissor(new THREE.Vector4());
    const scissorTest = renderer.getScissorTest(), clear = renderer.getClearColor(new THREE.Color());
    const alpha = renderer.getClearAlpha(), autoClear = renderer.autoClear;
    const pickCamera = camera.clone();
    // Keep any existing cropped camera projection, then magnify the chosen pixel.
    const width = Math.max(1, viewport.z * renderer.getPixelRatio());
    const height = Math.max(1, viewport.w * renderer.getPixelRatio());
    const x = (pointer.x + 1) * width / 2, y = (pointer.y + 1) * height / 2;
    const crop = new THREE.Matrix4().set(
      width, 0, 0, width - 2 * x,
      0, height, 0, height - 2 * y,
      0, 0, 1, 0,
      0, 0, 0, 1,
    );
    pickCamera.projectionMatrix.premultiply(crop);
    pickCamera.projectionMatrixInverse.copy(pickCamera.projectionMatrix).invert();
    try {
      renderer.setRenderTarget(this.target);
      renderer.setScissorTest(false);
      renderer.setClearColor(0, 0);
      renderer.autoClear = true;
      renderer.render(this.scene, pickCamera);
      renderer.readRenderTargetPixels(this.target, 0, 0, 1, 1, this.pixel);
      this.readCount++;
    } finally {
      renderer.setRenderTarget(target);
      renderer.setViewport(viewport);
      renderer.setScissor(scissor);
      renderer.setScissorTest(scissorTest);
      renderer.setClearColor(clear, alpha);
      renderer.autoClear = autoClear;
    }
    const index = this.pixel[0] + this.pixel[1] * 256 + this.pixel[2] * 65536 - 1;
    return candidates[index] ?? null;
  }

  dispose() {
    for (const { mesh } of this.entries.values()) mesh.material.dispose();
    this.entries.clear();
    this.scene.clear();
    this.target.dispose();
  }
}
