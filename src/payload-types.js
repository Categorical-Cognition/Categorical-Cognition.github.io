export const PAYLOAD_TYPES = Object.freeze({
  MARKDOWN: "text/markdown",
  LATEX: "text/latex",
  URL: "text/uri-list",
  NESTED_GOLOG: "nested-golog",
});

const LATEX_DOCUMENT_KINDS = new Set(["snippet", "paper"]);

const CODE_LANGUAGE_PATTERN = /^[a-z0-9][a-z0-9+._-]*$/;
const IMAGE_MIME_PATTERN = /^image\/[a-z0-9.+-]+$/;

export function normalizeCodeLanguage(language = "text") {
  const normalized = String(language ?? "text").trim().toLowerCase() || "text";
  return CODE_LANGUAGE_PATTERN.test(normalized) ? normalized : "text";
}

export function codePayloadType(language = "text") {
  return `code/${normalizeCodeLanguage(language)}`;
}

export function isCodePayloadType(type) {
  return String(type ?? "").startsWith("code/");
}

export function codeLanguageFromType(type) {
  return normalizeCodeLanguage(String(type ?? "").slice("code/".length));
}

export function normalizeImageMimeType(mimeType = "image/png") {
  const normalized = String(mimeType ?? "image/png").trim().toLowerCase();
  return IMAGE_MIME_PATTERN.test(normalized) ? normalized : "image/png";
}

export function imagePayloadType(mimeType = "image/png") {
  return normalizeImageMimeType(mimeType);
}

export function isImagePayloadType(type) {
  return IMAGE_MIME_PATTERN.test(String(type ?? "").trim().toLowerCase());
}

export function payloadKind(payloadOrType) {
  const type =
    typeof payloadOrType === "string" ? payloadOrType : payloadOrType?.type;
  if (type === PAYLOAD_TYPES.NESTED_GOLOG) {
    return "nested-golog";
  }

  if (type === PAYLOAD_TYPES.MARKDOWN) {
    return "markdown";
  }
  if (type === PAYLOAD_TYPES.LATEX) {
    return "latex";
  }
  if (type === PAYLOAD_TYPES.URL) {
    return "url";
  }
  if (isCodePayloadType(type)) {
    return "code";
  }
  if (isImagePayloadType(type)) {
    return "image";
  }
  return "unknown";
}

export function payloadAttachmentKey(payloadOrType) {
  const kind = payloadKind(payloadOrType);
  if (kind !== "unknown") {
    return kind;
  }
  const type =
    typeof payloadOrType === "string" ? payloadOrType : payloadOrType?.type;
  return String(type ?? "unknown").trim() || "unknown";
}

export function payloadHasText(payload) {
  const kind = payloadKind(payload);
  return kind === "markdown" || kind === "latex" || kind === "code";
}

export function payloadSearchText(payload) {
  if (!payload) {
    return "";
  }
  if (payloadHasText(payload)) {
    return [payload.text, payload.title, payload.latexUrl, payload.imageUrl, payload.pngUrl, payload.pdfUrl]
      .filter(Boolean)
      .join(" ");
  }
  if (payloadKind(payload) === "image") {
    return [payload.alt, payload.name, payload.mimeType, payload.type]
      .filter(Boolean)
      .join(" ");
  }
  if (payloadKind(payload) === "url") {
    return [payload.url, payload.title, payload.description]
      .filter(Boolean)
      .join(" ");
  }
  if (payloadKind(payload) === "nested-golog") {
    return [payload.targetGologId, payload.rootObjectId].filter(Boolean).join(" ");
  }

  return "";
}

export function normalizePayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Payload must be an object");
  }
  const type = String(payload.type ?? "").trim();
  if (!type) {
    throw new Error("Payload type is required");
  }

  if (type === "edge-expansion") {
    throw new Error("Unsupported payload type in this release: edge-expansion. Open this document in a version that supports this extension.");
  }

  if (type === PAYLOAD_TYPES.NESTED_GOLOG) {
    if (!payload.targetGologId) {
      throw new Error("Nested golog payload requires targetGologId");
    }
    return {
      type,
      targetGologId: String(payload.targetGologId),
      ...(payload.rootObjectId ? { rootObjectId: String(payload.rootObjectId) } : {}),
    };
  }

  if (type === PAYLOAD_TYPES.MARKDOWN) {
    return {
      type,
      text: String(payload.text ?? payload.source ?? ""),
    };
  }

  if (type === PAYLOAD_TYPES.LATEX) {
    const documentKind = LATEX_DOCUMENT_KINDS.has(payload.documentKind)
      ? payload.documentKind
      : "snippet";
    const normalized = {
      type,
      text: String(payload.text ?? payload.source ?? ""),
      documentKind,
      title: String(payload.title ?? ""),
      latexUrl: String(payload.latexUrl ?? payload.sourceUrl ?? ""),
      imageUrl: String(
        payload.imageUrl ?? payload.pngUrl ?? payload.previewUrl ?? "",
      ),
      imageDataUrl: String(
        payload.imageDataUrl ??
          payload.pngDataUrl ??
          payload.previewDataUrl ??
          "",
      ),
      pdfUrl: String(payload.pdfUrl ?? payload.renderedUrl ?? ""),
    };
    for (const field of [
      "preambleUrl",
      "standaloneLatexUrl",
      "sourcePngUrl",
      "reconstructionStatus",
    ]) {
      if (payload[field] !== undefined && payload[field] !== null) {
        normalized[field] = String(payload[field]);
      }
    }
    return normalized;
  }

  if (type === PAYLOAD_TYPES.URL) {
    return {
      type,
      url: String(payload.url ?? payload.href ?? payload.src ?? "").trim(),
      title: String(payload.title ?? payload.name ?? ""),
      description: String(payload.description ?? payload.text ?? ""),
    };
  }

  if (isCodePayloadType(type) || payload.kind === "code") {
    const language = normalizeCodeLanguage(
      payload.language ?? (isCodePayloadType(type) ? codeLanguageFromType(type) : "text"),
    );
    return {
      type: codePayloadType(language),
      language,
      text: String(payload.text ?? payload.code ?? payload.source ?? ""),
    };
  }

  if (isImagePayloadType(type) || payload.kind === "image") {
    const mimeType = normalizeImageMimeType(payload.mimeType ?? type);
    return {
      type: imagePayloadType(mimeType),
      mimeType,
      src: String(payload.src ?? payload.dataUrl ?? payload.url ?? ""),
      alt: String(payload.alt ?? ""),
      name: String(payload.name ?? ""),
    };
  }

  throw new Error(`Unsupported payload type: ${type}`);
}
