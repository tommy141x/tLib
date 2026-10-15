#!/usr/bin/env bun
/**
 * Install (or re-install, or verify) the secret gate's per-resource wiring in
 * every sibling resource.
 *
 * Why a provisioner and not eleven hand edits
 *
 * The gate itself is one implementation in tLib. The per-resource part is four
 * small things — a `.githooks/pre-commit`, three `package.json` scripts, a
 * `.gitignore` line and a CI workflow — and four small things times eleven
 * repos is forty-four chances for one to be the stale one. A stale copy of a
 * gate is silent, which is the whole failure mode being designed against here.
 *
 * So the wiring is generated, and `--check` asserts every repo's copy is
 * current. That check belongs in tLib's own `verify`: tLib is the only repo
 * from which all the siblings are visible.
 *
 * Usage:
 *   bun run scripts/secret-gate-provision.ts            # write/refresh
 *   bun run scripts/secret-gate-provision.ts --check     # assert, exit 1 on drift
 *   bun run scripts/secret-gate-provision.ts --only tRadio
 *
 * It does NOT run `git add`, `git commit` or `git config`. Writing files is
 * reversible and reviewable; staging and committing on a developer's behalf in
 * eleven repos is not. `core.hooksPath` is set by each resource's own
 * `secrets:install-hooks`, which is in its `setup`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { hookIsCurrent, PRE_COMMIT, writeHook } from "../shared/ts/secrets/hook.ts";
import { isStandaloneClone } from "./siblings.ts";

const tlibRoot = path.resolve(import.meta.dir, "..");
const scriptsRoot = path.resolve(tlibRoot, "..");

const SIDECAR_IGNORE = [
  "",
  "# The developer's real credentials. Never committed, never packaged.",
  "# The tracked config.lua holds blanks permanently; tlib.secrets overlays this",
  "# file onto Config at server start. See tLib/shared/imports/secrets/server.lua.",
  "config.local.lua",
  "config/config.local.lua",
  "",
].join("\n");

/**
 * The three scripts every resource gets. What the gate is and why it is shaped
 * this way lives in the header of secret-gate.ts, which is the file they run.
 */
function scriptsFor(repo: string): Record<string, string> {
  const gate = repo === "tLib" ? "scripts/secret-gate.ts" : "../tLib/scripts/secret-gate.ts";
  return {
    "secrets:check": `bun run ${gate}`,
    "secrets:install-hooks": `bun run ${gate} --install-hooks`,
    "secrets:check-hooks": `bun run ${gate} --check-hooks`,
  };
}

function workflowFor(): string {
  return `name: Secrets

# Layer 3 of 3, and the only one that cannot be skipped. What the gate asserts,
# and why gitleaks runs beside it rather than instead of it, is in the shared
# workflow this calls.

on:
  push:
  pull_request:
  workflow_dispatch:

jobs:
  secrets:
    uses: TIMMYG-Studios/workflows/.gitea/workflows/secrets.yml@main
    secrets: inherit
`;
}

type Change = { repo: string; what: string };

function provision(repo: string, repoRoot: string, check: boolean): Change[] {
  const changes: Change[] = [];

  // 1. The hook.
  if (!hookIsCurrent(repoRoot)) {
    changes.push({ repo, what: ".githooks/pre-commit is missing or stale" });
    if (!check) writeHook(repoRoot);
  }

  // 2. package.json scripts.
  //
  // Inserted TEXTUALLY, immediately after `"scripts": {`, never by
  // parse-and-restringify. Several of these package.json files have hand-set
  // indentation, and a round-trip through `JSON.stringify` reformats the whole
  // file. A one-line change that arrives as a 150-line diff
  // does not get reviewed, and in a tree where other work is in flight it is a
  // conflict for no reason.
  const packagePath = path.join(repoRoot, "package.json");
  if (fs.existsSync(packagePath)) {
    const text = fs.readFileSync(packagePath, "utf8");
    const parsed = JSON.parse(text) as { scripts?: Record<string, string> };
    const wanted = scriptsFor(repo);
    const scripts = parsed.scripts ?? {};
    const missing = Object.entries(wanted).filter(([key, value]) => scripts[key] !== value);
    if (missing.length > 0) {
      changes.push({ repo, what: `package.json scripts: ${missing.map(([k]) => k).join(", ")}` });
      if (!check) {
        const anchor = text.match(/^([ \t]*)"scripts"[ \t]*:[ \t]*\{[ \t]*\r?\n/m);
        if (!anchor || anchor.index == null) {
          throw new Error(
            `${packagePath}: no \`"scripts": {\` block to insert into. Add the three ` +
              "secrets:* scripts by hand rather than letting this reformat the file."
          );
        }
        const indent = `${anchor[1]}  `;
        const eol = text.includes("\r\n") ? "\r\n" : "\n";
        // Only the entries that are missing or wrong, so an existing one is not
        // duplicated. A duplicate key in JSON is last-wins and silent.
        const block = missing
          .map(([key, value]) => `${indent}${JSON.stringify(key)}: ${JSON.stringify(value)},`)
          .join(eol);
        const at = anchor.index + anchor[0].length;
        const stale = Object.keys(wanted).filter((key) => key in scripts);
        if (stale.length > 0) {
          throw new Error(
            `${packagePath} already has ${stale.join(", ")} with a different value. ` +
              "Update them by hand; rewriting an existing entry textually risks the wrong one."
          );
        }
        fs.writeFileSync(
          packagePath,
          `${text.slice(0, at)}${block}${eol}${text.slice(at)}`,
          "utf8"
        );
      }
    }
  }

  // 3. The sidecar must be gitignored BEFORE anybody is told to create one.
  const ignorePath = path.join(repoRoot, ".gitignore");
  const ignore = fs.existsSync(ignorePath) ? fs.readFileSync(ignorePath, "utf8") : "";
  if (!ignore.includes("config.local.lua")) {
    changes.push({ repo, what: ".gitignore does not cover config.local.lua" });
    if (!check) fs.writeFileSync(ignorePath, ignore.replace(/\n*$/, "\n") + SIDECAR_IGNORE, "utf8");
  }

  // 4. The CI workflow — the layer that cannot be skipped.
  //
  // tLib is exempt, and only tLib. It is published to GitHub, so its .gitea/
  // workflows live on a Gitea-only branch and are absent from the branch this
  // runs on — the directory naming the private org must not ship in a public
  // MIT repo. Every other resource here is Gitea-only and keeps the file in
  // its working tree, which is why the exemption is by name rather than by a
  // "does .gitea exist" test: a sibling that simply lost the directory is a
  // real finding and must stay one.
  if (repo !== "tLib") {
    const workflowPath = path.join(repoRoot, ".gitea", "workflows", "secrets.yml");
    const workflow = workflowFor();
    const existing = fs.existsSync(workflowPath) ? fs.readFileSync(workflowPath, "utf8") : null;
    if (existing !== workflow) {
      changes.push({ repo, what: ".gitea/workflows/secrets.yml is missing or stale" });
      if (!check) {
        fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
        fs.writeFileSync(workflowPath, workflow, "utf8");
      }
    }
  }

  return changes;
}

function main(): void {
  const argv = process.argv.slice(2);
  const check = argv.includes("--check");
  const onlyIndex = argv.indexOf("--only");
  const only = onlyIndex === -1 ? null : argv[onlyIndex + 1];

  // There is nothing to provision in a standalone clone of tLib, and nothing to
  // assert either: every resource this writes wiring into is a sibling. Checked
  // before the scan rather than after, because the scan is "any directory with a
  // .git and a package.json" — in a clone sitting beside somebody's unrelated
  // repos that would otherwise find them and write tLib's hooks into them.
  if (isStandaloneClone(tlibRoot)) {
    console.log(
      `  🔒 secret-gate provisioning skipped — no sibling resource beside tLib in ${scriptsRoot}. ` +
        "The wiring this writes is per-sibling; tLib's own gate is unaffected."
    );
    return;
  }

  const repos = fs
    .readdirSync(scriptsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => fs.existsSync(path.join(scriptsRoot, name, ".git")))
    .filter((name) => fs.existsSync(path.join(scriptsRoot, name, "package.json")))
    .filter((name) => only == null || name === only)
    .sort();

  if (repos.length === 0) {
    console.error(
      `secret-gate-provision: found no sibling repository with a package.json under ` +
        `${scriptsRoot}${only ? ` matching --only ${only}` : ""}. A provisioner that ` +
        "provisioned nothing is not a success."
    );
    process.exit(2);
  }

  const changes: Change[] = [];
  for (const repo of repos) {
    changes.push(...provision(repo, path.join(scriptsRoot, repo), check));
  }

  if (changes.length === 0) {
    console.log(`  🔒 secret-gate wiring is current in all ${repos.length} resources`);
    return;
  }

  if (check) {
    console.error(
      `✗ the secret-gate wiring has drifted in ${new Set(changes.map((c) => c.repo)).size} ` +
        `resource(s):\n` +
        changes.map((c) => `    ${c.repo}: ${c.what}`).join("\n") +
        "\n\n  Fix:  bun run scripts/secret-gate-provision.ts   (from tLib)"
    );
    process.exit(1);
  }

  console.log(
    `  🔒 secret-gate wiring written in ${new Set(changes.map((c) => c.repo)).size} resource(s):`
  );
  for (const change of changes) console.log(`     • ${change.repo}: ${change.what}`);
  console.log(
    "\n  Next, per resource:  bun run secrets:install-hooks   (sets core.hooksPath; it is\n" +
      "  per-clone config, which is why the CI workflow above is the actual guarantee)"
  );
}

if (import.meta.main) main();

export { PRE_COMMIT, provision, scriptsFor, workflowFor };
