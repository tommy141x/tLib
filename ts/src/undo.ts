/**
 * Undo/Redo system — fully decoupled from stores via registry pattern.
 *
 * Each store registers itself with `registerUndoable(tag, capture, restore)`.
 * Components call `withUndo(label, tags, fn)` for simple mutations, or
 * `pushUndo(label, tags)` / `commitUndo()` for batched operations (drag paint, gizmo drag).
 *
 * Undo entries store per-store snapshots (before + after) using structuredClone.
 * Restoring uses each store's own restore function (typically SolidJS reconcile).
 */

// ── Registry ──

type SnapshotFn = () => unknown;
type RestoreFn = (snapshot: unknown) => void;

const registry = new Map<string, { capture: SnapshotFn; restore: RestoreFn }>();

/** Register a store's undoable state. Called once per store at module init. */
export function registerUndoable(tag: string, capture: SnapshotFn, restore: RestoreFn): void {
  registry.set(tag, { capture, restore });
}

// ── Types ──

interface StoreSnapshots {
  [tag: string]: unknown;
}

interface UndoEntry {
  label: string;
  before: StoreSnapshots;
  after: StoreSnapshots;
}

// ── State ──

const MAX_HISTORY = 100;

let undoStack: UndoEntry[] = [];
let redoStack: UndoEntry[] = [];
let pendingBatch: { label: string; tags: Set<string>; before: StoreSnapshots } | null = null;

// ── Internal ──

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
}

// ── Public API ──

/**
 * Start (or extend) an undo batch. Call BEFORE mutating.
 * If called again with the same label while a batch is open, the batch is
 * extended to include any new store tags without re-capturing "before".
 * This is how drag-painting batches many cell edits into one undo entry.
 */
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

/** Finalize the current batch (capture "after" snapshot, push entry). */
export function commitUndo(): void {
  commitBatch();
}

/** Convenience: wraps a synchronous mutation in a single undo checkpoint. */
export function withUndo(label: string, tags: string[], fn: () => void): void {
  pushUndo(label, tags);
  fn();
  commitUndo();
}

/** Undo the most recent change. */
export function undo(): void {
  if (pendingBatch) commitBatch();
  const entry = undoStack.pop();
  if (!entry) return;
  restoreStores(entry.before);
  redoStack.push(entry);
}

/** Redo the most recently undone change. */
export function redo(): void {
  const entry = redoStack.pop();
  if (!entry) return;
  restoreStores(entry.after);
  undoStack.push(entry);
}

/** Discard all history (call on editor open/close/save). */
export function clearHistory(): void {
  undoStack = [];
  redoStack = [];
  pendingBatch = null;
}

export function canUndo(): boolean {
  return undoStack.length > 0 || pendingBatch !== null;
}
export function canRedo(): boolean {
  return redoStack.length > 0;
}
