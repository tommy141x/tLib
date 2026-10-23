#!/usr/bin/env bun
// Replays `internal` onto the published branch with the private paths removed.
// `internal` carries the private half — the provenance engine under internal/
// and the .gitea/ workflows that name the private org — and `main` neither.
//
// WHY A SCRIPT AND NOT A HOOK ALONE. Every commit on `internal` contains those
// paths, and no refspec, filter or hook publishes "the same commit minus a
// directory": the public branch has to be a DIFFERENT commit, with a different
// tree and sha. Replay is per-commit so the public history stays real, and a
// private-only commit is skipped rather than landing empty. The high-water
// mark is `refs/publish/last-internal`, a local ref — a file tracking publish
// state would itself have to ship in the public tree.
//
// WHY A THROWAWAY WORKTREE. `internal/` is absent from `main`, so
// `git checkout main` DELETES it from disk and every sibling resource that
// imports `tLib/internal/...` relatively breaks at once with `Cannot find
// module`. That happened. `main` is only touched inside a temporary worktree.
//
// Usage:  bun run publish:public [--dry-run]
// Exit 1 = a replay conflicted and the worktree was left for inspection.
// Exit 2 = refused: the repo is not in the state this assumes. NOT a pass.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..");
// Directories, plus single files. Both readers cope with a file: the skip test
// is `p === d || p.startsWith(`${d}/`)`, the removal an existsSync + rmSync.
// `scripts/deck-publish.ts` is listed unguarded because nothing references it.
//
// WARNING: A TEST OF PRIVATE CODE IS PRIVATE. The test files below import from
// `internal/`, which this script strips — so publishing them put an import of a
// path that does not exist on `main` into a tsconfig that includes `tests`, and
// `bun run typecheck` then failed on EVERY push. It was invisible from
// `internal`, where it resolves. `publishedEntriesAreSelfContained` stops it.
const PRIVATE = [
  "internal",
  ".gitea",
  "scripts/deck-publish.ts",
  "client/web/tests/export-badge.test.tsx",
  "client/web/tests/confirm-delete-unmount.test.tsx",
  "client/web/tests/harness.test.tsx",
  // These two reached `main` while the guard below was throwing instead of
  // checking. Listing them here removes them: the strip loop deletes any
  // PRIVATE path in the worktree, so the next replayed commit carries that.
  "client/web/tests/prop-editor-guard.test.tsx",
  "client/web/tests/undo-redo-ui.test.tsx",
];
const SOURCE = "internal";
const PUBLISHED = "main";
const MARK = "refs/publish/last-internal";

const dryRun = process.argv.includes("--dry-run");

function git(args: string[], cwd = REPO): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** `git`, but a non-zero exit is an answer rather than a throw. Stderr is
 *  swallowed: the first run asks for a ref that does not exist yet, and a
 *  `fatal:` on a successful run reads as a failure. */
function tryGit(args: string[], cwd = REPO): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

function refuse(message: string): never {
  console.error(`publish-public: ${message}`);
  process.exit(2);
}

if (git(["rev-parse", "--abbrev-ref", "HEAD"]) !== SOURCE) {
  refuse(`run this from the ${SOURCE} branch — it is the one that has every path.`);
}
if (git(["status", "--porcelain"]) !== "") {
  refuse("the working tree is dirty. Replaying onto a second worktree needs a clean source.");
}
for (const path of PRIVATE) {
  if (git(["ls-files", path]) === "") {
    refuse(
      `${path} is not tracked on ${SOURCE}. Either you are on the wrong branch or the ` +
        "private half has gone missing — publishing now would silently ship a tree that is " +
        "public because something was lost, not because it was filtered."
    );
  }
}

// The mark is the source-side sha, so the range survives the differing shas.
const mark = tryGit(["rev-parse", "--verify", `${MARK}^{commit}`]);
const range = mark ? `${mark}..${SOURCE}` : `${PUBLISHED}..${SOURCE}`;
// --first-parent is load-bearing. internal/ arrived by `git subtree` and those
// commits keep their ORIGINAL paths (src/, bin/) — the internal/ prefix comes
// from the merge. Reachable only through its second parent, they otherwise
// read as public-path commits that conflict against unrelated ancestry.
const todo = git(["rev-list", "--reverse", "--first-parent", "--no-merges", range])
  .split("\n")
  .filter(Boolean);

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

    // Decide BEFORE cherry-picking. Picking a private-only commit is not just
    // wasted work: internal/ arrived by subtree from a repo with its own root,
    // so it conflicts against a branch sharing no ancestry with it.
    const touched = git(["diff-tree", "--no-commit-id", "--name-only", "-r", "--root", sha])
      .split("\n")
      .filter(Boolean);
    if (touched.every((p) => PRIVATE.some((d) => p === d || p.startsWith(`${d}/`)))) {
      skipped++;
      continue;
    }

    // -n so a private path the commit also touched is dropped before recording.
    if (tryGit(["cherry-pick", "-n", "--allow-empty", sha], work) === null) {
      // A MIXED commit -- one that edits published files and also touches a
      // private path -- conflicts here even though the private half is deleted
      // just below. `main` has no internal/ history for the merge to stand on,
      // so every internal/ path comes back DU (deleted by us, modified by
      // them), which is not a conflict in anything this branch publishes. A
      // --dry-run cannot see it because it never applies a pick. Resolve by
      // removal; fail only when a PUBLISHED path conflicted, which is real.
      const unmerged = git(["diff", "--name-only", "--diff-filter=U"], work)
        .split("\n")
        .filter(Boolean);
      const publicConflicts = unmerged.filter(
        (p) => !PRIVATE.some((d) => p === d || p.startsWith(`${d}/`))
      );
      if (unmerged.length === 0 || publicConflicts.length > 0) {
        console.error(`publish-public: ${sha.slice(0, 9)} ${subject}`);
        for (const p of publicConflicts) console.error(`  conflicted: ${p}`);
        console.error(`  The worktree is at ${work} for inspection; resolve or reset.`);
        process.exit(1);
      }
      for (const path of unmerged) {
        tryGit(["rm", "-r", "--quiet", "--cached", "--ignore-unmatch", path], work);
        rmSync(join(work, path), { recursive: true, force: true });
      }
    }

    for (const path of PRIVATE) {
      if (existsSync(join(work, path))) {
        tryGit(["rm", "-r", "--quiet", "--cached", "--ignore-unmatch", path], work);
        rmSync(join(work, path), { recursive: true, force: true });
      }
    }

    // Nothing staged: the public half is already on the branch, or every path
    // that survived the pick was stripped as private above.
    if (git(["diff", "--cached", "--name-only"], work) === "") {
      tryGit(["reset", "--hard", "--quiet"], work);
      skipped++;
      continue;
    }

    // The public commit IS this change, not a report about it.
    const author = git(["log", "-1", "--format=%an <%ae>", sha]);
    const date = git(["log", "-1", "--format=%aI", sha]);
    git(["commit", "--quiet", "--no-verify", "-C", sha, "--author", author, "--date", date], work);
    published++;
  }

  // The published tree must not reach into a path we strip. Scanned from the
  // WORKTREE, which is the published tree itself, so this measures what a
  // consumer gets rather than what we think we sent. Grep rather than a parse:
  // a static import, a dynamic one and a `new URL(...)` have all turned up.
  const reaching = git(["ls-files"], work)
    .split("\n")
    .filter((f) => /\.(ts|tsx|lua|css)$/.test(f))
    .filter((f) => {
      const body = readFileSync(join(work, f), "utf8");
      // Only a MODULE SPECIFIER counts, not prose. A bare `[./]internal/` also
      // matched a `docs/internal/…` mention in a comment and a quoted rule in
      // a test, neither of which breaks `main`. The three forms that DO break
      // it put the path in quotes after `from`, `import(` or `new URL(`.
      return PRIVATE.some((d) => {
        if (d === ".gitea") return false;
        // Double-escaped on purpose: this is a TEMPLATE LITERAL, so `\b` is a
        // backspace and `\s` a plain `s` before the RegExp constructor sees
        // them. Written singly the source became an unbalanced group and threw
        // `Invalid regular expression: missing )` on every publish, wedging
        // the tool rather than checking anything.
        const spec = `["'\`][^"'\`]*[./]${d}/`;
        const lead = `(?:\\bfrom\\s*|\\bimport\\s*\\(\\s*|\\bURL\\s*\\(\\s*)`;
        return new RegExp(`${lead}${spec}`).test(body);
      });
    });
  if (reaching.length > 0) {
    // THROW, DO NOT process.exit. `finally` removes the throwaway worktree and
    // process.exit skips it, leaving `main` checked out in a temp dir so the
    // NEXT publish dies with "'main' is already used by worktree at …".
    throw new Error(
      "publish-public: these published files reference a path that is stripped from " +
        `${PUBLISHED}:\n` +
        reaching.map((f) => `  ${f}`).join("\n") +
        "\n\nThey resolve on `internal` and not on `main`, which is a branch that cannot " +
        "typecheck and an email on every push. Add them to PRIVATE, or stop them importing it."
    );
  }

  git(["update-ref", MARK, git(["rev-parse", SOURCE])]);
  console.log(
    `publish-public: ${published} published, ${skipped} private-only skipped. ` +
      `${PUBLISHED} is now ${git(["rev-parse", "--short", PUBLISHED])}.`
  );
  // BOTH REMOTES, AND GITEA IS THE ONE THAT GETS FORGOTTEN -- but ORIGIN is the
  // one the website reads. Docs do NOT reach tWeb from a gitea push: tWeb's own
  // `sync-github-docs.yml` PULLS them from github.com/tommy141x/tLib on a
  // schedule, so a doc edit committed but not on GitHub's `main` never appears,
  // and a run of that workflow rolls the site back to what GitHub last saw.
  // gitea still wants both branches: CI runs there and the private half lives
  // there. Nothing fails when that push is missed, hence saying it out loud.
  console.log("  Push it with:  git push origin main && git push gitea main");
  console.log("  origin is what the website reads: tWeb pulls docs/ from GitHub on a schedule.");
  console.log("  gitea is where CI runs and where the private half lives.");
} finally {
  tryGit(["worktree", "remove", "--force", work]);
  tryGit(["worktree", "prune"]);
}
