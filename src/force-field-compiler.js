export const FORCE_FIELD_FORMAT = "golog.compiled-force-field";
export const FORCE_FIELD_VERSION = 1;

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function cloneValue(value) {
  if (value?.clone) {
    return value.clone();
  }
  if (Array.isArray(value)) {
    return value.map((entry) => cloneValue(entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cloneValue(entry)]),
    );
  }
  return value;
}

function sourceDeclarations(sourceSetOrDeclarations) {
  return Array.isArray(sourceSetOrDeclarations)
    ? sourceSetOrDeclarations
    : sourceSetOrDeclarations?.declarations ?? [];
}

export function compileForceField(sourceSetOrDeclarations, options = {}) {
  const declarations = sourceDeclarations(sourceSetOrDeclarations);
  const bodies = [];
  const springs = [];
  const manyBodyFields = [];
  const centerFields = [];
  const higherConstraints = [];
  const twoSimplexBarycenterFields = [];
  const customSources = [];

  for (const source of declarations) {
    if (source.kind === "body") {
      bodies.push({
        id: source.targetId ?? source.objectId,
        objectId: source.objectId ?? source.targetId,
        mass: finiteNumber(source.mass, 1),
        chargeScale: finiteNumber(source.chargeScale, source.mass ?? 1),
        centerScale: finiteNumber(source.centerScale, source.mass ?? 1),
        pinned: Boolean(source.pinned),
        position: cloneValue(source.position),
      });
      continue;
    }

    if (source.kind === "spring") {
      springs.push({
        id: source.id,
        objectId: source.objectId,
        sourceId: source.sourceId,
        targetId: source.targetId,
        restLength: finiteNumber(source.restLength, 1),
        strength: finiteNumber(source.strength, 0),
      });
      continue;
    }

    if (source.kind === "many-body") {
      manyBodyFields.push({
        id: source.id,
        targetIds: source.targetIds ? [...source.targetIds] : null,
        strength: finiteNumber(source.strength, 0),
        minDistance: finiteNumber(source.minDistance, 0.35),
        chargeScales: cloneValue(source.chargeScales ?? {}),
        approximation:
          options.chargeApproximation ?? source.approximation ?? "pairwise",
        cellSize: finiteNumber(options.chargeCellSize ?? source.cellSize, 6),
        nearCellRadius: finiteNumber(
          options.chargeNearCellRadius ?? source.nearCellRadius,
          1,
        ),
      });
      continue;
    }

    if (source.kind === "center") {
      centerFields.push({
        id: source.id,
        targetIds: source.targetIds ? [...source.targetIds] : null,
        center: cloneValue(source.center ?? [0, 0, 0]),
        strength: finiteNumber(source.strength, 0),
        centerScales: cloneValue(source.centerScales ?? {}),
      });
      continue;
    }

    if (source.kind === "higher-constraint") {
      higherConstraints.push({
        id: source.id,
        objectId: source.objectId,
        constraintType: source.constraintType,
        edgeIds: [...(source.edgeIds ?? [])],
        nodeIds: source.nodeIds ? [...source.nodeIds] : null,
        strength: finiteNumber(source.strength, 0),
      });
      continue;
    }

    if (source.kind === "two-simplex-barycenter") {
      twoSimplexBarycenterFields.push({
        id: source.id,
        objectId: source.objectId,
        nodeIds: [...(source.nodeIds ?? [])],
        edgeIds: [...(source.edgeIds ?? [])],
        targetIds: [...(source.targetIds ?? [])],
        nodeStrength: finiteNumber(source.nodeStrength, 0),
        edgeStrength: finiteNumber(source.edgeStrength, 0),
      });
      continue;
    }

    customSources.push(cloneValue(source));
  }

  return {
    format: FORCE_FIELD_FORMAT,
    version: FORCE_FIELD_VERSION,
    gologId: sourceSetOrDeclarations?.gologId ?? options.gologId ?? null,
    sourceCount: declarations.length,
    bodies,
    springs,
    manyBodyFields,
    centerFields,
    higherConstraints,
    twoSimplexBarycenterFields,
    customSources,
    statistics: {
      bodyCount: bodies.length,
      springCount: springs.length,
      manyBodyFieldCount: manyBodyFields.length,
      centerFieldCount: centerFields.length,
      higherConstraintCount: higherConstraints.length,
      twoSimplexBarycenterFieldCount: twoSimplexBarycenterFields.length,
      customSourceCount: customSources.length,
    },
  };
}

export function forceSpecsFromCompiledField(field) {
  return [
    ...(field?.springs ?? []).map((spring) => ({
      kind: "spring",
      sourceId: spring.sourceId,
      targetId: spring.targetId,
      restLength: spring.restLength,
      strength: spring.strength,
      source: spring.objectId ?? spring.id,
    })),
    ...(field?.manyBodyFields ?? []).map((manyBody) => ({
      kind:
        manyBody.approximation === "spatial-hash" ? "spatial-charge" : "charge",
      strength: manyBody.strength,
      minDistance: manyBody.minDistance,
      targetIds: manyBody.targetIds,
      chargeScales: manyBody.chargeScales,
      cellSize: manyBody.cellSize,
      nearCellRadius: manyBody.nearCellRadius,
      source: manyBody.id,
    })),
    ...(field?.centerFields ?? []).map((center) => ({
      kind: "center",
      center: center.center,
      strength: center.strength,
      targetIds: center.targetIds,
      centerScales: center.centerScales,
      source: center.id,
    })),
    ...(field?.twoSimplexBarycenterFields ?? []).map((simplex) => ({
      kind: "two-simplex-barycenter",
      id: simplex.id,
      objectId: simplex.objectId,
      nodeIds: simplex.nodeIds,
      edgeIds: simplex.edgeIds,
      targetIds: simplex.targetIds,
      nodeStrength: simplex.nodeStrength,
      edgeStrength: simplex.edgeStrength,
      source: simplex.id,
    })),
    ...(field?.customSources ?? []),
  ];
}
