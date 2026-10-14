/**
 * One owner of Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y for the whole page.
 *
 * Deliberately the same shape as `escape-layer.ts`, for the same reason: tRadio's
 * settings app hosts tLib's shared `PropEditor` inside itself, so two raw
 * listeners means one Ctrl+Z undoes in both. Resolution is `depth` first, then
 * newest-registered-first; `active()` lets a mounted but hidden editor stand down.
 *
 * `ignoreWhenTyping` defaults to TRUE here, unlike the Escape registry: inside a
 * text field Ctrl+Z is the browser's own per-field undo, and taking it away is
 * strictly worse than having no editor-level undo, because the player has no other
 * way to take back a typo and nothing visible says the key was consumed.
 *
 * Auto-repeat does not travel. Each step restores a snapshot and queues a preview
 * across the NUI boundary, so a 30/second repeat empties the stack faster than the
 * player can see where it went. The key is still `preventDefault`ed on a repeat.
 *
 * No `stopPropagation`, same as the Escape registry: what other code tests is
 * `defaultPrevented`.
 *
 * It is `.ts` deliberately -- no markup, and no class names reachable by UnoCSS's
 * scanner. The buttons live in `shared/ts/ui/undo-redo.tsx`.
 */

import type { UndoHistory } from "./undo";

export type UndoAction = "undo" | "redo";

/** The subset of `KeyboardEvent` this registry reads. Injectable so tests drive the real thing. */
export interface UndoKeyEvent {
  readonly key: string;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
  readonly altKey?: boolean;
  readonly repeat?: boolean;
  readonly defaultPrevented: boolean;
  readonly target?: unknown;
  preventDefault(): void;
}

export interface UndoKeyTarget {
  addEventListener(type: string, listener: (event: UndoKeyEvent) => void, capture?: boolean): void;
  removeEventListener(
    type: string,
    listener: (event: UndoKeyEvent) => void,
    capture?: boolean
  ): void;
}

export interface UndoScopeOptions {
  /** The history this scope drives. */
  history: UndoHistory;
  /**
   * Whether this scope is eligible right now. A mounted-but-hidden editor must
   * return false or it shadows the host that should be receiving the key.
   * Default: always eligible.
   */
  active?: () => boolean;
  /** Larger wins. Equal depths resolve newest-first. Default 0. */
  depth?: number;
  /** Skip this scope for this press — the general case of `ignoreWhenTyping`. */
  blocked?: (event: UndoKeyEvent) => boolean;
  /** Stand down while focus is in a text field, leaving its native undo alone. Default true. */
  ignoreWhenTyping?: boolean;
  /** Act on every keydown of a held key rather than once per press. Default false. */
  allowRepeat?: boolean;
  /** Run instead of `history.undo()`. For an editor that has to settle a gesture first. */
  onUndo?: () => void;
  /** Run instead of `history.redo()`. */
  onRedo?: () => void;
  /** Shown in `undoKeyDiagnostics()`. Not used for behaviour. */
  label?: string;
}

interface Scope extends UndoScopeOptions {
  seq: number;
}

const TYPING_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

function isTyping(target: unknown): boolean {
  if (!target || typeof target !== "object") return false;
  const node = target as { tagName?: unknown; isContentEditable?: unknown };
  if (typeof node.tagName === "string" && TYPING_TAGS.has(node.tagName.toUpperCase())) return true;
  return node.isContentEditable === true;
}

/**
 * Which action a key press means, or null if it is not an undo shortcut. `meta`
 * is accepted alongside `ctrl` because the gallery and the studio run in a
 * desktop browser; in CEF only Ctrl exists. Alt is rejected -- Ctrl+Alt+Z is a
 * different press and belongs to whatever claims it.
 */
export function matchUndoKey(event: UndoKeyEvent): UndoAction | null {
  if (event.altKey) return null;
  if (!event.ctrlKey && !event.metaKey) return null;
  const key = event.key?.toLowerCase();
  if (key === "y") return "redo";
  if (key === "z") return event.shiftKey ? "redo" : "undo";
  return null;
}

export class UndoKeyRegistry {
  private readonly target: UndoKeyTarget;
  private readonly scopes = new Set<Scope>();
  private seq = 0;
  private attached = false;

  constructor(target: UndoKeyTarget) {
    this.target = target;
  }

  /** Register a scope. The returned function unregisters it and is safe to call twice. */
  add(options: UndoScopeOptions): () => void {
    const scope: Scope = { ...options, seq: ++this.seq };
    this.scopes.add(scope);
    this.attach();
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      this.scopes.delete(scope);
      this.detachIfIdle();
    };
  }

  /**
   * The scope that owns `event`, i.e. the innermost eligible one. With no event
   * the event-dependent predicates cannot be evaluated and are treated as not
   * blocking; that path is for diagnostics, never for a decision.
   */
  resolve(event?: UndoKeyEvent): Scope | null {
    let best: Scope | null = null;
    for (const scope of this.scopes) {
      if (scope.active && !scope.active()) continue;
      if (event) {
        if ((scope.ignoreWhenTyping ?? true) && isTyping(event.target)) continue;
        if (scope.blocked?.(event)) continue;
      }
      const depth = scope.depth ?? 0;
      const bestDepth = best?.depth ?? 0;
      if (!best || depth > bestDepth || (depth === bestDepth && scope.seq > best.seq)) best = scope;
    }
    return best;
  }

  /** Drive one press. Exported shape so a host with its own listener can delegate. */
  handle(event: UndoKeyEvent): UndoAction | null {
    if (event.defaultPrevented) return null;
    const action = matchUndoKey(event);
    if (!action) return null;
    const scope = this.resolve(event);
    if (!scope) return null;
    // Claimed either way: the browser must not also get it on a repeat, or a
    // held Ctrl+Z starts undoing in the page while the editor is declining to.
    event.preventDefault();
    if (event.repeat && !(scope.allowRepeat ?? false)) return null;
    if (action === "undo") {
      if (scope.onUndo) scope.onUndo();
      else scope.history.undo();
    } else {
      if (scope.onRedo) scope.onRedo();
      else scope.history.redo();
    }
    return action;
  }

  diagnostics(): {
    scopes: { label: string; depth: number; active: boolean }[];
    attached: boolean;
    owner: string | null;
  } {
    const owner = this.resolve();
    return {
      scopes: [...this.scopes].map((scope) => ({
        label: scope.label ?? `scope#${scope.seq}`,
        depth: scope.depth ?? 0,
        active: scope.active ? scope.active() : true,
      })),
      attached: this.attached,
      owner: owner ? (owner.label ?? `scope#${owner.seq}`) : null,
    };
  }

  /** Dispose everything. Tests and hot reload. */
  reset(): void {
    this.scopes.clear();
    this.detachIfIdle();
  }

  private attach(): void {
    if (this.attached) return;
    this.attached = true;
    this.target.addEventListener("keydown", this.onKeyDown, false);
  }

  private detachIfIdle(): void {
    if (!this.attached || this.scopes.size > 0) return;
    this.attached = false;
    this.target.removeEventListener("keydown", this.onKeyDown, false);
  }

  private readonly onKeyDown = (event: UndoKeyEvent): void => {
    this.handle(event);
  };
}

// The page-wide registry

let singleton: UndoKeyRegistry | null = null;

/**
 * The registry bound to `window`. Created on first use so importing this module
 * in a non-DOM runner costs nothing and throws nothing.
 *
 * A registry of SCOPES, not a shared history. It is the one thing here that is
 * page-global, and it has to be: there is one keyboard.
 */
export function undoKeys(): UndoKeyRegistry {
  if (!singleton) {
    const target = globalThis as unknown as UndoKeyTarget;
    if (typeof target.addEventListener !== "function") {
      throw new Error("undoKeys() needs a DOM; construct an UndoKeyRegistry instead");
    }
    singleton = new UndoKeyRegistry(target);
  }
  return singleton;
}

/**
 * Bind Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y to a history on the page-wide registry.
 *
 * In Solid 2 return the disposer from an `onSettled` callback — that return
 * value *is* the cleanup, and `onCleanup` inside that phase is forbidden.
 *
 *     onSettled(() => createUndoScope({ history, depth: 1, active: () => props.open }));
 */
export function createUndoScope(options: UndoScopeOptions): () => void {
  return undoKeys().add(options);
}

/** What the registry thinks is going on. For probes and galleries, not behaviour. */
export function undoKeyDiagnostics() {
  return undoKeys().diagnostics();
}
