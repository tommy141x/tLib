/**
 * `internal/` is private and this repo is public MIT. These assert the things that
 * keep it that way, because ".gitignore says so" is a claim nobody re-checks.
 *
 * The load-bearing one is the nested repository. A plain ignored directory is only
 * as safe as everyone's discipline: `git add -f internal/` would stage the sources,
 * and `git clean -xdf` would delete them outright, with no history anywhere to
 * restore from. Because `internal/` is its own repository, git treats it as a
 * boundary instead — `add -f` records a gitlink rather than file contents, and
 * `clean -xdf` steps over it (removing it needs a second `-f`). The ignore rule is
 * then just tidiness on top of a structural guarantee.
 *
 * A public clone has no `internal/` at all, and this suite runs there too — it is
 * part of `verify`. So the two assertions that protect the split are unconditional,
 * because both hold on a public checkout: an absent directory is still ignored, and
 * it still has nothing tracked under it. Only the nested-repo assertion depends on
 * the private tree existing, so that one is skipped when it does not. Were it
 * unconditional, the gate guarding the public/private split would itself be a
 * dependency on the private half, and `bun run verify` would fail for everyone
 * outside this machine.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..");

/** False on a public clone, where the private tree was never checked out. */
const HAS_PRIVATE_TREE = existsSync(join(REPO, "internal"));

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: REPO, encoding: "utf8" }).trim();
}

describe("the private internal/ tree stays out of this public repo", () => {
  test("git ignores it", () => {
    // check-ignore exits 1 when the path is NOT ignored, which execFileSync throws on.
    //
    // The trailing slash is load-bearing. The rule in .gitignore is `/internal/`,
    // which matches directories only, and check-ignore decides whether a path is a
    // directory by looking at the disk. On a public clone nothing is there, so
    // `check-ignore internal` reports NOT ignored and this would fail for a reason
    // that has nothing to do with the rule. Asking about `internal/` names a
    // directory explicitly and gives the same answer either way. Measured both.
    const ignored = (() => {
      try {
        git("check-ignore", "internal/");
        return true;
      } catch {
        return false;
      }
    })();
    expect(ignored).toBe(true);
  });

  test("nothing under it is tracked", () => {
    expect(git("ls-files", "internal")).toBe("");
  });

  test.skipIf(!HAS_PRIVATE_TREE)(
    "it is its own repository, which is what makes add -f and clean -xdf safe",
    () => {
      // The repo root is internal/ itself; tProvenance is a directory inside it.
      // A nested repo is a directory containing .git; on a worktree .git is a file.
      expect(existsSync(join(REPO, "internal", ".git"))).toBe(true);
    },
  );

  test("the release allowlist names nothing under it", () => {
    // prod.ts lists every shipped path explicitly (a missing entry is a hard error),
    // so this is the whole surface a release could pick it up from.
    const prod = readFileSync(join(REPO, "scripts", "prod.ts"), "utf8");
    const entries = [...prod.matchAll(/^\s*"([^"]+)",$/gm)].map((m) => m[1]);
    expect(entries.length).toBeGreaterThan(10);
    expect(entries.filter((e) => e.startsWith("internal"))).toEqual([]);
  });
});
