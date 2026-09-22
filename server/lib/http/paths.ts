// Path normalization and mount matching. Pure, and security-critical: mount
// selection runs on the normalized path, since matching a raw one lets
// `/dispatch/../admin` pick the wrong upstream.

/**
 * Canonical absolute form, or `null` if the input cannot be a path.
 *
 * - decodes `%2e` only, that being the traversal vector; other escapes reach the
 *   upstream as sent, since filenames legitimately contain `%20`, `%5B` etc.
 * - backslashes become slashes: a Windows upstream treats `\` as a separator,
 *   so `/mount\..\x` must not slip past a `/`-only normalizer
 * - resolves `.` and `..`, clamping at the root, and collapses repeat slashes
 * - preserves a trailing slash. Upstreams distinguish `/_` from `/_/` --
 *   PocketBase 307s between them, so dropping it turns the rewritten Location
 *   into a redirect loop -- and browsers resolve relative URLs against it.
 */
export function normalizePath(raw: string): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;

  // Strip query/fragment if a full request-target was passed in.
  let p = raw.split("?")[0].split("#")[0];

  p = p.replace(/%2e/gi, ".");

  p = p.replace(/\\/g, "/");

  if (!p.startsWith("/")) p = `/${p}`;

  // Ending in a separator, `.` or `..` denotes a directory.
  const trailing = /(?:\/|\/\.|\/\.\.)$/.test(p);

  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      out.pop(); // clamps at root — pop on empty is a no-op
      continue;
    }
    out.push(seg);
  }

  if (out.length === 0) return "/";
  return `/${out.join("/")}${trailing ? "/" : ""}`;
}

/** Root is not a valid mount: that path belongs to the hub. */
export function normalizeMount(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const n = normalizePath(raw);
  if (n === null || n === "/") return null;
  // Mounts are prefixes, never directories: `/db/` and `/db` are one mount.
  return n.endsWith("/") ? n.slice(0, -1) : n;
}

/**
 * Requires a segment boundary, so `/dispatcher` is not under `/dispatch`. Both
 * arguments must already be normalized.
 */
export function isUnder(pathname: string, mount: string): boolean {
  return pathname === mount || pathname.startsWith(`${mount}/`);
}

/** `strip` removes the mount prefix; the result keeps its leading slash. */
export function forwardPath(pathname: string, mount: string, strip: boolean): string {
  if (!strip) return pathname;
  const rest = pathname.slice(mount.length);
  return rest.length === 0 ? "/" : rest;
}
