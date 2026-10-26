// The Node half of `tlib.fs.writeResourceFile` — shared as code, not a runtime
// export. Used to be one tLib export, but FiveM's Node runtime sandboxes each
// resource to its own directory, so tLib writing into tDetector's folder is
// refused before it reaches disk ("Filesystem write permission check ... write
// not allowed"). The fix, `--allow-fs-write`, is a server startup argument, not
// a manifest key — not something to ask every customer to add. So the
// implementation is shared at build time (tDetector/tRadar already bundle
// `tLib/shared/ts/`) and each resource calls `registerWriteResourceFile()` from
// its own `server/main.ts`, so every write originates inside the resource it
// lands in and the sandbox has nothing to object to.
//
// On FiveM for GTAV Enhanced, `SaveResourceFile` returns false for some
// resources while Node's `fs` writes the identical path successfully — cause
// unknown, workaround proven. Untreated the failure is silent and total:
// `data.json` never changes and every saved setting is gone on restart.
// `shared/imports/fs/server.lua` tries the native first and only falls back
// here, so Legacy behaviour is unchanged and this path is never reached there.

import * as fs from "node:fs";
import * as path from "node:path";

// bun's CJS bundler wraps non-entry files in a module scope where `exports` is
// the CommonJS module-exports object, shadowing FiveM's global `exports(name,
// fn)` — resolving through `globalThis` keeps the bundler's hands off it (same
// reason server/lib/http/fivem.ts exists). Read lazily, not captured at module
// scope: a consumer's bundle may evaluate this before the host installs its
// globals.
type ExportsFn = (name: string, fn: (...args: unknown[]) => unknown) => void;

function runtime(): {
  exports: ExportsFn;
  GetCurrentResourceName: () => string;
  GetResourcePath: (resourceName: string) => string | null;
} {
  return globalThis as unknown as {
    exports: ExportsFn;
    GetCurrentResourceName: () => string;
    GetResourcePath: (resourceName: string) => string | null;
  };
}

/**
 * `true` on success, or a non-empty error string on failure — never `false` or
 * `""`. The Lua consumer branches on `res == true`; an empty string is truthy
 * in Lua, so a blank error would read as success. The string carries Node's
 * errno, since EACCES, a read-only mount (EROFS) and a full disk (ENOSPC) each
 * need a different fix from the server owner.
 */
export type WriteResourceFileResult = true | string;

// `relative` is resolved against the resource root and must stay inside it.
// `resourceName` is a NAME, not a path: a separator would let a caller point
// GetResourcePath at a sibling directory by relative name.
function resolveWithinResource(resourceName: unknown, relative: unknown): string | null {
  if (typeof relative !== "string" || relative.length === 0) return null;
  if (relative.includes("\0")) return null;
  if (typeof resourceName !== "string" || resourceName.length === 0) return null;
  if (/[\\/\0]/.test(resourceName)) return null;

  // Empty for a resource that does not exist or is not started, which is the
  // only reason a legitimate caller lands here with a name we cannot resolve.
  const root = runtime().GetResourcePath(resourceName);
  if (!root) return null;

  const rootResolved = path.resolve(root);
  const target = path.resolve(rootResolved, relative);
  const rel = path.relative(rootResolved, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;

  return target;
}

/**
 * Write a file inside a started resource's own directory.
 *
 * Callable directly, but the registered export below is what Lua reaches, and
 * `tlib.fs.writeResourceFile` is what consumers should actually call.
 *
 * @param resourceName the resource whose directory to write into
 * @param relative     path relative to that resource's root, no `..`
 * @param contents     the bytes to write
 */
export function writeResourceFile(
  resourceName: unknown,
  relative: unknown,
  contents: unknown
): WriteResourceFileResult {
  if (typeof contents !== "string") {
    // Almost always a caller that forgot to encode its table to JSON. Naming
    // the received type distinguishes this from a permissions problem.
    return `EINVAL: file contents must be a string, got ${typeof contents} (path "${String(relative)}")`;
  }
  const target = resolveWithinResource(resourceName, relative);
  if (!target) {
    return `EINVAL: path is unsafe or unresolvable, refusing to write outside resource "${String(resourceName)}" ("${String(relative)}")`;
  }

  try {
    // mkdir only when genuinely absent: Enhanced runs a write-permission check
    // against mkdir's target directory, so calling it unconditionally (even
    // with `recursive: true`, a no-op on an existing path) trips that check
    // against the resource root and denies the whole write. Still created when
    // missing — writing to a path whose parent doesn't exist has faulted the
    // server rather than failing cleanly.
    const parent = path.dirname(target);
    if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
    fs.writeFileSync(target, contents);
    return true;
  } catch (e: unknown) {
    const message = (e instanceof Error && e.message) || String(e) || "unknown filesystem error";
    return message;
  }
}

/**
 * Register this resource's own `WriteResourceFile` export. Call once, at the
 * top level of the resource's `server/main.ts`, so registration happens inside
 * the bundle that owns the directory being written.
 * `shared/imports/fs/server.lua` calls
 * `exports[GetCurrentResourceName()]:WriteResourceFile(...)`.
 *
 * Kept the three-argument `(resource, relPath, contents)` signature even
 * though the answer can now only be this resource: it's the shape
 * `tlib.fs.writeResourceFile` already speaks, and a cross-resource request has
 * to be answered, not silently redirected.
 */
export function registerWriteResourceFile(): void {
  const g = runtime();
  const self = g.GetCurrentResourceName();

  g.exports(
    "WriteResourceFile",
    (resourceName: unknown, relative: unknown, contents: unknown): WriteResourceFileResult => {
      // Refused here, with an explanation, rather than handed to Node for its
      // "Use --allow-fs-write" — a fix the customer can't apply, and one that
      // previously sent a session looking for a manifest key that doesn't exist.
      if (typeof resourceName === "string" && resourceName !== self) {
        return (
          `EPERM: '${self}' cannot write into resource '${resourceName}' — FiveM's Node ` +
          "runtime sandboxes each resource to its own directory. The resource that owns " +
          "the file must call registerWriteResourceFile() from its own server/main.ts."
        );
      }

      const result = writeResourceFile(self, relative, contents);
      if (result !== true) {
        console.log(`[${self}] WriteResourceFile failed for '${String(relative)}': ${result}`);
      }
      return result;
    }
  );
}
