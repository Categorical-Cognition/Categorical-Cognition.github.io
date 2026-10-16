import * as THREE from "three";

export class BatchSlotAllocator {
  constructor({ initialCapacity = 128 } = {}) {
    this.capacity = initialCapacity;
    this.slots = new Map();
    this.freeSlots = [];
    this.nextSlot = 0;
  }

  assign(id) {
    const existingSlot = this.slots.get(id);
    if (existingSlot !== undefined) {
      return existingSlot;
    }

    const slot =
      this.freeSlots.length > 0 ? this.freeSlots.pop() : this.nextSlot++;
    this.slots.set(id, slot);
    return slot;
  }

  release(id) {
    const slot = this.slots.get(id);
    if (slot === undefined) {
      return null;
    }

    this.slots.delete(id);
    this.freeSlots.push(slot);
    return slot;
  }

  slotFor(id) {
    return this.slots.get(id) ?? null;
  }

  ensureCapacity(requiredCapacity) {
    if (requiredCapacity <= this.capacity) {
      return false;
    }

    while (this.capacity < requiredCapacity) {
      this.capacity *= 2;
    }
    return true;
  }

  activeCount() {
    return this.slots.size;
  }

  highWaterSlotCount() {
    return this.nextSlot;
  }
}

export class BatchedGeometryRenderer {
  constructor({
    scene,
    name,
    material,
    initialCapacity = 128,
    frustumCulled = false,
  }) {
    this.scene = scene;
    this.records = new Map();
    this.slots = new BatchSlotAllocator({ initialCapacity });
    this.capacity = this.slots.capacity;
    this.geometry = new THREE.BufferGeometry();
    this.material = material;
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = name;
    this.mesh.frustumCulled = frustumCulled;
    this.scene.add(this.mesh);
  }

  upsertRecord(id, record) {
    this.records.set(id, record);
    const slot = this.slots.assign(id);
    if (this.slots.ensureCapacity(slot + 1)) {
      this.capacity = this.slots.capacity;
      this.allocateBuffers(this.capacity);
      this.rebuild();
      return slot;
    }

    this.writeRecord(record, slot);
    this.updateDrawRange();
    return slot;
  }

  removeRecord(id) {
    const slot = this.slots.release(id);
    this.records.delete(id);
    if (slot === null) {
      return null;
    }

    this.clearSlot(slot);
    this.updateDrawRange();
    return slot;
  }

  rebuild() {
    for (const [id, record] of this.records.entries()) {
      this.writeRecord(record, this.slots.slotFor(id));
    }
    this.updateDrawRange();
  }

  setAttribute(name, array, itemSize) {
    this.geometry.setAttribute(name, new THREE.BufferAttribute(array, itemSize));
  }

  markAttributeRange(attributeName, start, count) {
    const attribute = this.geometry.getAttribute(attributeName);
    attribute.addUpdateRange(start, count);
    attribute.needsUpdate = true;
  }

  updateDrawRange() {
    this.geometry.setDrawRange(
      0,
      this.slots.highWaterSlotCount() * this.indicesPerItem,
    );
  }

  baseStats() {
    return {
      capacity: this.capacity,
      drawCalls: 1,
      indexCount: this.geometry.drawRange.count,
    };
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
  }
}
