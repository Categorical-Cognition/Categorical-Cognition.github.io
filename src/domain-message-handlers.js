import {
  DOMAIN_OPERATION_APPLY_EVENT,
  DOMAIN_OPERATION_TYPES,
} from "./domain-operations.js";
import { OperationPipeline } from "./operation-pipeline.js";

function operationOriginFrom(options, type, payload) {
  if (typeof options.operationOrigin === "function") {
    return options.operationOrigin(type, payload);
  }
  return options.operationOrigin ?? { source: "local-bus" };
}

export function registerDomainMessageHandlers(store, bus, options = {}) {
  const pipeline =
    options.pipeline ?? new OperationPipeline({ store, bus, policy: store.mutationPolicy });
  store.operationPipeline = pipeline;

  for (const type of DOMAIN_OPERATION_TYPES) {
    bus.on(type, (payload = {}) => {
      const { origin, ...operationPayload } = payload ?? {};
      return pipeline.submit(type, operationPayload, {
        origin: origin ?? operationOriginFrom(options, type, payload),
      });
    });
  }

  bus.on(DOMAIN_OPERATION_APPLY_EVENT, (operation) =>
    pipeline.submitOperation(operation),
  );

  bus.on("sphere:select", ({ id }) => store.selectSphere(id));
  bus.on("edge:select", ({ id }) => store.selectEdge(id));
  bus.on("surface:select", ({ id }) => store.selectSurface(id));
  bus.on("volume:select", ({ id }) => store.selectVolume(id));
  bus.on("object:locks-acquire", (payload) =>
    store.acquireLocks(payload.objectIds ?? [payload.objectId], payload),
  );
  bus.on("object:locks-release", (payload) =>
    store.releaseLocks(payload.objectIds ?? [payload.objectId], payload),
  );
}
