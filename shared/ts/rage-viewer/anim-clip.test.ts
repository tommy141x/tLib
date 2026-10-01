import { expect, test } from "bun:test";
import * as THREE from "three";
import type { Animation } from "../rage/ycd";
import { TrackType } from "../rage/ycd";
import {
  applyPose,
  buildAnimationClip,
  DEFAULT_MOVER_NODE_NAME,
  describeAnimationTracks,
  enforceQuaternionContinuity,
  nativeFps,
  normaliseQuaternionValues,
} from "./anim-clip";
import { buildSkeleton, type SkeletonJson } from "./skeleton";

// The .ycd reader is verified separately against CodeWalker (18.5M components), so
// these tests stub at the sampleTrack boundary: a synthetic Animation whose tracks
// return known values. That keeps them about THIS module's job - targeting the
// right node, at the right time, with continuous quaternions.
type Sampler = (frame: number) => [number, number, number, number];

function fakeAnimation(
  frames: number,
  duration: number,
  tracks: { boneId: number; track: number; sample: Sampler }[],
  sequenceFrameLimit = frames
): Animation {
  const blockCount = Math.max(1, Math.ceil(frames / sequenceFrameLimit));
  const sequences = Array.from({ length: blockCount }, (_, block) => ({
    numFrames: sequenceFrameLimit,
    frameLength: 0,
    chunkSize: 0,
    tracks: tracks.map((t) => ({
      evaluateVector: (local: number) => t.sample(block * sequenceFrameLimit + local),
    })),
  }));
  return {
    hash: 0,
    frames,
    sequenceFrameLimit,
    duration,
    boneIds: tracks.map((t) => ({ boneId: t.boneId, unk0: 0, track: t.track })),
    sequences,
  } as unknown as Animation;
}

const SKEL: SkeletonJson = {
  boneCount: 2,
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
      tag: 28422,
      name: "PH_R_Hand",
      index: 1,
      parentIndex: 0,
      translation: [0, 0, 1],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
    },
  ],
};

/** Non-null assert with a real failure message instead of a `!`. */
function req<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`missing ${what}`);
  return value;
}

function skeleton() {
  return buildSkeleton(SKEL);
}

test("nativeFps guards the degenerate cases", () => {
  expect(nativeFps({ frames: 60, duration: 2 })).toBe(30);
  expect(nativeFps({ frames: 0, duration: 2 })).toBe(0);
  expect(nativeFps({ frames: 60, duration: 0 })).toBe(0);
  expect(nativeFps({ frames: 60, duration: Number.NaN })).toBe(0);
});

test("a position track targets the bone the TAG names, not the index", () => {
  // Tag 28422 is index 1. A tag-as-index bug would target index 28422 (absent) or
  // SKEL_ROOT, so the track name is the assertion.
  const anim = fakeAnimation(4, 0.2, [
    { boneId: 28422, track: TrackType.BonePosition, sample: (f) => [f, 0, 0, 0] },
  ]);
  const r = buildAnimationClip(anim, skeleton());
  expect(r.boundTracks).toBe(1);
  expect(r.clip.tracks[0].name).toBe("PH_R_Hand.position");
  expect(r.clip.tracks[0]).toBeInstanceOf(THREE.VectorKeyframeTrack);
  expect(Array.from(r.clip.tracks[0].values)).toEqual([0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0]);
  expect(r.unresolvedBoneTags).toEqual([]);
});

test("rotation and scale tracks map to the right three track types", () => {
  const anim = fakeAnimation(2, 0.1, [
    { boneId: 28422, track: TrackType.BoneRotation, sample: () => [0, 0, 0, 1] },
    { boneId: 28422, track: TrackType.BoneScale, sample: () => [2, 2, 2, 0] },
  ]);
  const r = buildAnimationClip(anim, skeleton());
  const byName = new Map(r.clip.tracks.map((t) => [t.name, t]));
  expect(byName.get("PH_R_Hand.quaternion")).toBeInstanceOf(THREE.QuaternionKeyframeTrack);
  expect(byName.get("PH_R_Hand.scale")).toBeInstanceOf(THREE.VectorKeyframeTrack);
  expect(Array.from(req(byName.get("PH_R_Hand.scale"), "scale track").values)).toEqual([2, 2, 2, 2, 2, 2]);
});

test("key times are the native rate and the clip keeps the animation's duration", () => {
  const anim = fakeAnimation(30, 1, [
    { boneId: 28422, track: TrackType.BonePosition, sample: () => [0, 0, 0, 0] },
  ]);
  const r = buildAnimationClip(anim, skeleton());
  expect(r.fps).toBe(30);
  expect(r.clip.duration).toBe(1);
  const times = Array.from(r.clip.tracks[0].times);
  expect(times).toHaveLength(30);
  expect(times[0]).toBe(0);
  expect(times[1]).toBeCloseTo(1 / 30, 7);
  expect(times[29]).toBeCloseTo(29 / 30, 7);
});

test("frames are read across sequence blocks, not just the first", () => {
  // 10 frames in blocks of 4: the last block is partial, which is the case that
  // breaks if you index `sequences` directly instead of going through sampleTrack.
  const anim = fakeAnimation(
    10,
    0.5,
    [{ boneId: 28422, track: TrackType.BonePosition, sample: (f) => [f, 0, 0, 0] }],
    4
  );
  const r = buildAnimationClip(anim, skeleton());
  const xs = Array.from(r.clip.tracks[0].values).filter((_, i) => i % 3 === 0);
  expect(xs).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test("enforceQuaternionContinuity negates keys that cross hemispheres", () => {
  // Only the middle key crosses; the third already agrees with the corrected
  // second one, so a correct pass flips once, not twice.
  const values = [0, 0, 0, 1, 0, 0, 0, -1, 0, 0, 0, 1];
  expect(enforceQuaternionContinuity(values)).toBe(1);
  expect(values).toEqual([0, 0, 0, 1, -0, -0, -0, 1, 0, 0, 0, 1]);
  // Idempotent: a second pass has nothing left to do.
  expect(enforceQuaternionContinuity(values)).toBe(0);
});

test("a hemisphere-flipped rotation track is made continuous during the build", () => {
  // Without the fix, slerping frame 0 -> 1 goes the long way round and the joint
  // visibly spins; the stored values are what three interpolates between.
  const s = Math.SQRT1_2;
  const keys: [number, number, number, number][] = [
    [0, 0, 0, 1],
    [0, 0, -s, -s],
    [0, 0, 1, 0],
  ];
  const anim = fakeAnimation(3, 0.1, [
    { boneId: 28422, track: TrackType.BoneRotation, sample: (f) => keys[f] },
  ]);
  const r = buildAnimationClip(anim, skeleton());
  expect(r.quaternionFlips).toBe(1);
  const v = r.clip.tracks[0].values;
  for (let i = 4; i < v.length; i += 4) {
    const dot =
      v[i] * v[i - 4] + v[i + 1] * v[i - 3] + v[i + 2] * v[i - 2] + v[i + 3] * v[i - 1];
    expect(dot).toBeGreaterThanOrEqual(0);
  }
  // The orientation is unchanged: q and -q are the same rotation.
  const q = new THREE.Quaternion(v[4], v[5], v[6], v[7]);
  expect(Math.abs(q.dot(new THREE.Quaternion(0, 0, -s, -s)))).toBeCloseTo(1, 6);
});

test("mover tracks are dropped in place and emitted with root motion on", () => {
  const anim = fakeAnimation(2, 0.1, [
    { boneId: 0, track: TrackType.MoverPosition, sample: (f) => [f, 0, 0, 0] },
    { boneId: 0, track: TrackType.MoverRotation, sample: () => [0, 0, 0, 1] },
    { boneId: 28422, track: TrackType.BonePosition, sample: () => [0, 0, 0, 0] },
  ]);

  const inPlace = buildAnimationClip(anim, skeleton());
  expect(inPlace.rootMotionApplied).toBe(false);
  expect(inPlace.clip.tracks.map((t) => t.name)).toEqual(["PH_R_Hand.position"]);
  expect(inPlace.skippedTracks).toEqual([
    { track: TrackType.MoverPosition, count: 1 },
    { track: TrackType.MoverRotation, count: 1 },
  ]);

  const moving = buildAnimationClip(anim, skeleton(), { rootMotion: true });
  expect(moving.rootMotionApplied).toBe(true);
  expect(moving.clip.tracks.map((t) => t.name)).toEqual([
    `${DEFAULT_MOVER_NODE_NAME}.position`,
    `${DEFAULT_MOVER_NODE_NAME}.quaternion`,
    "PH_R_Hand.position",
  ]);
});

test("requesting root motion on a clip that has none warns", () => {
  const anim = fakeAnimation(2, 0.1, [
    { boneId: 28422, track: TrackType.BonePosition, sample: () => [0, 0, 0, 0] },
  ]);
  const r = buildAnimationClip(anim, skeleton(), { rootMotion: true });
  expect(r.rootMotionApplied).toBe(false);
  expect(r.warnings.join(" ")).toMatch(/no mover tracks/);
});

test("an unsupported track type is skipped and reported, not fatal", () => {
  const seen: number[] = [];
  const anim = fakeAnimation(2, 0.1, [
    { boneId: 28422, track: TrackType.UV0, sample: () => [0, 0, 0, 0] },
    { boneId: 28422, track: 99, sample: () => [0, 0, 0, 0] },
    { boneId: 28422, track: TrackType.BonePosition, sample: () => [1, 2, 3, 0] },
  ]);
  const r = buildAnimationClip(anim, skeleton(), {
    onUnsupportedTrack: (info) => seen.push(info.track),
  });
  expect(seen).toEqual([TrackType.UV0, 99]);
  expect(r.boundTracks).toBe(1);
  expect(r.skippedTracks).toEqual([
    { track: TrackType.UV0, count: 1 },
    { track: 99, count: 1 },
  ]);
  expect(r.warnings).toHaveLength(2);
});

test("a bone tag the skeleton lacks is reported, and the rest still binds", () => {
  const anim = fakeAnimation(2, 0.1, [
    { boneId: 123456, track: TrackType.BoneRotation, sample: () => [0, 0, 0, 1] },
    { boneId: 28422, track: TrackType.BonePosition, sample: () => [0, 0, 0, 0] },
  ]);
  const r = buildAnimationClip(anim, skeleton());
  expect(r.unresolvedBoneTags).toEqual([123456]);
  expect(r.boundTracks).toBe(1);
  expect(r.warnings.join(" ")).toMatch(/123456/);
});

test("a zero-duration animation is a pose, and emits no NaN key times", () => {
  // This used to return an empty clip - correct arithmetic, blank preview. A zero
  // duration means a held pose, not a broken file.
  const anim = fakeAnimation(4, 0, [
    { boneId: 28422, track: TrackType.BonePosition, sample: () => [0.5, 0, 0, 0] },
  ]);
  const r = buildAnimationClip(anim, skeleton());
  expect(r.kind).toBe("pose");
  expect(r.fps).toBe(0);
  expect(r.boundTracks).toBe(1);
  expect(Array.from(r.clip.tracks[0].times)).toEqual([0]);
  expect(Array.from(r.clip.tracks[0].times).every(Number.isFinite)).toBe(true);
});

test("bones with no track are left at rest by the mixer", () => {
  const skel = skeleton();
  const anim = fakeAnimation(2, 0.1, [
    { boneId: 28422, track: TrackType.BonePosition, sample: () => [5, 5, 5, 0] },
  ]);
  const root = new THREE.Group();
  root.add(skel.roots[0]);
  const mixer = new THREE.AnimationMixer(root);
  mixer.clipAction(buildAnimationClip(anim, skel).clip).play();
  mixer.update(0);
  expect(req(skel.byTag.get(28422), "PH_R_Hand").position.toArray()).toEqual([5, 5, 5]);
  // SKEL_ROOT has no track at all; it must still be at its rest transform.
  expect(req(skel.byTag.get(0), "SKEL_ROOT").position.toArray()).toEqual([0, 0, 0]);
});

test("describeAnimationTracks groups track kinds by tag", () => {
  const anim = fakeAnimation(2, 0.1, [
    { boneId: 28422, track: TrackType.BonePosition, sample: () => [0, 0, 0, 0] },
    { boneId: 28422, track: TrackType.BoneRotation, sample: () => [0, 0, 0, 1] },
    { boneId: 0, track: TrackType.MoverPosition, sample: () => [0, 0, 0, 0] },
  ]);
  expect(describeAnimationTracks(anim)).toEqual([
    { tag: 28422, tracks: [TrackType.BonePosition, TrackType.BoneRotation] },
    { tag: 0, tracks: [TrackType.MoverPosition] },
  ]);
});

// ---------------------------------------------------------------- held poses

test("a single-frame animation builds a one-key pose clip, not nothing", () => {
  // The real defect: sitdownonknees@queensisters.ycd / sitdown_clip is frames=1,
  // duration=0 with 384 bone ids, all 128 tags on the ped skeleton. Emitting nothing
  // showed a blank preview of a perfectly good asset.
  const anim = fakeAnimation(
    1,
    0,
    [
      { boneId: 28422, track: TrackType.BonePosition, sample: () => [1, 2, 3, 0] },
      { boneId: 28422, track: TrackType.BoneRotation, sample: () => [0, 0, 0, 1] },
      { boneId: 0, track: TrackType.BoneScale, sample: () => [1, 1, 1, 0] },
    ],
    31
  );
  const r = buildAnimationClip(anim, skeleton());
  expect(r.kind).toBe("pose");
  expect(r.boundTracks).toBe(3);
  expect(r.clip.tracks).toHaveLength(3);
  for (const t of r.clip.tracks) expect(Array.from(t.times)).toEqual([0]);
  expect(Array.from(r.clip.tracks[0].values)).toEqual([1, 2, 3]);
  // Duration 0: three's LoopRepeat divides by the duration, so the scene must not
  // play this through the mixer - and `kind` is how it knows.
  expect(r.clip.duration).toBe(0);
  expect(r.classification.kind).toBe("pose");
  expect(r.warnings.join(" ")).toMatch(/single held pose/);
});

test("a zero-duration multi-frame animation is also built as a pose", () => {
  const anim = fakeAnimation(30, 0, [
    { boneId: 28422, track: TrackType.BonePosition, sample: (f) => [f, 0, 0, 0] },
  ]);
  const r = buildAnimationClip(anim, skeleton());
  expect(r.kind).toBe("pose");
  expect(Array.from(r.clip.tracks[0].values)).toEqual([0, 0, 0]);
});

test("zero frames is empty, and says so distinctly from a pose", () => {
  const r = buildAnimationClip(
    fakeAnimation(0, 1, [
      { boneId: 28422, track: TrackType.BonePosition, sample: () => [0, 0, 0, 0] },
    ]),
    skeleton()
  );
  expect(r.kind).toBe("empty");
  expect(r.boundTracks).toBe(0);
  expect(r.warnings.join(" ")).toMatch(/nothing to sample/);
});

test("applyPose writes frame transforms straight onto the bones", () => {
  const skel = skeleton();
  const anim = fakeAnimation(
    1,
    0,
    [
      { boneId: 28422, track: TrackType.BonePosition, sample: () => [0.5, 0.25, 0.125, 0] },
      // Deliberately non-unit, as quantised rotation tracks are.
      { boneId: 28422, track: TrackType.BoneRotation, sample: () => [0, 0, 0.6, 0.6] },
      { boneId: 28422, track: TrackType.BoneScale, sample: () => [2, 2, 2, 0] },
    ],
    31
  );
  const applied = applyPose(anim, skel, 0);
  expect(applied).toEqual({ bonesPosed: 1, tracksApplied: 3 });
  const hand = req(skel.byTag.get(28422), "PH_R_Hand");
  expect(hand.position.toArray()).toEqual([0.5, 0.25, 0.125]);
  expect(hand.scale.toArray()).toEqual([2, 2, 2]);
  expect(hand.quaternion.length()).toBeCloseTo(1, 12);
  // Bones with no track keep their rest transform.
  expect(req(skel.byTag.get(0), "SKEL_ROOT").position.toArray()).toEqual([0, 0, 0]);
});

test("applyPose ignores mover and unsupported tracks and unknown tags", () => {
  const skel = skeleton();
  const anim = fakeAnimation(
    1,
    0,
    [
      { boneId: 0, track: TrackType.MoverPosition, sample: () => [9, 9, 9, 0] },
      { boneId: 999999, track: TrackType.BonePosition, sample: () => [9, 9, 9, 0] },
      { boneId: 28422, track: TrackType.UV0, sample: () => [9, 9, 9, 0] },
    ],
    31
  );
  expect(applyPose(anim, skel, 0)).toEqual({ bonesPosed: 0, tracksApplied: 0 });
  expect(req(skel.byTag.get(0), "SKEL_ROOT").position.toArray()).toEqual([0, 0, 0]);
});

// ------------------------------------------------- quaternion normalisation

test("normaliseQuaternionValues reports the worst deviation and fixes every key", () => {
  const values = [0, 0, 0, 1, 0, 0, 0.6, 0.6, 0, 0, 0, 0];
  const { maxDeviation, degenerate } = normaliseQuaternionValues(values);
  // |(0,0,0.6,0.6)| = 0.8485..., so the deviation is ~0.1515. The zero-length key is
  // counted as degenerate and excluded, or its deviation of exactly 1 would swamp
  // the quantisation-noise signal this number exists to report.
  expect(maxDeviation).toBeCloseTo(1 - Math.hypot(0.6, 0.6), 12);
  expect(degenerate).toBe(1);
  for (let i = 0; i < values.length; i += 4) {
    expect(Math.hypot(values[i], values[i + 1], values[i + 2], values[i + 3])).toBeCloseTo(1, 12);
  }
  // A zero-length key becomes identity rather than NaN.
  expect(values.slice(8)).toEqual([0, 0, 0, 1]);
});

test("rotation keys are normalised during the build and the deviation is reported", () => {
  // Measured on the real corpus: a non-type-7 rotation track is four independently
  // QuantizeFloat-encoded channels, so |q| drifts. Worst seen over 60 files was
  // |q|-1 = 7.837e-3; three's slerp assumes unit input.
  const anim = fakeAnimation(3, 0.1, [
    { boneId: 28422, track: TrackType.BoneRotation, sample: () => [0, 0, 0.7, 0.7] },
  ]);
  const r = buildAnimationClip(anim, skeleton());
  expect(r.maxQuaternionDeviation).toBeCloseTo(1 - Math.hypot(0.7, 0.7), 6);
  expect(r.degenerateQuaternions).toBe(0);
  const v = r.clip.tracks[0].values;
  for (let i = 0; i < v.length; i += 4) {
    expect(Math.hypot(v[i], v[i + 1], v[i + 2], v[i + 3])).toBeCloseTo(1, 6);
  }
});

test("normalisation does not undo the hemisphere fix", () => {
  const s = 0.6;
  const keys: [number, number, number, number][] = [
    [0, 0, 0, 1],
    [0, 0, -s, -s],
    [0, 0, s, s],
  ];
  const anim = fakeAnimation(3, 0.1, [
    { boneId: 28422, track: TrackType.BoneRotation, sample: (f) => keys[f] },
  ]);
  const r = buildAnimationClip(anim, skeleton());
  const v = r.clip.tracks[0].values;
  for (let i = 4; i < v.length; i += 4) {
    const dot = v[i] * v[i - 4] + v[i + 1] * v[i - 3] + v[i + 2] * v[i - 2] + v[i + 3] * v[i - 1];
    expect(dot).toBeGreaterThanOrEqual(0);
    // Float32Array storage, so unit-ness holds to float32 precision, not float64.
    expect(Math.hypot(v[i], v[i + 1], v[i + 2], v[i + 3])).toBeCloseTo(1, 6);
  }
});

test("a degenerate rotation key is replaced with identity and warned about", () => {
  const anim = fakeAnimation(2, 0.1, [
    { boneId: 28422, track: TrackType.BoneRotation, sample: () => [0, 0, 0, 0] },
  ]);
  const r = buildAnimationClip(anim, skeleton());
  expect(r.degenerateQuaternions).toBe(2);
  expect(r.warnings.join(" ")).toMatch(/zero-length/);
  expect(Array.from(r.clip.tracks[0].values)).toEqual([0, 0, 0, 1, 0, 0, 0, 1]);
});

test("the build result carries a classification that agrees with classifyAnimation", () => {
  const anim = fakeAnimation(
    1,
    0,
    [{ boneId: 28422, track: TrackType.BonePosition, sample: () => [0, 0, 0, 0] }],
    31
  );
  const r = buildAnimationClip(anim, skeleton());
  expect(r.classification.kind).toBe("pose");
  expect(r.classification.resolvedTags).toBe(1);
});
