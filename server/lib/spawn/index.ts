/**
 * The export surface for spawning, and the lifecycle wiring behind it.
 *
 * Everything crosses as JSON strings because the callers are a mix of Lua,
 * bundled TypeScript and plain CommonJS, and the shapes are small.
 *
 * FXServer attributes its `spawn` permission check to the CALLING resource, so
 * every t* resource shipping a local engine needed its own
 * `add_unsafe_child_process_permission` line. One line for tLib replaces them,
 * and that is only an improvement because what sits behind it is NARROWER: see
 * catalog.ts and docs/internal/spawn-gate.md.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { describeFamily } from "./catalog";
import {
  currentResource,
  fEmit,
  fExports,
  fOn,
  invokingResource,
  resourceAuthors,
  resourcePath,
} from "./fivem";
import { type Platform, type Probes, type Refusal, type Resolved, resolveSpawn } from "./gate";
import { SpawnHost } from "./host";

const host = new SpawnHost();

const probes: Probes = {
  resourcePath,
  realpath: (target) => fs.realpathSync(target),
  isFile: (target) => {
    try {
      return fs.statSync(target).isFile();
    } catch {
      return false;
    }
  },
  sha256: (target) => crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex"),
  authors: resourceAuthors,
  // The one place the real platform is read; everything downstream takes it as an
  // argument, which is what lets the gate's suite run under both shapes. Anything
  // that is not Windows is treated as Linux -- a third platform has no binaries
  // in any catalog entry and fails at "not present inside <resource>".
  platform: () => (process.platform === "win32" ? "win32" : "linux") as Platform,
  join: (...parts) => path.join(...parts),
  resolve: (...parts) => path.resolve(...parts),
  sep: path.sep,
};

function decode(payload: unknown): Record<string, unknown> | null {
  if (payload && typeof payload === "object") return payload as Record<string, unknown>;
  if (typeof payload !== "string" || payload.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(payload);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Says yes once, loudly, and says no once, loudly. Every refusal reaches the
 * console as well as the caller: a caller that swallows the JSON error -- and one
 * of them will -- otherwise turns a deliberate security refusal into "the feature
 * just does not work".
 */
const announced = new Set<string>();

function announce(resource: string, plan: Resolved | Refusal, what: string): void {
  if ("error" in plan) {
    console.log(`[tLib] spawn: refused ${resource}'s ${what} — ${plan.error}`);
    return;
  }
  if (plan.authorWarning) console.log(`[tLib] spawn: ${plan.authorWarning}`);

  // Once per (resource, program), not per invocation: tDB runs the same binary
  // four times at boot -- update, superuser upsert, migrate, serve -- and the
  // fourth copy of a sentence does not make it louder.
  //
  // Keyed on the PROGRAM, not the arguments, so a second program or a second
  // resource is still a new fact and still announces. The refusal branch above
  // is never deduplicated.
  const key = `${resource}\u0000${plan.program}`;
  if (announced.has(key)) return;
  announced.add(key);

  // Still says yes, once, per the contract above -- but WITHOUT the argument
  // list and the absolute cwd. Those made each line ~200 characters, and tDB
  // alone spawns four times at boot (update, superuser upsert, migrate, serve),
  // so the single noisiest thing in a startup log was tLib narrating its own
  // plumbing in full. The program and the resource are what an operator needs
  // to see; the arguments are a debugging detail, and `plan` is already
  // reachable from the gate's own tests and docs/internal/spawn-gate.md.
  //
  // The REFUSAL branch above is deliberately untouched and stays verbatim.
  // A refusal that is quiet reads as "the feature just does not work", which is
  // the exact failure this function's docstring exists to prevent.
  console.log(`[tLib] spawn: ${resource} → ${plan.program}`);
}

/**
 * Wraps an export so a throw inside it does not reach the caller as `undefined`.
 * FiveM does not propagate an exception across the export boundary, and the
 * caller's first `JSON.parse` then reports `"undefined" is not valid JSON` --
 * naming the symptom and hiding the cause.
 */
function guarded(name: string, fn: (...args: unknown[]) => string): (...args: unknown[]) => string {
  return (...args: unknown[]): string => {
    try {
      return fn(...args);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.log(`[tLib] spawn: ${name} failed — ${error.stack ?? error.message}`);
      return JSON.stringify({ error: `tLib's ${name} failed: ${error.message}` });
    }
  };
}

export function installSpawn(): void {
  // The allowlist is hardcoded, so server.cfg no longer tells an operator who
  // may spawn. This is still where they find out -- but it is now a ROW IN
  // tLib'S BANNER rather than a separate line above it, because it is a static
  // startup fact and that is what the banner is for. The intent is unchanged:
  // the catalogue has to be visible somewhere an operator will actually look.
  //
  // DEFERRED BY A TICK, and it does not work without that. `installSpawn()`
  // runs while this bundle is loading, which is BEFORE sv_main.lua calls the
  // version check and subscribes to this event -- so emitting inline fired it
  // into nothing and the row silently never appeared. Measured: the `Hub:` row
  // landed and `Spawns:` did not, because the hub becomes ready later and this
  // is known immediately. Being early is what broke it.
  setTimeout(() => {
    fEmit(
      "tlib:vcInfo:spawns",
      `${describeFamily().join(" | ")} (one add_unsafe_child_process_permission tLib covers all)`
    );
  }, 0);

  /** Start a long-lived process. Idempotent per key; returns `{ pid }` or `{ error }`. */
  fExports(
    "SpawnServe",
    guarded("SpawnServe", (payload: unknown): string => {
      const resource = invokingResource();
      const request = decode(payload);
      if (!request) return JSON.stringify({ error: "malformed request" });
      const key = typeof request.key === "string" ? request.key : "";
      // `bytes` is the duplex mode, for tAI's speech process: it widens the DATA
      // path only, and the program, path and arguments go through the same gate.
      const mode = request.mode === "bytes" ? "bytes" : "lines";
      const plan = resolveSpawn(resource, request, probes);
      announce(resource, plan, `${String(request.program)} (${key})`);
      if ("error" in plan) return JSON.stringify({ error: plan.error });
      return host.serve(plan, resource, key, mode);
    }) as (...args: unknown[]) => string
  );

  /** Writes base64 bytes to a duplex child's stdin. `bytes` mode only. */
  fExports("SpawnWrite", (key: unknown, data: unknown): boolean => {
    if (typeof key !== "string" || typeof data !== "string") return false;
    return host.write(invokingResource(), key, data);
  });

  fExports("SpawnUnserve", (key: unknown): boolean => {
    if (typeof key !== "string") return false;
    return host.unserve(invokingResource(), key);
  });

  /** Lines a served process has written, plus whether it is still alive. */
  fExports(
    "SpawnOutput",
    guarded("SpawnOutput", (key: unknown, since: unknown): string => {
      if (typeof key !== "string") return JSON.stringify({ lines: [], next: 0, alive: false });
      return host.output(invokingResource(), key, Number(since) || 0);
    }) as (...args: unknown[]) => string
  );

  /** A one-shot process. Returns `{ job }`; poll `SpawnJob` for the result. */
  fExports(
    "SpawnRun",
    guarded("SpawnRun", (payload: unknown): string => {
      const resource = invokingResource();
      const request = decode(payload);
      if (!request) return JSON.stringify({ error: "malformed request" });
      const plan = resolveSpawn(resource, request, probes);
      announce(resource, plan, String(request.program));
      if ("error" in plan) return JSON.stringify({ error: plan.error });
      return host.run(plan, resource, typeof request.stdin === "string" ? request.stdin : null);
    }) as (...args: unknown[]) => string
  );

  fExports(
    "SpawnJob",
    guarded("SpawnJob", (id: unknown): string => {
      if (typeof id !== "string") return JSON.stringify({ state: "unknown" });
      return host.job(invokingResource(), id);
    }) as (...args: unknown[]) => string
  );

  fExports("SpawnCancel", (id: unknown): boolean => {
    if (typeof id !== "string") return false;
    return host.cancel(invokingResource(), id);
  });

  /** Diagnostics: what is running, for whom. No paths, no arguments. */
  fExports(
    "SpawnList",
    guarded("SpawnList", (): string => JSON.stringify(host.list()))
  );

  // Reaping
  //
  // The feature, not an afterthought. See host.ts: a child started here belongs
  // to tLib's VM and will not die with its owner unless this fires.
  fOn("onResourceStop", (resource: unknown) => {
    if (typeof resource !== "string") return;
    if (resource === currentResource()) {
      // tLib going down. Everything it is holding open on someone else's behalf
      // goes with it, or the restart finds its own ports held by its children.
      const killed = host.killEverything();
      if (killed > 0) console.log(`[tLib] spawn: stopped ${killed} process(es) on shutdown`);
      return;
    }
    // Forget what was announced for it, or the dedupe above makes every spawn
    // after a resource's first restart silent for the rest of tLib's life --
    // a quiet grant being the thing announce() exists to prevent.
    for (const key of announced) {
      if (key.startsWith(`${resource}\u0000`)) announced.delete(key);
    }

    // Silent. Reaping a stopped resource's children is bookkeeping that always
    // happens; tLib's OWN shutdown above still says so, because there the
    // children outliving it is the failure this exists to prevent.
    host.killAll(resource);
  });
}
