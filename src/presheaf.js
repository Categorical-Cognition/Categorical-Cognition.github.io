// A category presented by generators and path equations. Paths run source to
// target; their presheaf action runs backwards. The empty path is the identity.
// No path enumeration, renderer, transport, or geometric tolerance is involved.
function identifier(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a nonempty string`);
  }
  return value;
}

function indexed(records, label) {
  const index = new Map();
  for (const record of records) {
    const id = identifier(record.id, `${label} id`);
    if (index.has(id)) throw new Error(`Duplicate ${label}: ${id}`);
    index.set(id, record);
  }
  return index;
}

export class PresentedCategory {
  #objects;
  #arrows;
  #incoming;

  constructor({ id, objects, arrows = [], equations = [] }) {
    this.id = identifier(id, "Category id");
    this.objects = Object.freeze(objects.map((object) =>
      identifier(typeof object === "string" ? object : object.id, "Object id")));
    this.#objects = indexed(this.objects.map((id) => ({ id })), "object");
    this.arrows = Object.freeze(arrows.map(({ id, source, target }) =>
      Object.freeze({ id, source, target })));
    this.#arrows = indexed(this.arrows, "arrow");
    this.#incoming = new Map(this.objects.map((id) => [id, []]));
    for (const arrow of this.arrows) {
      this.object(arrow.source);
      this.object(arrow.target);
      this.#incoming.get(arrow.target).push(arrow);
    }
    for (const arrows of this.#incoming.values()) Object.freeze(arrows);
    this.equations = Object.freeze(equations.map((equation, index) => {
      if (!Array.isArray(equation.left) || !Array.isArray(equation.right)) {
        throw new Error(`Equation paths must be arrays: ${index}`);
      }
      const left = Object.freeze([...equation.left]);
      const right = Object.freeze([...equation.right]);
      const source = equation.source ?? this.arrow(left[0] ?? right[0]).source;
      const a = this.path(left, source);
      const b = this.path(right, source);
      if (a.target !== b.target) throw new Error(`Nonparallel equation: ${index}`);
      return Object.freeze({ id: equation.id ?? `equation:${index}`, source,
        target: a.target, left, right });
    }));
    Object.freeze(this);
  }

  object(id) {
    if (!this.#objects.has(id)) throw new Error(`Unknown shape: ${id}`);
    return id;
  }

  arrow(id) {
    const arrow = this.#arrows.get(id);
    if (!arrow) throw new Error(`Unknown arrow: ${id}`);
    return arrow;
  }

  incoming(shape) { return this.#incoming.get(this.object(shape)); }

  path(path, source) {
    if (!Array.isArray(path)) throw new Error("A path must be an array of arrow ids");
    this.object(source);
    let target = source;
    for (const id of path) {
      const arrow = this.arrow(id);
      if (arrow.source !== target) throw new Error(`Noncomposable path at ${id}`);
      target = arrow.target;
    }
    return { source, target };
  }

  toJSON() {
    return { id: this.id, objects: this.objects, arrows: this.arrows,
      equations: this.equations };
  }
}

// Finite sets over a presented (possibly infinite) category. Global element ids
// name elements of the disjoint union of the sets. Equations on generators are
// sufficient: evaluation extends to paths and respects the presented congruence.
export class FinitePresheaf {
  #elements;
  #sets;
  #cofaces;

  constructor(category, elements = []) {
    if (!(category instanceof PresentedCategory)) throw new Error("Expected a presented category");
    this.category = category;
    this.#elements = indexed(elements.map(({ id, shape, faces = {} }) =>
      Object.freeze({ id, shape, faces: Object.freeze({ ...faces }) })), "element");
    this.#sets = new Map(category.objects.map((shape) => [shape, []]));
    this.#cofaces = new Map([...this.#elements.keys()].map((id) => [id, new Set()]));
    for (const element of this.#elements.values()) {
      category.object(element.shape);
      this.#sets.get(element.shape).push(element);
      const incoming = category.incoming(element.shape);
      for (const key of Object.keys(element.faces)) {
        if (category.arrow(key).target !== element.shape) {
          throw new Error(`Unexpected restriction ${key} on ${element.id}`);
        }
      }
      for (const arrow of incoming) {
        const face = this.#elements.get(element.faces[arrow.id]);
        if (!face || face.shape !== arrow.source) {
          throw new Error(`Invalid restriction ${element.id}[${arrow.id}]: expected ${arrow.source}`);
        }
        this.#cofaces.get(face.id).add(element.id);
      }
    }
    for (const equation of category.equations) {
      for (const element of this.#sets.get(equation.target)) {
        const left = this.restrict(element.id, equation.left);
        const right = this.restrict(element.id, equation.right);
        if (left.id !== right.id) {
          throw new Error(`Restriction equation ${equation.id} fails on ${element.id}: ${left.id} != ${right.id}`);
        }
      }
    }
    for (const set of this.#sets.values()) Object.freeze(set);
    Object.freeze(this);
  }

  get(id) {
    const element = this.#elements.get(id);
    if (!element) throw new Error(`Unknown element: ${id}`);
    return element;
  }

  at(shape) { return this.#sets.get(this.category.object(shape)); }

  restrict(id, path = []) {
    if (!Array.isArray(path)) throw new Error("A path must be an array of arrow ids");
    let element = this.get(id);
    for (let i = path.length - 1; i >= 0; i--) {
      const arrow = this.category.arrow(path[i]);
      if (element.shape !== arrow.target) throw new Error(`Restriction path is not typed at ${arrow.id}`);
      element = this.get(element.faces[arrow.id]);
    }
    return element;
  }

  // The result includes the seeds. Reverse incidence makes this linear in the
  // visited support closure, including loops, repeated faces, and higher cells.
  support(ids) {
    const queue = [...new Set(ids)];
    const parents = new Map(queue.map((id) => [this.get(id).id, null]));
    for (let i = 0; i < queue.length; i++) {
      for (const id of this.#cofaces.get(queue[i])) {
        if (!parents.has(id)) {
          parents.set(id, queue[i]);
          queue.push(id);
        }
      }
    }
    return queue.map((id) => ({ id, supportedBy: parents.get(id) }));
  }

  withElements(elements) {
    const replacements = indexed(elements, "replacement element");
    return new FinitePresheaf(this.category, [
      ...[...this.#elements.values()].filter((e) => !replacements.has(e.id)),
      ...replacements.values(),
    ]);
  }

  withoutElements(ids, { cascade = false } = {}) {
    const requested = new Set(ids);
    const support = this.support(ids);
    if (!cascade && support.some(({ id }) => !requested.has(id))) {
      throw new Error("Deletion would leave dependent elements; include the support closure or use cascade");
    }
    const removed = new Set(support.map(({ id }) => id));
    return new FinitePresheaf(this.category,
      [...this.#elements.values()].filter(({ id }) => !removed.has(id)));
  }

  toJSON() {
    return { format: "golog.finite-presheaf", version: 1,
      category: this.category.toJSON(), elements: [...this.#elements.values()] };
  }
}

// A natural transformation is a typed function on elements commuting with
// every generating restriction. Requiring the same category instance avoids
// silently identifying two different presentations that happen to share an id.
export function naturalTransformation(source, target, mapping) {
  if (source.category !== target.category) throw new Error("Presheaves must share their category");
  const map = new Map(Object.entries(mapping));
  let count = 0;
  for (const shape of source.category.objects) {
    for (const element of source.at(shape)) {
      count++;
      const image = target.get(map.get(element.id));
      if (image.shape !== shape) throw new Error(`Transformation changes shape at ${element.id}`);
      for (const arrow of source.category.incoming(shape)) {
        if (map.get(element.faces[arrow.id]) !== image.faces[arrow.id]) {
          throw new Error(`Naturality fails at ${element.id}[${arrow.id}]`);
        }
      }
    }
  }
  if (map.size !== count) throw new Error("Transformation contains unknown elements");
  return Object.freeze(Object.fromEntries(map));
}
