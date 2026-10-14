/**
 * One Escape owner for the whole page: a registry (so depth is explicit and a
 * layer need not be an element), capture-sample-then-bubble-decide (so one press
 * dismisses one thing), and an internal-first/`active` contract. Five resources
 * had arrived at three different mechanisms and each knew something the others
 * did not; this is all three at once.
 *
 * The capture sample is the non-obvious half: a panel that closes itself on
 * keydown would otherwise leave the keyup looking at a page with nothing open and
 * dismiss a second thing underneath.
 *
 * There is no `stopPropagation`: with one registry there are no sibling handlers
 * left to stop, and what other code tests is `defaultPrevented`. Overlays that
 * cannot register -- Ark's popovers and listboxes -- are handled from the other
 * direction by `registerEscapeGuard`.
 *
 * It is `.ts` deliberately: UnoCSS never scans plain `.ts`, so the class-shaped
 * strings in this prose cannot leak into a bundle as generated CSS.
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
   * Evaluated once per press, in the capture phase. A blocked layer is SKIPPED
   * during resolution, so the layer below it can own the key instead -- the
   * difference between "not mine" and "mine, do nothing".
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

/**
 * The subset of `KeyboardEvent` this registry reads, plus what it HANDS ON. The
 * modifiers are not read here; they are declared because `blocked` is given this
 * event and a layer that declines Ctrl/Alt-modified presses should be able to say
 * so without casting back to `KeyboardEvent`.
 */
export interface EscapeKeyEvent {
  readonly key: string;
  readonly repeat?: boolean;
  readonly defaultPrevented: boolean;
  readonly target?: unknown;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly altKey?: boolean;
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
   * Declare that something outside the registry owns Escape right now, for a
   * third-party overlay that will never call `add`. A guard that returns true
   * makes the whole registry stand down for that press, in both phases.
   *
   * It is called once, in the capture phase, so a DOM probe sees the page as it
   * was before anything reacted. A guard must not match an overlay that registers
   * a layer of its own, or the registry stands down and that layer never fires.
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
   * capture handler. With no event the event-dependent predicates cannot be
   * evaluated and are treated as not blocking; that path is for diagnostics,
   * never for a decision.
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

  // The three listeners

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

// The page-wide singleton

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
