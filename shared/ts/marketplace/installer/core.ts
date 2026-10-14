// Shared vocabulary of a marketplace installation: the validated target context,
// the ownership receipt, and the path checks every other module depends on.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ModuleManifest } from "../../modules/manifest";

/** Consumer-owned, embedded release inventory; never derive this from runtime disk scans. */
export interface ProtectedBuiltinInventory {
  schema: 1;
  resourceName: string;
  /** SHA-256 of the trusted release ZIP, or canonical release-staging manifest when source is release-staging. */
  releaseHash: string;
  source?: "release-zip" | "release-staging";
  /** Every shipped file, relative to this resource's root. */
  files: readonly string[];
}

/**
 * The prepared, fully-validated payload a {@link ContentValidator} is handed.
 *
 * `files` is keyed by the entry's path within the bundle, exactly as it will be
 * written relative to the destination. A SOUND installs as a flat audio file, so
 * its payload is the single entry under the empty-string key -- the destination is
 * the file, not a directory containing it.
 *
 * `manifest` is the sound module's `module.json`, passed in memory because a flat
 * audio file has nowhere on disk to keep it: on a FiveM resource a sound is just
 * the `.wav`, and its name, licence, duration and peaks live in the studio.
 */
export interface PreparedPayload {
  type: string;
  slug: string;
  /** True for a ZIP bundle, false for a single raw file. Says nothing about the destination. */
  zip: boolean;
  files: ReadonlyMap<string, Buffer>;
  /** A sound module's manifest, when the item is a sound. Never written to a resource. */
  manifest?: ModuleManifest;
}

/**
 * A consumer's own content contract for one item type, run immediately before the
 * commit. REJECT BY THROWING -- the message is surfaced verbatim as
 * `InstallFailure.error`, so write it for the server owner who will read it.
 *
 * The structural guarantees in this module establish that a bundle is SAFE TO
 * EXTRACT and nothing more; they cannot establish that it is a valid instance of
 * whatever the consumer expects. Without a hook here, the only place left to find
 * out is at render time on a player's machine.
 *
 * Called BEFORE the staging directory exists, so a rejected bundle touches no disk
 * and leaves nothing to roll back. Deliberately NOT given the resource root or any
 * filesystem handle: it inspects the payload it is passed and nothing else, and it
 * runs inside the install lock.
 */
export type ContentValidator = (payload: PreparedPayload) => void;

export interface InstallTarget {
  resourceName: string;
  resourceRoot: string;
  type: string;
  installPath: string;
  maxBundleBytes: number;
  /** Optional for compatibility. Absence never authorizes legacy adoption. */
  protectedInventory?: ProtectedBuiltinInventory;
  validate?: ContentValidator;
}

export interface InstallResult {
  ok: true;
  installedAt: string;
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

export const MAX_ENTRIES = 1024;
export const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");
export const failure = (err: unknown): InstallFailure => ({
  ok: false,
  error: err instanceof Error ? err.message : String(err),
});
export const stat = (p: string) => {
  try {
    return fs.lstatSync(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
};

export function safeName(name: string): boolean {
  return (
    typeof name === "string" &&
    !!name &&
    !name.includes("\\") &&
    name.split("/").every(
      (seg) =>
        !!seg &&
        seg !== "." &&
        seg !== ".." &&
        // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters in a path segment is the point of this check.
        !/[<>:"|?*\x00-\x1f\x7f]/.test(seg) &&
        !/[. ]$/.test(seg) &&
        !/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(seg)
    )
  );
}

// Check every ancestor, including the resource itself, before any mkdir/write.
export function checkAncestors(dir: string): void {
  const parent = path.dirname(dir);
  if (parent !== dir) checkAncestors(parent);
  const s = stat(dir);
  if (s && (s.isSymbolicLink() || !s.isDirectory()))
    throw new Error(`unsafe install directory: ${dir}`);
}

export function context(target: InstallTarget, slug: string) {
  const { resourceName, type, resourceRoot: root } = target;
  if (
    typeof resourceName !== "string" ||
    !resourceName ||
    typeof type !== "string" ||
    !type ||
    typeof slug !== "string" ||
    !/^[a-z0-9_-]+$/i.test(slug) ||
    !safeName(slug)
  ) {
    throw new Error("invalid resourceName, type, or slug");
  }
  if (!root) throw new Error("resource has no resolvable path");
  if (!safeName(target.installPath)) throw new Error("unsafe installPath");
  const base = path.resolve(root, target.installPath);
  checkAncestors(base);
  const name = slug.toLowerCase();
  return { base, name, resourceName, type, receipt: path.join(base, `.marketplace-${name}.json`) };
}
export type Context = ReturnType<typeof context>;

/**
 * Every path under `base` that a slug could legitimately occupy: the module
 * directory, and the three flat audio names a SOUND installs as -- a sound on a
 * FiveM resource is just the `.wav`, chosen so an operator can drag one in.
 *
 * Deliberately NOT narrowed by `c.type`. A target is a target: a directory named
 * `airhorn` must block a sound install and `airhorn.wav` must block a layout
 * install. Narrowing it would mean an unreceipted file of the "wrong" shape
 * stopped being protected.
 */
export const DESTINATIONS = (c: Context): string[] => [
  c.name,
  `${c.name}.wav`,
  `${c.name}.ogg`,
  `${c.name}.mp3`,
];
export interface Receipt {
  version: 1;
  resourceName: string;
  type: string;
  slug: string;
  destination: string;
  files: Record<string, string>;
}

// Hash an exact tree, rejecting links, special files and unexpected empty folders.
// Thus a receipt cannot authorize deletion of later-added unrelated content.
export function inventory(dest: string): Record<string, string> {
  const files: Record<string, string> = Object.create(null);
  function walk(p: string, rel: string): void {
    const s = stat(p);
    if (!s || s.isSymbolicLink()) throw new Error("missing or symlinked installed content");
    if (s.isFile()) {
      if (s.nlink !== 1) throw new Error("hard-linked installed content");
      files[rel] = hash(fs.readFileSync(p));
    } else if (s.isDirectory()) {
      files[`${rel}/`] = "directory";
      for (const child of fs.readdirSync(p))
        walk(path.join(p, child), rel ? `${rel}/${child}` : child);
    } else throw new Error("unsupported installed file type");
  }
  walk(dest, "");
  return files;
}
export function owned(c: Context): Receipt | null {
  let receipt: Receipt | null = null;
  const s = stat(c.receipt);
  if (s) {
    if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.size > 1024 * 1024)
      throw new Error("unsafe marketplace receipt");
    receipt = JSON.parse(fs.readFileSync(c.receipt, "utf8"));
    if (
      !receipt ||
      receipt.version !== 1 ||
      receipt.resourceName !== c.resourceName ||
      receipt.type !== c.type ||
      receipt.slug !== c.name ||
      !DESTINATIONS(c).includes(receipt.destination) ||
      !receipt.files ||
      typeof receipt.files !== "object"
    )
      throw new Error("invalid marketplace ownership receipt");
    const actual = inventory(path.join(c.base, receipt.destination));
    if (
      Object.keys(actual).length !== Object.keys(receipt.files).length ||
      Object.keys(actual).some((key) => actual[key] !== receipt!.files[key])
    )
      throw new Error("installed content changed; refusing overwrite/delete");
  }
  // THE PROTECTION PROPERTY. Read this before changing the line below.
  //
  // Content that SHIPPED with a resource has no receipt. This throw is therefore
  // the entire reason shipped content cannot be overwritten or uninstalled: on
  // install and on uninstall alike, a target that exists and that no receipt
  // claims is refused. It is NOT `ProtectedBuiltinInventory`, which is measurably
  // inert — nothing in the estate passes one and `protectedLegacyDestination`
  // returns false on its first line. Demo mode's reset sweep (./reset.ts) rests
  // on the same property: it can only delete what a receipt names, so shipped
  // modules are invisible to it.
  for (const candidate of DESTINATIONS(c)) {
    if (stat(path.join(c.base, candidate)) && candidate !== receipt?.destination)
      throw new Error("existing target has no marketplace ownership receipt");
  }

  // The same refusal on a case-sensitive filesystem.
  //
  // `c.name` is the slug lowercased, but shipped module folders are not: tRadio
  // ships `bgDog`, `transEnd1`, `QRX-720`. On Windows the `stat` above already
  // finds `bgDog` when asked for `bgdog` and refuses. On Linux — which is a
  // first-class target for these resources — it does not, so without this an
  // install of slug `bgdog` would quietly create a second module beside the
  // shipped `bgDog` and the two would differ only by case. That is not a
  // destructive outcome, but it is an unexplainable one, and "protected
  // everywhere except in the container the customer actually runs" is not a
  // property worth claiming.
  const sibling = caseVariantOf(c.base, c.name);
  if (sibling && sibling !== receipt?.destination)
    throw new Error(
      `existing target "${sibling}" differs from "${c.name}" only by case; refusing to install beside it`
    );

  return receipt;
}

/**
 * An entry in `base` whose name matches `name` case-insensitively but not exactly.
 *
 * Returns null when the directory is absent or unreadable: this backs a refusal,
 * and a refusal that cannot read the directory has nothing to refuse on. The
 * `stat` check above is what covers "the target is simply there".
 */
function caseVariantOf(base: string, name: string): string | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(base);
  } catch {
    return null;
  }
  const lower = name.toLowerCase();
  for (const entry of entries) {
    if (entry !== name && entry.toLowerCase() === lower) return entry;
  }
  return null;
}
