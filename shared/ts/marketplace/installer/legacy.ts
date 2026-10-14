// Adoption of an installation that predates the marketplace. Byte equivalence
// against a trusted package proves the tree is unmodified — never ownership, and
// never permission to mutate a built-in.
import * as fs from "node:fs";
import * as path from "node:path";
import { prepareBundle } from "./bundle";
import {
  type Context,
  checkAncestors,
  context,
  failure,
  hash,
  type InstallFailure,
  type InstallTarget,
  safeName,
  stat,
} from "./core";
import { lockTarget } from "./lock";
import { protectedLegacyDestination, snapshotProtectedInventory } from "./protected";
import { cleanup } from "./transaction";

export interface LegacyVerificationResult {
  ok: true;
  classification: "verified-unreceipted";
  destination: string;
  packageHash: string;
  fileCount: number;
  /** Byte equivalence does not establish ownership. This is NOT an adoption token. */
  adoptionAllowed: false;
  blocker: "builtin-boundary-unavailable" | "adoption-not-enabled";
}
export type LegacyVerificationOutcome = LegacyVerificationResult | InstallFailure;

// Compare only the expected tree: reject unexpected names before reading their
// contents, and check sizes before allocation. Explicit empty ZIP folders are
// intentionally omitted, exactly as in the installer's extraction semantics.
function expectedLegacyTree(
  prepared: ReturnType<typeof prepareBundle>
): Map<string, Buffer | null> {
  const expected = new Map<string, Buffer | null>();
  // The destination directory itself, when the destination IS a directory. A
  // sound adopts as a flat file, so its expected tree is the single empty-key
  // entry the payload already carries and there is no directory to expect.
  //
  // `directory`, not `zip`: a zipped sound module is an archive that installs
  // flat, and comparing it against a folder would fail every adoption.
  if (prepared.directory) expected.set("", null);
  for (const [name, data] of prepared.files) {
    expected.set(name, data);
    const parts = name.split("/");
    while (parts.length > 1) {
      parts.pop();
      expected.set(parts.join("/"), null);
    }
  }
  return expected;
}

function verifyLegacyTree(dest: string, prepared: ReturnType<typeof prepareBundle>): void {
  const expected = expectedLegacyTree(prepared);
  const pending = [""];
  const seen = new Set<string>();
  while (pending.length) {
    const rel = pending.pop()!;
    if (!expected.has(rel) || seen.has(rel)) throw new Error("extra or unsafe legacy content");
    seen.add(rel);
    const data = expected.get(rel)!;
    const p = rel ? path.join(dest, rel) : dest;
    const before = stat(p);
    if (!before || before.isSymbolicLink()) throw new Error("missing or symlinked legacy content");
    if (data === null) {
      if (!before.isDirectory()) throw new Error("legacy file/directory mismatch");
      const dir = fs.opendirSync(p);
      try {
        for (let child = dir.readSync(); child; child = dir.readSync()) {
          const name = rel ? `${rel}/${child.name}` : child.name;
          if (!safeName(name) || !expected.has(name))
            throw new Error("extra or unsafe legacy content");
          pending.push(name);
        }
      } finally {
        dir.closeSync();
      }
    } else {
      if (!before.isFile() || before.nlink !== 1)
        throw new Error("unsafe or hard-linked legacy content");
      if (before.size !== data.length) throw new Error("modified legacy content");
      const fd = fs.openSync(p, "r");
      try {
        const opened = fs.fstatSync(fd);
        if (
          !opened.isFile() ||
          opened.nlink !== 1 ||
          opened.dev !== before.dev ||
          opened.ino !== before.ino ||
          opened.size !== data.length
        )
          throw new Error("legacy content changed during verification");
        // Never read an unbounded file if another writer grows it after lstat.
        const actual = Buffer.alloc(data.length + 1);
        let length = 0;
        while (length < actual.length) {
          const n = fs.readSync(fd, actual, length, actual.length - length, length);
          if (!n) break;
          length += n;
        }
        if (length !== data.length || hash(actual.subarray(0, length)) !== hash(data))
          throw new Error("modified legacy content");
      } finally {
        fs.closeSync(fd);
      }
    }
    const after = stat(p);
    if (
      !after ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      after.isSymbolicLink()
    ) {
      throw new Error("legacy content changed during verification");
    }
  }
  if (seen.size !== expected.size) throw new Error("missing legacy content");
}

function checkLegacyDestination(c: Context, destination: string, receiptAllowed = false): void {
  // The module directory named after the slug, AND the three flat audio names a
  // sound can take. Both, unconditionally, because a target is a target: a
  // directory called `demo` must block a sound install just as `demo.wav` must
  // block a layout install, and refusing more is the safe direction.
  //
  // The "ambiguous legacy destinations" branch below also catches two entries
  // that match case-insensitively, which is what a case-sensitive filesystem
  // makes possible and what must never be adopted.
  const candidates = new Set([c.name, `${c.name}.wav`, `${c.name}.ogg`, `${c.name}.mp3`]);
  checkAncestors(c.base);
  if (!stat(c.base)) throw new Error("legacy installation is missing");
  const dir = fs.opendirSync(c.base);
  const matches: string[] = [];
  try {
    for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
      const lower = entry.name.toLowerCase();
      if (
        lower === path.basename(c.receipt).toLowerCase() &&
        (!receiptAllowed || entry.name !== path.basename(c.receipt))
      )
        throw new Error("marketplace receipt already exists; refusing legacy verification");
      if (candidates.has(lower)) matches.push(entry.name);
      if (matches.length > 1) throw new Error("ambiguous legacy destinations");
    }
  } finally {
    dir.closeSync();
  }
  if (!matches.length) throw new Error("legacy installation is missing");
  if (matches[0] !== destination) throw new Error("ambiguous or mismatched legacy destination");
}

/**
 * Read-only prerequisite, run in the consumer's VM. The expected SHA-256 must
 * come from a trusted package source — a digest of arbitrary local content
 * proves nothing about provenance. Nothing is written and the result never
 * authorizes adoption; that needs a separate, explicitly authorized call to
 * adoptLegacyInstallationFromData against a trusted policy.
 */
export function verifyLegacyInstallationFromData(
  target: InstallTarget,
  slug: string,
  packageBytes: Buffer,
  expectedHash: string,
  expectedSize: number
): LegacyVerificationOutcome {
  try {
    const c = context(target, slug);
    if (typeof expectedHash !== "string" || !/^(?:sha256:)?[a-f0-9]{64}$/i.test(expectedHash)) {
      throw new Error("legacy verification requires a sha256 package hash");
    }
    const prepared = prepareBundle(target, c, packageBytes, expectedHash, expectedSize);
    if (protectedLegacyDestination(target, c))
      throw new Error("protected built-in destination; refusing legacy adoption");
    checkLegacyDestination(c, prepared.destination);
    const destination = path.join(c.base, prepared.destination);
    verifyLegacyTree(destination, prepared);
    checkLegacyDestination(c, prepared.destination);
    return {
      ok: true,
      classification: "verified-unreceipted",
      destination,
      packageHash: hash(packageBytes),
      fileCount: prepared.files.size,
      adoptionAllowed: false,
      blocker: target.protectedInventory ? "adoption-not-enabled" : "builtin-boundary-unavailable",
    };
  } catch (err) {
    return failure(err);
  }
}

/** Explicit authorization from a trusted consumer-side operator workflow, not an event payload. */
export interface LegacyAdoptionAuthorization {
  action: "adopt-verified-legacy";
  resourceName: string;
  type: string;
  slug: string;
  packageHash: string;
  protectedReleaseHash: string;
}
export interface LegacyAdoptionResult {
  ok: true;
  adoptedAt: string;
  fileCount: number;
  payloadBytesWritten: 0;
}
export type LegacyAdoptionOutcome = LegacyAdoptionResult | InstallFailure;

/**
 * Consumer-local primitive, deliberately not reachable as a network event. Takes
 * the same target lock as install/uninstall, re-verifies the whole tree under
 * it, and publishes the receipt with link(2)'s atomic no-overwrite semantics; a
 * filesystem without hard links fails closed.
 *
 * An external writer is not locked out — the checks only detect changes they
 * observe, and later install/uninstall still validate the receipt inventory.
 * Abandoned locks need operator review.
 */
export function adoptLegacyInstallationFromData(
  target: InstallTarget,
  slug: string,
  packageBytes: Buffer,
  expectedHash: string,
  expectedSize: number,
  authorization: LegacyAdoptionAuthorization
): LegacyAdoptionOutcome {
  let unlock: (() => void) | undefined;
  let stage: string | undefined;
  let published: { path: string; dev: number; ino: number; data: Buffer } | undefined;
  try {
    const c = context(target, slug);
    if (!target.protectedInventory) throw new Error("builtin-boundary-unavailable");
    const protectedInventory = snapshotProtectedInventory(
      target.protectedInventory,
      c.resourceName
    );
    const scopedTarget = { ...target, protectedInventory };
    if (typeof expectedHash !== "string" || !/^(?:sha256:)?[a-f0-9]{64}$/i.test(expectedHash))
      throw new Error("adoption requires a verified sha256 package hash");
    const digest = expectedHash.toLowerCase().replace(/^sha256:/, "");
    if (
      !authorization ||
      authorization.action !== "adopt-verified-legacy" ||
      authorization.resourceName !== c.resourceName ||
      authorization.type !== c.type ||
      authorization.slug !== c.name ||
      authorization.packageHash !== digest ||
      authorization.protectedReleaseHash !== protectedInventory.releaseHash
    )
      throw new Error("explicit matching legacy adoption authorization required");
    // Detach package bytes too: callers cannot change the authorized package mid-operation.
    if (
      !Number.isSafeInteger(target.maxBundleBytes) ||
      target.maxBundleBytes <= 0 ||
      !Buffer.isBuffer(packageBytes) ||
      packageBytes.length > target.maxBundleBytes
    )
      throw new Error("invalid adoption package");
    const bytes = Buffer.from(packageBytes);
    const prepared = prepareBundle(scopedTarget, c, bytes, digest, expectedSize);
    if (protectedLegacyDestination(scopedTarget, c))
      throw new Error("protected built-in destination; refusing legacy adoption");
    checkLegacyDestination(c, prepared.destination);
    unlock = lockTarget(c, "adopt");
    const destination = path.join(c.base, prepared.destination);
    const reverify = () => {
      checkLegacyDestination(c, prepared.destination);
      verifyLegacyTree(destination, prepared);
      checkLegacyDestination(c, prepared.destination);
    };
    reverify();
    const files: Record<string, string> = Object.create(null);
    for (const [name, data] of expectedLegacyTree(prepared))
      files[data === null ? `${name}/` : name] = data === null ? "directory" : hash(data);
    const receipt = {
      version: 1,
      resourceName: c.resourceName,
      type: c.type,
      slug: c.name,
      destination: prepared.destination,
      files,
      adoption: { packageHash: digest, protectedReleaseHash: protectedInventory.releaseHash },
    };
    const serialized = Buffer.from(JSON.stringify(receipt));
    if (serialized.length > 1024 * 1024)
      throw new Error("adoption receipt exceeds ownership receipt limit");
    stage = fs.mkdtempSync(path.join(c.base, ".marketplace-transaction-"));
    const stagedReceipt = path.join(stage, "receipt");
    fs.writeFileSync(stagedReceipt, serialized, { flag: "wx", mode: 0o600 });
    const fd = fs.openSync(stagedReceipt, "r+");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    const identity = fs.lstatSync(stagedReceipt);
    reverify(); // Includes mutations while staging/fsyncing the receipt.
    // Unlike rename, link never replaces an existing destination receipt.
    fs.linkSync(stagedReceipt, c.receipt);
    published = { path: c.receipt, dev: identity.dev, ino: identity.ino, data: serialized };
    fs.unlinkSync(stagedReceipt); // Receipt now has the single link owned() requires.
    checkLegacyDestination(c, prepared.destination, true);
    verifyLegacyTree(destination, prepared); // Detect an observed publication-window mutation.
    const committed = fs.lstatSync(c.receipt);
    if (
      !committed.isFile() ||
      committed.isSymbolicLink() ||
      committed.nlink !== 1 ||
      committed.dev !== identity.dev ||
      committed.ino !== identity.ino ||
      committed.size !== serialized.length ||
      !fs.readFileSync(c.receipt).equals(serialized)
    )
      throw new Error("receipt changed during adoption");
    published = undefined;
    return {
      ok: true,
      adoptedAt: destination,
      fileCount: prepared.files.size,
      payloadBytesWritten: 0,
    };
  } catch (err) {
    if (published) {
      try {
        const current = stat(published.path);
        if (current) {
          if (
            !current.isFile() ||
            current.isSymbolicLink() ||
            current.dev !== published.dev ||
            current.ino !== published.ino ||
            current.size !== published.data.length ||
            !fs.readFileSync(published.path).equals(published.data)
          ) {
            throw new Error(
              "published receipt identity/content changed; retained for operator review"
            );
          }
          fs.unlinkSync(published.path);
        }
      } catch (rollback) {
        return failure(`${String(err)}; receipt cleanup failed: ${String(rollback)}`);
      }
    }
    return failure(err);
  } finally {
    if (stage) cleanup(stage);
    unlock?.();
  }
}
