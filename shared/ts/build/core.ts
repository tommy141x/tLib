/**
 * Core build utilities: logging, command execution, simple staging, and zip.
 * Zero npm dependencies — AdmZip is passed by the caller.
 */

import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { describeSanitize, sanitizeStagedSecrets } from "../secrets/release.ts";
import { stageFontLicences } from "./font-licences.ts";
import { checkLicenses, formatLicenseReport } from "./license.ts";
import { type LicenceSource, mergeLicenceFiles } from "./licence-bundle.ts";
import { assertManifestStaged } from "./manifest-coverage.ts";

export function step(label: string) {
  console.log(`\n→ ${label}`);
}

export function run(cmd: string, args: string[], cwd: string, env?: Record<string, string>) {
  const proc = Bun.spawnSync([cmd, ...args], {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
    env: env ? { ...process.env, ...env } : undefined,
  });
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

export const BUILD_STAMP_KEY = "tlib_build";

// Matches the blank lines ahead of the stamp too, so re-stamping is idempotent.
const STAMP_LINE = new RegExp(`\\n*^${BUILD_STAMP_KEY}\\s+'[^']*'[ \\t]*$\\n?`, "m");

function stagedPaths(dist: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(dist, prefix)).sort()) {
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(join(dist, rel)).isDirectory()) out.push(...stagedPaths(dist, rel));
    else out.push(rel);
  }
  return out;
}

/**
 * Stamp the staged manifest with a build id hashed from the staged bytes, not a version
 * bump: v1.0 was republished in place with a crash fix (`c9a8f8f`) and no version change, so
 * `tradio_diag` printed `tLib 1.0.0` for both trees with no way to confirm a customer had the
 * fix. The hash, derived from the bytes `prod` is about to zip, is the identity. Its own key,
 * never `version` — `imports.lua` enforces `tlib_min_version` out of that string and every
 * consumer pins `'1.0'`.
 */
export function stampBuildId(dist: string, now = new Date()): string {
  const manifestPath = join(dist, "fxmanifest.lua");
  // Trailing whitespace NORMALISED: stripping the stamp takes the blank line
  // ahead of it, so without this a restamp reports a new id for an unchanged tree.
  const bare = `${readFileSync(manifestPath, "utf8").replace(STAMP_LINE, "").trimEnd()}\n`;

  const hash = createHash("sha256");
  for (const rel of stagedPaths(dist)) {
    hash.update(rel);
    hash.update("\0");
    // The manifest hashes WITHOUT its stamp, or the id depends on the last id.
    hash.update(rel === "fxmanifest.lua" ? Buffer.from(bare, "utf8") : readFileSync(join(dist, rel)));
  }

  const id = `${now.toISOString().slice(0, 10).replace(/-/g, "")}-${hash.digest("hex").slice(0, 8)}`;
  writeFileSync(manifestPath, `${bare}\n${BUILD_STAMP_KEY} '${id}'\n`, "utf8");
  return id;
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
 * Layer 2 of the credential gate, at the one chokepoint every release passes through. Done
 * here, inside `createZip`, on purpose: before 2026-10-06 only tRadio sanitized its staged
 * config (a four-name hand-written array) while the other eight resources didn't, including
 * tCAD, whose `.env.example` declares 23 credential keys — a per-resource call is a
 * per-resource chance to skip it. Values are blanked, not refused, since a release is a
 * derived artifact and rewriting its copy is free (the commit-time layer refuses instead,
 * since there the file is the developer's). `expectConfig: false` is for a resource that
 * genuinely ships no config file (tLib, tAFK) — say why at the call site, since the default
 * refusal exists because a sanitizer finding nothing prints the same tick as one that worked.
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
  /**
   * The legal documents to merge into one `server/LICENSE.txt`, in reading order.
   *
   * Omitted means no merge, for a resource that ships none. When set, the files must
   * NOT also appear in `include` -- `mergeLicenceFiles` throws on a loose copy in the
   * staged tree, because two copies of a licence is how they come to disagree.
   */
  licenceSources?: LicenceSource[];
  /** `tlib_build` in the staged manifest (see `stampBuildId`). Opt-in: it changes
   *  the manifest of every resource that releases through here. */
  buildStamp?: boolean;
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

  // Both directions of the allowlist: stageFiles throws on an included path that no longer
  // exists; this throws on a path fxmanifest.lua declares that nobody added to `include` —
  // otherwise the release ships without a file the resource demands at start, and the
  // failure surfaces on a customer's server instead of here.
  assertManifestStaged(readFileSync(join(root, "fxmanifest.lua"), "utf8"), include);

  // Dependency licences, after the structural asserts and before anything is written —
  // running it here rather than per-resource is what makes it impossible to skip (tLib's own
  // release path never ran one before this). After the asserts, not before: a root with no
  // package.json fails the licence check, so a build actually missing an artifact used to
  // report "License compliance failed" instead of naming the missing file. Still unbypassable
  // either way — nothing is staged or zipped until this passes.
  step("Checking dependency licences");
  const depLicences = checkLicenses({ cwd: root });
  console.log(formatLicenseReport(depLicences));
  if (!depLicences.ok) {
    throw new Error(`License compliance failed with ${depLicences.failures.length} finding(s)`);
  }

  // Everything generated lands under one root, so .gitignore needs a single
  // rule and a new artifact can never reach a release by being forgotten.
  const dist = join(root, ".build", "dist");
  stageFiles(root, dist, include);

  // One merged `server/LICENSE.txt` rather than loose legal files at the resource root,
  // which is the first thing an operator sees when they extract the zip. The repo keeps
  // the documents separate; only the archive is merged.
  if (config.licenceSources) {
    step("Merging the licence and notices");
    const bundle = mergeLicenceFiles({
      root,
      dist,
      name,
      sources: config.licenceSources,
    });
    console.log(`  ${bundle.out} — ${bundle.sections.length} section(s), ${(bundle.bytes / 1024).toFixed(1)} KB`);
  }

  // A licence beside every staged webfont, or refuse to build — after staging and before
  // zipping, since two previous versions of this rule watched the build output instead and
  // stayed green while the zip shipped fonts with none of their licences. See
  // stageFontLicences. tLib's own font directory (Hanken Grotesk, Inter, JetBrains Mono) is
  // always searched; a resource adds its own via `fontLicenceDirs`.
  const licences = stageFontLicences(dist, [
    ...(config.fontLicenceDirs ?? []).map((d) => join(root, d)),
    join(import.meta.dir, "..", "..", "css", "fonts"),
  ]);
  if (licences.copied.length > 0 || licences.satisfied.length > 0) {
    step("Font licences");
    for (const line of licences.copied) console.log(`  + ${line}`);
    console.log(`  ${licences.copied.length} copied, ${licences.satisfied.length} already covered`);
  }

  // Last before the zip, so the id covers every staged byte.
  if (config.buildStamp) {
    step("Stamping the build id");
    console.log(`  ${BUILD_STAMP_KEY} '${stampBuildId(dist)}'`);
  }

  createZip(new AdmZipClass(), dist, join(root, ".build", `${name}.zip`), name, {
    expectConfig: config.expectConfig,
  });
}
