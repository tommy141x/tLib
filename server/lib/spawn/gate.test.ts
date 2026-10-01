/**
 * The refusals, which are the whole point of the module — run twice, once under
 * a POSIX filesystem and once under a Windows one.
 *
 * Both shapes, in one suite, because this development machine is Windows and
 * most FiveM hosting is Linux containers: a suite that only proves the Windows
 * shape proves the half of the product nobody deploys. The two differ in ways
 * that matter to a containment check — separator, drive letters, and above all
 * case, since `/srv/tdb` and `/srv/tDB` are two directories on Linux and one on
 * Windows. `path.posix` and `path.win32` are the real implementations, so these
 * are not an imitation of the other platform.
 *
 * The filesystem is a map rather than real files, because the two cases that
 * matter most cannot be built portably on disk: a symlink pointing out of a
 * resource (needs privileges on Windows) and a path that is inside only *before*
 * `realpath`. Both are ordinary entries below.
 *
 * Every refusal here is mutation-proven by `scripts/mutate-spawn-gate.ts`: the
 * check is broken, exactly these assertions fail, and it is restored.
 */

import { describe, expect, it } from "bun:test";
import { posix, win32 } from "node:path";
import type { Platform, Probes } from "./gate";
import { resolveSpawn } from "./gate";

interface Shape {
  label: string;
  platform: Platform;
  root: string;
  sep: string;
  join(...parts: string[]): string;
  resolve(...parts: string[]): string;
  /** Resource-relative, platform-correct, for building fixture keys. */
  at(...parts: string[]): string;
  /** The binary the catalog resolves to for each program on this platform. */
  pocketbase: string;
  llamaTAI: string;
  llamaTRadio: string;
  piper: string;
  node: string;
  sidecar: string;
}

const POSIX: Shape = (() => {
  const root = "/opt/fxserver/resources/[tScripts]";
  const at = (...parts: string[]) => posix.join(root, ...parts);
  return {
    label: "posix",
    platform: "linux",
    root,
    sep: posix.sep,
    join: posix.join,
    resolve: posix.resolve,
    at,
    pocketbase: at("tDB/.runtime/pocketbase-linux"),
    llamaTAI: at("tAI/bin/linux/llama-server"),
    llamaTRadio: at("tRadio/server/bin/linux/llama/llama-server"),
    piper: at("tRadio/server/bin/linux/piper/piper"),
    node: at("tAI/bin/linux/node"),
    sidecar: at("tAI/bin/tts-sidecar.js"),
  };
})();

const WINDOWS: Shape = (() => {
  const root = "C:\\fxserver\\resources\\[tScripts]";
  const at = (...parts: string[]) => win32.join(root, ...parts);
  return {
    label: "windows",
    platform: "win32",
    root,
    sep: win32.sep,
    join: win32.join,
    resolve: win32.resolve,
    at,
    pocketbase: at("tDB\\.runtime\\pocketbase-win.exe"),
    llamaTAI: at("tAI\\bin\\win\\llama-server.exe"),
    llamaTRadio: at("tRadio\\server\\bin\\win\\llama\\llama-server.exe"),
    piper: at("tRadio\\server\\bin\\win\\piper\\piper.exe"),
    node: at("tAI\\bin\\win\\node.exe"),
    sidecar: at("tAI\\bin\\tts-sidecar.js"),
  };
})();

/** Everything that exists, mapped to where it really resolves. */
function filesystem(shape: Shape): Record<string, string> {
  const self = (p: string) => [p, p] as const;
  const entries: (readonly [string, string])[] = [
    self(shape.at("tDB")),
    self(shape.pocketbase),
    self(shape.at("tAI")),
    self(shape.llamaTAI),
    self(shape.node),
    self(shape.sidecar),
    self(shape.at("tRadio")),
    self(shape.llamaTRadio),
    self(shape.piper),
    self(shape.join(shape.llamaTRadio, "..")),
    self(shape.join(shape.piper, "..")),
    // Somewhere outside every resource, for the symlink-escape cases.
    [shape.platform === "win32" ? "C:\\Windows\\System32\\cmd.exe" : "/bin/sh", shape.platform === "win32" ? "C:\\Windows\\System32\\cmd.exe" : "/bin/sh"],
  ];
  return Object.fromEntries(entries);
}

const OUTSIDE = (shape: Shape) =>
  shape.platform === "win32" ? "C:\\Windows\\System32\\cmd.exe" : "/bin/sh";

function probesFor(shape: Shape, overrides: Partial<Probes> = {}): Probes {
  const real = filesystem(shape);
  return {
    resourcePath: (resource) => (real[shape.at(resource)] ? shape.at(resource) : ""),
    realpath: (target) => {
      const resolved = real[target];
      if (!resolved) throw new Error(`ENOENT: ${target}`);
      return resolved;
    },
    // Directories are not files; everything else in the map is.
    isFile: (target) => Boolean(real[target]) && !isDirectory(shape, target),
    sha256: () => "0".repeat(64),
    authors: () => ["Tommy Johnston", "TIMMYG Studios"],
    platform: () => shape.platform,
    join: shape.join,
    resolve: shape.resolve,
    sep: shape.sep,
    ...overrides,
  };
}

/** The fixture directories, so `isFile` can say no to them. */
function isDirectory(shape: Shape, target: string): boolean {
  return (
    target === shape.at("tDB") ||
    target === shape.at("tAI") ||
    target === shape.at("tRadio") ||
    target === shape.join(shape.llamaTRadio, "..") ||
    target === shape.join(shape.piper, "..")
  );
}

const SERVE = ["serve", "--http=127.0.0.1:8090", "--dir", ".runtime/pb_data", "--hooksDir=pb_hooks"];

type Answer = { error: string } & { binary: string; argv: string[]; cwd: string; loggable: string[] };

for (const shape of [POSIX, WINDOWS]) {
  const probes = (overrides: Partial<Probes> = {}) => probesFor(shape, overrides);

  describe(`${shape.label}: caller identity`, () => {
    it("admits a declared first-party caller", () => {
      const plan = resolveSpawn("tDB", { program: "pocketbase", args: SERVE }, probes());
      expect(plan).not.toHaveProperty("error");
    });

    it("refuses a resource that is not in the family", () => {
      const plan = resolveSpawn("tCAD", { program: "pocketbase", args: SERVE }, probes());
      expect((plan as Answer).error).toContain("not in tLib's spawn family");
    });

    it("refuses when the engine cannot name the caller", () => {
      const plan = resolveSpawn("", { program: "pocketbase", args: SERVE }, probes());
      expect((plan as Answer).error).toContain("could not be identified");
    });

    it("refuses a program another family member declares", () => {
      // Membership is per program, not per family, or the consolidation would
      // hand every caller every binary.
      const plan = resolveSpawn("tDB", { program: "llama-server", args: [] }, probes());
      expect((plan as Answer).error).toContain("may not run");
    });
  });

  describe(`${shape.label}: author metadata`, () => {
    it("warns but still allows when the manifest author differs", () => {
      const plan = resolveSpawn(
        "tDB",
        { program: "pocketbase", args: SERVE },
        probes({ authors: () => ["someone else"] })
      );
      expect(plan).not.toHaveProperty("error");
      expect((plan as { authorWarning?: string }).authorWarning).toContain("someone else");
    });

    it("is silent when it matches", () => {
      const plan = resolveSpawn("tDB", { program: "pocketbase", args: SERVE }, probes());
      expect((plan as { authorWarning?: string }).authorWarning).toBeUndefined();
    });
  });

  describe(`${shape.label}: program resolution`, () => {
    it("picks the binary for this platform, from the catalog", () => {
      // The names differ per platform — `pocketbase-win.exe` against
      // `pocketbase-linux`, matching what tDB's fetch-runtime.ts writes — and the
      // caller never says which.
      expect((resolveSpawn("tDB", { program: "pocketbase", args: SERVE }, probes()) as Answer).binary).toBe(
        shape.pocketbase
      );
      expect(
        (resolveSpawn("tAI", { program: "llama-server", args: [] }, probes()) as Answer).binary
      ).toBe(shape.llamaTAI);
      expect(
        (resolveSpawn("tRadio", { program: "llama-server", args: [] }, probes()) as Answer).binary
      ).toBe(shape.llamaTRadio);
    });

    it("refuses a program whose file is missing from the resource", () => {
      const plan = resolveSpawn(
        "tAI",
        { program: "llama-server", args: [] },
        probes({ isFile: () => false })
      );
      expect((plan as Answer).error).toContain("not present inside tAI");
    });
  });

  describe(`${shape.label}: containment`, () => {
    it("refuses a binary that resolves outside the resource", () => {
      // A textual prefix test passes this; realpath on both sides does not.
      const real = filesystem(shape);
      const plan = resolveSpawn(
        "tDB",
        { program: "pocketbase", args: SERVE },
        probes({
          realpath: (target) =>
            target === shape.pocketbase ? OUTSIDE(shape) : (real[target] ?? ""),
        })
      );
      expect((plan as Answer).error).toContain("not present inside tDB");
    });

    it("refuses a cwd that escapes through ..", () => {
      const plan = resolveSpawn("tRadio", { program: "piper", args: [], cwd: "../tDB" }, probes());
      expect((plan as Answer).error).toContain("may only run in");
    });

    it("refuses a declared cwd that resolves outside the resource", () => {
      // The name is on the program's list, so the string check passes; the
      // realpath check is what stops it.
      const real = filesystem(shape);
      const elsewhere = shape.platform === "win32" ? "C:\\Windows" : "/etc";
      const plan = resolveSpawn(
        "tRadio",
        { program: "piper", args: [], cwd: "server/bin/win/piper" },
        probes({
          realpath: (target) =>
            target === shape.join(shape.piper, "..") ? elsewhere : (real[target] ?? ""),
        })
      );
      // On Linux the declared cwd for piper is the linux directory, so the
      // win-named one is refused by the allowlist first. Either refusal is
      // correct; what must never happen is acceptance.
      expect(plan).toHaveProperty("error");
    });

    it("refuses a cwd another program declares", () => {
      const plan = resolveSpawn(
        "tRadio",
        { program: "piper", args: [], cwd: `server/bin/${shape.platform === "win32" ? "win" : "linux"}/llama` },
        probes()
      );
      expect((plan as Answer).error).toContain("may only run in");
    });

    it('treats cwd "" as the resource root, not as "not supplied"', () => {
      // Load-bearing and wrong once: PocketBase's `--hooksDir=pb_hooks` is
      // relative to tDB's root, and running it from `.runtime/` instead makes
      // every hook silently fail to load.
      const root = resolveSpawn("tDB", { program: "pocketbase", args: SERVE, cwd: "" }, probes());
      expect((root as Answer).cwd).toBe(shape.at("tDB"));

      const omitted = resolveSpawn("tDB", { program: "pocketbase", args: SERVE }, probes());
      expect((omitted as Answer).cwd).toBe(shape.join(shape.pocketbase, ".."));
    });
  });

  describe(`${shape.label}: argument shapes`, () => {
    it("accepts a declared invocation and echoes it verbatim", () => {
      const plan = resolveSpawn("tDB", { program: "pocketbase", args: SERVE }, probes());
      expect((plan as Answer).argv).toEqual(SERVE);
    });

    it("refuses an undeclared flag", () => {
      const plan = resolveSpawn(
        "tDB",
        { program: "pocketbase", args: ["serve", "--exec=/bin/sh"] },
        probes()
      );
      expect((plan as Answer).error).toContain("not a declared way of running");
    });

    it("refuses a second command appended after a valid one", () => {
      const plan = resolveSpawn(
        "tDB",
        { program: "pocketbase", args: ["serve", ";", "/bin/sh"] },
        probes()
      );
      expect(plan).toHaveProperty("error");
    });

    it("refuses a non-loopback bind address", () => {
      // An engine that can be told to bind 0.0.0.0 is an unauthenticated server
      // on the open internet.
      const plan = resolveSpawn(
        "tDB",
        { program: "pocketbase", args: ["serve", "--http=0.0.0.0:8090"] },
        probes()
      );
      expect(plan).toHaveProperty("error");
    });

    it("refuses a non-loopback --host for llama-server", () => {
      const plan = resolveSpawn(
        "tAI",
        { program: "llama-server", args: ["--host", "0.0.0.0", "--port", "8181"] },
        probes()
      );
      expect(plan).toHaveProperty("error");
    });

    it("refuses a port outside the range", () => {
      const plan = resolveSpawn(
        "tAI",
        { program: "llama-server", args: ["--port", "99999"] },
        probes()
      );
      expect(plan).toHaveProperty("error");
    });

    it("refuses a value carrying a NUL", () => {
      const plan = resolveSpawn(
        "tDB",
        { program: "pocketbase", args: ["serve", "--dir=pb\0/etc"] },
        probes()
      );
      expect(plan).toHaveProperty("error");
    });

    it("refuses a subcommand in a position the shape does not have one", () => {
      // `admin@x.com` is a valid email, but only after `superuser upsert`.
      const plan = resolveSpawn(
        "tDB",
        { program: "pocketbase", args: ["admin@x.com", "hunter2"] },
        probes()
      );
      expect(plan).toHaveProperty("error");
    });

    it("keeps the superuser password out of the loggable form", () => {
      const plan = resolveSpawn(
        "tDB",
        {
          program: "pocketbase",
          args: ["superuser", "upsert", "admin@localhost.local", "s3cr3t-p4ss"],
        },
        probes()
      );
      expect((plan as Answer).argv).toContain("s3cr3t-p4ss");
      expect((plan as Answer).loggable.join(" ")).not.toContain("s3cr3t-p4ss");
    });

    it("refuses a repeated flag", () => {
      const plan = resolveSpawn(
        "tDB",
        { program: "pocketbase", args: ["serve", "--dir", "a", "--dir", "b"] },
        probes()
      );
      expect(plan).toHaveProperty("error");
    });

    it("refuses args that are not strings", () => {
      const plan = resolveSpawn(
        "tDB",
        { program: "pocketbase", args: ["serve", 5] as unknown },
        probes()
      );
      expect((plan as Answer).error).toContain("array of strings");
    });
  });

  describe(`${shape.label}: environment`, () => {
    it("allows a declared variable", () => {
      const plan = resolveSpawn(
        "tRadio",
        { program: "piper", args: [], env: { LD_LIBRARY_PATH: "/x" } },
        probes()
      );
      expect((plan as unknown as { env: Record<string, string> }).env.LD_LIBRARY_PATH).toBe("/x");
    });

    it("refuses an undeclared variable", () => {
      // LD_PRELOAD into a process tLib spawns is code execution with the
      // containment rule intact, which is why this is a list and not a filter.
      const plan = resolveSpawn(
        "tRadio",
        { program: "piper", args: [], env: { LD_PRELOAD: "/tmp/x.so" } },
        probes()
      );
      expect((plan as Answer).error).toContain("may not set LD_PRELOAD");
    });
  });

  describe(`${shape.label}: catalog-supplied paths (prepend)`, () => {
    const SIDECAR_ARGS = [shape.at("tAI"), "4", "neutts"];

    it("puts the script tLib chose in front of the caller's arguments", () => {
      const plan = resolveSpawn("tAI", { program: "tts-sidecar", args: SIDECAR_ARGS }, probes());
      expect((plan as Answer).binary).toBe(shape.node);
      expect((plan as Answer).argv).toEqual([shape.sidecar, ...SIDECAR_ARGS]);
    });

    it("refuses when the script is not where the catalog says", () => {
      // Running the interpreter without its script drops tAI's vendored Node
      // into a REPL reading the server's stdin.
      const real = filesystem(shape);
      const plan = resolveSpawn(
        "tAI",
        { program: "tts-sidecar", args: SIDECAR_ARGS },
        probes({ isFile: (t) => Boolean(real[t]) && !t.endsWith(".js") && !isDirectory(shape, t) })
      );
      expect((plan as Answer).error).toContain("tts-sidecar.js");
    });

    it("will not let the caller supply a script of its own", () => {
      const plan = resolveSpawn(
        "tAI",
        { program: "tts-sidecar", args: [OUTSIDE(shape), "1"] },
        probes()
      );
      expect((plan as Answer).argv[0]).toBe(shape.sidecar);
    });

    it("refuses a sidecar invocation with an undeclared extra argument", () => {
      const plan = resolveSpawn(
        "tAI",
        { program: "tts-sidecar", args: [...SIDECAR_ARGS, "--inspect-brk"] },
        probes()
      );
      expect(plan).toHaveProperty("error");
    });
  });

  describe(`${shape.label}: pinning`, () => {
    it("enforces a sha256 when a program declares one", async () => {
      const { FAMILY } = await import("./catalog");
      const pocketbase = FAMILY.find((c) => c.resource === "tDB")?.programs[0];
      if (!pocketbase) throw new Error("catalog changed shape");
      pocketbase.sha256 = ["a".repeat(64)];
      try {
        const plan = resolveSpawn("tDB", { program: "pocketbase", args: SERVE }, probes());
        expect((plan as Answer).error).toContain("does not match its pin");
        const ok = resolveSpawn(
          "tDB",
          { program: "pocketbase", args: SERVE },
          probes({ sha256: () => "A".repeat(64) })
        );
        expect(ok).not.toHaveProperty("error");
      } finally {
        pocketbase.sha256 = undefined;
      }
    });
  });
}

/**
 * Case is where the two platforms genuinely disagree, so it gets its own block.
 *
 * `/opt/.../tdb` and `/opt/.../tDB` are different directories on Linux and the
 * same one on Windows. The containment check must therefore compare paths
 * exactly — case-folding them would accept a different directory on Linux while
 * also weakening the check on Windows, which is the worst of both.
 */
describe("case sensitivity", () => {
  it("refuses a binary whose real path differs from the root only in case", () => {
    const shape = POSIX;
    const real = filesystem(shape);
    // A real file, at a real path, that is a DIFFERENT directory on Linux.
    // `isFile` says yes to it deliberately: if it did not, the test would pass
    // for the wrong reason — "no such file" rather than "not inside tDB" — and a
    // case-folded prefix comparison would sail through it. Mutation-proven.
    const folded = shape.at("tdb/.runtime/pocketbase-linux");
    const plan = resolveSpawn(
      "tDB",
      { program: "pocketbase", args: SERVE },
      probesFor(shape, {
        realpath: (target) => {
          if (target === shape.pocketbase) return folded;
          if (target === folded) return folded;
          const resolved = real[target];
          if (!resolved) throw new Error(`ENOENT: ${target}`);
          return resolved;
        },
        isFile: (target) =>
          target === folded || (Boolean(real[target]) && !isDirectory(shape, target)),
      })
    );
    expect((plan as Answer).error).toContain("not present inside tDB");
  });

  it("accepts the same fixture when the case actually matches", () => {
    const plan = resolveSpawn("tDB", { program: "pocketbase", args: SERVE }, probesFor(POSIX));
    expect(plan).not.toHaveProperty("error");
  });
});
