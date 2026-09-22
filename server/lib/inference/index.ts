// Binds the engine registry to FiveM's export surface.
//
// Everything crosses as JSON strings because the callers are a mix of Lua and
// bundled JavaScript and the shapes are small. An empty string is the universal
// "no" — no handle, no match — so no caller has to branch on a type.

import { currentResource, fExports, fOn, invokingResource } from "./fivem";
import { SpawnHost, type SpawnRequest } from "./host";
import { type AdvertiseRequest, Registry } from "./registry";

const registry = new Registry();
const host = new SpawnHost();

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

  // ── Spawning on a caller's behalf ───────────────────────────────────────────
  //
  // So that `add_unsafe_child_process_permission tLib` is the only line an
  // operator ever writes, however many t* resources ship local inference.

  fExports("InferenceServe", (payload: unknown): string => {
    const request = decode(payload) as SpawnRequest | null;
    if (!request) return JSON.stringify({ error: "malformed request" });
    return host.serve(invokingResource(), request);
  });

  fExports("InferenceUnserve", (key: unknown): boolean => {
    if (typeof key !== "string") return false;
    return host.unserve(invokingResource(), key);
  });

  /** Lines a served process has written, plus whether it is still alive. */
  fExports("InferenceOutput", (key: unknown, since: unknown): string => {
    if (typeof key !== "string") return JSON.stringify({ lines: [], next: 0, alive: false });
    return host.output(invokingResource(), key, Number(since) || 0);
  });

  fExports("InferenceRun", (payload: unknown): string => {
    const request = decode(payload) as SpawnRequest | null;
    if (!request) return JSON.stringify({ error: "malformed request" });
    return host.run(invokingResource(), request);
  });

  fExports("InferenceJob", (id: unknown): string => {
    if (typeof id !== "string") return JSON.stringify({ state: "unknown" });
    return host.job(invokingResource(), id);
  });

  // A resource that stops takes its engines with it. Without this the next
  // consumer adopts a dead endpoint and waits out a timeout to discover it.
  fOn("onResourceStop", (resource: unknown) => {
    if (typeof resource !== "string") return;
    if (resource === currentResource()) {
      // tLib going down: everything it is holding open on someone else's behalf
      // goes with it, or a restart finds its own ports occupied by its children.
      host.killEverything();
      return;
    }
    const removed = registry.withdrawAll(resource);
    if (removed > 0) console.log(`[tLib] inference: dropped ${removed} engine(s) from ${resource}`);
    const killed = host.killAll(resource);
    if (killed > 0) console.log(`[tLib] inference: stopped ${killed} process(es) for ${resource}`);
  });
}
