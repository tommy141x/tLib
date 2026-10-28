// The mount table behind RegisterWebApp. Unlike server/marketplace/registry.ts,
// a mount collision is refused rather than last-writer-wins: a silently
// overridden mount presents to the operator as an unexplainable routing bug.

import { isUnder, normalizeMount, normalizePath } from "./paths";

export interface Upstream {
  host: string;
  port: number;
}

/** A separate process (tRadio, tDB) reached over loopback. */
export interface ProxyMount {
  kind: "proxy";
  upstream: Upstream;
  /** Strip the mount before forwarding, and rewrite Set-Cookie/Location back. */
  stripPrefix: boolean;
  /** Forward WebSocket upgrades to this upstream. */
  websocket: boolean;
}

/**
 * A handler in tLib's own bundle (realtime at /rt). Reachable only from inside
 * tLib by construction: each resource's Node bundle is a separate V8 isolate.
 */
export interface InProcessMount {
  kind: "inprocess";
  onRequest?: (req: unknown, res: unknown, forwarded: string) => void;
  onUpgrade?: (req: unknown, socket: unknown, head: unknown) => void;
}

export interface HubLink {
  /** Stable within this mount; 'root' is reserved for its primary destination. */
  id: string;
  /** Literal canonical path relative to the mount, e.g. '/admin'. */
  path: string;
  title?: string;
  listed?: boolean;
  icon?: string;
  description?: string;
  accent?: string;
}

export interface HubDestination {
  id: string;
  /** Where this answers on tLib's own listener. */
  path: string;
  /**
   * Where the same destination answers on the FiveM server port, which is a
   * different string because each resource owns its own door there. Resolved
   * when the destination is built, so the one place that knows the addressing
   * rule is the one that holds the mount table.
   */
  ingressPath: string;
  title: string;
  icon?: string;
  description?: string;
  accent?: string;
}

export type Mount = {
  id: string;
  mount: string;
  title: string;
  /** Visibility of the primary destination only; never an access-control gate. */
  listed: boolean;
  /** Independent sibling destinations within this same proxy mount. */
  hubLinks?: HubLink[];
  /** Owning resource, for onResourceStop cleanup. */
  resourceName: string;
  /**
   * Where the bare mount lands, relative to it — "/_/" for PocketBase, whose
   * admin UI is not at its root. Without it the upstream is asked for "/" and
   * answers with whatever it says about an empty root, which for PocketBase is
   * a JSON 404 that reads like the router is broken.
   */
  index?: string;
  /**
   * Paths this app used to be mounted at, answered with a 301 to the current
   * mount. For renaming a mount without breaking a bookmark or a link somebody
   * already published — the only correct way to move a URL.
   */
  legacyMounts?: string[];
  /** Lucide icon name, e.g. "database". */
  icon?: string;
  description?: string;
  /** `#rgb`/`#rrggbb`. */
  accent?: string;
} & (ProxyMount | InProcessMount);

export type RegisterResult = { ok: true; mount: Mount } | { ok: false; error: string };

import { isKnownIcon } from "./icons";

const mounts = new Map<string, Mount>();

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * Rejects a malformed or root mount, a non-loopback upstream (arbitrary hosts
 * would make the router an SSRF gadget), and any mount that collides with,
 * contains or is contained by an existing one.
 */
export function register(input: Mount): RegisterResult {
  const mount = normalizeMount(input.mount);
  if (mount === null) {
    return { ok: false, error: `invalid mount path '${String(input.mount)}'` };
  }

  if (input.kind === "proxy") {
    const host = String(input.upstream?.host ?? "");
    const port = Number(input.upstream?.port);
    if (!LOOPBACK.has(host)) {
      return {
        ok: false,
        error: `upstream host '${host}' is not loopback — the router only exposes local services`,
      };
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { ok: false, error: `invalid upstream port '${String(input.upstream?.port)}'` };
    }
  }

  // Nesting is a collision too: /dispatch and /dispatch/admin cannot both be
  // mounts, because longest-prefix would silently shadow part of the first.
  for (const existing of mounts.values()) {
    if (isUnder(mount, existing.mount) || isUnder(existing.mount, mount)) {
      return {
        ok: false,
        error:
          `mount '${mount}' conflicts with '${existing.mount}' ` +
          `already registered by '${existing.resourceName}'`,
      };
    }
  }

  // The index is concatenated onto the mount and sent as a Location, so
  // "//evil.example.com" or "/../x" would be an open redirect.
  const index = normalizeIndex(input.index);
  if (index === null) {
    return { ok: false, error: `invalid index path '${String(input.index)}'` };
  }

  // Presentation is cosmetic: a bad value loses the decoration, never the mount.
  const normalized: Mount = {
    ...input,
    mount,
    index,
    legacyMounts: normalizeLegacyMounts(input.legacyMounts, mount),
    hubLinks: normalizeHubLinks(input.hubLinks),
    icon: isKnownIcon(input.icon) ? input.icon : undefined,
    description: normalizeDescription(input.description),
    accent: normalizeAccent(input.accent),
  };
  mounts.set(mount, normalized);
  return { ok: true, mount: normalized };
}

/**
 * A dropped value costs a redirect, not the mount — the app still works at its
 * current path either way. A legacy path that is or contains the live mount is
 * dropped too: `/tRadio` redirecting to `/tRadio` is a loop.
 */
function normalizeLegacyMounts(raw: unknown, mount: string): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const value of raw.slice(0, 8)) {
    const old = normalizeMount(value);
    if (old === null || old === mount) continue;
    if (isUnder(old, mount) || isUnder(mount, old)) continue;
    if (!out.includes(old)) out.push(old);
  }
  return out.length ? out : undefined;
}

/**
 * The mount that has replaced an old path, for a 301. Checked only after a live
 * mount fails to match, so a real mount always wins over a stale alias of it.
 */
export function matchLegacy(pathname: string): { from: string; to: Mount } | null {
  let best: { from: string; to: Mount } | null = null;
  for (const m of mounts.values()) {
    for (const old of m.legacyMounts ?? []) {
      if (!isUnder(pathname, old)) continue;
      if (!best || old.length > best.from.length) best = { from: old, to: m };
    }
  }
  return best;
}

/** Remove every mount owned by a resource — called on its stop. */
export function unregisterResource(resourceName: string): string[] {
  const removed: string[] = [];
  for (const [key, m] of mounts) {
    if (m.resourceName === resourceName) {
      mounts.delete(key);
      removed.push(key);
    }
  }
  return removed;
}

/**
 * Where a router path answers on the FiveM server port.
 *
 * On that port a path's first segment IS a resource name — FXServer resolves it
 * before any resource code runs — so every app is reached under its owner and
 * nowhere else. An app whose mount is already its resource name therefore needs
 * no second segment: FXServer has consumed `/tRadio`, and tLib's door for
 * tRadio puts exactly that back. The two doors then spell the app identically,
 * `/tRadio/admin` either way, which is why mounts are named after their
 * resource. An app mounted under some other name keeps its mount as a second
 * segment — `/thatResource/thatMount/` — because its own links say so.
 *
 * `stripPrefix` is part of the test for the same reason: an upstream that is
 * SENT its mount writes that mount into its links, so dropping the segment from
 * the public path would break every one of them.
 */
export function ingressPath(m: Mount, routerPath: string): string {
  const door = `/${m.resourceName}`;
  if (m.mount === door && m.kind === "proxy" && m.stripPrefix) {
    return `${door}${routerPath.slice(m.mount.length) || "/"}`;
  }
  return `${door}${routerPath}`;
}

/**
 * Longest-prefix match. `pathname` must already be normalized.
 *
 * `entries` narrows the table — the FiveM-server-port ingress passes only the
 * mounts owned by the resource whose door was knocked on, because there a mount
 * is reachable at exactly one prefix and no other.
 */
export function match(pathname: string, entries: Iterable<Mount> = mounts.values()): Mount | null {
  let best: Mount | null = null;
  for (const m of entries) {
    if (!isUnder(pathname, m.mount)) continue;
    if (!best || m.mount.length > best.mount.length) best = m;
  }
  return best;
}

export function list(): Mount[] {
  return Array.from(mounts.values()).sort((a, b) => a.mount.localeCompare(b.mount));
}

export function listed(): Mount[] {
  return list().filter((m) => m.listed);
}

/**
 * A local canonical path, never a URL or query string. Literal only: percent
 * escapes hide traversal and separators that browsers and upstreams decode
 * differently.
 */
function safeHubPath(raw: unknown): raw is string {
  return (
    typeof raw === "string" &&
    raw.startsWith("/") &&
    !raw.startsWith("//") &&
    /^\/[A-Za-z0-9/_~.!$&'()*+,;=:@-]*$/.test(raw) &&
    normalizePath(raw) === raw
  );
}

/** Invalid links are omitted rather than fatal; they must not disable the app. */
function normalizeHubLinks(raw: unknown): HubLink[] {
  if (!Array.isArray(raw)) return [];
  const ids = new Set<string>(["root"]);
  const links: HubLink[] = [];
  for (const value of raw.slice(0, 16)) {
    if (!value || typeof value !== "object") continue;
    const { id, path } = value;
    if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(id) || ids.has(id)) continue;
    if (!safeHubPath(path)) continue;
    ids.add(id);
    links.push({
      id,
      path,
      listed: value.listed !== false,
      title: typeof value.title === "string" ? value.title.trim() : id,
      icon: isKnownIcon(value.icon) ? value.icon : undefined,
      description: normalizeDescription(value.description),
      accent: normalizeAccent(value.accent),
    });
  }
  return links;
}

/**
 * One list for both root routing and the hub cards. Deduplication happens
 * before counting, so two names for one destination cannot turn what should be
 * a redirect into a picker with a single entry.
 */
export function hubDestinations(entries: Mount[] = list()): HubDestination[] {
  const destinations = new Map<string, HubDestination>();
  for (const m of entries) {
    if (!safeHubPath(m.mount) || m.mount === "/") continue;
    const add = (
      id: string,
      relative: string,
      presentation: {
        title?: string;
        icon?: string;
        description?: string;
        accent?: string;
      }
    ) => {
      if (!safeHubPath(relative)) return;
      const path = `${m.mount}${relative === "/" ? (m.index ?? "/") : relative}`;
      if (!safeHubPath(path) || !isUnder(path, m.mount) || destinations.has(path)) return;
      destinations.set(path, {
        id: `${m.resourceName}:${m.mount}:${id}`,
        path,
        ingressPath: ingressPath(m, path),
        title: presentation.title || id,
        icon: presentation.icon,
        description: presentation.description,
        accent: presentation.accent,
      });
    };
    if (m.listed) add("root", "/", { ...m, title: m.title || m.id });
    for (const link of normalizeHubLinks(m.hubLinks)) {
      if (link.listed) add(link.id, link.path, link);
    }
  }
  return [...destinations.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * `undefined` when none was given, `null` when unusable — rejected rather than
 * dropped so a typo surfaces at registration instead of as a strange redirect.
 */
function normalizeIndex(raw: unknown): string | null | undefined {
  if (raw === undefined || raw === null || raw === "" || raw === "/") return undefined;
  return safeHubPath(raw) ? raw : null;
}

/**
 * Interpolated into a `style` attribute, so it is matched against hex rather
 * than escaped: a CSS function, a var(), or a `;` opening a second declaration
 * is dropped.
 */
function normalizeAccent(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const s = raw.trim();
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(s) ? s.toLowerCase() : undefined;
}

/** Capped for the fixed-width card grid. Escaped at render, not here. */
function normalizeDescription(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const s = raw.replace(/\s+/g, " ").trim();
  if (!s) return undefined;
  return s.length > 120 ? `${s.slice(0, 119)}…` : s;
}

/** Test seam — drops all mounts. */
export function clear(): void {
  mounts.clear();
}
