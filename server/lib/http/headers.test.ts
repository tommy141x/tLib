import { describe, expect, test } from "bun:test";
import {
  buildForwardHeaders,
  rewriteCookiePath,
  rewriteForMount,
  rewriteLocation,
  sanitizeResponseHeaders,
} from "./headers";

const ctx = { remoteAddress: "203.0.113.9", host: "srv:7777", prefix: null };

describe("buildForwardHeaders", () => {
  test("passes ordinary headers through", () => {
    const h = buildForwardHeaders({ accept: "text/html", cookie: "a=1" }, ctx);
    expect(h.accept).toBe("text/html");
    expect(h.cookie).toBe("a=1");
  });

  test("strips hop-by-hop headers", () => {
    const h = buildForwardHeaders(
      { connection: "keep-alive", "transfer-encoding": "chunked", te: "trailers" },
      ctx
    );
    expect(h.connection).toBeUndefined();
    expect(h["transfer-encoding"]).toBeUndefined();
    expect(h.te).toBeUndefined();
  });

  test("overwrites a client-supplied X-Forwarded-For — spoofing guard", () => {
    const h = buildForwardHeaders({ "x-forwarded-for": "1.2.3.4" }, ctx);
    expect(h["x-forwarded-for"]).toBe("203.0.113.9");
  });

  test("drops every client-spoofable edge header", () => {
    const h = buildForwardHeaders(
      {
        "x-real-ip": "1.2.3.4",
        "x-forwarded-host": "evil.com",
        "x-forwarded-proto": "https",
        "x-forwarded-prefix": "/admin",
      },
      ctx
    );
    expect(h["x-real-ip"]).toBeUndefined();
    expect(h["x-forwarded-host"]).toBe("srv:7777");
    expect(h["x-forwarded-proto"]).toBe("http");
    expect(h["x-forwarded-prefix"]).toBeUndefined();
  });

  test("sets X-Forwarded-Prefix only when a prefix is given", () => {
    const h = buildForwardHeaders({}, { ...ctx, prefix: "/db" });
    expect(h["x-forwarded-prefix"]).toBe("/db");
  });
});

describe("sanitizeResponseHeaders", () => {
  test("strips hop-by-hop from the upstream response", () => {
    const h = sanitizeResponseHeaders({
      "content-type": "text/html",
      connection: "close",
      "transfer-encoding": "chunked",
    });
    expect(h["content-type"]).toBe("text/html");
    expect(h.connection).toBeUndefined();
    expect(h["transfer-encoding"]).toBeUndefined();
  });
});

describe("rewriteCookiePath", () => {
  test("re-anchors a root-scoped cookie under the mount", () => {
    expect(rewriteCookiePath("s=1; Path=/; HttpOnly", "/db")).toBe("s=1; Path=/db/; HttpOnly");
  });

  test("re-anchors a sub-path cookie", () => {
    expect(rewriteCookiePath("s=1; Path=/admin; HttpOnly", "/dispatch")).toBe(
      "s=1; Path=/dispatch/admin; HttpOnly"
    );
  });

  test("is case-insensitive on the attribute name", () => {
    expect(rewriteCookiePath("s=1; path=/", "/db")).toBe("s=1; Path=/db/");
  });

  test("leaves a cookie with no Path alone", () => {
    expect(rewriteCookiePath("s=1; HttpOnly", "/db")).toBe("s=1; HttpOnly");
  });

  test("preserves other attributes", () => {
    const out = rewriteCookiePath("s=1; Path=/; Max-Age=86400; SameSite=Strict; Secure", "/db");
    expect(out).toContain("Max-Age=86400");
    expect(out).toContain("SameSite=Strict");
    expect(out).toContain("Secure");
    expect(out).toContain("Path=/db/");
  });
});

describe("rewriteLocation", () => {
  test("prefixes a root-relative redirect", () => {
    expect(rewriteLocation("/_/", "/db")).toBe("/db/_/");
  });

  test("leaves an absolute URL alone", () => {
    expect(rewriteLocation("https://discord.com/oauth", "/db")).toBe("https://discord.com/oauth");
  });

  test("leaves a protocol-relative URL alone", () => {
    expect(rewriteLocation("//cdn.example.com/x", "/db")).toBe("//cdn.example.com/x");
  });

  test("leaves a path-relative redirect alone", () => {
    expect(rewriteLocation("next", "/db")).toBe("next");
  });
});

describe("rewriteForMount", () => {
  test("rewrites an array of Set-Cookie headers", () => {
    const h = rewriteForMount({ "set-cookie": ["a=1; Path=/", "b=2; Path=/admin"] }, "/dispatch");
    expect(h["set-cookie"]).toEqual(["a=1; Path=/dispatch/", "b=2; Path=/dispatch/admin"]);
  });

  test("rewrites Location and leaves other headers untouched", () => {
    const h = rewriteForMount({ location: "/_/", "content-type": "text/html" }, "/db");
    expect(h.location).toBe("/db/_/");
    expect(h["content-type"]).toBe("text/html");
  });
});
