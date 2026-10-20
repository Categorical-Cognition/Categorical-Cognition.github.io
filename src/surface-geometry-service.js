import {
  elevateQuadraticBezierToCubic,
  getQuadraticControlPoint,
  getTriangularCubicInteriorControlForSurfacePoint,
  makePlaneBasisFromNormal,
} from "./geometry-utils.js";

const DEGENERATE_DIRECTION_EPSILON = 1e-10;
const TRIANGLE_BARYCENTER = Object.freeze({ a: 1 / 3, b: 1 / 3, c: 1 / 3 });

export function createTwoCellFaceDirection({ firstEdgeMidpoint, secondEdgeMidpoint }) {
  // Native 2-cells point from the source d1 to the target d0.
  const direction = secondEdgeMidpoint.clone().sub(firstEdgeMidpoint);
  return direction.lengthSq() > DEGENERATE_DIRECTION_EPSILON
    ? direction.normalize()
    : null;
}

export function createTwoCellControlLine({
  firstEdge,
  secondEdge,
  frame,
  previousDirection = null,
}) {
  const coneLine = secondEdge.midpoint.clone().sub(firstEdge.midpoint);
  coneLine.addScaledVector(frame.tangent, -coneLine.dot(frame.tangent));
  const boundaryCenter = firstEdge.midpoint.clone().lerp(secondEdge.midpoint, 0.5);
  const direction = frame.tangent.clone().cross(coneLine);

  if (direction.lengthSq() < DEGENERATE_DIRECTION_EPSILON) {
    const projectedPrevious = previousDirection
      ?.clone()
      .addScaledVector(frame.tangent, -previousDirection.dot(frame.tangent));
    if (projectedPrevious?.lengthSq() > DEGENERATE_DIRECTION_EPSILON) {
      direction.copy(projectedPrevious);
    } else {
      direction.copy(frame.u);
    }
  }

  direction.normalize();
  if (previousDirection?.dot?.(direction) < 0) direction.negate();
  return {
    origin: boundaryCenter,
    direction,
    defaultCoordinate: 0,
  };
}

export function createTwoSimplexControlLine({
  source,
  middle,
  target,
  previousDirection = null,
}) {
  const origin = source.position
    .clone()
    .add(middle.position)
    .add(target.position)
    .multiplyScalar(1 / 3);
  const sourceToMiddle = middle.position.clone().sub(source.position);
  const sourceToTarget = target.position.clone().sub(source.position);
  const direction = sourceToMiddle.cross(sourceToTarget);

  if (direction.lengthSq() < DEGENERATE_DIRECTION_EPSILON) {
    if (previousDirection?.lengthSq?.() > DEGENERATE_DIRECTION_EPSILON) {
      direction.copy(previousDirection);
    } else {
      direction.copy(makePlaneBasisFromNormal(sourceToTarget).u);
    }
  }

  direction.normalize();
  if (previousDirection?.dot?.(direction) < 0) direction.negate();
  return {
    origin,
    direction,
    defaultCoordinate: 0,
  };
}

export function createTwoSimplexControlNet({
  surfacePoint,
  source,
  middle,
  target,
  firstEdge,
  secondEdge,
  compositeEdge,
}) {
  const firstControl = getQuadraticControlPoint(
    source.position,
    firstEdge.midpoint,
    middle.position,
  );
  const secondControl = getQuadraticControlPoint(
    middle.position,
    secondEdge.midpoint,
    target.position,
  );
  const compositeControl = getQuadraticControlPoint(
    source.position,
    compositeEdge.midpoint,
    target.position,
  );
  const firstBoundary = elevateQuadraticBezierToCubic(
    source.position,
    firstControl,
    middle.position,
  );
  const secondBoundary = elevateQuadraticBezierToCubic(
    middle.position,
    secondControl,
    target.position,
  );
  const compositeBoundary = elevateQuadraticBezierToCubic(
    source.position,
    compositeControl,
    target.position,
  );
  const triangleControlNet = Array.from({ length: 4 }, () =>
    Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => null)),
  );

  triangleControlNet[3][0][0] = firstBoundary[0];
  triangleControlNet[2][1][0] = firstBoundary[1];
  triangleControlNet[1][2][0] = firstBoundary[2];
  triangleControlNet[0][3][0] = firstBoundary[3];

  triangleControlNet[0][3][0] = secondBoundary[0];
  triangleControlNet[0][2][1] = secondBoundary[1];
  triangleControlNet[0][1][2] = secondBoundary[2];
  triangleControlNet[0][0][3] = secondBoundary[3];

  triangleControlNet[3][0][0] = compositeBoundary[0];
  triangleControlNet[2][0][1] = compositeBoundary[1];
  triangleControlNet[1][0][2] = compositeBoundary[2];
  triangleControlNet[0][0][3] = compositeBoundary[3];

  triangleControlNet[1][1][1] =
    getTriangularCubicInteriorControlForSurfacePoint({
      controlNet: triangleControlNet,
      surfacePoint,
      barycentric: TRIANGLE_BARYCENTER,
    });
  return triangleControlNet;
}
