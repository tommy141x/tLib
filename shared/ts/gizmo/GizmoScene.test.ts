import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import * as THREE from "three";
import { clampUniformScale } from "./types";

// Keep real Three geometry/math; only GPU and DOM controls are mocked.
class Renderer {
  domElement: HTMLCanvasElement;
  render = mock(() => {});
  dispose = mock(() => {});
  setPixelRatio = mock(() => {});
  setClearColor = mock(() => {});
  setSize = mock(() => {});
  constructor({ canvas }: { canvas: HTMLCanvasElement }) {
    this.domElement = canvas;
  }
}
// `addEventListener` RECORDS rather than discarding: the scale/translate/rotate
// derivations all live in the `objectChange` handler the constructor registers,
// and a no-op listener makes that whole branch unreachable from a test.
/** The only field GizmoScene reads off a controls event: `dragging-changed`'s. */
type ControlsEvent = { value?: boolean };
class Controls {
  dragging = false;
  mode = "translate";
  listeners = new Map<string, Set<(e: ControlsEvent) => void>>();
  setSize() {}
  setSpace() {}
  setMode(mode: string) {
    this.mode = mode;
  }
  attach() {}
  getHelper() {
    return new THREE.Object3D();
  }
  addEventListener(name: string, fn: (e: ControlsEvent) => void) {
    const set = this.listeners.get(name) ?? new Set<(e: ControlsEvent) => void>();
    this.listeners.set(name, set);
    set.add(fn);
  }
  emit(name: string, event: ControlsEvent = {}) {
    for (const fn of this.listeners.get(name) ?? []) fn(event);
  }
  detach = mock(() => {});
  dispose = mock(() => {});
}
mock.module("three", () => ({ ...THREE, WebGLRenderer: Renderer }));
mock.module("three/addons/controls/TransformControls.js", () => ({ TransformControls: Controls }));
const { GizmoScene } = await import("./GizmoScene");

class Target {
  listeners = new Map<string, Set<EventListener>>();
  devicePixelRatio = 1;
  clientWidth = 800;
  clientHeight = 600;
  parentElement = { clientWidth: 800, clientHeight: 600 };
  addEventListener(name: string, fn: EventListener) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)!.add(fn);
  }
  removeEventListener(name: string, fn: EventListener) {
    this.listeners.get(name)?.delete(fn);
  }
  count() {
    return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0);
  }
  emit(name: string) {
    for (const fn of this.listeners.get(name) ?? []) fn({ clientX: 10, clientY: 10 } as any);
  }
}
const prior = {
  window: globalThis.window,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  cancelAnimationFrame: globalThis.cancelAnimationFrame,
};
let win: Target;
let pending: Map<number, FrameRequestCallback>;
let nextId: number;
let scenes: InstanceType<typeof GizmoScene>[];
beforeEach(() => {
  win = new Target();
  pending = new Map();
  nextId = 0;
  scenes = [];
  Object.assign(globalThis, {
    window: win,
    requestAnimationFrame: (fn: FrameRequestCallback) => {
      pending.set(++nextId, fn);
      return nextId;
    },
    cancelAnimationFrame: (id: number) => {
      pending.delete(id);
    },
  });
});
afterEach(() => {
  for (const scene of scenes) scene.dispose();
  Object.assign(globalThis, prior);
});
afterAll(() => mock.restore());
function create(canvas = new Target(), picking = false) {
  const scene = new GizmoScene({
    canvas: canvas as unknown as HTMLCanvasElement,
    features: { picking },
  });
  scenes.push(scene);
  return scene;
}
/** A prop-editor-shaped scene: the scale handle on, reporting ONE scalar. */
function createUniform(features: { uniformScale?: boolean; multiSelect?: boolean } = {}) {
  const scene = new GizmoScene({
    canvas: new Target() as unknown as HTMLCanvasElement,
    features: { scale: true, uniformScale: true, ...features },
  });
  scenes.push(scene);
  return scene;
}
/** Drag `axis` to `factor` and run the handler the real controls would. */
function dragScale(
  scene: InstanceType<typeof GizmoScene>,
  axes: Partial<Record<"x" | "y" | "z", number>>
) {
  const controls = scene.transformControls as unknown as Controls;
  controls.mode = "scale";
  for (const [axis, v] of Object.entries(axes)) {
    scene.gizmoTarget.scale[axis as "x" | "y" | "z"] = v as number;
  }
  controls.emit("objectChange");
}
function frame() {
  const [id, fn] = pending.entries().next().value!;
  pending.delete(id);
  fn(0);
}

test("repeated start creates only one RAF chain; repeated stop is safe and restart works", () => {
  const scene = create();
  scene.startLoop();
  scene.startLoop();
  expect(pending.size).toBe(1);
  expect(scene.renderer.render).toHaveBeenCalledTimes(1);
  frame();
  expect(pending.size).toBe(1);
  expect(scene.renderer.render).toHaveBeenCalledTimes(2);
  const stale = [...pending.values()][0];
  scene.stopLoop();
  scene.stopLoop();
  expect(pending.size).toBe(0);
  scene.startLoop();
  stale(0); // Even an already-dispatched old callback cannot revive its chain.
  expect(pending.size).toBe(1);
  expect(scene.renderer.render).toHaveBeenCalledTimes(3);
});

test("dispose frees resources once, cancels RAF and permanently prevents restart", () => {
  const scene = create();
  const geometryDispose = spyOn(scene.gizmoTarget.geometry, "dispose");
  const materialDispose = spyOn(scene.gizmoTarget.material as THREE.Material, "dispose");
  scene.startLoop();
  const stale = [...pending.values()][0];
  scene.dispose();
  scene.dispose();
  scene.stopLoop();
  scene.startLoop();
  stale(0);
  expect(pending.size).toBe(0);
  expect(win.count()).toBe(0);
  expect(scene.renderer.render).toHaveBeenCalledTimes(1);
  expect(scene.renderer.dispose).toHaveBeenCalledTimes(1);
  expect(scene.transformControls.detach).toHaveBeenCalledTimes(1);
  expect(scene.transformControls.dispose).toHaveBeenCalledTimes(1);
  expect(geometryDispose).toHaveBeenCalledTimes(1);
  expect(materialDispose).toHaveBeenCalledTimes(1);
});

test("picking listeners are removed on dispose and canvas reuse does not retain old scenes", () => {
  const canvas = new Target();
  for (let i = 0; i < 3; i++) {
    const scene = create(canvas, true);
    const pick = spyOn(scene as any, "_pickItem").mockImplementation(() => {});
    expect(canvas.count()).toBe(3);
    canvas.emit("pointerdown");
    canvas.emit("pointerup");
    expect(pick).toHaveBeenCalledTimes(1);
    scene.dispose();
    scene.dispose();
    expect(canvas.count()).toBe(0);
    expect(win.count()).toBe(0);
    canvas.emit("pointerdown");
    canvas.emit("pointerup");
    expect(pick).toHaveBeenCalledTimes(1);
  }
});

test("dispose before start is safe with picking disabled", () => {
  const canvas = new Target();
  const scene = create(canvas);
  expect(canvas.count()).toBe(0);
  scene.stopLoop();
  scene.dispose();
  scene.startLoop();
  expect(pending.size).toBe(0);
  expect(scene.renderer.render).not.toHaveBeenCalled();
});

test("clampUniformScale rules out 0, negatives and junk, and bounds to [0.1, 10]", () => {
  // Unusable input means "no scale supplied", which is 1 — NOT the minimum.
  for (const bad of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, 0, -1, -0.5]) {
    expect(clampUniformScale(bad as number)).toBe(1);
  }
  expect(clampUniformScale(0.0001)).toBe(0.1);
  expect(clampUniformScale(1e9)).toBe(10);
  expect(clampUniformScale(0.1)).toBe(0.1);
  expect(clampUniformScale(10)).toBe(10);
  expect(clampUniformScale(2.5)).toBe(2.5);
});

test("uniform scale derives one scalar from whichever single axis was dragged", () => {
  const scene = createUniform();
  const seen: number[] = [];
  scene.onUniformScaleChange = (s) => seen.push(s);
  scene.onScaleChange = mock(() => {});
  scene.updatePropGizmo({ x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, scale: 2 });

  // TransformControls writes ONE component per axis handle and leaves the other
  // two at 1; the component furthest from 1 is therefore the dragged one,
  // whichever handle it was. The result is absolute: start (2) x factor.
  dragScale(scene, { x: 1.5 });
  scene.gizmoTarget.scale.set(1, 1, 1);
  dragScale(scene, { y: 0.5 });
  scene.gizmoTarget.scale.set(1, 1, 1);
  dragScale(scene, { z: 2 });
  expect(seen).toEqual([3, 1, 4]);

  // The centre XYZ handle moves all three together. A tie is harmless — a tie
  // means the axes agree — and must not read as "no drag".
  scene.gizmoTarget.scale.set(1.25, 1.25, 1.25);
  dragScale(scene, {});
  expect(seen.at(-1)).toBeCloseTo(2.5, 10);

  // Shrinking below 1 must win over an untouched axis sitting exactly at 1.
  scene.gizmoTarget.scale.set(1, 1, 1);
  dragScale(scene, { y: 0.25 });
  expect(seen.at(-1)).toBe(0.5);

  // The 2D sw/sh path is not also fired.
  expect(scene.onScaleChange).not.toHaveBeenCalled();
});

test("uniform scale clamps at both ends and never emits 0 or a negative", () => {
  const scene = createUniform();
  const seen: number[] = [];
  scene.onUniformScaleChange = (s) => seen.push(s);
  scene.updatePropGizmo({ x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, scale: 5 });

  dragScale(scene, { x: 100 }); // 500 → 10
  scene.gizmoTarget.scale.set(1, 1, 1);
  dragScale(scene, { x: 0.0001 }); // 0.0005 → 0.1
  scene.gizmoTarget.scale.set(1, 1, 1);
  // TransformControls can drive a handle through the origin and out the far
  // side; a negative factor would MIRROR the prop, and the Lua half's contract
  // is that it never sees one.
  dragScale(scene, { x: -3 });
  expect(seen).toEqual([10, 0.1, 1]);
  expect(seen.every((s) => s >= 0.1 && s <= 10)).toBe(true);
});

test("updatePropGizmo tracks the starting scale and absent/invalid resolves to 1", () => {
  const scene = createUniform();
  const seen: number[] = [];
  scene.onUniformScaleChange = (s) => seen.push(s);

  scene.updatePropGizmo({ x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 });
  expect(scene.uniformScaleStart).toBe(1);
  dragScale(scene, { x: 3 });
  expect(seen.at(-1)).toBe(3);

  // An older record with no scale handle wrote 0; it must not collapse the prop.
  scene.gizmoTarget.scale.set(1, 1, 1);
  scene.updatePropGizmo({ x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, scale: 0 });
  expect(scene.uniformScaleStart).toBe(1);

  // Re-attaching the handle resets its relative scale, which is what makes the
  // multiply above correct on the next drag.
  scene.gizmoTarget.scale.set(4, 4, 4);
  scene.updatePropGizmo({ x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, scale: 2 });
  expect(scene.gizmoTarget.scale.toArray()).toEqual([1, 1, 1]);
  expect(scene.uniformScaleStart).toBe(2);
});

test("a scale drag end resets the handle, so factors do not compound across drags", () => {
  const scene = createUniform();
  const seen: number[] = [];
  scene.onUniformScaleChange = (s) => seen.push(s);
  scene.updatePropGizmo({ x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, scale: 1 });
  const controls = scene.transformControls as unknown as Controls;

  dragScale(scene, { x: 2 });
  controls.emit("dragging-changed", { value: false });
  expect(scene.gizmoTarget.scale.toArray()).toEqual([1, 1, 1]);
  // The host has stored 2 and fed it back; a second 2x drag is 4, not 2.
  scene.updatePropGizmo({ x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, scale: seen.at(-1) });
  dragScale(scene, { x: 2 });
  expect(seen).toEqual([2, 4]);
});

test("the 2D sw/sh scale path is untouched when uniformScale is off", () => {
  const scene = createUniform({ uniformScale: false });
  const pairs: [number, number][] = [];
  scene.onScaleChange = (sw, sh) => pairs.push([sw, sh]);
  scene.onUniformScaleChange = mock(() => {});
  scene.updateGizmoPosition([{ x: 0, y: 0, z: 0, sw: 0.5, sh: 0.25 }], 0);

  dragScale(scene, { x: 2, y: 4 });
  expect(pairs).toEqual([[1, 1]]);
  expect(scene.onUniformScaleChange).not.toHaveBeenCalled();
});
