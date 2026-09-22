import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  type ProtectedBuiltinInventory,
  snapshotProtectedInventory,
} from "../marketplace/installer";

export interface MarketplaceReleaseMetadataOptions {
  /** Explicit clean release staging directory; never an installed resource root. */
  stagingRoot: string;
  resourceName: string;
  /** Reviewed source commit associated with the clean release build. */
  sourceRevision: string;
  /** Complete approved FINAL staged file manifest, supplied by the build pipeline.
   * Do not derive this approval manifest by scanning a running resource. */
  expectedFiles: Readonly<Record<string, string>>;
  maxTotalBytes?: number;
}
export interface MarketplaceReleaseMetadata {
  schema: 1;
  resourceName: string;
  sourceRevision: string;
  shippedFiles: { path: string; sha256: string; bytes: number }[];
  protectedInventory: ProtectedBuiltinInventory;
}

/**
 * Opt-in post-staging/pre-package hook. Validates the ENTIRE explicit staging tree
 * against the approved build manifest, then exclusively publishes release metadata.
 * Does not invoke builds, package archives, clean dist, or alter staged payloads.
 * The canonical manifest digest avoids self-referencing the final ZIP hash. The
 * pipeline must distribute/attest this metadata and embed its policy in the agent;
 * merely finding this file on mutable runtime disk must never authorize adoption.
 */
export function writeMarketplaceReleaseMetadata(
  options: MarketplaceReleaseMetadataOptions
): MarketplaceReleaseMetadata {
  const { resourceName, sourceRevision } = options;
  if (
    typeof options.stagingRoot !== "string" ||
    !options.stagingRoot ||
    typeof resourceName !== "string" ||
    !/^[a-z0-9_-]+$/i.test(resourceName) ||
    typeof sourceRevision !== "string" ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(sourceRevision)
  ) {
    throw new Error("explicit staging root, resource and source revision required");
  }
  if (
    !options.expectedFiles ||
    typeof options.expectedFiles !== "object" ||
    Array.isArray(options.expectedFiles)
  )
    throw new Error("approved build manifest required");
  const expected = new Map(Object.entries(options.expectedFiles));
  const names = snapshotProtectedInventory(
    { schema: 1, resourceName, releaseHash: "0".repeat(64), files: [...expected.keys()] },
    resourceName
  ).files;
  if (names.some((name) => name.toLowerCase() === ".marketplace-release.json"))
    throw new Error("release metadata cannot approve itself");
  for (const digest of expected.values())
    if (typeof digest !== "string" || !/^[a-f0-9]{64}$/i.test(digest))
      throw new Error("invalid approved file digest");
  const max = options.maxTotalBytes ?? 512 * 1024 * 1024;
  if (!Number.isSafeInteger(max) || max <= 0) throw new Error("invalid staging byte limit");
  const root = path.resolve(options.stagingRoot);
  for (let dir = root; ; dir = path.dirname(dir)) {
    const s = fs.lstatSync(dir);
    if (!s.isDirectory() || s.isSymbolicLink()) throw new Error("unsafe staging ancestry");
    if (path.dirname(dir) === dir) break;
  }
  const directories = new Set([""]);
  for (const name of names) {
    const parts = name.split("/");
    while (parts.length > 1) {
      parts.pop();
      directories.add(parts.join("/"));
    }
  }
  const shippedFiles: MarketplaceReleaseMetadata["shippedFiles"] = [];
  const pending = [""];
  let total = 0;
  while (pending.length) {
    const rel = pending.pop()!;
    const full = rel ? path.join(root, rel) : root;
    const before = fs.lstatSync(full);
    if (before.isSymbolicLink()) throw new Error("symlink in release staging");
    if (before.isDirectory()) {
      if (!directories.has(rel)) throw new Error("unexpected staging directory");
      const dir = fs.opendirSync(full);
      try {
        for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
          const child = rel ? `${rel}/${entry.name}` : entry.name;
          if (!expected.has(child) && !directories.has(child))
            throw new Error("unexpected staged content");
          pending.push(child);
        }
      } finally {
        dir.closeSync();
      }
    } else {
      if (!before.isFile() || before.nlink !== 1 || !expected.has(rel))
        throw new Error("unsafe staged content");
      total += before.size;
      if (total > max) throw new Error("staging exceeds byte limit");
      const fd = fs.openSync(full, "r");
      let bytes = 0;
      const hash = createHash("sha256");
      try {
        const opened = fs.fstatSync(fd);
        if (
          !opened.isFile() ||
          opened.nlink !== 1 ||
          opened.dev !== before.dev ||
          opened.ino !== before.ino ||
          opened.size !== before.size
        )
          throw new Error("staged file changed");
        const buffer = Buffer.alloc(64 * 1024);
        while (true) {
          const n = fs.readSync(
            fd,
            buffer,
            0,
            Math.min(buffer.length, before.size - bytes + 1),
            bytes
          );
          if (!n) break;
          bytes += n;
          if (bytes > before.size) throw new Error("staged file grew during verification");
          hash.update(buffer.subarray(0, n));
        }
      } finally {
        fs.closeSync(fd);
      }
      const digest = hash.digest("hex");
      if (bytes !== before.size || digest !== expected.get(rel)!.toLowerCase())
        throw new Error("staged content differs from approved manifest");
      shippedFiles.push({ path: rel, sha256: digest, bytes });
    }
    const after = fs.lstatSync(full);
    if (
      after.isSymbolicLink() ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw new Error("staging changed during verification");
  }
  if (shippedFiles.length !== expected.size) throw new Error("approved staged files are missing");
  shippedFiles.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const canonical = { resourceName, sourceRevision: sourceRevision.toLowerCase(), shippedFiles };
  const releaseHash = createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
  const protectedInventory = snapshotProtectedInventory(
    { schema: 1, resourceName, source: "release-staging", releaseHash, files: [...names] },
    resourceName
  );
  const metadata: MarketplaceReleaseMetadata = { schema: 1, ...canonical, protectedInventory };
  const temporary = path.join(root, `.marketplace-release-${randomUUID()}.tmp`);
  let failure: unknown;
  try {
    fs.writeFileSync(temporary, JSON.stringify(metadata), { flag: "wx", mode: 0o600 });
    fs.linkSync(temporary, path.join(root, ".marketplace-release.json"));
  } catch (err) {
    failure = err;
  }
  try {
    fs.unlinkSync(temporary);
  } catch (err) {
    // The write's own error is the useful one; a stray temp file only matters
    // when the release itself was written.
    if (failure === undefined && (err as NodeJS.ErrnoException).code !== "ENOENT") failure = err;
  }
  if (failure !== undefined) throw failure;
  return metadata;
}
