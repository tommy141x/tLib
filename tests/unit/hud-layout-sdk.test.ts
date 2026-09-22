import { afterAll, beforeAll, expect, test } from "bun:test";

const priorWindow = globalThis.window;
const priorWidth = globalThis.innerWidth,
  priorHeight = globalThis.innerHeight;
const listeners = new Map<string, (event: any) => void>();
let sdk: { attach(id: string, element: any, onEdit?: (editing: boolean) => void): () => void };
beforeAll(async () => {
  Object.assign(globalThis, {
    innerWidth: 1920,
    innerHeight: 1080,
    window: {
      addEventListener(name: string, fn: (event: any) => void) {
        listeners.set(name, fn);
      },
    },
  });
  await import("../../client/web/src/hud-layout-sdk");
  sdk = (globalThis.window as any).tLibHudLayout;
});
afterAll(() =>
  Object.assign(globalThis, {
    window: priorWindow,
    innerWidth: priorWidth,
    innerHeight: priorHeight,
  })
);
const update = (id: string, changes = {}) => ({
  id,
  width: 240,
  height: 90,
  editing: false,
  phase: "restore",
  layout: { x: -0.03, y: -0.04, scale: 1, visible: true, anchor: "bottom-right" },
  ...changes,
});
function element() {
  return {
    style: {} as Record<string, string>,
    hidden: false,
    getAttribute: () => null,
    removeAttribute: () => {},
    setAttribute: () => {},
  };
}
const send = (data: unknown) => listeners.get("message")!({ data: { tlibHud: data } });
test("consumer wrapper uses the editor geometry without touching child content", () => {
  const el = element();
  const detach = sdk.attach("radio", el);
  send(update("radio"));
  // Placement rides on one composited transform; left/top stay pinned at the origin.
  // Offsets are reference pixels over 1080: 0.03 * 1080 = 32.4px in from the right.
  expect(el.style.left).toBe("0px");
  expect(el.style.top).toBe("0px");
  expect(el.style.width).toBe("240px");
  expect(el.style.transform).toBe("translate3d(1647.6px, 946.8px, 0) scale(1)");
  Object.assign(globalThis, { innerWidth: 3840, innerHeight: 2160 });
  listeners.get("resize")!({});
  expect(el.style.transform).toBe("translate3d(3295.2px, 1893.6px, 0) scale(2)");
  detach();
  Object.assign(globalThis, { innerWidth: 1920, innerHeight: 1080 });
});
test("updates received before mount restore on attach; editing suppresses pointer events", () => {
  send(update("status", { editing: true }));
  const el = element(),
    edits: boolean[] = [];
  const detach = sdk.attach("status", el, (value) => edits.push(value));
  expect(el.style.pointerEvents).toBe("none");
  expect(edits).toEqual([true]);
  send(
    update("status", { layout: { ...update("status").layout, visible: false }, phase: "commit" })
  );
  expect(el.hidden).toBe(true);
  expect(el.style.pointerEvents).toBe("");
  detach();
  expect(el.hidden).toBe(false);
  expect(edits.at(-1)).toBe(false);
});
test("invalid layout messages and duplicate mounts are rejected", () => {
  const el = element(),
    detach = sdk.attach("detector", el);
  expect(() => sdk.attach("detector", element())).toThrow();
  send(update("detector", { width: Infinity }));
  expect(el.style.transform).toBeUndefined();
  send(update("detector", { layout: { ...update("detector").layout, x: NaN } }));
  expect(el.style.transform).toBeUndefined();
  // An offset beyond the v2 bound is still refused, so a corrupt record cannot
  // place a widget thousands of screens away.
  send(update("detector", { layout: { ...update("detector").layout, x: 9 } }));
  expect(el.style.transform).toBeUndefined();
  send(update("detector"));
  expect(el.style.transform).toBe("translate3d(1647.6px, 946.8px, 0) scale(1)");
  detach();
});
