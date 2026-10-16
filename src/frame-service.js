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
  const tangent = secondPosition.clone().sub(firstPosition).normalize();
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
