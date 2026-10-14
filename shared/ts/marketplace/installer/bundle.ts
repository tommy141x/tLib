// Archive validation and bounded extraction. Read-only and shared: install and
// legacy verification must agree byte for byte on what a bundle contains.

import * as path from "node:path";
import { inflateRawSync } from "node:zlib";
import AdmZip from "adm-zip";
import { MODULE_MANIFEST, type ModuleManifest, parseModuleManifest } from "../../modules/manifest";
import { type Context, hash, type InstallTarget, MAX_ENTRIES, safeName } from "./core";

/**
 * What the catalogue knows about the item being installed, for the `module.json`
 * a raw audio bundle has to be given.
 *
 * Optional because a caller that cannot supply it must still be able to install:
 * the alternative is refusing every sound item in the catalogue until each is
 * re-published, and the round trip has to keep working.
 */
export interface ItemMetadata {
  name?: string;
  version?: string;
}

/**
 * The version written when the caller did not supply one.
 *
 * Not a guess dressed up as a fact. `0.0.0` reads as "nobody told us", which is
 * the truth for a raw audio item: the marketplace ships the bytes and keeps the
 * version in its own database, so there is nothing in the bundle to read. A
 * sound published as a ZIP carries its own `module.json` and never reaches this.
 */
export const UNKNOWN_ITEM_VERSION = "0.0.0";

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
  expectedSize: number,
  item?: ItemMetadata
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
  const sound = type === "sound" || type === "tone";
  /** The sound module's manifest, generated or read from the bundle. */
  let manifest: ModuleManifest | undefined;

  // A sound installs as a FLAT FILE; everything else as a module directory
  //
  // `layouts/sounds/airhorn.wav`, not `layouts/sounds/airhorn/airhorn.wav`.
  //
  // That is not a leftover from before modules existed — it is the shape, chosen
  // so that an operator can drag a `.wav` into `layouts/sounds/` and have it
  // work. No folder to create, no `module.json` to author, nothing to get wrong.
  // A sound is still a MODULE in the studio and in the marketplace, with a folder
  // and a manifest carrying its name, author, licence, duration and waveform
  // peaks; this is the boundary where that becomes a plain file.
  //
  // `directory` is returned rather than inferred, and nothing may go back to
  // branching on `zip` for it: a zipped sound module is an archive AND installs
  // flat, which is precisely the case a `zip` test gets wrong.
  const directory = !sound;
  let audioName: string | null = null;
  let entries: ReturnType<AdmZip["getEntries"]> = [];
  if (!zip) {
    if (!sound) throw new Error("raw bundles are only supported for sound/tone types");
    // The marketplace ships most sounds as the audio file itself, with the name,
    // licence and peaks in its own database. Nothing to unpack: the format comes
    // from the magic bytes and the bytes are the payload.
    audioName = c.name + soundExtension(zipBytes);
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
  if (audioName) {
    // The flat-destination convention: ONE entry under the empty-string key, so
    // the destination IS the file rather than a directory containing it. The
    // manifest a validator wants rides on `manifest` instead, because there is
    // nowhere on disk for it to go.
    files.set("", zipBytes);
    manifest = {
      schema: 1,
      kind: "sound",
      id: c.name,
      name: item?.name?.trim() || c.name,
      version: item?.version?.trim() || UNKNOWN_ITEM_VERSION,
      slug: c.name,
      sound: { file: audioName },
    };
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
  // A zipped SOUND module is reduced to its audio, here
  //
  // tWeb exports a sound as a folder: `module.json`, the audio, and possibly
  // artwork or an alternate encoding. On a FiveM resource only the audio exists,
  // so the manifest is read, parsed and kept in memory for the validator, the
  // declared audio becomes the flat payload, and ANYTHING ELSE IN THE BUNDLE IS
  // DROPPED. That last part is said out loud rather than discovered: a publisher
  // who ships a cover image will not find it on disk, and the alternative —
  // refusing the bundle — would reject a module that is perfectly valid in the
  // studio.
  if (sound && zip) {
    const manifestBytes = files.get(MODULE_MANIFEST);
    if (!manifestBytes) throw new Error(`zipped sound "${c.name}" has no ${MODULE_MANIFEST}`);
    let decoded: unknown;
    try {
      decoded = JSON.parse(manifestBytes.toString("utf8"));
    } catch (err) {
      throw new Error(
        `zipped sound "${c.name}" has a malformed ${MODULE_MANIFEST}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
    // Parsed against the slug AND the kind, so a manifest for a different item,
    // or a layout manifest in a sound bundle, is refused before anything is
    // staged. The `id === audio stem` rule is enforced in here too, which is what
    // makes `<slug>.<ext>` below the same filename the module declared.
    manifest = parseModuleManifest(decoded, c.name, "sound");
    audioName = manifest.sound?.file ?? null;
    if (!audioName) throw new Error(`zipped sound "${c.name}" declares no audio file`);
    const audio = files.get(audioName);
    if (!audio)
      throw new Error(
        `zipped sound "${c.name}" declares "${audioName}" but the bundle does not contain it`
      );
    files.clear();
    files.set("", audio);
    bytesWritten = audio.length;
  }

  // `zip` says whether the publisher shipped an archive or a bare file, which is
  // a fact about the ITEM that a ContentValidator may legitimately care about.
  // `directory` says whether the DESTINATION is a folder. They are not the same
  // question and a zipped sound module is exactly where they differ.
  const destination = directory ? c.name : c.name + path.extname(audioName ?? "");
  return { destination, directory, zip, files, bytesWritten, manifest };
}
