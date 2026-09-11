// public-url.ts — the URL clients are told to use.
//
// The router binds a port; it cannot know what address reaches it from
// outside. NAT, a tunnel, a reverse proxy and a bare WAN IP all present
// differently, and a host cannot answer "am I reachable from the internet"
// by asking itself — most routers do not hairpin. So the operator states it:
//
//   setr tlib_http_public_url "fivem.example.com"
//
// Leaving it unset auto-detects the public IP and appends the router's port,
// which is right for the common case of a box with a forwarded port and no
// domain.
//
// The value is deliberately forgiving, because the operators setting it are
// not writing URLs for a living. A scheme or an explicit port is always
// honoured; anything missing is inferred from the shape of the host:
//
//   (unset)                   http://<detected-ip>:<port>
//   localhost                 http://localhost:<port>
//   192.168.8.141             http://192.168.8.141:<port>
//   192.168.8.141:8080        http://192.168.8.141:8080
//   fivem.example.com         https://fivem.example.com
//   http://fivem.example.com  http://fivem.example.com
//   https://example.com/radio https://example.com/radio
//
// The one inference worth stating plainly: a registered domain name with no
// port becomes **https with no port**. A name only reaches a FiveM box because
// someone pointed DNS at it, and that is done with a tunnel or a reverse proxy
// terminating TLS on 443 — appending :7777 there would be wrong every time. An
// IP literal gets the opposite treatment for the same reason in reverse: you
// cannot put a certificate on a bare IP, so it is direct, on the router's port.

/** A parsed public base URL, ready to have a mount path appended. */
export interface PublicUrl {
  /** Full base, no trailing slash — e.g. "https://example.com/radio". */
  base: string;
  /** True when no convar was set and this came from IP detection. */
  detected: boolean;
}

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
// Anything that cannot sit in an authority. Catches a pasted "ip:port (note)".
const ILLEGAL = /[\s<>"'\\^`{|}]/;

/**
 * Build the public base URL.
 *
 * `raw` is the convar verbatim. `detectedIp` is the resolved public IP, or null
 * when detection has not landed yet or failed. `port` is the router's port.
 *
 * Never throws: an unparseable value falls back to detection, because handing
 * clients a broken URL is worse than handing them a possibly-unreachable one,
 * and a hard failure here would take the whole hub down over a typo.
 */
export function resolvePublicUrl(
  raw: string | null,
  detectedIp: string | null,
  port: number
): PublicUrl {
  const value = (raw ?? "").trim();
  if (!value) return { base: autoBase(detectedIp, port), detected: true };

  const parsed = SCHEME.test(value) ? fromAbsolute(value) : fromBareAuthority(value, port);
  if (!parsed) return { base: autoBase(detectedIp, port), detected: true };
  return { base: parsed, detected: false };
}

/** Detection fallback. "localhost" is correct for a dev box and harmless. */
function autoBase(detectedIp: string | null, port: number): string {
  const host = detectedIp ?? "localhost";
  return `http://${wrapIfIpv6(host)}:${port}`;
}

/** The operator typed a scheme, so only normalization is needed. */
function fromAbsolute(value: string): string | null {
  try {
    const u = new URL(value);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.hostname) return null;
    // origin drops a default port and normalizes case; pathname carries a
    // prefix like /radio, which must survive — mounts are appended to this.
    return trimSlashes(`${u.origin}${u.pathname}`);
  } catch {
    return null;
  }
}

/** No scheme: `host`, `host:port`, `host/path`, `[::1]:8080`, all allowed. */
function fromBareAuthority(value: string, port: number): string | null {
  if (ILLEGAL.test(value)) return null;

  const slash = value.indexOf("/");
  const authority = slash === -1 ? value : value.slice(0, slash);
  const path = slash === -1 ? "" : value.slice(slash);
  if (!authority) return null;

  const split = splitHostPort(authority);
  if (!split) return null;
  const { host, explicitPort } = split;

  // An explicit port means direct exposure, which means no TLS terminator in
  // front, which means http — regardless of whether the host is a name.
  if (explicitPort !== null) {
    return trimSlashes(`http://${wrapIfIpv6(host)}:${explicitPort}${path}`);
  }

  // A registered domain reaches this box only via DNS someone configured, and
  // that is done with a proxy or tunnel on 443. See the header note.
  if (isRegisteredDomain(host)) {
    return trimSlashes(`https://${host.toLowerCase()}${path}`);
  }

  return trimSlashes(`http://${wrapIfIpv6(host)}:${port}${path}`);
}

/** Split an authority into host and optional port. Handles IPv6 literals. */
function splitHostPort(authority: string): { host: string; explicitPort: number | null } | null {
  // Bracketed IPv6, optionally with a port: [::1] or [::1]:8080
  const bracketed = authority.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracketed) {
    const p = bracketed[2] ? Number(bracketed[2]) : null;
    if (p !== null && !isValidPort(p)) return null;
    return { host: bracketed[1], explicitPort: p };
  }

  // Unbracketed and more than one colon can only be a bare IPv6 address;
  // "::1:8080" is ambiguous and is read as the address, never as a port.
  const colons = authority.split(":").length - 1;
  if (colons > 1) return { host: authority, explicitPort: null };

  if (colons === 1) {
    const [host, portStr] = authority.split(":");
    if (!host) return null;
    if (!/^\d+$/.test(portStr)) return null;
    const p = Number(portStr);
    if (!isValidPort(p)) return null;
    return { host, explicitPort: p };
  }

  return { host: authority, explicitPort: null };
}

/**
 * A name someone had to register and point at this box — as opposed to
 * localhost, a LAN hostname, or an IP literal.
 */
function isRegisteredDomain(host: string): boolean {
  if (IPV4.test(host)) return false;
  if (host.includes(":")) return false; // IPv6
  if (!host.includes(".")) return false; // localhost, or a single-label LAN name
  return /^[a-z0-9.-]+$/i.test(host) && !host.startsWith(".") && !host.endsWith(".");
}

function isValidPort(p: number): boolean {
  return Number.isInteger(p) && p > 0 && p < 65536;
}

/** A bare IPv6 address needs brackets before it can carry a port in a URL. */
function wrapIfIpv6(host: string): string {
  if (host.startsWith("[")) return host;
  return host.includes(":") ? `[${host}]` : host;
}

function trimSlashes(s: string): string {
  return s.replace(/\/+$/, "");
}
