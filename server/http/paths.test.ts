import { describe, expect, test } from "bun:test";
import { forwardPath, isUnder, normalizeMount, normalizePath } from "./paths";

describe("normalizePath", () => {
  test("leaves a plain path alone", () => {
    expect(normalizePath("/dispatch/admin")).toBe("/dispatch/admin");
  });

  test("adds a leading slash", () => {
    expect(normalizePath("dispatch")).toBe("/dispatch");
  });

  test("collapses repeated slashes", () => {
    expect(normalizePath("//dispatch///admin")).toBe("/dispatch/admin");
  });

  test("drops '.' segments", () => {
    expect(normalizePath("/dispatch/./admin")).toBe("/dispatch/admin");
  });

  test("resolves '..' segments", () => {
    expect(normalizePath("/dispatch/../admin")).toBe("/admin");
  });

  test("clamps '..' at the root — cannot escape above /", () => {
    expect(normalizePath("/../../../etc/passwd")).toBe("/etc/passwd");
    expect(normalizePath("/..")).toBe("/");
  });

  test("decodes encoded dots so %2e traversal cannot slip through", () => {
    expect(normalizePath("/dispatch/%2e%2e/admin")).toBe("/admin");
    expect(normalizePath("/dispatch/%2E%2E/admin")).toBe("/admin");
  });

  test("treats backslashes as separators", () => {
    expect(normalizePath("/dispatch\\..\\admin")).toBe("/admin");
  });

  test("leaves non-dot escapes intact for the upstream", () => {
    expect(normalizePath("/layouts/my%20skin.png")).toBe("/layouts/my%20skin.png");
  });

  test("strips query and fragment", () => {
    expect(normalizePath("/api/status?x=1")).toBe("/api/status");
    expect(normalizePath("/api/status#frag")).toBe("/api/status");
  });

  test("root stays root", () => {
    expect(normalizePath("/")).toBe("/");
  });

  test("rejects empty and non-string input", () => {
    expect(normalizePath("")).toBeNull();
    expect(normalizePath(undefined as unknown as string)).toBeNull();
  });
});

describe("normalizeMount", () => {
  test("normalizes and strips a trailing slash", () => {
    expect(normalizeMount("/dispatch/")).toBe("/dispatch");
    expect(normalizeMount("dispatch")).toBe("/dispatch");
  });

  test("rejects root — that path belongs to the hub", () => {
    expect(normalizeMount("/")).toBeNull();
    expect(normalizeMount("")).toBeNull();
  });

  test("rejects non-strings", () => {
    expect(normalizeMount(42)).toBeNull();
    expect(normalizeMount(null)).toBeNull();
  });
});

describe("isUnder", () => {
  test("matches the mount itself and its children", () => {
    expect(isUnder("/dispatch", "/dispatch")).toBe(true);
    expect(isUnder("/dispatch/admin", "/dispatch")).toBe(true);
  });

  test("requires a segment boundary — /dispatcher is not under /dispatch", () => {
    expect(isUnder("/dispatcher", "/dispatch")).toBe(false);
  });

  test("does not match unrelated paths", () => {
    expect(isUnder("/db", "/dispatch")).toBe(false);
  });
});

describe("forwardPath", () => {
  test("passes the path through when not stripping", () => {
    expect(forwardPath("/dispatch/admin", "/dispatch", false)).toBe("/dispatch/admin");
  });

  test("strips the mount prefix when stripping", () => {
    expect(forwardPath("/db/api/health", "/db", true)).toBe("/api/health");
  });

  test("the mount root becomes / when stripping", () => {
    expect(forwardPath("/db", "/db", true)).toBe("/");
  });
});
