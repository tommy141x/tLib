import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertProductionFiles, buildProductionUI, runProd } from "../../shared/ts/build/core";

describe("production UI build selection", () => {
  test("existing consumers retain the Vite build default", () => {
    const calls: unknown[][] = [];
    buildProductionUI("/resource/ui", { source: "ui" }, (...args) => {
      calls.push(args);
    });
    expect(calls).toEqual([["bunx", ["vp", "build"], "/resource/ui"]]);
  });

  test("a full build replaces Vite rather than running a second cleanup", () => {
    const calls: unknown[][] = [];
    const command: [string, ...string[]] = ["bun", "run", "build"];
    buildProductionUI("/resource/ui", { source: "ui", command }, (...args) => {
      calls.push(args);
    });
    expect(calls).toEqual([["bun", ["run", "build"], "/resource/ui"]]);
    expect(command).toEqual(["bun", "run", "build"]);
  });

  test("build failures propagate before release staging", () => {
    expect(() =>
      buildProductionUI("/resource/ui", { source: "ui" }, () => {
        throw new Error("build failed");
      })
    ).toThrow("build failed");
  });

  test("missing artifacts refuse packaging before touching prior output", () => {
    const root = mkdtempSync(join(tmpdir(), "tlib-prod-test-"));
    try {
      writeFileSync(join(root, "dist"), "prior output sentinel");
      class Zip {
        addLocalFile() {
          throw new Error("unexpected zip write");
        }
        writeZip() {
          throw new Error("unexpected zip write");
        }
      }
      expect(() =>
        runProd({ name: "test", root, uiBuilds: [], include: [], requiredFiles: ["hud.js"] }, Zip)
      ).toThrow("Missing or empty production artifact: hud.js");
      expect(readFileSync(join(root, "dist"), "utf8")).toBe("prior output sentinel");
      writeFileSync(join(root, "hud.js"), "");
      expect(() => assertProductionFiles(root, ["hud.js"])).toThrow(
        "Missing or empty production artifact"
      );
      expect(() => assertProductionFiles(root, ["."])).toThrow(
        "Missing or empty production artifact"
      );
      writeFileSync(join(root, "hud.js"), "runtime");
      expect(() => assertProductionFiles(root, ["hud.js"])).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("runProd refuses an allowlist that would ship without a manifest path", () => {
    // The direction stageFiles cannot see. It throws when an INCLUDED path has
    // stopped existing; nothing was checking the reverse -- a path added to
    // fxmanifest.lua and never added to `include`. That release builds clean and
    // fails at start on a customer's server, which is the worst place to find it.
    const root = mkdtempSync(join(tmpdir(), "tlib-manifest-test-"));
    try {
      writeFileSync(
        join(root, "fxmanifest.lua"),
        "shared_scripts { '@tLib/imports.lua', 'shared/sh_utils.lua' }\n" +
          "server_scripts { 'server/sv_main.lua', 'server/sv_brand_new.lua' }\n"
      );
      writeFileSync(join(root, "shared.lua"), "x");
      class Zip {
        addLocalFile() {
          throw new Error("unexpected zip write");
        }
        writeZip() {
          throw new Error("unexpected zip write");
        }
      }
      const include = ["fxmanifest.lua", "shared/sh_utils.lua", "server/sv_main.lua"];
      expect(() => runProd({ name: "test", root, uiBuilds: [], include }, Zip)).toThrow(
        "server/sv_brand_new.lua"
      );
      // '@tLib/imports.lua' is another resource's path and is not this release's
      // to stage, so it must not count as missing.
      expect(() => runProd({ name: "test", root, uiBuilds: [], include }, Zip)).not.toThrow(
        "imports.lua"
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("tLib release selects the script that generates all three runtime artifacts", () => {
    const release = readFileSync(new URL("../../scripts/prod.ts", import.meta.url), "utf8");
    const pkg = JSON.parse(
      readFileSync(new URL("../../client/web/package.json", import.meta.url), "utf8")
    );
    expect(release).toContain('command: ["bun", "run", "build"]');
    expect(pkg.scripts.build).toContain("vp build");
    // Relative to client/web: lands at client/ui/assets/hud-layout.js, which is what
    // prod.ts asserts. `../assets` was right from the old ui/src/ location only.
    expect(pkg.scripts.build).toContain("--outfile ../ui/assets/hud-layout.js");
    expect(pkg.scripts.build).toContain("--outfile ../../server/dist/bundle.js");
  });
});
