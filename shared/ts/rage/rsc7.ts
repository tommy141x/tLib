// RSC7 resource container: header, page-size flags, and the raw-deflate body.
//
// Ported from CodeWalker.Core (MIT, dexyfex/Neodymium):
//   RpfFile.cs:712          CreateResourceFileEntry - the 16-byte header
//   RpfFile.cs:2702-2851    RpfResourcePageFlags     - page size from flags
//   ResourceBuilder.cs:674  Decompress               - raw deflate, no zlib wrapper
//
// Scope: loose, unencrypted resource files, which is what a FiveM resource ships in
// its stream/ folder. RPF archive entries are NG-encrypted and deliberately out of
// scope - that path needs keys scanned out of GTA5.exe.

/** Virtual address base for the system (paged struct) segment. */
export const SYSTEM_BASE = 0x50000000;
/** Virtual address base for the graphics (vertex/index/pixel data) segment. */
export const GRAPHICS_BASE = 0x60000000;

const RSC7_MAGIC = 0x37435352; // 'RSC7' little-endian
const HEADER_BYTES = 16;

export interface Rsc7Header {
  /** Container version. Meaning is per file type: .yft 162 gen8 / 171 gen9, .ycd 46. */
  version: number;
  systemFlags: number;
  graphicsFlags: number;
  /** Decoded byte length of the system segment. */
  systemSize: number;
  /** Decoded byte length of the graphics segment. */
  graphicsSize: number;
}

export interface Rsc7Resource {
  header: Rsc7Header;
  system: Uint8Array;
  graphics: Uint8Array;
}

export class Rsc7Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Rsc7Error";
  }
}

/**
 * Decode a page-count bitfield into a byte size.
 *
 * The flags word packs nine page-count fields at descending granularity against a
 * base page size of `0x200 << (flags & 0xF)`. Each field contributes
 * `count * (baseSize << i)`, which the shifts below fold into a single sum.
 */
export function pageSizeFromFlags(flags: number): number {
  const f = flags >>> 0;
  const pages =
    ((f >>> 27) & 0x1) +
    (((f >>> 26) & 0x1) << 1) +
    (((f >>> 25) & 0x1) << 2) +
    (((f >>> 24) & 0x1) << 3) +
    (((f >>> 17) & 0x7f) << 4) +
    (((f >>> 11) & 0x3f) << 5) +
    (((f >>> 7) & 0xf) << 6) +
    (((f >>> 5) & 0x3) << 7) +
    (((f >>> 4) & 0x1) << 8);
  // Deliberately not `<<`: baseSize * pages can exceed 2^31 and `<<` would wrap.
  const baseSize = 0x200 * 2 ** (f & 0xf);
  return baseSize * pages;
}

/** Parse the 16-byte RSC7 header. Does not touch the compressed body. */
export function parseRsc7Header(bytes: Uint8Array): Rsc7Header {
  if (bytes.length < HEADER_BYTES) {
    throw new Rsc7Error(`file is ${bytes.length} bytes, too short for an RSC7 header`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint32(0, true);
  if (magic !== RSC7_MAGIC) {
    const ascii = String.fromCharCode(...bytes.subarray(0, 4)).replace(/[^\x20-\x7e]/g, ".");
    throw new Rsc7Error(
      `not an RSC7 container: magic 0x${magic.toString(16).padStart(8, "0")} ("${ascii}"). ` +
        "Encrypted or non-RSC7 files are not supported."
    );
  }
  const systemFlags = view.getUint32(8, true);
  const graphicsFlags = view.getUint32(12, true);
  return {
    version: view.getInt32(4, true),
    systemFlags,
    graphicsFlags,
    systemSize: pageSizeFromFlags(systemFlags),
    graphicsSize: pageSizeFromFlags(graphicsFlags),
  };
}

/**
 * Raw-inflate that tolerates trailing bytes after the deflate stream.
 *
 * Measured on this corpus: a large minority of real resource files carry a few bytes
 * (commonly exactly 4) after the end of the compressed data. zlib and CodeWalker read
 * them without complaint; `DecompressionStream` throws "Trailing junk found after the
 * end of the compressed stream" — but only AFTER emitting every valid output byte.
 *
 * So the output is collected incrementally and a late error is survivable: it is
 * accepted only once at least `required` bytes have already been produced, which is the
 * full size the page flags declare. A stream that dies early still throws, so genuine
 * corruption is not silently swallowed.
 */
async function inflateRaw(bytes: Uint8Array, required: number): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    throw new Rsc7Error(
      "DecompressionStream is unavailable; a raw-deflate implementation is required"
    );
  }

  // Trailing bytes are common and must be trimmed, not tolerated. When the stream
  // hits junk after a complete deflate member it raises an error AND DISCARDS output
  // still sitting in its internal queue - measured, that silently loses half the file,
  // and draining concurrently only recovers ~91% of it. So the only safe use of this
  // API is to hand it exactly one deflate member.
  //
  // The compressed length is not stored anywhere, but the decompressed length is known
  // exactly (the page flags), and across this corpus every file decompresses to exactly
  // that. So: try the whole body, and on failure walk a few bytes back off the end
  // until the output is exactly `required`. Observed padding is 0 or 4 bytes.
  for (let trim = 0; trim <= MAX_TRAILING_TRIM; trim++) {
    const attempt = await tryInflate(bytes.subarray(0, bytes.length - trim));
    if (attempt !== null && attempt.length === required) return attempt;
  }

  throw new Rsc7Error(
    `raw deflate did not produce the ${required} bytes the page flags declare, ` +
      `even after trimming up to ${MAX_TRAILING_TRIM} trailing bytes`
  );
}

/** Padding observed after the deflate member is 0 or 4 bytes; allow headroom. */
const MAX_TRAILING_TRIM = 16;

/** Inflate exactly, or `null` if the stream errored. Never returns partial output. */
async function tryInflate(bytes: Uint8Array): Promise<Uint8Array | null> {
  const ds = new DecompressionStream("deflate-raw");
  const writer = ds.writable.getWriter();
  void writer.write(bytes as BufferSource).catch(() => {});
  void writer.close().catch(() => {});

  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.length;
      }
    }
  } catch {
    return null;
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/**
 * Parse an RSC7 file and split its decompressed body into the system and graphics
 * segments that virtual pointers resolve against.
 *
 * The body is raw deflate (no zlib header), so `deflate-raw` is required - `deflate`
 * fails on these files.
 */
export async function parseRsc7(bytes: Uint8Array): Promise<Rsc7Resource> {
  const header = parseRsc7Header(bytes);
  const expected = header.systemSize + header.graphicsSize;
  const body = await inflateRaw(bytes.subarray(HEADER_BYTES), expected);

  // inflateRaw already guarantees this, but the invariant is worth stating where the
  // segments are cut: a short body would hand out views that produce nonsense offsets
  // somewhere far away from here.
  if (body.length < expected) {
    throw new Rsc7Error(
      `decompressed body is ${body.length} bytes but the page flags declare ${expected} ` +
        `(system ${header.systemSize} + graphics ${header.graphicsSize})`
    );
  }

  return {
    header,
    system: body.subarray(0, header.systemSize),
    graphics: body.subarray(header.systemSize, expected),
  };
}
