export const GOLOG_PATCH_HISTORY_FORMAT = "golog.patch-history";
export const GOLOG_PATCH_HISTORY_VERSION = 1;
export const GOLOG_PATCHES_APPLIED_EVENT = "workspace:patches-applied";

const MAX_HISTORY_TRANSACTIONS = 200;

export function clonePatchValue(value) {
  if (value?.isVector3) {
    return [value.x, value.y, value.z];
  }
  if (value?.isVector2) {
    return [value.x, value.y];
  }
  if (Array.isArray(value)) {
    return value.map((entry) => clonePatchValue(entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, clonePatchValue(entry)]),
    );
  }
  return value ?? null;
}

export function patchValuesEqual(first, second) {
  const left = clonePatchValue(first);
  const right = clonePatchValue(second);
  return JSON.stringify(left) === JSON.stringify(right);
}

function encodePointerSegment(value) {
  return String(value).replaceAll("~", "~0").replaceAll("/", "~1");
}

function decodePointerSegment(value) {
  return String(value).replaceAll("~1", "/").replaceAll("~0", "~");
}

export function buildGologPatchPath({
  gologId,
  collection,
  objectId,
  property = null,
}) {
  const segments = ["gologs", gologId, collection, objectId].map(
    encodePointerSegment,
  );
  if (property) {
    segments.push(encodePointerSegment(property));
  }
  return `/${segments.join("/")}`;
}

export function parseGologPatchPath(path) {
  const segments = String(path ?? "")
    .split("/")
    .slice(1)
    .map(decodePointerSegment);
  if (segments.length < 4 || segments[0] !== "gologs") {
    throw new Error(`Unsupported golog patch path: ${path}`);
  }
  return {
    gologId: segments[1],
    collection: segments[2],
    objectId: segments[3],
    property: segments[4] ?? null,
  };
}

export function normalizePatchOperation(operation) {
  return {
    op: operation.op ?? "replace",
    path: String(operation.path),
    value: clonePatchValue(operation.value),
  };
}

function normalizeTransaction(transaction, fallbackId) {
  return {
    id: String(transaction.id ?? fallbackId),
    revision: Number(transaction.revision ?? 0),
    createdAt: Number(transaction.createdAt ?? Date.now()),
    label: String(transaction.label ?? "Patch"),
    coalesceKey: transaction.coalesceKey ?? null,
    patches: (transaction.patches ?? []).map(normalizePatchOperation),
    inverse: (transaction.inverse ?? []).map(normalizePatchOperation),
  };
}

export function normalizePatchHistory(history) {
  if (!history) {
    return {
      format: GOLOG_PATCH_HISTORY_FORMAT,
      version: GOLOG_PATCH_HISTORY_VERSION,
      revision: 0,
      undo: [],
      redo: [],
    };
  }
  if (history.format !== GOLOG_PATCH_HISTORY_FORMAT) {
    throw new Error(
      `Unsupported patch history format: ${history.format ?? "missing"}`,
    );
  }
  if (history.version !== GOLOG_PATCH_HISTORY_VERSION) {
    throw new Error(
      `Unsupported patch history version: ${history.version ?? "missing"}`,
    );
  }
  return {
    format: GOLOG_PATCH_HISTORY_FORMAT,
    version: GOLOG_PATCH_HISTORY_VERSION,
    revision: Number(history.revision ?? 0),
    undo: (history.undo ?? []).map((transaction, index) =>
      normalizeTransaction(transaction, `undo-${index + 1}`),
    ),
    redo: (history.redo ?? []).map((transaction, index) =>
      normalizeTransaction(transaction, `redo-${index + 1}`),
    ),
  };
}

export class WorkspacePatchHistory {
  constructor({ workspace, maxTransactions = MAX_HISTORY_TRANSACTIONS }) {
    this.workspace = workspace;
    this.maxTransactions = maxTransactions;
    this.revision = 0;
    this.undoStack = [];
    this.redoStack = [];
    this.dragDrafts = new Map();
    this.applyingDepth = 0;
    this.suspendDepth = 0;
  }

  get isApplying() {
    return this.applyingDepth > 0 || this.suspendDepth > 0;
  }

  canUndo() {
    return this.undoStack.length > 0;
  }

  canRedo() {
    return this.redoStack.length > 0;
  }

  summary() {
    return {
      revision: this.revision,
      canUndo: this.canUndo(),
      canRedo: this.canRedo(),
      undoCount: this.undoStack.length,
      redoCount: this.redoStack.length,
      lastUndoLabel: this.undoStack.at(-1)?.label ?? null,
      lastRedoLabel: this.redoStack.at(-1)?.label ?? null,
    };
  }

  snapshot() {
    return {
      format: GOLOG_PATCH_HISTORY_FORMAT,
      version: GOLOG_PATCH_HISTORY_VERSION,
      revision: this.revision,
      undo: this.undoStack.map((transaction) => clonePatchValue(transaction)),
      redo: this.redoStack.map((transaction) => clonePatchValue(transaction)),
    };
  }

  restore(history) {
    const normalized = normalizePatchHistory(history);
    this.revision = normalized.revision;
    this.undoStack = normalized.undo;
    this.redoStack = normalized.redo;
    this.dragDrafts.clear();
    this.emitChanged();
  }

  clear() {
    this.revision = 0;
    this.undoStack = [];
    this.redoStack = [];
    this.dragDrafts.clear();
    this.emitChanged();
  }

  suspend(callback) {
    this.suspendDepth += 1;
    try {
      return callback();
    } finally {
      this.suspendDepth -= 1;
    }
  }

  recordChanges({ gologId, label, changes, coalesceKey = null }) {
    if (this.isApplying) {
      return null;
    }

    const filteredChanges = (changes ?? []).filter(
      (change) => !patchValuesEqual(change.before, change.after),
    );
    if (filteredChanges.length === 0) {
      return null;
    }

    const patches = filteredChanges.map((change) =>
      normalizePatchOperation({
        op: "replace",
        path: buildGologPatchPath({
          gologId,
          collection: change.collection,
          objectId: change.objectId,
          property: change.property ?? null,
        }),
        value: change.after,
      }),
    );
    const inverse = [...filteredChanges].reverse().map((change) =>
      normalizePatchOperation({
        op: "replace",
        path: buildGologPatchPath({
          gologId,
          collection: change.collection,
          objectId: change.objectId,
          property: change.property ?? null,
        }),
        value: change.before,
      }),
    );

    return this.recordTransaction({
      label,
      coalesceKey,
      patches,
      inverse,
    });
  }

  recordTransaction(transaction) {
    if (this.isApplying || !transaction?.patches?.length) {
      return null;
    }

    const normalized = normalizeTransaction(
      {
        ...transaction,
        revision: this.revision + 1,
        createdAt: Date.now(),
      },
      `patch-${this.revision + 1}`,
    );

    const last = this.undoStack.at(-1);
    if (normalized.coalesceKey && last?.coalesceKey === normalized.coalesceKey) {
      this.undoStack[this.undoStack.length - 1] = {
        ...last,
        label: normalized.label,
        createdAt: normalized.createdAt,
        revision: normalized.revision,
        patches: normalized.patches,
      };
      this.revision += 1;
      this.redoStack = [];
      this.emitChanged();
      return this.undoStack.at(-1);
    }

    this.revision += 1;
    const committed = {
      ...normalized,
      id: `patch-${this.revision}`,
      revision: this.revision,
    };
    this.undoStack.push(committed);
    if (this.undoStack.length > this.maxTransactions) {
      this.undoStack.shift();
    }
    this.redoStack = [];
    this.emitChanged();
    return committed;
  }

  beginInteraction(store, objectId, snapshot = store.capturePatchSnapshot?.(objectId)) {
    if (this.isApplying) {
      return;
    }
    if (!snapshot || snapshot.objectId !== objectId) {
      return;
    }
    this.dragDrafts.set(this.draftKey(store.gologId, snapshot.objectId), {
      gologId: store.gologId,
      objectId: snapshot.objectId,
      snapshot: clonePatchValue(snapshot),
    });
  }

  endInteractionsForReleased(store, releasedIds) {
    if (this.isApplying) {
      return;
    }
    const released = new Set(releasedIds ?? []);
    for (const [key, draft] of [...this.dragDrafts.entries()]) {
      if (draft.gologId !== store.gologId || !released.has(draft.objectId)) {
        continue;
      }
      this.endInteraction(store, draft.objectId);
    }
  }

  endInteraction(store, objectId, current = store.capturePatchSnapshot?.(objectId)) {
    const key = this.draftKey(store.gologId, objectId), draft = this.dragDrafts.get(key);
    if (!draft || this.isApplying) return;
    this.dragDrafts.delete(key);
    if (!current || current.objectId !== objectId || current.collection !== draft.snapshot.collection) return;
    const changes = Object.entries(draft.snapshot.properties).flatMap(([property, before]) => {
      const after = current.properties[property];
      return patchValuesEqual(before, after) ? [] : [{
        collection: current.collection, objectId, property, before, after,
      }];
    });
    return this.recordChanges({ gologId: store.gologId, label: `Move ${objectId}`, changes });
  }

  undo() {
    const transaction = this.undoStack.pop();
    if (!transaction) {
      return null;
    }
    try {
      this.applyOperations(transaction.inverse);
    } catch (error) {
      this.undoStack.push(transaction);
      throw error;
    }
    this.redoStack.push(transaction);
    this.emitChanged();
    return transaction;
  }

  redo() {
    const transaction = this.redoStack.pop();
    if (!transaction) {
      return null;
    }
    try {
      this.applyOperations(transaction.patches);
    } catch (error) {
      this.redoStack.push(transaction);
      throw error;
    }
    this.undoStack.push(transaction);
    this.emitChanged();
    return transaction;
  }

  applyOperations(operations) {
    this.applyingDepth += 1;
    let patchCount = 0;
    try {
      for (const operation of operations ?? []) {
        this.applyOperation(operation);
        patchCount += 1;
      }
    } finally {
      this.applyingDepth -= 1;
    }
    // Direct patches, undo, and redo mutate outside the relay operation stream.
    // History recorded from ordinary commits does not cross this boundary.
    if (patchCount > 0 && this.applyingDepth === 0) {
      this.workspace.bus.emit(GOLOG_PATCHES_APPLIED_EVENT, { patchCount });
    }
  }

  applyOperation(operation) {
    if (operation.op !== "replace") {
      throw new Error(`Unsupported golog patch operation: ${operation.op}`);
    }
    const target = parseGologPatchPath(operation.path);
    const golog = this.workspace.gologs.get(target.gologId);
    if (!golog) {
      throw new Error(`Patch target golog does not exist: ${target.gologId}`);
    }
    return golog.state.applyPatchOperation({
      ...target,
      op: operation.op,
      value: clonePatchValue(operation.value),
    });
  }

  draftKey(gologId, objectId) {
    return `${gologId}:${objectId}`;
  }

  emitChanged() {
    this.workspace.bus.emit("workspace:history-changed", this.summary());
  }
}
