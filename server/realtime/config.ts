// config.ts — realtime transport configuration.
//
// tLib has no config file. Deployment-specific values come from FiveM convars,
// read at boot. No convars set = production defaults (port 30125, ipify-resolved
// public IP). Developers doing local testing set them in their own server.cfg.
//
// convars:
//   setr tlib_realtime_port        30125                    # listen port
//   setr tlib_realtime_host        "0.0.0.0"                # bind address
//   setr tlib_realtime_public_url  "ws://localhost:7777"    # override the URL handed to clients

import { fGetConvar } from "./fivem";

const DEFAULT_PORT = 30125;
const DEFAULT_HOST = "0.0.0.0";

export interface RealtimeConfig {
  host: string;
  port: number;
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
  const port = intConvar("tlib_realtime_port", DEFAULT_PORT);
  const host = strConvar("tlib_realtime_host", DEFAULT_HOST);
  const publicUrlOverride = strConvar("tlib_realtime_public_url", "") || null;
  return {
    host,
    port,
    publicUrlOverride,
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

// Public WS URL handed to clients.
// Priority: explicit override > resolved public IP > localhost.
export function composeWsUrl(
  override: string | null,
  publicIp: string | null,
  port: number
): string {
  if (override && override.length > 0) return override;
  const host = publicIp ?? "localhost";
  return `ws://${host}:${port}`;
}

function intConvar(name: string, fallback: number): number {
  try {
    const raw = fGetConvar(name, "");
    if (!raw) return fallback;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
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
