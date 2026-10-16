export function safePayloadPreviewUrl(value, {
  mediaType = "pdf",
  baseUrl = globalThis.location?.href ?? "http://localhost/",
} = {}) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw, baseUrl);
    if (["http:", "https:"].includes(url.protocol)) return url.href;
    const dataType = mediaType === "pdf" ? /^data:application\/pdf[;,]/i : /^data:image\/[a-z0-9.+-]+[;,]/i;
    return url.protocol === "data:" && dataType.test(raw) ? raw : "";
  } catch {
    return "";
  }
}

export function appendPdfPreview(container, { url, title = "PDF payload", className = "" } = {}) {
  const documentRef = container.ownerDocument;
  const safeUrl = safePayloadPreviewUrl(url, { baseUrl: documentRef.baseURI });
  if (!safeUrl) return null;
  const frame = documentRef.createElement("iframe");
  frame.className = className;
  frame.title = title;
  // A server may return HTML at a PDF URL. It must never execute as app code.
  frame.setAttribute("sandbox", "");
  frame.referrerPolicy = "no-referrer";
  frame.src = `${safeUrl.split("#")[0]}#toolbar=0&navpanes=0&scrollbar=0`;
  const fallback = documentRef.createElement("a");
  fallback.className = "payload-pdf-open";
  fallback.textContent = "Open PDF";
  fallback.href = safeUrl;
  fallback.target = "_blank";
  fallback.rel = "noopener noreferrer";
  container.append(frame, fallback);
  return frame;
}
