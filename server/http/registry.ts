// registry.ts — the mount table.
//
// Consumer resources call RegisterWebApp(...) to declare "I am listening on
// loopback port N, expose me at /mount". Modeled on
// server/marketplace/registry.ts, with one deliberate difference: mount
// collisions are REFUSED rather than last-writer-wins. A silently overridden
// mount presents as a routing bug, and the operator has no way to see it.

import { isUnder, normalizeMount } from "./paths";

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
 * A handler living in tLib's own bundle (realtime at /rt).
 *
 * Only reachable from inside tLib by construction: each FiveM resource's Node
 * bundle runs in a separate V8 isolate, so no other resource could hand us a
 * function reference anyway.
 */
export interface InProcessMount {
  kind: "inprocess";
  onRequest?: (req: unknown, res: unknown, forwarded: string) => void;
  onUpgrade?: (req: unknown, socket: unknown, head: unknown) => void;
}

export type Mount = {
  id: string;
  mount: string;
  title: string;
  /** false = routable, but hidden from the hub index. */
  listed: boolean;
  /** Owning resource, for onResourceStop cleanup. */
  resourceName: string;
  /**
   * Where the bare mount should land, relative to it — e.g. "/_/" for
   * PocketBase, whose admin UI is not at its root.
   *
   * Without this, visiting the mount hands the upstream a request for "/" and
   * the operator sees whatever it says about an empty root, which for
   * PocketBase is a bare JSON 404 that reads like the router is broken.
   */
  index?: string;
} & (ProxyMount | InProcessMount);

export type RegisterResult = { ok: true; mount: Mount } | { ok: false; error: string };

const mounts = new Map<string, Mount>();

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * Register a mount.
 *
 * Rejects:
 * - a malformed or root mount path
 * - a non-loopback upstream (a registry accepting arbitrary hosts is SSRF as a
 *   feature — the router must only ever expose services on this machine)
 * - a mount that collides with, contains, or is contained by an existing one
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

  // The index is concatenated onto the mount and handed straight to the browser
  // in a Location, so a caller-supplied "//evil.example.com" or "/../x" would be
  // an open redirect. Require a single-slash-rooted, traversal-free path.
  const index = normalizeIndex(input.index);
  if (index === null) {
    return { ok: false, error: `invalid index path '${String(input.index)}'` };
  }

  const normalized: Mount = { ...input, mount, index };
  mounts.set(mount, normalized);
  return { ok: true, mount: normalized };
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

/** Longest-prefix match. `pathname` must already be normalized. */
export function match(pathname: string): Mount | null {
  let best: Mount | null = null;
  for (const m of mounts.values()) {
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
 * Validate an optional index path.
 *
 * Returns the normalized path, or `undefined` when none was given. `null`
 * means the caller supplied something unusable — rejected rather than
 * silently dropped, so a typo surfaces at registration instead of becoming a
 * confusing redirect later.
 *
 * "//host" and "/\host" are protocol-relative and would leave the server
 * entirely; ".." could climb out of the mount into another one.
 */
function normalizeIndex(raw: unknown): string | null | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string") return null;
  if (!raw.startsWith("/")) return null;
  if (raw.startsWith("//") || raw.startsWith("/\\")) return null;
  if (raw.split("/").includes("..")) return null;
  // No query or fragment: this is a path within the mount, and letting one in
  // would collide with the query the router carries through the redirect.
  if (/[?#]/.test(raw)) return null;
  return raw;
}

/** Test seam — drops all mounts. */
export function clear(): void {
  mounts.clear();
}
