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
 * PocketBase 307s between them, so dropping it turns the rewritten Location
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
 *
 * The comparison is case-INSENSITIVE, for two reasons that both point the same
 * way now a mount is named after its resource:
 *
 *  * FXServer already is. `/tradio/admin` on the FiveM server port reaches
 *    tRadio and answers 200, so a case-sensitive listener meant one URL working
 *    on one door and 404ing on the other — the exact thing naming mounts after
 *    their resource was meant to end.
 *  * It makes `/tRadio` and `/tradio` COLLIDE at registration rather than
 *    becoming two mounts differing only in case, which nobody could debug from
 *    a URL.
 *
 * Only the mount is folded. `forwardPath` slices by length, so the remainder
 * reaches the upstream with its case intact — that part is the app's own
 * namespace to judge.
 */
export function isUnder(pathname: string, mount: string): boolean {
  const p = pathname.toLowerCase();
  const m = mount.toLowerCase();
  return p === m || p.startsWith(`${m}/`);
}

/**
 * Two paths that name the same place. Folds case for the same reason `isUnder`
 * does — a bare mount typed in any case must still take the index redirect,
 * rather than falling through to the upstream's own idea of its root (which for
 * PocketBase is a JSON 404 that reads like a broken router).
 */
export function samePath(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** `strip` removes the mount prefix; the result keeps its leading slash. */
export function forwardPath(pathname: string, mount: string, strip: boolean): string {
  if (!strip) return pathname;
  const rest = pathname.slice(mount.length);
  return rest.length === 0 ? "/" : rest;
}
