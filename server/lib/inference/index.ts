// Binds the engine registry to FiveM's export surface.
//
// Everything crosses as JSON strings because the callers are a mix of Lua and
// bundled JavaScript and the shapes are small. An empty string is the universal
// "no" — no handle, no match — so no caller has to branch on a type.

import { fExports, fOn, invokingResource } from "./fivem";
import { type AdvertiseRequest, Registry } from "./registry";

const registry = new Registry();

function decode(payload: unknown): AdvertiseRequest | null {
  if (payload && typeof payload === "object") return payload as AdvertiseRequest;
  if (typeof payload !== "string" || payload.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(payload);
    return parsed && typeof parsed === "object" ? (parsed as AdvertiseRequest) : null;
  } catch {
    return null;
  }
}

export function installInference(): void {
  fExports("InferenceAdvertise", (payload: unknown): string => {
    const resource = invokingResource();
    const request = decode(payload);
    if (!resource || !request) return "";
    return registry.advertise(resource, request);
  });

  fExports("InferenceLookup", (capability: unknown, workload: unknown): string => {
    if (typeof capability !== "string" || typeof workload !== "string") return "";
    const found = registry.lookup(invokingResource(), capability, workload);
    return found ? JSON.stringify(found) : "";
  });

  fExports("InferenceWithdraw", (handle: unknown): boolean => {
    if (typeof handle !== "string") return false;
    return registry.withdraw(invokingResource(), handle);
  });

  /** Diagnostics. Reveals ports on loopback only, which is all the registry accepts. */
  fExports("InferenceList", (): string => JSON.stringify(registry.list()));

  // Starting the engines themselves is `server/lib/spawn/`: a separate concern
  // with a separate, gated export surface, because "who is serving which model"
  // and "what may this resource execute" have nothing to do with each other.

  // A resource that stops takes its engines with it. Without this the next
  // consumer adopts a dead endpoint and waits out a timeout to discover it.
  fOn("onResourceStop", (resource: unknown) => {
    if (typeof resource !== "string") return;
    const removed = registry.withdrawAll(resource);
    if (removed > 0) console.log(`[tLib] inference: dropped ${removed} engine(s) from ${resource}`);
  });
}
