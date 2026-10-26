// Router configuration. tLib has no config file; deployment-specific values are
// FiveM convars read at boot:
//
//   set tlib_http_port        7777        # the one external port
//   set tlib_http_host        "0.0.0.0"   # bind address
//   set tlib_http_public_url  ""          # the address clients should be told
//
// `set`, not `setr`: all three are server-side only through GetConvar, so
// replicating them would only widen what the server tells the world about its
// own networking. The public URL still reaches clients, resolved server-side
// and sent as a value, not as the raw convar.
//
// tlib_http_public_url is the one an operator has to think about — the router
// binds a port but can't know what address reaches it from outside. Unset
// auto-detects the public IP; public-url.ts has the inference rules.
//
// 7777 is tRadio's historical port, kept across the v7 cutover since every
// existing customer already has it open in the firewall and forwarded in NAT.

import { fGetConvar } from "./fivem";

const DEFAULT_PORT = 7777;
const DEFAULT_HOST = "0.0.0.0";

export interface HttpConfig {
  host: string;
  port: number;
  publicUrlOverride: string | null;
  /** Upstream connect + header timeout. Bodies may stream indefinitely. */
  upstreamTimeoutMs: number;
  /** Hard cap on concurrent sockets, to bound socket exhaustion. */
  maxConnections: number;
}

export function resolveConfig(): HttpConfig {
  return {
    host: strConvar("tlib_http_host", DEFAULT_HOST),
    port: intConvar("tlib_http_port", DEFAULT_PORT),
    publicUrlOverride: strConvar("tlib_http_public_url", "") || null,
    upstreamTimeoutMs: 30_000,
    maxConnections: 1024,
  };
}

function intConvar(name: string, fallback: number): number {
  try {
    const raw = fGetConvar(name, "");
    if (!raw) return fallback;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 && n < 65536 ? n : fallback;
  } catch {
    return fallback;
  }
}

function strConvar(name: string, fallback: string): string {
  try {
    return fGetConvar(name, fallback);
  } catch {
    return fallback;
  }
}
