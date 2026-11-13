import { describe, expect, test } from "bun:test";
import { hubRow, rejectedOverrideNotice, resolvePublicUrl } from "./public-url";

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
      rejected: false,
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
    expect(base("198.18.0.9")).toBe("http://198.18.0.9:7777");
  });

  test("a single-label LAN name gets the router's port over http", () => {
    expect(base("myserver")).toBe("http://myserver:7777");
  });

  // The headline inference: DNS pointed here means a proxy or tunnel on 443.
  test("a registered domain becomes https with no port", () => {
    expect(base("fivem.timmygstudios.com")).toBe("https://fivem.timmygstudios.com");
  });

  test("a two-label domain is treated the same", () => {
    expect(base("mycommunity.net")).toBe("https://mycommunity.net");
  });

  test("normalizes host case", () => {
    expect(base("FiveM.Mycommunity.NET")).toBe("https://fivem.mycommunity.net");
  });
});

describe("explicit port", () => {
  test("an IP with a port is honoured verbatim", () => {
    expect(base("192.168.8.141:8080")).toBe("http://192.168.8.141:8080");
  });

  // A port means the box is exposed directly, so there is no TLS terminator.
  test("a domain with a port stays http and keeps the port", () => {
    expect(base("fivem.mycommunity.net:7777")).toBe("http://fivem.mycommunity.net:7777");
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
    expect(base("http://fivem.mycommunity.net")).toBe("http://fivem.mycommunity.net");
  });

  test("https is honoured", () => {
    expect(base("https://fivem.mycommunity.net")).toBe("https://fivem.mycommunity.net");
  });

  test("an explicit scheme overrides the domain inference", () => {
    expect(base("http://mycommunity.net:7777")).toBe("http://mycommunity.net:7777");
  });

  test("a default port is dropped", () => {
    expect(base("https://mycommunity.net:443")).toBe("https://mycommunity.net");
  });

  test("a trailing slash is trimmed", () => {
    expect(base("https://mycommunity.net/")).toBe("https://mycommunity.net");
  });
});

// Mounts are appended to this base, so a path prefix has to survive intact.
describe("path prefix", () => {
  test("survives on an absolute URL", () => {
    expect(base("https://mycommunity.net/radio")).toBe("https://mycommunity.net/radio");
  });

  test("survives on a bare host", () => {
    expect(base("mycommunity.net/radio")).toBe("https://mycommunity.net/radio");
  });

  test("survives alongside an explicit port", () => {
    expect(base("192.168.8.141:8080/radio")).toBe("http://192.168.8.141:8080/radio");
  });

  test("a trailing slash on the prefix is trimmed", () => {
    expect(base("https://mycommunity.net/radio/")).toBe("https://mycommunity.net/radio");
  });
});

// A typo must never take the hub down, and must never hand out a broken URL.
describe("unusable values fall back to detection", () => {
  test.each([
    ["ftp://mycommunity.net", "unsupported scheme"],
    ["ws://mycommunity.net", "unsupported scheme"],
    ["my server.com", "whitespace"],
    ["mycommunity.net:notaport", "non-numeric port"],
    ["mycommunity.net:0", "port out of range"],
    ["mycommunity.net:99999", "port out of range"],
    ["http://", "no host"],
    [":7777", "no host"],
  ])("%s (%s)", (value) => {
    const r = resolvePublicUrl(value, "203.0.113.9", PORT);
    expect(r.base).toBe("http://203.0.113.9:7777");
    expect(r.detected).toBe(true);
    expect(r.rejected).toBe(true);
  });
});

// germancatfish pasted the install docs' example verbatim and his banner read
// `Panel: http://your-server-address:7777/tRadio`. The shape was a legal hostname, so
// nothing refused it; the words were the only tell.
describe("a docs placeholder is not an address", () => {
  test.each([
    "your-server-address",
    "http://your-server-address:7777",
    "http://YOUR-SERVER-ADDRESS:50053",
    "your-server",
    "your_ip",
    "your-ip:7777",
    "yourdomain.com",
    "https://radio.example.com",
    "example.org",
    "203.0.113.10",
    "http://192.0.2.1:7777",
    "198.51.100.7",
  ])("%s falls back to detection and says it did", (value) => {
    const r = resolvePublicUrl(value, "198.18.0.9", PORT);
    expect(r).toEqual({ base: "http://198.18.0.9:7777", detected: true, rejected: true });
  });

  test.each([
    "localhost",
    "http://localhost:30120",
    "192.168.1.20",
    "198.18.0.9",
    "fivem.mycommunity.net",
    "https://youtube.com",
    "yourname.mycommunity.net",
  ])("%s is still honoured", (value) => {
    const r = resolvePublicUrl(value, "198.18.0.9", PORT);
    expect(r.rejected).toBe(false);
    expect(r.detected).toBe(false);
  });

  test("nothing set is not a rejection", () => {
    expect(resolvePublicUrl(null, "198.18.0.9", PORT).rejected).toBe(false);
  });
});

describe("detected flag", () => {
  test("is false when the operator set a usable value", () => {
    expect(resolvePublicUrl("mycommunity.net", "203.0.113.9", PORT).detected).toBe(false);
  });
});

// The Hub row is the first line an operator reads about where the panel lives.
describe("the Hub row of the banner", () => {
  test("a configured address is printed alone", () => {
    expect(hubRow("http://198.18.0.9:30120/tLib", false)).toBe("http://198.18.0.9:30120/tLib");
  });

  test("a detected address says it is a guess and names the convar", () => {
    const row = hubRow("http://198.18.0.9:30120/tLib", true);
    expect(row).toContain("detected");
    expect(row).toContain("tlib_http_public_url");
  });

  test("no row suggests tlib_http_port 7777: on a host that never allocated 7777 it is a dead socket", () => {
    for (const detected of [true, false]) {
      const row = hubRow("http://198.18.0.9:30120/tLib", detected);
      expect(row).not.toContain("7777");
      expect(row).not.toContain("restores");
    }
  });

  test("a rejected value is quoted back so the operator can find it in server.cfg", () => {
    const text = rejectedOverrideNotice("http://your-server-address:7777");
    expect(text).toContain('tlib_http_public_url "http://your-server-address:7777"');
    expect(text).toContain("placeholder");
    expect(text).toContain("detecting this server's public IP instead");
  });
});
