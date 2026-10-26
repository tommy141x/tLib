/**
 * Reaping, with real processes. Mocks prove nothing here: the claim under test
 * is "a child started from tLib's VM actually dies when its owner stops," and
 * that's only visible with something really running. These spawn the test
 * runner itself and check the PID with signal 0; `host.ts` never consults the
 * catalog, so a harmless sleeper stands in for an engine.
 *
 * Runs only on whichever OS the suite runs on — there's no way to fake a real
 * process the way `gate.test.ts` fakes a filesystem. Acceptable because
 * `host.ts` doesn't branch on platform: `SIGTERM` then `SIGKILL`, which
 * Windows collapses into `TerminateProcess` for both. All platform-shaped
 * logic lives in `gate.ts`, covered under both shapes there.
 */

import { describe, expect, it } from "bun:test";
import type { Resolved } from "./gate";
import { SpawnHost } from "./host";

const RUNNER = process.execPath;

function plan(script: string, program = "sleeper"): Resolved {
  return {
    program,
    binary: RUNNER,
    argv: ["-e", script],
    cwd: process.cwd(),
    env: {},
    loggable: ["-e", script],
  };
}

/** Stays up until it is signalled. Long enough that nothing here races it out. */
const SLEEPER = "setTimeout(() => {}, 120000)";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function until(predicate: () => boolean, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

function quiet(): SpawnHost {
  return new SpawnHost(() => {});
}

describe("serving", () => {
  it("starts a process and reports its pid", async () => {
    const host = quiet();
    const answer = JSON.parse(host.serve(plan(SLEEPER), "tDB", "pocketbase")) as { pid?: number };
    expect(answer.pid).toBeGreaterThan(0);
    expect(alive(answer.pid as number)).toBe(true);
    host.killEverything();
    expect(await until(() => !alive(answer.pid as number))).toBe(true);
  });

  it("is idempotent per key, because the caller's bookkeeping may have restarted", async () => {
    const host = quiet();
    const first = JSON.parse(host.serve(plan(SLEEPER), "tDB", "pocketbase")) as { pid: number };
    const second = JSON.parse(host.serve(plan(SLEEPER), "tDB", "pocketbase")) as { pid: number };
    expect(second.pid).toBe(first.pid);
    host.killEverything();
    await until(() => !alive(first.pid));
  });

  it("files two callers' identical keys separately", async () => {
    const host = quiet();
    const a = JSON.parse(host.serve(plan(SLEEPER), "tAI", "llama")) as { pid: number };
    const b = JSON.parse(host.serve(plan(SLEEPER), "tRadio", "llama")) as { pid: number };
    expect(b.pid).not.toBe(a.pid);
    host.killEverything();
    await until(() => !alive(a.pid) && !alive(b.pid));
  });

  it("hands back output from a cursor that survives discards", async () => {
    const host = quiet();
    host.serve(plan("console.log('loading model'); console.error('warning: slow')"), "tAI", "x");
    await until(() => {
      const report = JSON.parse(host.output("tAI", "x", 0)) as { lines: unknown[] };
      return report.lines.length >= 2;
    });
    const first = JSON.parse(host.output("tAI", "x", 0)) as {
      lines: { stream: string; text: string }[];
      next: number;
    };
    expect(first.lines.map((l) => l.text)).toContain("loading model");
    expect(first.lines.find((l) => l.text.includes("warning"))?.stream).toBe("stderr");
    const again = JSON.parse(host.output("tAI", "x", first.next)) as { lines: unknown[] };
    expect(again.lines).toEqual([]);
    host.killEverything();
  });
});

describe("reaping", () => {
  it("kills a caller's children when that caller stops", async () => {
    const host = quiet();
    const mine = JSON.parse(host.serve(plan(SLEEPER), "tDB", "pocketbase")) as { pid: number };
    const theirs = JSON.parse(host.serve(plan(SLEEPER), "tRadio", "llama")) as { pid: number };

    const killed = host.killAll("tDB");

    expect(killed).toBe(1);
    expect(await until(() => !alive(mine.pid))).toBe(true);
    // The other caller's engine is untouched. A reap that took the whole table
    // would look identical from tDB's side and break every neighbour.
    expect(alive(theirs.pid)).toBe(true);

    host.killEverything();
    await until(() => !alive(theirs.pid));
  });

  it("kills everything when tLib itself stops", async () => {
    const host = quiet();
    const a = JSON.parse(host.serve(plan(SLEEPER), "tDB", "pocketbase")) as { pid: number };
    const b = JSON.parse(host.serve(plan(SLEEPER), "tAI", "llama")) as { pid: number };
    expect(host.killEverything()).toBe(2);
    expect(await until(() => !alive(a.pid) && !alive(b.pid))).toBe(true);
  });

  it("reaps a running one-shot too", async () => {
    const host = quiet();
    const started = JSON.parse(host.run(plan(SLEEPER), "tRadio", null)) as { job: string };
    expect(host.killAll("tRadio")).toBe(1);
    // The job is forgotten as well as killed, so a later poll cannot adopt it.
    expect(JSON.parse(host.job("tRadio", started.job))).toEqual({ state: "unknown" });
  });

  it("forgets a stopped caller's entries, so a restart starts clean", async () => {
    const host = quiet();
    const first = JSON.parse(host.serve(plan(SLEEPER), "tDB", "pocketbase")) as { pid: number };
    host.killAll("tDB");
    await until(() => !alive(first.pid));
    // The restarted copy asks for the same key and must get a new process, not
    // the corpse of the old one — kill-and-respawn, not reuse.
    const second = JSON.parse(host.serve(plan(SLEEPER), "tDB", "pocketbase")) as { pid: number };
    expect(second.pid).not.toBe(first.pid);
    expect(alive(second.pid)).toBe(true);
    host.killEverything();
    await until(() => !alive(second.pid));
  });

  it("leaves nothing listed after a reap", () => {
    const host = quiet();
    host.serve(plan(SLEEPER), "tDB", "pocketbase");
    expect(host.list()).toHaveLength(1);
    host.killAll("tDB");
    expect(host.list()).toEqual([]);
  });
});

describe("one-shot jobs", () => {
  it("returns the exit code and the captured stdout", async () => {
    const host = quiet();
    const started = JSON.parse(
      host.run(plan("console.log('Successfully saved superuser'); process.exit(0)"), "tDB", null)
    ) as { job: string };

    let result: { state: string; code?: number; stdout?: string } = { state: "running" };
    await until(() => {
      const answer = JSON.parse(host.job("tDB", started.job)) as typeof result;
      if (answer.state === "running") return false;
      result = answer;
      return true;
    });

    expect(result.state).toBe("exited");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Successfully saved superuser");
  });

  it("writes stdin and closes it", async () => {
    const host = quiet();
    const started = JSON.parse(
      host.run(
        plan(
          "let s='';process.stdin.on('data',c=>{s+=c});process.stdin.on('end',()=>{console.log('got:'+s.trim())})"
        ),
        "tRadio",
        "hello dispatch\n"
      )
    ) as { job: string };

    let stdout = "";
    await until(() => {
      const answer = JSON.parse(host.job("tRadio", started.job)) as {
        state: string;
        stdout?: string;
      };
      if (answer.state === "running") return false;
      stdout = answer.stdout ?? "";
      return true;
    });
    expect(stdout).toContain("got:hello dispatch");
  });

  it("will not hand one caller's job to another", () => {
    const host = quiet();
    const started = JSON.parse(host.run(plan("process.exit(0)"), "tDB", null)) as { job: string };
    expect(JSON.parse(host.job("tAI", started.job))).toEqual({ state: "unknown" });
    host.killEverything();
  });

  it("forgets a finished job once it is read", async () => {
    const host = quiet();
    const started = JSON.parse(host.run(plan("process.exit(3)"), "tDB", null)) as { job: string };
    await until(() => {
      const answer = JSON.parse(host.job("tDB", started.job)) as { state: string; code?: number };
      if (answer.state === "running") return false;
      expect(answer.code).toBe(3);
      return true;
    });
    expect(JSON.parse(host.job("tDB", started.job))).toEqual({ state: "unknown" });
  });
});

describe("failures", () => {
  it("reports a binary that cannot be executed rather than throwing", () => {
    const host = quiet();
    const answer = JSON.parse(
      host.serve({ ...plan(SLEEPER), binary: "" }, "tDB", "pocketbase")
    ) as { error?: string };
    expect(typeof answer.error).toBe("string");
  });

  it("refuses to serve without a key", () => {
    const host = quiet();
    expect(JSON.parse(host.serve(plan(SLEEPER), "tDB", ""))).toEqual({ error: "no key given" });
  });
});

describe("duplex (bytes) mode", () => {
  /**
   * Echoes stdin back on stdout, byte for byte, including bytes that are not
   * valid UTF-8. That is the property under test: the speech sidecar exchanges
   * length-prefixed audio frames, and a text round-trip anywhere in the path
   * would replace an invalid sequence with U+FFFD and desynchronise the stream
   * for good.
   */
  const ECHO = "process.stdin.on('data', c => process.stdout.write(c))";

  it("carries arbitrary bytes in both directions", async () => {
    const host = quiet();
    host.serve(plan(ECHO), "tAI", "tts", "bytes");

    const payload = Buffer.from([0x00, 0xff, 0xfe, 0x01, 0x80, 0x0a, 0x0d]);
    expect(host.write("tAI", "tts", payload.toString("base64"))).toBe(true);

    let back = Buffer.alloc(0);
    await until(() => {
      const report = JSON.parse(host.output("tAI", "tts", 0)) as { chunks: string[] };
      for (const chunk of report.chunks) back = Buffer.concat([back, Buffer.from(chunk, "base64")]);
      return back.length >= payload.length;
    });
    expect([...back]).toEqual([...payload]);
    host.killEverything();
  });

  it("does not hand the same chunk back twice", async () => {
    const host = quiet();
    host.serve(plan(ECHO), "tAI", "tts", "bytes");
    host.write("tAI", "tts", Buffer.from("first").toString("base64"));
    await until(() => {
      const report = JSON.parse(host.output("tAI", "tts", 0)) as { chunks: string[] };
      return report.chunks.length > 0;
    });
    const second = JSON.parse(host.output("tAI", "tts", 1)) as { chunks: string[] };
    expect(second.chunks).toEqual([]);
    host.killEverything();
  });

  it("refuses a write to a line-mode process", () => {
    const host = quiet();
    host.serve(plan(SLEEPER), "tDB", "pocketbase");
    expect(host.write("tDB", "pocketbase", Buffer.from("x").toString("base64"))).toBe(false);
    host.killEverything();
  });

  it("refuses a write from a resource that does not own the key", () => {
    const host = quiet();
    host.serve(plan(ECHO), "tAI", "tts", "bytes");
    expect(host.write("tRadio", "tts", Buffer.from("x").toString("base64"))).toBe(false);
    host.killEverything();
  });

  it("still reaps a duplex child on its owner's stop", async () => {
    const host = quiet();
    const started = JSON.parse(host.serve(plan(ECHO), "tAI", "tts", "bytes")) as { pid: number };
    expect(host.killAll("tAI")).toBe(1);
    expect(await until(() => !alive(started.pid))).toBe(true);
  });
});
