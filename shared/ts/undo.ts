/**
 * The one undo/redo primitive for the whole estate. A history is an object you
 * construct, one per editor; the module-level singleton it replaced broke the
 * moment a second editor nested on a page, which tRadio's settings app does by
 * hosting tLib's `PropEditor` inside itself — Ctrl+Z walked the outer app's
 * history and restored state the player couldn't see.
 *
 * Snapshot, not per-key diff: a diff can't express a removal (a deleted id has
 * no "before" to restore to, it has to restore existence), and tUnit's element
 * editor changes the element set. `key` just labels an entry for `remove()`.
 *
 * `.ts` deliberately: UnoCSS never scans plain `.ts`, so no class-shaped string
 * in this prose leaks into a consumer's stylesheet as a dead rule. UI affordance
 * is `internal/shared-ts/ui/undo-redo.tsx`, keyboard binding is `shared/ts/undo-keys.ts`.
 */

/** What one registered store contributes to an entry. */
export interface UndoableOptions<T> {
  /** Snapshot the store. Must return a value that `restore` can consume later. */
  capture: () => T;
  /** Put a snapshot back. Called with a value this tag's own `capture` produced. */
  restore: (snapshot: T) => void;
  /**
   * No-op guard for this tag: return true when two snapshots mean the same
   * thing, so a no-change commit is discarded. Defaults to `Object.is`, which is
   * always false for a freshly-built snapshot — the default never silently
   * discards, a registrant opts in by describing its own equality. A commit is
   * discarded only when every tag in the batch compares equal.
   */
  equal?: (a: T, b: T) => boolean;
}

interface Registered {
  capture: () => unknown;
  restore: (snapshot: unknown) => void;
  equal: (a: unknown, b: unknown) => boolean;
}

/** `tag -> snapshot`, for every tag an entry covers. */
export type UndoSnapshots = Record<string, unknown>;

export interface UndoEntry {
  readonly label: string;
  /**
   * Which thing this entry is about, when that is a meaningful question.
   * Only `remove()` reads it, and `undo()`/`redo()` hand it back so a caller can
   * re-select what just moved.
   */
  readonly key?: string;
  readonly before: UndoSnapshots;
  readonly after: UndoSnapshots;
}

/** What `undo()` / `redo()` report about the entry they applied. */
export interface UndoApplied {
  readonly label: string;
  readonly key?: string;
}

/**
 * Everything a UI needs, in one object, delivered on every change -- the whole
 * state, not just `canUndo`, because a listener given one boolean is never told
 * that redo availability changed and a redo BUTTON wired to it never enables.
 *
 * `dirty` is `canUndo` under the name the question is usually asked in: "is there
 * anything worth prompting about before I throw this away".
 */
export interface UndoState {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly dirty: boolean;
  /** Label of the entry `undo()` would apply, or null. */
  readonly undoLabel: string | null;
  /** Label of the entry `redo()` would apply, or null. */
  readonly redoLabel: string | null;
  readonly undoDepth: number;
  readonly redoDepth: number;
}

export type UndoListener = (state: UndoState) => void;

export const UNDO_LIMIT_DEFAULT = 100;

export interface UndoHistoryOptions {
  /** Entries kept before the oldest is dropped. Default 100. */
  limit?: number;
  /** Shown in `diagnostics()` and by the keyboard registry. Not behavioural. */
  label?: string;
  /**
   * Drain the host framework's pending writes so a snapshot taken right after a
   * mutation observes it. Without this, redo silently restores the pre-edit
   * state: a Solid 2 store write isn't readable through the proxy in the tick it
   * was made, and `with()` is push->mutate->commit in one tick, so `after`
   * always equalled `before`. Undo and the dirty flag were unaffected (only
   * redo reads `after`), and batches spanning ticks were always correct — which
   * is why this went unnoticed everywhere at once. Injected, not imported, to
   * keep this module framework-agnostic. Pinned by tLS's
   * `tests/undo-redo-roundtrip.test.ts`, control included.
   */
  settle?: () => void;
}

interface PendingBatch {
  label: string;
  key?: string;
  tags: Set<string>;
  before: UndoSnapshots;
}

const strictEqual = (a: unknown, b: unknown) => Object.is(a, b);

export class UndoHistory {
  readonly limit: number;
  readonly label: string;

  private readonly registry = new Map<string, Registered>();
  private readonly listeners = new Set<UndoListener>();
  private readonly settle: () => void;
  private past: UndoEntry[] = [];
  private future: UndoEntry[] = [];
  private pending: PendingBatch | null = null;

  constructor(options: UndoHistoryOptions = {}) {
    this.limit = Math.max(1, options.limit ?? UNDO_LIMIT_DEFAULT);
    this.label = options.label ?? "undo";
    this.settle = options.settle ?? (() => {});
  }

  // Registration

  /**
   * Declare a store this history can snapshot. Call once per store at init, or
   * once per element for an editor whose elements come and go — the layout
   * editor registers `layout:<key>` per component and disposes it when the host
   * withdraws that component. Returns an unregister function, safe to call
   * twice; an entry mentioning an unregistered tag skips it on restore rather
   * than throwing, which is why the layout editor pairs it with `remove(key)`.
   */
  register<T>(tag: string, undoable: UndoableOptions<T>): () => void {
    const entry: Registered = {
      capture: undoable.capture as () => unknown,
      restore: undoable.restore as (snapshot: unknown) => void,
      equal: (undoable.equal ?? strictEqual) as (a: unknown, b: unknown) => boolean,
    };
    this.registry.set(tag, entry);
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      if (this.registry.get(tag) === entry) this.registry.delete(tag);
    };
  }

  registeredTags(): string[] {
    return [...this.registry.keys()];
  }

  // Recording

  /**
   * Open (or extend) a batch. Call BEFORE mutating. Calling again with the same
   * `label` and `key` EXTENDS the open batch rather than starting a new one,
   * which is how a drag or a wheel burst collapses into one entry; a different
   * label or key closes the open batch first.
   */
  push(label: string, tags: string[], key?: string): void {
    // Settle before capturing `before`, same reason commit() settles before
    // `after`: an unflushed outside write would otherwise leak into this batch.
    this.settle();
    const open = this.pending;
    if (open && open.label === label && open.key === key) {
      for (const tag of tags) {
        if (open.tags.has(tag)) continue;
        open.tags.add(tag);
        const registered = this.registry.get(tag);
        if (registered) open.before[tag] = registered.capture();
      }
      return;
    }
    if (open) this.commit();
    this.pending = { label, key, tags: new Set(tags), before: this.captureAll(tags) };
    this.emit();
  }

  /** Close the open batch, pushing one entry — unless nothing changed. */
  commit(): void {
    if (!this.pending) return;
    // Settle before `after` is captured — see UndoHistoryOptions.settle.
    this.settle();
    const open = this.pending;
    if (!open) return;
    this.pending = null;
    const after = this.captureAll(open.tags);
    if (this.unchanged(open.before, after)) {
      // Redo stack stays intact: a gesture that ended where it started is not
      // a new branch of history.
      this.emit();
      return;
    }
    const entry: UndoEntry = { label: open.label, before: open.before, after };
    this.past.push(open.key === undefined ? entry : { ...entry, key: open.key });
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
    this.emit();
  }

  /**
   * Throw the open batch away without recording it, for a gesture the user
   * cancelled and the caller has already reverted. Not the same as `commit()` on
   * an unchanged batch: `abort()` makes no claim about the current state, so it
   * does not need `equal` to be implemented.
   */
  abort(): void {
    if (!this.pending) return;
    this.pending = null;
    this.emit();
  }

  /** `push` + `fn` + `commit`, for a one-shot mutation. Returns `fn`'s result. */
  with<T>(label: string, tags: string[], fn: () => T, key?: string): T {
    this.push(label, tags, key);
    try {
      return fn();
    } finally {
      this.commit();
    }
  }

  // Travel

  /** Apply the previous state. Returns what it applied, or null. */
  undo(): UndoApplied | null {
    this.commit();
    const entry = this.past.pop();
    if (!entry) return null;
    this.restoreAll(entry.before);
    this.future.push(entry);
    this.emit();
    return { label: entry.label, key: entry.key };
  }

  /** Re-apply the state an `undo()` took away. Returns what it applied, or null. */
  redo(): UndoApplied | null {
    const entry = this.future.pop();
    if (!entry) return null;
    this.restoreAll(entry.after);
    this.past.push(entry);
    this.emit();
    return { label: entry.label, key: entry.key };
  }

  // Eviction

  /**
   * Drop every entry about `key` from both stacks — for a key the host
   * withdrew, not a user-initiated delete (which is an ordinary, undoable edit).
   * An open batch for that key is aborted for the same reason.
   */
  remove(key: string): void {
    const before = this.past.length + this.future.length;
    this.past = this.past.filter((entry) => entry.key !== key);
    this.future = this.future.filter((entry) => entry.key !== key);
    const hadPending = this.pending?.key === key;
    if (hadPending) this.pending = null;
    if (hadPending || before !== this.past.length + this.future.length) this.emit();
  }

  /** Forget everything. Call on editor open, close and save. */
  clear(): void {
    this.past = [];
    this.future = [];
    this.pending = null;
    this.emit();
  }

  // State

  canUndo(): boolean {
    return this.past.length > 0 || this.pending !== null;
  }

  canRedo(): boolean {
    return this.future.length > 0;
  }

  /** "Is there anything to lose." The prompt-before-discard question. */
  isDirty(): boolean {
    return this.canUndo();
  }

  undoLabel(): string | null {
    return this.pending?.label ?? this.past[this.past.length - 1]?.label ?? null;
  }

  redoLabel(): string | null {
    return this.future[this.future.length - 1]?.label ?? null;
  }

  state(): UndoState {
    const canUndo = this.canUndo();
    return {
      canUndo,
      canRedo: this.canRedo(),
      dirty: canUndo,
      undoLabel: this.undoLabel(),
      redoLabel: this.redoLabel(),
      undoDepth: this.past.length,
      redoDepth: this.future.length,
    };
  }

  /**
   * Subscribe to every change. Returns an unsubscribe, safe to call twice.
   *
   * The listener is called immediately with the current state, so a UI that
   * mounts after the first edit is not left showing a stale pair of buttons.
   */
  onChange(listener: UndoListener): () => void {
    this.listeners.add(listener);
    listener(this.state());
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      this.listeners.delete(listener);
    };
  }

  diagnostics(): {
    label: string;
    limit: number;
    tags: string[];
    pending: string | null;
  } & UndoState {
    return {
      label: this.label,
      limit: this.limit,
      tags: this.registeredTags(),
      pending: this.pending?.label ?? null,
      ...this.state(),
    };
  }

  // Internals

  private captureAll(tags: Iterable<string>): UndoSnapshots {
    const snapshots: UndoSnapshots = {};
    for (const tag of tags) {
      const registered = this.registry.get(tag);
      if (registered) snapshots[tag] = registered.capture();
    }
    return snapshots;
  }

  private restoreAll(snapshots: UndoSnapshots): void {
    for (const [tag, snapshot] of Object.entries(snapshots)) {
      this.registry.get(tag)?.restore(snapshot);
    }
  }

  /** True when every tag the batch covers compares equal before and after. */
  private unchanged(before: UndoSnapshots, after: UndoSnapshots): boolean {
    const tags = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const tag of tags) {
      const registered = this.registry.get(tag);
      // A tag that went away mid-batch cannot be compared, and guessing "equal"
      // would silently drop the rest of the batch with it.
      if (!registered) return false;
      if (!registered.equal(before[tag], after[tag])) return false;
    }
    return true;
  }

  private emit(): void {
    if (this.listeners.size === 0) return;
    const state = this.state();
    for (const listener of [...this.listeners]) listener(state);
  }
}

/** Convenience for the common `new UndoHistory({...})`, so a call site reads as a verb. */
export function createUndoHistory(options?: UndoHistoryOptions): UndoHistory {
  return new UndoHistory(options);
}
