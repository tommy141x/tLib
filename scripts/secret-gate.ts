#!/usr/bin/env bun
/**
 * The one secret gate, run by every resource.
 *
 * THIS FILE LIVES IN tLib AND IS RUN BY ALL OF THEM. The per-resource part
 * is a `.githooks/pre-commit` shim, two `package.json` scripts and a CI
 * workflow — nothing that can drift. The precedent is tUnit's `scan:solid2`,
 * which already runs `../tLib/scripts/solid2-scan.ts` for exactly this reason:
 * "a rule that has drifted reports zero, and zero reads exactly like a finished
 * migration".
 *
 * Usage
 *
 *   bun run ../tLib/scripts/secret-gate.ts                 # HEAD  (CI backstop)
 *   bun run ../tLib/scripts/secret-gate.ts --staged        # index (pre-commit)
 *   bun run ../tLib/scripts/secret-gate.ts --worktree      # local, informational
 *   bun run ../tLib/scripts/secret-gate.ts --install-hooks # core.hooksPath=.githooks
 *   bun run ../tLib/scripts/secret-gate.ts --check-hooks   # is the hook installed?
 *   bun run ../tLib/scripts/secret-gate.ts --repo ../tRadio
 *
 * Exit codes: 0 clean, 1 a credential has a value, 2 the gate could not run
 * (no repo, no config files found, a malformed policy). A 2 is NOT a pass.
 *
 * Where a developer's local value lives
 *
 * Not in the tracked file. The tracked `config.lua` holds blanks permanently
 * and the real values live in a gitignored sidecar next to it
 * (`config.local.lua`), which `tlib.secrets` overlays onto `Config` at server
 * start. That is the answer to the question every other mechanism gets wrong:
 * a clean/smudge filter or a strip-on-commit leaves the committed blob blank
 * and the working tree holding a value, so the next `git checkout` or `pull`
 * that touches `config.lua` OVERWRITES the developer's credential with the
 * blank — silently, and with no copy anywhere. With the sidecar there is
 * nothing to strip, nothing to restore, and a pull cannot reach the value
 * because git has never heard of the file.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  coverage,
  formatReport,
  type GatePolicy,
  type GateReport,
  isConfigPath,
  isIgnored,
  judge,
  readPolicy,
} from "../shared/ts/secrets/gate.ts";
import { hookIsCurrent, writeHook } from "../shared/ts/secrets/hook.ts";
import { secretPatterns } from "../shared/ts/secrets/patterns.ts";
import { blankSecrets } from "../shared/ts/secrets/scan.ts";

export { blankSecrets, coverage, isConfigPath, judge, readPolicy, secretPatterns };

const HOOKS_PATH = ".githooks";

function git(repo: string, args: string[]): { ok: boolean; out: string } {
  const result = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
  return {
    ok: result.exitCode === 0,
    out: new TextDecoder().decode(result.exitCode === 0 ? result.stdout : result.stderr),
  };
}

function die(message: string): never {
  console.error(message);
  process.exit(2);
}

/** Tracked config files, by the rule in `gate.ts`, minus the policy's ignores. */
export function configFiles(repo: string, policy: GatePolicy): string[] {
  const tracked = git(repo, ["ls-files", "-z"]);
  if (!tracked.ok) die(`secret-gate: \`git ls-files\` failed in ${repo}:\n${tracked.out}`);

  const all = tracked.out.split("\0").filter(Boolean);
  const candidates = all.filter((file) => isConfigPath(file) || policy.extraFiles.includes(file));
  const kept = candidates.filter((file) => isIgnored(file, policy) === null);

  for (const extra of policy.extraFiles) {
    if (!all.includes(extra)) {
      die(
        `secret-gate: secretGate.extraFiles names "${extra}", which is not tracked in ` +
          `${repo}. A gate pointed at a path that does not exist reads clean.`
      );
    }
  }

  if (kept.length === 0) {
    if (policy.noConfig) {
      console.log(`  🔒 no tracked config file, declared: ${policy.noConfig}`);
      return [];
    }
    die(
      `secret-gate: no tracked config file found in ${repo}.\n` +
        "  The rule is: a tracked .lua whose basename contains `config`, or one under a\n" +
        "  `config/` directory, or a dotenv file. Zero of those means either this repo\n" +
        '  genuinely has no config — in which case set `"secretGate": { "noConfig": "<why>" }`\n' +
        "  in package.json, deliberately and with a reason — or the rule has stopped\n" +
        "  matching. Either way it is not a pass."
    );
  }
  if (policy.noConfig) {
    die(
      `secret-gate: ${repo} declares secretGate.noConfig ("${policy.noConfig}") but the ` +
        `config rule matches ${kept.length} tracked file(s):\n` +
        kept.map((f) => `    ${f}`).join("\n") +
        "\n  Remove noConfig. A declaration that this repo has no config, in a repo that " +
        "has one,\n  is the gate reporting on a file set it was told to ignore."
    );
  }
  return kept.sort();
}

type Source = GateReport["source"];

type ReadFiles = {
  contents: Array<{ file: string; content: string }>;
  /** Tracked but with no blob at this source — a newly added, uncommitted path. */
  absent: string[];
  /** Files read from the index because HEAD has no blob for them yet. */
  fromIndex: string[];
};

/**
 * A file this could not read is reported, never swallowed.
 *
 * MEASURED 2026-10-06: tDB has `config.example.lua` staged as an ADD and
 * `config.lua` staged as a delete, so at HEAD neither exists. An earlier draft
 * dropped a file whose `git show` failed and printed
 * "0 tracked config file(s) read at HEAD … all blank", exit 0 — a clean verdict
 * over a repo whose only config file it had not read.
 *
 * In `head` mode a tracked file with no HEAD blob is read from the INDEX
 * instead, and said so. "Is this blank at HEAD" is vacuous for a file that is
 * not at HEAD yet, and the staged blob is the thing that is about to become
 * HEAD — so the fallback is strictly more coverage, never less. Without it a
 * repo mid-migration (tDB, exactly) gets a permanent exit 2 from its own
 * `verify`, and a gate that is red for a reason nobody can fix is a gate that
 * gets deleted.
 *
 * Reading NONE of the files it identified is still a refusal (exit 2).
 */
function readAt(repo: string, source: Source, files: string[]): ReadFiles {
  const contents: Array<{ file: string; content: string }> = [];
  const absent: string[] = [];
  const fromIndex: string[] = [];
  for (const file of files) {
    if (source === "worktree") {
      const full = path.join(repo, file);
      if (fs.existsSync(full)) contents.push({ file, content: fs.readFileSync(full, "utf8") });
      else absent.push(file);
      continue;
    }
    const spec = source === "head" ? `HEAD:${file}` : `:${file}`;
    const blob = git(repo, ["show", spec]);
    if (blob.ok) {
      contents.push({ file, content: blob.out });
      continue;
    }
    if (source === "head") {
      const staged = git(repo, ["show", `:${file}`]);
      if (staged.ok) {
        contents.push({ file, content: staged.out });
        fromIndex.push(file);
        continue;
      }
    }
    absent.push(file);
  }
  return { contents, absent, fromIndex };
}

const HINT = [
  "  How to fix, and how to stop it coming back:",
  "",
  "    1. Blank the value in the tracked config file.",
  "    2. Put the real value in the gitignored sidecar beside it — `config.local.lua`",
  "       for a Lua config, `.env` for a dotenv one. For a Lua config the sidecar is a",
  "       plain table that is overlaid onto Config at server start:",
  "",
  "           -- config.local.lua  (gitignored; never committed, never packaged)",
  "           return { authToken = 'a-real-value', discord = { botToken = 'another' } }",
  "",
  "    The tracked file stays blank forever, so there is nothing to strip at commit",
  "    time and nothing a `git pull` can overwrite. That is the point of the sidecar:",
  "    a mechanism that strips on commit has to put the value back on checkout, and",
  "    the one that does not is the one that deletes your credential.",
  "",
  "  If a key legitimately ships non-blank, add it to `secretGate.allow` in",
  "  package.json WITH THE REASON. An exemption without a reason outlives its cause.",
].join("\n");

function hooksInstalled(repo: string): { installed: boolean; value: string } {
  const configured = git(repo, ["config", "--get", "core.hooksPath"]);
  const value = configured.ok ? configured.out.trim() : "";
  return { installed: value === HOOKS_PATH, value };
}

function main(): void {
  const argv = process.argv.slice(2);
  const repoArg = argv.indexOf("--repo");
  const repo = path.resolve(repoArg === -1 ? process.cwd() : (argv[repoArg + 1] ?? "."));

  if (!fs.existsSync(path.join(repo, ".git"))) {
    die(`secret-gate: ${repo} is not a git repository (no .git). Pass --repo <path>.`);
  }

  if (argv.includes("--write-hooks")) {
    // Writes the canonical bytes. Separate from --install-hooks so a developer
    // setting up a clone never silently rewrites a tracked file.
    const changed = writeHook(repo);
    const marked = git(repo, ["update-index", "--add", "--chmod=+x", `${HOOKS_PATH}/pre-commit`]);
    if (!marked.ok) {
      die(`secret-gate --write-hooks: could not mark the hook executable:\n${marked.out}`);
    }
    console.log(
      `  🔒 ${HOOKS_PATH}/pre-commit ${changed ? "written" : "already current"} in ` +
        `${path.basename(repo)} (mode +x in the index)`
    );
    return;
  }

  if (argv.includes("--install-hooks")) {
    if (!hookIsCurrent(repo)) {
      die(
        `secret-gate --install-hooks: ${HOOKS_PATH}/pre-commit in ${repo} is missing or is ` +
          "not the canonical bytes from tLib's shared/ts/secrets/hook.ts.\n" +
          "  Refresh it:  bun run ../tLib/scripts/secret-gate.ts --write-hooks\n" +
          "  A stale hook is the one failure mode a hook cannot report about itself."
      );
    }
    const set = git(repo, ["config", "core.hooksPath", HOOKS_PATH]);
    if (!set.ok) die(`secret-gate --install-hooks: could not set core.hooksPath:\n${set.out}`);
    console.log(`  🔒 core.hooksPath = ${HOOKS_PATH} in ${path.basename(repo)}`);
    return;
  }

  if (argv.includes("--check-hooks")) {
    const { installed, value } = hooksInstalled(repo);
    if (installed && !hookIsCurrent(repo)) {
      console.error(
        `✗ ${path.basename(repo)} has core.hooksPath = ${HOOKS_PATH}, but the hook there is ` +
          "not tLib's current bytes.\n    Fix:  bun run secrets:write-hooks"
      );
      process.exit(1);
    }
    if (installed) {
      console.log(`  🔒 pre-commit secret gate installed (core.hooksPath = ${HOOKS_PATH})`);
      return;
    }
    console.error(
      `✗ the pre-commit secret gate is NOT installed in ${path.basename(repo)}.\n` +
        `    core.hooksPath is ${value === "" ? "unset" : `"${value}"`}, so git is using\n` +
        "    .git/hooks, which is not tracked and does not contain it.\n\n" +
        "    Fix:  bun run secrets:install-hooks\n\n" +
        "    This is a convenience layer, not the guarantee — CI checks HEAD regardless.\n" +
        "    Without the hook you simply find out later and in public."
    );
    process.exit(1);
  }

  const packageJsonPath = path.join(repo, "package.json");
  let policy: GatePolicy;
  try {
    const raw = fs.existsSync(packageJsonPath)
      ? JSON.parse(fs.readFileSync(packageJsonPath, "utf8"))
      : null;
    policy = readPolicy(raw);
  } catch (error) {
    die(`secret-gate: ${packageJsonPath}: ${(error as Error).message}`);
  }

  const source: Source = argv.includes("--staged")
    ? "staged"
    : argv.includes("--worktree")
      ? "worktree"
      : "head";

  const files = configFiles(repo, policy);

  if (argv.includes("--list")) {
    console.log(files.join("\n"));
    return;
  }

  const { contents, absent, fromIndex } = readAt(repo, source, files);
  if (files.length > 0 && contents.length === 0) {
    die(
      `secret-gate: identified ${files.length} tracked config file(s) in ${repo} but could\n` +
        `  read none of them ${source === "head" ? "at HEAD" : `in the ${source}`}:\n` +
        absent.map((f) => `    ${f}`).join("\n") +
        "\n  A gate that read nothing is not a gate that passed."
    );
  }

  const report = judge(source, contents, policy);

  if (argv.includes("--coverage")) {
    console.log([...coverage(contents)].sort().join("\n"));
    return;
  }

  console.log(formatReport(report, HINT));
  for (const file of fromIndex) {
    console.log(
      `     • ${file}: not at HEAD yet (a staged add) — read from the INDEX instead, which ` +
        "is the blob about to become HEAD"
    );
  }
  for (const file of absent) {
    console.log(
      `     • ${file}: tracked but not present ${source === "head" ? "at HEAD" : `in the ${source}`} ` +
        "(a staged add or delete) — not read"
    );
  }
  if (report.offences.length > 0) process.exit(1);
}

if (import.meta.main) main();
