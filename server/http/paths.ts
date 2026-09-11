// paths.ts — request path normalization and mount matching.
//
// Pure, no I/O. This is security-critical: mount selection happens on the
// normalized path, because matching a raw path lets `/dispatch/../admin` pick
// the wrong upstream.

/**
 * Normalize a request path to a canonical absolute form.
 *
 * - percent-decodes ONLY `%2e` (encoded dot), because that is the traversal
 *   vector; other escapes are left intact so upstreams see what the client
 *   actually sent (filenames legitimately contain `%20`, `%5B` etc.)
 * - converts backslashes to forward slashes (Windows upstreams treat `\` as a
 *   separator, so `/mount\..\x` must not slip past a `/`-only normalizer)
 * - resolves `.` and `..` segments, clamping at the root so `..` can never
 *   escape above `/`
 * - collapses repeated slashes
 * - always returns a leading `/`, and never a trailing one except for root
 *
 * Returns `null` if the input is not a usable path.
 */
export function normalizePath(raw: string): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;

  // Strip query/fragment if a full request-target was passed in.
  let p = raw.split("?")[0].split("#")[0];

  // Decode encoded dots only. Case-insensitive: %2E and %2e are both dots.
  p = p.replace(/%2e/gi, ".");

  // Windows separators count as separators for traversal purposes.
  p = p.replace(/\\/g, "/");

  if (!p.startsWith("/")) p = "/" + p;

  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      out.pop(); // clamps at root — pop on empty is a no-op
      continue;
    }
    out.push(seg);
  }

  return "/" + out.join("/");
}

/**
 * Normalize a mount prefix: leading slash, no trailing slash, no traversal.
 * Root (`/`) is not a valid mount — that path belongs to the hub.
 * Returns `null` if the value cannot be a mount.
 */
export function normalizeMount(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const n = normalizePath(raw);
  if (n === null || n === "/") return null;
  return n;
}

/**
 * True if `pathname` falls inside `mount`.
 *
 * Requires a segment boundary, so `/dispatcher` does NOT match mount
 * `/dispatch`. Both arguments must already be normalized.
 */
export function isUnder(pathname: string, mount: string): boolean {
  return pathname === mount || pathname.startsWith(mount + "/");
}

/**
 * The path to forward upstream for a mount.
 * `strip` removes the mount prefix; the result always keeps a leading slash.
 */
export function forwardPath(pathname: string, mount: string, strip: boolean): string {
  if (!strip) return pathname;
  const rest = pathname.slice(mount.length);
  return rest.length === 0 ? "/" : rest;
}
