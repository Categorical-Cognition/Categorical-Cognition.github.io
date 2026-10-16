export const HOSTED_WORKSPACE_CATALOG_PATH = "/__golog/workspaces";
export const HOSTED_WORKSPACE_ROUTE_PREFIX = "/golog/";
export const HOSTED_WORKSPACE_FILE_PREFIX = "/workspaces/";

// Workspace content belongs to the serving runtime, never to the application.
export const HOSTED_WORKSPACES = Object.freeze([]);

export function findHostedWorkspace(idOrAlias, workspaces = HOSTED_WORKSPACES) {
  const normalized = String(idOrAlias ?? "").trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  return (
    workspaces.find(
      (entry) =>
        entry.id === normalized ||
        (entry.startupAliases ?? []).includes(normalized),
    ) ?? null
  );
}

export function hostedWorkspaceIdFromPath(pathname = "") {
  const path = String(pathname).replace(/\/+$/, "");
  if (!path.startsWith(HOSTED_WORKSPACE_ROUTE_PREFIX)) {
    return null;
  }
  const rawId = path.slice(HOSTED_WORKSPACE_ROUTE_PREFIX.length).split("/")[0];
  return rawId ? decodeURIComponent(rawId).toLowerCase() : null;
}

export function hostedWorkspaceIdFromFilePath(pathname = "") {
  const path = String(pathname);
  if (!path.startsWith(HOSTED_WORKSPACE_FILE_PREFIX)) {
    return null;
  }
  const filename = path.slice(HOSTED_WORKSPACE_FILE_PREFIX.length);
  const match = filename.match(/^(.+)\.golog\.json$/);
  return match ? decodeURIComponent(match[1]).toLowerCase() : null;
}

export function hostedWorkspaceStartupConfig(entry) {
  if (!entry) {
    return null;
  }
  return {
    url: entry.workspaceUrl,
    activeGologTitle: entry.activeGologTitle,
    hostedWorkspaceId: entry.id,
  };
}

export function hostedWorkspaceStartupConfigForId(id) {
  const normalized = String(id ?? "").trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  return {
    url: `${HOSTED_WORKSPACE_FILE_PREFIX}${encodeURIComponent(
      normalized,
    )}.golog.json`,
    activeGologTitle: null,
    hostedWorkspaceId: normalized,
  };
}

export function publicHostedWorkspaceRecord(entry) {
  return {
    id: entry.id,
    title: entry.title,
    url: entry.workspaceUrl,
    workspaceUrl: entry.workspaceUrl,
    routeUrl: entry.routeUrl,
    activeGologTitle: entry.activeGologTitle,
    discovered: Boolean(entry.discovered),
    sourceLabel: entry.sourceLabel ?? null,
    gologCount: entry.gologCount ?? null,
  };
}

export function hostedWorkspaceCatalog(workspaces = HOSTED_WORKSPACES) {
  return workspaces.map(publicHostedWorkspaceRecord);
}
