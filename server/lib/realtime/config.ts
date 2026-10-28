// config.ts — realtime transport configuration.
//
// Realtime no longer owns a socket. It is a mount on tLib's router (`/rt`,
// see server/http/mounts.ts), so the listen port and bind address are the
// router's — `tlib_http_port` / `tlib_http_host`. The old `tlib_realtime_port`
// and `tlib_realtime_host` convars are gone; setting them now does nothing.
//
// Which means realtime is the one thing the FiveM-server-port ingress cannot
// carry: WebSocket has no upgrade surface there. A server that binds no
// listener has no door for realtime at all, and `composeWsUrl` says so by
// returning null rather than naming a port nothing listens on.
//
// tLib has no config file. Deployment-specific values come from FiveM convars,
// read at boot.
//
// convars:
//   set tlib_realtime_public_url  "ws://host:7777/rt"   # the URL handed to clients
//
// `set`, not `setr`: it is read here, server-side. The resolved URL is sent to
// clients over the wire, so the override itself never needs replicating.

import { REALTIME_MOUNT } from "../http/constants";
import { fGetConvar } from "./fivem";

export interface RealtimeConfig {
  publicUrlOverride: string | null;
  authTimeoutMs: number;
  tokenTtlMs: number;
  maxSessionsPerPlayer: number;
  maxRoomsPerSession: number;
  maxPayloadBytes: number;
  rateLimit: {
    binFramesPerSec: number;
    binBurst: number;
    eventsPerSec: number;
    eventsBurst: number;
  };
}

export function resolveConfig(): RealtimeConfig {
  return {
    publicUrlOverride: strConvar("tlib_realtime_public_url", "") || null,
    authTimeoutMs: 10_000,
    tokenTtlMs: 60_000,
    maxSessionsPerPlayer: 2,
    maxRoomsPerSession: 128,
    maxPayloadBytes: 64 * 1024,
    rateLimit: {
      binFramesPerSec: 120,
      binBurst: 240,
      eventsPerSec: 20,
      eventsBurst: 60,
    },
  };
}

// Public WS URL handed to clients — the router's origin plus the realtime
// mount, e.g. ws://1.2.3.4:7777/rt.
//
// Priority: explicit override > resolved public IP > localhost. An override is
// honoured with no listener too: it is an address the operator arranged, which
// is the one way realtime can be reached behind a proxy of their own.
export function composeWsUrl(
  override: string | null,
  publicIp: string | null,
  port: number | null
): string | null {
  if (override && override.length > 0) return override;
  if (port === null) return null;
  const host = publicIp ?? "localhost";
  return `ws://${host}:${port}${REALTIME_MOUNT}`;
}

function strConvar(name: string, fallback: string): string {
  try {
    return fGetConvar(name, fallback);
  } catch {
    return fallback;
  }
}
