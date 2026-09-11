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
