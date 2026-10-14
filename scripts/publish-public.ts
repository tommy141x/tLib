#!/usr/bin/env bun
// Replays `internal` onto the published branch with the private paths removed.
//
// tLib develops on `internal` and publishes `main`. `internal` carries the
// private half — the provenance engine under internal/, and the .gitea/
// workflows that name the private org — and `main` carries neither.
//
// WHY A SCRIPT AND NOT A HOOK ALONE. A push sends commits, and every commit on
// `internal` contains those paths. There is no refspec, filter or hook that
// publishes "the same commit minus a directory": the public branch has to be a
// DIFFERENT commit, with a different tree and a different sha. This builds it.
//
// WHY A THROWAWAY WORKTREE. `internal/` is tracked on `internal` and absent
// from `main`, so `git checkout main` DELETES it from disk — and six sibling
// resources import `tLib/internal/...` by relative path at build time, so they
// all break at once with `Cannot find module` and no other warning. That
// happened. The working directory must never leave `internal`, so `main` is
// only ever touched inside a temporary worktree this script removes again.
//
// Per-commit replay rather than one squashed publish, so the public history
// stays real. A commit touching ONLY private paths produces nothing public and
// is skipped rather than landing as an empty commit.
//
// The high-water mark lives in `refs/publish/last-internal`, a local ref. Not a
// file, because a file tracking publish state would itself have to ship in the
// public tree.
//
// Usage:  bun run publish:public [--dry-run]
// Exit 1 = a replay conflicted and the worktree was left for inspection.
// Exit 2 = refused: the repo is not in the state this assumes. NOT a pass.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..");
const PRIVATE = ["internal", ".gitea"];
const SOURCE = "internal";
const PUBLISHED = "main";
const MARK = "refs/publish/last-internal";

const dryRun = process.argv.includes("--dry-run");

function git(args: string[], cwd = REPO): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function tryGit(args: string[], cwd = REPO): string | null {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

function refuse(message: string): never {
  console.error(`publish-public: ${message}`);
  process.exit(2);
}

// The assumptions, checked rather than trusted.
if (git(["rev-parse", "--abbrev-ref", "HEAD"]) !== SOURCE) {
  refuse(`run this from the ${SOURCE} branch — it is the one that has every path.`);
}
if (git(["status", "--porcelain"]) !== "") {
  refuse("the working tree is dirty. Replaying onto a second worktree needs a clean source.");
}
for (const path of PRIVATE) {
  if (git(["ls-files", path]) === "") {
    refuse(
      `${path}/ is not tracked on ${SOURCE}. Either you are on the wrong branch or the ` +
        "private half has gone missing — publishing now would silently ship a tree that is " +
        "public because something was lost, not because it was filtered."
    );
  }
}

// Everything on `internal` since the last publish. The mark is the source-side
// sha, so this stays correct even though the published shas differ.
const mark = tryGit(["rev-parse", "--verify", `${MARK}^{commit}`]);
const range = mark ? `${mark}..${SOURCE}` : `${PUBLISHED}..${SOURCE}`;
const todo = git(["rev-list", "--reverse", "--no-merges", range]).split("\n").filter(Boolean);

if (todo.length === 0) {
  console.log("publish-public: nothing new to publish");
  process.exit(0);
}
console.log(`publish-public: ${todo.length} commit(s) to replay onto ${PUBLISHED}`);

if (dryRun) {
  for (const sha of todo) console.log(`  ${git(["log", "-1", "--format=%h %s", sha])}`);
  process.exit(0);
}

const work = mkdtempSync(join(tmpdir(), "tlib-publish-"));
let published = 0;
let skipped = 0;

try {
  git(["worktree", "add", "--quiet", work, PUBLISHED]);

  for (const sha of todo) {
    const subject = git(["log", "-1", "--format=%s", sha]);

    // -n so the private paths can be dropped before anything is recorded.
    if (tryGit(["cherry-pick", "-n", "--allow-empty", sha], work) === null) {
      console.error(`publish-public: ${sha.slice(0, 9)} ${subject}`);
      console.error(`  conflicted. The worktree is at ${work} for inspection; resolve or reset.`);
      process.exit(1);
    }

    for (const path of PRIVATE) {
      if (existsSync(join(work, path))) {
        tryGit(["rm", "-r", "--quiet", "--cached", "--ignore-unmatch", path], work);
        rmSync(join(work, path), { recursive: true, force: true });
      }
    }

    // A commit that only touched private paths leaves nothing to say.
    if (git(["diff", "--cached", "--name-only"], work) === "") {
      tryGit(["reset", "--hard", "--quiet"], work);
      skipped++;
      continue;
    }

    // Author, date and message carried over: the public commit IS this change,
    // not a report about it.
    const author = git(["log", "-1", "--format=%an <%ae>", sha]);
    const date = git(["log", "-1", "--format=%aI", sha]);
    git(["commit", "--quiet", "--no-verify", "-C", sha, "--author", author, "--date", date], work);
    published++;
  }

  git(["update-ref", MARK, git(["rev-parse", SOURCE])]);
  console.log(
    `publish-public: ${published} published, ${skipped} private-only skipped. ` +
      `${PUBLISHED} is now ${git(["rev-parse", "--short", PUBLISHED])}.`
  );
  console.log("  Push it with:  git push origin main");
} finally {
  tryGit(["worktree", "remove", "--force", work]);
  tryGit(["worktree", "prune"]);
}
