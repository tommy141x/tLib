/**
 * `internal/` is private and this repo is public MIT. These assert the things that
 * keep it that way, because ".gitignore says so" is a claim nobody re-checks.
 *
 * THE INVARIANT CHANGED, and the difference is the whole point of this file.
 * `internal/` used to be a nested repository, which made the split structural:
 * `git add -f` recorded a gitlink rather than file contents, and `git clean -xdf`
 * stepped over it. It is now ordinary tracked content on a Gitea-only branch, so
 * it has neither property. The rule is no longer "internal/ is never tracked"
 * but "internal/ is never tracked ON A PUBLISHED BRANCH", and the only thing
 * enforcing that is `.githooks/pre-push` plus branch discipline.
 *
 * So this suite asserts a different pair depending on where it runs, and which
 * branch that is, is decided by the tree rather than by a branch NAME — a name
 * is a convention and renaming one must not silently disable the gate.
 *
 * A public clone has no `internal/` at all and this suite runs there too, as
 * part of `verify`. Everything below holds there: an absent directory is still
 * ignored, nothing is tracked under it, and the hook is tracked on main so it
 * ships with the clone.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..");

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: REPO, encoding: "utf8" }).trim();
}

/**
 * True on the private branch. Measured from what git TRACKS, not from the branch
 * name: `git ls-files` is the same question the publish decision turns on.
 */
const PRIVATE_BRANCH = git("ls-files", "internal").length > 0;

describe("the private half never reaches a published branch", () => {
  test("the pre-push hook exists and is wired", () => {
    // The guard that replaced the nested repository. It ships on every branch,
    // including a public clone, because a fork publishing to its own GitHub
    // wants it too.
    const hook = join(REPO, ".githooks", "pre-push");
    expect(existsSync(hook)).toBe(true);
    expect(git("config", "core.hooksPath")).toBe(".githooks");

    const body = readFileSync(hook, "utf8");
    // Both paths, or the hook is only half a guard.
    expect(body).toContain("internal/");
    expect(body).toContain(".gitea/");
    // It must key on the REMOTE, not the branch: pushing the private branch to
    // Gitea is the normal case and must not be refused.
    expect(body).toContain("github.com");
  });

  test("the hook refuses a private tree bound for a public remote", () => {
    // The gate's own negative control, run against real refs rather than a
    // fixture: without this the suite proves the file exists, not that it works.
    const head = git("rev-parse", "HEAD");
    const zero = "0".repeat(40);
    const feed = `refs/heads/x ${head} refs/heads/x ${zero}\n`;

    const run = (remote: string, url: string): number => {
      try {
        execFileSync("sh", [join(REPO, ".githooks", "pre-push"), remote, url], {
          cwd: REPO,
          input: feed,
          stdio: ["pipe", "pipe", "pipe"],
        });
        return 0;
      } catch (e) {
        return (e as { status?: number }).status ?? 1;
      }
    };

    const github = run("origin", "https://github.com/tommy141x/tLib.git");
    const gitea = run("gitea", "https://git.timmygstudios.com/TIMMYG-Studios/tLib.git");

    // Gitea always accepts; GitHub accepts only a branch with no private paths.
    expect(gitea).toBe(0);
    expect(github).toBe(PRIVATE_BRANCH ? 1 : 0);
  });

  test.skipIf(PRIVATE_BRANCH)("a published branch tracks nothing private", () => {
    expect(git("ls-files", "internal")).toBe("");
    expect(git("ls-files", ".gitea")).toBe("");
  });

  test.skipIf(PRIVATE_BRANCH)("and git ignores both, so they cannot be added by accident", () => {
    // check-ignore exits 1 when the path is NOT ignored, which execFileSync throws on.
    //
    // The trailing slash is load-bearing. The rules are `/internal/` and `/.gitea/`,
    // which match directories only, and check-ignore decides whether a path is a
    // directory by looking at the disk. On a public clone nothing is there, so
    // `check-ignore internal` reports NOT ignored and this would fail for a reason
    // that has nothing to do with the rule. Naming a directory explicitly gives the
    // same answer either way.
    expect(() => git("check-ignore", "-q", "internal/")).not.toThrow();
    expect(() => git("check-ignore", "-q", ".gitea/")).not.toThrow();
  });

  test.skipIf(!PRIVATE_BRANCH)("the private branch really does carry both", () => {
    // The other half of the control: if this branch stopped carrying them the
    // skipIf above would silently disable the published-branch assertions too.
    expect(git("ls-files", "internal").length).toBeGreaterThan(0);
    expect(git("ls-files", ".gitea").length).toBeGreaterThan(0);
  });
});
