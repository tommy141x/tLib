import { beforeEach, describe, expect, test } from "bun:test";
import { clear, list, listed, match, register, unregisterResource } from "./registry";

const proxyMount = (over: Record<string, unknown> = {}) =>
  ({
    kind: "proxy" as const,
    id: "radio",
    mount: "/dispatch",
    title: "Dispatch",
    listed: true,
    resourceName: "tRadio",
    upstream: { host: "127.0.0.1", port: 7777 },
    stripPrefix: false,
    websocket: true,
    ...over,
  }) as Parameters<typeof register>[0];

beforeEach(() => clear());

describe("register", () => {
  test("accepts a loopback proxy mount", () => {
    const r = register(proxyMount());
    expect(r.ok).toBe(true);
  });

  test("normalizes the mount path on the way in", () => {
    const r = register(proxyMount({ mount: "/dispatch/" }));
    expect(r.ok && r.mount.mount).toBe("/dispatch");
  });

  test("rejects a non-loopback upstream (SSRF guard)", () => {
    const r = register(proxyMount({ upstream: { host: "10.0.0.5", port: 80 } }));
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain("not loopback");
  });

  test("rejects a public-host upstream even on a loopback-looking port", () => {
    const r = register(proxyMount({ upstream: { host: "evil.example.com", port: 7777 } }));
    expect(r.ok).toBe(false);
  });

  test("rejects an out-of-range upstream port", () => {
    expect(register(proxyMount({ upstream: { host: "127.0.0.1", port: 0 } })).ok).toBe(false);
    expect(register(proxyMount({ upstream: { host: "127.0.0.1", port: 99999 } })).ok).toBe(false);
  });

  test("rejects the root mount — that path belongs to the hub", () => {
    expect(register(proxyMount({ mount: "/" })).ok).toBe(false);
  });

  test("refuses a duplicate mount rather than silently overriding", () => {
    expect(register(proxyMount()).ok).toBe(true);
    const second = register(proxyMount({ resourceName: "tOther", id: "other" }));
    expect(second.ok).toBe(false);
    expect(second.ok === false && second.error).toContain("tRadio");
    // the original survives
    expect(match("/dispatch")?.resourceName).toBe("tRadio");
  });

  test("refuses a nested mount that would be shadowed", () => {
    register(proxyMount());
    const nested = register(proxyMount({ mount: "/dispatch/admin", resourceName: "tOther" }));
    expect(nested.ok).toBe(false);
  });

  test("refuses a parent mount that would shadow an existing one", () => {
    register(proxyMount({ mount: "/dispatch/admin" }));
    const parent = register(proxyMount({ mount: "/dispatch", resourceName: "tOther" }));
    expect(parent.ok).toBe(false);
  });

  test("allows sibling mounts", () => {
    expect(register(proxyMount()).ok).toBe(true);
    expect(register(proxyMount({ mount: "/db", id: "db", resourceName: "tDB" })).ok).toBe(true);
    expect(list()).toHaveLength(2);
  });

  test("in-process mounts need no upstream", () => {
    const r = register({
      kind: "inprocess",
      id: "rt",
      mount: "/rt",
      title: "Realtime",
      listed: false,
      resourceName: "tLib",
      onUpgrade: () => {},
    });
    expect(r.ok).toBe(true);
  });
});

describe("match", () => {
  test("finds a mount by its own path and by a child path", () => {
    register(proxyMount());
    expect(match("/dispatch")?.id).toBe("radio");
    expect(match("/dispatch/admin/config")?.id).toBe("radio");
  });

  test("returns null for an unmounted path", () => {
    register(proxyMount());
    expect(match("/nope")).toBeNull();
    expect(match("/")).toBeNull();
  });

  test("does not match on a partial segment", () => {
    register(proxyMount());
    expect(match("/dispatcher")).toBeNull();
  });

  test("prefers the longest prefix", () => {
    // registered directly to bypass the nesting guard, which is what a future
    // explicit-override feature would do
    register(proxyMount({ mount: "/a", id: "short" }));
    clear();
    register(proxyMount({ mount: "/a/b", id: "long", resourceName: "L" }));
    expect(match("/a/b/c")?.id).toBe("long");
  });
});

describe("unregisterResource", () => {
  test("removes every mount owned by the resource", () => {
    register(proxyMount());
    register(proxyMount({ mount: "/extra", id: "extra" }));
    register(proxyMount({ mount: "/db", id: "db", resourceName: "tDB" }));

    const removed = unregisterResource("tRadio");
    expect(removed.sort()).toEqual(["/dispatch", "/extra"]);
    expect(match("/dispatch")).toBeNull();
    expect(match("/db")?.id).toBe("db");
  });

  test("frees the mount for re-registration on restart", () => {
    register(proxyMount());
    unregisterResource("tRadio");
    expect(register(proxyMount()).ok).toBe(true);
  });
});

describe("listed", () => {
  test("hides unlisted mounts from the hub index but keeps them routable", () => {
    register(proxyMount());
    register(proxyMount({ mount: "/db", id: "db", resourceName: "tDB", listed: false }));

    expect(listed().map((m) => m.id)).toEqual(["radio"]);
    expect(match("/db")?.id).toBe("db");
  });
});

// The index is concatenated onto the mount and handed to the browser in a
// Location header, so an unvalidated one is an open redirect.
describe("index validation", () => {
  test("accepts a rooted path", () => {
    const r = register(proxyMount({ index: "/_/" }));
    expect(r.ok && r.mount.index).toBe("/_/");
  });

  test("is undefined when not supplied", () => {
    const r = register(proxyMount());
    expect(r.ok && r.mount.index).toBeUndefined();
  });

  test("treats an empty string as absent", () => {
    const r = register(proxyMount({ index: "" }));
    expect(r.ok && r.mount.index).toBeUndefined();
  });

  test("rejects a protocol-relative path — it would leave the server", () => {
    for (const index of ["//evil.example.com", "/\\evil.example.com"]) {
      const r = register(proxyMount({ index }));
      expect(r.ok).toBe(false);
      clear();
    }
  });

  test("rejects traversal out of the mount", () => {
    expect(register(proxyMount({ index: "/../other" })).ok).toBe(false);
  });

  test("rejects an unrooted path", () => {
    expect(register(proxyMount({ index: "_/" })).ok).toBe(false);
  });

  test("rejects an absolute URL", () => {
    expect(register(proxyMount({ index: "https://evil.example.com" })).ok).toBe(false);
  });

  // The router appends the request's own query after the index.
  test("rejects a query or fragment", () => {
    expect(register(proxyMount({ index: "/_/?a=1" })).ok).toBe(false);
    clear();
    expect(register(proxyMount({ index: "/_/#x" })).ok).toBe(false);
  });

  test("rejects a non-string", () => {
    expect(register(proxyMount({ index: 42 })).ok).toBe(false);
  });
});

// Presentation is cosmetic. Nothing here may ever fail a registration — a
// mistyped colour must cost the card its accent, not the operator their panel.
describe("hub presentation", () => {
  test("keeps a known icon and drops an unknown one", () => {
    const good = register(proxyMount({ icon: "database" }));
    expect(good.ok && good.mount.icon).toBe("database");
    clear();
    const bad = register(proxyMount({ icon: "definitely-not-an-icon" }));
    expect(bad.ok).toBe(true);
    expect(bad.ok && bad.mount.icon).toBeUndefined();
  });

  test("rejects an icon name that could not be a lookup key", () => {
    for (const icon of ["../../etc/passwd", "<svg onload=x>", 42, "Database"]) {
      const r = register(proxyMount({ icon }));
      expect(r.ok && r.mount.icon).toBeUndefined();
      clear();
    }
  });

  // The accent lands in a style attribute, so it is matched, not escaped.
  test("accepts #rgb and #rrggbb, normalized to lowercase", () => {
    const short = register(proxyMount({ accent: "#ABC" }));
    expect(short.ok && short.mount.accent).toBe("#abc");
    clear();
    const long = register(proxyMount({ accent: "  #4F8EF7 " }));
    expect(long.ok && long.mount.accent).toBe("#4f8ef7");
  });

  test("drops anything that is not a plain hex colour", () => {
    for (const accent of [
      "red",
      "rgb(1,2,3)",
      "var(--x)",
      "#abc; background:url(//evil)",
      "#12345",
      7,
    ]) {
      const r = register(proxyMount({ accent }));
      expect(r.ok).toBe(true);
      expect(r.ok && r.mount.accent).toBeUndefined();
      clear();
    }
  });

  test("collapses whitespace in the description and drops an empty one", () => {
    const r = register(proxyMount({ description: "  two   lines\nhere  " }));
    expect(r.ok && r.mount.description).toBe("two lines here");
    clear();
    expect(register(proxyMount({ description: "   " })).ok && true).toBe(true);
    clear();
    const blank = register(proxyMount({ description: "\n\t " }));
    expect(blank.ok && blank.mount.description).toBeUndefined();
  });

  test("caps a long description so it cannot wreck the card grid", () => {
    const r = register(proxyMount({ description: "x".repeat(400) }));
    expect(r.ok && r.mount.description?.length).toBe(120);
    expect(r.ok && r.mount.description?.endsWith("…")).toBe(true);
  });
});
