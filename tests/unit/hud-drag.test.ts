// Drag a HUD surface by its own background: the gesture, the clamp, and the
// background/control discrimination.
//
// There is no DOM in this runner, so the harness below provides one. Its
// `matches` covers exactly the selector grammar HUD_CONTROL_SELECTOR uses and
// nothing else — it is a harness, not a claim about CEF's selector engine. Two
// things carry that claim instead: `selector covers every element HudBinder
// attaches a listener to`, which reads tLib's own binder source rather than a
// list written from memory, and running the real thing in the game.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import {
  attachHudDrag,
  HUD_CONTROL_SELECTOR,
  isHudControl,
} from "../../shared/ts/hud-drag";
import {
  constrainLayout,
  type Layout,
  layoutRect,
  MAX_OFFSET,
} from "../../shared/ts/hud-geometry";

// ── DOM harness ─────────────────────────────────────────────────────────────
class FakeElement {
  attrs: Record<string, string>;
  tag: string;
  parent: FakeElement | null = null;
  captured = new Set<number>();
  constructor(tag: string, attrs: Record<string, string> = {}) {
    this.tag = tag;
    this.attrs = attrs;
  }
  child(tag: string, attrs: Record<string, string> = {}) {
    const node = new FakeElement(tag, attrs);
    node.parent = this;
    return node;
  }
  contains(node: unknown) {
    for (let at = node as FakeElement | null; at; at = at.parent) if (at === this) return true;
    return false;
  }
  setPointerCapture(id: number) {
    this.captured.add(id);
  }
  hasPointerCapture(id: number) {
    return this.captured.has(id);
  }
  releasePointerCapture(id: number) {
    this.captured.delete(id);
  }
  /** Only the four forms HUD_CONTROL_SELECTOR is built from. */
  matches(selector: string): boolean {
    return selector.split(",").some((raw) => {
      const part = raw.trim();
      const not = part.match(/^(.*?):not\(\[([\w-]+)="([^"]*)"\]\)$/);
      if (not) return this.matches(not[1]) && this.attrs[not[2]] !== not[3];
      const pair = part.match(/^\[([\w-]+)="([^"]*)"\]$/);
      if (pair) return this.attrs[pair[1]] === pair[2];
      const bare = part.match(/^\[([\w-]+)\]$/);
      if (bare) return this.attrs[bare[1]] !== undefined;
      const tagged = part.match(/^([a-z]+)\[([\w-]+)\]$/);
      if (tagged) return this.tag === tagged[1] && this.attrs[tagged[2]] !== undefined;
      if (/^[a-z]+$/.test(part)) return this.tag === part;
      throw new Error(`harness cannot match selector fragment: ${part}`);
    });
  }
  closest(selector: string): FakeElement | null {
    for (let at: FakeElement | null = this; at; at = at.parent)
      if (at.matches(selector)) return at;
    return null;
  }
}

type Listener = (event: PointerEvent) => void;
const listeners = new Map<string, Listener[]>();
let frames: (() => void)[] = [];
const prior = {
  window: globalThis.window,
  Element: (globalThis as { Element?: unknown }).Element,
  raf: globalThis.requestAnimationFrame,
  caf: globalThis.cancelAnimationFrame,
};
beforeAll(() => {
  Object.assign(globalThis, {
    Element: FakeElement,
    window: {
      innerWidth: 1920,
      innerHeight: 1080,
      addEventListener(name: string, fn: Listener) {
        listeners.set(name, [...(listeners.get(name) ?? []), fn]);
      },
      removeEventListener(name: string, fn: Listener) {
        listeners.set(name, (listeners.get(name) ?? []).filter((it) => it !== fn));
      },
    },
    requestAnimationFrame(fn: () => void) {
      frames.push(fn);
      return frames.length;
    },
    cancelAnimationFrame(id: number) {
      frames[id - 1] = () => {};
    },
  });
});
afterAll(() => Object.assign(globalThis, prior));
beforeEach(() => {
  listeners.clear();
  frames = [];
});
function fire(name: string, event: Record<string, unknown>) {
  for (const fn of listeners.get(name) ?? []) fn(event as unknown as PointerEvent);
}
/** Run every frame the loop has queued, the way a real vsync would. */
function vsync() {
  const queued = frames;
  frames = [];
  for (const fn of queued) fn();
  return queued.length;
}

// ── Fixture ─────────────────────────────────────────────────────────────────
// The RCX-150 remote: a 220x488 chassis with keys on top of it.
const REMOTE = { width: 220, height: 488 };
const START: Layout = {
  x: -600 / 1080,
  y: -40 / 1080,
  scale: 1,
  visible: true,
  anchor: "bottom-right",
};
function surface(layout: Layout = START) {
  const root = new FakeElement("div");
  // pointer-events:none in the real skin, so a press lands on the shell.
  const shell = root.child("div");
  const chassis = shell.child("img", { class: "rcx150-chassis" });
  const key = shell.child("div", {
    "data-hud-btn": "lock:front",
    role: "button",
    tabindex: "0",
  });
  const commits: Layout[] = [];
  const previews: Layout[] = [];
  let cancels = 0;
  let current = layout;
  const viewport = { width: 1920, height: 1080 };
  const detach = attachHudDrag({
    surface: () => root as unknown as HTMLElement,
    enabled: () => enabled,
    metrics: () => ({ ...REMOTE, layout: current }),
    onPreview: (next) => {
      previews.push(next);
      current = next;
    },
    onCommit: (next) => {
      commits.push(next);
      current = next;
    },
    onCancel: () => {
      cancels++;
    },
    viewport: () => viewport,
  });
  let enabled = true;
  return {
    root,
    shell,
    chassis,
    key,
    commits,
    previews,
    detach,
    viewport,
    get cancels() {
      return cancels;
    },
    get layout() {
      return current;
    },
    set enabled(value: boolean) {
      enabled = value;
    },
  };
}
const down = (target: unknown, x: number, y: number, extra = {}) =>
  fire("pointerdown", {
    target,
    button: 0,
    pointerId: 1,
    clientX: x,
    clientY: y,
    preventDefault() {},
    ...extra,
  });
const move = (x: number, y: number) => fire("pointermove", { pointerId: 1, clientX: x, clientY: y });
const up = () => fire("pointerup", { pointerId: 1 });

// ── 1. Background vs control ────────────────────────────────────────────────
test("a press on the chassis starts a drag; a press on a key does not", () => {
  const s = surface();
  down(s.key, 100, 100);
  move(160, 140);
  expect(vsync()).toBe(0);
  expect(s.previews.length).toBe(0);
  up();
  expect(s.commits.length).toBe(0);

  down(s.chassis, 100, 100);
  move(160, 140);
  vsync();
  expect(s.previews.length).toBe(1);
  up();
  expect(s.commits.length).toBe(1);
  s.detach();
});

test("every way a control can be marked blocks the drag, independently", () => {
  const s = surface();
  // Each of these alone is enough. A skin author who adds a key and forgets
  // data-hud-btn is still caught by role, and by tabindex, and by the tag.
  for (const attrs of [
    { "data-hud-btn": "x" },
    { role: "button" },
    { tabindex: "0" },
    { "data-hud-nodrag": "" },
    { role: "slider" },
  ]) {
    const node = s.shell.child("div", attrs);
    expect(isHudControl(node)).toBe(true);
  }
  // …and a decorative node with none of them is grab surface.
  expect(isHudControl(s.shell.child("div", { class: "silkscreen" }))).toBe(false);
  expect(isHudControl(s.shell.child("div", { tabindex: "-1" }))).toBe(false);
  expect(isHudControl(s.chassis)).toBe(false);
  s.detach();
});

test("a control's DESCENDANT is not grab surface either", () => {
  const s = surface();
  const label = s.key.child("span");
  expect(isHudControl(label)).toBe(true);
  down(label, 100, 100);
  move(200, 200);
  vsync();
  expect(s.previews.length).toBe(0);
  s.detach();
});

// Mutation proof: the guard is derived from tLib's own binder, not from memory.
// A skin element is a CONTROL precisely when HudBinder attaches an event
// listener to it, so that — and not a list written here — is what the guard has
// to cover. Bind a second attribute in hud-template.ts and this fails, instead
// of silently shipping a key that drags the device off screen when pressed.
//
// Selectors HudBinder merely READS (`[data-hud-keys]` declares which view keys
// an element renders) are deliberately not included: a readout is part of the
// faceplate, and grabbing a device by its glass is the normal way to pick it up.
test("selector covers every element HudBinder attaches a listener to", () => {
  const source = readFileSync(new URL("../../shared/ts/hud-template.ts", import.meta.url), "utf8");
  const scans = [...source.matchAll(/querySelectorAll<[^>]*>\("(\[[^"]+\])"\)/g)];
  expect(scans.length).toBeGreaterThan(0);
  const listens = scans
    .filter((match) => source.slice(match.index ?? 0).slice(0, 400).includes("addEventListener"))
    .map((match) => match[1]);
  // If this ever drops to zero the proof has stopped proving anything.
  expect(listens).toContain("[data-hud-btn]");
  for (const selector of listens) expect(HUD_CONTROL_SELECTOR.split(",")).toContain(selector);
});

test("a press outside the surface is ignored", () => {
  const s = surface();
  const elsewhere = new FakeElement("div");
  down(elsewhere, 100, 100);
  move(200, 200);
  vsync();
  expect(s.previews.length).toBe(0);
  s.detach();
});

// ── 2. Activation ───────────────────────────────────────────────────────────
test("disabled means no drag at all", () => {
  const s = surface();
  s.enabled = false;
  down(s.chassis, 100, 100);
  move(300, 300);
  vsync();
  expect(s.previews.length).toBe(0);
  expect(s.commits.length).toBe(0);
  s.detach();
});

test("detach stops listening", () => {
  const s = surface();
  s.detach();
  down(s.chassis, 100, 100);
  move(300, 300);
  vsync();
  expect(s.previews.length).toBe(0);
});

// ── 3. 1:1 at every viewport, anchor, scale and delta ───────────────────────
const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 3440, height: 1440 },
  { width: 2560, height: 1080 },
  { width: 1280, height: 720 },
];
const ANCHORS = ["top-left", "top-right", "bottom-left", "bottom-right", "center"] as const;
const SCALES = [0.6, 1, 1.75];
const DELTAS = [
  [0, 0],
  [37, -19],
  [-140, 96],
  [3, 211],
];

test("the surface moves by exactly the pointer delta, 240 combinations", () => {
  let checked = 0;
  for (const viewport of VIEWPORTS) {
    for (const anchor of ANCHORS) {
      for (const scale of SCALES) {
        // Start from the middle of the screen so no combination is clamped;
        // clamping is a separate test and would mask a 1:1 error here.
        const centred = { x: 0, y: 0, scale, visible: true, anchor: "center" as const };
        const middle = layoutRect(REMOTE, centred, viewport);
        const layout = {
          ...centred,
          anchor,
          ...(anchor === "center"
            ? {}
            : {
                x:
                  (middle.left -
                    (anchor.endsWith("right") ? viewport.width - middle.width : 0)) /
                  viewport.height,
                y:
                  (middle.top -
                    (anchor.startsWith("bottom") ? viewport.height - middle.height : 0)) /
                  viewport.height,
              }),
        } as Layout;
        const before = layoutRect(REMOTE, layout, viewport);
        for (const [dx, dy] of DELTAS) {
          const s = surface(layout);
          Object.assign(s.viewport, viewport);
          down(s.chassis, 500, 400);
          move(500 + dx, 400 + dy);
          vsync();
          up();
          const after = layoutRect(REMOTE, s.layout, viewport);
          expect(after.left - before.left).toBeCloseTo(dx, 6);
          expect(after.top - before.top).toBeCloseTo(dy, 6);
          s.detach();
          checked++;
        }
      }
    }
  }
  expect(checked).toBe(VIEWPORTS.length * ANCHORS.length * SCALES.length * DELTAS.length);
});

test("a multi-step drag tracks the pointer, not the accumulated deltas", () => {
  const s = surface();
  const before = layoutRect(REMOTE, s.layout, s.viewport);
  down(s.chassis, 800, 600);
  // Deliberately jagged, with several moves inside one frame: the delta is
  // always measured from the pointerdown, so intermediate frames cannot drift.
  for (const [x, y] of [
    [820, 590],
    [700, 640],
    [905, 555],
  ] as const) {
    move(x, y);
    vsync();
  }
  move(870, 700);
  vsync();
  up();
  const after = layoutRect(REMOTE, s.layout, s.viewport);
  expect(after.left - before.left).toBeCloseTo(70, 6);
  expect(after.top - before.top).toBeCloseTo(100, 6);
  s.detach();
});

// ── 4. Clamping, through the shared choke point ─────────────────────────────
test("the surface cannot be dragged off screen, on either axis or either side", () => {
  for (const [dx, dy] of [
    [-100000, -100000],
    [100000, 100000],
    [100000, -100000],
    [-100000, 100000],
  ]) {
    const s = surface();
    down(s.chassis, 900, 500);
    move(900 + dx, 500 + dy);
    vsync();
    // The PREVIEW is asserted as well as the commit. Only the commit going
    // through `reanchor` would re-clamp it for free, which would leave the
    // player watching their remote fly off the screen for the whole drag and
    // snap back on release — clamped by accident rather than on purpose.
    const previewed = s.previews.at(-1) as Layout;
    up();
    for (const layout of [previewed, s.layout]) {
      const rect = layoutRect(REMOTE, layout, s.viewport);
      // tLib's universal rule: min(extent, viewportAxis, max(96, extent * 0.4)).
      const needX = Math.min(rect.width, s.viewport.width, Math.max(96, rect.width * 0.4));
      const needY = Math.min(rect.height, s.viewport.height, Math.max(96, rect.height * 0.4));
      expect(rect.left).toBeGreaterThanOrEqual(needX - rect.width - 1e-6);
      expect(rect.left).toBeLessThanOrEqual(s.viewport.width - needX + 1e-6);
      expect(rect.top).toBeGreaterThanOrEqual(needY - rect.height - 1e-6);
      expect(rect.top).toBeLessThanOrEqual(s.viewport.height - needY + 1e-6);
      expect(Math.abs(layout.x)).toBeLessThanOrEqual(MAX_OFFSET);
      expect(Math.abs(layout.y)).toBeLessThanOrEqual(MAX_OFFSET);
    }
    s.detach();
  }
});

test("the committed placement is one the clamp already agrees with", () => {
  const s = surface();
  down(s.chassis, 900, 500);
  move(-4000, 3000);
  vsync();
  up();
  const committed = s.commits.at(-1) as Layout;
  expect(constrainLayout(REMOTE, committed, s.viewport)).toEqual(committed);
  s.detach();
});

test("the anchor is re-derived once, on release, and never mid-drag", () => {
  const s = surface();
  down(s.chassis, 900, 500);
  // Bottom-right corner to the top-left quadrant.
  move(200, 120);
  vsync();
  expect(s.previews.at(-1)?.anchor).toBe("bottom-right");
  up();
  expect(s.commits.at(-1)?.anchor).toBe("top-left");
  s.detach();
});

// ── 5. Performance: one apply per frame, no matter the event rate ───────────
test("600 pointermoves across 30 frames produce 30 previews", () => {
  const s = surface();
  down(s.chassis, 900, 500);
  let applied = 0;
  for (let i = 0; i < 600; i++) {
    move(900 + (i % 50), 500 + (i % 37));
    if (i % 20 === 19) applied += vsync();
  }
  up();
  expect(applied).toBe(30);
  // One preview per frame, plus the flush the release performs if a frame was
  // still outstanding. Nothing proportional to the 600 events.
  expect(s.previews.length).toBe(30);
  expect(s.commits.length).toBe(1);
  s.detach();
});

test("release flushes the frame the last move queued", () => {
  const s = surface();
  down(s.chassis, 900, 500);
  move(940, 530);
  // No vsync: the frame is still pending when the pointer goes up.
  up();
  expect(s.previews.length).toBe(1);
  expect(s.commits.length).toBe(1);
  const rect = layoutRect(REMOTE, s.layout, s.viewport);
  const before = layoutRect(REMOTE, START, s.viewport);
  expect(rect.left - before.left).toBeCloseTo(40, 6);
  s.detach();
});

// ── 6. Gesture lifecycle ────────────────────────────────────────────────────
test("a press that never moves is a click, not a drag", () => {
  const s = surface();
  down(s.chassis, 900, 500);
  up();
  expect(s.previews.length).toBe(0);
  expect(s.commits.length).toBe(0);
  expect(s.cancels).toBe(1);
  expect(s.layout).toEqual(START);
  s.detach();
});

test("pointercancel discards the gesture and the frame it had queued", () => {
  const s = surface();
  down(s.chassis, 900, 500);
  move(1200, 800);
  fire("pointercancel", { pointerId: 1 });
  expect(vsync()).toBe(1); // the frame runs, but the gesture is already gone
  expect(s.previews.length).toBe(0);
  expect(s.commits.length).toBe(0);
  expect(s.cancels).toBe(1);
  s.detach();
});

test("pointer capture is taken on the surface and released when the gesture ends", () => {
  const s = surface();
  down(s.chassis, 900, 500);
  expect(s.root.hasPointerCapture(1)).toBe(true);
  move(1000, 600);
  vsync();
  up();
  expect(s.root.hasPointerCapture(1)).toBe(false);
  s.detach();
});

test("a second pointer cannot hijack a gesture in flight", () => {
  const s = surface();
  down(s.chassis, 900, 500);
  down(s.chassis, 100, 100, { pointerId: 2 });
  fire("pointermove", { pointerId: 2, clientX: 400, clientY: 400 });
  expect(vsync()).toBe(0);
  move(950, 500);
  vsync();
  up();
  const before = layoutRect(REMOTE, START, s.viewport);
  const after = layoutRect(REMOTE, s.layout, s.viewport);
  expect(after.left - before.left).toBeCloseTo(50, 6);
  s.detach();
});

test("losing the window abandons the drag", () => {
  const s = surface();
  down(s.chassis, 900, 500);
  move(1200, 800);
  fire("blur", {});
  vsync();
  expect(s.commits.length).toBe(0);
  expect(s.cancels).toBe(1);
  s.detach();
});
