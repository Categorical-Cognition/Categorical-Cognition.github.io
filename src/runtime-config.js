import { HOSTED_WORKSPACES } from "./hosted-workspaces.js";

export const STATIC_LATEX_COMPILE_MESSAGE =
  "LaTeX compilation is unavailable in this browser-only edition. Source remains editable; existing images can still be displayed.";

// This policy comes from the deployed app shell, not query parameters.
export function browserRuntimeConfig(config = globalThis.__GOLOG_RUNTIME_CONFIG) {
  const staticHosting = config?.staticHosting === true;
  const developmentTools = !staticHosting && config?.developmentTools !== false;
  const shared = !staticHosting && config?.shared === true;
  return {
    staticHosting,
    developmentTools,
    shared,
    sharedWorkspaceLoad: shared && config?.sharedWorkspaceLoad === true,
    peer: staticHosting ? null : config?.peer ?? null,
    serverWorkspaceSave: developmentTools && config?.serverWorkspaceSave !== false,
    serverWorkspaceCatalog: !staticHosting,
    serverLatexCompile: !staticHosting,
    hostedWorkspaces: !staticHosting && Array.isArray(config?.hostedWorkspaces)
      ? config.hostedWorkspaces
      : HOSTED_WORKSPACES,
  };
}
