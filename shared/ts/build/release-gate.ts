/**
 * Refuses a release that cannot be told apart from the one before it.
 *
 * tLib 1.1 was republished four times under one number while the `v1.1` tag stayed on
 * the first commit, and `prod` zips the WORKING TREE, so what customers held matched no
 * commit. Every one of those builds printed `v1.1 -- up to date`. `version` is the
 * compatibility contract (`tlib_min_version` compares it), so a build someone could be
 * running needs a version of its own; the tag is the record that the version is taken.
 *
 *   dirty tree        refused: the zip would hold bytes no commit holds
 *   tag, other tree   refused: that version already names different bytes
 *   odd version shape refused: see `assertVersionShape`
 *
 * `dev` skips all three, for building to look at rather than to ship.
 */

import { readBackVersions, throwIfMissed, toSemver, type VersionTarget } from "./version.ts";

export type Git = (args: string[]) => { ok: boolean; out: string };

export const bunGit =
  (cwd: string): Git =>
  (args) => {
    const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    return { ok: proc.exitCode === 0, out: proc.stdout.toString().trim() };
  };

export interface ReleaseState {
  version: string;
  /** `abc1234`, or `abc1234+dirty` for a dev build off a modified tree. */
  commit: string;
  /** A dev build: no gate ran and nothing is tagged. */
  dev: boolean;
  /** The gate passed and no tag names this version yet. */
  needsTag: boolean;
}

/**
 * `X.Y`, or `X.Y.Z` with Z above zero. The manifest drops a trailing `.0`
 * (250cec3, tDetector), so `1.1` and `1.1.0` are the same version spelled two ways;
 * allowing both would let a second spelling dodge the tag lookup. A patch exists only
 * to say "same X.Y, different bytes", which is why it is the one thing that may appear.
 */
export function assertVersionShape(version: string): void {
  if (!/^\d+\.\d+(\.[1-9]\d*)?$/.test(version)) {
    throw new Error(
      `fxmanifest.lua version '${version}' is not X.Y or X.Y.Z (Z above zero). A trailing .0 is ` +
        `dropped, not written: '1.1', then '1.1.1'.`
    );
  }
}

/** Tags that could name `version`: the manifest spelling and its padded semver. */
function tagNames(version: string): string[] {
  return [...new Set([`v${version}`, `v${toSemver(version)}`])];
}

export async function assertReleasable(opts: {
  root: string;
  version: string;
  dev: boolean;
  versionTargets?: VersionTarget[];
  git: Git;
}): Promise<ReleaseState> {
  const { root, version, dev, git } = opts;

  const head = git(["rev-parse", "--short=7", "HEAD"]);
  const dirty = git(["status", "--porcelain", "--untracked-files=all"]);
  if (!head.ok || !dirty.ok) {
    if (dev) return { version, commit: "unknown", dev, needsTag: false };
    throw new Error(
      `${root} is not a git checkout, so this build cannot be tied to a commit. Release from a ` +
        `clone, or pass --dev for a build that will not be shipped.`
    );
  }
  const isDirty = dirty.out !== "";
  const commit = isDirty ? `${head.out}+dirty` : head.out;
  if (dev) return { version, commit, dev, needsTag: false };

  assertVersionShape(version);

  for (const { file, expected, actual } of await readBackVersions(
    opts.versionTargets ?? [],
    root
  )) {
    throwIfMissed(file, expected, actual, version);
  }

  if (isDirty) {
    const files = dirty.out.split("\n").slice(0, 8).join("\n  ");
    throw new Error(
      `The working tree has uncommitted changes, and the zip is built from the working tree, ` +
        `so it would match no commit:\n  ${files}\nCommit them, or pass --dev for a build that ` +
        `will not be shipped.`
    );
  }

  const tree = git(["rev-parse", "HEAD^{tree}"]).out;
  for (const tag of tagNames(version)) {
    const tagged = git(["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{tree}`]);
    if (!tagged.ok) continue;
    if (tagged.out !== tree) {
      throw new Error(
        `Version ${version} is already released as tag ${tag}, on different files than this ` +
          `tree holds. A build somebody may be running needs a version of its own: raise ` +
          `'version' in fxmanifest.lua (and package.json), commit, and run again.`
      );
    }
    return { version, commit, dev, needsTag: false };
  }
  return { version, commit, dev, needsTag: true };
}

/** Records the version as taken. Annotated so the build id travels with the tag. */
export function tagRelease(git: Git, name: string, version: string, buildId: string): string {
  const tag = `v${version}`;
  const made = git(["tag", "-a", tag, "-m", `${name} ${version} build ${buildId}`]);
  if (!made.ok) {
    throw new Error(
      `The zip is built but tag ${tag} could not be created (${made.out || "git failed"}). ` +
        `Create it before uploading, or the next build will not know ${version} is taken.`
    );
  }
  return tag;
}
