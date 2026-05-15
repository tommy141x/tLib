// undo/redo — stores register with registerUndoable(), then use
// withUndo() for one-shot mutations or pushUndo()/commitUndo() for batched ops (drag, paint).

type SnapshotFn = () => unknown;
type RestoreFn = (snapshot: unknown) => void;

const registry = new Map<string, { capture: SnapshotFn; restore: RestoreFn }>();

// call once per store at init
export function registerUndoable(tag: string, capture: SnapshotFn, restore: RestoreFn): void {
  registry.set(tag, { capture, restore });
}

interface StoreSnapshots {
  [tag: string]: unknown;
}

interface UndoEntry {
  label: string;
  before: StoreSnapshots;
  after: StoreSnapshots;
}

const MAX_HISTORY = 100;

let undoStack: UndoEntry[] = [];
let redoStack: UndoEntry[] = [];
let pendingBatch: { label: string; tags: Set<string>; before: StoreSnapshots } | null = null;

function captureStores(tags: Iterable<string>): StoreSnapshots {
  const snap: StoreSnapshots = {};
  for (const tag of tags) {
    const entry = registry.get(tag);
    if (entry) snap[tag] = entry.capture();
  }
  return snap;
}

function restoreStores(snap: StoreSnapshots): void {
  for (const [tag, data] of Object.entries(snap)) {
    const entry = registry.get(tag);
    if (entry) entry.restore(data);
  }
}

function commitBatch(): void {
  if (!pendingBatch) return;
  const after = captureStores(pendingBatch.tags);
  undoStack.push({
    label: pendingBatch.label,
    before: pendingBatch.before,
    after,
  });
  if (undoStack.length > MAX_HISTORY) undoStack.shift();
  redoStack = [];
  pendingBatch = null;
  emitChange();
}

// call before mutating. calling again with same label extends the batch
// (drag-paint uses this to batch many cell edits into one undo entry)
export function pushUndo(label: string, tags: string[]): void {
  if (pendingBatch && pendingBatch.label === label) {
    // Extend: capture any newly-involved stores
    for (const t of tags) {
      if (!pendingBatch.tags.has(t)) {
        pendingBatch.tags.add(t);
        const entry = registry.get(t);
        if (entry) pendingBatch.before[t] = entry.capture();
      }
    }
    return;
  }
  // New batch — commit any stale pending batch first
  if (pendingBatch) commitBatch();
  pendingBatch = {
    label,
    tags: new Set(tags),
    before: captureStores(tags),
  };
}

export function commitUndo(): void {
  commitBatch();
}

export function withUndo(label: string, tags: string[], fn: () => void): void {
  pushUndo(label, tags);
  fn();
  commitUndo();
}

export function undo(): void {
  if (pendingBatch) commitBatch();
  const entry = undoStack.pop();
  if (!entry) return;
  restoreStores(entry.before);
  redoStack.push(entry);
  emitChange();
}

export function redo(): void {
  const entry = redoStack.pop();
  if (!entry) return;
  restoreStores(entry.after);
  undoStack.push(entry);
  emitChange();
}

// call on editor open/close/save
export function clearHistory(): void {
  undoStack = [];
  redoStack = [];
  pendingBatch = null;
  emitChange();
}

export function canUndo(): boolean {
  return undoStack.length > 0 || pendingBatch !== null;
}
export function canRedo(): boolean {
  return redoStack.length > 0;
}

// ── History change listeners ──────────────────────────────────────────────
type HistoryChangeListener = (dirty: boolean) => void;
const historyListeners: HistoryChangeListener[] = [];

/** Subscribe to undo history changes. Returns an unsubscribe function. */
export function onHistoryChange(listener: HistoryChangeListener): () => void {
  historyListeners.push(listener);
  return () => {
    const i = historyListeners.indexOf(listener);
    if (i >= 0) historyListeners.splice(i, 1);
  };
}

function emitChange(): void {
  const dirty = canUndo();
  for (const fn of historyListeners) fn(dirty);
}
