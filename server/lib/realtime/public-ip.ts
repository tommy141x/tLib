// Public-IP discovery; failed attempts must not permanently prevent HTTP readiness.

import * as https from "node:https";

let cached: string | null = null;
let inflight: Promise<string | null> | null = null;

/** Returns the cached public IP, or null if not yet known. */
export function getCachedIP(): string | null {
  return cached;
}

/** Kicks off resolution. Idempotent — subsequent calls return the same promise. */
export function resolvePublicIP(): Promise<string | null> {
  if (cached) return Promise.resolve(cached);
  if (inflight) return inflight;

  inflight = new Promise<string | null>((resolve) => {
    const req = https.get("https://api.ipify.org", { timeout: 5000 }, (res) => {
      let body = "";
      res.on("data", (c) => {
        body += c;
      });
      res.on("end", () => {
        const ip = body.trim();
        cached = isPlausibleIP(ip) ? ip : null;
        resolve(cached);
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  }).finally(() => {
    inflight = null;
  });

  return inflight;
}

function isPlausibleIP(s: string): boolean {
  if (!s || s.length > 45) return false;
  // trivial shape check; ipify returns raw ip
  return /^[0-9a-fA-F:.]+$/.test(s);
}

/** Returns a cancellation function; late HTTP results cannot publish after stop. */
export function detectPublicIP(
  resolved: (ip: string | null) => void,
  runtime = {
    resolve: resolvePublicIP,
    schedule: (fn: () => void, ms: number) => setTimeout(fn, ms),
    cancel: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
  }
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const detect = (attempt: number): void => {
    if (stopped) return;
    runtime.resolve().catch(() => null).then((ip) => {
      if (stopped) return;
      if (ip || attempt >= 5) return resolved(ip);
      timer = runtime.schedule(() => detect(attempt + 1), Math.min(60_000, 5_000 * 2 ** attempt));
    });
  };
  detect(0);
  return () => {
    stopped = true;
    if (timer !== null) runtime.cancel(timer);
  };
}
