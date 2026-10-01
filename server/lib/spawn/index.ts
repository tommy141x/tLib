/**
 * The export surface for spawning, and the lifecycle wiring behind it.
 *
 * Everything crosses as JSON strings because the callers are a mix of Lua,
 * bundled TypeScript and plain CommonJS, and the shapes are small.
 *
 * ## Why this exists
 *
 * FXServer refuses `spawn` unless the *calling* resource is named in an
 * `add_unsafe_child_process_permission` line, and the check is attributed to
 * whichever resource's runtime made the call — measured, not assumed. So every
 * t* resource that ships a local engine needed its own line, and a customer who
 * dropped in a new one got a feature that silently did not work.
 *
 * One line for tLib replaces all of them. That is only an improvement if what
 * sits behind the line is *narrower* than four unrestricted grants, which is the
 * entire job of `catalog.ts` and `gate.ts`: a caller names a declared program,
 * never a path, and tLib builds the command line itself. What tDB could run
 * yesterday was "anything"; what it can run now is `pocketbase`, from inside its
 * own directory, with arguments matching a shape written down in tLib.
 *
 * ## What this does not claim
 *
 * `GetInvokingResource()` identifies the calling resource container and nothing
 * more. A hostile folder named `tDB` passes it, exactly as it passed
 * `add_unsafe_child_process_permission tDB`. Consolidation does not change that
 * and no comment here should suggest it does.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { describeFamily } from "./catalog";
import {
  currentResource,
  fExports,
  fOn,
  invokingResource,
  resourceAuthors,
  resourcePath,
} from "./fivem";
import {
  type Platform,
  type Probes,
  type Refusal,
  type Resolved,
  resolveSpawn,
} from "./gate";
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
  // The one place the real platform is read. Everything downstream takes it as
  // an argument, which is what lets the gate's whole test suite run under both
  // shapes rather than only the one this machine happens to be.
  //
  // Anything that is not Windows is treated as Linux, because those are the two
  // FXServer ships and a third would have no binaries in any catalog entry
  // anyway — it fails at "not present inside <resource>", which names the real
  // problem better than an unsupported-platform error would.
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
 * Says yes once, loudly, and says no once, loudly.
 *
 * Every refusal reaches the console as well as the caller. A caller that
 * swallows the JSON error — and one of them will — otherwise turns a deliberate
 * security refusal into "the feature just does not work", which is the failure
 * mode that costs an evening.
 */
function announce(resource: string, plan: Resolved | Refusal, what: string): void {
  if ("error" in plan) {
    console.log(`[tLib] spawn: refused ${resource}'s ${what} — ${plan.error}`);
    return;
  }
  if (plan.authorWarning) console.log(`[tLib] spawn: ${plan.authorWarning}`);
  console.log(
    `[tLib] spawn: ${resource} → ${plan.program} ${plan.loggable.join(" ")} (cwd ${plan.cwd})`
  );
}

/**
 * Wraps an export so a throw inside it does not reach the caller as `undefined`.
 *
 * FiveM does not propagate an exception across the export boundary: the caller's
 * `exports.tLib.X(...)` simply evaluates to `undefined`, and the first thing it
 * usually does with that is `JSON.parse`, which then reports `"undefined" is not
 * valid JSON`. That message names the symptom and hides the cause — measured
 * here, on the first live run of the probe path — so every export answers with
 * its own failure and writes the real one to the console.
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
  // may spawn. This line is where they find out instead.
  console.log(
    `[tLib] spawn: child processes on behalf of — ${describeFamily().join(" | ")}. ` +
      "One add_unsafe_child_process_permission tLib covers all of them."
  );

  /** Start a long-lived process. Idempotent per key; returns `{ pid }` or `{ error }`. */
  fExports("SpawnServe", guarded("SpawnServe", (payload: unknown): string => {
    const resource = invokingResource();
    const request = decode(payload);
    if (!request) return JSON.stringify({ error: "malformed request" });
    const key = typeof request.key === "string" ? request.key : "";
    // `bytes` is the duplex mode: stdout comes back base64 with nothing dropped
    // and stdin stays open for `SpawnWrite`. It exists for tAI's speech process,
    // which exchanges length-prefixed audio frames rather than lines. It widens
    // the DATA path only — the program, its path and its arguments go through
    // exactly the same gate either way.
    const mode = request.mode === "bytes" ? "bytes" : "lines";
    const plan = resolveSpawn(resource, request, probes);
    announce(resource, plan, `${String(request.program)} (${key})`);
    if ("error" in plan) return JSON.stringify({ error: plan.error });
    return host.serve(plan, resource, key, mode);
  }) as (...args: unknown[]) => string);

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
  fExports("SpawnOutput", guarded("SpawnOutput", (key: unknown, since: unknown): string => {
    if (typeof key !== "string") return JSON.stringify({ lines: [], next: 0, alive: false });
    return host.output(invokingResource(), key, Number(since) || 0);
  }) as (...args: unknown[]) => string);

  /** A one-shot process. Returns `{ job }`; poll `SpawnJob` for the result. */
  fExports("SpawnRun", guarded("SpawnRun", (payload: unknown): string => {
    const resource = invokingResource();
    const request = decode(payload);
    if (!request) return JSON.stringify({ error: "malformed request" });
    const plan = resolveSpawn(resource, request, probes);
    announce(resource, plan, String(request.program));
    if ("error" in plan) return JSON.stringify({ error: plan.error });
    return host.run(plan, resource, typeof request.stdin === "string" ? request.stdin : null);
  }) as (...args: unknown[]) => string);

  fExports("SpawnJob", guarded("SpawnJob", (id: unknown): string => {
    if (typeof id !== "string") return JSON.stringify({ state: "unknown" });
    return host.job(invokingResource(), id);
  }) as (...args: unknown[]) => string);

  fExports("SpawnCancel", (id: unknown): boolean => {
    if (typeof id !== "string") return false;
    return host.cancel(invokingResource(), id);
  });

  /** Diagnostics: what is running, for whom. No paths, no arguments. */
  fExports("SpawnList", guarded("SpawnList", (): string => JSON.stringify(host.list())));

  // ── Reaping ────────────────────────────────────────────────────────────────
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
    const killed = host.killAll(resource);
    if (killed > 0) console.log(`[tLib] spawn: stopped ${killed} process(es) for ${resource}`);
  });
}
