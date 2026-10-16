import {
  ELEMENT_KINDS,
  defaultElementDefinitions as defaultStructureElementDefinitions,
  defaultElementProviders as defaultStructureElementProviders,
} from "./hierarchical-theta-space-definition.js";
import {
  createDefaultSchemaRegistry,
  DEFAULT_MATH_SCHEMA_REGISTRY,
} from "./mathematical-schema-registry.js";
import {
  virtualDoubleElementDefinitions,
  VIRTUAL_DOUBLE_ELEMENT_KINDS,
} from "./virtual-double-category-definition.js";
import { structureDefinitionFor } from "./structure-definition-registry.js";
import { thetaVolumeSchemaRef, validateThetaVolumeElement, THETA_VOLUME_KIND } from "./theta-volume-definition.js";

export { ELEMENT_KINDS, VIRTUAL_DOUBLE_ELEMENT_KINDS };

export const ELEMENT_DECLARATION_SET_FORMAT = "golog.element-declaration-set";
export const ELEMENT_DECLARATION_SET_VERSION = 1;

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

function declarationCounts(declarations) {
  return declarations.reduce((counts, declaration) => {
    counts[declaration.kind] = (counts[declaration.kind] ?? 0) + 1;
    return counts;
  }, {});
}

export function normalizeElementKind(kind) {
  return DEFAULT_MATH_SCHEMA_REGISTRY.normalizeElementKind(kind);
}

function createIdForDefinition(store, definition) {
  if (!definition?.createId) {
    return null;
  }
  const { prefix, counter } = definition.createId;
  return `${prefix}${store[counter]}`;
}

export function defaultElementDefinitions() {
  return [
    ...defaultStructureElementDefinitions(),
    ...virtualDoubleElementDefinitions(),
  ];
}

export function defaultElementProviders() {
  return defaultStructureElementProviders();
}

export class ElementRegistry {
  constructor({
    definitions = defaultElementDefinitions(),
    providers = defaultElementProviders(),
    schemaRegistry = createDefaultSchemaRegistry(),
  } = {}) {
    this.definitions = new Map(
      definitions.map((definition) => [definition.elementKind, definition]),
    );
    this.providers = [...providers];
    this.schemaRegistry = schemaRegistry;
  }

  registerDefinition(definition) {
    this.definitions.set(definition.elementKind, definition);
    return () => {
      if (this.definitions.get(definition.elementKind) === definition) {
        this.definitions.delete(definition.elementKind);
      }
    };
  }

  register(provider) {
    this.providers.push(provider);
    return () => {
      this.providers = this.providers.filter((entry) => entry !== provider);
    };
  }

  definitionFor(kind) {
    const elementKind = this.schemaRegistry.normalizeElementKind(kind) ?? kind;
    const definition = this.definitions.get(elementKind);
    if (!definition) {
      throw new Error(`Unsupported element kind: ${kind ?? "missing"}`);
    }
    return definition;
  }

  prepareCreatePayload(store, payload = {}) {
    const requestedKind = payload.elementKind ?? payload.kind ?? payload.elementType;
    const definition = this.definitionFor(requestedKind);
    const elementKind = definition.elementKind;
    const structure = structureDefinitionFor({
      structureId: store.structure?.id ?? "hierarchical-theta-space",
      schemaId: store.structure?.schema,
    });
    if (!Object.values(structure.elementKinds).includes(elementKind)) {
      throw new Error(
        `${structure.id} does not define element kind: ${elementKind}`,
      );
    }
    const schemaRef = elementKind === THETA_VOLUME_KIND
      ? thetaVolumeSchemaRef(payload)
      : this.schemaRegistry.schemaRefForElementKind(elementKind);
    if (payload.schemaRef && ["schemaId", "structureId", "objectId", "elementKind"].some(
      (key) => payload.schemaRef[key] != null && payload.schemaRef[key] !== schemaRef?.[key],
    )) throw new Error(`Element schema reference does not match ${elementKind}`);
    const position =
      [ELEMENT_KINDS.ZERO_SIMPLEX, VIRTUAL_DOUBLE_ELEMENT_KINDS.OBJECT].includes(
        elementKind,
      ) && payload.position == null
        ? store.findCompactNodePosition?.()
        : payload.position;
    const id = payload.id ?? createIdForDefinition(store, definition);
    if (typeof id !== "string" || !id) throw new Error("Element id must be a nonempty string");
    const existing = store.getObject?.(id);
    if (existing && existing.elementKind !== elementKind) {
      throw new Error(`Element id already belongs to another kind: ${id}`);
    }
    const prepared = {
      ...payload,
      elementKind,
      ...(schemaRef ? { schemaRef } : {}),
      ...(position === undefined ? {} : { position }),
      id,
    };
    if (elementKind === THETA_VOLUME_KIND) validateThetaVolumeElement(store, prepared);
    return prepared;
  }

  createElement(store, payload = {}) {
    const prepared = this.prepareCreatePayload(store, payload);
    const definition = this.definitionFor(prepared.elementKind);
    return definition.create(store, prepared);
  }

  collectElements(graph, options = {}) {
    return this.providers.flatMap((provider) => provider(graph, options) ?? []);
  }

  collectDeclarations(graph, options = {}) {
    const elements = this.collectElements(graph, options);
    const declarations = elements.flatMap((element) =>
      (element.declarations ?? []).map((declaration) => ({
        ...cloneValue(declaration),
        elementKind: declaration.elementKind ?? element.elementKind,
        objectId: declaration.objectId ?? element.objectId ?? undefined,
      })),
    );
    return {
      format: ELEMENT_DECLARATION_SET_FORMAT,
      version: ELEMENT_DECLARATION_SET_VERSION,
      gologId: graph.gologId,
      elements,
      declarations,
      counts: declarationCounts(declarations),
      elementCounts: elements.reduce((counts, element) => {
        counts[element.elementKind] = (counts[element.elementKind] ?? 0) + 1;
        return counts;
      }, {}),
    };
  }

  collect(graph, options = {}) {
    return this.collectDeclarations(graph, options);
  }
}

export function createElementRegistry(options = {}) {
  return new ElementRegistry(options);
}
