import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import * as THREE from "three";

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
class Controls {
  dragging = false;
  setSize() {}
  setSpace() {}
  attach() {}
  getHelper() {
    return new THREE.Object3D();
  }
  addEventListener() {}
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
