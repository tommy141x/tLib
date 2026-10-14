// WebGL upload: hand the compressed blocks to the GPU when it can take them, decode on
// the CPU when it cannot.
//
// This is the only module in `rage/ytd` that mentions WebGL. `decode.ts` stays pure so
// it can be posted to a worker; keep it that way by never importing this from there.
//
// Why both paths exist: the fast path is a straight `compressedTexImage2D` of the file's
// own bytes, which costs nothing and is the only practical answer for BC7 (there is no
// BC7 software decoder in CodeWalker, and a JS one is ~20x the cost of a memcpy). But
// extension support is not uniform - `EXT_texture_compression_bptc` in particular is
// absent on plenty of integrated GPUs and on some driver/browser combinations - so the
// CPU fallback is not optional.
//
// The target here is CEF 103 (Chromium 103) inside FiveM's NUI: WebGL2 and WASM are
// present, but every extension below must still be queried at runtime, never assumed.

import { decoderFor } from "./decode";
import { DxgiFormat, isCompressedFormat } from "./formats";
import { mipBytes, type Texture } from "./ytd";

/** The `WEBGL_compressed_texture_s3tc` / RGTC / BPTC enum values, by name. */
const GL_COMPRESSED = {
  RGB_S3TC_DXT1: 0x83f0,
  RGBA_S3TC_DXT1: 0x83f1,
  RGBA_S3TC_DXT3: 0x83f2,
  RGBA_S3TC_DXT5: 0x83f3,
  SRGB_S3TC_DXT1: 0x8c4c,
  SRGB_ALPHA_S3TC_DXT1: 0x8c4d,
  SRGB_ALPHA_S3TC_DXT3: 0x8c4e,
  SRGB_ALPHA_S3TC_DXT5: 0x8c4f,
  RED_RGTC1: 0x8dbb,
  SIGNED_RED_RGTC1: 0x8dbc,
  RED_GREEN_RGTC2: 0x8dbd,
  SIGNED_RED_GREEN_RGTC2: 0x8dbe,
  RGBA_BPTC_UNORM: 0x8e8c,
  SRGB_ALPHA_BPTC_UNORM: 0x8e8d,
} as const;

/** Which extension a compressed DXGI format needs, and the GL internal format it maps to. */
interface CompressedTarget {
  extension: "s3tc" | "s3tc_srgb" | "rgtc" | "bptc";
  internalFormat: number;
}

function compressedTargetFor(format: DxgiFormat): CompressedTarget | null {
  switch (format) {
    case DxgiFormat.BC1_UNORM:
    case DxgiFormat.BC1_TYPELESS:
      // DXT1 with alpha, always: a BC1 block signals its own 1-bit alpha mode and the
      // RGB-only enum would discard it.
      return { extension: "s3tc", internalFormat: GL_COMPRESSED.RGBA_S3TC_DXT1 };
    case DxgiFormat.BC1_UNORM_SRGB:
      return { extension: "s3tc_srgb", internalFormat: GL_COMPRESSED.SRGB_ALPHA_S3TC_DXT1 };
    case DxgiFormat.BC2_UNORM:
    case DxgiFormat.BC2_TYPELESS:
      return { extension: "s3tc", internalFormat: GL_COMPRESSED.RGBA_S3TC_DXT3 };
    case DxgiFormat.BC2_UNORM_SRGB:
      return { extension: "s3tc_srgb", internalFormat: GL_COMPRESSED.SRGB_ALPHA_S3TC_DXT3 };
    case DxgiFormat.BC3_UNORM:
    case DxgiFormat.BC3_TYPELESS:
      return { extension: "s3tc", internalFormat: GL_COMPRESSED.RGBA_S3TC_DXT5 };
    case DxgiFormat.BC3_UNORM_SRGB:
      return { extension: "s3tc_srgb", internalFormat: GL_COMPRESSED.SRGB_ALPHA_S3TC_DXT5 };
    case DxgiFormat.BC4_UNORM:
    case DxgiFormat.BC4_TYPELESS:
      return { extension: "rgtc", internalFormat: GL_COMPRESSED.RED_RGTC1 };
    case DxgiFormat.BC4_SNORM:
      return { extension: "rgtc", internalFormat: GL_COMPRESSED.SIGNED_RED_RGTC1 };
    case DxgiFormat.BC5_UNORM:
    case DxgiFormat.BC5_TYPELESS:
      return { extension: "rgtc", internalFormat: GL_COMPRESSED.RED_GREEN_RGTC2 };
    case DxgiFormat.BC5_SNORM:
      return { extension: "rgtc", internalFormat: GL_COMPRESSED.SIGNED_RED_GREEN_RGTC2 };
    case DxgiFormat.BC7_UNORM:
    case DxgiFormat.BC7_TYPELESS:
      return { extension: "bptc", internalFormat: GL_COMPRESSED.RGBA_BPTC_UNORM };
    case DxgiFormat.BC7_UNORM_SRGB:
      return { extension: "bptc", internalFormat: GL_COMPRESSED.SRGB_ALPHA_BPTC_UNORM };
    default:
      return null;
  }
}

/** Which compressed families this context actually has. Query once, reuse. */
export interface GlCompressionSupport {
  s3tc: boolean;
  s3tcSrgb: boolean;
  rgtc: boolean;
  bptc: boolean;
}

type GL = WebGLRenderingContext | WebGL2RenderingContext;

/**
 * Probe the context for the compressed-texture extensions.
 *
 * `getExtension` must actually be called, not just looked for in
 * `getSupportedExtensions` - on some drivers the extension is advertised and then fails
 * to instantiate. Calling it also enables it, which is required before use.
 */
export function detectCompressionSupport(gl: GL): GlCompressionSupport {
  const has = (name: string) => gl.getExtension(name) !== null;
  return {
    s3tc: has("WEBGL_compressed_texture_s3tc"),
    s3tcSrgb: has("WEBGL_compressed_texture_s3tc_srgb"),
    rgtc: has("EXT_texture_compression_rgtc"),
    bptc: has("EXT_texture_compression_bptc"),
  };
}

function supports(
  support: GlCompressionSupport,
  extension: CompressedTarget["extension"]
): boolean {
  switch (extension) {
    case "s3tc":
      return support.s3tc;
    case "s3tc_srgb":
      return support.s3tcSrgb;
    case "rgtc":
      return support.rgtc;
    case "bptc":
      return support.bptc;
  }
}

/** How a texture was uploaded, so callers can log or count the fallbacks. */
export interface UploadResult {
  texture: WebGLTexture;
  /** `"compressed"` means the file's own bytes went to the GPU untouched. */
  path: "compressed" | "decoded";
  /** Mip levels actually uploaded. */
  levels: number;
  /** Set when the CPU path was taken and why. */
  fallbackReason?: string;
}

export interface UploadOptions {
  /** Result of `detectCompressionSupport`. Probed on demand if omitted. */
  support?: GlCompressionSupport;
  /** Upload the whole mip chain rather than just the base level. Default true. */
  mipmaps?: boolean;
  /** Force the CPU path - useful for proving the two agree. Default false. */
  forceDecode?: boolean;
}

/**
 * Upload a parsed `.ytd` texture, choosing the compressed path when the GPU has it.
 *
 * The compressed path uploads every stored mip and sets `TEXTURE_MAX_LEVEL`; it never
 * calls `generateMipmap`, which is illegal on a compressed texture anyway.
 *
 * Throws only for a format with neither a GL mapping nor a CPU decoder. A missing
 * extension is not an error - it is the fallback's whole purpose.
 */
export function uploadTexture(gl: GL, texture: Texture, options: UploadOptions = {}): UploadResult {
  const support = options.support ?? detectCompressionSupport(gl);
  const wantMips = options.mipmaps !== false;
  const levels = wantMips ? Math.max(1, texture.mips.length) : 1;

  const handle = gl.createTexture();
  if (!handle) throw new Error("gl.createTexture() returned null (context lost?)");
  gl.bindTexture(gl.TEXTURE_2D, handle);

  const target = compressedTargetFor(texture.dxgi);
  const canCompress =
    !options.forceDecode && target !== null && supports(support, target.extension);

  if (canCompress && target) {
    for (let i = 0; i < levels; i++) {
      const mip = texture.mips[i];
      const bytes = mipBytes(texture, i);
      if (bytes.length < mip.slicePitch) break; // truncated data block; stop here
      gl.compressedTexImage2D(
        gl.TEXTURE_2D,
        i,
        target.internalFormat,
        Math.max(1, mip.width),
        Math.max(1, mip.height),
        0,
        bytes
      );
    }
    if ("TEXTURE_MAX_LEVEL" in gl) {
      (gl as WebGL2RenderingContext).texParameteri(
        gl.TEXTURE_2D,
        (gl as WebGL2RenderingContext).TEXTURE_MAX_LEVEL,
        levels - 1
      );
    }
    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_MIN_FILTER,
      levels > 1 ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return { texture: handle, path: "compressed", levels };
  }

  if (!decoderFor(texture.dxgi)) {
    gl.deleteTexture(handle);
    throw new Error(
      `texture "${texture.name}": DXGI format ${DxgiFormat[texture.dxgi] ?? texture.dxgi} has ` +
        "neither a WebGL compressed format nor a CPU decoder"
    );
  }

  const reason = options.forceDecode
    ? "forceDecode"
    : target
      ? `${target.extension} extension unavailable`
      : "format has no compressed GL equivalent";

  let uploaded = 0;
  for (let i = 0; i < levels; i++) {
    const mip = texture.mips[i];
    if (mip.width < 1 || mip.height < 1) break;
    const bytes = mipBytes(texture, i);
    if (bytes.length < mip.slicePitch) break;
    const rgba = decodeToRgbaChecked(texture.dxgi, bytes, mip.width, mip.height);
    gl.texImage2D(
      gl.TEXTURE_2D,
      i,
      gl.RGBA,
      mip.width,
      mip.height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      rgba
    );
    uploaded++;
  }
  if ("TEXTURE_MAX_LEVEL" in gl) {
    (gl as WebGL2RenderingContext).texParameteri(
      gl.TEXTURE_2D,
      (gl as WebGL2RenderingContext).TEXTURE_MAX_LEVEL,
      Math.max(0, uploaded - 1)
    );
  }
  gl.texParameteri(
    gl.TEXTURE_2D,
    gl.TEXTURE_MIN_FILTER,
    uploaded > 1 ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  return { texture: handle, path: "decoded", levels: uploaded, fallbackReason: reason };
}

function decodeToRgbaChecked(
  format: DxgiFormat,
  bytes: Uint8Array,
  width: number,
  height: number
): Uint8Array {
  const decode = decoderFor(format);
  if (!decode) throw new Error(`no decoder for ${DxgiFormat[format] ?? format}`);
  return decode(bytes, width, height);
}

/**
 * Whether the GPU could take this texture's own bytes.
 *
 * Useful for reporting how much of a dictionary will take the fast path before uploading
 * any of it - the answer is a property of the format and the context, not of the data.
 */
export function canUploadCompressed(format: DxgiFormat, support: GlCompressionSupport): boolean {
  if (!isCompressedFormat(format)) return false;
  const target = compressedTargetFor(format);
  return target !== null && supports(support, target.extension);
}
