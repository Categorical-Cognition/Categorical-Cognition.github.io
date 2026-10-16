import {
  PAYLOAD_SCENE_PRESENTATION_TYPES,
  scenePresentationForPayload,
} from "./payload-scene-presenters.js";
import {
  payloadAttachmentKey,
  payloadKind,
  PAYLOAD_TYPES,
} from "./payload-types.js";

export function latexPayloadImageSource(payload) {
  if (payload?.type !== PAYLOAD_TYPES.LATEX) {
    return "";
  }
  return String(
    payload.imageDataUrl ||
      payload.pngDataUrl ||
      payload.previewDataUrl ||
      payload.imageUrl ||
      payload.pngUrl ||
      payload.previewUrl ||
      "",
  );
}

export function latexPayloadNeedsCompile(payload) {
  return (
    payload?.type === PAYLOAD_TYPES.LATEX &&
    String(payload.text ?? "").trim().length > 0 &&
    !latexPayloadImageSource(payload)
  );
}

export function selectableKindForObject(object) {
  if (!object) {
    return null;
  }
  if (object.dimension === 0) {
    return "sphere";
  }
  if (object.dimension === 1) {
    return "edge";
  }
  if (object.dimension === 2) {
    return "surface";
  }
  return null;
}

export function buildPayloadRenderManifest({ state, workspace } = {}) {
  const manifest = {
    renderableMedia: [],
    uncompiledLatex: [],
    compiledLatexCount: 0,
    imagePayloadCount: 0,
    skippedPayloadCount: 0,
  };

  if (!state?.payloads) {
    return {
      ...manifest,
      renderableMediaCount: 0,
      uncompiledLatexCount: 0,
      totalMediaCount: 0,
    };
  }

  const owners =
    typeof state.getPayloads === "function"
      ? [
          ...new Set([
            ...[...(state.payloadAttachments?.keys?.() ?? [])],
            ...[...state.payloads.keys()],
            ...[...state.spheres.values()]
              .filter((sphere) => sphere.childGologId)
              .map((sphere) => sphere.id),
          ]),
        ]
      : [...state.payloads.keys()];

  for (const objectId of owners) {
    const object = state.getObject?.(objectId);
    const objectKind = selectableKindForObject(object);
    if (!object || !objectKind) {
      manifest.skippedPayloadCount += 1;
      continue;
    }

    const payloads =
      typeof state.getPayloads === "function"
        ? state.getPayloads(objectId)
        : [state.payloads.get(objectId)].filter(Boolean);
    for (const payload of payloads) {
      const kind = payloadKind(payload);
      if (kind === "image") {
        manifest.imagePayloadCount += 1;
      }
      if (payload?.type === PAYLOAD_TYPES.LATEX) {
        if (latexPayloadNeedsCompile(payload)) {
          manifest.uncompiledLatex.push({
            objectId,
            objectKind,
            object,
            payload,
          });
          continue;
        }
        if (latexPayloadImageSource(payload)) {
          manifest.compiledLatexCount += 1;
        }
      }

      const presentation = scenePresentationForPayload(payload, { workspace });
      if (
        presentation?.type === PAYLOAD_SCENE_PRESENTATION_TYPES.MEDIA_BILLBOARD &&
        presentation.mediaType === "image" &&
        presentation.src
      ) {
        manifest.renderableMedia.push({
          objectId,
          objectKind,
        object,
        payload,
        payloadKey: payloadAttachmentKey(payload),
        presentation,
      });
      }
    }
  }

  return {
    ...manifest,
    renderableMediaCount: manifest.renderableMedia.length,
    uncompiledLatexCount: manifest.uncompiledLatex.length,
    totalMediaCount:
      manifest.imagePayloadCount + manifest.compiledLatexCount,
  };
}
