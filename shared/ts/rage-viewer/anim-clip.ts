// A parsed .ycd Animation -> THREE.AnimationClip.
//
// Three things here are not obvious and each one produces a wrong-looking result
// rather than an error when you get it wrong:
//
//  1. Tracks address bones by TAG, not index. `Animation.boneIds[i].boneId` is a
//     joaat of the bone name. Resolving it as an index gives a fully animated
//     skeleton with every joint driven by the wrong track.
//  2. Consecutive quaternion keys can land in opposite hemispheres. q and -q are the
//     same orientation, but three's quaternion interpolant takes the shorter arc
//     between the stored values, so an un-flipped pair spins the joint ~360 degrees
//     across one frame interval. Fixed by negating any key whose dot with the
//     previous key is negative.
//  3. Mover tracks (5/6) are root motion and live on the mover node, not on a bone.
//     "In place" - the default - just drops them.
//  4. A rotation track's four components are four INDEPENDENTLY quantised channels,
//     so the stored quaternion is only approximately unit - measured worst case over
//     a 60-file corpus: |q| = 0.998975 on SKEL_L_Clavicle in mouse@jump_jack. three's
//     slerp assumes unit length, so every key is normalised.
//  5. frames <= 1 or duration <= 0 is a held POSE, not a broken file. Emote packs ship
//     them constantly. Refusing to emit anything shows a blank preview of a perfectly
//     good asset, so a pose gets a one-key clip and `kind: "pose"`.

import * as THREE from "three";
import { type Animation, findTrackIndex, sampleTrack, TrackType } from "../rage/ycd";
import { type AnimationClassification, classifyAnimation } from "./classify";
import type { ViewerSkeleton } from "./skeleton";

/** Node name the root-motion tracks are emitted against. */
export const DEFAULT_MOVER_NODE_NAME = "MoverRoot";

export interface BuildAnimationClipOptions {
  /** Clip name. Defaults to "clip". */
  name?: string;
  /**
   * false (default) plays in place: mover tracks are dropped.
   * true emits them against `moverNodeName` so the rig travels.
   */
  rootMotion?: boolean;
  moverNodeName?: string;
  /** Called once per track that is neither a bone track nor a mover track. */
  onUnsupportedTrack?: (info: { boneId: number; track: number; index: number }) => void;
}

export interface SkippedTrack {
  track: number;
  count: number;
}

/**
 * What was built.
 *
 * `"pose"` is a success, not a degraded case - it means a single held frame, which is
 * a normal thing for a .ycd to contain. `"empty"` means there was genuinely nothing.
 */
export type BuiltClipKind = "animation" | "pose" | "empty";

export interface BuildAnimationClipResult {
  clip: THREE.AnimationClip;
  /** Distinguishes a one-frame held pose from a real animation and from nothing. */
  kind: BuiltClipKind;
  /**
   * What the source asset is, against this skeleton. Computed here so a caller that
   * builds a clip does not have to classify separately and risk the two disagreeing;
   * `classifyAnimation` is exported for callers that only want the verdict.
   */
  classification: AnimationClassification;
  /** Native sample rate, frames / duration. */
  fps: number;
  frames: number;
  /** Clip duration in seconds, taken from the animation. */
  duration: number;
  /** How many KeyframeTracks were emitted. */
  boundTracks: number;
  /** Bone tags referenced by the animation that this skeleton does not have. */
  unresolvedBoneTags: number[];
  /** Track types that were skipped, with counts. */
  skippedTracks: SkippedTrack[];
  /** True when mover tracks existed and were emitted. */
  rootMotionApplied: boolean;
  /** How many quaternion keys were negated for hemisphere continuity. */
  quaternionFlips: number;
  /**
   * Worst |‖q‖ - 1| seen across rotation keys BEFORE normalisation.
   *
   * Quantisation noise measures ~1e-3; anything far larger is a genuinely corrupt
   * track rather than the format being the format.
   */
  maxQuaternionDeviation: number;
  /** Rotation keys that were zero-length and had to be replaced with identity. */
  degenerateQuaternions: number;
  warnings: string[];
}

/**
 * Sample rate implied by an animation's frame count and duration.
 *
 * Guards the degenerate cases a hand-authored or truncated .ycd can carry: a zero
 * duration would otherwise produce Infinity and a NaN key time.
 */
export function nativeFps(animation: Pick<Animation, "frames" | "duration">): number {
  const { frames, duration } = animation;
  if (!Number.isFinite(frames) || frames <= 0) return 0;
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  return frames / duration;
}

/**
 * Make a quaternion key sequence continuous in-place.
 *
 * Operates on a flat [x,y,z,w, x,y,z,w, ...] array, which is exactly the layout
 * QuaternionKeyframeTrack wants. Returns the number of keys negated.
 */
export function enforceQuaternionContinuity(values: number[] | Float32Array): number {
  let flips = 0;
  for (let i = 4; i + 3 < values.length; i += 4) {
    const dot =
      values[i] * values[i - 4] +
      values[i + 1] * values[i - 3] +
      values[i + 2] * values[i - 2] +
      values[i + 3] * values[i - 1];
    if (dot < 0) {
      values[i] = -values[i];
      values[i + 1] = -values[i + 1];
      values[i + 2] = -values[i + 2];
      values[i + 3] = -values[i + 3];
      flips++;
    }
  }
  return flips;
}

/**
 * Make every quaternion in a flat [x,y,z,w,...] array unit length, in place.
 *
 * Needed because a non-type-7 rotation track stores four independently
 * QuantizeFloat-encoded channels, so the reassembled quaternion is only
 * approximately unit. (Type-7 tracks are reconstructed on the unit sphere and are
 * already fine.) three's slerp assumes unit input and degrades subtly - and
 * cumulatively - without this.
 *
 * Returns the worst deviation seen so quantisation noise stays distinguishable from
 * a corrupt track, and a count of keys that were zero-length and got identity.
 */
export function normaliseQuaternionValues(values: number[] | Float32Array): {
  maxDeviation: number;
  degenerate: number;
} {
  let maxDeviation = 0;
  let degenerate = 0;
  for (let i = 0; i + 3 < values.length; i += 4) {
    const length = Math.hypot(values[i], values[i + 1], values[i + 2], values[i + 3]);
    if (length === 0 || !Number.isFinite(length)) {
      values[i] = 0;
      values[i + 1] = 0;
      values[i + 2] = 0;
      values[i + 3] = 1;
      degenerate++;
      continue;
    }
    // Degenerate keys are counted separately and deliberately excluded here: a
    // zero-length key deviates by exactly 1 and would swamp the quantisation-noise
    // signal this number exists to report.
    const deviation = Math.abs(length - 1);
    if (deviation > maxDeviation) maxDeviation = deviation;
    if (deviation === 0) continue;
    values[i] /= length;
    values[i + 1] /= length;
    values[i + 2] /= length;
    values[i + 3] /= length;
  }
  return { maxDeviation, degenerate };
}

/**
 * Key times for `frames` samples at the native rate.
 *
 * Frame f sits at f / fps, so the last key is one interval short of `duration`.
 * That final interval holds the last pose, which is what a looping clip wants: an
 * animation whose first and last frames are the same pose would otherwise show a
 * visible pause at the seam.
 */
function buildTimes(frames: number, fps: number): Float32Array {
  const times = new Float32Array(frames);
  for (let f = 0; f < frames; f++) times[f] = f / fps;
  return times;
}

export function buildAnimationClip(
  animation: Animation,
  skeleton: ViewerSkeleton,
  options: BuildAnimationClipOptions = {}
): BuildAnimationClipResult {
  const {
    name = "clip",
    rootMotion = false,
    moverNodeName = DEFAULT_MOVER_NODE_NAME,
    onUnsupportedTrack,
  } = options;

  const warnings: string[] = [];
  const frames = animation.frames;
  const duration = animation.duration;
  const fps = nativeFps(animation);

  const classification = classifyAnimation(animation, skeleton);

  if (!(frames > 0)) {
    warnings.push(`animation has frames=${frames}; there is nothing to sample`);
    return emptyResult(name, warnings, classification);
  }

  // A single frame, or a zero duration, is a HELD POSE - a normal thing for an emote
  // pack to ship, not a broken file. Emitting nothing here showed a blank preview of
  // a perfectly good asset, so a pose gets a one-key clip of duration 0 and says so.
  const isPose = frames <= 1 || !(duration > 0);
  const keyCount = isPose ? 1 : frames;
  if (isPose) {
    warnings.push(
      `frames=${frames} duration=${duration}: treated as a single held pose, ` +
        "not an animation"
    );
  }

  const times = isPose ? new Float32Array([0]) : buildTimes(frames, fps);
  const tracks: THREE.KeyframeTrack[] = [];
  const unresolved = new Set<number>();
  const skipped = new Map<number, number>();
  let quaternionFlips = 0;
  let maxQuaternionDeviation = 0;
  let degenerateQuaternions = 0;
  let rootMotionApplied = false;

  const pushVector = (nodeName: string, property: string, trackIndex: number) => {
    const values = new Float32Array(keyCount * 3);
    for (let f = 0; f < keyCount; f++) {
      const v = sampleTrack(animation, trackIndex, f);
      if (!v) continue;
      values[f * 3] = v[0];
      values[f * 3 + 1] = v[1];
      values[f * 3 + 2] = v[2];
    }
    tracks.push(new THREE.VectorKeyframeTrack(`${nodeName}.${property}`, times, values));
  };

  const pushQuaternion = (nodeName: string, trackIndex: number) => {
    const values = new Float32Array(keyCount * 4);
    for (let f = 0; f < keyCount; f++) {
      const v = sampleTrack(animation, trackIndex, f);
      if (!v) {
        values[f * 4 + 3] = 1;
        continue;
      }
      values[f * 4] = v[0];
      values[f * 4 + 1] = v[1];
      values[f * 4 + 2] = v[2];
      values[f * 4 + 3] = v[3];
    }
    quaternionFlips += enforceQuaternionContinuity(values);
    // Normalise AFTER the continuity pass; negating does not change length, but the
    // order is the one documented so it cannot drift.
    const normalised = normaliseQuaternionValues(values);
    if (normalised.maxDeviation > maxQuaternionDeviation) {
      maxQuaternionDeviation = normalised.maxDeviation;
    }
    degenerateQuaternions += normalised.degenerate;
    tracks.push(new THREE.QuaternionKeyframeTrack(`${nodeName}.quaternion`, times, values));
  };

  animation.boneIds.forEach((boneId, trackIndex) => {
    const { boneId: tag, track } = boneId;

    if (track === TrackType.MoverPosition || track === TrackType.MoverRotation) {
      if (!rootMotion) {
        bump(skipped, track);
        return;
      }
      rootMotionApplied = true;
      if (track === TrackType.MoverPosition) pushVector(moverNodeName, "position", trackIndex);
      else pushQuaternion(moverNodeName, trackIndex);
      return;
    }

    if (
      track !== TrackType.BonePosition &&
      track !== TrackType.BoneRotation &&
      track !== TrackType.BoneScale
    ) {
      bump(skipped, track);
      onUnsupportedTrack?.({ boneId: tag, track, index: trackIndex });
      warnings.push(`track type ${track} on bone tag ${tag} is not supported; skipped`);
      return;
    }

    const bone = skeleton.byTag.get(tag);
    if (!bone) {
      unresolved.add(tag);
      return;
    }

    if (track === TrackType.BonePosition) pushVector(bone.name, "position", trackIndex);
    else if (track === TrackType.BoneRotation) pushQuaternion(bone.name, trackIndex);
    else pushVector(bone.name, "scale", trackIndex);
  });

  if (unresolved.size > 0) {
    warnings.push(
      `${unresolved.size} bone tag(s) in this animation are not in the skeleton: ` +
        `${[...unresolved].slice(0, 8).join(", ")}${unresolved.size > 8 ? ", ..." : ""}`
    );
  }
  if (rootMotion && !rootMotionApplied) {
    warnings.push("root motion was requested but this animation has no mover tracks");
  }

  if (degenerateQuaternions > 0) {
    warnings.push(
      `${degenerateQuaternions} rotation key(s) were zero-length and were replaced with identity`
    );
  }

  // A pose clip has duration 0. Play it with LoopOnce, or better, use applyPose():
  // three's LoopRepeat divides by the duration.
  const clip = new THREE.AnimationClip(name, isPose ? 0 : duration, tracks);

  return {
    clip,
    kind: tracks.length === 0 ? "empty" : isPose ? "pose" : "animation",
    classification,
    fps,
    frames,
    duration,
    boundTracks: tracks.length,
    unresolvedBoneTags: [...unresolved],
    skippedTracks: [...skipped.entries()].map(([track, count]) => ({ track, count })),
    rootMotionApplied,
    quaternionFlips,
    maxQuaternionDeviation,
    degenerateQuaternions,
    warnings,
  };
}

function emptyResult(
  name: string,
  warnings: string[],
  classification: AnimationClassification
): BuildAnimationClipResult {
  const { frames, duration } = classification;
  return {
    clip: new THREE.AnimationClip(name, Math.max(duration, 0), []),
    kind: "empty",
    classification,
    fps: 0,
    frames,
    duration,
    boundTracks: 0,
    unresolvedBoneTags: [],
    skippedTracks: [],
    rootMotionApplied: false,
    quaternionFlips: 0,
    maxQuaternionDeviation: 0,
    degenerateQuaternions: 0,
    warnings,
  };
}

/**
 * Write one frame of an animation straight onto the skeleton's bones.
 *
 * The reliable way to show a pose: no AnimationMixer, no interpolation, no
 * duration-0 clip to play. Also useful for scrubbing to an exact frame.
 *
 * Returns how many bones were written. Bones with no track are left alone, so call
 * `skeleton.resetToRest()` first if the previous pose must not show through.
 */
export function applyPose(
  animation: Animation,
  skeleton: ViewerSkeleton,
  frame = 0
): { bonesPosed: number; tracksApplied: number } {
  const posed = new Set<THREE.Bone>();
  let tracksApplied = 0;
  const q = new THREE.Quaternion();

  animation.boneIds.forEach((boneId, trackIndex) => {
    const { boneId: tag, track } = boneId;
    if (!isBoneTrack(track)) return;
    const bone = skeleton.byTag.get(tag);
    if (!bone) return;
    const v = sampleTrack(animation, trackIndex, frame);
    if (!v) return;

    if (track === TrackType.BonePosition) bone.position.set(v[0], v[1], v[2]);
    else if (track === TrackType.BoneScale) bone.scale.set(v[0], v[1], v[2]);
    else {
      q.set(v[0], v[1], v[2], v[3]);
      // Same quantisation slop as the keyframe path; a non-unit quaternion on a bone
      // shears everything below it.
      if (q.lengthSq() > 0) q.normalize();
      else q.identity();
      bone.quaternion.copy(q);
    }
    posed.add(bone);
    tracksApplied++;
  });

  for (const root of skeleton.roots) root.updateMatrixWorld(true);
  return { bonesPosed: posed.size, tracksApplied };
}

function isBoneTrack(track: number): boolean {
  return (
    track === TrackType.BonePosition ||
    track === TrackType.BoneRotation ||
    track === TrackType.BoneScale
  );
}

function bump(map: Map<number, number>, key: number): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/**
 * Bone tags this animation actually drives, with the track kinds present for each.
 *
 * Useful for a UI that lists what a clip touches, and for picking an attach bone
 * that the clip moves.
 */
export function describeAnimationTracks(
  animation: Animation
): { tag: number; tracks: number[] }[] {
  const byTag = new Map<number, number[]>();
  for (const b of animation.boneIds) {
    const list = byTag.get(b.boneId);
    if (list) list.push(b.track);
    else byTag.set(b.boneId, [b.track]);
  }
  return [...byTag.entries()].map(([tag, tracks]) => ({ tag, tracks }));
}

export { findTrackIndex, sampleTrack, TrackType };
