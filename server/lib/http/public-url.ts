// The URL clients are told to use. A host cannot work out what address reaches
// it from outside -- NAT, a tunnel, a proxy and a bare WAN IP all differ, and
// most routers do not hairpin -- so the operator states it:
//
//   set tlib_http_public_url "fivem.example.com"
//
// Unset means detect the public IP and append the router's port. A scheme or an
// explicit port is always honoured; the rest is inferred from the host's shape:
//
//   (unset)                   http://<detected-ip>:<port>
//   localhost                 http://localhost:<port>
//   192.168.8.141             http://192.168.8.141:<port>
//   192.168.8.141:8080        http://192.168.8.141:8080
//   fivem.example.com         https://fivem.example.com
//   http://fivem.example.com  http://fivem.example.com
//   https://example.com/radio https://example.com/radio
//
// A registered name with no port becomes https with no port: a name reaches a
// FiveM box only because someone pointed DNS at it, which means a tunnel or
// proxy terminating TLS on 443, so :7777 would be wrong every time. An IP
// literal is the reverse -- no certificate fits a bare IP -- so it stays direct
// on the router's port.

/** A parsed public base URL, ready to have a mount path appended. */
export interface PublicUrl {
  /** Full base, no trailing slash — e.g. "https://example.com/radio". */
  base: string;
  /** True when this came from IP detection: no value was set, or the one set was not used. */
  detected: boolean;
  /** True when a value WAS set and not used: unparseable, or an address no host can have. */
  rejected: boolean;
}

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
// Anything that cannot sit in an authority. Catches a pasted "ip:port (note)".
const ILLEGAL = /[\s<>"'\\^`{|}]/;

// What a docs example looks like once an operator has pasted it unedited: the `your-...`
// words the install docs used, the names RFC 2606 reserves, and the three blocks RFC 5737
// reserves for documentation. None can reach a server, so none is an answer.
const PLACEHOLDER_NAME =
  /^(?:your[-_.]?(?:server|ip|domain|address|host|public)[-_a-z0-9.]*|(?:[a-z0-9-]+\.)*example\.(?:com|org|net))$/i;
const DOCUMENTATION_IPV4 = /^(?:192\.0\.2|198\.51\.100|203\.0\.113)\.\d{1,3}$/;

/** True for a host that only ever appears in documentation. */
export function isPlaceholderHost(host: string): boolean {
  return PLACEHOLDER_NAME.test(host) || DOCUMENTATION_IPV4.test(host);
}

/**
 * The Hub row of tLib's startup banner. A detected address names itself and the convar
 * that overrides it: the host in it is a guess, and a wrong guess surfaces much later as a
 * CORS refusal far from the cause. Nothing else is appended — the hub row once suggested
 * `tlib_http_port 7777`, which on a host that never allocated 7777 binds a dead socket.
 */
export function hubRow(address: string, detected: boolean): string {
  return detected
    ? `${address} (detected — set tlib_http_public_url if players reach you another way)`
    : address;
}

/** The warning for a `tlib_http_public_url` that was set and could not be used. */
export function rejectedOverrideNotice(value: string): string {
  return (
    `tlib_http_public_url "${value}" is not an address tLib can use (a placeholder from the ` +
    `docs, or not a web address), so tLib is detecting this server's public IP instead. Set it ` +
    `to the address players type, such as "http://<your server's IP>:<your game port>" or ` +
    `"https://radio.<your domain>".`
  );
}

/**
 * `raw` is the convar verbatim; `detectedIp` is null when detection failed or
 * has not landed. Never throws — an unparseable value falls back to detection,
 * since a typo should not take the hub down, and a possibly-unreachable URL
 * beats a broken one. A placeholder is treated as unparseable: printing
 * `http://your-server-address:7777` as the panel's address is a confident lie, where
 * a detected address at least says it is a guess.
 */
export function resolvePublicUrl(
  raw: string | null,
  detectedIp: string | null,
  port: number
): PublicUrl {
  const value = (raw ?? "").trim();
  if (!value) return { base: autoBase(detectedIp, port), detected: true, rejected: false };

  const parsed = SCHEME.test(value) ? fromAbsolute(value) : fromBareAuthority(value, port);
  if (!parsed || isPlaceholderHost(new URL(parsed).hostname)) {
    return { base: autoBase(detectedIp, port), detected: true, rejected: true };
  }
  return { base: parsed, detected: false, rejected: false };
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
    // origin normalizes and drops a default port; pathname carries a prefix like
    // /radio, which must survive since mounts are appended to this.
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

  // An explicit port means direct exposure, so no TLS terminator, so http --
  // whether or not the host is a name.
  if (explicitPort !== null) {
    return trimSlashes(`http://${wrapIfIpv6(host)}:${explicitPort}${path}`);
  }

  if (isRegisteredDomain(host)) {
    return trimSlashes(`https://${host.toLowerCase()}${path}`);
  }

  return trimSlashes(`http://${wrapIfIpv6(host)}:${port}${path}`);
}

/** Split an authority into host and optional port. Handles IPv6 literals. */
function splitHostPort(authority: string): { host: string; explicitPort: number | null } | null {
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

/** A name someone registered, as opposed to localhost, a LAN name or an IP. */
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
