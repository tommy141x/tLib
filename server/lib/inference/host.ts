// Starting a resource's own engine binaries on its behalf.
//
// FXServer refuses `spawn` unless the resource is named in an
// `add_unsafe_child_process_permission` line in server.cfg, and the check is
// attributed to whichever resource's runtime made the call — measured, not
// assumed. So a resource that ships local inference needs the operator to add a
// line for it, every one of them needs its own, and a customer dropping in a new
// t* resource gets a feature that silently does not work until they find out
// why.
//
// Doing the spawning here turns that into one line for tLib, forever. Nothing
// else moves: the caller still decides what to run and with which arguments,
// still talks to the engine directly over loopback, and still works alone if
// tLib is absent — it just has to have its own grant in that case.
//
// The rule that keeps the grant honest is that a caller may only launch a
// binary that lives inside its own resource directory, resolved through
// realpath so a symlink cannot point out of it. tLib holding the permission
// must not become "any resource may run anything".

import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { resourcePath } from "./fivem";

export interface SpawnRequest {
  /** Caller-chosen name for a long-lived process, unique within the resource. */
  key?: unknown;
  /** Path to the executable, relative to the calling resource's directory. */
  binary?: unknown;
  args?: unknown;
  /** Working directory, relative to the calling resource. Defaults to its root. */
  cwd?: unknown;
  /** Added to tLib's own environment. `LD_LIBRARY_PATH` is why this exists. */
  env?: unknown;
  /** Written to the child's stdin, which is then closed. One-shot runs only. */
  stdin?: unknown;
}

interface Served {
  resource: string;
  child: ChildProcess;
  pid: number;
  /** Ring of recent output lines; see `output`. */
  lines: OutputLine[];
  /** Sequence number of `lines[0]`, so a reader's cursor survives the discards. */
  first: number;
  exit: number | null;
}

/** Which pipe a line came from, because a warning and a failure read alike. */
export interface OutputLine {
  stream: "stdout" | "stderr";
  text: string;
}

/**
 * Lines kept per served process.
 *
 * Enough for a model loader's progress and the error that follows a bad start,
 * not enough to be a log file. A consumer reading at any sane interval never
 * sees a discard; one that stops reading cannot grow this without bound.
 */
const TAIL_LINES = 200;

interface Job {
  resource: string;
  child: ChildProcess;
  state: "running" | "exited";
  code: number | null;
  error: string;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function environment(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!value || typeof value !== "object") return out;
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === "string") out[name] = raw;
  }
  return out;
}

export class SpawnHost {
  private readonly served = new Map<string, Served>();
  private readonly jobs = new Map<string, Job>();
  private next = 1;

  /**
   * Where a requested path really is, or "" if it is not the caller's to run.
   *
   * realpath rather than a string prefix test, because the containment rule is
   * the only thing standing between "tLib may spawn" and "anyone may spawn
   * anything": a relative segment or a symlink out of the resource would
   * otherwise satisfy a textual check and land somewhere else entirely.
   */
  private contained(resource: string, relative: string): string {
    const root = resourcePath(resource);
    if (!root) return "";
    try {
      const realRoot = fs.realpathSync(root);
      const target = fs.realpathSync(path.resolve(realRoot, relative));
      if (target !== realRoot && !target.startsWith(realRoot + path.sep)) return "";
      return target;
    } catch {
      return "";
    }
  }

  private launch(
    resource: string,
    request: SpawnRequest,
    stdio: "ignore" | ["pipe", "ignore", "ignore"] | ["ignore", "pipe", "pipe"]
  ): { child: ChildProcess } | { error: string } {
    if (!resource) return { error: "the calling resource could not be identified" };
    if (typeof request.binary !== "string" || !request.binary) return { error: "no binary given" };

    const binary = this.contained(resource, request.binary);
    if (!binary) return { error: `${request.binary} is not a file inside ${resource}` };

    let cwd = path.dirname(binary);
    if (typeof request.cwd === "string" && request.cwd) {
      cwd = this.contained(resource, request.cwd);
      if (!cwd) return { error: `cwd ${request.cwd} is not inside ${resource}` };
    }

    try {
      const child = spawn(binary, strings(request.args), {
        cwd,
        env: { ...process.env, ...environment(request.env) },
        stdio,
        // Must die with the server rather than outlive it as an orphan holding
        // a port nothing remembers starting.
        detached: false,
        windowsHide: true,
      });
      return { child };
    } catch (err) {
      return { error: (err as Error).message };
    }
  }

  /**
   * A long-lived process, started at most once per key.
   *
   * Idempotent because the caller's own "is it already running" bookkeeping
   * lives in a different resource that may have restarted since; asking twice
   * has to be free rather than a second copy of a model server.
   */
  serve(resource: string, request: SpawnRequest): string {
    const key = typeof request.key === "string" ? request.key : "";
    if (!key) return JSON.stringify({ error: "no key given" });

    const id = `${resource}:${key}`;
    const running = this.served.get(id);
    if (running?.exit === null) return JSON.stringify({ pid: running.pid });

    // Piped rather than ignored because the caller cannot see this process at
    // all otherwise, and a model server says why it failed on stderr and
    // nowhere else. Both pipes are drained below; an undrained one deadlocks
    // the child on its first write past the buffer.
    const started = this.launch(resource, request, ["ignore", "pipe", "pipe"]);
    if ("error" in started) return JSON.stringify({ error: started.error });

    const pid = started.child.pid ?? 0;
    const entry: Served = { resource, child: started.child, pid, lines: [], first: 0, exit: null };
    this.served.set(id, entry);

    const collect = (stream: "stdout" | "stderr", source: NodeJS.ReadableStream | null) => {
      if (!source) return;
      let pending = "";
      source.on("data", (chunk: Buffer | string) => {
        pending += chunk.toString();
        const split = pending.split(/\r?\n/);
        pending = split.pop() ?? "";
        for (const text of split) {
          if (!text.trim()) continue;
          entry.lines.push({ stream, text });
          if (entry.lines.length > TAIL_LINES) {
            entry.lines.shift();
            entry.first++;
          }
        }
      });
      source.on("error", () => {
        // A broken pipe is the child going away, which `exit` already reports.
      });
    };
    collect("stdout", started.child.stdout);
    collect("stderr", started.child.stderr);

    // The entry outlives the process deliberately: the lines explaining a bad
    // start arrive last, and deleting on exit would throw them away just as the
    // caller notices something is wrong. Cleared by the next serve of this key.
    started.child.on("exit", (code) => {
      entry.exit = code ?? 0;
      if (code) console.log(`[tLib] inference: ${resource}'s ${key} exited with code ${code}`);
    });
    started.child.on("error", (err) => {
      entry.exit = -1;
      entry.lines.push({ stream: "stderr", text: err.message });
      console.log(`[tLib] inference: ${resource}'s ${key} failed — ${err.message}`);
    });
    return JSON.stringify({ pid });
  }

  /**
   * What a served process has said, from a cursor the caller keeps.
   *
   * A cursor rather than "everything since last time" because the caller is in
   * another resource: it may restart, ask twice, or not ask for a minute, and
   * none of those should silently drop the line that explains the failure.
   */
  output(resource: string, key: string, since: number): string {
    const entry = this.served.get(`${resource}:${key}`);
    if (!entry) return JSON.stringify({ lines: [], next: 0, alive: false, code: null });
    const from = Math.max(0, Math.min(entry.lines.length, since - entry.first));
    return JSON.stringify({
      lines: entry.lines.slice(from),
      next: entry.first + entry.lines.length,
      alive: entry.exit === null,
      code: entry.exit,
    });
  }

  unserve(resource: string, key: string): boolean {
    const entry = this.served.get(`${resource}:${key}`);
    if (!entry) return false;
    this.served.delete(`${resource}:${key}`);
    try {
      entry.child.kill();
    } catch {
      // Already gone; the map entry was the only thing left to clean up.
    }
    return true;
  }

  /**
   * A process that runs to completion, reported by polling rather than by event.
   *
   * Polling because the alternative is an event the caller might register for
   * after it fires — a text-to-speech turn that hangs forever is a worse failure
   * than four extra export calls while a sentence renders.
   */
  run(resource: string, request: SpawnRequest): string {
    const wantsStdin = typeof request.stdin === "string";
    const started = this.launch(
      resource,
      request,
      wantsStdin ? ["pipe", "ignore", "ignore"] : "ignore"
    );
    if ("error" in started) return JSON.stringify({ error: started.error });

    const id = `${this.next++}`;
    const job: Job = { resource, child: started.child, state: "running", code: null, error: "" };
    this.jobs.set(id, job);

    started.child.on("exit", (code) => {
      job.state = "exited";
      job.code = code;
    });
    started.child.on("error", (err) => {
      job.state = "exited";
      job.error = err.message;
    });
    if (wantsStdin) {
      try {
        started.child.stdin?.end(request.stdin as string);
      } catch (err) {
        job.error = (err as Error).message;
      }
    }
    return JSON.stringify({ job: id });
  }

  /** Reading a finished job's result also forgets it — nobody asks twice. */
  job(resource: string, id: string): string {
    const entry = this.jobs.get(id);
    if (!entry || entry.resource !== resource) return JSON.stringify({ state: "unknown" });
    if (entry.state === "running") return JSON.stringify({ state: "running" });
    this.jobs.delete(id);
    return JSON.stringify({ state: "exited", code: entry.code, error: entry.error });
  }

  /** Everything a stopping resource left behind. Returns how many were alive. */
  killAll(resource: string): number {
    let killed = 0;
    for (const [id, entry] of this.served) {
      if (entry.resource !== resource) continue;
      if (entry.exit === null) killed += this.end(entry) ? 1 : 0;
      this.served.delete(id);
    }
    for (const [id, entry] of this.jobs) {
      if (entry.resource !== resource) continue;
      if (entry.state === "running") killed += this.end(entry) ? 1 : 0;
      this.jobs.delete(id);
    }
    return killed;
  }

  private end(entry: { child: ChildProcess }): boolean {
    try {
      entry.child.kill();
      return true;
    } catch {
      // Already gone, which is the state this was trying to reach.
      return false;
    }
  }

  /** tLib itself stopping: nothing it started may outlive it. */
  killEverything(): void {
    for (const entry of [...this.served.values(), ...this.jobs.values()]) this.end(entry);
    this.served.clear();
    this.jobs.clear();
  }
}
