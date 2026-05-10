/**
 * Core build utilities: logging, command execution, simple staging, and zip.
 * Zero npm dependencies — AdmZip is passed by the caller.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

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
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  mkdirSync(dir, { recursive: true });
}

export function stageFiles(root: string, dist: string, includes: string[]) {
  step("Staging release files");
  cleanDir(dist);

  for (const item of includes) {
    const src = join(root, item);
    const dest = join(dist, item);
    if (!existsSync(src)) {
      console.warn(`  skip  ${item} (not found)`);
      continue;
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
  console.log(`      dist/    — unzipped output\n`);
}

export interface ProdConfig {
  name: string;
  root: string;
  uiBuilds: Array<{
    source: string;
    install?: boolean;
    label?: string;
  }>;
  include: string[];
}

export function runProd(config: ProdConfig, AdmZipClass: new () => ZipLike) {
  const { name, root, uiBuilds, include } = config;

  for (const ui of uiBuilds) {
    const cwd = join(root, ui.source);
    if (ui.install !== false) installDeps(cwd);
    buildViteUI(cwd, ui.label);
  }

  const dist = join(root, "dist");
  stageFiles(root, dist, include);
  createZip(new AdmZipClass(), dist, join(root, `${name}.zip`), name);
}
