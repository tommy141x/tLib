// Router configuration. tLib has no config file; deployment-specific values are
// FiveM convars read at boot:
//
//   set tlib_http_port        7777        # bind a listener on this port
//   set tlib_http_host        "0.0.0.0"   # bind address
//   set tlib_http_public_url  ""          # the address clients should be told
//
// `set`, not `setr`: all three are server-side only through GetConvar, so
// replicating them would only widen what the server tells the world about its
// own networking. The public URL still reaches clients, resolved server-side
// and sent as a value, not as the raw convar.
//
// Binding a listener is opt-in. With neither port nor host set, the only door is
// the FiveM server port ingress (sv_http_ingress.lua), which needs no firewall
// rule, no NAT forward and no convar — so a fresh install works untouched. Set
// either convar and the listener binds exactly as it always has.
//
// tlib_http_public_url is the one an operator has to think about — tLib can't
// know what address reaches it from outside. Unset auto-detects the public IP;
// public-url.ts has the inference rules.
//
// 7777 is tRadio's historical port, which is why it is still what a host-only
// configuration binds: every customer who had tLib binding before already has
// that number open in the firewall and forwarded in NAT.

import { fGetConvar } from "./fivem";

const DEFAULT_PORT = 7777;
const DEFAULT_HOST = "0.0.0.0";

export interface HttpConfig {
  host: string;
  /** null when no listener is wanted; the ingress is then the only door. */
  port: number | null;
  publicUrlOverride: string | null;
  /** Upstream connect + header timeout. Bodies may stream indefinitely. */
  upstreamTimeoutMs: number;
  /** Hard cap on concurrent sockets, to bound socket exhaustion. */
  maxConnections: number;
}

/** A config that binds, which is the only kind `Router` can start. */
export type BoundHttpConfig = HttpConfig & { port: number };

/** `getConvar` is injected only by `config.test.ts`; nothing else passes it. */
export function resolveConfig(getConvar = fGetConvar): HttpConfig {
  const host = strConvar(getConvar, "tlib_http_host", "");
  return {
    host: host || DEFAULT_HOST,
    // A bind address is an instruction to bind: an operator who set only the
    // host has said where the listener goes, not whether to have one.
    port: intConvar(getConvar, "tlib_http_port") ?? (host ? DEFAULT_PORT : null),
    publicUrlOverride: strConvar(getConvar, "tlib_http_public_url", "") || null,
    upstreamTimeoutMs: 30_000,
    maxConnections: 1024,
  };
}

/**
 * null only when the convar is unset. A value that is set but unusable still
 * binds, on the default port: a typo is an operator who wants a listener, and
 * reading it as "no listener" would silently take the port away instead.
 */
function intConvar(getConvar: typeof fGetConvar, name: string): number | null {
  try {
    const raw = getConvar(name, "");
    if (!raw) return null;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 && n < 65536 ? n : DEFAULT_PORT;
  } catch {
    return null;
  }
}

function strConvar(getConvar: typeof fGetConvar, name: string, fallback: string): string {
  try {
    return getConvar(name, fallback);
  } catch {
    return fallback;
  }
}
