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

  test("tLib release selects the script that generates all three runtime artifacts", () => {
    const release = readFileSync(new URL("../../scripts/prod.ts", import.meta.url), "utf8");
    const pkg = JSON.parse(
      readFileSync(new URL("../../client/web/package.json", import.meta.url), "utf8")
    );
    expect(release).toContain('command: ["bun", "run", "build"]');
    expect(pkg.scripts.build).toContain("vp build");
    expect(pkg.scripts.build).toContain("--outfile ../assets/hud-layout.js");
    expect(pkg.scripts.build).toContain("--outfile ../../server/dist/bundle.js");
  });
});
