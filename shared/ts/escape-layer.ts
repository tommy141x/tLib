/**
 * One Escape owner for the whole page.
 *
 * Five resources had independently arrived at three different mechanisms for
 * the same question — "this key press: is it mine, or does something on top of
 * me own it?" — and each mechanism knew something the others did not:
 *
 * - **tELS** marked its modals with `data-editor-modal` and had the editor
 *   probe the DOM (`editorShortcutBlocked`) for anything modal-shaped before
 *   acting. The marker works, but it is a *global* query: every modal is
 *   equally blocking, so two stacked modals cannot tell which of them is on
 *   top, and a layer that is not an element at all cannot participate.
 * - **tRadio** sampled ownership on `keydown` *capture*, before any handler
 *   ran, and consulted the sample on `keyup`. That is the one insight neither
 *   of the others had, and it is not stylistic: tRadio releases focus on keyup,
 *   so a panel that closes itself on keydown would otherwise leave the keyup
 *   looking at a page with nothing open and hide the radio underneath as well.
 *   One key press, two dismissals.
 * - **tLib's** marketplace browser dismissed its own inner layer (an open
 *   preview) first and only then handed the key to its host, and gated the
 *   whole thing on an `active` prop because the component has two mounts and
 *   only the visible one may react.
 *
 * This module is all three at once: a registry (so depth is explicit and a
 * layer need not be an element), capture-sample-then-bubble-decide (so one
 * press dismisses one thing), and an internal-first/`active` contract.
 *
 * ## Why there is no `stopPropagation` here
 *
 * Three of the copies called it. With one registry there are no sibling
 * handlers left to stop — the decision happens once, in a bubble-phase
 * listener on the target, which is already the last stop. What other code
 * actually tests is `defaultPrevented`, and that is what this sets. Anything
 * still listening for Escape outside the registry (Ark UI's popovers and
 * listboxes, which cannot register) is handled from the other direction, by
 * `registerEscapeGuard`.
 *
 * ## It is `.ts`, deliberately
 *
 * UnoCSS never scans plain `.ts`, so the class-name-shaped strings in these
 * comments cannot leak into a bundle as generated CSS. There is no markup here
 * and there must not be.
 */

export type EscapePhase = "keydown" | "keyup";

export interface EscapeLayerOptions {
  /** Dismiss this layer. Called at most once per key press. */
  onEscape: () => void;
  /**
   * Whether this layer is currently eligible to own Escape. A layer that is
   * mounted but hidden — the marketplace browser on an unselected dialog tab —
   * must return false, or it shadows the host that should be receiving the key.
   * Default: always eligible.
   */
  active?: () => boolean;
  /**
   * Larger wins. Equal depths resolve newest-registered-first, which is the
   * order things were stacked in. Default 0.
   */
  depth?: number;
  /**
   * A chance to consume the key *inside* this layer instead of dismissing it.
   * Return true if it did. This is the marketplace preview: Escape closes the
   * preview, and only a second Escape closes the browser.
   */
  onInternal?: () => boolean;
  /**
   * Which half of the key press acts. Default `"keydown"`. Use `"keyup"` only
   * when the press itself has to be allowed to reach something else first —
   * tRadio's focus release is the only such case in the tree.
   */
  phase?: EscapePhase;
  /** Skip while focus is in a text field. Default false. */
  ignoreWhenTyping?: boolean;
  /**
   * Skip this layer for this press. The layer-level form of a registry guard,
   * and the general case `ignoreWhenTyping` is the common shorthand for: tELS's
   * editor declines Escape while focus is on any interactive control, not just
   * a text field, because its Escape throws a draft away.
   *
   * Evaluated once per press, in the capture phase. A blocked layer is skipped
   * during resolution, so the layer *below* it can own the key instead — which
   * is the difference between "not mine" and "mine, do nothing".
   */
  blocked?: (event: EscapeKeyEvent) => boolean;
  /** Shown in `escapeLayerDiagnostics()`. Not used for behaviour. */
  label?: string;
}

/** The subset of `window` this registry needs. Injectable so tests drive the real registry. */
export interface EscapeTarget {
  addEventListener(
    type: string,
    listener: (event: EscapeKeyEvent) => void,
    capture?: boolean
  ): void;
  removeEventListener(
    type: string,
    listener: (event: EscapeKeyEvent) => void,
    capture?: boolean
  ): void;
}

/** The subset of `KeyboardEvent` this registry reads. */
export interface EscapeKeyEvent {
  readonly key: string;
  readonly repeat?: boolean;
  readonly defaultPrevented: boolean;
  readonly target?: unknown;
  preventDefault(): void;
}

interface Layer extends EscapeLayerOptions {
  seq: number;
}

/** Sampled once per press, in the capture phase, before anything has reacted. */
export type EscapeGuard = (event: EscapeKeyEvent) => boolean;

interface Sample {
  owner: Layer | null;
  guarded: boolean;
  /** Something has already acted on this press, so the keyup must not act again. */
  consumed: boolean;
}

const TYPING_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

function isTyping(target: unknown): boolean {
  if (!target || typeof target !== "object") return false;
  const node = target as { tagName?: unknown; isContentEditable?: unknown };
  if (typeof node.tagName === "string" && TYPING_TAGS.has(node.tagName.toUpperCase())) return true;
  return node.isContentEditable === true;
}

export class EscapeLayerRegistry {
  private readonly target: EscapeTarget;
  private readonly layers = new Set<Layer>();
  private readonly guards = new Set<EscapeGuard>();
  private seq = 0;
  private attached = false;
  private sample: Sample | null = null;

  constructor(target: EscapeTarget) {
    this.target = target;
  }

  /** Register a layer. The returned function unregisters it and is safe to call twice. */
  add(options: EscapeLayerOptions): () => void {
    const layer: Layer = { ...options, seq: ++this.seq };
    this.layers.add(layer);
    this.attach();
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      this.layers.delete(layer);
      // A layer that disposes itself mid-press must not still be the sampled
      // owner of the keyup half, or the key acts on something unmounted.
      if (this.sample?.owner === layer) this.sample.owner = null;
      this.detachIfIdle();
    };
  }

  /**
   * Declare that something outside the registry owns Escape right now.
   *
   * This exists for third-party overlays that will never call `add` — Ark UI
   * popovers, listboxes and menus handle Escape themselves. A guard that
   * returns true makes the whole registry stand down for that press, in both
   * phases, which is what tELS's DOM probe was really expressing.
   *
   * The guard receives the keydown event, because "is this press mine" can
   * legitimately depend on where it landed and tELS's probe reads the target.
   * It is called once, in the capture phase, so a DOM probe sees the page as it
   * was before anything reacted.
   *
   * ⚠️ A guard must not match an overlay that registers a layer of its own, or
   * the registry stands down and that layer never fires. Guards are for the
   * overlays that cannot register.
   */
  addGuard(guard: EscapeGuard): () => void {
    this.guards.add(guard);
    this.attach();
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      this.guards.delete(guard);
      this.detachIfIdle();
    };
  }

  /**
   * The layer that would own Escape for `event`. Called once per press, from the
   * capture handler.
   *
   * With no event the event-dependent predicates (`blocked`,
   * `ignoreWhenTyping`) cannot be evaluated and are treated as not blocking;
   * that path is for diagnostics, never for a decision.
   */
  resolve(event?: EscapeKeyEvent): Layer | null {
    let best: Layer | null = null;
    for (const layer of this.layers) {
      if (layer.active && !layer.active()) continue;
      if (event) {
        if (layer.ignoreWhenTyping && isTyping(event.target)) continue;
        if (layer.blocked?.(event)) continue;
      }
      if (
        !best ||
        (layer.depth ?? 0) > (best.depth ?? 0) ||
        ((layer.depth ?? 0) === (best.depth ?? 0) && layer.seq > best.seq)
      ) {
        best = layer;
      }
    }
    return best;
  }

  private anyGuard(event: EscapeKeyEvent): boolean {
    for (const guard of this.guards) if (guard(event)) return true;
    return false;
  }

  escapeLayerDiagnostics(): {
    layers: { label: string; depth: number; phase: EscapePhase; active: boolean }[];
    guards: number;
    attached: boolean;
    owner: string | null;
  } {
    const owner = this.resolve();
    return {
      layers: [...this.layers].map((layer) => ({
        label: layer.label ?? `layer#${layer.seq}`,
        depth: layer.depth ?? 0,
        phase: layer.phase ?? "keydown",
        active: layer.active ? layer.active() : true,
      })),
      guards: this.guards.size,
      attached: this.attached,
      owner: owner ? (owner.label ?? `layer#${owner.seq}`) : null,
    };
  }

  private attach(): void {
    if (this.attached) return;
    this.attached = true;
    this.target.addEventListener("keydown", this.onCapture, true);
    this.target.addEventListener("keydown", this.onKeyDown, false);
    this.target.addEventListener("keyup", this.onKeyUp, false);
  }

  private detachIfIdle(): void {
    if (!this.attached || this.layers.size > 0 || this.guards.size > 0) return;
    this.attached = false;
    this.sample = null;
    this.target.removeEventListener("keydown", this.onCapture, true);
    this.target.removeEventListener("keydown", this.onKeyDown, false);
    this.target.removeEventListener("keyup", this.onKeyUp, false);
  }

  /** Dispose everything. Tests and hot reload. */
  reset(): void {
    this.layers.clear();
    this.guards.clear();
    this.detachIfIdle();
    this.sample = null;
  }

  // ── The three listeners ───────────────────────────────────────────────────

  /**
   * Capture phase, so this runs before any layer's own handler and before
   * anything that might close a layer. Whatever was on top *at the moment the
   * key went down* is what owns this press, for both halves of it.
   */
  private readonly onCapture = (event: EscapeKeyEvent): void => {
    if (event.key !== "Escape") return;
    // An auto-repeating hold is still the same press: re-sampling would hand
    // ownership to whatever the first repeat's own handler just revealed.
    if (event.repeat && this.sample) return;
    this.sample = { owner: this.resolve(event), guarded: this.anyGuard(event), consumed: false };
  };

  private readonly onKeyDown = (event: EscapeKeyEvent): void => {
    if (event.key !== "Escape") return;
    const sample = this.sample;
    if (!sample) return;
    // A held key arrives as a stream of keydowns sharing one sample. Acting on
    // each of them would dismiss a whole stack of layers from one press, which
    // is the same "one press, two dismissals" failure as the keyup case.
    if (sample.consumed) return;
    // Someone outside the registry owns it. Record that so the keyup half
    // also stands down, then leave the event completely alone.
    if (sample.guarded || event.defaultPrevented) {
      sample.consumed = true;
      return;
    }
    const owner = sample.owner;
    if (!owner || !this.layers.has(owner)) return;
    if ((owner.phase ?? "keydown") !== "keydown") return;
    sample.consumed = true;
    event.preventDefault();
    if (owner.onInternal?.()) return;
    owner.onEscape();
  };

  private readonly onKeyUp = (event: EscapeKeyEvent): void => {
    if (event.key !== "Escape") return;
    const sample = this.sample;
    this.sample = null;
    if (!sample || sample.consumed || sample.guarded || event.defaultPrevented) return;
    const owner = sample.owner;
    if (!owner || !this.layers.has(owner)) return;
    if (owner.phase !== "keyup") return;
    event.preventDefault();
    if (owner.onInternal?.()) return;
    owner.onEscape();
  };
}

// ── The page-wide singleton ─────────────────────────────────────────────────

let singleton: EscapeLayerRegistry | null = null;

/**
 * The registry bound to `window`. Created on first use so importing this module
 * in a non-DOM runner (a test, a build script) costs nothing and throws
 * nothing.
 */
export function escapeLayers(): EscapeLayerRegistry {
  if (!singleton) {
    const target = globalThis as unknown as EscapeTarget;
    if (typeof target.addEventListener !== "function") {
      throw new Error("escapeLayers() needs a DOM; construct an EscapeLayerRegistry instead");
    }
    singleton = new EscapeLayerRegistry(target);
  }
  return singleton;
}

/**
 * Register an Escape layer on the page-wide registry.
 *
 * In Solid 2 return the disposer from an `onSettled` callback — that return
 * value *is* the cleanup, and `onCleanup` inside that phase is forbidden.
 *
 *     onSettled(() => createEscapeLayer({ depth: 1, onEscape: props.onClose }));
 */
export function createEscapeLayer(options: EscapeLayerOptions): () => void {
  return escapeLayers().add(options);
}

/** Declare that something unregisterable owns Escape while `guard()` is true. */
export function registerEscapeGuard(guard: EscapeGuard): () => void {
  return escapeLayers().addGuard(guard);
}

/** What the registry thinks is going on. For probes and galleries, not behaviour. */
export function escapeLayerDiagnostics() {
  return escapeLayers().escapeLayerDiagnostics();
}
