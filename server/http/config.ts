// config.ts — router configuration.
//
// tLib has no config file. Deployment-specific values come from FiveM convars,
// read at boot.
//
// convars:
//   setr tlib_http_port        7777              # the one external port
//   setr tlib_http_host        "0.0.0.0"         # bind address
//   setr tlib_http_public_url  "http://x:7777"   # override the URL handed to clients
//
// The default port is 7777 — tRadio's historical port. tRadio v7 is a hard
// cutover, so every existing customer already has 7777 open in their firewall
// and forwarded in NAT. Reusing it means the upgrade changes paths but not
// networking, which is the half of a migration you cannot talk an operator
// through over Discord.

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

/**
 * Public base URL for the router.
 * Priority: explicit override > resolved public IP > localhost.
 */
export function composeHttpUrl(
  override: string | null,
  publicIp: string | null,
  port: number
): string {
  if (override && override.length > 0) return override.replace(/\/+$/, "");
  const host = publicIp ?? "localhost";
  return `http://${host}:${port}`;
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
