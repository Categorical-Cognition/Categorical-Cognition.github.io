import { VIRTUAL_DOUBLE_CATEGORY_SCHEMA } from "./virtual-double-category-schema.js";
import { HORIZONTAL_SHELL_FACE_IDS } from "./theta-restriction-completion.js";

export const MATH_SCHEMA_FORMAT = "golog.math-schema";
export const MATH_SCHEMA_VERSION = 1;

export const THETA_HANDLER_PACKAGE_FORMAT = "golog.theta-handler-package";
export const THETA_HANDLER_PACKAGE_VERSION = 1;

async function loadJsonArtifact(url) {
  if (url.protocol === "file:") {
    const { readFile } = await import("node:fs/promises");
    return JSON.parse(await readFile(url, "utf8"));
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Unable to load schema registry ${url}: ${response.status}`);
  }
  return response.json();
}

function cloneValue(value) {
  if (Array.isArray(value)) {
    return value.map(cloneValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cloneValue(entry)]),
    );
  }
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object") {
    return value;
  }
  for (const entry of Object.values(value)) {
    deepFreeze(entry);
  }
  return Object.freeze(value);
}

function normalizeKey(value) {
  return String(value ?? "").trim().toLowerCase();
}

const THETA3_SCHEMA_REGISTRY = deepFreeze(
  await loadJsonArtifact(new URL("../schemas/theta3-registry.json", import.meta.url)),
);
export const THETA3_GRAPHICS_MAPPING = deepFreeze(
  await loadJsonArtifact(new URL("../schemas/theta3-graphics-mapping.json", import.meta.url)),
);

export const CORE_THETA_SCHEMA_ID = THETA3_SCHEMA_REGISTRY.id;
export const CORE_THETA_STRUCTURE_ID = THETA3_SCHEMA_REGISTRY.structureId;
export const THETA3_OBJECTS = THETA3_SCHEMA_REGISTRY.objects;
export const THETA3_FACE_MORPHISMS = THETA3_SCHEMA_REGISTRY.faceMorphisms;
export const THETA3_FACE_COMPOSITION_RELATIONS =
  THETA3_SCHEMA_REGISTRY.faceCompositionRelations;

const CORE_THETA_LEVEL = THETA3_SCHEMA_REGISTRY.level ?? 3;
const CORE_THETA_ALIASES = THETA3_GRAPHICS_MAPPING.aliases ?? {};
const CORE_THETA_ELEMENT_KIND_BY_OBJECT_INDEX = new Map(
  (THETA3_GRAPHICS_MAPPING.elementKinds ?? []).map(([index, kind]) => [
    index,
    kind,
  ]),
);
const CORE_THETA_OBJECT_ID_BY_INDEX = new Map(
  (THETA3_GRAPHICS_MAPPING.objectIds ?? []).map(([index, id]) => [index, id]),
);

function thetaObjectRow(index) {
  const row = THETA3_OBJECTS[index];
  if (!row) {
    throw new Error(`Unknown theta object index: ${index}`);
  }
  return row;
}

function thetaObjectId(index) {
  return CORE_THETA_OBJECT_ID_BY_INDEX.get(index) ?? `theta3:o${index}`;
}

function thetaElementKind(index) {
  return CORE_THETA_ELEMENT_KIND_BY_OBJECT_INDEX.get(index) ??
    ([3, 4, 6, 7, 8, 9].includes(index) ? "theta-volume" : null);
}

function thetaObjectValueM(object) {
  return object[0];
}

function thetaObjectValueChildren(object) {
  return object.slice(1);
}

function thetaObjectValueNotation(object) {
  const m = thetaObjectValueM(object);
  const children = thetaObjectValueChildren(object);
  return children.length
    ? `[${m}](${children.map(thetaObjectValueNotation).join(",")})`
    : `[${m}]`;
}

export function thetaObjectNotation(index) {
  return thetaObjectValueNotation(thetaObjectRow(index));
}

function thetaObjectValueGraphicalDimension(object) {
  const m = thetaObjectValueM(object);
  const children = thetaObjectValueChildren(object);
  const childDimensions = children.map(thetaObjectValueGraphicalDimension);
  return m + Math.max(0, ...childDimensions);
}

export function thetaObjectGraphicalDimension(index) {
  return thetaObjectValueGraphicalDimension(thetaObjectRow(index));
}

function thetaObjectValueAdditiveDegree([m, ...children]) {
  return m + children.reduce((total, child) => total + thetaObjectValueAdditiveDegree(child), 0);
}

export function thetaObjectAdditiveDegree(index) {
  return thetaObjectValueAdditiveDegree(thetaObjectRow(index));
}

function thetaRenderKind(index) {
  return thetaGraphicsHandler(index).gologRenderKind;
}

function thetaGraphicsHandler(index) {
  const dimension = thetaObjectGraphicalDimension(index);
  if (dimension === 0) {
    return {
      entityKind: "sphere",
      geometryKind: "bezier-point",
      gologRenderKind: "sphere",
      boundaryKind: "none",
    };
  }
  if (dimension === 1) {
    return {
      entityKind: "bezier-curve",
      geometryKind: "quadratic-bezier-curve",
      gologRenderKind: "edge",
      boundaryKind: "endpoints",
      boundaryEntityKind: "sphere",
    };
  }
  if (dimension === 2) {
    return {
      entityKind: "bezier-surface",
      geometryKind: "bezier-surface",
      gologRenderKind: "surface",
      boundaryKind: "boundary-curves",
      boundaryEntityKind: "bezier-curve",
    };
  }
  if (dimension === 3) {
    return {
      entityKind: "convex-region",
      geometryKind: "convex-region-between-faces",
      gologRenderKind: "volume",
      boundaryKind: "boundary-surfaces",
      boundaryEntityKind: "bezier-surface",
    };
  }
  return {
    entityKind: "higher",
    geometryKind: "higher-dimensional-region",
    gologRenderKind: "higher",
    boundaryKind: "boundary",
  };
}

function faceSourceIndex(faceMorphism) {
  return Array.isArray(faceMorphism)
    ? faceMorphism[0]
    : faceMorphism.sourceIndex;
}

function faceTargetIndex(faceMorphism) {
  return Array.isArray(faceMorphism)
    ? faceMorphism[1]
    : faceMorphism.targetIndex;
}

function faceMorphismValue(faceMorphism) {
  if (Array.isArray(faceMorphism)) {
    return faceMorphism[2];
  }
  return faceMorphism.face ?? faceMorphism.morphism;
}

function faceMorphismId(faceMorphism, faceIndex) {
  return faceMorphism.id ?? `theta3:face:${faceIndex}`;
}

function thetaGraphicsBoundary(index, faceMorphisms = THETA3_FACE_MORPHISMS) {
  return faceMorphisms
    .map((faceMorphism, faceIndex) => {
      const sourceIndex = faceSourceIndex(faceMorphism);
      const targetIndex = faceTargetIndex(faceMorphism);
      const morphism = faceMorphismValue(faceMorphism);
      return {
        id: faceMorphismId(faceMorphism, faceIndex),
        faceIndex,
        sourceIndex,
        targetIndex,
        sourceObjectId: thetaObjectId(sourceIndex),
        sourceDimension: thetaObjectGraphicalDimension(sourceIndex),
        morphism: cloneValue(morphism),
        notation: faceMorphism.notation ?? thetaFaceNotation(morphism),
      };
    })
    .filter((face) => face.targetIndex === index);
}

function thetaGraphicsEntity(
  index,
  { faceMorphisms = THETA3_FACE_MORPHISMS } = {},
) {
  const handler = thetaGraphicsHandler(index);
  const boundary = thetaGraphicsBoundary(index, faceMorphisms);
  return {
    additiveDegree: thetaObjectAdditiveDegree(index),
    entityKind: handler.entityKind,
    geometryKind: handler.geometryKind,
    gologRenderKind: handler.gologRenderKind,
    boundaryKind: handler.boundaryKind,
    ...(handler.boundaryEntityKind
      ? { boundaryEntityKind: handler.boundaryEntityKind }
      : {}),
    boundary,
    ...(index === 8 ? {
      graphicalBoundary: HORIZONTAL_SHELL_FACE_IDS.map((id) => boundary.find((face) => face.id === id)),
      boundaryConvention: "horizontal-composition-shell",
    } : {}),
  };
}

export function thetaObjectGraphics(
  index,
  { faceMorphisms = THETA3_FACE_MORPHISMS } = {},
) {
  return deepFreeze(thetaGraphicsEntity(index, { faceMorphisms }));
}

function thetaPrimitiveFaceNotation([n, i, ...delta]) {
  if (i === -2) return `map_${delta.join("")}_${n}`;
  return i < 0 ? `id_${n}` : `F_${n}_${i}`;
}

export function thetaFaceNotation(face) {
  const [primitive, ...children] = face;
  const head = thetaPrimitiveFaceNotation(primitive);
  return children.length
    ? `[${head}](${children.map(thetaFaceNotation).join(",")})`
    : `[${head}]`;
}

function compileThetaFaceMorphisms() {
  return THETA3_FACE_MORPHISMS.map(
    ([sourceIndex, targetIndex, face], index) => ({
      id: `theta3:face:${index}`,
      sourceObjectId: thetaObjectId(sourceIndex),
      targetObjectId: thetaObjectId(targetIndex),
      sourceIndex,
      targetIndex,
      face: cloneValue(face),
      notation: thetaFaceNotation(face),
    }),
  );
}

function compileThetaFaceCompositionRelations(faceMorphisms) {
  return THETA3_FACE_COMPOSITION_RELATIONS.map(([leftPath, rightPath], index) => {
    const leftFaces = leftPath.map((faceIndex) => faceMorphisms[faceIndex]);
    const rightFaces = rightPath.map((faceIndex) => faceMorphisms[faceIndex]);
    const leftFirst = leftFaces[0];
    const leftLast = leftFaces[leftFaces.length - 1];
    const rightFirst = rightFaces[0];
    const rightLast = rightFaces[rightFaces.length - 1];
    return {
      id: `theta3:face-composition:${index}`,
      leftPath: cloneValue(leftPath),
      rightPath: cloneValue(rightPath),
      sourceIndex: leftFirst.sourceIndex,
      targetIndex: leftLast.targetIndex,
      sourceObjectId: leftFirst.sourceObjectId,
      targetObjectId: leftLast.targetObjectId,
      sourceNotation: thetaObjectNotation(leftFirst.sourceIndex),
      targetNotation: thetaObjectNotation(leftLast.targetIndex),
      leftNotation: leftFaces.map((face) => face.notation).join(" ; "),
      rightNotation: rightFaces.map((face) => face.notation).join(" ; "),
      consistent:
        leftFirst.sourceIndex === rightFirst.sourceIndex &&
        leftLast.targetIndex === rightLast.targetIndex,
    };
  });
}

function compileThetaFaceMorphismPackage(row, index) {
  const [sourceIndex, targetIndex, face] = row;
  return {
    id: `theta3:face:${index}`,
    sourceIndex,
    targetIndex,
    sourceObjectId: thetaObjectId(sourceIndex),
    targetObjectId: thetaObjectId(targetIndex),
    sourceNotation: thetaObjectNotation(sourceIndex),
    targetNotation: thetaObjectNotation(targetIndex),
    morphism: cloneValue(face),
    notation: thetaFaceNotation(face),
  };
}

export function thetaObjectHandlerPackage(
  index,
  {
    schemaId = CORE_THETA_SCHEMA_ID,
    structureId = CORE_THETA_STRUCTURE_ID,
    faceMorphisms = THETA3_FACE_MORPHISMS,
  } = {},
) {
  const objectValue = thetaObjectRow(index);
  const m = thetaObjectValueM(objectValue);
  const children = thetaObjectValueChildren(objectValue);
  const objectId = thetaObjectId(index);
  const elementKind = thetaElementKind(index);
  const dimension = thetaObjectGraphicalDimension(index);
  const graphics = thetaGraphicsEntity(index, { faceMorphisms });
  const faces = faceMorphisms
    .map(compileThetaFaceMorphismPackage)
    .filter((face) => face.targetIndex === index);
  const graphicalFaces = graphics.graphicalBoundary ?? faces;
  const boundaryObjectIds = [...new Set(graphicalFaces.map((face) => face.sourceObjectId))];
  const schemaRef = {
    schemaId,
    structureId,
    objectId,
    ...(elementKind ? { elementKind } : {}),
  };

  return deepFreeze({
    format: THETA_HANDLER_PACKAGE_FORMAT,
    version: THETA_HANDLER_PACKAGE_VERSION,
    schemaRef: cloneValue(schemaRef),
    registry: {
      object: cloneValue(objectValue),
      faces: faces.map((face) => ({
        sourceIndex: face.sourceIndex,
        targetIndex: face.targetIndex,
        morphism: cloneValue(face.morphism),
      })),
    },
    object: {
      id: objectId,
      thetaIndex: index,
      notation: thetaObjectNotation(index),
      level: CORE_THETA_LEVEL,
      m,
      childObjects: cloneValue(children),
      childNotations: children.map(thetaObjectValueNotation),
      dimension,
      graphicalDimension: dimension,
      additiveDegree: thetaObjectAdditiveDegree(index),
      renderKind: thetaRenderKind(index),
      graphics: cloneValue(graphics),
      ...(elementKind ? { elementKind } : {}),
    },
    boundary: faces,
    golog: {
      supportsCreation: Boolean(elementKind),
      createElementKind: elementKind,
      schemaRef: cloneValue(schemaRef),
      expectedFaceObjectIds: boundaryObjectIds,
      requiredFaceIds: graphicalFaces.map((face) => face.id),
      ...(index === 8 ? { restrictionCompletion: "free-presheaf-extension" } : {}),
    },
    renderer: {
      renderKind: thetaRenderKind(index),
      graphics: cloneValue(graphics),
      graphicalDimension: dimension,
      dimension,
      boundaryObjectIds,
      faceMorphisms: faces.map((face) => ({
        id: face.id,
        sourceObjectId: face.sourceObjectId,
        morphism: cloneValue(face.morphism),
        notation: face.notation,
      })),
    },
    force: {
      listensToObjectId: objectId,
      boundaryDependencies: boundaryObjectIds,
      topologySignature: `${thetaObjectNotation(index)}|${faces
        .map((face) => face.notation)
        .join("|")}`,
    },
  });
}

function compileThetaObjects(faceMorphisms) {
  return THETA3_OBJECTS.map((objectValue, index) => {
    const elementKind = thetaElementKind(index);
    const m = thetaObjectValueM(objectValue);
    const children = thetaObjectValueChildren(objectValue);
    const graphics = thetaGraphicsEntity(index, { faceMorphisms });
    const object = {
      id: thetaObjectId(index),
      thetaIndex: index,
      thetaObject: cloneValue(objectValue),
      notation: thetaObjectNotation(index),
      level: CORE_THETA_LEVEL,
      m,
      childObjects: cloneValue(children),
      childNotations: children.map(thetaObjectValueNotation),
      dimension: thetaObjectGraphicalDimension(index),
      graphicalDimension: thetaObjectGraphicalDimension(index),
      additiveDegree: thetaObjectAdditiveDegree(index),
      renderKind: thetaRenderKind(index),
      graphics: cloneValue(graphics),
      boundary: faceMorphisms
        .filter((face) => face.targetIndex === index)
        .map((face) => ({
          id: face.id,
          sourceObjectId: face.sourceObjectId,
          morphism: cloneValue(face.face),
          notation: face.notation,
        })),
    };
    return elementKind ? { ...object, elementKind } : object;
  });
}

export function createHierarchicalThetaSchema() {
  const generatingFaceMorphisms = compileThetaFaceMorphisms();
  const faceCompositionRelations =
    compileThetaFaceCompositionRelations(generatingFaceMorphisms);
  const objects = compileThetaObjects(generatingFaceMorphisms);
  return deepFreeze({
    format: MATH_SCHEMA_FORMAT,
    version: MATH_SCHEMA_VERSION,
    id: CORE_THETA_SCHEMA_ID,
    structureId: CORE_THETA_STRUCTURE_ID,
    title: THETA3_SCHEMA_REGISTRY.title,
    objectEncoding: THETA3_SCHEMA_REGISTRY.objectEncoding,
    faceMorphismEncoding: THETA3_SCHEMA_REGISTRY.faceMorphismEncoding,
    objects,
    aliases: CORE_THETA_ALIASES,
    graphicsMapping: cloneValue(THETA3_GRAPHICS_MAPPING),
    rawObjects: THETA3_OBJECTS,
    rawGeneratingFaceMorphisms: THETA3_FACE_MORPHISMS,
    rawFaceCompositionRelations: THETA3_FACE_COMPOSITION_RELATIONS,
    generatingFaceMorphisms,
    faceCompositionRelations,
  });
}

// Schemas are immutable; compile once rather than rebuilding the complete
// geometry/face catalogue for every store and every registry lookup.
const BUILTIN_SCHEMAS = [createHierarchicalThetaSchema(), VIRTUAL_DOUBLE_CATEGORY_SCHEMA];

export class MathematicalSchemaRegistry {
  constructor({
    schemas = BUILTIN_SCHEMAS,
  } = {}) {
    this.schemasById = new Map();
    this.schemasByStructureId = new Map();
    this.objectsByElementKind = new Map();
    this.aliases = new Map();
    for (const schema of schemas) {
      this.registerSchema(schema);
    }
  }

  registerSchema(schema) {
    if (!schema?.id) {
      throw new Error("Mathematical schema requires an id");
    }
    this.schemasById.set(schema.id, schema);
    if (schema.structureId) {
      this.schemasByStructureId.set(schema.structureId, schema);
    }
    for (const object of schema.objects ?? []) {
      if (!object.elementKind) {
        continue;
      }
      this.objectsByElementKind.set(normalizeKey(object.elementKind), {
        schema,
        object,
      });
      this.aliases.set(normalizeKey(object.elementKind), object.elementKind);
    }
    for (const [alias, elementKind] of Object.entries(schema.aliases ?? {})) {
      this.aliases.set(normalizeKey(alias), elementKind);
    }
    return schema;
  }

  schema(id) {
    return this.schemasById.get(id) ?? null;
  }

  schemaForStructure(structureId) {
    return this.schemasByStructureId.get(structureId) ?? null;
  }

  normalizeElementKind(kind) {
    const resolved = this.aliases.get(normalizeKey(kind)) ?? null;
    return resolved && this.objectsByElementKind.has(normalizeKey(resolved))
      ? resolved
      : null;
  }

  objectForElementKind(kind, objectId = null) {
    const elementKind = this.normalizeElementKind(kind);
    if (objectId != null) {
      return this.schemaForElementKind(elementKind)?.objects.find(
        (object) => object.id === objectId && object.elementKind === elementKind,
      ) ?? null;
    }
    if (elementKind === "theta-volume") return null;
    return this.objectsByElementKind.get(normalizeKey(elementKind))?.object ?? null;
  }

  schemaForElementKind(kind) {
    const elementKind = this.normalizeElementKind(kind);
    return this.objectsByElementKind.get(normalizeKey(elementKind))?.schema ?? null;
  }

  schemaRefForElementKind(kind, objectId = null) {
    const elementKind = this.normalizeElementKind(kind);
    const entry = this.objectsByElementKind.get(normalizeKey(elementKind));
    const object = this.objectForElementKind(elementKind, objectId);
    if (!entry || !object) {
      return null;
    }
    return {
      schemaId: entry.schema.id,
      structureId: entry.schema.structureId,
      objectId: object.id,
      elementKind: object.elementKind,
    };
  }

  exportSchemas() {
    return [...this.schemasById.values()].map((schema) => cloneValue(schema));
  }
}

export function createDefaultSchemaRegistry() {
  return new MathematicalSchemaRegistry();
}

export const DEFAULT_MATH_SCHEMA_REGISTRY = createDefaultSchemaRegistry();

export function normalizeSchemaElementKind(kind) {
  return DEFAULT_MATH_SCHEMA_REGISTRY.normalizeElementKind(kind);
}

export function schemaRefForElementKind(kind, objectId = null) {
  const ref = DEFAULT_MATH_SCHEMA_REGISTRY.schemaRefForElementKind(kind, objectId);
  return ref ? cloneValue(ref) : null;
}
