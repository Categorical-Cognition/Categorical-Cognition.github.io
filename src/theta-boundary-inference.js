import { FinitePresheaf } from "./presheaf.js";
import { THETA_FACE_CATEGORY, withCompletedThetaElements } from "./golog-presheaf.js";
import { CORE_THETA_SCHEMA_ID, DEFAULT_MATH_SCHEMA_REGISTRY }
  from "./mathematical-schema-registry.js";

const schema = DEFAULT_MATH_SCHEMA_REGISTRY.schema(CORE_THETA_SCHEMA_ID);
const surfaceShapes = new Set(schema.objects.filter((shape) => shape.dimension === 2)
  .map((shape) => shape.id));
const volumeShapes = schema.objects.filter((shape) => shape.elementKind === "theta-volume")
  .map((shape) => ({
    thetaIndex: shape.thetaIndex,
    shapeId: shape.id,
    roles: shape.graphics.graphicalBoundary ?? shape.boundary,
    equations: THETA_FACE_CATEGORY.equations.filter((equation) => equation.target === shape.id),
  }));
const maximumFaceCount = Math.max(...volumeShapes.map((shape) => shape.roles.length));

function consistentAssignment(presheaf, faces, equations) {
  const restrict = (path) => {
    const face = faces[path.at(-1)];
    return face === undefined ? undefined : presheaf.restrict(face, path.slice(0, -1)).id;
  };
  return equations.every((equation) => {
    const left = restrict(equation.left), right = restrict(equation.right);
    return left === undefined || right === undefined || left === right;
  });
}

// Selection order only chooses the orientation of a globe between two parallel
// bigons: first is source (face 5), second is target (face 4). Every other shell
// must have a unique exact binding, independently of selection order. A Set is
// unordered and therefore leaves even the globe's two orientations ambiguous.
// Incomplete means no contradiction is yet known, not a promise of a filler.
export function inferThetaVolumeBoundary(presheaf, selectedSurfaceIds) {
  const result = (status, reason, candidates = []) => ({ status, reason, candidates,
    ...(status === "matched" ? { match: candidates[0] } : {}) });
  const ordered = Array.isArray(selectedSurfaceIds);
  if ((!ordered && !(selectedSurfaceIds instanceof Set)) ||
      presheaf?.category !== THETA_FACE_CATEGORY) {
    return result("invalid", "unsupported-selection");
  }
  const ids = [...selectedSurfaceIds];
  if (ids.length > maximumFaceCount || new Set(ids).size !== ids.length ||
      ids.some((id) => typeof id !== "string" || !id)) {
    return result("invalid", "invalid-surface-selection");
  }
  if (!ids.length) return result("incomplete", "missing-boundary-faces");
  let selected;
  try {
    selected = ids.map((id) => presheaf.get(id));
  } catch {
    return result("invalid", "unknown-surface");
  }
  if (selected.some((element) => !surfaceShapes.has(element.shape))) {
    return result("invalid", "expected-surface");
  }

  // Exact validation only needs the selected downward closure. Unrelated
  // workspace elements and existing volumes do not participate in inference.
  const closure = new Map();
  const visit = (element) => {
    if (closure.has(element.id)) return;
    closure.set(element.id, element);
    for (const id of Object.values(element.faces)) visit(presheaf.get(id));
  };
  selected.forEach(visit);
  const boundary = new FinitePresheaf(THETA_FACE_CATEGORY, [...closure.values()]);
  let candidateId = "theta-boundary-candidate";
  while (closure.has(candidateId)) candidateId += "-";
  const candidates = [];
  let incomplete = false;
  for (const shape of volumeShapes) {
    if (shape.roles.length < selected.length) continue;
    const full = shape.roles.length === selected.length;
    const faces = {};
    const assign = (index) => {
      if (index === selected.length) {
        if (!full) {
          incomplete = true;
          return true;
        }
        // The horizontal shell also requires the registry's exact free
        // restriction completion; local face comparisons alone are insufficient.
        try {
          withCompletedThetaElements(boundary, [{ id: candidateId, shape: shape.shapeId, faces }]);
        } catch {
          return false;
        }
        candidates.push({ thetaIndex: shape.thetaIndex, shapeId: shape.shapeId, faces: { ...faces } });
        return candidates.length === 2;
      }
      const element = selected[index];
      for (const role of shape.roles) {
        if (faces[role.id] !== undefined || role.sourceObjectId !== element.shape) continue;
        if (ordered && shape.thetaIndex === 3 &&
            role.id !== `theta3:face:${index === 0 ? 5 : 4}`) continue;
        faces[role.id] = element.id;
        const stop = consistentAssignment(boundary, faces, shape.equations) && assign(index + 1);
        delete faces[role.id];
        if (stop) return true;
      }
      return false;
    };
    assign(0);
    if (candidates.length === 2) return result("ambiguous", "multiple-boundary-bindings", candidates);
  }
  if (candidates.length === 1) return result("matched", "exact-boundary", candidates);
  return incomplete ? result("incomplete", "missing-boundary-faces")
    : result("invalid", "incompatible-boundary-faces");
}
