import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import * as THREE from "three";
import type { Animation } from "../rage/ycd";
import { TrackType } from "../rage/ycd";
import type { SkeletonJson } from "./skeleton";

// Same approach as gizmo/GizmoScene.test.ts: keep real three geometry and maths,
// mock only the GPU and the DOM-bound addon controls. Nothing here needs WebGL, so
// nothing here silently skips.
class Renderer {
  domElement: HTMLCanvasElement;
  render = mock(() => {});
  dispose = mock(() => {});
  setPixelRatio = mock(() => {});
  setSize = mock(() => {});
  constructor({ canvas }: { canvas: HTMLCanvasElement }) {
    this.domElement = canvas;
  }
}
class Orbit {
  enabled = true;
  enableDamping = false;
  target = new THREE.Vector3();
  update = mock(() => {});
  dispose = mock(() => {});
}
class Transform {
  mode = "translate";
  enabled = false;
  dragging = false;
  object: THREE.Object3D | null = null;
  listeners = new Map<string, Set<(e: { value?: boolean }) => void>>();
  helper = new THREE.Object3D();
  setSize() {}
  setSpace() {}
  setMode(mode: string) {
    this.mode = mode;
  }
  setTranslationSnap() {}
  setRotationSnap() {}
  attach(object: THREE.Object3D) {
    this.object = object;
  }
  detach = mock(function (this: Transform) {
    this.object = null;
  });
  getHelper() {
    return this.helper;
  }
  addEventListener(name: string, fn: (e: { value?: boolean }) => void) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)?.add(fn);
  }
  emit(name: string, event: { value?: boolean } = {}) {
    for (const fn of this.listeners.get(name) ?? []) fn(event);
  }
  dispose = mock(() => {});
}
// PMREMGenerator would need a real context; the scene already catches that, and
// mocking it keeps the failure path out of these assertions.
mock.module("three", () => ({ ...THREE, WebGLRenderer: Renderer }));
mock.module("three/addons/controls/OrbitControls.js", () => ({ OrbitControls: Orbit }));
mock.module("three/addons/controls/TransformControls.js", () => ({ TransformControls: Transform }));
const { AnimViewerScene } = await import("./AnimViewerScene");
const { PH_R_HAND_TAG } = await import("./prop-attach");

class Target {
  listeners = new Map<string, Set<EventListener>>();
  devicePixelRatio = 1;
  clientWidth = 800;
  clientHeight = 600;
  parentElement = { clientWidth: 800, clientHeight: 600 };
  addEventListener(name: string, fn: EventListener) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)?.add(fn);
  }
  removeEventListener(name: string, fn: EventListener) {
    this.listeners.get(name)?.delete(fn);
  }
  count() {
    return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0);
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
let scenes: InstanceType<typeof AnimViewerScene>[];

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

const SKEL: SkeletonJson = {
  boneCount: 3,
  bones: [
    {
      tag: 0,
      name: "SKEL_ROOT",
      index: 0,
      parentIndex: -1,
      translation: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
    },
    {
      tag: 11816,
      name: "SKEL_Pelvis",
      index: 1,
      parentIndex: 0,
      translation: [0, 0, 1],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
    },
    {
      tag: PH_R_HAND_TAG,
      name: "PH_R_Hand",
      index: 2,
      parentIndex: 1,
      translation: [0.2, 0, 0],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
    },
  ],
};

type Sampler = (frame: number) => [number, number, number, number];
function fakeAnimation(
  frames: number,
  duration: number,
  tracks: { boneId: number; track: number; sample: Sampler }[]
): Animation {
  return {
    hash: 0,
    frames,
    sequenceFrameLimit: frames,
    duration,
    boneIds: tracks.map((t) => ({ boneId: t.boneId, unk0: 0, track: t.track })),
    sequences: [
      {
        numFrames: frames,
        frameLength: 0,
        chunkSize: 0,
        tracks: tracks.map((t) => ({ evaluateVector: (f: number) => t.sample(f) })),
      },
    ],
  } as unknown as Animation;
}

/** Non-null assert with a real failure message instead of a `!`. */
function req<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`missing ${what}`);
  return value;
}

function create(skeleton: SkeletonJson | null = SKEL) {
  const scene = new AnimViewerScene({
    canvas: new Target() as unknown as HTMLCanvasElement,
    skeleton,
  });
  scenes.push(scene);
  return scene;
}
function frame() {
  const [id, fn] = req(pending.entries().next().value, "a pending animation frame");
  pending.delete(id);
  fn(0);
}

test("the rig hangs under a single -90deg X group, so GTA Z-up maps to three Y-up", () => {
  const scene = create();
  expect(scene.zUp.rotation.x).toBeCloseTo(-Math.PI / 2, 12);
  expect(scene.mover.parent).toBe(scene.zUp);
  expect(scene.skeleton?.roots[0].parent).toBe(scene.mover);

  // The hand is GTA (0.2, 0, 1); in three that must read (0.2, 1, 0).
  scene.zUp.updateMatrixWorld(true);
  const hand = req(req(scene.skeleton, "skeleton").byTag.get(PH_R_HAND_TAG), "PH_R_Hand");
  const world = new THREE.Vector3().setFromMatrixPosition(hand.matrixWorld);
  expect(world.x).toBeCloseTo(0.2, 6);
  expect(world.y).toBeCloseTo(1, 6);
  expect(world.z).toBeCloseTo(0, 6);
});

test("setAnimation binds tracks against the real node graph", () => {
  const scene = create();
  const info = scene.setAnimation(
    fakeAnimation(4, 0.2, [
      { boneId: PH_R_HAND_TAG, track: TrackType.BonePosition, sample: (f) => [f, 0, 0, 0] },
    ]),
    "radio_check"
  );
  expect(info?.boundTracks).toBe(1);
  expect(info?.fps).toBe(20);
  expect(scene.action).not.toBeNull();
  expect(scene.duration).toBeCloseTo(0.2, 12);

  // Frame 2 is at 0.1s: the binding resolved if the bone actually moved.
  scene.setTime(0.1);
  expect(
    req(req(scene.skeleton, "skeleton").byTag.get(PH_R_HAND_TAG), "PH_R_Hand").position.x
  ).toBeCloseTo(2, 5);
  expect(scene.playbackState.frame).toBe(2);
});

test("scrubbing applies the pose while paused", () => {
  const scene = create();
  scene.setAnimation(
    fakeAnimation(10, 1, [
      { boneId: PH_R_HAND_TAG, track: TrackType.BonePosition, sample: (f) => [f / 10, 0, 0, 0] },
    ])
  );
  expect(scene.isPlaying).toBe(false);
  scene.setFrame(7);
  expect(scene.time).toBeCloseTo(0.7, 6);
  expect(
    req(req(scene.skeleton, "skeleton").byTag.get(PH_R_HAND_TAG), "PH_R_Hand").position.x
  ).toBeCloseTo(0.7, 5);
  // Out-of-range scrubs clamp rather than throwing or wrapping.
  scene.setTime(99);
  expect(scene.time).toBeCloseTo(1, 6);
  scene.setTime(-5);
  expect(scene.time).toBe(0);
});

test("play/pause and speed drive the action, not a private clock", () => {
  const scene = create();
  scene.setAnimation(
    fakeAnimation(10, 1, [
      { boneId: PH_R_HAND_TAG, track: TrackType.BonePosition, sample: () => [0, 0, 0, 0] },
    ])
  );
  expect(scene.action?.paused).toBe(true);
  scene.play();
  expect(scene.action?.paused).toBe(false);
  scene.setSpeed(2);
  expect(scene.action?.timeScale).toBe(2);
  scene.tick(0.25);
  expect(scene.time).toBeCloseTo(0.5, 6);
  scene.pause();
  scene.tick(0.25);
  expect(scene.time).toBeCloseTo(0.5, 6);
});

test("setLoop switches the action's loop mode", () => {
  const scene = create();
  scene.setAnimation(
    fakeAnimation(4, 0.2, [
      { boneId: PH_R_HAND_TAG, track: TrackType.BonePosition, sample: () => [0, 0, 0, 0] },
    ])
  );
  expect(scene.action?.loop).toBe(THREE.LoopRepeat);
  scene.setLoop(false);
  expect(scene.action?.loop).toBe(THREE.LoopOnce);
});

test("the root motion toggle rebuilds the clip and keeps the scrub position", () => {
  const scene = create();
  const anim = fakeAnimation(10, 1, [
    { boneId: 0, track: TrackType.MoverPosition, sample: (f) => [f / 10, 0, 0, 0] },
    { boneId: PH_R_HAND_TAG, track: TrackType.BonePosition, sample: () => [0.2, 0, 0, 0] },
  ]);
  scene.setAnimation(anim);
  expect(scene.rootMotionEnabled).toBe(false);
  expect(scene.clipInfo?.boundTracks).toBe(1);
  scene.setTime(0.5);

  scene.setRootMotion(true);
  expect(scene.clipInfo?.rootMotionApplied).toBe(true);
  expect(scene.clipInfo?.boundTracks).toBe(2);
  expect(scene.time).toBeCloseTo(0.5, 6);
  expect(scene.mover.position.x).toBeCloseTo(0.5, 5);

  scene.setRootMotion(false);
  expect(scene.mover.position.x).toBe(0);
});

test("an animation set before the skeleton is applied once the skeleton arrives", () => {
  const scene = create(null);
  expect(scene.skeleton).toBeNull();
  expect(
    scene.setAnimation(
      fakeAnimation(4, 0.2, [
        { boneId: PH_R_HAND_TAG, track: TrackType.BonePosition, sample: () => [1, 0, 0, 0] },
      ])
    )
  ).toBeNull();
  scene.setSkeleton(SKEL);
  expect(scene.clipInfo?.boundTracks).toBe(1);
});

test("warnings from the clip build are surfaced, not swallowed", () => {
  const scene = create();
  const seen: string[][] = [];
  scene.onWarnings = (w) => seen.push(w);
  scene.setAnimation(
    fakeAnimation(4, 0.2, [
      { boneId: 999999, track: TrackType.BonePosition, sample: () => [0, 0, 0, 0] },
    ])
  );
  expect(seen.flat().join(" ")).toMatch(/999999/);
});

test("attachProp parents to the tagged bone and reports drags as game-ready records", () => {
  const scene = create();
  const records: unknown[] = [];
  scene.onPlacementChange = (r) => records.push(r);

  const prop = scene.attachProp(
    "prop_cs_hand_radio",
    PH_R_HAND_TAG,
    [0.13, 0.05, 0.01, -113, 0, -60],
    {
      bounds: { min: [-0.03, -0.02, 0], max: [0.03, 0.02, 0.18] },
    }
  );
  expect(prop).not.toBeNull();
  expect(prop?.root.parent?.name).toBe("PH_R_Hand");
  expect(scene.transformControls.enabled).toBe(true);

  // Simulate a TransformControls drag: it writes the object's PARENT-space transform.
  req(prop, "prop").root.position.set(0.2, 0, 0);
  (scene.transformControls as unknown as Transform).emit("objectChange");
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ model: "prop_cs_hand_radio", bone: PH_R_HAND_TAG });
  expect((records[0] as { placement: number[] }).placement.slice(0, 3)).toEqual([0.2, 0, 0]);
});

test("attachProp refuses an unknown bone tag rather than attaching to the root", () => {
  const scene = create();
  expect(scene.attachProp("m", 424242)).toBeNull();
  expect(scene.prop).toBeNull();
});

test("setPropBone moves the prop and keeps the placement numbers", () => {
  const scene = create();
  scene.attachProp("m", PH_R_HAND_TAG, [0.1, 0.2, 0.3, 0, 0, 0]);
  expect(scene.setPropBone(11816)).toBe(true);
  expect(scene.prop?.root.parent?.name).toBe("SKEL_Pelvis");
  expect(scene.prop?.getPlacement(4).slice(0, 3)).toEqual([0.1, 0.2, 0.3]);
  expect(scene.setPropBone(424242)).toBe(false);
});

test("dragging the gizmo suspends orbit and releasing restores it", () => {
  const scene = create();
  const controls = scene.transformControls as unknown as Transform;
  controls.emit("dragging-changed", { value: true });
  expect(scene.orbit.enabled).toBe(false);
  controls.emit("dragging-changed", { value: false });
  expect(scene.orbit.enabled).toBe(true);
});

test("repeated start creates one RAF chain; stop and restart are safe", () => {
  const scene = create();
  scene.startLoop();
  scene.startLoop();
  expect(pending.size).toBe(1);
  expect(scene.renderer.render).toHaveBeenCalledTimes(1);
  frame();
  expect(scene.renderer.render).toHaveBeenCalledTimes(2);
  const stale = [...pending.values()][0];
  scene.stopLoop();
  scene.stopLoop();
  expect(pending.size).toBe(0);
  scene.startLoop();
  stale(0);
  expect(pending.size).toBe(1);
  expect(scene.renderer.render).toHaveBeenCalledTimes(3);
});

test("dispose frees once, cancels RAF, drops listeners and prevents restart", () => {
  const scene = create();
  scene.attachProp("m", PH_R_HAND_TAG);
  scene.startLoop();
  const stale = [...pending.values()][0];
  scene.dispose();
  scene.dispose();
  scene.startLoop();
  stale(0);
  expect(pending.size).toBe(0);
  expect(win.count()).toBe(0);
  expect(scene.renderer.dispose).toHaveBeenCalledTimes(1);
  expect(scene.transformControls.dispose).toHaveBeenCalledTimes(1);
  expect(scene.orbit.dispose).toHaveBeenCalledTimes(1);
  expect(scene.skeleton).toBeNull();
});

test("frameSkeleton points the camera at the rig", () => {
  const scene = create();
  scene.frameSkeleton();
  // Rig spans GTA z 0..1 => three y 0..1; the target must land inside that.
  expect(scene.orbit.target.y).toBeGreaterThan(0);
  expect(scene.orbit.target.y).toBeLessThan(1.01);
  expect(scene.camera.position.length()).toBeGreaterThan(0.5);
});

test("a held pose is applied to the bones without a mixer action", () => {
  // frames=1/duration=0 used to build nothing and render a blank viewer. It must now
  // show the pose - and must NOT go through the mixer, because three's LoopRepeat
  // divides by the clip duration.
  const scene = create();
  const info = scene.setAnimation(
    fakeAnimation(1, 0, [
      { boneId: PH_R_HAND_TAG, track: TrackType.BonePosition, sample: () => [0.4, 0, 0, 0] },
    ]),
    "sitdown_clip"
  );
  expect(info?.kind).toBe("pose");
  expect(scene.isPose).toBe(true);
  expect(scene.action).toBeNull();
  expect(
    req(req(scene.skeleton, "skeleton").byTag.get(PH_R_HAND_TAG), "PH_R_Hand").position.x
  ).toBeCloseTo(0.4, 6);
});

test("a pose exposes no timeline and cannot be played or scrubbed into motion", () => {
  const scene = create();
  scene.setAnimation(
    fakeAnimation(1, 0, [
      { boneId: PH_R_HAND_TAG, track: TrackType.BonePosition, sample: () => [0.4, 0, 0, 0] },
    ])
  );
  expect(scene.duration).toBe(0);
  expect(scene.playbackState.kind).toBe("pose");
  scene.play();
  // play() on a pose is a no-op: a transport that says "playing" while time never
  // advances is worse than no transport.
  expect(scene.isPlaying).toBe(false);
  scene.tick(1);
  expect(scene.time).toBe(0);
  scene.setTime(5);
  expect(scene.time).toBe(0);
});

test("switching from a pose back to an animation restores playback", () => {
  const scene = create();
  scene.setAnimation(
    fakeAnimation(1, 0, [
      { boneId: PH_R_HAND_TAG, track: TrackType.BonePosition, sample: () => [0.4, 0, 0, 0] },
    ])
  );
  expect(scene.isPose).toBe(true);
  scene.setAnimation(
    fakeAnimation(10, 1, [
      { boneId: PH_R_HAND_TAG, track: TrackType.BonePosition, sample: (f) => [f / 10, 0, 0, 0] },
    ])
  );
  expect(scene.isPose).toBe(false);
  expect(scene.action).not.toBeNull();
  scene.play();
  expect(scene.isPlaying).toBe(true);
  scene.tick(0.5);
  expect(scene.time).toBeCloseTo(0.5, 6);
});

test("the playback state carries the built kind so a UI can label it", () => {
  const scene = create();
  expect(scene.playbackState.kind).toBe("empty");
  scene.setAnimation(
    fakeAnimation(10, 1, [
      { boneId: PH_R_HAND_TAG, track: TrackType.BonePosition, sample: () => [0, 0, 0, 0] },
    ])
  );
  expect(scene.playbackState.kind).toBe("animation");
});
