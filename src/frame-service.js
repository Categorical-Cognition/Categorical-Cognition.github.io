import { Vector3 } from "three";
import {
  bendFromFramePoint as calculateBendFromFramePoint,
  makePlaneBasisFromNormal,
  pointFromFrameBend as calculatePointFromFrameBend,
  transportPlaneBasis,
} from "./geometry-utils.js";

export function createNodePairFrameGeometry({
  firstPosition,
  secondPosition,
  existingFrame = null,
}) {
  const tangent = secondPosition.clone().sub(firstPosition);
  if (tangent.lengthSq() < 1e-20) tangent.copy(existingFrame?.tangent ?? tangent.set(0, 0, 1));
  tangent.normalize();
  const { u, v } = existingFrame
    ? transportPlaneBasis(existingFrame, tangent)
    : makePlaneBasisFromNormal(tangent);

  return {
    origin: firstPosition.clone().lerp(secondPosition, 0.5),
    tangent,
    u,
    v,
  };
}

export function pointFromFrameBend(frame, bend) {
  return calculatePointFromFrameBend(frame, bend);
}

export function bendFromFramePoint(frame, point) {
  return calculateBendFromFramePoint(frame, point);
}

// A transported frame is presentation data: coordinates alone do not determine
// geometry after a closed path of boundary rotations.
export function normalizeControlDirection(value, name = "control direction") {
  if (value == null) return null;
  const coordinates = value?.isVector3 ? value.toArray() : value;
  if (!Array.isArray(coordinates) || coordinates.length !== 3 || !coordinates.every(Number.isFinite)) {
    throw new TypeError(`${name} must contain three finite coordinates`);
  }
  const direction = new Vector3(...coordinates);
  if (Math.abs(direction.lengthSq() - 1) > 1e-4) throw new TypeError(`${name} must be a unit vector`);
  return direction.normalize();
}

export function normalizeFrameGauge(value) {
  if (value == null) return null;
  const u = normalizeControlDirection(value.u, "frame u");
  const tangent = normalizeControlDirection(value.tangent, "frame tangent");
  if (!u || !tangent || Math.abs(u.dot(tangent)) > 1e-4) {
    throw new TypeError("Frame axes must be orthogonal unit vectors");
  }
  u.addScaledVector(tangent, -u.dot(tangent)).normalize();
  return { u, tangent, v: tangent.clone().cross(u).normalize() };
}

export function serializeFrameGauge(frame) {
  return { u: frame.u.toArray(), tangent: frame.tangent.toArray() };
}

export function assertFrameTangent(frame, firstPosition, secondPosition) {
  const tangent = secondPosition.clone().sub(firstPosition);
  if (tangent.lengthSq() > 1e-20 && tangent.normalize().dot(frame.tangent) < 1 - 1e-4) {
    throw new TypeError("Frame tangent must follow its ordered boundary positions");
  }
}

export function frameGaugesEqual(first, second) {
  return first.u.distanceToSquared(second.u) <= 1e-10 &&
    first.tangent.distanceToSquared(second.tangent) <= 1e-10;
}
