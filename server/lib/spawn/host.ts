/**
 * The process table: what tLib started, for whom, and how it gets reaped.
 *
 * This is the half of the consolidation that is an engineering risk rather than
 * a security one. Before it, a child died with its owner's VM for free — stop
 * tDB and PocketBase went with it, because PocketBase was tDB's child. Started
 * from tLib's VM it is tLib's child, and stopping tDB does nothing to it unless
 * something here does it deliberately. An orphaned PocketBase holds its HTTP
 * port and its SQLite data directory, and the next start fails as a bind error
 * or a locked database — a failure that reads like configuration and is not.
 *
 * So every child is filed under the resource that asked for it, and there are
 * exactly three ways one ends:
 *
 *  - the owner stops or restarts → `killAll(owner)` from `onResourceStop`;
 *  - the owner asks → `unserve`;
 *  - tLib stops or restarts → `killEverything()`, because a restart that left
 *    them running would find its own ports held by its own children.
 *
 * A caller restarting is **kill-and-respawn**, not reuse. `onResourceStop` fires
 * before the restarted copy's `onResourceStart`, so the old engine is signalled
 * and waited for before the new copy asks for one. Reuse was the alternative and
 * was rejected: the new copy may have different configuration — a different
 * model, a different context size, a different port — and adopting a process
 * started under the old one is how you get a server that is silently running
 * yesterday's settings.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { ensureExecutable } from "./executable";
import type { Resolved } from "./gate";

/** Which pipe a line came from, because a warning and a failure read alike. */
export interface OutputLine {
  stream: "stdout" | "stderr";
  text: string;
}

/**
 * Lines kept per process.
 *
 * Enough for a model loader's progress and the error that follows a bad start,
 * not enough to be a log file. A consumer reading at any sane interval never
 * sees a discard; one that stops reading cannot grow this without bound.
 */
const TAIL_LINES = 200;

/** Cap on what a one-shot's stdout may accumulate before it is truncated. */
const JOB_OUTPUT_LIMIT = 64 * 1024;

/**
 * Unread bytes a duplex child may have queued before it is killed.
 *
 * Not a discard, deliberately. The one duplex consumer reads a length-prefixed
 * frame stream, where dropping bytes in the middle does not lose a chunk — it
 * desynchronises the stream, and every frame after that is garbage that decodes
 * as audio. Killing the child and saying why is recoverable; a silent gap is
 * not. 32 MB is roughly a minute of the widest thing the sidecar sends, so
 * reaching it means the reader has stopped, not that it is behind.
 */
const DUPLEX_BACKLOG_LIMIT = 32 * 1024 * 1024;

/** SIGTERM, then this long, then SIGKILL. */
const KILL_GRACE_MS = 5_000;

interface Served {
  resource: string;
  program: string;
  child: ChildProcess;
  pid: number;
  /**
   * `lines` — stdout and stderr split into text lines, kept in a ring.
   * `bytes` — stdout is a binary stream handed back base64 with nothing dropped,
   *           and stdin stays open for `write`. stderr is still lines.
   */
  mode: "lines" | "bytes";
  lines: OutputLine[];
  /** Sequence number of `lines[0]`, so a reader's cursor survives the discards. */
  first: number;
  /** Base64 stdout chunks, in order, byte mode only. Never discarded. */
  chunks: string[];
  /** Sequence number of `chunks[0]`, which only advances as a reader consumes. */
  chunkFirst: number;
  /** Bytes currently held in `chunks`, against DUPLEX_BACKLOG_LIMIT. */
  backlog: number;
  exit: number | null;
}

interface Job {
  resource: string;
  program: string;
  child: ChildProcess;
  state: "running" | "exited";
  code: number | null;
  stdout: string;
  stderr: string;
  error: string;
}

export type HostLog = (message: string) => void;

export class SpawnHost {
  private readonly served = new Map<string, Served>();
  private readonly jobs = new Map<string, Job>();
  private next = 1;

  constructor(private readonly log: HostLog = (m) => console.log(m)) {}

  private launch(
    plan: Resolved,
    stdio: "ignore" | ["pipe", "pipe", "pipe"] | ["ignore", "pipe", "pipe"]
  ): { child: ChildProcess } | { error: string } {
    // Before the spawn and not before the plan, because `plan.binary` is
    // whatever is actually exec'd — the program on a glibc host, the bundled
    // loader on a host that needs one — and only this side of the gate knows
    // which it ended up being. See executable.ts for why a release arrives
    // without the bit at all.
    ensureExecutable(plan.binary);
    try {
      const child = spawn(plan.binary, plan.argv, {
        cwd: plan.cwd,
        env: { ...process.env, ...plan.env },
        stdio,
        // No shell, ever. With `shell: true` the argv would be re-parsed by cmd
        // or sh and every value in it would become quotable — which is the one
        // way the argument matching in gate.ts could be worked around.
        shell: false,
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
  serve(
    plan: Resolved,
    resource: string,
    key: string,
    mode: "lines" | "bytes" = "lines"
  ): string {
    if (!key) return JSON.stringify({ error: "no key given" });

    const id = `${resource}:${key}`;
    const running = this.served.get(id);
    if (running?.exit === null) return JSON.stringify({ pid: running.pid });

    // Piped rather than ignored because the caller cannot see this process at
    // all otherwise, and a model server says why it failed on stderr and
    // nowhere else. Both pipes are drained below; an undrained one deadlocks
    // the child on its first write past the buffer. stdin is piped only in
    // duplex mode — an open stdin nothing writes to keeps a handle alive across
    // shutdown.
    const started = this.launch(
      plan,
      mode === "bytes" ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"]
    );
    if ("error" in started) return JSON.stringify({ error: started.error });

    const pid = started.child.pid ?? 0;
    const entry: Served = {
      resource,
      program: plan.program,
      child: started.child,
      pid,
      mode,
      lines: [],
      first: 0,
      chunks: [],
      chunkFirst: 0,
      backlog: 0,
      exit: null,
    };
    this.served.set(id, entry);

    const collectLines = (stream: "stdout" | "stderr", source: NodeJS.ReadableStream | null) => {
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

    /**
     * Byte-exact stdout for a duplex child.
     *
     * base64 rather than a string, because the payload is audio: any text
     * decoding of it is lossy, and the consumer is reading length-prefixed
     * frames where a single wrong byte poisons everything after it.
     */
    const collectBytes = (source: NodeJS.ReadableStream | null) => {
      if (!source) return;
      source.on("data", (chunk: Buffer | string) => {
        const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        entry.chunks.push(buffer.toString("base64"));
        entry.backlog += buffer.length;
        if (entry.backlog > DUPLEX_BACKLOG_LIMIT) {
          entry.lines.push({
            stream: "stderr",
            text: `killed: ${DUPLEX_BACKLOG_LIMIT} bytes of output went unread`,
          });
          this.end(entry.child);
        }
      });
      source.on("error", () => {
        // The child going away, which `exit` already reports.
      });
    };

    if (mode === "bytes") collectBytes(started.child.stdout);
    else collectLines("stdout", started.child.stdout);
    collectLines("stderr", started.child.stderr);
    // stdin needs one too, and it is the easiest to forget because nothing reads
    // it. Killing a child makes the next write EPIPE, and an `error` event with
    // no listener is not a rejected promise — it is an uncaught exception thrown
    // from a native callback, which in fxserver takes the runtime with it.
    started.child.stdin?.on("error", () => {
      // The child has gone. `exit` reports that, and the caller learns it from
      // the next `output`.
    });

    // The entry outlives the process deliberately: the lines explaining a bad
    // start arrive last, and deleting on exit would throw them away just as the
    // caller notices something is wrong. Cleared by the next serve of this key.
    started.child.on("exit", (code) => {
      entry.exit = code ?? 0;
      if (code) this.log(`[tLib] spawn: ${resource}'s ${key} exited with code ${code}`);
    });
    started.child.on("error", (err) => {
      entry.exit = -1;
      entry.lines.push({ stream: "stderr", text: err.message });
      this.log(`[tLib] spawn: ${resource}'s ${key} failed — ${err.message}`);
    });
    return JSON.stringify({ pid });
  }

  /**
   * Writes to a duplex child's stdin. `data` is base64, for the same reason the
   * output is: the frames are binary and a string round-trip would corrupt them.
   */
  write(resource: string, key: string, data: string): boolean {
    const entry = this.served.get(`${resource}:${key}`);
    if (entry?.mode !== "bytes" || entry.exit !== null) return false;
    try {
      return entry.child.stdin?.write(Buffer.from(data, "base64")) !== undefined;
    } catch {
      // A closed pipe is the child having gone; the caller learns that from the
      // next `output`, which reports `alive: false` along with any last words.
      return false;
    }
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
    if (!entry) {
      return JSON.stringify({ lines: [], chunks: [], next: 0, alive: false, code: null });
    }

    if (entry.mode === "bytes") {
      // The cursor addresses chunks here, and consuming them frees the backlog.
      // Nothing is dropped on tLib's side: a reader that falls far enough behind
      // gets its child killed with a reason rather than a hole in its stream.
      const start = Math.max(0, Math.min(entry.chunks.length, since - entry.chunkFirst));
      const chunks = entry.chunks.slice(start);
      const consumed = entry.chunks.length;
      for (let i = 0; i < consumed; i++) {
        const chunk = entry.chunks[i];
        if (chunk) entry.backlog -= Math.floor((chunk.length * 3) / 4);
      }
      entry.chunkFirst += consumed;
      entry.chunks = [];
      if (entry.backlog < 0) entry.backlog = 0;
      // stderr is drained rather than cursored: it is log text, the one consumer
      // prints it, and a second cursor to keep would be a second thing to get
      // wrong in the middle of an audio stream.
      const stderr = entry.lines.map((line) => line.text);
      entry.lines = [];
      entry.first = 0;
      return JSON.stringify({
        chunks,
        next: entry.chunkFirst,
        stderr,
        alive: entry.exit === null,
        code: entry.exit,
      });
    }

    const from = Math.max(0, Math.min(entry.lines.length, since - entry.first));
    return JSON.stringify({
      lines: entry.lines.slice(from),
      next: entry.first + entry.lines.length,
      alive: entry.exit === null,
      code: entry.exit,
    });
  }

  unserve(resource: string, key: string): boolean {
    const id = `${resource}:${key}`;
    const entry = this.served.get(id);
    if (!entry) return false;
    this.served.delete(id);
    this.end(entry.child);
    return true;
  }

  /**
   * A process that runs to completion, reported by polling rather than by event.
   *
   * Polling because the alternative is an event the caller might register for
   * after it fires — a text-to-speech turn that hangs forever is a worse failure
   * than four extra export calls while a sentence renders.
   */
  run(plan: Resolved, resource: string, stdin: string | null): string {
    const started = this.launch(plan, ["pipe", "pipe", "pipe"]);
    if ("error" in started) return JSON.stringify({ error: started.error });

    const id = `${this.next++}`;
    const job: Job = {
      resource,
      program: plan.program,
      child: started.child,
      state: "running",
      code: null,
      stdout: "",
      stderr: "",
      error: "",
    };
    this.jobs.set(id, job);

    // Both pipes are read even when the caller wants neither. An unread pipe
    // deadlocks the child at ~64 KB, and the symptom is a silent freeze rather
    // than an error — `pocketbase update` on a slow link is exactly the shape
    // that hits it.
    const absorb = (source: NodeJS.ReadableStream | null, into: "stdout" | "stderr") => {
      if (!source) return;
      source.on("data", (chunk: Buffer | string) => {
        if (job[into].length >= JOB_OUTPUT_LIMIT) return;
        job[into] += chunk.toString();
      });
      source.on("error", () => {
        // The child going away, which `exit` already reports.
      });
    };
    absorb(started.child.stdout, "stdout");
    absorb(started.child.stderr, "stderr");

    started.child.on("exit", (code) => {
      job.state = "exited";
      job.code = code;
    });
    started.child.on("error", (err) => {
      job.state = "exited";
      job.error = err.message;
    });
    if (stdin !== null) {
      try {
        started.child.stdin?.end(stdin);
      } catch (err) {
        job.error = (err as Error).message;
      }
    } else {
      started.child.stdin?.end();
    }
    return JSON.stringify({ job: id });
  }

  /** Reading a finished job's result also forgets it — nobody asks twice. */
  job(resource: string, id: string): string {
    const entry = this.jobs.get(id);
    if (!entry || entry.resource !== resource) return JSON.stringify({ state: "unknown" });
    if (entry.state === "running") return JSON.stringify({ state: "running" });
    this.jobs.delete(id);
    return JSON.stringify({
      state: "exited",
      code: entry.code,
      stdout: entry.stdout,
      stderr: entry.stderr,
      error: entry.error,
    });
  }

  /** Kills a running job early. Used when the caller's request is aborted. */
  cancel(resource: string, id: string): boolean {
    const entry = this.jobs.get(id);
    if (!entry || entry.resource !== resource) return false;
    if (entry.state === "running") this.end(entry.child);
    return true;
  }

  /** Everything a stopping resource left behind. Returns how many were alive. */
  killAll(resource: string): number {
    let killed = 0;
    for (const [id, entry] of this.served) {
      if (entry.resource !== resource) continue;
      if (entry.exit === null && this.end(entry.child)) killed++;
      this.served.delete(id);
    }
    for (const [id, entry] of this.jobs) {
      if (entry.resource !== resource) continue;
      if (entry.state === "running" && this.end(entry.child)) killed++;
      this.jobs.delete(id);
    }
    return killed;
  }

  /**
   * SIGTERM now, SIGKILL if it is still there after the grace period.
   *
   * The escalation is the point. A llama-server mid-load ignores SIGTERM long
   * enough that "killed" and "gone" are different facts, and the caller's next
   * start races the old process for the port. The timer is unref'd so it cannot
   * hold the runtime open during a shutdown.
   */
  private end(child: ChildProcess, escalate = true): boolean {
    let signalled = false;
    try {
      child.kill("SIGTERM");
      signalled = true;
    } catch {
      // Already gone, which is the state this was trying to reach.
    }
    if (!signalled || child.exitCode !== null || !escalate) return signalled;
    const timer = setTimeout(() => {
      try {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      } catch {
        // Gone in the meantime.
      }
    }, KILL_GRACE_MS);
    timer.unref?.();
    return true;
  }

  /**
   * tLib itself stopping: nothing it started may outlive it.
   *
   * No SIGKILL escalation here, unlike every other path. The escalation is a
   * five-second timer, and this runs from tLib's own `onResourceStop` — so the
   * timer would be scheduled inside a runtime that is about to be destroyed and
   * would fire, if it fired at all, into a dead one. Nothing catches that. The
   * signal already sent is what these children get; on Windows it is a
   * `TerminateProcess` and is unconditional anyway, and on Linux a survivor is
   * caught by each product's own PID guard on the next start, which is the case
   * those guards exist for.
   */
  killEverything(): number {
    let killed = 0;
    for (const entry of this.served.values()) {
      if (entry.exit === null && this.end(entry.child, false)) killed++;
    }
    for (const entry of this.jobs.values()) {
      if (entry.state === "running" && this.end(entry.child, false)) killed++;
    }
    this.served.clear();
    this.jobs.clear();
    return killed;
  }

  /** Diagnostics for the `tlib spawn` console command. */
  list(): { resource: string; program: string; key: string; pid: number; alive: boolean }[] {
    const out: { resource: string; program: string; key: string; pid: number; alive: boolean }[] =
      [];
    for (const [id, entry] of this.served) {
      out.push({
        resource: entry.resource,
        program: entry.program,
        key: id.slice(entry.resource.length + 1),
        pid: entry.pid,
        alive: entry.exit === null,
      });
    }
    return out;
  }
}
