import { cloneStoreValue } from "./store-utils.js";

export class DomainEventsAdapter {
  constructor(bus) {
    this.bus = bus;
  }

  emit(type, payload) {
    this.bus.emit(type, payload);
  }

  stateChanged(snapshot) {
    this.emit("state:changed", snapshot);
  }

  objectUpserted(record) {
    this.emit("store:object-upserted", cloneStoreValue(record));
  }

  objectDeleted(record) {
    this.emit("store:object-deleted", cloneStoreValue(record));
  }

  sphereCreated({ id, position }) {
    this.emit("render:sphere-created", { id, position: position.clone() });
  }

  sphereMoved({ id, position }) {
    this.emit("render:sphere-moved", { id, position: position.clone() });
  }

  sphereSelected(id) {
    this.emit("render:sphere-selected", { id });
  }

  edgeCreated(edgePayload) {
    this.emit("render:edge-created", edgePayload);
  }

  edgeMidpointMoved(edgePayload) {
    this.emit("render:edge-midpoint-moved", edgePayload);
  }

  edgeSelected(id) {
    this.emit("render:edge-selected", { id });
  }

  edgeDeleted(payload) {
    this.emit("render:edge-deleted", cloneStoreValue(payload));
  }

  surfaceCreated(surfacePayload) {
    this.emit("render:surface-created", surfacePayload);
  }

  surfaceUpdated(surfacePayload) {
    this.emit("render:surface-updated", surfacePayload);
  }

  surfaceSelected(id) {
    this.emit("render:surface-selected", { id });
  }

  surfaceDeleted(payload) {
    this.emit("render:surface-deleted", cloneStoreValue(payload));
  }

  volumeCreated(payload) { this.emit("render:volume-created", payload); }
  volumeUpdated(payload) { this.emit("render:volume-updated", payload); }
  volumeDeleted(payload) { this.emit("render:volume-deleted", cloneStoreValue(payload)); }
  volumeSelected(id) { this.emit("render:volume-selected", { id }); }

  selectSphere(id) {
    this.volumeSelected(null);
    this.sphereSelected(id);
    this.edgeSelected(null);
    this.surfaceSelected(null);
  }

  selectEdge(id) {
    this.volumeSelected(null);
    this.sphereSelected(null);
    this.edgeSelected(id);
    this.surfaceSelected(null);
  }

  selectSurface(id) {
    this.volumeSelected(null);
    this.sphereSelected(null);
    this.edgeSelected(null);
    this.surfaceSelected(id);
  }

  selectVolume(id) {
    this.sphereSelected(null);
    this.edgeSelected(null);
    this.surfaceSelected(null);
    this.volumeSelected(id);
  }

  simplexRenamed({ id, name }) {
    this.emit("render:simplex-renamed", { id, name });
  }

  childGologAttached(payload) {
    this.emit("sphere:child-golog-attached", payload);
  }

  locksAcquired(result) {
    this.emit("store:locks-acquired", cloneStoreValue(result));
  }

  locksReleased(payload) {
    this.emit("store:locks-released", cloneStoreValue(payload));
  }

  locksChanged(snapshot) {
    this.emit("store:locks-changed", snapshot);
  }

  lockDenied(result) {
    this.emit("store:lock-denied", cloneStoreValue(result));
  }

  mutationDenied(payload) {
    this.emit("store:mutation-denied", cloneStoreValue(payload));
  }
}
