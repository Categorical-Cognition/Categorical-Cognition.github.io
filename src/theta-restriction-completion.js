// Horizontal composition is displayed using a selected spherical subcomplex
// of its representable boundary. Freely adjoin the remaining restrictions,
// imposing the category equations and the supplied faces. This is the finite
// pushout X <- S -> y(T): distinct supplied elements are never identified.
// The resulting terms belong to the immutable snapshot, not a second store.
export const HORIZONTAL_THETA_SHAPE = "theta3:o8";
export const HORIZONTAL_SHELL_FACE_IDS = Object.freeze(
  [20, 18, 19, 24, 21].map((index) => `theta3:face:${index}`),
);

export function completeHorizontalThetaRestrictions(category, elements) {
  if (!elements.some((element) => element.shape === HORIZONTAL_THETA_SHAPE)) return elements;
  const records = new Map();
  const parents = new Map();
  const native = new Set(elements.map((element) => element.id));
  const root = (id) => {
    if (!parents.has(id)) throw new Error(`Invalid restriction: missing element ${id}`);
    let current = id;
    while (parents.get(current) !== current) current = parents.get(current);
    while (parents.get(id) !== id) {
      const next = parents.get(id);
      parents.set(id, current);
      id = next;
    }
    return current;
  };
  for (const element of elements) {
    if (records.has(element.id)) throw new Error(`Duplicate element: ${element.id}`);
    category.object(element.shape);
    records.set(element.id, { ...element, faces: { ...element.faces } });
    parents.set(element.id, element.id);
  }
  // Explicit references must be stored elements. Private completion terms
  // cannot become independently mutable boundaries of another store record.
  for (const element of records.values()) {
    for (const [arrowId, faceId] of Object.entries(element.faces)) {
      const arrow = category.arrow(arrowId);
      if (arrow.target !== element.shape) throw new Error(`Unexpected restriction ${arrowId} on ${element.id}`);
      if (records.get(faceId)?.shape !== arrow.source) {
        throw new Error(`Invalid restriction ${element.id}[${arrowId}]: expected ${arrow.source}`);
      }
    }
    const required = element.shape === HORIZONTAL_THETA_SHAPE
      ? HORIZONTAL_SHELL_FACE_IDS : category.incoming(element.shape).map((arrow) => arrow.id);
    for (const arrowId of required) {
      if (!element.faces[arrowId]) throw new Error(`Invalid restriction ${element.id}[${arrowId}]: required boundary face`);
    }
  }
  const fresh = (ownerId, path, shape, ancestors = []) => {
    if (ancestors.includes(shape)) throw new Error("Theta restriction completion requires an acyclic face category");
    const id = `theta-restriction:${encodeURIComponent(ownerId)}:${path.map(encodeURIComponent).join("/")}`;
    if (records.has(id)) throw new Error(`Restriction term id collision: ${id}`);
    const element = { id, shape, faces: {} };
    records.set(id, element);
    parents.set(id, id);
    for (const arrow of category.incoming(shape)) {
      element.faces[arrow.id] = fresh(ownerId, [...path, arrow.id], arrow.source, [...ancestors, shape]);
    }
    return id;
  };
  for (const element of elements.filter((entry) => entry.shape === HORIZONTAL_THETA_SHAPE)) {
    const record = records.get(element.id);
    for (const arrow of category.incoming(record.shape)) {
      if (!record.faces[arrow.id]) record.faces[arrow.id] = fresh(record.id, [arrow.id], arrow.source);
    }
  }
  const restrict = (id, path) => {
    for (let i = path.length - 1; i >= 0; i--) {
      id = records.get(root(id)).faces[path[i]];
    }
    return root(id);
  };
  const merge = (left, right, equation) => {
    const pending = [[left, right]];
    let changed = false;
    for (let i = 0; i < pending.length; i++) {
      let [a, b] = pending[i].map(root);
      if (a === b) continue;
      const first = records.get(a), second = records.get(b);
      if (first.shape !== second.shape) throw new Error(`Invalid restriction types in ${equation}`);
      if (native.has(a) && native.has(b)) {
        throw new Error(`Restriction equation ${equation} fails: ${a} != ${b}`);
      }
      if (native.has(b) || (!native.has(a) && b < a)) [a, b] = [b, a];
      parents.set(b, a);
      changed = true;
      for (const arrow of category.incoming(first.shape)) {
        pending.push([first.faces[arrow.id], second.faces[arrow.id]]);
      }
    }
    return changed;
  };
  let changed;
  do {
    changed = false;
    for (const equation of category.equations) {
      for (const element of records.values()) {
        if (root(element.id) !== element.id || element.shape !== equation.target) continue;
        changed = merge(restrict(element.id, equation.left), restrict(element.id, equation.right), equation.id) || changed;
      }
    }
  } while (changed);
  const completed = (element) => ({ id: element.id, shape: element.shape,
    faces: Object.fromEntries(Object.entries(element.faces).map(([arrow, id]) => [arrow, root(id)])) });
  return [
    ...elements.map((element) => completed(records.get(element.id))),
    ...[...records.values()].filter((element) => !native.has(element.id) && root(element.id) === element.id)
      .sort((a, b) => a.id.localeCompare(b.id)).map(completed),
  ];
}
