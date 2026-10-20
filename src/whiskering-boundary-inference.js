import { FinitePresheaf } from "./presheaf.js";
import { THETA_FACE_CATEGORY } from "./golog-presheaf.js";
import { CORE_THETA_SCHEMA_ID, DEFAULT_MATH_SCHEMA_REGISTRY }
  from "./mathematical-schema-registry.js";

const schema = DEFAULT_MATH_SCHEMA_REGISTRY.schema(CORE_THETA_SCHEMA_ID);
const shapeAt = (index) => schema.objects.find((shape) => shape.thetaIndex === index).id;
const edgeShape = shapeAt(1), twoCellShape = shapeAt(2), triangleShape = shapeAt(5);
const whiskeringShapes = [
  { thetaIndex: 6, inputFace: 12, outputFace: 29, sourceFace: 14, targetFace: 13, before: true },
  { thetaIndex: 7, inputFace: 15, outputFace: 30, sourceFace: 17, targetFace: 16, before: false },
];
const face = (index) => `theta3:face:${index}`;
const result = (status, reason, candidates = []) => ({ status, reason, candidates,
  ...(status === "matched" ? { match: candidates[0] } : {}) });

// The two selected bigons keep their stored source (face 3) and target (face 2).
// The shortcut proposes new triangular witnesses, never an equality of arrows
// or an arbitrary reuse of an existing triangle with the same boundary.
export function inferWhiskeringBoundary(presheaf, selection = {}) {
  if (presheaf?.category !== THETA_FACE_CATEGORY || !selection ||
      typeof selection !== "object" || Array.isArray(selection)) {
    return result("invalid", "unsupported-selection");
  }
  const { inputId, edgeId, outputId } = selection;
  const ids = [inputId, edgeId, outputId].filter((id) => id !== undefined);
  if (ids.some((id) => typeof id !== "string" || !id) || new Set(ids).size !== ids.length) {
    return result("invalid", "invalid-whiskering-selection");
  }
  const selected = {};
  try {
    for (const [key, id, shape] of [["input", inputId, twoCellShape],
      ["edge", edgeId, edgeShape], ["output", outputId, twoCellShape]]) {
      if (id === undefined) continue;
      const element = presheaf.get(id);
      if (element.shape !== shape) return result("invalid", "unexpected-boundary-type");
      selected[key] = element;
    }
  } catch {
    return result("invalid", "unknown-boundary-element");
  }
  if (ids.length < 3) return result("incomplete", "missing-whiskering-boundary");

  const sourceEdges = [selected.input.faces[face(3)], selected.output.faces[face(3)]];
  const targetEdges = [selected.input.faces[face(2)], selected.output.faces[face(2)]];
  const edges = [edgeId, ...sourceEdges, ...targetEdges];
  // Native browser triangles require three distinct vertices and edges. The
  // kernel itself permits repeated restrictions and loops; this shortcut does not.
  if (new Set(edges).size !== 5 || edges.some((id) => {
    const edge = presheaf.get(id);
    return edge.faces[face(0)] === edge.faces[face(1)];
  })) return result("invalid", "unsupported-degenerate-boundary");

  const closure = new Map();
  const visit = (element) => {
    if (closure.has(element.id)) return;
    closure.set(element.id, element);
    for (const id of Object.values(element.faces)) visit(presheaf.get(id));
  };
  Object.values(selected).forEach(visit);
  const freshId = (name) => {
    let id = `whiskering-candidate-${name}`;
    while (closure.has(id)) id += "-";
    return id;
  };
  const sourceId = freshId("source"), targetId = freshId("target"), volumeId = freshId("volume");
  const candidates = [];
  for (const shape of whiskeringShapes) {
    const triangles = [["source", shape.sourceFace, sourceEdges], ["target", shape.targetFace, targetEdges]]
      .map(([role, faceIndex, [inputEdgeId, outputEdgeId]]) => ({ role, faceId: face(faceIndex),
        edgeIds: shape.before ? [edgeId, inputEdgeId, outputEdgeId] : [inputEdgeId, edgeId, outputEdgeId] }));
    const faces = { [face(shape.inputFace)]: inputId, [face(shape.outputFace)]: outputId };
    const triangleElements = triangles.map(({ role, faceId, edgeIds: [first, second, composite] }) => {
      const id = role === "source" ? sourceId : targetId;
      faces[faceId] = id;
      return { id, shape: triangleShape, faces: { [face(9)]: second, [face(10)]: composite, [face(11)]: first } };
    });
    try {
      new FinitePresheaf(THETA_FACE_CATEGORY, [...closure.values(), ...triangleElements,
        { id: volumeId, shape: shapeAt(shape.thetaIndex), faces }]);
    } catch {
      continue;
    }
    candidates.push({ thetaIndex: shape.thetaIndex, shapeId: shapeAt(shape.thetaIndex),
      faces: { [face(shape.inputFace)]: inputId, [face(shape.outputFace)]: outputId }, triangles });
  }
  if (candidates.length > 1) return result("ambiguous", "multiple-whiskering-bindings", candidates);
  return candidates.length ? result("matched", "exact-whiskering-boundary", candidates)
    : result("invalid", "incompatible-whiskering-boundary");
}
