// config.ts — router configuration.
//
// tLib has no config file. Deployment-specific values come from FiveM convars,
// read at boot.
//
// convars:
//   setr tlib_http_port        7777        # the one external port
//   setr tlib_http_host        "0.0.0.0"   # bind address
//   setr tlib_http_public_url  ""          # the address clients should use
//
// tlib_http_public_url is the one operators actually have to think about: the
// router binds a port but cannot know what address reaches it from outside.
// It takes shorthand — "localhost", "192.168.8.141:8080",
// "fivem.example.com" — and completes it. Unset auto-detects the public IP.
// public-url.ts documents the inference rules.
//
// The default port is 7777 — tRadio's historical port. tRadio v7 is a hard
// cutover, so every existing customer already has 7777 open in their firewall
// and forwarded in NAT. Reusing it means the upgrade changes paths but not
// networking, which is the half of a migration you cannot talk an operator
// through over Discord.

import { fGetConvar } from "./fivem";
import { resolvePublicUrl } from "./public-url";

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
 *
 * The convar is shorthand-friendly — "localhost", "1.2.3.4:8080" and
 * "fivem.example.com" are all accepted and completed into a full URL. See
 * public-url.ts for the inference rules and why they are what they are.
 */
export function composeHttpUrl(
  override: string | null,
  publicIp: string | null,
  port: number
): string {
  return resolvePublicUrl(override, publicIp, port).base;
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
