#!/usr/bin/env bun
/**
 * Negative control for the secret gate — end to end, in a real git repository.
 *
 * ## Why this exists in this shape
 *
 * The precedents in this tree are specific and they are all the same mistake in
 * different clothes:
 *
 *   • a control that passed by accident, because the thing it planted would
 *     have been caught by something other than the rule under test;
 *   • a control with a stale expected COUNT, which refused its own run;
 *   • a control that asserted what a stub had been told to record.
 *
 * So this one: (1) uses a real `git init` repo, a real `.githooks/pre-commit`, a
 * real `git commit` and a real `git show HEAD:`, with no stubs anywhere;
 * (2) asserts coverage as a SET OF KEY NAMES, never as a count; and (3) runs a
 * BROKEN-GATE DRILL — the same planted credential with the pattern list
 * narrowed so it cannot match — and requires the gate to go GREEN. Without that
 * last part, a red verdict is not evidence the rule caused it.
 *
 * ## What it proves, in both directions
 *
 *   PLANTED      a credential-shaped key with a value is caught:
 *                  — the pre-commit hook refuses the commit (exit 1, names the key)
 *                  — the working tree still holds the value afterwards
 *                  — the staged gate and the HEAD gate both fail
 *   CLEAN        the same repo with the value in a gitignored sidecar passes,
 *                and a non-credential key with a value passes
 *   DRILL        with the pattern list narrowed so the key cannot match, the
 *                PLANTED case passes — so the red above is caused by the rule
 *
 * ⛔ Every value planted here is obviously synthetic. Nothing in this file is a
 * credential for anything.
 *
 * Usage:  bun run scripts/secret-gate-control.ts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { coverage } from "../shared/ts/secrets/gate.ts";
import { hookIsCurrent, PRE_COMMIT } from "../shared/ts/secrets/hook.ts";
import { isSecretName, secretPatterns } from "../shared/ts/secrets/patterns.ts";
import { scanLua } from "../shared/ts/secrets/scan.ts";

const tlibRoot = path.resolve(import.meta.dir, "..");
const gateScript = path.join(tlibRoot, "scripts", "secret-gate.ts");

const failures: string[] = [];
function check(ok: boolean, what: string): void {
  if (ok) console.log(`  ✓ ${what}`);
  else {
    failures.push(what);
    console.log(`  ✗ ${what}`);
  }
}

type Run = { code: number; out: string };
function run(cwd: string, cmd: string[], env?: Record<string, string>): Run {
  const result = Bun.spawnSync(cmd, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...(env ?? {}) },
  });
  const decode = new TextDecoder();
  return {
    code: result.exitCode ?? 1,
    out: `${decode.decode(result.stdout)}${decode.decode(result.stderr)}`,
  };
}

// ── The fixture ─────────────────────────────────────────────────────────────
//
// Synthetic, and shaped like the real thing: aligned assignments, a nested
// block, and `dispatchNacId` present because it is the key that must NOT be
// treated as a credential — it ships as the public demo's code on purpose.

const BLANK_CONFIG = `Config = {
    authToken          = "",
    adminPassword      = "",
    dispatchNacId      = "141",
    discord            = {
        clientId     = "1234567890",
        clientSecret = "",
    },
    Advanced           = {
        S3 = { AccessKey = "", SecretKey = "" },
    },
}
`;

/** The planted value. Obviously synthetic, and long enough to be realistic. */
const PLANTED = "SYNTHETIC-NOT-A-REAL-CREDENTIAL-0000";

/**
 * A fixture repo in a parent directory that also holds a `tLib` junction to the
 * real tLib, so the hook's `../tLib/scripts/secret-gate.ts` branch — the one
 * every consumer resource actually takes — is what gets exercised.
 *
 * ⚠️ MEASURED: an earlier version dropped a one-line `scripts/secret-gate.ts`
 * re-export into the fixture instead. That took the hook's "we are tLib" branch,
 * `bun run` loaded the gate as an imported module, `import.meta.main` was false,
 * `main()` never ran and the hook exited 0 — a hook that looked installed and
 * checked nothing. Four assertions in this control caught it. A symlink of type
 * `junction` needs no administrator on Windows.
 */
function makeRepo(label: string): string {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), `tlib-secretgate-${label}-`));
  cleanup.push(parent);
  const dir = path.join(parent, "fixture");
  fs.mkdirSync(dir);
  fs.symlinkSync(tlibRoot, path.join(parent, "tLib"), "junction");
  run(dir, ["git", "init", "-q", "-b", "main"]);
  run(dir, ["git", "config", "user.email", "control@example.invalid"]);
  run(dir, ["git", "config", "user.name", "Secret Gate Control"]);
  run(dir, ["git", "config", "commit.gpgsign", "false"]);

  fs.mkdirSync(path.join(dir, "config"), { recursive: true });
  fs.writeFileSync(path.join(dir, "config", "config.lua"), BLANK_CONFIG, "utf8");
  fs.writeFileSync(
    path.join(dir, "package.json"),
    `${JSON.stringify({ name: "control-fixture", private: true }, null, 2)}\n`,
    "utf8"
  );
  fs.writeFileSync(path.join(dir, ".gitignore"), "config.local.lua\n", "utf8");

  // The real hook bytes, verbatim from tLib's hook.ts. The fixture's parent
  // holds a `tLib` junction, so the hook takes its `../tLib/...` branch — the
  // one every consumer resource actually takes.
  fs.mkdirSync(path.join(dir, ".githooks"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".githooks", "pre-commit"), PRE_COMMIT, "utf8");
  fs.chmodSync(path.join(dir, ".githooks", "pre-commit"), 0o755);
  run(dir, ["git", "config", "core.hooksPath", ".githooks"]);

  run(dir, ["git", "add", "-A"]);
  const first = run(dir, ["git", "commit", "-q", "-m", "fixture: blank config"]);
  if (first.code !== 0) {
    console.error(`control: could not create the fixture repo:\n${first.out}`);
    process.exit(2);
  }
  return dir;
}

const cleanup: string[] = [];

/**
 * ⛔ The junction is UNLINKED FIRST, explicitly, and tLib is re-checked
 * afterwards.
 *
 * A recursive delete over a directory containing a junction to tLib is one
 * typo away from deleting tLib. `fs.rmSync` unlinks a junction rather than
 * descending into it, but "should" is not the standard for a line that could
 * delete the library, so the link is removed by name before anything recursive
 * runs and the result is verified.
 */
function dispose(): void {
  for (const dir of cleanup) {
    const link = path.join(dir, "tLib");
    try {
      if (fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link);
    } catch {
      // Not every temp dir has one (the drill copy does not).
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (!fs.existsSync(path.join(tlibRoot, "shared", "imports", "diag", "shared.lua"))) {
    console.error("CONTROL ABORTED: cleanup appears to have followed the tLib junction.");
    process.exit(3);
  }
}

// ── 0. The gate can see itself ─────────────────────────────────────────────

console.log("\n0. preconditions");
check(hookIsCurrent(tlibRoot), "tLib's own .githooks/pre-commit is the canonical bytes");
check(secretPatterns().length >= 18, "the pattern list parsed from Lua is non-trivial");

// ── 1. CLEAN: the baseline must be green, or nothing below means anything ──

console.log("\n1. CLEAN — a blank tracked config, value in the gitignored sidecar");
{
  const repo = makeRepo("clean");

  // The developer's real value, in the sidecar. This is the whole design: it is
  // set locally, the server reads it, and git has never heard of the file.
  fs.writeFileSync(
    path.join(repo, "config.local.lua"),
    `return { authToken = '${PLANTED}', discord = { clientSecret = '${PLANTED}' } }\n`,
    "utf8"
  );

  const head = run(repo, ["bun", "run", gateScript]);
  check(head.code === 0, "the HEAD gate passes");
  check(
    head.out.includes("credential-shaped key(s), all blank"),
    "it reports the blank keys it saw, so a zero-file run is distinguishable"
  );

  // A commit that touches the config but adds no value must go through.
  fs.appendFileSync(path.join(repo, "config", "config.lua"), "-- a comment\n", "utf8");
  const commit = (() => {
    run(repo, ["git", "add", "config/config.lua"]);
    return run(repo, ["git", "commit", "-q", "-m", "a harmless config edit"]);
  })();
  check(commit.code === 0, "the pre-commit hook allows a config commit with no credential");
  check(
    !run(repo, ["git", "status", "--porcelain"]).out.includes("config.local.lua"),
    "the sidecar is gitignored — git never offers to commit it"
  );
  check(
    fs.readFileSync(path.join(repo, "config.local.lua"), "utf8").includes(PLANTED),
    "and the developer's value is still there, untouched, after a commit"
  );

  // A non-credential key with a value is not the gate's business.
  const nac = scanLua(BLANK_CONFIG).findings.some((f) => f.key === "dispatchNacId");
  check(!nac, "dispatchNacId holds '141' and is NOT flagged — the name rule does not match it");
  check(!isSecretName("dispatchNacId"), "…and it needs no exemption to be safe");
}

// ── 2. PLANTED: a credential typed into the tracked file ──────────────────

console.log("\n2. PLANTED — a credential-shaped key given a value in the tracked config");
let plantedRepo = "";
{
  const repo = makeRepo("planted");
  plantedRepo = repo;

  const configPath = path.join(repo, "config", "config.lua");
  fs.writeFileSync(
    configPath,
    BLANK_CONFIG.replace('authToken          = ""', `authToken          = "${PLANTED}"`).replace(
      'AccessKey = ""',
      `AccessKey = "${PLANTED}"`
    ),
    "utf8"
  );

  // The two keys planted, asserted as a SET of names. `AccessKey` is here
  // deliberately: it is the one credential name the hand-written lists missed,
  // and a count-based assertion would have been satisfied without it.
  const found = coverage([
    { file: "config/config.lua", content: fs.readFileSync(configPath, "utf8") },
  ]);
  const expected = new Set([
    "authToken",
    "adminPassword",
    "clientSecret",
    "AccessKey",
    "SecretKey",
  ]);
  check(
    [...expected].every((k) => found.has(k)) && expected.size === found.size,
    `coverage is exactly ${[...expected].sort().join(", ")} (a set, not a count)`
  );

  run(repo, ["git", "add", "config/config.lua"]);

  const staged = run(repo, ["bun", "run", gateScript, "--staged"]);
  check(staged.code === 1, "the staged gate exits 1");
  check(staged.out.includes("authToken"), "…and names authToken");
  check(staged.out.includes("AccessKey"), "…and names AccessKey, the measured miss");
  check(!staged.out.includes(PLANTED), "…and never prints the value itself");
  check(staged.out.includes("config.local.lua"), "…and tells the developer where it should live");

  const refused = run(repo, ["git", "commit", "-q", "-m", "this must not land"]);
  check(refused.code !== 0, "the pre-commit HOOK refuses the commit");
  check(refused.out.includes("authToken"), "…with the key name in the refusal");

  const log = run(repo, ["git", "log", "--oneline"]);
  check(
    log.out.trim().split("\n").length === 1,
    "…and no commit was created (still only the fixture commit)"
  );
  check(
    fs.readFileSync(configPath, "utf8").includes(PLANTED),
    "the WORKING TREE still holds the value — a refusal destroys nothing"
  );

  // --no-verify is the documented bypass; CI is the layer that still catches it.
  const bypassed = run(repo, ["git", "commit", "-q", "--no-verify", "-m", "bypassed"]);
  check(bypassed.code === 0, "--no-verify bypasses the hook (as documented)");
  const head = run(repo, ["bun", "run", gateScript]);
  check(head.code === 1, "…and the HEAD gate — the CI backstop — fails anyway");
  check(head.out.includes("at HEAD") && head.out.includes("authToken"), "…naming HEAD and the key");
}

// ── 2b. A config file that is not at HEAD yet is read from the INDEX ──────
//
// MEASURED 2026-10-06 on tDB, which has `config.example.lua` staged as an add
// and `config.lua` staged as a delete — so neither exists at HEAD. The first
// version of the gate refused with exit 2 there, permanently, which is a gate
// that gets deleted from `verify`. It now falls back to the staged blob, and
// that fallback must not be a hole: the credential has to still be caught.

console.log("\n2b. STAGED-ADD — a brand-new config file, never yet committed");
{
  const repo = makeRepo("stagedadd");

  fs.writeFileSync(
    path.join(repo, "config.example.lua"),
    `return {\n    Superuser = { Password = "${PLANTED}" },\n}\n`,
    "utf8"
  );
  run(repo, ["git", "add", "config.example.lua"]);

  const head = run(repo, ["bun", "run", gateScript]);
  check(head.code === 1, "the HEAD gate catches a credential in a file with no HEAD blob");
  check(head.out.includes("Password"), "…naming the key");
  check(
    head.out.includes("read from the INDEX"),
    "…and saying which source it read, so the fallback is visible rather than silent"
  );
  check(!head.out.includes(PLANTED), "…and still never printing the value");

  // Blank it and the same staged-add file passes — the fallback reads the blob,
  // it does not merely tolerate the file's absence.
  fs.writeFileSync(
    path.join(repo, "config.example.lua"),
    'return {\n    Superuser = { Password = "" },\n}\n',
    "utf8"
  );
  run(repo, ["git", "add", "config.example.lua"]);
  const blanked = run(repo, ["bun", "run", gateScript]);
  check(blanked.code === 0, "and the same staged-add file passes once the value is blank");
}

// ── 3. The DRILL: break the rule and the planted case must pass ───────────
//
// A red verdict above is only evidence if the rule is what produced it. The gate
// derives its patterns from the Lua file, so the drill narrows that file in a
// COPY of tLib and re-runs the same planted repo against it. If the planted
// credential is still caught with `token` and `accesskey` removed, something
// other than the pattern list is doing the catching and the control above
// proves nothing.

console.log("\n3. DRILL — pattern list narrowed; the planted case must go GREEN");
{
  const drillRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tlib-secretgate-drill-"));
  cleanup.push(drillRoot);

  for (const relative of [
    "scripts/secret-gate.ts",
    "shared/ts/secrets/patterns.ts",
    "shared/ts/secrets/scan.ts",
    "shared/ts/secrets/gate.ts",
    "shared/ts/secrets/hook.ts",
    "shared/imports/diag/shared.lua",
  ]) {
    const target = path.join(drillRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(tlibRoot, relative), target);
  }

  const luaPath = path.join(drillRoot, "shared/imports/diag/shared.lua");
  const lua = fs.readFileSync(luaPath, "utf8");
  // Narrow the list to patterns that cannot match any key in the fixture. The
  // substitution is asserted to have changed the file: a gsub that matched
  // nothing would hand the drill the real list and it would then assert that a
  // working gate works.
  const narrowed = lua.replace(
    /Diag\.SECRET_PATTERNS = \{[^}]*\}/,
    "Diag.SECRET_PATTERNS = {\n    'nothinghere',\n}"
  );
  if (narrowed === lua) {
    console.error("control: the drill's substitution matched nothing — it would prove nothing.");
    dispose();
    process.exit(2);
  }
  fs.writeFileSync(luaPath, narrowed, "utf8");

  const drillGate = path.join(drillRoot, "scripts", "secret-gate.ts");
  const drilled = run(plantedRepo, ["bun", "run", drillGate, "--repo", plantedRepo]);
  check(
    drilled.code === 0,
    "with the pattern list narrowed, the SAME planted credential passes — so the " +
      "red verdict in step 2 was caused by the pattern list and by nothing else"
  );
  check(
    !drilled.out.includes("authToken"),
    "…and the narrowed gate does not name the key it can no longer see"
  );
}

// ── Verdict ────────────────────────────────────────────────────────────────

dispose();
console.log("");
if (failures.length > 0) {
  console.error(`CONTROL FAILED: ${failures.length} assertion(s):`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(
  "CONTROL OK: the gate refuses a planted credential at commit and at HEAD, keeps the " +
    "working tree intact, passes a blank config with a sidecar, and goes green when its " +
    "own pattern list is broken."
);
