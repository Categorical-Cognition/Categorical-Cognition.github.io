import {
  HIERARCHICAL_THETA_SPACE_DEFINITION,
} from "./hierarchical-theta-space-definition.js";
import {
  VIRTUAL_DOUBLE_CATEGORY_DEFINITION,
} from "./virtual-double-category-definition.js";

export class StructureDefinitionRegistry {
  constructor({
    definitions = [
      HIERARCHICAL_THETA_SPACE_DEFINITION,
      VIRTUAL_DOUBLE_CATEGORY_DEFINITION,
    ],
  } = {}) {
    this.byId = new Map();
    this.bySchema = new Map();
    for (const definition of definitions) {
      this.register(definition);
    }
  }

  register(definition) {
    if (!definition?.id || !definition?.schema) {
      throw new Error("Structure definitions require id and schema");
    }
    this.byId.set(definition.id, definition);
    this.bySchema.set(definition.schema, definition);
    return definition;
  }

  resolve({ structureId = null, schemaId = null } = {}) {
    const structure = structureId ? this.byId.get(structureId) : null;
    const schema = schemaId ? this.bySchema.get(schemaId) : null;
    if ((structureId && !structure) || (schemaId && !schema)) return null;
    if (structure && schema && structure !== schema) return null;
    return structure ?? schema ?? null;
  }
}

export const DEFAULT_STRUCTURE_DEFINITION_REGISTRY =
  new StructureDefinitionRegistry();

export function structureDefinitionFor(reference = {}) {
  const registry = DEFAULT_STRUCTURE_DEFINITION_REGISTRY;
  const definition = typeof reference === "string"
    ? registry.resolve({ structureId: reference }) ?? registry.resolve({ schemaId: reference })
    : registry.resolve(reference);
  if (!definition) {
    throw new Error(
      `Unsupported mathematical structure: ${
        reference?.structureId ?? reference?.schemaId ?? reference ?? "missing"
      }`,
    );
  }
  return definition;
}
