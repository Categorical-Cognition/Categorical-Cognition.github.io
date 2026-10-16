import * as THREE from "three";

export const OPPOSITE_TANGENT_EPSILON = 1e-8;

export function makePlaneBasisFromNormal(normal) {
  if (normal.lengthSq() === 0) {
    return {
      u: new THREE.Vector3(1, 0, 0),
      v: new THREE.Vector3(0, 1, 0),
    };
  }

  const n = normal.clone().normalize();
  const sign = Math.sign(n.z) || 1;
  const a = -1 / (sign + n.z);
  const b = n.x * n.y * a;
  const u = new THREE.Vector3(
    1 + sign * n.x * n.x * a,
    sign * b,
    -sign * n.x,
  ).normalize();
  const v = new THREE.Vector3(b, sign + n.y * n.y * a, -n.y).normalize();
  return { u, v };
}

export function transportPlaneBasis(frame, newTangent) {
  const oldTangent = frame.tangent?.clone?.().normalize();
  if (!oldTangent || oldTangent.lengthSq() === 0 || newTangent.lengthSq() === 0) {
    return makePlaneBasisFromNormal(newTangent);
  }

  const dot = THREE.MathUtils.clamp(oldTangent.dot(newTangent), -1, 1);
  if (dot < -1 + OPPOSITE_TANGENT_EPSILON) {
    const projectedU = frame.u
      .clone()
      .addScaledVector(newTangent, -frame.u.dot(newTangent));
    if (projectedU.lengthSq() > OPPOSITE_TANGENT_EPSILON) {
      const u = projectedU.normalize();
      return {
        u,
        v: newTangent.clone().cross(u).normalize(),
      };
    }
    return makePlaneBasisFromNormal(newTangent);
  }

  const rotation = new THREE.Quaternion().setFromUnitVectors(
    oldTangent,
    newTangent,
  );
  const u = frame.u.clone().applyQuaternion(rotation);
  u.addScaledVector(newTangent, -u.dot(newTangent)).normalize();
  const v = newTangent.clone().cross(u).normalize();
  return { u, v };
}

export function pointFromFrameBend(frame, bend) {
  return frame.origin
    .clone()
    .addScaledVector(frame.u, bend.x)
    .addScaledVector(frame.v, bend.y);
}

export function bendFromFramePoint(frame, point) {
  const offset = point.clone().sub(frame.origin);
  return new THREE.Vector2(offset.dot(frame.u), offset.dot(frame.v));
}

export function getQuadraticControlPoint(start, midpoint, end) {
  return midpoint
    .clone()
    .multiplyScalar(2)
    .sub(start.clone().multiplyScalar(0.5))
    .sub(end.clone().multiplyScalar(0.5));
}

export function evaluateQuadraticBezier(start, control, end, t) {
  const inverse = 1 - t;
  return start
    .clone()
    .multiplyScalar(inverse * inverse)
    .addScaledVector(control, 2 * inverse * t)
    .addScaledVector(end, t * t);
}

export function evaluateBiquadraticBezierPatch(controlNet, u, v) {
  const bu = [(1 - u) ** 2, 2 * (1 - u) * u, u ** 2];
  const bv = [(1 - v) ** 2, 2 * (1 - v) * v, v ** 2];
  const point = new THREE.Vector3();

  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      point.addScaledVector(controlNet[row][column], bv[row] * bu[column]);
    }
  }

  return point;
}

export function squareToTriangularBarycentric(u, v) {
  return {
    a: 1 - u,
    b: u * (1 - v),
    c: u * v,
  };
}

export function elevateQuadraticBezierToCubic(start, control, end) {
  return [
    start.clone(),
    start.clone().multiplyScalar(1 / 3).addScaledVector(control, 2 / 3),
    control.clone().multiplyScalar(2 / 3).addScaledVector(end, 1 / 3),
    end.clone(),
  ];
}

export function evaluateTriangularCubicBezierPatch(controlNet, { a, b, c }) {
  return new THREE.Vector3()
    .addScaledVector(controlNet[3][0][0], a ** 3)
    .addScaledVector(controlNet[2][1][0], 3 * a ** 2 * b)
    .addScaledVector(controlNet[1][2][0], 3 * a * b ** 2)
    .addScaledVector(controlNet[0][3][0], b ** 3)
    .addScaledVector(controlNet[2][0][1], 3 * a ** 2 * c)
    .addScaledVector(controlNet[1][0][2], 3 * a * c ** 2)
    .addScaledVector(controlNet[0][0][3], c ** 3)
    .addScaledVector(controlNet[0][2][1], 3 * b ** 2 * c)
    .addScaledVector(controlNet[0][1][2], 3 * b * c ** 2)
    .addScaledVector(controlNet[1][1][1], 6 * a * b * c);
}

export function cloneTriangularCubicControlNet(controlNet) {
  return controlNet.map((byB) =>
    byB.map((byC) =>
      byC.map((point) => point?.clone?.() ?? null),
    ),
  );
}

export function getTriangularCubicInteriorControlForSurfacePoint({
  controlNet,
  surfacePoint,
  barycentric,
}) {
  const { a, b, c } = barycentric;
  const interiorCoefficient = 6 * a * b * c;
  if (Math.abs(interiorCoefficient) < 1e-10) {
    return controlNet[1][1][1]?.clone?.() ?? surfacePoint.clone();
  }

  const fixedControlNet = cloneTriangularCubicControlNet(controlNet);
  fixedControlNet[1][1][1] = new THREE.Vector3();
  const fixedPoint = evaluateTriangularCubicBezierPatch(
    fixedControlNet,
    barycentric,
  );
  return surfacePoint.clone().sub(fixedPoint).multiplyScalar(1 / interiorCoefficient);
}

export function getBiquadraticInteriorControlForCenterPoint({
  start,
  firstControl,
  end,
  secondControl,
  centerPoint,
}) {
  return getBiquadraticInteriorControlForSurfacePoint({
    controlNet: [
      [start, firstControl, end],
      [start, new THREE.Vector3(), end],
      [start, secondControl, end],
    ],
    surfacePoint: centerPoint,
    u: 0.5,
    v: 0.5,
  });
}

export function getBiquadraticInteriorControlForSurfacePoint({
  controlNet,
  surfacePoint,
  u,
  v,
}) {
  const bu = [(1 - u) ** 2, 2 * (1 - u) * u, u ** 2];
  const bv = [(1 - v) ** 2, 2 * (1 - v) * v, v ** 2];
  const interiorCoefficient = bu[1] * bv[1];
  if (Math.abs(interiorCoefficient) < 1e-10) {
    return controlNet[1][1]?.clone?.() ?? surfacePoint.clone();
  }

  const fixedControlNet = controlNet.map((row, rowIndex) =>
    row.map((point, columnIndex) =>
      rowIndex === 1 && columnIndex === 1 ? new THREE.Vector3() : point,
    ),
  );
  const fixedPoint = evaluateBiquadraticBezierPatch(fixedControlNet, u, v);
  return surfacePoint.clone().sub(fixedPoint).multiplyScalar(1 / interiorCoefficient);
}

export function makeBiquadraticControlNetForCenterPoint({
  start,
  firstControl,
  end,
  secondControl,
  centerPoint,
}) {
  const controlNet = [
    [start, firstControl, end],
    [start, new THREE.Vector3(), end],
    [start, secondControl, end],
  ];
  controlNet[1][1] = getBiquadraticInteriorControlForSurfacePoint({
    controlNet,
    surfacePoint: centerPoint,
    u: 0.5,
    v: 0.5,
  });
  return controlNet;
}
