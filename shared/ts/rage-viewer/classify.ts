// What kind of thing is this .ycd clip?
//
// Upload validation needs this: "binds zero tracks against a ped skeleton" is a
// legitimate facial or UV clip, a wrong-skeleton clip, or a broken file, and telling
// a creator the wrong one of those is worse than saying nothing. Every threshold and
// track-id set below is measured against a 60-file / 82-clip corpus, not assumed -
// see the numbers inline.
//
// No `three` import: this is pure data classification and stays callable server-side.

import type { Animation } from "../rage/ycd";
import { TrackType } from "../rage/ycd";

export type AnimationKind =
  /** A ped body animation with more than one frame. */
  | "animation"
  /** A ped body pose: a single frame, or zero duration. Emote packs ship these. */
  | "pose"
  /** Facial/expression tracks. Addresses the head rig, not the body skeleton. */
  | "facial"
  /** Texture UV scroll. Addresses a drawable, not a skeleton at all. */
  | "uv"
  /** Body tracks, but for a vehicle/prop/creature rig - not this ped skeleton. */
  | "other-skeleton"
  /** No tracks at all. */
  | "empty"
  /** Tracks exist but match no known modality. Deliberately not guessed. */
  | "unknown";

export interface AnimationClassification {
  kind: AnimationKind;
  /** One sentence naming the evidence, safe to show a creator. */
  reason: string;
  frames: number;
  duration: number;
  /** Native sample rate, or 0 when it cannot be computed. */
  fps: number;
  /** True when there is at most one distinct frame to show. */
  isStatic: boolean;
  /** Total (bone, track) pairs. */
  trackCount: number;
  /** Distinct bone tags addressed. */
  uniqueTags: number;
  /** Distinct track type ids present, ascending. */
  trackTypes: number[];
  bodyTracks: number;
  moverTracks: number;
  facialTracks: number;
  uvTracks: number;
  /** Tags the supplied skeleton has, or null when no skeleton was supplied. */
  resolvedTags: number | null;
  /** resolvedTags / uniqueTags, or null. */
  matchRatio: number | null;
}

/** Anything with a `byTag` map - a ViewerSkeleton satisfies this structurally. */
export interface TagSource {
  byTag: ReadonlyMap<number, unknown>;
}

/**
 * Facial track ids, measured from the corpus: 22, 24, 25, 26 and 134-140 appear only
 * on clips whose names end `_facial` or that live in a `facials@` dictionary, and
 * never alongside a body track. CodeWalker does not name these, so the ranges are
 * empirical - widen them if a facial clip ever classifies as `unknown`.
 */
export function isFacialTrack(track: number): boolean {
  return (track >= 22 && track <= 26) || (track >= 134 && track <= 140);
}

function isBodyTrack(track: number): boolean {
  return (
    track === TrackType.BonePosition ||
    track === TrackType.BoneRotation ||
    track === TrackType.BoneScale
  );
}

function isMoverTrack(track: number): boolean {
  return track === TrackType.MoverPosition || track === TrackType.MoverRotation;
}

function isUvTrack(track: number): boolean {
  return track === TrackType.UV0 || track === TrackType.UV1;
}

/**
 * Minimum share of an animation's bone tags that must exist on the ped skeleton for
 * it to count as a ped animation.
 *
 * Measured separation over the corpus: the lowest genuine ped clip matches 0.738
 * (45 of 61 tags - a two-character emote that also drives a dog rig), while the
 * highest non-ped clip matches 0.091 (1 of 11 - a DJ-stand prop rig, matching only
 * tag 0). Nothing lands between. 0.5 sits in that gap with room on both sides.
 */
export const PED_RIG_MIN_MATCH = 0.5;

export function classifyAnimation(
  animation: Animation,
  skeleton?: TagSource | null
): AnimationClassification {
  const { frames, duration, boneIds } = animation;
  const tags = new Set<number>();
  const types = new Set<number>();
  let bodyTracks = 0;
  let moverTracks = 0;
  let facialTracks = 0;
  let uvTracks = 0;

  for (const b of boneIds) {
    tags.add(b.boneId);
    types.add(b.track);
    if (isBodyTrack(b.track)) bodyTracks++;
    else if (isMoverTrack(b.track)) moverTracks++;
    else if (isUvTrack(b.track)) uvTracks++;
    else if (isFacialTrack(b.track)) facialTracks++;
  }

  let resolvedTags: number | null = null;
  if (skeleton) {
    resolvedTags = 0;
    for (const tag of tags) if (skeleton.byTag.has(tag)) resolvedTags++;
  }
  const matchRatio = resolvedTags === null || tags.size === 0 ? null : resolvedTags / tags.size;

  const fps =
    Number.isFinite(frames) && frames > 0 && Number.isFinite(duration) && duration > 0
      ? frames / duration
      : 0;
  const isStatic = !(frames > 1) || !(duration > 0);

  const base = {
    frames,
    duration,
    fps,
    isStatic,
    trackCount: boneIds.length,
    uniqueTags: tags.size,
    trackTypes: [...types].sort((a, b) => a - b),
    bodyTracks,
    moverTracks,
    facialTracks,
    uvTracks,
    resolvedTags,
    matchRatio,
  };

  if (boneIds.length === 0) {
    return { ...base, kind: "empty", reason: "the animation declares no tracks" };
  }
  if (uvTracks === boneIds.length) {
    return {
      ...base,
      kind: "uv",
      reason: `texture UV animation: ${uvTracks} UV track(s) and nothing else`,
    };
  }
  if (bodyTracks === 0 && facialTracks > 0) {
    return {
      ...base,
      kind: "facial",
      reason:
        `facial animation: ${facialTracks} expression track(s) across ${tags.size} tags ` +
        "and no body bone tracks",
    };
  }
  if (bodyTracks === 0) {
    return {
      ...base,
      kind: "unknown",
      reason: `no body, facial or UV tracks; track types present: ${base.trackTypes.join(", ")}`,
    };
  }

  if (matchRatio !== null && matchRatio < PED_RIG_MIN_MATCH) {
    return {
      ...base,
      kind: "other-skeleton",
      reason:
        `body tracks address a different rig: only ${resolvedTags} of ${tags.size} bone ` +
        `tags exist on this skeleton (${(matchRatio * 100).toFixed(0)}%)`,
    };
  }

  if (isStatic) {
    return {
      ...base,
      kind: "pose",
      reason:
        `single held pose: frames=${frames}, duration=${duration}` +
        (matchRatio === null ? "" : `, ${resolvedTags}/${tags.size} bone tags matched`),
    };
  }

  return {
    ...base,
    kind: "animation",
    reason:
      `ped animation: ${frames} frames over ${duration.toFixed(3)}s (${fps.toFixed(1)} fps)` +
      (matchRatio === null ? "" : `, ${resolvedTags}/${tags.size} bone tags matched`),
  };
}

/** True for the kinds a ped-skeleton viewer can actually display. */
export function isPreviewableOnPed(kind: AnimationKind): boolean {
  return kind === "animation" || kind === "pose";
}
