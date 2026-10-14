import { describe, expect, test } from "bun:test";
import { computeMipLevels, DxgiFormat, TextureFormat, TextureFormatG9 } from "./formats";
import {
  canUploadCompressed,
  detectCompressionSupport,
  type GlCompressionSupport,
  uploadTexture,
} from "./upload";
import { type Texture, TextureDimension, TextureTileMode, TextureUsage } from "./ytd";

/**
 * A WebGL2 stand-in that records the calls the upload path makes.
 *
 * A real context is not available here (CEF 103 and bun both lack one headlessly), and
 * the thing worth testing is the *decision* - compressed versus decoded - not the driver.
 * `scripts/verify-bc7.ts` covers the real GPU.
 */
function fakeGl(available: string[]) {
  const calls = {
    compressed: [] as {
      level: number;
      internalFormat: number;
      width: number;
      height: number;
      bytes: number;
    }[],
    plain: [] as { level: number; width: number; height: number; bytes: number }[],
    params: [] as [number, number][],
    deleted: 0,
  };
  const gl = {
    TEXTURE_2D: 0x0de1,
    RGBA: 0x1908,
    UNSIGNED_BYTE: 0x1401,
    LINEAR: 0x2601,
    LINEAR_MIPMAP_LINEAR: 0x2703,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_MAX_LEVEL: 0x813d,
    getExtension: (name: string) => (available.includes(name) ? {} : null),
    createTexture: () => ({}) as WebGLTexture,
    deleteTexture: () => {
      calls.deleted++;
    },
    bindTexture: () => {},
    texParameteri: (_t: number, p: number, v: number) => calls.params.push([p, v]),
    compressedTexImage2D: (
      _t: number,
      level: number,
      internalFormat: number,
      width: number,
      height: number,
      _border: number,
      bytes: Uint8Array
    ) => calls.compressed.push({ level, internalFormat, width, height, bytes: bytes.length }),
    texImage2D: (
      _t: number,
      level: number,
      _if: number,
      width: number,
      height: number,
      _b: number,
      _f: number,
      _ty: number,
      bytes: Uint8Array
    ) => calls.plain.push({ level, width, height, bytes: bytes.length }),
  };
  return { gl: gl as unknown as WebGL2RenderingContext, calls };
}

const ALL = [
  "WEBGL_compressed_texture_s3tc",
  "WEBGL_compressed_texture_s3tc_srgb",
  "EXT_texture_compression_rgtc",
  "EXT_texture_compression_bptc",
];

function texture(dxgi: DxgiFormat, width = 16, height = 16, levels = 3): Texture {
  const mips = computeMipLevels(dxgi, width, height, levels);
  const total = mips.reduce((n, m) => n + m.slicePitch, 0);
  return {
    name: "t",
    nameHash: 0,
    width,
    height,
    depth: 1,
    levels,
    stride: mips[0].rowPitch,
    format: TextureFormat.D3DFMT_DXT5,
    formatG9: TextureFormatG9.BC3_UNORM,
    dxgi,
    usage: TextureUsage.DIFFUSE,
    usageFlags: 0,
    dimension: TextureDimension.Texture2D,
    tileMode: TextureTileMode.Auto,
    mips,
    data: new Uint8Array(total),
  };
}

const SUPPORT_ALL: GlCompressionSupport = { s3tc: true, s3tcSrgb: true, rgtc: true, bptc: true };
const SUPPORT_NONE: GlCompressionSupport = {
  s3tc: false,
  s3tcSrgb: false,
  rgtc: false,
  bptc: false,
};

describe("detectCompressionSupport", () => {
  test("reports each family independently", () => {
    const { gl } = fakeGl(["WEBGL_compressed_texture_s3tc", "EXT_texture_compression_bptc"]);
    expect(detectCompressionSupport(gl)).toEqual({
      s3tc: true,
      s3tcSrgb: false,
      rgtc: false,
      bptc: true,
    });
  });
});

describe("uploadTexture", () => {
  test("takes the compressed path and uploads every stored mip", () => {
    const { gl, calls } = fakeGl(ALL);
    const tex = texture(DxgiFormat.BC3_UNORM);
    const r = uploadTexture(gl, tex, { support: SUPPORT_ALL });
    expect(r.path).toBe("compressed");
    expect(r.levels).toBe(3);
    expect(calls.compressed.map((c) => [c.width, c.height])).toEqual([
      [16, 16],
      [8, 8],
      [4, 4],
    ]);
    // COMPRESSED_RGBA_S3TC_DXT5_EXT
    expect(calls.compressed[0].internalFormat).toBe(0x83f3);
    expect(calls.plain).toHaveLength(0);
  });

  test("BC1 uploads through the RGBA enum, never the RGB one", () => {
    const { gl, calls } = fakeGl(ALL);
    uploadTexture(gl, texture(DxgiFormat.BC1_UNORM), { support: SUPPORT_ALL });
    // COMPRESSED_RGBA_S3TC_DXT1_EXT: a BC1 block signals its own 1-bit alpha mode and
    // the RGB-only enum would throw that away.
    expect(calls.compressed[0].internalFormat).toBe(0x83f1);
  });

  test("BC7 is the whole reason the compressed path exists", () => {
    const { gl, calls } = fakeGl(ALL);
    const r = uploadTexture(gl, texture(DxgiFormat.BC7_UNORM), { support: SUPPORT_ALL });
    expect(r.path).toBe("compressed");
    expect(calls.compressed[0].internalFormat).toBe(0x8e8c); // RGBA_BPTC_UNORM
  });

  test("sRGB variants pick the sRGB internal format", () => {
    const { gl, calls } = fakeGl(ALL);
    uploadTexture(gl, texture(DxgiFormat.BC7_UNORM_SRGB), { support: SUPPORT_ALL });
    expect(calls.compressed[0].internalFormat).toBe(0x8e8d); // SRGB_ALPHA_BPTC_UNORM
  });

  test("a missing extension falls back to decoding, and says which one", () => {
    const { gl, calls } = fakeGl([]);
    const r = uploadTexture(gl, texture(DxgiFormat.BC7_UNORM), { support: SUPPORT_NONE });
    expect(r.path).toBe("decoded");
    expect(r.fallbackReason).toContain("bptc");
    expect(calls.compressed).toHaveLength(0);
    expect(calls.plain.map((c) => c.bytes)).toEqual([16 * 16 * 4, 8 * 8 * 4, 4 * 4 * 4]);
  });

  test("an uncompressed format always takes the CPU path", () => {
    const { gl } = fakeGl(ALL);
    const r = uploadTexture(gl, texture(DxgiFormat.B8G8R8A8_UNORM), { support: SUPPORT_ALL });
    expect(r.path).toBe("decoded");
    expect(r.fallbackReason).toContain("no compressed GL equivalent");
  });

  test("forceDecode proves the two paths can be compared on the same data", () => {
    const { gl } = fakeGl(ALL);
    const r = uploadTexture(gl, texture(DxgiFormat.BC3_UNORM), {
      support: SUPPORT_ALL,
      forceDecode: true,
    });
    expect(r.path).toBe("decoded");
    expect(r.fallbackReason).toBe("forceDecode");
  });

  test("mipmaps: false uploads only the base level", () => {
    const { gl, calls } = fakeGl(ALL);
    const r = uploadTexture(gl, texture(DxgiFormat.BC3_UNORM), {
      support: SUPPORT_ALL,
      mipmaps: false,
    });
    expect(r.levels).toBe(1);
    expect(calls.compressed).toHaveLength(1);
  });

  test("a truncated data block stops at the last complete mip", () => {
    const { gl, calls } = fakeGl(ALL);
    const tex = texture(DxgiFormat.BC3_UNORM);
    tex.data = tex.data.subarray(0, tex.mips[1].offset + 1);
    uploadTexture(gl, tex, { support: SUPPORT_ALL });
    expect(calls.compressed).toHaveLength(1);
  });

  test("a format with neither a GL mapping nor a decoder throws and frees the texture", () => {
    const { gl, calls } = fakeGl(ALL);
    const tex = texture(DxgiFormat.BC6H_UF16);
    expect(() => uploadTexture(gl, tex, { support: SUPPORT_ALL })).toThrow(/BC6H_UF16/);
    expect(calls.deleted).toBe(1);
  });

  test("TEXTURE_MAX_LEVEL is set so a partial chain is not sampled past its end", () => {
    const { gl, calls } = fakeGl(ALL);
    uploadTexture(gl, texture(DxgiFormat.BC3_UNORM), { support: SUPPORT_ALL });
    expect(calls.params).toContainEqual([0x813d, 2]);
  });
});

describe("canUploadCompressed", () => {
  test("is true only for a compressed format whose extension is present", () => {
    expect(canUploadCompressed(DxgiFormat.BC7_UNORM, SUPPORT_ALL)).toBe(true);
    expect(canUploadCompressed(DxgiFormat.BC7_UNORM, { ...SUPPORT_ALL, bptc: false })).toBe(false);
    expect(canUploadCompressed(DxgiFormat.BC5_UNORM, { ...SUPPORT_ALL, rgtc: false })).toBe(false);
    expect(canUploadCompressed(DxgiFormat.B8G8R8A8_UNORM, SUPPORT_ALL)).toBe(false);
  });
});
