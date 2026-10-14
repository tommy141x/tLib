// Clip dictionary (.ycd) structure parsing.
//
// Ported from CodeWalker.Core Clip.cs and YcdFile.cs (MIT, dexyfex/Neodymium).
// Block layouts are field-for-field, padding included - every `skip` below is a real
// gap in the file, not a convenience.
//
// YCD is generation-agnostic: unlike Drawable.cs (291 gen9 branches) and Texture.cs
// (172), Clip.cs has none. One code path reads Legacy and Enhanced alike.

import { ResourceReadError, type ResourceReader } from "../reader";
import { type Rsc7Resource, SYSTEM_BASE } from "../rsc7";
import {
  ANIM_CHANNEL_TYPE_COUNT,
  type AnimChannel,
  AnimChannelCachedQuaternion,
  AnimChannelDataReader,
  AnimChannelType,
  AnimSequence,
  constructChannel,
  type Vec4,
} from "./channels";

export enum ClipType {
  Animation = 1,
  AnimationList = 2,
}

/**
 * Track kinds seen on a bone id.
 *
 * 0/1 are named in CodeWalker (YcdFile.cs:150-180), 5/6 in Clip.cs:2783,2794, and
 * 17/18 appear only in commented-out code there. 2 is not named anywhere in CodeWalker;
 * it is identified as scale by measurement - a 128-bone ped skeleton carries 128 each of
 * tracks 0/1/2 and every track-2 value is exactly (1,1,1).
 */
export enum TrackType {
  BonePosition = 0,
  BoneRotation = 1,
  BoneScale = 2,
  MoverPosition = 5,
  MoverRotation = 6,
  UV0 = 17,
  UV1 = 18,
}

export interface AnimationBoneId {
  boneId: number;
  unk0: number;
  track: number;
}

/** One chunk of an animation's frames, holding the packed channel data. */
export interface SequenceBlock {
  numFrames: number;
  frameLength: number;
  chunkSize: number;
  tracks: AnimSequence[];
}

export interface Animation {
  hash: number;
  frames: number;
  /** Frames per sequence block. Frame F lives in block F/limit at index F%limit. */
  sequenceFrameLimit: number;
  duration: number;
  boneIds: AnimationBoneId[];
  sequences: SequenceBlock[];
}

export interface ClipAnimationRef {
  kind: "animation";
  animation: Animation | null;
  startTime: number;
  endTime: number;
  rate: number;
}

export interface ClipAnimationListRef {
  kind: "animationList";
  /** Blended multi-animation clips are recognised but not decoded. */
  reason: string;
}

export interface Clip {
  hash: number;
  name: string | null;
  /** Trailing path component of `name`, which is what scripts actually reference. */
  shortName: string | null;
  content: ClipAnimationRef | ClipAnimationListRef;
}

export interface ClipDictionary {
  version: number;
  clips: Clip[];
  animations: Animation[];
  /** Non-fatal problems: a clip whose animation pointer was null, and similar. */
  warnings: string[];
}

function shortNameOf(name: string | null): string | null {
  if (!name) return null;
  const normalised = name.replace(/\\/g, "/");
  const slash = normalised.lastIndexOf("/");
  const tail =
    slash >= 0 && slash < normalised.length - 1 ? normalised.slice(slash + 1) : normalised;
  // Names commonly carry a ".clip" suffix that scripts never use.
  return tail.endsWith(".clip") ? tail.slice(0, -5) : tail;
}

/** A `ResourcePointerList64` / `ResourceSimpleList64_s` header: ptr, count, capacity, pad. */
function readListHeader(r: ResourceReader): { pointer: number; count: number; capacity: number } {
  const pointer = r.pointer();
  const count = r.uint16();
  const capacity = r.uint16();
  r.skip(4);
  return { pointer, count, capacity };
}

function readBoneIds(r: ResourceReader): AnimationBoneId[] {
  const { pointer, count } = readListHeader(r);
  return r.simpleArray(pointer, count, (rr) => ({
    boneId: rr.uint16(),
    unk0: rr.byte(),
    track: rr.byte(),
  }));
}

/**
 * Decode one sequence block's packed channel data.
 *
 * Channels are declared in nine type-ordered groups; each channel's parameter block is
 * read from the main cursor while its (sequence, index) assignment comes from a parallel
 * cursor. Only after all declarations are the per-frame bits read, because a channel's
 * frame width is not known until its parameters are.
 */
function parseSequenceData(
  data: Uint8Array,
  numFrames: number,
  chunkSize: number,
  frameOffset: number,
  frameLength: number
): AnimSequence[] {
  const reader = new AnimChannelDataReader(data, numFrames, chunkSize, frameOffset, frameLength);

  interface Placed {
    sequence: number;
    index: number;
    channel: AnimChannel;
  }
  const placed: Placed[] = [];
  const byType: (AnimChannel | null)[][] = [];
  let frameBitCursor = 0;

  for (let t = 0; t < ANIM_CHANNEL_TYPE_COUNT; t++) {
    const type = t as AnimChannelType;
    const channelCount = reader.readChannelCount();
    const channels: (AnimChannel | null)[] = new Array(channelCount).fill(null);

    for (let c = 0; c < channelCount; c++) {
      const channel = constructChannel(type);
      const channelDataBit = reader.readChannelDataBits();
      if (!channel) continue;

      channel.dataOffset = Math.floor(reader.position / 4);
      channel.read(reader);
      channels[c] = channel;

      const sequence = channelDataBit >> 2;
      let index = channelDataBit & 3;
      if (channel instanceof AnimChannelCachedQuaternion) {
        // The low bits hold which quaternion component is reconstructed, not a
        // channel slot; the real slot is fixed by the channel type.
        channel.quatIndex = index;
        index = channel.type === AnimChannelType.CachedQuaternion1 ? 3 : 4;
      }
      channel.associate(sequence, index);
      placed.push({ sequence, index, channel });

      channel.frameOffset = frameBitCursor;
      frameBitCursor += channel.getFrameBits();
    }

    reader.alignChannelDataOffset(channelCount);
    byType[t] = channels;
  }

  for (let f = 0; f < numFrames; f++) {
    reader.beginFrame(f);
    for (let t = 0; t < ANIM_CHANNEL_TYPE_COUNT; t++) {
      for (const channel of byType[t]) channel?.readFrame(reader);
    }
  }

  if (placed.length === 0) return [];

  const trackCount = Math.max(...placed.map((p) => p.sequence)) + 1;
  const tracks: AnimSequence[] = [];
  for (let i = 0; i < trackCount; i++) {
    const seq = new AnimSequence();
    const mine = placed.filter((p) => p.sequence === i);
    if (mine.length > 0) {
      const width = Math.max(...mine.map((p) => p.index)) + 1;
      seq.channels = new Array(width).fill(null);
      for (const p of mine) seq.channels[p.index] = p.channel;
      // A CachedQuaternion1 in the group marks the whole track as a three-plus-
      // reconstructed-component rotation.
      seq.isType7Quat = seq.channels.some((c) => c?.type === AnimChannelType.CachedQuaternion1);
    }
    tracks[i] = seq;
  }

  // Cached-quaternion channels resolve their siblings lazily through this.
  reader.sequences = tracks;
  return tracks;
}

function readSequence(r: ResourceReader): SequenceBlock {
  r.skip(4); // Unknown_00h - an identifier of some kind
  const dataLength = r.uint32();
  r.skip(4); // Unused_08h
  const frameOffset = r.uint32();
  r.skip(4); // RootMotionRefsOffset
  r.skip(2); // Unused_14h
  const numFrames = r.uint16();
  const frameLength = r.uint16();
  r.skip(2); // IndirectQuantizeFloatNumInts
  r.skip(2); // QuantizeFloatValueBits
  const chunkSize = r.byte();
  r.skip(1); // RootMotionRefCounts

  const data = r.bytesAt(r.position, dataLength);
  r.skip(dataLength);

  return {
    numFrames,
    frameLength,
    chunkSize,
    tracks: parseSequenceData(data, numFrames, chunkSize, frameOffset, frameLength),
  };
}

function readAnimation(r: ResourceReader): Omit<Animation, "hash"> {
  r.skip(16); // VFT, Unknown_04h, Unused_08h, Unused_0Ch
  r.skip(4); // Unknown_10h, Unknown_11h, Unused_12h
  const frames = r.uint16();
  const sequenceFrameLimit = r.uint16();
  const duration = r.float32();
  r.skip(4); // Unknown_1Ch
  r.skip(24); // Unused_20h .. Unused_34h
  r.skip(4); // MaxSeqBlockLength
  r.skip(4); // UsageCount

  const seqHeader = readListHeader(r);
  const boneIds = readBoneIds(r);

  // A pointer list stores `capacity` pointers but only `count` live items.
  const pointers: number[] = r.simpleArray(seqHeader.pointer, seqHeader.capacity, (rr) =>
    rr.pointer()
  );
  const sequences: SequenceBlock[] = [];
  for (let i = 0; i < seqHeader.count; i++) {
    const block = r.atPointer(pointers[i] ?? 0, readSequence);
    if (block) sequences.push(block);
  }

  return { frames, sequenceFrameLimit, duration, boneIds, sequences };
}

function readClip(r: ResourceReader, warnings: string[]): Omit<Clip, "hash"> {
  r.skip(16); // VFT, Unknown_04h, Unknown_08h, Unknown_0Ch
  const type = r.uint32() as ClipType;
  r.skip(4); // Unknown_14h
  const namePointer = r.pointer();
  r.skip(4); // NameLength, NameCapacity
  r.skip(4); // Unknown_24h
  r.skip(8); // Unknown_28hPtr
  r.skip(8); // Unknown_30h, Unknown_34h
  r.skip(8); // TagsPointer   - clip tags, not needed to play a clip
  r.skip(8); // PropertiesPointer
  r.skip(8); // Unknown_48h, Unknown_4Ch

  const name = r.stringAt(namePointer);

  if (type !== ClipType.Animation) {
    return {
      name,
      shortName: shortNameOf(name),
      content: {
        kind: "animationList",
        reason: "ClipAnimationList blends several animations; decoding it is not supported",
      },
    };
  }

  const animationPointer = r.pointer();
  const startTime = r.float32();
  const endTime = r.float32();
  const rate = r.float32();

  let animation: Animation | null = null;
  if (animationPointer) {
    const body = r.atPointer(animationPointer, readAnimation);
    if (body) animation = { hash: 0, ...body };
  } else {
    warnings.push(`clip "${name ?? "?"}" has a null animation pointer`);
  }

  return {
    name,
    shortName: shortNameOf(name),
    content: { kind: "animation", animation, startTime, endTime, rate },
  };
}

/** Parse a decompressed RSC7 resource as a clip dictionary. */
export function parseClipDictionary(
  resource: Rsc7Resource,
  reader: ResourceReader
): ClipDictionary {
  const warnings: string[] = [];
  const r = reader.seek(SYSTEM_BASE);

  r.skip(16); // ResourceFileBase: FileVFT, FileUnknown, FilePagesInfoPointer
  r.skip(8); // Unknown_10h, Unknown_14h
  const animationsPointer = r.pointer();
  r.skip(8); // Unknown_20h, Unknown_24h
  const clipsPointer = r.pointer();
  const clipsMapCapacity = r.uint16();
  r.skip(2); // ClipsMapEntries - live count; buckets are chained, so capacity is what we walk
  r.skip(12); // Unknown_34h, Unknown_38h, Unknown_3Ch

  // Both maps are open hash tables: `capacity` buckets, each a chain linked by
  // NextPointer. Walking only the bucket heads would silently drop colliding entries.
  const animationsByAddress = new Map<number, Animation>();

  const animations: Animation[] = [];
  if (animationsPointer) {
    r.atPointer(animationsPointer, (rr) => {
      rr.skip(24); // VFT, Unknown_04h .. Unknown_14h
      const entriesPointer = rr.pointer();
      const capacity = rr.uint16();
      rr.skip(2); // AnimationsMapEntries
      rr.skip(12); // Unknown_24h, Unknown_28h, Unknown_2Ch

      const heads = rr.simpleArray(entriesPointer, capacity, (x) => x.pointer());
      for (const head of heads) {
        let entry = head;
        const seen = new Set<number>();
        while (entry) {
          if (seen.has(entry)) {
            warnings.push(`animation map chain at 0x${entry.toString(16)} loops; stopped walking`);
            break;
          }
          seen.add(entry);
          const next = rr.atPointer(entry, (e) => {
            const hash = e.uint32();
            e.skip(4); // Unknown_04h
            const animationPtr = e.pointer();
            const nextPtr = e.pointer();
            if (animationPtr) {
              const existing = animationsByAddress.get(animationPtr);
              if (existing) {
                existing.hash = hash;
              } else {
                const body = e.atPointer(animationPtr, readAnimation);
                if (body) {
                  const anim: Animation = { hash, ...body };
                  animationsByAddress.set(animationPtr, anim);
                  animations.push(anim);
                }
              }
            }
            return nextPtr;
          });
          entry = next ?? 0;
        }
      }
      return null;
    });
  }

  const clips: Clip[] = [];
  if (clipsPointer) {
    const heads = r.simpleArray(clipsPointer, clipsMapCapacity, (x) => x.pointer());
    for (const head of heads) {
      let entry = head;
      const seen = new Set<number>();
      while (entry) {
        if (seen.has(entry)) {
          warnings.push(`clip map chain at 0x${entry.toString(16)} loops; stopped walking`);
          break;
        }
        seen.add(entry);
        const next = r.atPointer(entry, (e) => {
          const hash = e.uint32();
          e.skip(4); // Unknown_04h
          const clipPointer = e.pointer();
          const nextPtr = e.pointer();
          if (clipPointer) {
            const body = e.atPointer(clipPointer, (c) => readClip(c, warnings));
            if (body) {
              // Reuse the already-parsed animation when the clip points at one
              // the animation map also covers, so both views share an object.
              const content = body.content;
              if (content.kind === "animation" && content.animation) {
                const existing = [...animationsByAddress.values()].find(
                  (a) => a.hash === content.animation?.hash && a.hash !== 0
                );
                if (existing) content.animation = existing;
              }
              clips.push({ hash, ...body });
            }
          }
          return nextPtr;
        });
        entry = next ?? 0;
      }
    }
  }

  return { version: resource.header.version, clips, animations, warnings };
}

/**
 * Sample one track of an animation at a global frame index.
 *
 * Sequence blocks are an encoding detail: frame F lives in block F/sequenceFrameLimit
 * at local index F%sequenceFrameLimit. Returns null when the track or block is absent
 * rather than a zero vector, so callers can tell "no data" from "zero".
 */
export function sampleTrack(animation: Animation, trackIndex: number, frame: number): Vec4 | null {
  const limit = animation.sequenceFrameLimit;
  if (limit <= 0) return null;
  const block = animation.sequences[Math.floor(frame / limit)];
  const track = block?.tracks[trackIndex];
  if (!track) return null;
  return track.evaluateVector(frame % limit);
}

/** Index of the track carrying `track` for `boneTag`, or -1. */
export function findTrackIndex(animation: Animation, boneTag: number, track: number): number {
  return animation.boneIds.findIndex((b) => b.boneId === boneTag && b.track === track);
}

export { ResourceReadError };
