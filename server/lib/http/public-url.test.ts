import { describe, expect, test } from "bun:test";
import { resolvePublicUrl } from "./public-url";

const PORT = 7777;
const base = (raw: string | null, ip: string | null = null) => resolvePublicUrl(raw, ip, PORT).base;

describe("no convar set", () => {
  test("uses the detected public IP and the router's port", () => {
    expect(base(null, "203.0.113.9")).toBe("http://203.0.113.9:7777");
  });

  test("falls back to localhost before detection lands", () => {
    expect(base(null, null)).toBe("http://localhost:7777");
  });

  test("treats an empty or whitespace convar as unset", () => {
    expect(resolvePublicUrl("   ", "203.0.113.9", PORT)).toEqual({
      base: "http://203.0.113.9:7777",
      detected: true,
    });
  });

  test("brackets a detected IPv6 address", () => {
    expect(base(null, "2001:db8::1")).toBe("http://[2001:db8::1]:7777");
  });
});

describe("bare host, no port", () => {
  test("localhost gets the router's port over http", () => {
    expect(base("localhost")).toBe("http://localhost:7777");
  });

  test("an IPv4 literal gets the router's port over http", () => {
    expect(base("192.168.8.141")).toBe("http://192.168.8.141:7777");
  });

  // A certificate cannot be issued for an IP, so it is never behind TLS.
  test("a public IPv4 is still http, not https", () => {
    expect(base("203.0.113.9")).toBe("http://203.0.113.9:7777");
  });

  test("a single-label LAN name gets the router's port over http", () => {
    expect(base("myserver")).toBe("http://myserver:7777");
  });

  // The headline inference: DNS pointed here means a proxy or tunnel on 443.
  test("a registered domain becomes https with no port", () => {
    expect(base("fivem.timmygstudios.com")).toBe("https://fivem.timmygstudios.com");
  });

  test("a two-label domain is treated the same", () => {
    expect(base("example.com")).toBe("https://example.com");
  });

  test("normalizes host case", () => {
    expect(base("FiveM.Example.COM")).toBe("https://fivem.example.com");
  });
});

describe("explicit port", () => {
  test("an IP with a port is honoured verbatim", () => {
    expect(base("192.168.8.141:8080")).toBe("http://192.168.8.141:8080");
  });

  // A port means the box is exposed directly, so there is no TLS terminator.
  test("a domain with a port stays http and keeps the port", () => {
    expect(base("fivem.example.com:7777")).toBe("http://fivem.example.com:7777");
  });

  test("an IPv6 literal in brackets can carry a port", () => {
    expect(base("[2001:db8::1]:8080")).toBe("http://[2001:db8::1]:8080");
  });

  test("a bare IPv6 address is read as the address, never as host:port", () => {
    expect(base("2001:db8::1")).toBe("http://[2001:db8::1]:7777");
  });
});

describe("explicit scheme", () => {
  test("http is honoured and the port is not added", () => {
    expect(base("http://fivem.example.com")).toBe("http://fivem.example.com");
  });

  test("https is honoured", () => {
    expect(base("https://fivem.example.com")).toBe("https://fivem.example.com");
  });

  test("an explicit scheme overrides the domain inference", () => {
    expect(base("http://example.com:7777")).toBe("http://example.com:7777");
  });

  test("a default port is dropped", () => {
    expect(base("https://example.com:443")).toBe("https://example.com");
  });

  test("a trailing slash is trimmed", () => {
    expect(base("https://example.com/")).toBe("https://example.com");
  });
});

// Mounts are appended to this base, so a path prefix has to survive intact.
describe("path prefix", () => {
  test("survives on an absolute URL", () => {
    expect(base("https://example.com/radio")).toBe("https://example.com/radio");
  });

  test("survives on a bare host", () => {
    expect(base("example.com/radio")).toBe("https://example.com/radio");
  });

  test("survives alongside an explicit port", () => {
    expect(base("192.168.8.141:8080/radio")).toBe("http://192.168.8.141:8080/radio");
  });

  test("a trailing slash on the prefix is trimmed", () => {
    expect(base("https://example.com/radio/")).toBe("https://example.com/radio");
  });
});

// A typo must never take the hub down, and must never hand out a broken URL.
describe("unusable values fall back to detection", () => {
  test.each([
    ["ftp://example.com", "unsupported scheme"],
    ["ws://example.com", "unsupported scheme"],
    ["my server.com", "whitespace"],
    ["example.com:notaport", "non-numeric port"],
    ["example.com:0", "port out of range"],
    ["example.com:99999", "port out of range"],
    ["http://", "no host"],
    [":7777", "no host"],
  ])("%s (%s)", (value) => {
    const r = resolvePublicUrl(value, "203.0.113.9", PORT);
    expect(r.base).toBe("http://203.0.113.9:7777");
    expect(r.detected).toBe(true);
  });
});

describe("detected flag", () => {
  test("is false when the operator set a usable value", () => {
    expect(resolvePublicUrl("example.com", "203.0.113.9", PORT).detected).toBe(false);
  });
});
