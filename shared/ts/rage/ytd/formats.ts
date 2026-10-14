// Texture formats: the three enums a .ytd speaks, and the pitch/mip arithmetic that
// turns a format plus a width and height into byte offsets.
//
// Ported from CodeWalker.Core (MIT, dexyfex/Neodymium):
//   Resources/Texture.cs:1125  TextureFormat    - legacy D3DFMT values / FourCCs
//   Resources/Texture.cs:1144  TextureFormatG9  - rage::sga::BufferFormat, gen9
//   Resources/Texture.cs:719   GetLegacyFormat  - the gen9 -> legacy mapping
//   Utils/DDSIO.cs:503         GetDXGIFormat
//   Utils/DDSIO.cs:674         DXTex.ComputePitch
//   Utils/DDSIO.cs:937         DXTex.BitsPerPixel
//   Utils/DDSIO.cs:538         GetMipmapImages  - the mip offset walk
//
// Three format spaces exist because the file stores one and the decoders want another:
// a gen8 `.ytd` stores a legacy D3DFMT, a gen9 `.ytd` stores a `sga::BufferFormat`, and
// both are funnelled to DXGI - which is also what WebGL's compressed-texture extensions
// are named after. Keep DXGI as the single currency past parsing.

/** Legacy D3DFMT values as stored in a gen8 `.ytd`. FourCCs are little-endian ASCII. */
export enum TextureFormat {
  D3DFMT_A8R8G8B8 = 21,
  D3DFMT_X8R8G8B8 = 22,
  D3DFMT_A1R5G5B5 = 25,
  D3DFMT_A8 = 28,
  D3DFMT_A8B8G8R8 = 32,
  D3DFMT_L8 = 50,
  D3DFMT_DXT1 = 0x31545844,
  D3DFMT_DXT3 = 0x33545844,
  D3DFMT_DXT5 = 0x35545844,
  D3DFMT_ATI1 = 0x31495441,
  D3DFMT_ATI2 = 0x32495441,
  D3DFMT_BC7 = 0x20374342,
}

/**
 * `rage::sga::BufferFormat` - the gen9 format byte. Numerically close to DXGI but not
 * equal to it, so it must be mapped rather than cast.
 */
export enum TextureFormatG9 {
  UNKNOWN = 0x0,
  R32G32B32A32_TYPELESS = 0x1,
  R32G32B32A32_FLOAT = 0x2,
  R32G32B32A32_UINT = 0x3,
  R32G32B32A32_SINT = 0x4,
  R32G32B32_TYPELESS = 0x5,
  R32G32B32_FLOAT = 0x6,
  R32G32B32_UINT = 0x7,
  R32G32B32_SINT = 0x8,
  R16G16B16A16_TYPELESS = 0x9,
  R16G16B16A16_FLOAT = 0xa,
  R16G16B16A16_UNORM = 0xb,
  R16G16B16A16_UINT = 0xc,
  R16G16B16A16_SNORM = 0xd,
  R16G16B16A16_SINT = 0xe,
  R32G32_TYPELESS = 0xf,
  R32G32_FLOAT = 0x10,
  R32G32_UINT = 0x11,
  R32G32_SINT = 0x12,
  D32_FLOAT_S8X24_UINT = 0x14,
  B10G10R10A2_UNORM = 0x15,
  R10G10B10A2_SNORM = 0x16,
  R10G10B10A2_TYPELESS = 0x17,
  R10G10B10A2_UNORM = 0x18,
  R10G10B10A2_UINT = 0x19,
  R11G11B10_FLOAT = 0x1a,
  R8G8B8A8_TYPELESS = 0x1b,
  R8G8B8A8_UNORM = 0x1c,
  R8G8B8A8_UNORM_SRGB = 0x1d,
  R8G8B8A8_UINT = 0x1e,
  R8G8B8A8_SNORM = 0x1f,
  R8G8B8A8_SINT = 0x20,
  R16G16_TYPELESS = 0x21,
  R16G16_FLOAT = 0x22,
  R16G16_UNORM = 0x23,
  R16G16_UINT = 0x24,
  R16G16_SNORM = 0x25,
  R16G16_SINT = 0x26,
  R32_TYPELESS = 0x27,
  D32_FLOAT = 0x28,
  R32_FLOAT = 0x29,
  R32_UINT = 0x2a,
  R32_SINT = 0x2b,
  R8G8_TYPELESS = 0x30,
  R8G8_UNORM = 0x31,
  R8G8_UINT = 0x32,
  R8G8_SNORM = 0x33,
  R8G8_SINT = 0x34,
  R16_TYPELESS = 0x35,
  R16_FLOAT = 0x36,
  D16_UNORM = 0x37,
  R16_UNORM = 0x38,
  R16_UINT = 0x39,
  R16_SNORM = 0x3a,
  R16_SINT = 0x3b,
  R8_TYPELESS = 0x3c,
  R8_UNORM = 0x3d,
  R8_UINT = 0x3e,
  R8_SNORM = 0x3f,
  R8_SINT = 0x40,
  A8_UNORM = 0x41,
  R9G9B9E5_SHAREDEXP = 0x43,
  BC1_TYPELESS = 0x46,
  BC1_UNORM = 0x47,
  BC1_UNORM_SRGB = 0x48,
  BC2_TYPELESS = 0x49,
  BC2_UNORM = 0x4a,
  BC2_UNORM_SRGB = 0x4b,
  BC3_TYPELESS = 0x4c,
  BC3_UNORM = 0x4d,
  BC3_UNORM_SRGB = 0x4e,
  BC4_TYPELESS = 0x4f,
  BC4_UNORM = 0x50,
  BC4_SNORM = 0x51,
  BC5_TYPELESS = 0x52,
  BC5_UNORM = 0x53,
  BC5_SNORM = 0x54,
  B5G6R5_UNORM = 0x55,
  B5G5R5A1_UNORM = 0x56,
  B8G8R8A8_UNORM = 0x57,
  B8G8R8A8_TYPELESS = 0x5a,
  B8G8R8A8_UNORM_SRGB = 0x5b,
  BC6H_TYPELESS = 0x5e,
  BC6H_UF16 = 0x5f,
  BC6H_SF16 = 0x60,
  BC7_TYPELESS = 0x61,
  BC7_UNORM = 0x62,
  BC7_UNORM_SRGB = 0x63,
  NV12 = 0x67,
  B4G4R4A4_UNORM = 0x73,
  D16_UNORM_S8_UINT = 0x76,
  R16_UNORM_X8_TYPELESS = 0x77,
  X16_TYPELESS_G8_UINT = 0x78,
  ETC1 = 0x79,
  ETC1_SRGB = 0x7a,
  ETC1A = 0x7b,
  ETC1A_SRGB = 0x7c,
  R4G4_UNORM = 0x7f,
}

/** DXGI format numbers. Only the values a `.ytd` can reach are listed. */
export enum DxgiFormat {
  UNKNOWN = 0,
  R32G32B32A32_FLOAT = 2,
  R16G16B16A16_FLOAT = 10,
  R16G16B16A16_UNORM = 11,
  R11G11B10_FLOAT = 26,
  R8G8B8A8_UNORM = 28,
  R8G8B8A8_UNORM_SRGB = 29,
  R16G16_UNORM = 35,
  R32_FLOAT = 41,
  R8G8_UNORM = 49,
  R16_FLOAT = 54,
  R16_UNORM = 56,
  R8_UNORM = 61,
  A8_UNORM = 65,
  BC1_TYPELESS = 70,
  BC1_UNORM = 71,
  BC1_UNORM_SRGB = 72,
  BC2_TYPELESS = 73,
  BC2_UNORM = 74,
  BC2_UNORM_SRGB = 75,
  BC3_TYPELESS = 76,
  BC3_UNORM = 77,
  BC3_UNORM_SRGB = 78,
  BC4_TYPELESS = 79,
  BC4_UNORM = 80,
  BC4_SNORM = 81,
  BC5_TYPELESS = 82,
  BC5_UNORM = 83,
  BC5_SNORM = 84,
  B5G6R5_UNORM = 85,
  B5G5R5A1_UNORM = 86,
  B8G8R8A8_UNORM = 87,
  B8G8R8X8_UNORM = 88,
  R10G10B10A2_UNORM = 24,
  BC6H_TYPELESS = 94,
  BC6H_UF16 = 95,
  BC6H_SF16 = 96,
  BC7_TYPELESS = 97,
  BC7_UNORM = 98,
  BC7_UNORM_SRGB = 99,
  B4G4R4A4_UNORM = 115,
}

/**
 * gen9 format -> legacy format, exactly as `TextureBase.GetLegacyFormat`.
 *
 * It is lossy on purpose in CodeWalker: both sRGB variants collapse onto their linear
 * twin and `R16_UNORM` lands on `A8`. Use `dxgiFromG9` when the real format matters -
 * that path keeps sRGB, which the GPU upload path needs.
 */
export function legacyFormatFromG9(format: TextureFormatG9): TextureFormat | 0 {
  switch (format) {
    case TextureFormatG9.UNKNOWN:
      return 0;
    case TextureFormatG9.R8G8B8A8_UNORM:
      return TextureFormat.D3DFMT_A8B8G8R8;
    case TextureFormatG9.B8G8R8A8_UNORM:
      return TextureFormat.D3DFMT_A8R8G8B8;
    case TextureFormatG9.A8_UNORM:
      return TextureFormat.D3DFMT_A8;
    case TextureFormatG9.R8_UNORM:
      return TextureFormat.D3DFMT_L8;
    case TextureFormatG9.B5G5R5A1_UNORM:
      return TextureFormat.D3DFMT_A1R5G5B5;
    case TextureFormatG9.BC1_UNORM:
      return TextureFormat.D3DFMT_DXT1;
    case TextureFormatG9.BC2_UNORM:
      return TextureFormat.D3DFMT_DXT3;
    case TextureFormatG9.BC3_UNORM:
      return TextureFormat.D3DFMT_DXT5;
    case TextureFormatG9.BC4_UNORM:
      return TextureFormat.D3DFMT_ATI1;
    case TextureFormatG9.BC5_UNORM:
      return TextureFormat.D3DFMT_ATI2;
    case TextureFormatG9.BC7_UNORM:
    case TextureFormatG9.BC7_UNORM_SRGB:
      return TextureFormat.D3DFMT_BC7;
    case TextureFormatG9.BC3_UNORM_SRGB:
      return TextureFormat.D3DFMT_DXT5;
    case TextureFormatG9.R16_UNORM:
      return TextureFormat.D3DFMT_A8;
    default:
      return TextureFormat.D3DFMT_A8R8G8B8;
  }
}

/** Legacy format -> DXGI. `DDSIO.GetDXGIFormat`. */
export function dxgiFromLegacy(format: TextureFormat | 0): DxgiFormat {
  switch (format) {
    case TextureFormat.D3DFMT_DXT1:
      return DxgiFormat.BC1_UNORM;
    case TextureFormat.D3DFMT_DXT3:
      return DxgiFormat.BC2_UNORM;
    case TextureFormat.D3DFMT_DXT5:
      return DxgiFormat.BC3_UNORM;
    case TextureFormat.D3DFMT_ATI1:
      return DxgiFormat.BC4_UNORM;
    case TextureFormat.D3DFMT_ATI2:
      return DxgiFormat.BC5_UNORM;
    case TextureFormat.D3DFMT_BC7:
      return DxgiFormat.BC7_UNORM;
    case TextureFormat.D3DFMT_A1R5G5B5:
      return DxgiFormat.B5G5R5A1_UNORM;
    case TextureFormat.D3DFMT_A8:
      return DxgiFormat.A8_UNORM;
    case TextureFormat.D3DFMT_A8B8G8R8:
      return DxgiFormat.R8G8B8A8_UNORM;
    case TextureFormat.D3DFMT_L8:
      return DxgiFormat.R8_UNORM;
    case TextureFormat.D3DFMT_A8R8G8B8:
      return DxgiFormat.B8G8R8A8_UNORM;
    case TextureFormat.D3DFMT_X8R8G8B8:
      return DxgiFormat.B8G8R8X8_UNORM;
    default:
      return DxgiFormat.UNKNOWN;
  }
}

/**
 * gen9 format -> DXGI, without the sRGB-collapsing detour through the legacy enum.
 *
 * CodeWalker has no such function - it always round-trips through `GetLegacyFormat`,
 * which is why its own viewer treats a `BC7_UNORM_SRGB` as `BC7_UNORM`. Keeping the
 * distinction matters for upload: `SRGB8_ALPHA8` and `RGBA8` are different GL formats.
 */
export function dxgiFromG9(format: TextureFormatG9): DxgiFormat {
  switch (format) {
    case TextureFormatG9.BC1_UNORM:
      return DxgiFormat.BC1_UNORM;
    case TextureFormatG9.BC1_UNORM_SRGB:
      return DxgiFormat.BC1_UNORM_SRGB;
    case TextureFormatG9.BC2_UNORM:
      return DxgiFormat.BC2_UNORM;
    case TextureFormatG9.BC2_UNORM_SRGB:
      return DxgiFormat.BC2_UNORM_SRGB;
    case TextureFormatG9.BC3_UNORM:
      return DxgiFormat.BC3_UNORM;
    case TextureFormatG9.BC3_UNORM_SRGB:
      return DxgiFormat.BC3_UNORM_SRGB;
    case TextureFormatG9.BC4_UNORM:
      return DxgiFormat.BC4_UNORM;
    case TextureFormatG9.BC4_SNORM:
      return DxgiFormat.BC4_SNORM;
    case TextureFormatG9.BC5_UNORM:
      return DxgiFormat.BC5_UNORM;
    case TextureFormatG9.BC5_SNORM:
      return DxgiFormat.BC5_SNORM;
    case TextureFormatG9.BC6H_UF16:
      return DxgiFormat.BC6H_UF16;
    case TextureFormatG9.BC6H_SF16:
      return DxgiFormat.BC6H_SF16;
    case TextureFormatG9.BC7_UNORM:
      return DxgiFormat.BC7_UNORM;
    case TextureFormatG9.BC7_UNORM_SRGB:
      return DxgiFormat.BC7_UNORM_SRGB;
    case TextureFormatG9.R8G8B8A8_UNORM:
      return DxgiFormat.R8G8B8A8_UNORM;
    case TextureFormatG9.R8G8B8A8_UNORM_SRGB:
      return DxgiFormat.R8G8B8A8_UNORM_SRGB;
    case TextureFormatG9.B8G8R8A8_UNORM:
    case TextureFormatG9.B8G8R8A8_UNORM_SRGB:
      return DxgiFormat.B8G8R8A8_UNORM;
    case TextureFormatG9.B5G5R5A1_UNORM:
      return DxgiFormat.B5G5R5A1_UNORM;
    case TextureFormatG9.B5G6R5_UNORM:
      return DxgiFormat.B5G6R5_UNORM;
    case TextureFormatG9.B4G4R4A4_UNORM:
      return DxgiFormat.B4G4R4A4_UNORM;
    case TextureFormatG9.R8_UNORM:
      return DxgiFormat.R8_UNORM;
    case TextureFormatG9.A8_UNORM:
      return DxgiFormat.A8_UNORM;
    case TextureFormatG9.R8G8_UNORM:
      return DxgiFormat.R8G8_UNORM;
    case TextureFormatG9.R16_UNORM:
      return DxgiFormat.R16_UNORM;
    case TextureFormatG9.R16_FLOAT:
      return DxgiFormat.R16_FLOAT;
    case TextureFormatG9.R16G16_UNORM:
      return DxgiFormat.R16G16_UNORM;
    case TextureFormatG9.R16G16B16A16_UNORM:
      return DxgiFormat.R16G16B16A16_UNORM;
    case TextureFormatG9.R16G16B16A16_FLOAT:
      return DxgiFormat.R16G16B16A16_FLOAT;
    case TextureFormatG9.R32_FLOAT:
      return DxgiFormat.R32_FLOAT;
    case TextureFormatG9.R32G32B32A32_FLOAT:
      return DxgiFormat.R32G32B32A32_FLOAT;
    case TextureFormatG9.R10G10B10A2_UNORM:
      return DxgiFormat.R10G10B10A2_UNORM;
    case TextureFormatG9.R11G11B10_FLOAT:
      return DxgiFormat.R11G11B10_FLOAT;
    default:
      return DxgiFormat.UNKNOWN;
  }
}

/** Human-readable name for a DXGI value, for reports and error messages. */
export function dxgiFormatName(format: DxgiFormat): string {
  return DxgiFormat[format] ?? `0x${format.toString(16)}`;
}

/** True for the block-compressed families (BC1-BC7). */
export function isCompressedFormat(format: DxgiFormat): boolean {
  return (
    (format >= DxgiFormat.BC1_TYPELESS && format <= DxgiFormat.BC5_SNORM) ||
    (format >= DxgiFormat.BC6H_TYPELESS && format <= DxgiFormat.BC7_UNORM_SRGB)
  );
}

/** Bytes per 4x4 block for a compressed format, or 0 if it is not compressed. */
export function blockBytes(format: DxgiFormat): number {
  switch (format) {
    case DxgiFormat.BC1_TYPELESS:
    case DxgiFormat.BC1_UNORM:
    case DxgiFormat.BC1_UNORM_SRGB:
    case DxgiFormat.BC4_TYPELESS:
    case DxgiFormat.BC4_UNORM:
    case DxgiFormat.BC4_SNORM:
      return 8;
    case DxgiFormat.BC2_TYPELESS:
    case DxgiFormat.BC2_UNORM:
    case DxgiFormat.BC2_UNORM_SRGB:
    case DxgiFormat.BC3_TYPELESS:
    case DxgiFormat.BC3_UNORM:
    case DxgiFormat.BC3_UNORM_SRGB:
    case DxgiFormat.BC5_TYPELESS:
    case DxgiFormat.BC5_UNORM:
    case DxgiFormat.BC5_SNORM:
    case DxgiFormat.BC6H_TYPELESS:
    case DxgiFormat.BC6H_UF16:
    case DxgiFormat.BC6H_SF16:
    case DxgiFormat.BC7_TYPELESS:
    case DxgiFormat.BC7_UNORM:
    case DxgiFormat.BC7_UNORM_SRGB:
      return 16;
    default:
      return 0;
  }
}

/** `DXTex.BitsPerPixel`, restricted to the formats a `.ytd` can hold. */
export function bitsPerPixel(format: DxgiFormat): number {
  switch (format) {
    case DxgiFormat.R32G32B32A32_FLOAT:
      return 128;
    case DxgiFormat.R16G16B16A16_FLOAT:
    case DxgiFormat.R16G16B16A16_UNORM:
      return 64;
    case DxgiFormat.R8G8B8A8_UNORM:
    case DxgiFormat.R8G8B8A8_UNORM_SRGB:
    case DxgiFormat.B8G8R8A8_UNORM:
    case DxgiFormat.B8G8R8X8_UNORM:
    case DxgiFormat.R16G16_UNORM:
    case DxgiFormat.R32_FLOAT:
    case DxgiFormat.R10G10B10A2_UNORM:
    case DxgiFormat.R11G11B10_FLOAT:
      return 32;
    case DxgiFormat.R8G8_UNORM:
    case DxgiFormat.R16_FLOAT:
    case DxgiFormat.R16_UNORM:
    case DxgiFormat.B5G6R5_UNORM:
    case DxgiFormat.B5G5R5A1_UNORM:
    case DxgiFormat.B4G4R4A4_UNORM:
      return 16;
    case DxgiFormat.R8_UNORM:
    case DxgiFormat.A8_UNORM:
      return 8;
    case DxgiFormat.BC1_TYPELESS:
    case DxgiFormat.BC1_UNORM:
    case DxgiFormat.BC1_UNORM_SRGB:
    case DxgiFormat.BC4_TYPELESS:
    case DxgiFormat.BC4_UNORM:
    case DxgiFormat.BC4_SNORM:
      return 4;
    case DxgiFormat.BC2_TYPELESS:
    case DxgiFormat.BC2_UNORM:
    case DxgiFormat.BC2_UNORM_SRGB:
    case DxgiFormat.BC3_TYPELESS:
    case DxgiFormat.BC3_UNORM:
    case DxgiFormat.BC3_UNORM_SRGB:
    case DxgiFormat.BC5_TYPELESS:
    case DxgiFormat.BC5_UNORM:
    case DxgiFormat.BC5_SNORM:
    case DxgiFormat.BC6H_TYPELESS:
    case DxgiFormat.BC6H_UF16:
    case DxgiFormat.BC6H_SF16:
    case DxgiFormat.BC7_TYPELESS:
    case DxgiFormat.BC7_UNORM:
    case DxgiFormat.BC7_UNORM_SRGB:
      return 8;
    default:
      return 0;
  }
}

export interface Pitch {
  /** Bytes in one row - one row of *blocks* for a compressed format. */
  rowPitch: number;
  /** Bytes in the whole 2D image. */
  slicePitch: number;
}

/**
 * `DXTex.ComputePitch` with byte alignment (the only flag combination CodeWalker uses).
 *
 * The `max(1, ...)` on the block counts is what makes a 2x2 or 1x1 mip still occupy one
 * whole 4x4 block. Drop it and every mip tail comes out short.
 *
 * Zero width or height is not clamped for uncompressed formats - that is deliberate and
 * matches CodeWalker, whose mip walk divides the *base* dimensions and so can reach 0.
 */
export function computePitch(format: DxgiFormat, width: number, height: number): Pitch {
  const bb = blockBytes(format);
  if (bb > 0) {
    const nbw = Math.max(1, Math.floor((width + 3) / 4));
    const nbh = Math.max(1, Math.floor((height + 3) / 4));
    const rowPitch = nbw * bb;
    return { rowPitch, slicePitch: rowPitch * nbh };
  }
  const bpp = bitsPerPixel(format);
  const rowPitch = Math.floor((width * bpp + 7) / 8);
  return { rowPitch, slicePitch: rowPitch * height };
}

/** Rows of data in an image: block rows for compressed formats, scanlines otherwise. */
export function computeScanlines(format: DxgiFormat, height: number): number {
  return blockBytes(format) > 0 ? Math.max(1, Math.floor((height + 3) / 4)) : height;
}

/** One mip level's position and shape inside a texture's contiguous data block. */
export interface MipLevel {
  level: number;
  width: number;
  height: number;
  rowPitch: number;
  slicePitch: number;
  /** Byte offset into the texture's data block. */
  offset: number;
}

/**
 * Where each mip lives inside the contiguous per-texture data block.
 *
 * `DDSIO.GetMipmapImages`: each level's dimensions are the *base* dimensions divided by
 * 2^level, not the previous level halved. For powers of two the two are identical; for
 * anything else they are not, and the file follows the division. A level can reach 0 in
 * one axis, which for an uncompressed format legitimately yields a zero-length mip.
 */
export function computeMipLevels(
  format: DxgiFormat,
  width: number,
  height: number,
  levels: number
): MipLevel[] {
  const out: MipLevel[] = [];
  let div = 1;
  let offset = 0;
  for (let i = 0; i < levels; i++) {
    const w = Math.floor(width / div);
    const h = Math.floor(height / div);
    const { rowPitch, slicePitch } = computePitch(format, w, h);
    out.push({ level: i, width: w, height: h, rowPitch, slicePitch, offset });
    offset += slicePitch;
    div *= 2;
  }
  return out;
}

/**
 * Total bytes the mip chain occupies. `TextureBase.CalcDataSize` (times `Depth`).
 *
 * This is the gen9 data length: gen9 stores no stride, so the size has to be derived.
 */
export function computeDataSize(
  format: DxgiFormat,
  width: number,
  height: number,
  levels: number,
  depth = 1
): number {
  if (format === DxgiFormat.UNKNOWN) return 0;
  let total = 0;
  for (const m of computeMipLevels(format, width, height, levels)) total += m.slicePitch;
  return total * depth;
}

/**
 * The gen8 data length, which is *not* `computeDataSize`.
 *
 * `TextureData.Read` (Texture.cs:1102) uses the stored `Stride`: the base mip is
 * `stride * height` and every further level is a quarter of the previous one. That
 * quartering is exact only for powers of two, but it is what the file was written with,
 * so it is what must be read back.
 */
export function computeLegacyDataSize(stride: number, height: number, levels: number): number {
  let total = 0;
  let length = stride * height;
  for (let i = 0; i < levels; i++) {
    total += length;
    length = Math.floor(length / 4);
  }
  return total;
}
