/**
 * `internal/` is private and this repo is public MIT. These assert the three things
 * that keep it that way, because ".gitignore says so" is a claim nobody re-checks.
 *
 * The load-bearing one is the nested repository. A plain ignored directory is only
 * as safe as everyone's discipline: `git add -f internal/` would stage the sources,
 * and `git clean -xdf` would delete them outright, with no history anywhere to
 * restore from. Because `internal/tProvenance` is its own repository, git treats it
 * as a boundary instead — `add -f` records a gitlink rather than file contents, and
 * `clean -xdf` steps over it (removing it needs a second `-f`). The ignore rule is
 * then just tidiness on top of a structural guarantee.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..");

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: REPO, encoding: "utf8" }).trim();
}

describe("the private internal/ tree stays out of this public repo", () => {
  test("git ignores it", () => {
    // check-ignore exits 1 when the path is NOT ignored, which execFileSync throws on.
    const ignored = (() => {
      try {
        git("check-ignore", "internal");
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

  test("it is its own repository, which is what makes add -f and clean -xdf safe", () => {
    // A nested repo is a directory containing .git; on a worktree .git is a file.
    expect(existsSync(join(REPO, "internal", "tProvenance", ".git"))).toBe(true);
  });

  test("the release allowlist names nothing under it", () => {
    // prod.ts lists every shipped path explicitly (a missing entry is a hard error),
    // so this is the whole surface a release could pick it up from.
    const prod = readFileSync(join(REPO, "scripts", "prod.ts"), "utf8");
    const entries = [...prod.matchAll(/^\s*"([^"]+)",$/gm)].map((m) => m[1]);
    expect(entries.length).toBeGreaterThan(10);
    expect(entries.filter((e) => e.startsWith("internal"))).toEqual([]);
  });
});
