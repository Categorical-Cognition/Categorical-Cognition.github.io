import { FinitePresheaf, PresentedCategory } from "./presheaf.js";
import { completeHorizontalThetaRestrictions } from "./theta-restriction-completion.js";
import { DEFAULT_MATH_SCHEMA_REGISTRY, CORE_THETA_SCHEMA_ID,
  CORE_THETA_STRUCTURE_ID } from "./mathematical-schema-registry.js";
import { VIRTUAL_DOUBLE_CATEGORY_STRUCTURE_ID, VIRTUAL_DOUBLE_ELEMENT_KINDS as V }
  from "./virtual-double-category-schema.js";

const theta = DEFAULT_MATH_SCHEMA_REGISTRY.schema(CORE_THETA_SCHEMA_ID);
export const THETA_FACE_CATEGORY = new PresentedCategory({
  id: `${theta.id}:faces`,
  objects: theta.objects,
  arrows: theta.generatingFaceMorphisms.map((f) => ({
    id: f.id, source: f.sourceObjectId, target: f.targetObjectId,
  })),
  equations: theta.faceCompositionRelations.map((r) => ({
    id: r.id,
    left: r.leftPath.map((i) => theta.generatingFaceMorphisms[i].id),
    right: r.rightPath.map((i) => theta.generatingFaceMorphisms[i].id),
  })),
});

export function withCompletedThetaElements(presheaf, elements) {
  const replacements = new Map(elements.map((element) => [element.id, element]));
  return new FinitePresheaf(THETA_FACE_CATEGORY, completeHorizontalThetaRestrictions(
    THETA_FACE_CATEGORY, [
      ...presheaf.toJSON().elements.filter((element) => !replacements.has(element.id)),
      ...replacements.values(),
    ],
  ));
}

function thetaElement(element) {
  const shape = DEFAULT_MATH_SCHEMA_REGISTRY.objectForElementKind(
    element.elementKind, element.schemaRef?.objectId,
  )?.id;
  const boundary = element.boundary ?? {};
  if (element.elementKind === "theta-volume") {
    return { id: element.id, shape, faces: { ...boundary.faces } };
  }
  const edges = boundary.edgeIds ?? [];
  const targets = {
    "0-simplex": [],
    "1-simplex": [boundary.targetId, boundary.sourceId],
    "2-cell": [edges[1], edges[0]],
    "2-simplex": [edges[1], edges[2], edges[0]],
  }[element.elementKind];
  if (!targets || (element.dimension >= 2 && edges.length !== targets.length)) {
    throw new Error(`Invalid element boundary: ${element.id}`);
  }
  return { id: element.id, shape, faces: Object.fromEntries(
    THETA_FACE_CATEGORY.incoming(shape).map((f, i) => [f.id, targets[i]])) };
}

// A virtual cell has one shape for each nonempty top-path arity. This is a
// presentation of its boundary data, not a claim of composition or units.
function virtualPresentation(elements) {
  const objects = [V.OBJECT, V.TIGHT_ARROW, V.PROARROW];
  const arrows = [];
  const equations = [];
  const add = (id, source, target) => arrows.push({ id, source, target });
  for (const kind of [V.TIGHT_ARROW, V.PROARROW]) {
    for (const end of ["source", "target"]) add(`${kind}:${end}`, V.OBJECT, kind);
  }
  const arities = [...new Set(elements.filter((e) => e.elementKind === V.CELL)
    .map((e) => e.boundary?.topPathIds?.length ?? 0))].sort((a, b) => a - b);
  for (const n of arities) {
    if (n < 1) throw new Error("Virtual cells require a nonempty top path");
    const shape = `${V.CELL}:${n}`;
    objects.push(shape);
    const face = (role) => `${shape}:${role}`;
    for (let i = 0; i < n; i++) add(face(`top:${i}`), V.PROARROW, shape);
    add(face("bottom"), V.PROARROW, shape);
    add(face("left"), V.TIGHT_ARROW, shape);
    add(face("right"), V.TIGHT_ARROW, shape);
    const path = (role, end) => [
      `${role === "left" || role === "right" ? V.TIGHT_ARROW : V.PROARROW}:${end}`, face(role),
    ];
    const equal = (a, b) => equations.push({ left: a, right: b });
    equal(path("top:0", "source"), path("left", "source"));
    equal(path(`top:${n - 1}`, "target"), path("right", "source"));
    equal(path("bottom", "source"), path("left", "target"));
    equal(path("bottom", "target"), path("right", "target"));
    for (let i = 1; i < n; i++) equal(path(`top:${i - 1}`, "target"), path(`top:${i}`, "source"));
  }
  const category = new PresentedCategory({ id: `${VIRTUAL_DOUBLE_CATEGORY_STRUCTURE_ID}:boundaries`,
    objects, arrows, equations });
  return new FinitePresheaf(category, elements.map((e) => {
    const b = e.boundary ?? {};
    const shape = e.elementKind === V.CELL ? `${V.CELL}:${b.topPathIds.length}` : e.elementKind;
    const values = e.elementKind === V.CELL
      ? [...b.topPathIds, b.bottomArrowId, b.leftArrowId, b.rightArrowId]
      : [b.sourceId, b.targetId];
    return { id: e.id, shape, faces: Object.fromEntries(
      category.incoming(shape).map((f, i) => [f.id, values[i]])) };
  }));
}

export function presheafFromElements(structureId, elements) {
  if (structureId === CORE_THETA_STRUCTURE_ID) {
    return new FinitePresheaf(THETA_FACE_CATEGORY,
      completeHorizontalThetaRestrictions(THETA_FACE_CATEGORY, elements.map(thetaElement)));
  }
  if (structureId === VIRTUAL_DOUBLE_CATEGORY_STRUCTURE_ID) return virtualPresentation(elements);
  throw new Error(`No presheaf boundary adapter for structure: ${structureId}`);
}
