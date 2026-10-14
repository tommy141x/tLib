import { expect, test } from "bun:test";
import type { Animation } from "../rage/ycd";
import { TrackType } from "../rage/ycd";
import {
  classifyAnimation,
  isFacialTrack,
  isPreviewableOnPed,
  PED_RIG_MIN_MATCH,
} from "./classify";

// Each fixture below mirrors a shape actually observed in a 60-file / 82-clip corpus;
// the counts in the comments are the measured ones. Classification feeds marketplace
// upload validation, so "roughly right" is not good enough - a creator gets told
// which of these their file is.
function anim(
  frames: number,
  duration: number,
  boneIds: { boneId: number; track: number }[]
): Animation {
  return {
    hash: 0,
    frames,
    sequenceFrameLimit: Math.max(frames, 1),
    duration,
    boneIds: boneIds.map((b) => ({ ...b, unk0: 0 })),
    sequences: [],
  } as unknown as Animation;
}

/** A fake ped skeleton holding exactly the tags given. */
function rig(tags: number[]) {
  return { byTag: new Map(tags.map((t) => [t, {}])) };
}

const BODY_TAGS = [0, 11816, 28422, 57005, 58271, 60309, 6286, 26875];
const PED = rig(BODY_TAGS);

function bodyTracks(tags: number[]) {
  return tags.flatMap((boneId) => [
    { boneId, track: TrackType.BonePosition },
    { boneId, track: TrackType.BoneRotation },
    { boneId, track: TrackType.BoneScale },
  ]);
}

test("a multi-frame ped clip is an animation", () => {
  // Corpus shape: 384 bone ids / 128 tags / kinds [0,1,2], 90 frames over 3.708s.
  const c = classifyAnimation(anim(90, 3.708, bodyTracks(BODY_TAGS)), PED);
  expect(c.kind).toBe("animation");
  expect(c.isStatic).toBe(false);
  expect(c.fps).toBeCloseTo(90 / 3.708, 6);
  expect(c.bodyTracks).toBe(24);
  expect(c.uniqueTags).toBe(8);
  expect(c.resolvedTags).toBe(8);
  expect(c.matchRatio).toBe(1);
  expect(c.trackTypes).toEqual([0, 1, 2]);
  expect(isPreviewableOnPed(c.kind)).toBe(true);
});

test("a single-frame ped clip is a pose, not a broken animation", () => {
  // The real defect: sitdownonknees@queensisters.ycd / sitdown_clip is frames=1,
  // duration=0, 384 bone ids, 128 tags, ALL matching the ped skeleton.
  const c = classifyAnimation(anim(1, 0, bodyTracks(BODY_TAGS)), PED);
  expect(c.kind).toBe("pose");
  expect(c.isStatic).toBe(true);
  expect(c.fps).toBe(0);
  expect(c.matchRatio).toBe(1);
  expect(c.reason).toMatch(/single held pose/);
  expect(isPreviewableOnPed(c.kind)).toBe(true);
});

test("a zero-duration multi-frame clip is also a pose", () => {
  expect(classifyAnimation(anim(30, 0, bodyTracks(BODY_TAGS)), PED).kind).toBe("pose");
});

test("facial clips are recognised by their track ids, not by name", () => {
  // Corpus shapes: 39 ids / 35 tags, kinds [22,25,134,137,138,139,140]; and
  // 114 ids / 94 tags, kinds [24,25,26,134,137,138,139,140]. Both resolve exactly
  // one tag against a body skeleton, which is why a tag-count test would fail them.
  for (const kinds of [
    [22, 25, 134, 137, 138, 139, 140],
    [24, 25, 26, 134, 137, 138, 139, 140],
  ]) {
    const c = classifyAnimation(
      anim(
        276,
        9.167,
        kinds.map((track, i) => ({ boneId: 1000 + i, track }))
      ),
      PED
    );
    expect(c.kind).toBe("facial");
    expect(c.bodyTracks).toBe(0);
    expect(c.facialTracks).toBe(kinds.length);
    expect(isPreviewableOnPed(c.kind)).toBe(false);
  }
});

test("isFacialTrack covers the measured ranges and nothing structural", () => {
  for (const t of [22, 23, 24, 25, 26, 134, 135, 136, 137, 138, 139, 140]) {
    expect(isFacialTrack(t)).toBe(true);
  }
  for (const t of [0, 1, 2, 5, 6, 17, 18, 21, 27, 133, 141]) {
    expect(isFacialTrack(t)).toBe(false);
  }
});

test("a UV-only clip is a UV animation", () => {
  // Corpus shape: 2 ids / 1 tag, kinds [17,18], 201 frames.
  const c = classifyAnimation(
    anim(201, 6.667, [
      { boneId: 42, track: TrackType.UV0 },
      { boneId: 42, track: TrackType.UV1 },
    ]),
    PED
  );
  expect(c.kind).toBe("uv");
  expect(c.uvTracks).toBe(2);
  expect(isPreviewableOnPed(c.kind)).toBe(false);
});

test("body tracks on a foreign rig are other-skeleton, not a broken ped clip", () => {
  // Corpus: anim@stretcher (0 of 5 tags matched) and a DJ-stand prop rig
  // (1 of 11 - tag 0 only, which is why "bound zero tracks" is the wrong test).
  const stretcher = classifyAnimation(
    anim(91, 3.75, bodyTracks([900001, 900002, 900003, 900004, 900005])),
    PED
  );
  expect(stretcher.kind).toBe("other-skeleton");
  expect(stretcher.matchRatio).toBe(0);

  const djStand = classifyAnimation(
    anim(
      41,
      1.333,
      bodyTracks([
        0, 900001, 900002, 900003, 900004, 900005, 900006, 900007, 900008, 900009, 900010,
      ])
    ),
    PED
  );
  expect(djStand.kind).toBe("other-skeleton");
  expect(djStand.resolvedTags).toBe(1);
  expect(djStand.matchRatio).toBeCloseTo(1 / 11, 6);
  expect(djStand.reason).toMatch(/9%/);
});

test("the ped-rig threshold sits in the measured gap", () => {
  // Measured separation: lowest genuine ped clip 0.738 (45/61), highest non-ped
  // 0.091 (1/11). The threshold must accept the former and reject the latter.
  expect(PED_RIG_MIN_MATCH).toBeGreaterThan(0.091);
  expect(PED_RIG_MIN_MATCH).toBeLessThan(0.738);

  const wideRig = rig(Array.from({ length: 45 }, (_, i) => i + 1));
  const ped45of61 = classifyAnimation(
    anim(
      2,
      0.042,
      bodyTracks([
        ...Array.from({ length: 45 }, (_, i) => i + 1),
        ...Array.from({ length: 16 }, (_, i) => 900000 + i),
      ])
    ),
    wideRig
  );
  expect(ped45of61.matchRatio).toBeCloseTo(45 / 61, 6);
  expect(ped45of61.kind).toBe("animation");
});

test("without a skeleton the rig cannot be judged and is not guessed", () => {
  const c = classifyAnimation(anim(90, 3, bodyTracks([900001, 900002])));
  expect(c.resolvedTags).toBeNull();
  expect(c.matchRatio).toBeNull();
  // No skeleton means no evidence of a foreign rig, so it stays an animation rather
  // than being labelled other-skeleton on a guess.
  expect(c.kind).toBe("animation");
});

test("an animation with no tracks is empty", () => {
  const c = classifyAnimation(anim(60, 2, []), PED);
  expect(c.kind).toBe("empty");
  expect(c.reason).toMatch(/no tracks/);
});

test("tracks that match no known modality are unknown, not guessed", () => {
  const c = classifyAnimation(anim(60, 2, [{ boneId: 5, track: 200 }]), PED);
  expect(c.kind).toBe("unknown");
  expect(c.trackTypes).toEqual([200]);
  expect(isPreviewableOnPed(c.kind)).toBe(false);
});

test("mover-only clips do not masquerade as ped animations", () => {
  const c = classifyAnimation(
    anim(60, 2, [
      { boneId: 0, track: TrackType.MoverPosition },
      { boneId: 0, track: TrackType.MoverRotation },
    ]),
    PED
  );
  expect(c.kind).toBe("unknown");
  expect(c.moverTracks).toBe(2);
});
