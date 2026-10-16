import { payloadKind, PAYLOAD_TYPES } from "./payload-types.js";

export const PAYLOAD_SCENE_PRESENTATION_TYPES = Object.freeze({
  MEDIA_BILLBOARD: "media-billboard",
  NESTED_GOLOG: "nested-golog",
});

function nestedGologPresentation(payload, { workspace } = {}) {
  const childGolog = workspace?.gologs?.get?.(payload.targetGologId) ?? null;
  return {
    type: PAYLOAD_SCENE_PRESENTATION_TYPES.NESTED_GOLOG,
    targetGologId: payload.targetGologId,
    childGolog,
  };
}

function imagePresentation(payload) {
  if (!payload.src) {
    return null;
  }
  return {
    type: PAYLOAD_SCENE_PRESENTATION_TYPES.MEDIA_BILLBOARD,
    mediaType: "image",
    src: payload.src,
    title: payload.alt || payload.name || "Image payload",
  };
}

function latexPresentation(payload) {
  const imageUrl =
    payload.imageDataUrl ||
    payload.pngDataUrl ||
    payload.previewDataUrl ||
    payload.imageUrl ||
    payload.pngUrl ||
    payload.previewUrl ||
    "";
  const pdfUrl = payload.pdfUrl || "";
  const src = imageUrl || pdfUrl;
  if (!src) {
    return null;
  }
  return {
    type: PAYLOAD_SCENE_PRESENTATION_TYPES.MEDIA_BILLBOARD,
    mediaType: imageUrl ? "image" : "pdf",
    src,
    title: payload.title || "LaTeX payload",
  };
}

function latexPngPresentation(payload) {
  const src =
    payload.imageDataUrl ||
    payload.pngDataUrl ||
    payload.previewDataUrl ||
    payload.imageUrl ||
    payload.pngUrl ||
    payload.previewUrl ||
    "";
  if (!src) {
    return null;
  }
  return {
    type: PAYLOAD_SCENE_PRESENTATION_TYPES.MEDIA_BILLBOARD,
    mediaType: "image",
    src,
    title: payload.title || "LaTeX payload",
  };
}

export function scenePresentationForPayload(payload, context = {}) {
  if (!payload) {
    return null;
  }

  if (payload.type === PAYLOAD_TYPES.NESTED_GOLOG) {
    return nestedGologPresentation(payload, context);
  }

  const kind = payloadKind(payload);
  if (kind === "image") {
    return imagePresentation(payload);
  }

  if (kind === "latex") {
    return latexPresentation(payload);
  }

  return null;
}

export function scenePresentablePayloadChoices(payloads = [], context = {}) {
  return payloads
    .map((payload) => ({
      payload,
      presentation: scenePresentationForPayload(payload, context),
    }))
    .filter((choice) => Boolean(choice.presentation));
}

export function sceneExpansionPayloadChoices(payloads = [], context = {}) {
  return payloads
    .map((payload) => {
      if (payload?.type === PAYLOAD_TYPES.NESTED_GOLOG) {
        return {
          payload,
          presentation: nestedGologPresentation(payload, context),
        };
      }

      if (payloadKind(payload) === "latex") {
        return {
          payload,
          presentation: latexPngPresentation(payload),
        };
      }
      return { payload, presentation: null };
    })
    .filter((choice) => Boolean(choice.presentation));
}
