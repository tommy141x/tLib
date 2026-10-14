// BC7 partition, anchor and mode tables.
//
// These are NOT from CodeWalker - CodeWalker has no BC7 decoder at all (`DDSIO.cs:167`
// is literally `//BC7 TODO!!`). They are the fixed tables from the Direct3D 11 BC7
// specification, which every conformant decoder shares.
//
// Kept in their own module because they are data, not logic: a diff against the spec is
// easy here and impossible when they are interleaved with the decoder.

/** Subset assignment for each of the 64 two-subset partitions, in raster order. */
// biome-ignore format: a 4x4 block per row is the only readable shape for this.
export const BC7_PARTITION_2: readonly (readonly number[])[] = [
	[0,0,1,1,0,0,1,1,0,0,1,1,0,0,1,1], [0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1],
	[0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1], [0,0,0,1,0,0,1,1,0,0,1,1,0,1,1,1],
	[0,0,0,0,0,0,0,1,0,0,0,1,0,0,1,1], [0,0,1,1,0,1,1,1,0,1,1,1,1,1,1,1],
	[0,0,0,1,0,0,1,1,0,1,1,1,1,1,1,1], [0,0,0,0,0,0,0,1,0,0,1,1,0,1,1,1],
	[0,0,0,0,0,0,0,0,0,0,0,1,0,0,1,1], [0,0,1,1,0,1,1,1,1,1,1,1,1,1,1,1],
	[0,0,0,0,0,0,0,1,0,1,1,1,1,1,1,1], [0,0,0,0,0,0,0,0,0,0,0,1,0,1,1,1],
	[0,0,0,1,0,1,1,1,1,1,1,1,1,1,1,1], [0,0,0,0,0,0,0,0,1,1,1,1,1,1,1,1],
	[0,0,0,0,1,1,1,1,1,1,1,1,1,1,1,1], [0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,1],
	[0,0,0,0,1,0,0,0,1,1,1,0,1,1,1,1], [0,1,1,1,0,0,0,1,0,0,0,0,0,0,0,0],
	[0,0,0,0,0,0,0,0,1,0,0,0,1,1,1,0], [0,1,1,1,0,0,1,1,0,0,0,1,0,0,0,0],
	[0,0,1,1,0,0,0,1,0,0,0,0,0,0,0,0], [0,0,0,0,1,0,0,0,1,1,0,0,1,1,1,0],
	[0,0,0,0,0,0,0,0,1,0,0,0,1,1,0,0], [0,1,1,1,0,0,1,1,0,0,1,1,0,0,0,1],
	[0,0,1,1,0,0,0,1,0,0,0,1,0,0,0,0], [0,0,0,0,1,0,0,0,1,0,0,0,1,1,0,0],
	[0,1,1,0,0,1,1,0,0,1,1,0,0,1,1,0], [0,0,1,1,0,1,1,0,0,1,1,0,1,1,0,0],
	[0,0,0,1,0,1,1,1,1,1,1,0,1,0,0,0], [0,0,0,0,1,1,1,1,1,1,1,1,0,0,0,0],
	[0,1,1,1,0,0,0,1,1,0,0,0,1,1,1,0], [0,0,1,1,1,0,0,1,1,0,0,1,1,1,0,0],
	[0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1], [0,0,0,0,1,1,1,1,0,0,0,0,1,1,1,1],
	[0,1,0,1,1,0,1,0,0,1,0,1,1,0,1,0], [0,0,1,1,0,0,1,1,1,1,0,0,1,1,0,0],
	[0,0,1,1,1,1,0,0,0,0,1,1,1,1,0,0], [0,1,0,1,0,1,0,1,1,0,1,0,1,0,1,0],
	[0,1,1,0,1,0,0,1,0,1,1,0,1,0,0,1], [0,1,0,1,1,0,1,0,1,0,1,0,0,1,0,1],
	[0,1,1,1,0,0,1,1,1,1,0,0,1,1,1,0], [0,0,0,1,0,0,1,1,1,1,0,0,1,0,0,0],
	[0,0,1,1,0,0,1,0,0,1,0,0,1,1,0,0], [0,0,1,1,1,0,1,1,1,1,0,1,1,1,0,0],
	[0,1,1,0,1,0,0,1,1,0,0,1,0,1,1,0], [0,0,1,1,1,1,0,0,1,1,0,0,0,0,1,1],
	[0,1,1,0,0,1,1,0,1,0,0,1,1,0,0,1], [0,0,0,0,0,1,1,0,0,1,1,0,0,0,0,0],
	[0,1,0,0,1,1,1,0,0,1,0,0,0,0,0,0], [0,0,1,0,0,1,1,1,0,0,1,0,0,0,0,0],
	[0,0,0,0,0,0,1,0,0,1,1,1,0,0,1,0], [0,0,0,0,0,1,0,0,1,1,1,0,0,1,0,0],
	[0,1,1,0,1,1,0,0,1,0,0,1,0,0,1,1], [0,0,1,1,0,1,1,0,1,1,0,0,1,0,0,1],
	[0,1,1,0,0,0,1,1,1,0,0,1,1,1,0,0], [0,0,1,1,1,0,0,1,1,1,0,0,0,1,1,0],
	[0,1,1,0,1,1,0,0,1,1,0,0,1,0,0,1], [0,1,1,0,0,0,1,1,0,0,1,1,1,0,0,1],
	[0,1,1,1,1,1,1,0,1,0,0,0,0,0,0,1], [0,0,0,1,1,0,0,0,1,1,1,0,0,1,1,1],
	[0,0,0,0,1,1,1,1,0,0,1,1,0,0,1,1], [0,0,1,1,0,0,1,1,1,1,1,1,0,0,0,0],
	[0,0,1,0,0,0,1,0,1,1,1,0,1,1,1,0], [0,1,0,0,0,1,0,0,0,1,1,1,0,1,1,1],
];

/** Subset assignment for each of the 64 three-subset partitions. */
// biome-ignore format: a 4x4 block per row is the only readable shape for this.
export const BC7_PARTITION_3: readonly (readonly number[])[] = [
	[0,0,1,1,0,0,1,1,0,2,2,1,2,2,2,2], [0,0,0,1,0,0,1,1,2,2,1,1,2,2,2,1],
	[0,0,0,0,2,0,0,1,2,2,1,1,2,2,1,1], [0,2,2,2,0,0,2,2,0,0,1,1,0,1,1,1],
	[0,0,0,0,0,0,0,0,1,1,2,2,1,1,2,2], [0,0,1,1,0,0,1,1,0,0,2,2,0,0,2,2],
	[0,0,2,2,0,0,2,2,1,1,1,1,1,1,1,1], [0,0,1,1,0,0,1,1,2,2,1,1,2,2,1,1],
	[0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2], [0,0,0,0,1,1,1,1,1,1,1,1,2,2,2,2],
	[0,0,0,0,1,1,1,1,2,2,2,2,2,2,2,2], [0,0,1,2,0,0,1,2,0,0,1,2,0,0,1,2],
	[0,1,1,2,0,1,1,2,0,1,1,2,0,1,1,2], [0,1,2,2,0,1,2,2,0,1,2,2,0,1,2,2],
	[0,0,1,1,0,1,1,2,1,1,2,2,1,2,2,2], [0,0,1,1,2,0,0,1,2,2,0,0,2,2,2,0],
	[0,0,0,1,0,0,1,1,0,1,1,2,1,1,2,2], [0,1,1,1,0,0,1,1,2,0,0,1,2,2,0,0],
	[0,0,0,0,1,1,2,2,1,1,2,2,1,1,2,2], [0,0,2,2,0,0,2,2,0,0,2,2,1,1,1,1],
	[0,1,1,1,0,1,1,1,0,2,2,2,0,2,2,2], [0,0,0,1,0,0,0,1,2,2,2,1,2,2,2,1],
	[0,0,0,0,0,0,1,1,0,1,2,2,0,1,2,2], [0,0,0,0,1,1,0,0,2,2,1,0,2,2,1,0],
	[0,1,2,2,0,1,2,2,0,0,1,1,0,0,0,0], [0,0,1,2,0,0,1,2,1,1,2,2,2,2,2,2],
	[0,1,1,0,1,2,2,1,1,2,2,1,0,1,1,0], [0,0,0,0,0,1,1,0,1,2,2,1,1,2,2,1],
	[0,0,2,2,1,1,0,2,1,1,0,2,0,0,2,2], [0,1,1,0,0,1,1,0,2,0,0,2,2,2,2,2],
	[0,0,1,1,0,1,2,2,0,1,2,2,0,0,1,1], [0,0,0,0,2,0,0,0,2,2,1,1,2,2,2,1],
	[0,0,0,0,0,0,0,2,1,1,2,2,1,2,2,2], [0,2,2,2,0,0,2,2,0,0,1,2,0,0,1,1],
	[0,0,1,1,0,0,1,2,0,0,2,2,0,2,2,2], [0,1,2,0,0,1,2,0,0,1,2,0,0,1,2,0],
	[0,0,0,0,1,1,1,1,2,2,2,2,0,0,0,0], [0,1,2,0,1,2,0,1,2,0,1,2,0,1,2,0],
	[0,1,2,0,2,0,1,2,1,2,0,1,0,1,2,0], [0,0,1,1,2,2,0,0,1,1,2,2,0,0,1,1],
	[0,0,1,1,1,1,2,2,2,2,0,0,0,0,1,1], [0,1,0,1,0,1,0,1,2,2,2,2,2,2,2,2],
	[0,0,0,0,0,0,0,0,2,1,2,1,2,1,2,1], [0,0,2,2,1,1,2,2,0,0,2,2,1,1,2,2],
	[0,0,2,2,0,0,1,1,0,0,2,2,0,0,1,1], [0,2,2,0,1,2,2,1,0,2,2,0,1,2,2,1],
	[0,1,0,1,2,2,2,2,2,2,2,2,0,1,0,1], [0,0,0,0,2,1,2,1,2,1,2,1,2,1,2,1],
	[0,1,0,1,0,1,0,1,0,1,0,1,2,2,2,2], [0,2,2,2,0,1,1,1,0,2,2,2,0,1,1,1],
	[0,0,0,2,1,1,1,2,0,0,0,2,1,1,1,2], [0,0,0,0,2,1,1,2,2,1,1,2,2,1,1,2],
	[0,2,2,2,0,1,1,1,0,1,1,1,0,2,2,2], [0,0,0,2,1,1,1,2,1,1,1,2,0,0,0,2],
	[0,1,1,0,0,1,1,0,0,1,1,0,2,2,2,2], [0,0,0,0,0,0,0,0,2,1,1,2,2,1,1,2],
	[0,1,1,0,0,1,1,0,2,2,2,2,2,2,2,2], [0,0,2,2,0,0,1,1,0,0,1,1,0,0,2,2],
	[0,0,2,2,1,1,2,2,1,1,2,2,0,0,2,2], [0,0,0,0,0,0,0,0,0,0,0,0,2,1,1,2],
	[0,0,0,2,0,0,0,1,0,0,0,2,0,0,0,1], [0,2,2,2,1,2,2,2,0,2,2,2,1,2,2,2],
	[0,1,0,1,2,2,2,2,2,2,2,2,2,2,2,2], [0,1,1,1,2,0,1,1,2,2,0,1,2,2,2,0],
];

/**
 * Anchor (fix-up) index for subset 1 of a two-subset partition.
 *
 * The anchor pixel of a subset stores one fewer index bit, because its high bit is
 * implied to be 0. Subset 0's anchor is always pixel 0 and needs no table.
 */
// biome-ignore format: 16 per row mirrors the partition table above.
export const BC7_ANCHOR_2: readonly number[] = [
	15,15,15,15,15,15,15,15, 15,15,15,15,15,15,15,15,
	15, 2, 8, 2, 2, 8, 8,15,  2, 8, 2, 2, 8, 8, 2, 2,
	15,15, 6, 8, 2, 8,15,15,  2, 8, 2, 2, 2,15,15, 6,
	 6, 2, 6, 8,15,15, 2, 2, 15,15,15,15,15, 2, 2,15,
];

/** Anchor index for subset 1 of a three-subset partition. */
// biome-ignore format: 16 per row mirrors the partition table above.
export const BC7_ANCHOR_3_1: readonly number[] = [
	 3, 3,15,15, 8, 3,15,15,  8, 8, 6, 6, 6, 5, 3, 3,
	 3, 3, 8,15, 3, 3, 6,10,  5, 8, 8, 6, 8, 5,15,15,
	 8,15, 3, 5, 6,10, 8,15, 15, 3,15, 5,15,15,15,15,
	 3,15, 5, 5, 5, 8, 5,10,  5,10, 8,13,15,12, 3, 3,
];

/**
 * Anchor index for subset 2 of a three-subset partition.
 *
 * Entries 59, 60 and 63 were wrong in the first transcription of this table and were
 * corrected against a GPU: `scripts/verify-bc7.ts` builds blocks whose anchor pixels
 * decode to a distinctly darker grey than the rest, so the hardware reports its own
 * anchor positions. The same probe confirmed every other entry and the whole of
 * `BC7_PARTITION_3`; `BC7_PARTITION_2[18]` was corrected the same way.
 */
// biome-ignore format: 16 per row mirrors the partition table above.
export const BC7_ANCHOR_3_2: readonly number[] = [
	15, 8, 8, 3,15,15, 3, 8, 15,15,15,15,15,15,15, 8,
	15, 8,15, 3,15, 8,15, 8,  3,15, 6,10,15,15,10, 8,
	15, 3,15,10,10, 8, 9,10,  6,15, 8,15, 3, 6, 6, 8,
	15, 3,15,15,15,15,15,15, 15,15,15,15,  3,15,15, 8,
];

/** Interpolation weights, indexed by index-bit count then by index value. */
export const BC7_WEIGHTS_2: readonly number[] = [0, 21, 43, 64];
export const BC7_WEIGHTS_3: readonly number[] = [0, 9, 18, 27, 37, 46, 55, 64];
// biome-ignore format: one row keeps it comparable with the spec table.
export const BC7_WEIGHTS_4: readonly number[] = [0,4,9,13,17,21,26,30,34,38,43,47,51,55,60,64];

export interface Bc7ModeInfo {
  /** Number of subsets: 1, 2 or 3. */
  subsets: number;
  /** Partition index bit count. */
  partitionBits: number;
  /** Rotation bit count (modes 4 and 5 only). */
  rotationBits: number;
  /** Index-selection bit count (mode 4 only). */
  indexSelectionBits: number;
  /** Colour endpoint precision, in bits per component. */
  colorBits: number;
  /** Alpha endpoint precision. 0 means the block is opaque. */
  alphaBits: number;
  /** Per-endpoint P-bit count: 1 means every endpoint carries its own low bit. */
  endpointPBits: number;
  /** Shared P-bit count: 1 means the two endpoints of a subset share one low bit. */
  sharedPBits: number;
  /** Primary index bit count. */
  indexBits: number;
  /** Secondary index bit count (modes 4 and 5), 0 when there is only one index set. */
  indexBits2: number;
}

/** Per-mode layout, in mode order 0-7. Table 1 of the BC7 specification. */
export const BC7_MODES: readonly Bc7ModeInfo[] = [
  {
    subsets: 3,
    partitionBits: 4,
    rotationBits: 0,
    indexSelectionBits: 0,
    colorBits: 4,
    alphaBits: 0,
    endpointPBits: 1,
    sharedPBits: 0,
    indexBits: 3,
    indexBits2: 0,
  },
  {
    subsets: 2,
    partitionBits: 6,
    rotationBits: 0,
    indexSelectionBits: 0,
    colorBits: 6,
    alphaBits: 0,
    endpointPBits: 0,
    sharedPBits: 1,
    indexBits: 3,
    indexBits2: 0,
  },
  {
    subsets: 3,
    partitionBits: 6,
    rotationBits: 0,
    indexSelectionBits: 0,
    colorBits: 5,
    alphaBits: 0,
    endpointPBits: 0,
    sharedPBits: 0,
    indexBits: 2,
    indexBits2: 0,
  },
  {
    subsets: 2,
    partitionBits: 6,
    rotationBits: 0,
    indexSelectionBits: 0,
    colorBits: 7,
    alphaBits: 0,
    endpointPBits: 1,
    sharedPBits: 0,
    indexBits: 2,
    indexBits2: 0,
  },
  {
    subsets: 1,
    partitionBits: 0,
    rotationBits: 2,
    indexSelectionBits: 1,
    colorBits: 5,
    alphaBits: 6,
    endpointPBits: 0,
    sharedPBits: 0,
    indexBits: 2,
    indexBits2: 3,
  },
  {
    subsets: 1,
    partitionBits: 0,
    rotationBits: 2,
    indexSelectionBits: 0,
    colorBits: 7,
    alphaBits: 8,
    endpointPBits: 0,
    sharedPBits: 0,
    indexBits: 2,
    indexBits2: 2,
  },
  {
    subsets: 1,
    partitionBits: 0,
    rotationBits: 0,
    indexSelectionBits: 0,
    colorBits: 7,
    alphaBits: 7,
    endpointPBits: 1,
    sharedPBits: 0,
    indexBits: 4,
    indexBits2: 0,
  },
  {
    subsets: 2,
    partitionBits: 6,
    rotationBits: 0,
    indexSelectionBits: 0,
    colorBits: 5,
    alphaBits: 5,
    endpointPBits: 1,
    sharedPBits: 0,
    indexBits: 2,
    indexBits2: 0,
  },
];

/** The anchor pixel index for `subset` of `partition` under `subsetCount` subsets. */
export function bc7Anchor(subsetCount: number, partition: number, subset: number): number {
  if (subset === 0) return 0;
  if (subsetCount === 2) return BC7_ANCHOR_2[partition] ?? 15;
  return (subset === 1 ? BC7_ANCHOR_3_1[partition] : BC7_ANCHOR_3_2[partition]) ?? 15;
}

/** Which subset each of the 16 pixels belongs to. */
export function bc7Subsets(subsetCount: number, partition: number): readonly number[] {
  if (subsetCount === 1) return BC7_SINGLE_SUBSET;
  const table = subsetCount === 2 ? BC7_PARTITION_2 : BC7_PARTITION_3;
  return table[partition] ?? BC7_SINGLE_SUBSET;
}

const BC7_SINGLE_SUBSET: readonly number[] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
