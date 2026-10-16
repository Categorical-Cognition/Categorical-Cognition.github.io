import { normalizeResourceId } from "./resource-ids.js";
import { cloneStoreValue } from "./store-utils.js";

export const CANONICAL_AUTHORITY_SECTION_FORMAT =
  "golog.canonical-authority-section";
export const CANONICAL_AUTHORITY_SECTION_VERSION = 1;

function stableHash(input) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function numericOrNull(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function optionalString(value) {
  return value === null || value === undefined || value === ""
    ? null
    : String(value);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function generation(value, fallback = 0) {
  const number = value === null || value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error("Authority generation must be a nonnegative safe integer");
  return number;
}

export function normalizeCanonicalAuthorityRecord(record = {}) {
  const resourceId = normalizeResourceId(record.resourceId);
  const holderId = optionalString(record.holderId);
  if (!holderId) {
    throw new Error("Authority record requires holderId");
  }
  const epoch = generation(record.epoch);
  return {
    resourceId,
    holderId,
    status: record.status === "released" ? "released" : "active",
    epoch,
    fence: generation(record.fence ?? record.fencingToken, epoch),
    token: optionalString(record.token),
    acquiredAt: numericOrNull(record.acquiredAt) ?? 0,
    expiresAt: numericOrNull(record.expiresAt) ?? 0,
  };
}

export function canonicalAuthorityRecordKey(record = {}) {
  const normalized = normalizeCanonicalAuthorityRecord(record);
  return `${normalized.resourceId}\u0000${normalized.holderId}`;
}

export function compareCanonicalAuthorityRecords(first, second) {
  return (
    compareText(first.resourceId, second.resourceId) ||
    compareText(first.holderId, second.holderId) ||
    compareText(first.status, second.status) ||
    first.epoch - second.epoch ||
    first.fence - second.fence ||
    first.acquiredAt - second.acquiredAt ||
    first.expiresAt - second.expiresAt ||
    compareText(String(first.token ?? ""), String(second.token ?? ""))
  );
}

function compareAuthorityPrecedence(first, second) {
  return (
    first.fence - second.fence ||
    first.epoch - second.epoch ||
    first.expiresAt - second.expiresAt ||
    first.acquiredAt - second.acquiredAt ||
    compareText(String(first.token ?? ""), String(second.token ?? ""))
  );
}

export function authorityRecordDominates(candidate, current) {
  if (!current) {
    return true;
  }
  const left = normalizeCanonicalAuthorityRecord(candidate);
  const right = normalizeCanonicalAuthorityRecord(current);
  const precedence = compareAuthorityPrecedence(left, right);
  if (precedence !== 0) {
    return precedence > 0;
  }
  return (
    compareText(left.status, right.status) ||
    compareText(left.holderId, right.holderId)
  ) > 0;
}

// A section stores the latest observation of each resource/holder pair.
// Duplicate observations are idempotent; a release wins over its exact lease.
export function canonicalizeAuthorityRecords(records = []) {
  const latest = new Map();
  for (const input of records) {
    const record = normalizeCanonicalAuthorityRecord(input);
    const key = canonicalAuthorityRecordKey(record);
    if (authorityRecordDominates(record, latest.get(key))) {
      latest.set(key, record);
    }
  }
  return [...latest.values()].sort(compareCanonicalAuthorityRecords);
}

// Observed lease precedence is a merge rule, not distributed consensus.
// Equal-precedence owners obstruct gluing: neither is compiled as authority.
export function resolveAuthorityRecords(records = [], { now = -Infinity } = {}) {
  const normalized = canonicalizeAuthorityRecords(records);
  const candidates = new Map();
  for (const record of normalized) {
    const current = candidates.get(record.resourceId) ?? [];
    const precedence = current.length ? compareAuthorityPrecedence(record, current[0]) : 1;
    if (precedence > 0) candidates.set(record.resourceId, [record]);
    else if (precedence === 0) current.push(record);
  }
  const claims = [];
  const conflicts = [];
  for (const group of candidates.values()) {
    if (group.some((record) => record.status !== "active" || record.expiresAt <= now)) continue;
    if (group.length === 1) claims.push(group[0]);
    else for (const right of group.slice(1)) {
      conflicts.push({ resourceId: right.resourceId, left: group[0], right });
    }
  }
  return { records: normalized, claims, conflicts };
}

export function authorityRecordsConflict(left, right) {
  if (!left || !right) {
    return false;
  }
  const first = normalizeCanonicalAuthorityRecord(left);
  const second = normalizeCanonicalAuthorityRecord(right);
  return (
    first.status === "active" &&
    second.status === "active" &&
    first.resourceId === second.resourceId &&
    first.holderId !== second.holderId &&
    compareAuthorityPrecedence(first, second) === 0
  );
}

export function authoritySectionDigest({ gologId = null, records = [] } = {}) {
  return digestRecords(gologId, canonicalizeAuthorityRecords(records));
}

function digestRecords(gologId, records) {
  return `authority-section-${stableHash(stableStringify({ gologId, records }))}`;
}

export function createCanonicalAuthoritySection({ gologId = null, records = [] } = {}) {
  const normalizedRecords = canonicalizeAuthorityRecords(records);
  return {
    format: CANONICAL_AUTHORITY_SECTION_FORMAT,
    version: CANONICAL_AUTHORITY_SECTION_VERSION,
    gologId,
    digest: digestRecords(gologId, normalizedRecords),
    records: cloneStoreValue(normalizedRecords),
  };
}

export function normalizeCanonicalAuthoritySection(section = {}) {
  if (
    section.format &&
    section.format !== CANONICAL_AUTHORITY_SECTION_FORMAT
  ) {
    throw new Error("Unsupported canonical authority section format");
  }
  if (section.version !== undefined && section.version !== CANONICAL_AUTHORITY_SECTION_VERSION) {
    throw new Error("Unsupported canonical authority section version");
  }
  return createCanonicalAuthoritySection({
    gologId: section.gologId ?? null,
    records: section.records ?? [],
  });
}

export function canonicalAuthoritySectionsEqual(left, right) {
  const leftSection = normalizeCanonicalAuthoritySection(left);
  const rightSection = normalizeCanonicalAuthoritySection(right);
  return (
    leftSection.gologId === rightSection.gologId &&
    leftSection.digest === rightSection.digest &&
    stableStringify(leftSection.records) === stableStringify(rightSection.records)
  );
}

export function restrictCanonicalAuthoritySection(
  section,
  { resourceIds = null, holderIds = null, maxEpoch = Number.POSITIVE_INFINITY } = {},
) {
  const resources = resourceIds
    ? new Set(resourceIds.map((resourceId) => normalizeResourceId(resourceId)))
    : null;
  const holders = holderIds ? new Set(holderIds.map(String)) : null;
  const normalized = normalizeCanonicalAuthoritySection(section);
  return createCanonicalAuthoritySection({
    gologId: normalized.gologId,
    records: normalized.records.filter(
      (record) =>
        (!resources || resources.has(record.resourceId)) &&
        (!holders || holders.has(record.holderId)) &&
        record.epoch <= maxEpoch,
    ),
  });
}
