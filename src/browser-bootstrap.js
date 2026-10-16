import { createGologApp } from "./app-init.js";
import { browserRuntimeConfig } from "./runtime-config.js";

export function bootstrapGologBrowser({
  developmentTools = browserRuntimeConfig().developmentTools,
  documentRef = globalThis.document,
  windowRef = globalThis.window,
} = {}) {
  if (!developmentTools) {
    for (const element of documentRef.querySelectorAll("[data-development-only]")) {
      element.remove();
    }
  }
  const app = createGologApp({
    container: documentRef.querySelector("#scene-panel"),
    documentRef,
    developmentTools,
  });
  windowRef.__gologRenderTest = app;
  windowRef.__gologAgent = app.agentApi;
  return app;
}
