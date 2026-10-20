export function cloneStoreValue(value) {
  if (value?.isVector2 || value?.isVector3) {
    return value.clone();
  }
  if (Array.isArray(value)) {
    return value.map((entry) => cloneStoreValue(entry));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    for (const entry of entries) entry[1] = cloneStoreValue(entry[1]);
    return Object.fromEntries(entries);
  }
  return value;
}

export function normalizeClient(client = {}) {
  return {
    clientId: client.clientId ?? client.id ?? client.ownerId ?? null,
    clientIp: client.clientIp ?? client.ip ?? null,
  };
}
