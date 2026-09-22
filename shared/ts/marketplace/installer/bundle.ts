// Archive validation and bounded extraction. Read-only and shared: install and
// legacy verification must agree byte for byte on what a bundle contains.

import { inflateRawSync } from "node:zlib";
import AdmZip from "adm-zip";
import { type Context, hash, type InstallTarget, MAX_ENTRIES, safeName } from "./core";

export function zipEntryCount(buf: Buffer): number {
  // Bound entry allocation before AdmZip parses the central directory. ZIP64
  // and split archives are unnecessary at the 5 MB ceiling and fail closed.
  for (let end = buf.length - 22; end >= Math.max(0, buf.length - 65557); end--) {
    if (
      buf.readUInt32LE(end) !== 0x06054b50 ||
      end + 22 + buf.readUInt16LE(end + 20) !== buf.length
    )
      continue;
    const count = buf.readUInt16LE(end + 10);
    if (
      buf.readUInt16LE(end + 4) ||
      buf.readUInt16LE(end + 6) ||
      buf.readUInt16LE(end + 8) !== count ||
      !count ||
      count > MAX_ENTRIES ||
      buf.readUInt32LE(end + 12) + buf.readUInt32LE(end + 16) !== end
    )
      throw new Error("invalid zip directory or entry count");
    return count;
  }
  throw new Error("missing zip directory");
}

function soundExtension(buf: Buffer): string {
  if (
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WAVE"
  )
    return ".wav";
  if (buf.length >= 4 && buf.toString("ascii", 0, 4) === "OggS") return ".ogg";
  if (buf.length >= 3 && buf.toString("ascii", 0, 3) === "ID3") return ".mp3";
  if (
    buf.length >= 4 &&
    buf[0] === 0xff &&
    (buf[1] & 0xe0) === 0xe0 &&
    (buf[1] & 0x18) !== 0x08 &&
    (buf[1] & 0x06) !== 0 &&
    (buf[2] & 0xf0) !== 0xf0 &&
    (buf[2] & 0xf0) !== 0 &&
    (buf[2] & 0x0c) !== 0x0c
  )
    return ".mp3";
  throw new Error("unknown sound format");
}

// Shared preparation is read-only: install and legacy verification must use the
// very same archive validation, bounded extraction and HTML transformation.
export function prepareBundle(
  target: InstallTarget,
  c: Context,
  zipBytes: Buffer,
  expectedHash: string,
  expectedSize: number
) {
  const { type } = target;
  const max = target.maxBundleBytes;
  if (!Number.isSafeInteger(max) || max <= 0) throw new Error("invalid bundle limit");
  if (!Buffer.isBuffer(zipBytes) || !zipBytes.length || zipBytes.length > max)
    throw new Error("bundle exceeds max size or is empty");
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0)
    throw new Error("invalid expected size");
  if (expectedSize > 0 && zipBytes.length !== expectedSize) throw new Error("size mismatch");
  if (
    typeof expectedHash !== "string" ||
    (expectedHash !== "" && !/^(?:sha256:)?[a-f0-9]{64}$/i.test(expectedHash))
  )
    throw new Error("malformed sha256 hash");
  if (expectedHash && hash(zipBytes) !== expectedHash.toLowerCase().replace(/^sha256:/, ""))
    throw new Error("hash mismatch — bundle corrupted or tampered");
  const zip = zipBytes.length >= 4 && zipBytes.readUInt32LE(0) === 0x04034b50;
  let destination = c.name;
  let entries: ReturnType<AdmZip["getEntries"]> = [];
  if (!zip) {
    if (type !== "sound" && type !== "tone")
      throw new Error("raw bundles are only supported for sound/tone types");
    destination += soundExtension(zipBytes);
  } else {
    const count = zipEntryCount(zipBytes);
    entries = new AdmZip(zipBytes).getEntries();
    if (entries.length !== count) throw new Error("invalid zip entry count");
    let declared = 0;
    const names = new Map<string, boolean>();
    const spellings = new Map<string, string>();
    for (const entry of entries) {
      const name = entry.isDirectory ? entry.entryName.replace(/\/$/, "") : entry.entryName;
      if (!safeName(name)) throw new Error(`unsafe zip entry: ${entry.entryName}`);
      const segments = name.split("/");
      for (let i = 1; i <= segments.length; i++) {
        const prefix = segments.slice(0, i).join("/");
        const previous = spellings.get(prefix.toLowerCase());
        if (previous && previous !== prefix) throw new Error("case-aliased zip path");
        spellings.set(prefix.toLowerCase(), prefix);
      }
      const key = name.toLowerCase();
      if (names.has(key)) throw new Error("duplicate/aliased zip entry");
      names.set(key, entry.isDirectory);
      const mode = (entry.attr >>> 16) & 0xf000;
      if (mode && mode !== (entry.isDirectory ? 0x4000 : 0x8000))
        throw new Error("unsupported zip entry type");
      const size = entry.header.size;
      const compressed = entry.header.compressedSize;
      if (
        !Number.isSafeInteger(size) ||
        size < 0 ||
        !Number.isSafeInteger(compressed) ||
        compressed < 0 ||
        compressed > zipBytes.length ||
        (entry.isDirectory && size !== 0)
      )
        throw new Error("invalid zip declared size");
      declared += size;
      if (declared > max) throw new Error("declared uncompressed bundle exceeds max size");
    }
    for (const name of names.keys()) {
      const parts = name.split("/");
      while (parts.length > 1) {
        parts.pop();
        if (names.get(parts.join("/")) === false) throw new Error("zip file/directory conflict");
      }
    }
    if (entries.every((entry) => entry.isDirectory)) throw new Error("bundle has no files");
  }
  const files = new Map<string, Buffer>();
  let bytesWritten = 0;
  if (!zip) {
    files.set("", zipBytes);
    bytesWritten = zipBytes.length;
  } else {
    for (const entry of entries) {
      if (entry.isDirectory) continue;
      // AdmZip pads/truncates to declared size, and zero disables its inflater
      // bound. Check the real stream with an explicit bound before its CRC check.
      // ZIP general-purpose bit 0; avoids the encrypted/encripted typing mismatch.
      if ((entry.header.flags & 1) !== 0) throw new Error("encrypted zip entries are unsupported");
      const compressed = entry.getCompressedData();
      if (compressed.length !== entry.header.compressedSize)
        throw new Error("compressed size mismatch");
      let data: Buffer;
      if (entry.header.method === 0) data = compressed;
      else if (entry.header.method === 8)
        data = inflateRawSync(compressed, { maxOutputLength: Math.max(1, entry.header.size) });
      else throw new Error("unsupported zip compression method");
      bytesWritten += data.length;
      if (data.length !== entry.header.size || bytesWritten > max)
        throw new Error("actual uncompressed size mismatch or exceeds max size");
      entry.getData(); // CRC/local-header validation after bounded, exact-size inflation.
      if (entry.entryName === "ui.html") {
        const originalSize = data.length;
        data = Buffer.from(
          data.toString("utf8").replace(/\n?<!-- studio-design:[A-Za-z0-9+/=\s]*-->/g, "")
        );
        bytesWritten += data.length - originalSize;
        if (bytesWritten > max) throw new Error("processed bundle exceeds max size");
      }
      files.set(entry.entryName, data);
    }
  }
  return { destination, zip, files, bytesWritten };
}
