// Shared vocabulary of a marketplace installation: the validated target context,
// the ownership receipt, and the path checks every other module depends on.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

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

export interface InstallTarget {
  resourceName: string;
  resourceRoot: string;
  type: string;
  installPath: string;
  maxBundleBytes: number;
  /** Optional for compatibility. Absence never authorizes legacy adoption. */
  protectedInventory?: ProtectedBuiltinInventory;
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
      ![c.name, ...[".wav", ".ogg", ".mp3"].map((ext) => c.name + ext)].includes(
        receipt.destination
      ) ||
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
  for (const candidate of [c.name, `${c.name}.wav`, `${c.name}.ogg`, `${c.name}.mp3`]) {
    if (stat(path.join(c.base, candidate)) && candidate !== receipt?.destination)
      throw new Error("existing target has no marketplace ownership receipt");
  }
  return receipt;
}
