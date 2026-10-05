/**
 * The shared Escape registry, plus a negative control.
 *
 * There is no DOM in this runner, so `FakeTarget` below provides one. It is a
 * harness and not a claim about CEF: all it models is the one thing the
 * registry depends on, which is that a capture listener on the target runs
 * before a bubble listener on that same target. Everything else about the
 * event — `defaultPrevented`, `repeat`, `target` — is passed in explicitly by
 * each scenario rather than simulated.
 *
 * ## The negative controls
 *
 * There are **two**, and the reason is the point. The first draft had one — a
 * first-registered-wins registry — and it *passed* the `active` scenario by
 * accident: the inactive mount happened to be registered second, so picking
 * the first layer picked the right one for the wrong reason. A control that
 * gets a rule right by accident proves nothing about that rule. So each
 * mechanism now has a control that is blind to exactly it:
 *
 * - `FirstWinsRegistry` is depth-blind (and so cannot do stacking).
 * - `StackRegistry` is depth-aware but `active`-blind.
 * - Neither samples on capture, so both fail the one-press-one-dismissal
 *   scenario — that mechanism is the one no naive shape gets right.
 *
 * The real registry must pass every scenario. Each control must fail exactly
 * the scenarios named against it: a control that passes one has had its
 * mechanism stop being load-bearing, and a name that is not a real scenario
 * means the list went stale, which is how a control comes to refuse its own
 * run.
 */

import { expect, test } from "bun:test";
import {
  type EscapeKeyEvent,
  EscapeLayerRegistry,
  type EscapeLayerOptions,
  type EscapeTarget,
} from "../../shared/ts/escape-layer";

// ── DOM harness ─────────────────────────────────────────────────────────────

type Listener = (event: EscapeKeyEvent) => void;

class FakeTarget implements EscapeTarget {
  private capture: Record<string, Listener[]> = {};
  private bubble: Record<string, Listener[]> = {};

  addEventListener(type: string, listener: Listener, capture?: boolean) {
    const bag = capture ? this.capture : this.bubble;
    bag[type] ??= [];
    bag[type].push(listener);
  }

  removeEventListener(type: string, listener: Listener, capture?: boolean) {
    const bag = capture ? this.capture : this.bubble;
    bag[type] = (bag[type] ?? []).filter((entry) => entry !== listener);
  }

  /** Capture listeners first, then bubble, exactly as a listener on `window` sees it. */
  dispatch(type: string, event: FakeEvent) {
    for (const listener of [...(this.capture[type] ?? [])]) listener(event);
    for (const listener of [...(this.bubble[type] ?? [])]) listener(event);
    return event;
  }
}

class FakeEvent implements EscapeKeyEvent {
  defaultPrevented = false;
  constructor(
    readonly key: string,
    readonly repeat = false,
    readonly target: unknown = undefined,
    alreadyPrevented = false
  ) {
    this.defaultPrevented = alreadyPrevented;
  }
  preventDefault() {
    this.defaultPrevented = true;
  }
}

/** One Escape press: keydown then keyup, same event-shape conventions as a browser. */
function press(
  target: FakeTarget,
  options: { repeat?: boolean; on?: unknown; prevented?: boolean } = {}
) {
  const down = target.dispatch(
    "keydown",
    new FakeEvent("Escape", options.repeat ?? false, options.on, options.prevented ?? false)
  );
  const up = target.dispatch(
    "keyup",
    new FakeEvent("Escape", false, options.on, options.prevented ?? false)
  );
  return { down, up };
}

// ── The negative controls ───────────────────────────────────────────────────

interface Driver {
  add(options: EscapeLayerOptions): () => void;
  addGuard?(guard: () => boolean): () => void;
}

/**
 * Resolves live in each phase. Subclasses supply the one thing they are blind
 * to; nothing here samples on capture, which is the mechanism no naive shape
 * has.
 */
abstract class LiveRegistry implements Driver {
  protected readonly layers: EscapeLayerOptions[] = [];

  constructor(target: EscapeTarget) {
    target.addEventListener("keydown", this.onKeyDown as Listener, false);
    target.addEventListener("keyup", this.onKeyUp as Listener, false);
  }

  add(options: EscapeLayerOptions): () => void {
    this.layers.push(options);
    return () => {
      const at = this.layers.indexOf(options);
      if (at >= 0) this.layers.splice(at, 1);
    };
  }

  protected abstract resolve(phase: "keydown" | "keyup"): EscapeLayerOptions | null;

  private readonly onKeyDown = (event: EscapeKeyEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    const owner = this.resolve("keydown");
    if (!owner) return;
    event.preventDefault();
    if (owner.onInternal?.()) return;
    owner.onEscape();
  };

  private readonly onKeyUp = (event: EscapeKeyEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    const owner = this.resolve("keyup");
    if (!owner) return;
    event.preventDefault();
    owner.onEscape();
  };
}

/** Depth-blind: the first layer that asked for this phase gets the key. */
class FirstWinsRegistry extends LiveRegistry {
  protected resolve(phase: "keydown" | "keyup") {
    return this.layers.find((layer) => (layer.phase ?? "keydown") === phase) ?? null;
  }
}

/** `active`-blind: deepest, then newest, but a hidden mount still counts. */
class StackRegistry extends LiveRegistry {
  protected resolve(phase: "keydown" | "keyup") {
    let best: EscapeLayerOptions | null = null;
    for (const layer of this.layers) {
      if ((layer.phase ?? "keydown") !== phase) continue;
      if (!best || (layer.depth ?? 0) >= (best.depth ?? 0)) best = layer;
    }
    return best;
  }
}

const CONTROLS: { name: string; make(target: FakeTarget): Driver; mustFail: string[] }[] = [
  {
    name: "FirstWinsRegistry (depth-blind)",
    make: (target) => new FirstWinsRegistry(target),
    mustFail: [
      "the topmost layer owns the key and the host below it does not fire",
      "one press dismisses one thing even when the halves are owned by different layers",
    ],
  },
  {
    name: "StackRegistry (active-blind)",
    make: (target) => new StackRegistry(target),
    mustFail: [
      "an inactive mount does not shadow the host it is mounted in",
      "one press dismisses one thing even when the halves are owned by different layers",
    ],
  },
];

// ── Scenarios ───────────────────────────────────────────────────────────────

interface Scenario {
  name: string;
  run(target: FakeTarget, registry: Driver): void;
}

const SCENARIOS: Scenario[] = [
  {
    name: "a single layer is dismissed and the key is marked handled",
    run(target, registry) {
      const fired: string[] = [];
      registry.add({ label: "host", onEscape: () => fired.push("host") });
      const { down } = press(target);
      expect(fired).toEqual(["host"]);
      expect(down.defaultPrevented).toBe(true);
    },
  },
  {
    name: "the topmost layer owns the key and the host below it does not fire",
    run(target, registry) {
      const fired: string[] = [];
      registry.add({ label: "editor", depth: 0, onEscape: () => fired.push("editor") });
      registry.add({ label: "picker", depth: 1, onEscape: () => fired.push("picker") });
      press(target);
      expect(fired).toEqual(["picker"]);
    },
  },
  {
    name: "an inactive mount does not shadow the host it is mounted in",
    run(target, registry) {
      const fired: string[] = [];
      registry.add({ label: "dialog", depth: 0, onEscape: () => fired.push("dialog") });
      registry.add({
        label: "marketplace-tab",
        depth: 1,
        active: () => false,
        onEscape: () => fired.push("marketplace-tab"),
      });
      press(target);
      expect(fired).toEqual(["dialog"]);
    },
  },
  {
    name: "an internal layer is consumed first and only a second press dismisses",
    run(target, registry) {
      const fired: string[] = [];
      let preview = true;
      registry.add({
        label: "browser",
        onInternal: () => {
          if (!preview) return false;
          preview = false;
          fired.push("preview-closed");
          return true;
        },
        onEscape: () => fired.push("browser-closed"),
      });
      press(target);
      press(target);
      expect(fired).toEqual(["preview-closed", "browser-closed"]);
    },
  },
  {
    name: "one press dismisses one thing even when the halves are owned by different layers",
    run(target, registry) {
      // tRadio's bug, as a scenario. The dispatch panel closes on keydown; the
      // radio releases focus on keyup. Without a keydown sample the keyup sees
      // a page with nothing open and hides the radio too — one press, two
      // dismissals, and the player's radio is gone.
      const fired: string[] = [];
      let panelOpen = true;
      const disposePanel = registry.add({
        label: "dispatch-panel",
        depth: 1,
        active: () => panelOpen,
        onEscape: () => {
          panelOpen = false;
          fired.push("panel");
          disposePanel();
        },
      });
      registry.add({
        label: "radio-focus",
        depth: 0,
        phase: "keyup",
        onEscape: () => fired.push("radio"),
      });
      press(target);
      expect(fired).toEqual(["panel"]);
    },
  },
  {
    name: "a keyup layer still fires when nothing above it owned the press",
    run(target, registry) {
      const fired: string[] = [];
      registry.add({
        label: "radio-focus",
        depth: 0,
        phase: "keyup",
        onEscape: () => fired.push("radio"),
      });
      press(target);
      expect(fired).toEqual(["radio"]);
    },
  },
  {
    name: "an already-handled key is left entirely alone",
    run(target, registry) {
      const fired: string[] = [];
      registry.add({ label: "host", depth: 1, onEscape: () => fired.push("host") });
      registry.add({
        label: "radio-focus",
        depth: 0,
        phase: "keyup",
        onEscape: () => fired.push("radio"),
      });
      press(target, { prevented: true });
      expect(fired).toEqual([]);
    },
  },
];

// ── The real registry passes everything ─────────────────────────────────────

for (const scenario of SCENARIOS) {
  test(scenario.name, () => {
    const target = new FakeTarget();
    scenario.run(target, new EscapeLayerRegistry(target));
  });
}

// ── Registry behaviour the control has no opinion about ─────────────────────

test("a layer registered during the press does not own that press", () => {
  const target = new FakeTarget();
  const registry = new EscapeLayerRegistry(target);
  const fired: string[] = [];
  registry.add({
    label: "host",
    onEscape: () => {
      fired.push("host");
      // Opening a confirm dialog from the same key that closed the host is an
      // ordinary action here (tELS's discard guard does exactly this). It must
      // not then eat its own opening keyup.
      registry.add({ label: "confirm", depth: 5, onEscape: () => fired.push("confirm") });
    },
  });
  press(target);
  expect(fired).toEqual(["host"]);
});

test("a guard makes the whole registry stand down in both phases", () => {
  const target = new FakeTarget();
  const registry = new EscapeLayerRegistry(target);
  const fired: string[] = [];
  let arkPopoverOpen = true;
  registry.addGuard(() => arkPopoverOpen);
  registry.add({ label: "editor", depth: 1, onEscape: () => fired.push("editor") });
  registry.add({
    label: "radio-focus",
    depth: 0,
    phase: "keyup",
    onEscape: () => fired.push("radio"),
  });
  const { down } = press(target);
  expect(fired).toEqual([]);
  // And the event is untouched, so whoever does own it still sees a live key.
  expect(down.defaultPrevented).toBe(false);
  arkPopoverOpen = false;
  press(target);
  expect(fired).toEqual(["editor"]);
});

test("a guard is handed the press, and is asked once per press", () => {
  const target = new FakeTarget();
  const registry = new EscapeLayerRegistry(target);
  const seen: unknown[] = [];
  let count = 0;
  // tELS's probe reads the event target, which is why guards take the event.
  registry.addGuard((event) => {
    count++;
    seen.push(event.target);
    return (event.target as { tagName?: string })?.tagName === "INPUT";
  });
  let fired = 0;
  registry.add({ label: "editor", onEscape: () => fired++ });
  press(target, { on: { tagName: "INPUT" } });
  expect(fired).toBe(0);
  press(target, { on: { tagName: "DIV" } });
  expect(fired).toBe(1);
  // Twice, not four times: sampled on keydown capture only, so a DOM probe
  // sees the page as it was before anything reacted.
  expect(count).toBe(2);
  expect(seen).toEqual([{ tagName: "INPUT" }, { tagName: "DIV" }]);
});

test("a held key is one press, not one per repeat", () => {
  const target = new FakeTarget();
  const registry = new EscapeLayerRegistry(target);
  let count = 0;
  registry.add({ label: "host", onEscape: () => count++ });
  target.dispatch("keydown", new FakeEvent("Escape", false));
  target.dispatch("keydown", new FakeEvent("Escape", true));
  target.dispatch("keydown", new FakeEvent("Escape", true));
  // The repeats are suppressed by `defaultPrevented` on their own events
  // rather than by the sample, so assert the outcome: one dismissal.
  expect(count).toBe(1);
});

test("ignoreWhenTyping stands down inside a text field and acts outside one", () => {
  const target = new FakeTarget();
  const registry = new EscapeLayerRegistry(target);
  let count = 0;
  registry.add({ label: "editor", ignoreWhenTyping: true, onEscape: () => count++ });
  press(target, { on: { tagName: "INPUT" } });
  expect(count).toBe(0);
  press(target, { on: { tagName: "DIV" } });
  expect(count).toBe(1);
});

test("a blocked layer is skipped, so the layer below it owns the press", () => {
  // The difference between "not mine" and "mine, do nothing". tELS's editor
  // declines Escape while focus is on an interactive control; a modal stacked
  // above it must still close, and when the editor itself declines, nothing
  // above it should be invented either.
  const target = new FakeTarget();
  const registry = new EscapeLayerRegistry(target);
  const fired: string[] = [];
  registry.add({ label: "host", depth: 0, onEscape: () => fired.push("host") });
  registry.add({
    label: "editor",
    depth: 1,
    blocked: (event) => (event.target as { tagName?: string })?.tagName === "BUTTON",
    onEscape: () => fired.push("editor"),
  });
  press(target, { on: { tagName: "BUTTON" } });
  expect(fired).toEqual(["host"]);
  press(target, { on: { tagName: "DIV" } });
  expect(fired).toEqual(["host", "editor"]);
});

test("the registry detaches once its last layer and guard are gone", () => {
  const target = new FakeTarget();
  const registry = new EscapeLayerRegistry(target);
  const disposeLayer = registry.add({ label: "host", onEscape: () => {} });
  const disposeGuard = registry.addGuard(() => false);
  expect(registry.escapeLayerDiagnostics().attached).toBe(true);
  disposeLayer();
  expect(registry.escapeLayerDiagnostics().attached).toBe(true);
  disposeGuard();
  expect(registry.escapeLayerDiagnostics().attached).toBe(false);
  // Double disposal is a no-op, not a crash: Solid can run a cleanup twice.
  disposeLayer();
  disposeGuard();
  expect(registry.escapeLayerDiagnostics().attached).toBe(false);
});

test("a non-Escape key is never sampled or consumed", () => {
  const target = new FakeTarget();
  const registry = new EscapeLayerRegistry(target);
  let count = 0;
  registry.add({ label: "host", onEscape: () => count++ });
  const enter = target.dispatch("keydown", new FakeEvent("Enter"));
  target.dispatch("keyup", new FakeEvent("Enter"));
  expect(count).toBe(0);
  expect(enter.defaultPrevented).toBe(false);
});

// ── The negative control, actually run ──────────────────────────────────────

test("every control names real scenarios, and every mechanism has a control", () => {
  const names = new Set(SCENARIOS.map((scenario) => scenario.name));
  const covered = new Set<string>();
  for (const control of CONTROLS) {
    expect(control.mustFail.length).toBeGreaterThan(0);
    for (const name of control.mustFail) {
      expect(names.has(name)).toBe(true);
      covered.add(name);
    }
  }
  // Three mechanisms, three scenarios that isolate them. Asserted as a set of
  // names rather than a count, because a count is what goes stale.
  expect([...covered].sort()).toEqual(
    [
      "an inactive mount does not shadow the host it is mounted in",
      "one press dismisses one thing even when the halves are owned by different layers",
      "the topmost layer owns the key and the host below it does not fire",
    ].sort()
  );
});

for (const control of CONTROLS) {
  test(`${control.name} fails exactly the scenarios it is supposed to`, () => {
    const failed: string[] = [];
    for (const scenario of SCENARIOS) {
      const target = new FakeTarget();
      try {
        scenario.run(target, control.make(target));
      } catch {
        failed.push(scenario.name);
      }
    }
    expect(failed.sort()).toEqual([...control.mustFail].sort());
  });
}
