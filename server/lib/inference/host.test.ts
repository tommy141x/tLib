import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// The host asks the runtime where a resource lives; here that is a temp tree
// standing in for one, plus a sibling the tree must never be able to reach.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "tlib-host-"));
const resource = path.join(root, "tFake");
const outside = path.join(root, "outside");
fs.mkdirSync(path.join(resource, "bin"), { recursive: true });
fs.mkdirSync(outside, { recursive: true });

// A real executable, because the containment rule is enforced with realpath and
// a stub file would not survive it. Copied rather than linked for the same reason.
const win = process.platform === "win32";
const systemBinary = win ? "C:\\Windows\\System32\\cmd.exe" : "/bin/sh";
const inside = path.join(resource, "bin", win ? "engine.exe" : "engine");
fs.copyFileSync(systemBinary, inside);
fs.copyFileSync(systemBinary, path.join(outside, win ? "stranger.exe" : "stranger"));

const exits = (code: number) => (win ? ["/c", `exit ${code}`] : ["-c", `exit ${code}`]);
const relative = win ? "bin/engine.exe" : "bin/engine";

(globalThis as Record<string, unknown>).GetResourcePath = (name: string) =>
  name === "tFake" ? resource : null;

const { SpawnHost } = await import("./host");

const settled = async (host: InstanceType<typeof SpawnHost>, job: string) => {
  for (let i = 0; i < 100; i++) {
    const status = JSON.parse(host.job("tFake", job));
    if (status.state !== "running") return status;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("job never finished");
};

describe("SpawnHost", () => {
  let host: InstanceType<typeof SpawnHost>;
  beforeAll(() => {
    host = new SpawnHost();
  });
  afterAll(() => {
    host.killEverything();
    try {
      // Windows holds the image of a process it has only just killed, so the
      // copied executables can still be locked here. The temp dir is the OS's
      // problem in that case.
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {}
  });

  test("runs a binary the caller ships and reports how it exited", async () => {
    const started = JSON.parse(host.run("tFake", { binary: relative, args: exits(3) }));
    expect(started.job).toBeDefined();
    const status = await settled(host, started.job);
    expect(status.code).toBe(3);
  });

  test("a finished job is reported once, then forgotten", async () => {
    const started = JSON.parse(host.run("tFake", { binary: relative, args: exits(0) }));
    await settled(host, started.job);
    expect(JSON.parse(host.job("tFake", started.job)).state).toBe("unknown");
  });

  test("another resource cannot read, or reap, a job that is not its own", async () => {
    const started = JSON.parse(host.run("tFake", { binary: relative, args: exits(0) }));
    expect(JSON.parse(host.job("tOther", started.job)).state).toBe("unknown");
    expect((await settled(host, started.job)).code).toBe(0);
  });

  test("refuses a path that climbs out of the resource", () => {
    const climb = path.join("..", "outside", win ? "stranger.exe" : "stranger");
    const result = JSON.parse(host.run("tFake", { binary: climb }));
    expect(result.error).toContain("not a file inside tFake");
  });

  test("refuses a symlink pointing out of the resource", () => {
    const link = path.join(resource, "bin", win ? "linked.exe" : "linked");
    try {
      fs.symlinkSync(path.join(outside, win ? "stranger.exe" : "stranger"), link, "file");
    } catch {
      return; // Windows without developer mode: the rule is covered by the climb test.
    }
    const result = JSON.parse(
      host.run("tFake", { binary: `bin/${win ? "linked.exe" : "linked"}` })
    );
    expect(result.error).toContain("not a file inside tFake");
  });

  test("refuses a resource the runtime does not know", () => {
    expect(JSON.parse(host.run("tGhost", { binary: relative })).error).toContain("not a file");
    expect(JSON.parse(host.run("", { binary: relative })).error).toContain(
      "could not be identified"
    );
  });

  test("serving twice under one key does not start a second process", () => {
    const first = JSON.parse(
      host.serve("tFake", { key: "text", binary: relative, args: sleeper() })
    );
    const second = JSON.parse(
      host.serve("tFake", { key: "text", binary: relative, args: sleeper() })
    );
    expect(first.pid).toBeGreaterThan(0);
    expect(second.pid).toBe(first.pid);
    expect(host.unserve("tFake", "text")).toBe(true);
    expect(host.unserve("tFake", "text")).toBe(false);
  });

  test("reports what a served process printed, and that it has stopped", async () => {
    const line = "loading model";
    host.serve("tFake", {
      key: "talkative",
      binary: relative,
      args: win ? ["/c", `echo ${line}`] : ["-c", `echo ${line}`],
    });

    let seen:
      | {
          lines: { stream: string; text: string }[];
          next: number;
          alive: boolean;
          code: number | null;
        }
      | undefined;
    for (let i = 0; i < 100 && !(seen && !seen.alive); i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      seen = JSON.parse(host.output("tFake", "talkative", 0));
    }
    expect(seen?.alive).toBe(false);
    expect(seen?.code).toBe(0);
    expect(seen?.lines.map((l) => `${l.stream}:${l.text}`).join("\n")).toContain(`stdout:${line}`);

    // Read from the end of what we already have: nothing new to say.
    const again = JSON.parse(host.output("tFake", "talkative", seen?.next ?? 0));
    expect(again.lines).toEqual([]);
    expect(JSON.parse(host.output("tOther", "talkative", 0)).lines).toEqual([]);
    host.unserve("tFake", "talkative");
  });

  test("a stopping resource takes its processes with it", () => {
    host.serve("tFake", { key: "one", binary: relative, args: sleeper() });
    host.serve("tFake", { key: "two", binary: relative, args: sleeper() });
    expect(host.killAll("tOther")).toBe(0);
    expect(host.killAll("tFake")).toBe(2);
  });
});

/** Long enough to still be running while the test asserts on it. */
function sleeper(): string[] {
  return win ? ["/c", "timeout", "/t", "30", "/nobreak"] : ["-c", "sleep 30"];
}
