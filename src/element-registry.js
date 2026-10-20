import {
  ELEMENT_KINDS,
  defaultElementDefinitions as defaultStructureElementDefinitions,
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

export class ElementRegistry {
  constructor({
    definitions = defaultElementDefinitions(),
    schemaRegistry = createDefaultSchemaRegistry(),
  } = {}) {
    this.definitions = new Map(
      definitions.map((definition) => [definition.elementKind, definition]),
    );
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


}

export function createElementRegistry(options = {}) {
  return new ElementRegistry(options);
}
