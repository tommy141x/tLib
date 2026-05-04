// Atomic install pipeline: download → verify → extract → write → swap.
// Writes land in resources/<consumer>/<installPath>/<slug>/. A staging
// directory alongside is populated first; once every file is written and
// the hash matches, the old install (if any) is replaced in one rename.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import AdmZip from "adm-zip";
import { resolveConfig } from "./config";
import { fGetResourcePath } from "./fivem";
import { get as getTarget } from "./registry";

export interface InstallResult {
  ok: true;
  installedAt: string; // absolute path of the final install directory
  fileCount: number;
  bytesWritten: number;
}

export interface InstallFailure {
  ok: false;
  error: string;
}

export type InstallOutcome = InstallResult | InstallFailure;

export interface UninstallResult {
  ok: true;
}

export type UninstallOutcome = UninstallResult | InstallFailure;

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isZipBuffer(buf: Buffer): boolean {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4B && buf[2] === 0x03 && buf[3] === 0x04;
}

function guessExtFromMagic(buf: Buffer): string {
  // RIFF → WAV
  if (buf.length >= 4 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return ".wav";
  // OggS → OGG
  if (buf.length >= 4 && buf[0] === 0x4F && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53) return ".ogg";
  // ID3 → MP3
  if (buf.length >= 3 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return ".mp3";
  // MPEG sync → MP3
  if (buf.length >= 2 && buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0) return ".mp3";
  return ".wav";
}

/** Rejects absolute paths, traversal, and drive letters. Zip entries must stay relative. */
function isSafeEntryName(name: string): boolean {
  if (!name || typeof name !== "string") return false;
  const normalized = name.replace(/\\/g, "/");
  if (normalized.startsWith("/")) return false;
  if (/^[a-z]:/i.test(normalized)) return false;
  for (const seg of normalized.split("/")) {
    if (seg === "..") return false;
  }
  return true;
}

function rmDirSafe(p: string): void {
  if (!fs.existsSync(p)) return;
  fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
}

export function uninstallItem(resourceName: string, type: string, slug: string): UninstallOutcome {
  if (!resourceName || !type || !slug) {
    return { ok: false, error: "resourceName, type, and slug are required" };
  }

  const target = getTarget(resourceName, type);
  if (!target) {
    return { ok: false, error: `no install target registered for type "${type}"` };
  }

  const resourceRoot = fGetResourcePath(target.resourceName);
  if (!resourceRoot) {
    return { ok: false, error: `resource "${target.resourceName}" has no resolvable path` };
  }

  const safeSlug = slug.toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (!safeSlug || safeSlug !== slug.toLowerCase()) {
    return { ok: false, error: `slug "${slug}" contains invalid characters` };
  }

  const baseDir = path.resolve(resourceRoot, target.installPath);
  const finalDir = path.join(baseDir, safeSlug);

  // Must be a descendant of baseDir.
  const rel = path.relative(baseDir, finalDir);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return { ok: false, error: "uninstall path resolution escaped resource root" };
  }

  // Directory install (ZIP extract)
  if (fs.existsSync(finalDir) && fs.statSync(finalDir).isDirectory()) {
    try {
      rmDirSafe(finalDir);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // Flat file install (raw download — e.g. .wav, .ogg, .mp3)
  for (const ext of [".wav", ".ogg", ".mp3"]) {
    const filePath = finalDir + ext;
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  }

  return { ok: false, error: `"${slug}" is not installed` };
}

// Lua downloads the zip via PerformHttpRequest and passes the bytes here.
// expectedHash may be empty (skips verification). expectedSize 0 also skips.
export function installFromData(
  resourceName: string,
  type: string,
  slug: string,
  zipBytes: Buffer,
  expectedHash: string,
  expectedSize: number
): InstallOutcome {
  if (!resourceName || !type || !slug) {
    return { ok: false, error: "resourceName, type, and slug are required" };
  }

  const target = getTarget(resourceName, type);
  if (!target) {
    return { ok: false, error: `no install target registered for type "${type}"` };
  }

  const resourceRoot = fGetResourcePath(target.resourceName);
  if (!resourceRoot) {
    return { ok: false, error: `resource "${target.resourceName}" has no resolvable path` };
  }

  const safeSlug = slug.toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (!safeSlug || safeSlug !== slug.toLowerCase()) {
    return { ok: false, error: `slug "${slug}" contains invalid characters` };
  }

  const baseDir = path.resolve(resourceRoot, target.installPath);
  const finalDir = path.join(baseDir, safeSlug);
  const stageDir = path.join(baseDir, `.install-${safeSlug}-${Date.now()}`);

  const rel = path.relative(baseDir, finalDir);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return { ok: false, error: "install path resolution escaped resource root" };
  }

  try {
    if (expectedSize > 0 && zipBytes.byteLength !== expectedSize) {
      return { ok: false, error: `size mismatch (got ${zipBytes.byteLength}, expected ${expectedSize})` };
    }

    if (expectedHash) {
      const cleanHash = expectedHash.toLowerCase().replace(/^sha256:/, "");
      if (/^[0-9a-f]{64}$/.test(cleanHash)) {
        const actualHash = sha256Hex(new Uint8Array(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength));
        if (actualHash !== cleanHash) {
          return { ok: false, error: "hash mismatch — bundle corrupted or tampered" };
        }
      }
    }

    // Raw file (e.g. a sound pack distributed as a bare .wav rather than a zip).
    if (!isZipBuffer(zipBytes)) {
      const ext = guessExtFromMagic(zipBytes);
      const dest = path.join(baseDir, safeSlug + ext);
      const destRel = path.relative(baseDir, dest);
      if (destRel.startsWith("..") || path.isAbsolute(destRel)) {
        return { ok: false, error: "raw file path escaped install dir" };
      }
      fs.mkdirSync(baseDir, { recursive: true });
      fs.writeFileSync(dest, zipBytes);
      return { ok: true, installedAt: dest, fileCount: 1, bytesWritten: zipBytes.byteLength };
    }

    const zip = new AdmZip(zipBytes);
    const entries = zip.getEntries();
    if (entries.length === 0) return { ok: false, error: "bundle is empty" };

    const cfg = resolveConfig();
    let totalUncompressed = 0;

    fs.mkdirSync(stageDir, { recursive: true });

    let fileCount = 0;
    for (const entry of entries) {
      if (entry.isDirectory) continue;
      const entryName = entry.entryName.replace(/\\/g, "/");
      if (!isSafeEntryName(entryName)) {
        throw new Error(`unsafe zip entry: "${entryName}"`);
      }
      let data = entry.getData();
      totalUncompressed += data.byteLength;
      if (totalUncompressed > cfg.maxBundleBytes) {
        throw new Error("uncompressed bundle exceeds max size (zip bomb suspected)");
      }
      const dest = path.join(stageDir, entryName);
      const destRel = path.relative(stageDir, dest);
      if (destRel.startsWith("..") || path.isAbsolute(destRel)) {
        throw new Error(`zip entry path escaped staging dir: "${entryName}"`);
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (entryName === "ui.html") {
        let html = data.toString("utf8");
        html = html.replace(/\n?<!-- studio-design:[A-Za-z0-9+/=\s]*-->/g, "");
        data = Buffer.from(html, "utf8");
      }
      fs.writeFileSync(dest, data);
      fileCount++;
    }

    rmDirSafe(finalDir);
    fs.mkdirSync(baseDir, { recursive: true });
    fs.renameSync(stageDir, finalDir);

    return { ok: true, installedAt: finalDir, fileCount, bytesWritten: totalUncompressed };
  } catch (err) {
    rmDirSafe(stageDir);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
