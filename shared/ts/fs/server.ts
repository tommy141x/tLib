// The Node half of `tlib.fs.writeResourceFile` — shared as CODE, not as a
// runtime export.
//
// ── Why this is a shared module and not one export on tLib ───────────────────
//
// It used to be one export: tLib registered `WriteResourceFile(resource, ...)`
// and every consumer's Lua called `exports.tLib:WriteResourceFile(...)`. That
// cannot work on this platform. FiveM's Node runtime sandboxes each resource to
// its OWN directory, so tLib writing into tDetector's folder is refused before
// it reaches the disk:
//
//   [warning] [tLib] Filesystem write permission check from 'tLib' for
//     permission fs.write on resource '...\tDetector\data.json' - write not
//     allowed
//   [tLib] WriteResourceFile failed for 'tDetector/data.json': Access to this
//     API has been restricted. Use --allow-fs-write to manage permissions.
//
// `--allow-fs-write` is a server STARTUP ARGUMENT, not a manifest key, so the
// "fix" would be asking every customer to edit their launch command. It is not
// available to us. What is available is the thing tELS and tRadio were already
// doing by accident: each resource writes to itself from its own Node bundle.
//
// So the implementation is shared at BUILD time — tDetector and tRadar already
// bundle `tLib/shared/ts/` (see marketplace/agent) — and each resource calls
// `registerWriteResourceFile()` from its own `server/main.ts`. tLib calls it
// too, for its own files. Every write then originates inside the resource it
// lands in, and the sandbox has nothing to object to.
//
// ── Why the native is not enough ─────────────────────────────────────────────
//
// On FiveM for GTAV Enhanced, `SaveResourceFile` returns false for some
// resources while Node's `fs` writes the identical path successfully. The cause
// is still unknown; the workaround is proven. Untreated the failure is silent
// and total: `data.json` never changes and every setting the customer saves is
// gone on restart. `shared/imports/fs/server.lua` tries the native FIRST and
// only falls back here, so Legacy behaviour is byte-for-byte unchanged and this
// is never reached there.

import * as fs from "node:fs";
import * as path from "node:path";

// bun's CJS bundler wraps non-entry files in a module scope where `exports` is
// the CommonJS module-exports object, which shadows FiveM's global
// `exports(name, fn)` function. Resolving through `globalThis` is what keeps
// the bundler's hands off it — the same reason server/lib/http/fivem.ts exists.
// Read lazily rather than captured at module scope, because this file is
// imported by consumers whose bundles may evaluate it before the host has
// finished installing its globals.
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
 * `true` on success, or a **non-empty error string** on failure — never `false`
 * and never `""`.
 *
 * The Lua consumer branches on `res == true` and treats anything else as the
 * message to surface; an empty string is truthy in Lua, so a blank error would
 * read as success while the write had failed. The string carries Node's errno,
 * because `SaveResourceFile` has none to offer and EACCES, a read-only mount
 * (EROFS) and a full disk (ENOSPC) need three different fixes from the server
 * owner.
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
    // Parent directories are created ONLY when genuinely absent, and that is
    // load-bearing in both directions. Enhanced runs a write-permission check
    // against the directory passed to mkdir, so calling it unconditionally
    // (even with `recursive: true`, a no-op on an existing path) trips that
    // check against the resource root and denies the whole write. Missing
    // parents are still created, because writing to a path whose parent does
    // not exist has been observed to fault the server rather than fail
    // cleanly.
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
 * Register this resource's own `WriteResourceFile` export.
 *
 * Call it once, at the top level of the resource's `server/main.ts`, so the
 * registration happens inside the bundle that owns the directory being written.
 * `shared/imports/fs/server.lua` then calls
 * `exports[GetCurrentResourceName()]:WriteResourceFile(...)`.
 *
 * The three-argument signature — `(resource, relPath, contents)` — is kept even
 * though the answer can now only ever be this resource, because that is the
 * shape `tlib.fs.writeResourceFile` already speaks and because a cross-resource
 * request has to be *answered*, not silently redirected.
 */
export function registerWriteResourceFile(): void {
  const g = runtime();
  const self = g.GetCurrentResourceName();

  g.exports(
    "WriteResourceFile",
    (resourceName: unknown, relative: unknown, contents: unknown): WriteResourceFileResult => {
      // A cross-resource request is refused HERE, with an explanation, rather
      // than being handed to Node so it can answer with "Use --allow-fs-write".
      // That message names a fix the customer cannot be asked to apply, and it
      // sent a previous session looking for a manifest key that does not exist.
      // The real fix is always the same: the other resource registers its own.
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
