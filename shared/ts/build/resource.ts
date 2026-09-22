/**
 * The standard tScripts resource build.
 *
 * tAFK, tDetector, tELS and tRadar all had their own `scripts/build.ts`, three of
 * them byte-identical and the fourth differing only by not having a server bundle.
 * Every one of them also lacked the version fan-out that tRadio learned the hard
 * way it needed, so their package.json could — and did — drift from the version
 * fxmanifest.lua declares.
 *
 * A resource's build.ts is now the config for this function, not a copy of it.
 * tRadio stays on its own orchestration: it builds two Vite projects, a Tauri
 * desktop app and a WASM vocoder, with ordering constraints this does not model.
 */

import { buildServerBundle, viteBuild } from "./bun-builder.ts";
import { step } from "./core.ts";
import { syncVersions, type VersionTarget } from "./version.ts";

export interface StandardBuildOptions {
  /** Resource root, relative to which every other path resolves. Defaults to the cwd. */
  root?: string;
  /**
   * Generated copies of the version to keep in step with fxmanifest.lua.
   * Defaults to the resource's package.json, which is what every consumer needs.
   * Pass `[]` to skip the sync entirely.
   */
  versionTargets?: VersionTarget[];
  /** Vite/NUI project directory, or null for a resource with no NUI. */
  uiDir?: string | null;
  /** Server bundle entry and output directory, or null for a client-only resource. */
  server?: { entry: string; outDir: string } | null;
}

const DEFAULT_VERSION_TARGETS: VersionTarget[] = [{ kind: "json", file: "./package.json" }];

/**
 * Sync versions, then build the NUI and the server bundle in parallel.
 *
 * The version sync runs first and is awaited: it throws on a miss, and a build
 * that stamps the wrong version into a bundle is worse than one that stops.
 */
export async function buildStandardResource(
  options: StandardBuildOptions = {}
): Promise<{ success: boolean }> {
  const {
    root = ".",
    versionTargets = DEFAULT_VERSION_TARGETS,
    uiDir = "./client/web",
    server = { entry: "./server/main.ts", outDir: "./server/dist" },
  } = options;

  if (versionTargets.length > 0) {
    step("Syncing versions from fxmanifest.lua");
    await syncVersions(versionTargets, root);
  }

  const jobs: Promise<boolean>[] = [];
  if (uiDir) jobs.push(viteBuild(uiDir));
  if (server) {
    jobs.push(
      buildServerBundle(server.entry, server.outDir, "server bundle").then((r) => r.success)
    );
  }

  const results = await Promise.all(jobs);
  return { success: results.every(Boolean) };
}

/**
 * The `if (import.meta.main)` tail every resource build.ts repeated: run, report,
 * and set a non-zero exit code on failure so CI and `bun run verify` can see it.
 */
export function runStandardBuild(options: StandardBuildOptions = {}): void {
  buildStandardResource(options)
    .then((r) => {
      if (!r.success) {
        console.log("\nBuild failed!");
        process.exit(1);
      }
      console.log("\nBuild completed!");
    })
    .catch((e) => {
      console.error("Build failed:", e);
      process.exit(1);
    });
}
