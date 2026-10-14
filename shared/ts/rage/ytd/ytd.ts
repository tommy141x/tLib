// Texture dictionary (.ytd) structure parsing, both generations.
//
// Ported from CodeWalker.Core (MIT, dexyfex/Neodymium):
//   Resources/Texture.cs:15    TextureDictionary
//   Resources/Texture.cs:201   TextureBase  - two entirely different 80-byte layouts
//   Resources/Texture.cs:885   Texture      - the gen8 tail; gen9 has none
//   FileTypes/YtdFile.cs:45    the version -> generation decision
//
// Two things about this format cost time if you do not know them up front:
//
//   * `.ytd` container versions are INVERTED relative to `.yft`. gen8 is 13 and gen9 is
//     5, so here the *higher* number is Legacy. A `ver >= N` generation test calibrated
//     on YFT gets every `.ytd` backwards.
//   * Pixel data lives in the GRAPHICS segment (base 0x60000000); the structs live in
//     system (0x50000000). `ResourceReader` routes by address, so this is only visible
//     as a note - but a DataPointer that resolves to system means a misparse.

import { joaat } from "../jenk";
import { ResourceReadError, type ResourceReader } from "../reader";
import type { Rsc7Resource } from "../rsc7";
import { SYSTEM_BASE } from "../rsc7";
import {
  computeDataSize,
  computeLegacyDataSize,
  computeMipLevels,
  computePitch,
  DxgiFormat,
  dxgiFromG9,
  dxgiFromLegacy,
  legacyFormatFromG9,
  type MipLevel,
  type TextureFormat,
  TextureFormatG9,
} from "./formats";

/** `.ytd` container version for each generation. Higher is Legacy - see the note above. */
export const YTD_VERSION_GEN8 = 13;
export const YTD_VERSION_GEN9 = 5;

/** `TextureDimensionG9`. */
export enum TextureDimension {
  Texture2D = 1,
  TextureCube = 2,
  Texture3D = 3,
}

/**
 * `TextureTileModeG9`.
 *
 * PC textures are linear and CodeWalker contains no untiling code at all, so anything
 * other than `Auto` or `Linear` is unreadable here. `parseTextureDictionary` reports it
 * as a warning rather than guessing at a swizzle.
 */
export enum TextureTileMode {
  Depth = 4,
  Linear = 8,
  Display = 10,
  Standard = 13,
  RenderTarget = 14,
  VolumeStandard = 19,
  VolumeRenderTarget = 20,
  Auto = 255,
}

/** `TextureUsage` - the semantic slot a texture fills in a shader. */
export enum TextureUsage {
  UNKNOWN = 0,
  DEFAULT = 1,
  TERRAIN = 2,
  CLOUDDENSITY = 3,
  CLOUDNORMAL = 4,
  CABLE = 5,
  FENCE = 6,
  ENVEFF = 7,
  SCRIPT = 8,
  WATERFLOW = 9,
  WATERFOAM = 10,
  WATERFOG = 11,
  WATEROCEAN = 12,
  WATER = 13,
  FOAMOPACITY = 14,
  FOAM = 15,
  DIFFUSEMIPSHARPEN = 16,
  DIFFUSEDETAIL = 17,
  DIFFUSEDARK = 18,
  DIFFUSEALPHAOPAQUE = 19,
  DIFFUSE = 20,
  DETAIL = 21,
  NORMAL = 22,
  SPECULAR = 23,
  EMISSIVE = 24,
  TINTPALETTE = 25,
  SKIPPROCESSING = 26,
  DONOTOPTIMIZE = 27,
  TEST = 28,
  COUNT = 29,
}

export interface Texture {
  name: string | null;
  /** joaat of the lowercased name, which is how the dictionary is keyed. */
  nameHash: number;
  width: number;
  height: number;
  depth: number;
  levels: number;
  /** Bytes per row of the base mip. Stored on gen8, derived on gen9. */
  stride: number;
  /** Legacy D3DFMT. Derived from the gen9 format on an Enhanced file. */
  format: TextureFormat | 0;
  /** The gen9 format byte, or `UNKNOWN` on a Legacy file. */
  formatG9: TextureFormatG9;
  /** The format both decode paths actually switch on. */
  dxgi: DxgiFormat;
  usage: TextureUsage;
  usageFlags: number;
  dimension: TextureDimension;
  tileMode: TextureTileMode;
  /** Mip offsets and shapes inside `data`. */
  mips: MipLevel[];
  /** The whole mip chain, a view into the graphics segment - not a copy. */
  data: Uint8Array;
}

export interface TextureDictionary {
  /** RSC7 container version: 13 gen8, 5 gen9. */
  version: number;
  gen9: boolean;
  textures: Texture[];
  /** Name hashes in file order, parallel to `textures`. */
  nameHashes: number[];
  /** Non-fatal problems: an unreadable tile mode, a short data block, and similar. */
  warnings: string[];
}

/** A `ResourceSimpleList64` / `ResourcePointerList64` header: ptr, count, capacity, pad. */
function readListHeader(r: ResourceReader): { pointer: number; count: number; capacity: number } {
  const pointer = r.pointer();
  const count = r.uint16();
  const capacity = r.uint16();
  r.skip(4);
  return { pointer, count, capacity };
}

/**
 * Slice `length` bytes at `address`, clamped to what the segment actually holds.
 *
 * A short data block is common enough in shipped files that throwing would reject
 * otherwise-readable dictionaries; CodeWalker's own DDS export clamps the same way
 * (`DDSIO.GetDDSFile`, the `lengt = img.Data.Length - ...` branch).
 */
function clampedBytes(
  r: ResourceReader,
  address: number,
  length: number,
  warnings: string[],
  what: string
): Uint8Array {
  const { view, offset, segment } = r.resolve(address);
  const available = view.byteLength - offset;
  if (available < length) {
    warnings.push(
      `${what}: data block wants ${length} bytes at ${segment}+0x${offset.toString(16)} but ` +
        `only ${Math.max(0, available)} remain`
    );
  }
  const take = Math.max(0, Math.min(length, available));
  return new Uint8Array(view.buffer, view.byteOffset + offset, take);
}

/**
 * gen9 `TextureBase` + `Texture`: one flat 128-byte block.
 *
 * The gen9 layout shares no field offsets with gen8 beyond the first eight bytes. In
 * particular width/height/format sit inside the first 80 bytes here and in the *second*
 * 64 there, which is why a single reader for both generations is not possible.
 */
function readTextureGen9(r: ResourceReader, warnings: string[]): Texture {
  r.skip(4); // VFT
  r.skip(4); // Unknown_4h - 1
  r.skip(4); // G9_BlockCount  - derivable, and we derive it
  const blockStride = r.uint32();
  r.skip(4); // G9_Flags
  r.skip(4); // Unknown_14h
  const width = r.uint16();
  const height = r.uint16();
  const depth = r.uint16();
  const dimension = r.byte() as TextureDimension;
  const formatG9 = r.byte() as TextureFormatG9;
  const tileMode = r.byte() as TextureTileMode;
  r.skip(1); // G9_AntiAliasType
  const levels = r.byte();
  r.skip(1); // G9_Unknown_23h
  r.skip(1); // Unknown_24h
  r.skip(1); // G9_Unknown_25h
  r.skip(2); // G9_UsageCount
  const namePointer = r.pointer();
  r.skip(8); // G9_SRVPointer - a runtime shader resource view, nothing to decode
  const dataPointer = r.pointer();
  const usageData = r.uint32();
  r.skip(4); // Unknown_44h
  r.skip(8); // G9_Unknown_48h
  // The gen8 tail is absent; gen9 carries an embedded SRV here instead.
  r.skip(48);

  const name = r.stringAt(namePointer);
  const dxgi = dxgiFromG9(formatG9);

  if (tileMode !== TextureTileMode.Auto && tileMode !== TextureTileMode.Linear) {
    warnings.push(
      `texture "${name ?? "?"}": tile mode ${TextureTileMode[tileMode] ?? tileMode} is not ` +
        "linear; there is no untiling reference for it and the pixels will be wrong"
    );
  }

  const mips = computeMipLevels(dxgi, width, height, levels);
  const size = computeDataSize(dxgi, width, height, levels, Math.max(1, depth));
  const data = dataPointer
    ? clampedBytes(r, dataPointer, size, warnings, `texture "${name ?? "?"}"`)
    : new Uint8Array(0);

  return {
    name,
    nameHash: name ? joaat(name) : 0,
    width,
    height,
    depth,
    levels,
    // gen9 stores a per-block stride, not a row pitch; derive the row pitch the way
    // `TextureBase.CalculateStride` does so both generations report the same thing.
    stride: computePitch(dxgi, width, height).rowPitch || blockStride,
    format: legacyFormatFromG9(formatG9),
    formatG9,
    dxgi,
    usage: (usageData & 0x1f) as TextureUsage,
    usageFlags: usageData >>> 5,
    dimension,
    tileMode,
    mips,
    data,
  };
}

/** gen8 `TextureBase` (80 bytes) + `Texture` (64 more). */
function readTextureGen8(r: ResourceReader, warnings: string[]): Texture {
  r.skip(40); // VFT .. Unknown_24h
  const namePointer = r.pointer();
  r.skip(2); // Unknown_30h
  r.skip(2); // Unknown_32h
  r.skip(12); // Unknown_34h, Unknown_38h, Unknown_3Ch
  const usageData = r.uint32();
  r.skip(4); // Unknown_44h
  r.skip(4); // ExtraFlags
  r.skip(4); // Unknown_4Ch

  const width = r.uint16();
  const height = r.uint16();
  const depth = r.uint16();
  const stride = r.uint16();
  const format = r.uint32() as TextureFormat;
  r.skip(1); // Unknown_5Ch
  const levels = r.byte();
  r.skip(2); // Unknown_5Eh
  r.skip(16); // Unknown_60h .. Unknown_6Ch
  const dataPointer = r.pointer();
  r.skip(24); // Unknown_78h .. Unknown_8Ch

  const name = r.stringAt(namePointer);
  const dxgi = dxgiFromLegacy(format);
  const mips = computeMipLevels(dxgi, width, height, levels);

  // gen8 sizes its data block from the stored stride, not from the format - see
  // `computeLegacyDataSize`. Read that many bytes so the block matches the file even
  // when the two disagree, which they do for non-power-of-two textures.
  const size = computeLegacyDataSize(stride, height, levels);
  const data = dataPointer
    ? clampedBytes(r, dataPointer, size, warnings, `texture "${name ?? "?"}"`)
    : new Uint8Array(0);

  return {
    name,
    nameHash: name ? joaat(name) : 0,
    width,
    height,
    depth,
    levels,
    stride,
    format,
    formatG9: TextureFormatG9.UNKNOWN,
    dxgi,
    usage: (usageData & 0x1f) as TextureUsage,
    usageFlags: usageData >>> 5,
    dimension: TextureDimension.Texture2D,
    tileMode: TextureTileMode.Linear,
    mips,
    data,
  };
}

/**
 * Parse a decompressed RSC7 resource as a texture dictionary.
 *
 * `gen9` is decided by the container version, not by a heuristic: `YtdFile.Load` maps
 * 5 to gen9 and 13 to gen8 and nothing else is valid.
 */
export function parseTextureDictionary(
  resource: Rsc7Resource,
  reader: ResourceReader
): TextureDictionary {
  const warnings: string[] = [];
  const version = resource.header.version;
  let gen9: boolean;
  if (version === YTD_VERSION_GEN9) {
    gen9 = true;
  } else if (version === YTD_VERSION_GEN8) {
    gen9 = false;
  } else {
    throw new ResourceReadError(
      `.ytd container version ${version} is neither ${YTD_VERSION_GEN8} (gen8) nor ` +
        `${YTD_VERSION_GEN9} (gen9)`
    );
  }

  const r = reader.seek(SYSTEM_BASE);
  r.skip(16); // ResourceFileBase: FileVFT, FileUnknown, FilePagesInfoPointer
  r.skip(16); // Unknown_10h .. Unknown_1Ch
  const hashes = readListHeader(r);
  const textures = readListHeader(r);

  const nameHashes = r.simpleArray(hashes.pointer, hashes.count, (x) => x.uint32());

  const read = gen9 ? readTextureGen9 : readTextureGen8;
  const parsed = r.pointerArray(textures.pointer, textures.count, (rr) => read(rr, warnings));

  const out: Texture[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const tex = parsed[i];
    if (!tex) {
      warnings.push(`texture slot ${i} has a null pointer`);
      continue;
    }
    // The dictionary's own hash list is authoritative; the name-derived hash is only a
    // cross-check, and a mismatch means the name string was read from the wrong place.
    const declared = nameHashes[i];
    if (declared !== undefined && tex.nameHash !== 0 && declared !== tex.nameHash) {
      warnings.push(
        `texture "${tex.name}" hashes to 0x${tex.nameHash.toString(16)} but the dictionary ` +
          `lists 0x${(declared >>> 0).toString(16)}`
      );
    }
    if (tex.dxgi === DxgiFormat.UNKNOWN) {
      warnings.push(`texture "${tex.name}": unrecognised format, pixels cannot be decoded`);
    }
    out.push(tex);
  }

  return { version, gen9, textures: out, nameHashes, warnings };
}

/** Find a texture by name, case-insensitively, the way the game addresses them. */
export function findTexture(dict: TextureDictionary, name: string): Texture | undefined {
  const hash = joaat(name);
  return dict.textures.find((t) => t.nameHash === hash);
}

/**
 * The raw bytes of one mip level.
 *
 * Returns a view, not a copy. A level whose data runs past a truncated data block comes
 * back short rather than throwing - check `.length` against `mips[level].slicePitch` if
 * that matters.
 */
export function mipBytes(texture: Texture, level: number): Uint8Array {
  const mip = texture.mips[level];
  if (!mip) {
    throw new ResourceReadError(
      `texture "${texture.name}" has ${texture.mips.length} mip levels; ${level} is out of range`
    );
  }
  return texture.data.subarray(mip.offset, mip.offset + mip.slicePitch);
}
