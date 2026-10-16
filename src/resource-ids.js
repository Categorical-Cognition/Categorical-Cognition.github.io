export const RESOURCE_KINDS = Object.freeze({
  GOLOG: "golog",
  SIMPLEX: "simplex",
  PAYLOAD: "payload",
  WORKSPACE: "workspace",
  OPERATION: "operation",
  INTERACTION: "interaction",
});

export const RESOURCE_DEFINITIONS = Object.freeze({
  [RESOURCE_KINDS.GOLOG]: Object.freeze({
    kind: RESOURCE_KINDS.GOLOG,
    fields: Object.freeze(["gologId"]),
    required: Object.freeze(["gologId"]),
  }),
  [RESOURCE_KINDS.SIMPLEX]: Object.freeze({
    kind: RESOURCE_KINDS.SIMPLEX,
    fields: Object.freeze(["gologId", "objectId"]),
    required: Object.freeze(["gologId", "objectId"]),
  }),
  [RESOURCE_KINDS.PAYLOAD]: Object.freeze({
    kind: RESOURCE_KINDS.PAYLOAD,
    fields: Object.freeze(["gologId", "objectId", "payloadType"]),
    required: Object.freeze(["gologId", "objectId"]),
  }),
  [RESOURCE_KINDS.WORKSPACE]: Object.freeze({
    kind: RESOURCE_KINDS.WORKSPACE,
    fields: Object.freeze(["workspaceId"]),
    required: Object.freeze(["workspaceId"]),
    defaults: Object.freeze({ workspaceId: "default" }),
  }),
  [RESOURCE_KINDS.OPERATION]: Object.freeze({
    kind: RESOURCE_KINDS.OPERATION,
    fields: Object.freeze(["gologId", "operationType", "scope"]),
    required: Object.freeze(["gologId", "operationType"]),
  }),
  [RESOURCE_KINDS.INTERACTION]: Object.freeze({
    kind: RESOURCE_KINDS.INTERACTION,
    fields: Object.freeze(["gologId", "objectId", "mode"]),
    required: Object.freeze(["gologId", "objectId"]),
    defaults: Object.freeze({ mode: "human-control" }),
  }),
});

function encodePart(value) {
  if (value === null || value === undefined || value === "") {
    throw new Error("Resource id parts must be non-empty");
  }
  return encodeURIComponent(String(value));
}

function decodePart(value) {
  return decodeURIComponent(value);
}

function hasValue(value) {
  return value !== null && value !== undefined && value !== "";
}

export class ResourceDescriptorRegistry {
  constructor(definitions = RESOURCE_DEFINITIONS) {
    this.definitions = definitions;
  }

  definitionForKind(kind) {
    const definition = this.definitions[kind];
    if (!definition) {
      throw new Error(`Unsupported resource kind: ${kind}`);
    }
    return definition;
  }

  create(kind, fields = {}) {
    return this.canonicalDescriptor({ kind, ...fields });
  }

  canonicalDescriptor(resource) {
    if (!resource || typeof resource !== "object") {
      throw new Error("Resource descriptor must be an object");
    }
    const kind = String(resource.kind ?? "");
    const definition = this.definitionForKind(kind);
    const descriptor = { kind };

    for (const field of definition.fields) {
      const value = resource[field] ?? definition.defaults?.[field] ?? null;
      if (hasValue(value)) {
        descriptor[field] = String(value);
      }
    }

    for (const field of definition.required) {
      if (!hasValue(descriptor[field])) {
        throw new Error(`Resource descriptor missing required field: ${field}`);
      }
    }

    return descriptor;
  }

  serialize(resource) {
    const descriptor = this.canonicalDescriptor(resource);
    const definition = this.definitionForKind(descriptor.kind);
    const fieldValues = definition.fields
      .map((field) => descriptor[field])
      .filter(hasValue);
    return [descriptor.kind, ...fieldValues.map(encodePart)].join(":");
  }

  parse(resourceId) {
    if (typeof resourceId !== "string" || resourceId.length === 0) {
      throw new Error("Resource id must be a non-empty string");
    }
    const [kind, ...encodedValues] = resourceId.split(":");
    const definition = this.definitionForKind(kind);
    if (
      encodedValues.length < definition.required.length ||
      encodedValues.length > definition.fields.length
    ) {
      throw new Error(`Invalid ${kind} resource id field count`);
    }

    const descriptor = { kind };
    encodedValues.forEach((encoded, index) => {
      descriptor[definition.fields[index]] = decodePart(encoded);
    });
    return this.canonicalDescriptor(descriptor);
  }

  normalize(resource) {
    return typeof resource === "string"
      ? this.serialize(this.parse(resource))
      : this.serialize(resource);
  }
}

export const DEFAULT_RESOURCE_REGISTRY = Object.freeze(
  new ResourceDescriptorRegistry(RESOURCE_DEFINITIONS),
);

export function createResourceDescriptor(kind, fields = {}) {
  return DEFAULT_RESOURCE_REGISTRY.create(kind, fields);
}

export function serializeResourceId(resource) {
  return DEFAULT_RESOURCE_REGISTRY.serialize(resource);
}

export function parseResourceId(resourceId) {
  return DEFAULT_RESOURCE_REGISTRY.parse(resourceId);
}

export function normalizeResourceId(resource) {
  return DEFAULT_RESOURCE_REGISTRY.normalize(resource);
}

export function gologResource(gologId) {
  return createResourceDescriptor(RESOURCE_KINDS.GOLOG, { gologId });
}

export function simplexResource(gologId, objectId) {
  return createResourceDescriptor(RESOURCE_KINDS.SIMPLEX, {
    gologId,
    objectId,
  });
}

export function payloadResource(gologId, objectId, payloadType = null) {
  return createResourceDescriptor(RESOURCE_KINDS.PAYLOAD, {
    gologId,
    objectId,
    payloadType,
  });
}

export function workspaceResource(workspaceId = "default") {
  return createResourceDescriptor(RESOURCE_KINDS.WORKSPACE, { workspaceId });
}

export function operationResource(gologId, operationType, scope = null) {
  return createResourceDescriptor(RESOURCE_KINDS.OPERATION, {
    gologId,
    operationType,
    scope,
  });
}

export function interactionResource(gologId, objectId, mode = "human-control") {
  return createResourceDescriptor(RESOURCE_KINDS.INTERACTION, {
    gologId,
    objectId,
    mode,
  });
}

export function gologResourceId(gologId) {
  return serializeResourceId(gologResource(gologId));
}

export function simplexResourceId(gologId, objectId) {
  return serializeResourceId(simplexResource(gologId, objectId));
}

export function payloadResourceId(gologId, objectId, payloadType = null) {
  return serializeResourceId(payloadResource(gologId, objectId, payloadType));
}

export function workspaceResourceId(workspaceId = "default") {
  return serializeResourceId(workspaceResource(workspaceId));
}

export function operationResourceId(gologId, operationType, scope = null) {
  return serializeResourceId(operationResource(gologId, operationType, scope));
}

export function interactionResourceId(gologId, objectId, mode = "human-control") {
  return serializeResourceId(interactionResource(gologId, objectId, mode));
}
