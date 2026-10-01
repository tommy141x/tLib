/**
 * Core build utilities: logging, command execution, simple staging, and zip.
 * Zero npm dependencies — AdmZip is passed by the caller.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { assertManifestStaged } from "./manifest-coverage.ts";

export function step(label: string) {
  console.log(`\n→ ${label}`);
}

export function run(cmd: string, args: string[], cwd: string) {
  const proc = Bun.spawnSync([cmd, ...args], { cwd, stdout: "inherit", stderr: "inherit" });
  if (proc.exitCode !== 0) {
    console.error(`\nFailed: ${cmd} ${args.join(" ")}`);
    process.exit(1);
  }
}

export function installDeps(cwd: string) {
  step("Installing dependencies");
  run("bun", ["install"], cwd);
}

export function buildViteUI(cwd: string, label?: string) {
  step(label ?? "Building UI with Vite");
  run("bunx", ["vp", "build"], cwd);
}

export function cleanDir(dir: string) {
  // Windows hands out transient EBUSY on rmSync when anything has even a
  // browse-level handle on the directory (Explorer preview pane, AV scan, a
  // sibling shell). `force + maxRetries` is the Node-blessed retry loop.
  if (existsSync(dir))
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  mkdirSync(dir, { recursive: true });
}

export function stageFiles(root: string, dist: string, includes: string[]) {
  step("Staging release files");
  cleanDir(dist);

  for (const item of includes) {
    const src = join(root, item);
    const dest = join(dist, item);
    if (!existsSync(src)) {
      // Hard error, not a warning. This list is an allowlist: a path that stops
      // existing -- because a file was renamed or a tree moved -- means the
      // release silently ships without it, and the warning scrolls past in a
      // build log nobody reads. Failing here is the whole point of naming the
      // files instead of excluding directories.
      throw new Error(
        `Release file not found: ${item}. Update the include list in scripts/prod.ts after a move.`
      );
    }
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest, { recursive: true });
    console.log(`  +     ${item}`);
  }
}

interface ZipLike {
  addLocalFile(localPath: string, zipPath: string): void;
  writeZip(path: string): void;
}

export function addDirToZip(zip: ZipLike, dir: string, zipPrefix: string) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      addDirToZip(zip, full, `${zipPrefix}/${entry}`);
    } else {
      zip.addLocalFile(full, zipPrefix);
    }
  }
}

export function createZip(zip: ZipLike, dist: string, zipPath: string, folderName: string) {
  step(`Creating ${folderName}.zip`);
  if (existsSync(zipPath)) rmSync(zipPath);
  addDirToZip(zip, dist, folderName);
  zip.writeZip(zipPath);

  const mb = (statSync(zipPath).size / 1024 / 1024).toFixed(2);
  console.log(`\nDone! ${folderName}.zip — ${mb} MB`);
  console.log(`      .build/dist/ — unzipped output\n`);
}

export interface ProdConfig {
  name: string;
  root: string;
  uiBuilds: Array<{
    source: string;
    install?: boolean;
    label?: string;
    /** Full resource build when Vite alone does not produce every runtime artifact. */
    command?: [string, ...string[]];
  }>;
  include: string[];
  /** Required nonempty artifacts, checked before touching an existing distribution. */
  requiredFiles?: string[];
}

export function assertProductionFiles(root: string, files: string[]) {
  for (const file of files) {
    const full = join(root, file);
    if (!existsSync(full) || !statSync(full).isFile() || statSync(full).size === 0) {
      throw new Error(`Missing or empty production artifact: ${file}`);
    }
  }
}

export function buildProductionUI(
  cwd: string,
  ui: ProdConfig["uiBuilds"][number],
  execute: typeof run = run
) {
  step(ui.label ?? "Building UI with Vite");
  const [command, ...args] = ui.command ?? ["bunx", "vp", "build"];
  execute(command, args, cwd);
}

export function runProd(config: ProdConfig, AdmZipClass: new () => ZipLike) {
  const { name, root, uiBuilds, include } = config;

  for (const ui of uiBuilds) {
    const cwd = join(root, ui.source);
    if (ui.install !== false) installDeps(cwd);
    buildProductionUI(cwd, ui);
  }

  assertProductionFiles(root, config.requiredFiles ?? []);

  // Both directions of the allowlist, the way every sibling resource's prod.ts
  // does it by hand. stageFiles throws on an included path that has stopped
  // existing; this throws on a path fxmanifest.lua declares that nobody added
  // to `include`. Without it the release is missing a file the resource will
  // demand at start, and the build reports success -- the failure surfaces on a
  // customer's server, not here.
  assertManifestStaged(readFileSync(join(root, "fxmanifest.lua"), "utf8"), include);

  // Everything generated lands under one root, so .gitignore needs a single
  // rule and a new artifact can never reach a release by being forgotten.
  const dist = join(root, ".build", "dist");
  stageFiles(root, dist, include);
  createZip(new AdmZipClass(), dist, join(root, ".build", `${name}.zip`), name);
}
