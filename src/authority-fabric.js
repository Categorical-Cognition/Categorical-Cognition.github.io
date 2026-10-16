import { CompiledAuthorityTable, AUTHORITY_TABLE_BACKENDS } from "./compiled-authority-table.js";
import {
  AUTHORITY_GOSSIP_EVENT,
  AUTHORITY_GOSSIP_MERGED_EVENT,
  createAuthorityGossipSnapshot,
  normalizeAuthorityGossipSnapshot,
} from "./authority-gossip.js";
import {
  authorityRecordDominates,
  canonicalAuthorityRecordKey,
  createCanonicalAuthoritySection,
  normalizeCanonicalAuthorityRecord,
  resolveAuthorityRecords,
} from "./canonical-authority-section.js";
import { compileOperationResourceManifest } from "./operation-resource-manifest.js";
import { normalizePeerContext, peerHolderId } from "./peer-context.js";
import { RESOURCE_CLAIM_RELEASED_EVENT, RESOURCE_CLAIMS_CHANGED_EVENT } from "./resource-claim-manager.js";
import { cloneStoreValue } from "./store-utils.js";

export const AUTHORITY_FABRIC_FORMAT = "golog.authority-fabric";
export const AUTHORITY_FABRIC_VERSION = 1;
export const AUTHORITY_TABLE_REBUILT_EVENT = "authority:table-rebuilt";

export class AuthorityFabric {
  constructor({
    bus = null,
    store = null,
    backend = AUTHORITY_TABLE_BACKENDS.CPU_TYPED_ARRAY,
    table = new CompiledAuthorityTable({ backend }),
    now = () => store?.resourceClaims?.now?.() ?? Date.now(),
  } = {}) {
    this.format = AUTHORITY_FABRIC_FORMAT;
    this.version = AUTHORITY_FABRIC_VERSION;
    this.bus = bus;
    this.store = store;
    this.table = table;
    this.now = now;
    this.dirty = true;
    this.claimRevision = -1;
    // One latest observation per resource/holder. Retain released generations:
    // deleting their evidence could resurrect an older, longer-lived lease.
    this.records = new Map();
    this.nextExpiry = Infinity;
    this.gossipDigests = new Set();
    this.gossipSequence = 0;
    this.conflicts = [];
    this.authoritySection = createCanonicalAuthoritySection({ gologId: store?.gologId ?? null });
    this.unsubscribers = [];
  }

  registerBusHandlers() {
    if (!this.bus || this.unsubscribers.length) return;
    this.unsubscribers.push(
      this.bus.on(RESOURCE_CLAIMS_CHANGED_EVENT, () => this.markDirty()),
      this.bus.on(RESOURCE_CLAIM_RELEASED_EVENT, (release = {}) => this.recordReleaseTombstones(release.claims)),
      this.bus.on(AUTHORITY_GOSSIP_EVENT, (snapshot) => this.ingestGossip(snapshot)),
    );
  }

  markDirty() { this.dirty = true; }

  currentClaims() { return this.store?.resourceClaims?.snapshot?.() ?? []; }

  remember(records = []) {
    let changed = false;
    for (const input of records) {
      const record = normalizeCanonicalAuthorityRecord(input);
      const key = canonicalAuthorityRecordKey(record);
      if (!authorityRecordDominates(record, this.records.get(key))) continue;
      this.records.set(key, record);
      if (record.status === "active") this.nextExpiry = Math.min(this.nextExpiry, record.expiresAt);
      changed = true;
    }
    if (changed) this.markDirty();
    return changed;
  }

  recordReleaseTombstones(claims = []) {
    return this.remember(claims.map((claim) => ({ ...claim, status: "released" })));
  }

  pruneRemoteRecords() {
    const now = this.now();
    if (now < this.nextExpiry) return;
    this.nextExpiry = Infinity;
    for (const [key, record] of this.records) {
      if (record.status !== "active") continue;
      if (record.expiresAt <= now) {
        this.records.set(key, { ...record, status: "released" });
        this.markDirty();
      } else this.nextExpiry = Math.min(this.nextExpiry, record.expiresAt);
    }
  }

  resolve(claims = this.currentClaims(), additional = []) {
    this.pruneRemoteRecords();
    return resolveAuthorityRecords([...claims, ...this.records.values(), ...additional], { now: this.now() });
  }

  mergeClaims(claims = this.currentClaims()) { return this.resolve(claims).claims; }

  activeRemoteClaims() {
    return this.resolve().claims
      .filter((record) => this.records.has(canonicalAuthorityRecordKey(record)))
      .map(cloneStoreValue);
  }

  activeTombstones() {
    this.pruneRemoteRecords();
    return [...this.records.values()].filter((record) => record.status === "released").map(cloneStoreValue);
  }

  rebuildFromClaims(claims = this.currentClaims()) {
    const resolved = this.resolve(claims);
    this.conflicts = resolved.conflicts;
    this.authoritySection = createCanonicalAuthoritySection({
      gologId: this.store?.gologId ?? null,
      records: resolved.records,
    });
    const table = this.table.rebuildFromClaims(resolved.claims);
    this.dirty = false;
    this.claimRevision = this.store?.resourceClaims?.revision ?? this.claimRevision;
    const result = {
      format: this.format,
      version: this.version,
      backend: this.table.backend,
      digest: this.authoritySection.digest,
      authoritySection: this.authoritySection,
      claimCount: claims.length,
      mergedClaimCount: resolved.claims.length,
      remoteClaimCount: resolved.claims.filter((record) => this.records.has(canonicalAuthorityRecordKey(record))).length,
      table,
    };
    this.bus?.emit(AUTHORITY_TABLE_REBUILT_EVENT, cloneStoreValue(result));
    return result;
  }

  refresh() {
    this.store?.resourceClaims?.pruneExpired?.();
    this.pruneRemoteRecords();
    const revision = this.store?.resourceClaims?.revision ?? this.claimRevision;
    return this.dirty || revision !== this.claimRevision ? this.rebuildFromClaims() : null;
  }

  validateManifest(manifest, origin, { requireClaims = true } = {}) {
    const conflict = this.conflicts.find((record) => manifest.writeResources.includes(record.resourceId));
    if (conflict) return { ok: false, reason: "authority-section-mismatch", conflict, backend: this.table.backend };
    const peer = normalizePeerContext(origin);
    const decision = this.table.validateManifest(manifest, peer.isKnown ? peerHolderId(peer) : null);
    if (!requireClaims && decision.reason === "missing-resource-claim") {
      return { ...decision, ok: true, reason: "authority-granted", missingClaimGroup: null };
    }
    return decision;
  }

  validateOperation(operation = {}, { manifest = null, requireClaims = true } = {}) {
    this.refresh();
    return this.validateManifest(manifest ?? compileOperationResourceManifest(operation), operation.origin, { requireClaims });
  }

  validateBatch(entries = []) {
    this.refresh();
    return entries.map((entry) => this.validateManifest(
      entry.manifest ?? compileOperationResourceManifest(entry.operation),
      entry.operation?.origin ?? entry.origin,
    ));
  }

  ingestGossip(snapshot = {}, { emit = true } = {}) {
    const normalized = normalizeAuthorityGossipSnapshot(snapshot);
    if (normalized.gologId && normalized.gologId !== this.store?.gologId) {
      return { ok: false, reason: "wrong-golog", digest: normalized.digest };
    }
    const { conflicts } = this.resolve(this.currentClaims(), normalized.records);
    if (conflicts.length) {
      return {
        ok: false,
        reason: "authority-section-mismatch",
        digest: normalized.digest,
        recordCount: normalized.records.length,
        conflicts: cloneStoreValue(conflicts),
      };
    }
    const changed = this.remember(normalized.records);
    this.store?.resourceClaims?.observeAuthority?.(normalized.records);
    // Digests are diagnostics, never proof that two sections are equal.
    this.gossipDigests.add(normalized.digest);
    if (this.gossipDigests.size > 256) this.gossipDigests.delete(this.gossipDigests.values().next().value);
    this.refresh();
    const result = {
      ok: true,
      reason: changed ? "authority-gossip-merged" : "authority-gossip-observed",
      digest: normalized.digest,
      authoritySection: normalized.section,
      recordCount: normalized.records.length,
      changed,
    };
    if (emit) this.bus?.emit(AUTHORITY_GOSSIP_MERGED_EVENT, cloneStoreValue(result));
    return result;
  }

  createGossipSnapshot({ peer = null } = {}) {
    this.refresh();
    return createAuthorityGossipSnapshot({
      gologId: this.store?.gologId ?? null,
      peer,
      claims: this.authoritySection.records.filter((record) => record.status === "active"),
      tombstones: this.authoritySection.records.filter((record) => record.status === "released"),
      sequence: ++this.gossipSequence,
      observedAt: this.now(),
    });
  }

  snapshot() {
    this.refresh();
    return {
      format: this.format,
      version: this.version,
      authoritySection: cloneStoreValue(this.authoritySection),
      table: this.table.snapshot(),
      remoteClaims: this.activeRemoteClaims(),
      releaseTombstones: this.activeTombstones(),
      gossipDigestCount: this.gossipDigests.size,
    };
  }
}
