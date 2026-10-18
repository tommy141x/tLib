/**
 * Core build utilities: logging, command execution, simple staging, and zip.
 * Zero npm dependencies — AdmZip is passed by the caller.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { describeSanitize, sanitizeStagedSecrets } from "../secrets/release.ts";
import { stageFontLicences } from "./font-licences.ts";
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

/**
 * Layer 2 of the credential gate, applied at the one chokepoint every release
 * passes through.
 *
 * Done HERE, inside `createZip`, on purpose. Before 2026-10-06 exactly one
 * resource sanitized its staged config (tRadio, with a four-name hand-written
 * array) and the other eight did not — including tCAD, whose `.env.example`
 * declares 23 credential keys. A per-resource call is a per-resource chance to
 * not have one. `createZip` is called by every resource that cuts a zip, with
 * the staged tree as its second argument, so putting it here is both the
 * shared implementation and the thin per-resource call.
 *
 * Values are blanked, not refused: a release is a derived artifact, so
 * rewriting its copy is free and cannot destroy anything. (The commit-time
 * layer refuses instead, because there the file IS the developer's.)
 *
 * `expectConfig: false` is for a resource that genuinely ships no config file —
 * tLib and tAFK. Say why at the call site; the default refusal exists because a
 * sanitizer that sanitized nothing prints a tick either way.
 */
export function createZip(
  zip: ZipLike,
  dist: string,
  zipPath: string,
  folderName: string,
  opts: { expectConfig?: boolean } = {}
) {
  step(`Creating ${folderName}.zip`);
  if (existsSync(zipPath)) rmSync(zipPath);
  const sanitized = sanitizeStagedSecrets(dist, opts);
  console.log(describeSanitize(sanitized));
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
  /**
   * Set false only for a resource that ships NO config file. `createZip`
   * refuses a staged tree with none by default, because a credential sanitizer
   * that found nothing to sanitize prints the same tick as one that worked.
   */
  expectConfig?: boolean;
  /**
   * Extra directories to find `OFL-<Family>.txt` in, relative to `root`, for a
   * resource that ships a face of its own. tLib's own font directory is always
   * searched and does not need listing.
   */
  fontLicenceDirs?: string[];
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

  // A licence beside every staged webfont, or refuse to build. After staging and
  // before zipping, deliberately: it has to read the tree that is about to be
  // shipped, because the two previous versions of this rule in the estate both
  // watched the build output instead and were green while the zip went out with
  // the fonts and none of their licences. See stageFontLicences.
  //
  // tLib's own font directory is always searched, since that is where Hanken
  // Grotesk, Inter and JetBrains Mono now come from for every consumer; a
  // resource adds its own via `fontLicenceDirs` when it ships a face of its own.
  const licences = stageFontLicences(dist, [
    ...(config.fontLicenceDirs ?? []).map((d) => join(root, d)),
    join(import.meta.dir, "..", "..", "css", "fonts"),
  ]);
  if (licences.copied.length > 0 || licences.satisfied.length > 0) {
    step("Font licences");
    for (const line of licences.copied) console.log(`  + ${line}`);
    console.log(
      `  ${licences.copied.length} copied, ${licences.satisfied.length} already covered`
    );
  }

  createZip(new AdmZipClass(), dist, join(root, ".build", `${name}.zip`), name, {
    expectConfig: config.expectConfig,
  });
}
