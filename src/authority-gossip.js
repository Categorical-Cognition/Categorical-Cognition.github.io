import { normalizePeerContext } from "./peer-context.js";
import { cloneStoreValue } from "./store-utils.js";
import {
  authoritySectionDigest,
  compareCanonicalAuthorityRecords,
  createCanonicalAuthoritySection,
  normalizeCanonicalAuthorityRecord,
  numericOrNull,
} from "./canonical-authority-section.js";

export const AUTHORITY_GOSSIP_FORMAT = "golog.authority-gossip";
export const AUTHORITY_GOSSIP_VERSION = 1;
export const AUTHORITY_GOSSIP_EVENT = "authority:gossip";
export const AUTHORITY_GOSSIP_MERGED_EVENT = "authority:gossip-merged";

export {
  canonicalAuthorityRecordKey as authorityRecordKey,
  authorityRecordDominates,
} from "./canonical-authority-section.js";

export function normalizeAuthorityRecord(record = {}, defaults = {}) {
  const observedAt =
    numericOrNull(record.observedAt) ??
    numericOrNull(defaults.observedAt) ??
    Date.now();
  return normalizeCanonicalAuthorityRecord({
    ...record,
    acquiredAt: record.acquiredAt ?? observedAt,
  });
}

export function normalizeAuthorityGossipSnapshot(snapshot = {}) {
  if (snapshot.format !== AUTHORITY_GOSSIP_FORMAT) {
    throw new Error("Unsupported authority gossip format");
  }
  if (snapshot.version !== undefined && snapshot.version !== AUTHORITY_GOSSIP_VERSION) {
    throw new Error("Unsupported authority gossip version");
  }
  const sourcePeer = normalizePeerContext(snapshot.sourcePeer ?? snapshot.peer ?? {});
  const observedAt = numericOrNull(snapshot.observedAt) ?? Date.now();
  const records = (snapshot.records ?? [])
    .map((record) => normalizeAuthorityRecord(record, { sourcePeer, observedAt }))
    .sort(compareAuthorityRecords);
  const section = createCanonicalAuthoritySection({
    gologId: snapshot.gologId,
    records,
  });
  return {
    format: AUTHORITY_GOSSIP_FORMAT,
    version: AUTHORITY_GOSSIP_VERSION,
    gologId: snapshot.gologId ?? null,
    sourcePeer,
    observedAt,
    sequence: numericOrNull(snapshot.sequence) ?? 0,
    digest: section.digest,
    records: cloneStoreValue(section.records),
    section,
    table: snapshot.table ? cloneStoreValue(snapshot.table) : null,
  };
}

export function compareAuthorityRecords(first, second) {
  return compareCanonicalAuthorityRecords(first, second);
}

export function authorityDigest({ gologId = null, records = [] } = {}) {
  return authoritySectionDigest({ gologId, records });
}

export function createAuthorityGossipSnapshot({
  gologId,
  peer,
  claims = [],
  tombstones = [],
  table = null,
  sequence = 0,
  observedAt = Date.now(),
} = {}) {
  const sourcePeer = normalizePeerContext(peer ?? {});
  const activeRecords = claims.map((claim) =>
    normalizeAuthorityRecord(
      {
        ...claim,
        status: "active",
      },
      { sourcePeer, observedAt },
    ),
  );
  const releasedRecords = tombstones.map((record) =>
    normalizeAuthorityRecord(
      {
        ...record,
        status: "released",
      },
      { sourcePeer, observedAt },
    ),
  );
  const records = [...activeRecords, ...releasedRecords].sort(compareAuthorityRecords);
  const section = createCanonicalAuthoritySection({ gologId, records });
  return {
    format: AUTHORITY_GOSSIP_FORMAT,
    version: AUTHORITY_GOSSIP_VERSION,
    gologId,
    sourcePeer,
    observedAt,
    sequence,
    digest: section.digest,
    records: cloneStoreValue(section.records),
    section,
    table: table ? cloneStoreValue(table) : null,
  };
}
