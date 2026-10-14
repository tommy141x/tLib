#!/usr/bin/env bun
/**
 * Two contracts over a resource, both about a file that must never ship.
 *
 * ## 1. `checkStagedTree` — no runtime state in a release
 *
 * A FiveM resource is updated by extracting the new zip OVER the live install.
 * There is no installer, no merge step and no prompt. So one `data.json` in the
 * archive replaces the owner's entire saved configuration in a single step, and
 * `data.json.bak` cannot help, because the replacement parses cleanly and every
 * recovery path in this estate only fires on a file that does NOT parse.
 *
 * This has happened. tRadio shipped one, and `shared/data_defaults.lua` records
 * both halves of the damage: every zone, codeplug, alert, tower, speaker,
 * geo-zone, placed prop and tone mapping replaced, plus
 * `settings.generatedAdminPassword` — the developer's own working admin-panel
 * password — handed to every customer.
 *
 * Five of the seven resources with a data file already exclude it, and three
 * different ways: tELS and tAFK by an INCLUDE allowlist, tCAD by a named
 * forbidden list with a reason per entry, tRadio by `assertNoRuntimeStateStaged`.
 * tRadio's is the one worth generalising and its own docstring says why — the
 * other two are tests of the POLICY, and the zip is built by walking the
 * finished tree, so anything that puts a copy there AFTER staging (a re-added
 * EXTRA_FILES entry, a post-staging step, a hand-copied file) sails past them.
 * This asserts the artifact.
 *
 * Matched by BASENAME at any depth, not just at the staged root. tCAD's
 * `.gitignore` already found the sharp edge: the temp file is
 * `data.json.tmp-<pid>`, so the bare `data.json.tmp` that preceded it matched
 * nothing that is ever created — MEASURED with `git check-ignore -v`. Depth
 * matters for the same reason: `data.json` is written next to whichever file the
 * resource points its writer at, which is not always the root.
 *
 * ## 2. `checkDeclaredModules` — `tlib_modules` is an honest inventory
 *
 * `tlib_modules` in a consumer's fxmanifest only makes a load EAGER; `tlib.<x>`
 * would lazy-load either way. It matters anyway, for a reason every manifest in
 * the estate writes out: tLib's `imports.lua` answers an unknown module name
 * with a truthy export PROXY rather than nil, so an absent module is not caught
 * by any `if tlib.x` guard — the first index throws "attempt to index a function
 * value" halfway down a script and takes the whole file with it.
 *
 * And `imports.lua`'s eager loop is worse than that: `loadModule` returns nil
 * for a name that resolves to no file, with **no error**. A typo in
 * `tlib_modules` is therefore completely silent — it is not a failed load, it is
 * not a load at all.
 *
 * ### What this does NOT check, and why — read before adding it
 *
 * **The undeclared direction.** `tlib.<name>` used without declaring it is NOT a
 * bug: lazy loading is legal and is what most consumers rely on. It is only a
 * bug when the use is at FILE SCOPE, because then the chunk runs before any
 * lazy load could happen. Deciding "is this reference at file scope" needs a Lua
 * parser, and this gate has a regex. A rule that flagged every undeclared use
 * would be wrong about the majority of them, and a gate that is usually wrong is
 * a gate everyone learns to skip — so there is no rule here rather than a noisy
 * one. Stated, not silently omitted.
 *
 * Exit codes for both CLIs: 0 pass, 1 a finding, 2 the gate could not run.
 * Exit 2 is NOT a pass.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { stripLuaComments } from "./manifest-coverage.ts";

export interface RuntimeStateFinding {
  /** Stable rule id, so a control can assert WHICH rule fired. */
  rule: string;
  /** Path relative to the root that was scanned, or the root itself. */
  file: string;
  detail: string;
  /**
   * Reported, but does not fail the gate unless `--strict`.
   *
   * Exactly one rule is soft — `R-MODULE-UNUSED` — and it is soft because it
   * cannot distinguish a stale declaration from a legitimate one. A consumer may
   * declare a module it never names itself, because a tLib module it DOES use
   * needs that one loaded eagerly: tDetector declares `assets` and never calls
   * `tlib.assets`, but `soundstore` calls `tlib.assets.reconcile` at boot.
   * MEASURED across the eight resources here: 1 ghost-free, 4 unused, and at
   * least one of the four is that pattern rather than a mistake.
   *
   * Hard-failing it would make the gate wrong about a quarter of what it says,
   * and a gate that is often wrong is one everybody learns to pass with a skip
   * flag. Everything else here is provable and fails.
   */
  soft?: boolean;
}

/** Findings that fail the gate, which is all of them unless `strict` is off. */
export function failing(findings: RuntimeStateFinding[], strict = false): RuntimeStateFinding[] {
  return findings.filter((f) => strict || !f.soft);
}

// 1. The staged tree

/**
 * Basenames a release may never contain, with the reason travelling with the
 * rule. tCAD does this and it is right: "Staged tree contains data.json" on its
 * own tells whoever hits it nothing about why it matters.
 *
 * Patterns, not literals, because three of the five names carry a suffix that is
 * generated at runtime — a pid, a unix timestamp, a schema version.
 */
export const FORBIDDEN_RUNTIME_STATE: Array<{ rule: string; match: RegExp; why: string }> = [
  {
    rule: "R-DATA-FILE",
    match: /^data\.json$/,
    why:
      "the owner's entire saved configuration. An update is an unzip over the live install, " +
      "so a copy in the archive replaces all of it in one step — and it has shipped a real " +
      "admin password before. Every resource seeds a fresh one on the first boot that finds " +
      "none, so a new install does not need one.",
  },
  {
    rule: "R-DATA-BAK",
    match: /^data\.json\.bak$/,
    why:
      "the rolling last-known-good, and in tCAD the ONLY recovery path for a truncated " +
      "data.json (docs/PLAN.md §12). Shipping one overwrites the owner's with a copy of the " +
      "developer's, which is worse than shipping nothing: the recovery path now restores " +
      "someone else's data and reports success.",
  },
  {
    rule: "R-DATA-MIGRATION-BAK",
    match: /^data\.json\.v[0-9]+\.bak$/,
    why:
      "a one-off pre-migration snapshot written by tlib.jsonstore. It is per-install by " +
      "construction and shipping one puts a stale document where an owner will later look " +
      "for their own.",
  },
  {
    rule: "R-DATA-TMP",
    // The suffix is load-bearing: the real name is `data.json.tmp-<pid>`.
    match: /^data\.json\.tmp(-.*)?$/,
    why:
      "a half-written document. tCAD's writer is tmp + fsync + rename, so a crash between " +
      "openSync and renameSync leaves one behind holding a FULL COPY of the data.",
  },
  {
    rule: "R-TELEMETRY-CONSENT",
    match: /^telemetry-consent\.json$/,
    why:
      "the operator's own answer about diagnostics. Shipping one hands every " +
      "customer somebody else's decision — and in the direction that matters, since the " +
      "default is off and a stored `true` would silently opt an install in. It is written " +
      "beside the resource at runtime; a new install correctly has none.",
  },
  // `R-TELEMETRY-INSTALL-ID` (`/^telemetry-install-id\.txt$/`) WAS HERE AND IS
  // DELETED, not disabled. The per-install id moved inside tLib's own
  // `data.json` (see `shared/ts/install-id.ts`), so `R-DATA-FILE` above already
  // covers it — by BASENAME AT ANY DEPTH, which
  // `runtime-state-contract-control.ts` asserts with a `server/storage/data.json`
  // fixture — and for a strictly stronger reason: that rule exists because the
  // document has shipped a real admin password. There is no location the id can
  // now reach that `R-DATA-FILE` does not match, so a second rule would have
  // been a rule with no fixture that could ever go red.
  {
    rule: "R-DATA-CORRUPT",
    match: /^data\.json\.corrupt\..*$/,
    why:
      "a file tAFK parked aside because it would not parse. It is the owner's evidence for " +
      "a repair, and it is unparseable by definition.",
  },
];

/** Every file under `dir`, recursively, as paths relative to `dir`. */
function walk(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return walk(full, base);
    return entry.isFile() ? [relative(base, full).split("\\").join("/")] : [];
  });
}

export interface StagedTreeResult {
  findings: RuntimeStateFinding[];
  /** Files scanned. An empty list is itself a failure — see the floors. */
  fileCount: number;
  totalBytes: number;
  sawManifest: boolean;
}

export interface StagedTreeOptions {
  /** The finished staged tree, i.e. what the zip is built by walking. */
  dist: string;
  /**
   * Minimum file count. A real staged resource is hundreds of files; 5 is a
   * floor against a collapsed or wrong-directory scan, not a budget.
   */
  minFiles?: number;
  /** Rule ids to skip. Each needs a written reason at the call site. */
  skip?: string[];
}

export function checkStagedTree(options: StagedTreeOptions): StagedTreeResult {
  const { dist, minFiles = 5, skip = [] } = options;
  const findings: RuntimeStateFinding[] = [];

  if (!existsSync(dist)) {
    findings.push({
      rule: "R-NO-DIST",
      file: dist,
      detail: "the staged tree does not exist — stage the release before checking it",
    });
    return { findings, fileCount: 0, totalBytes: 0, sawManifest: false };
  }

  const files = walk(dist);
  let totalBytes = 0;
  let sawManifest = false;

  for (const file of files) {
    const name = basename(file);
    if (name === "fxmanifest.lua") sawManifest = true;
    try {
      totalBytes += statSync(join(dist, file)).size;
    } catch {
      /* raced away between walk and stat; the count below is what matters */
    }
    for (const { rule, match, why } of FORBIDDEN_RUNTIME_STATE) {
      if (skip.includes(rule)) continue;
      if (match.test(name)) findings.push({ rule, file, detail: why });
    }
  }

  // The floors. Without these the gate passes PERFECTLY on an empty
  // directory, and "no data.json in the staged tree" and "no staged tree" are
  // otherwise the same green. This is not hypothetical for this check: it is
  // pointed at a build output directory, and a build that failed early, a
  // cleaned `.build/`, or a path typo all produce exactly that shape.
  if (files.length < minFiles && !skip.includes("R-FILE-FLOOR")) {
    findings.push({
      rule: "R-FILE-FLOOR",
      file: dist,
      detail:
        `the staged tree holds ${files.length} file(s), below the ${minFiles} floor. ` +
        "Every rule above is green on an empty directory, so this floor is what makes " +
        "them mean anything.",
    });
  }

  // A second, independent witness, in the sense of the web-perf playbook §1.5:
  // it can only be produced by the thing under test having actually run. Every
  // staged FiveM resource has an fxmanifest at its root; a tree without one is
  // not a staged resource, however many files it happens to contain.
  if (!sawManifest && !skip.includes("R-MANIFEST-FLOOR")) {
    findings.push({
      rule: "R-MANIFEST-FLOOR",
      file: dist,
      detail:
        "no fxmanifest.lua anywhere in the staged tree. Whatever this directory is, it is " +
        "not a staged FiveM resource — so a clean result says nothing about the release.",
    });
  }

  return { findings, fileCount: files.length, totalBytes, sawManifest };
}

// 2. Declared tLib modules

export interface DeclaredModulesResult {
  findings: RuntimeStateFinding[];
  declared: string[];
  /** Module names that exist in tLib, for the report. Empty is a failure. */
  available: string[];
  /** Informational: declared, present, but server-only. Never fails. */
  serverOnly: string[];
}

export interface DeclaredModulesOptions {
  /** The consumer resource's root (the directory holding fxmanifest.lua). */
  root: string;
  /** tLib's root, which owns `shared/imports/<name>/`. */
  tlib: string;
  skip?: string[];
}

/** Whether a soft finding should fail. See `RuntimeStateFinding.soft`. */
export interface StrictOption {
  strict?: boolean;
}

/** `tlib_module {...}` and `tlib_modules {...}`, both spellings, comments gone. */
export function declaredModules(manifest: string): string[] {
  const source = stripLuaComments(manifest);
  const names: string[] = [];
  // `imports.lua` reads both keys, so both are read here. A block may span many
  // lines and carry long comments, which `stripLuaComments` has already removed.
  for (const block of source.matchAll(/\btlib_modules?\s*(?:\{([\s\S]*?)\}|(['"])(.*?)\2)/g)) {
    const body = block[1] ?? block[3] ?? "";
    for (const entry of body.matchAll(/['"]([A-Za-z0-9_]+)['"]/g)) names.push(entry[1]);
  }
  return [...new Set(names)].sort();
}

/** Module names tLib actually provides, by the same rule `imports.lua` uses. */
export function availableModules(tlib: string): string[] {
  const dir = join(tlib, "shared", "imports");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) =>
      ["server.lua", "client.lua", "shared.lua"].some((f) => existsSync(join(dir, entry.name, f)))
    )
    .map((entry) => entry.name)
    .sort();
}

function luaFiles(root: string): string[] {
  return walk(root).filter(
    (f) =>
      f.endsWith(".lua") &&
      !f.startsWith("node_modules/") &&
      !f.startsWith(".build/") &&
      !f.startsWith("dist/") &&
      // A test or a build script may name a module it does not USE at runtime.
      !f.startsWith("scripts/") &&
      !f.startsWith("tests/")
  );
}

export function checkDeclaredModules(options: DeclaredModulesOptions): DeclaredModulesResult {
  const { root, tlib, skip = [] } = options;
  const findings: RuntimeStateFinding[] = [];
  const manifestPath = join(root, "fxmanifest.lua");

  if (!existsSync(manifestPath)) {
    findings.push({
      rule: "R-NO-MANIFEST",
      file: manifestPath,
      detail: "no fxmanifest.lua — this is not a resource root",
    });
    return { findings, declared: [], available: [], serverOnly: [] };
  }

  const declared = declaredModules(readFileSync(manifestPath, "utf8"));
  const available = availableModules(tlib);

  // A floor, for the same reason as above. `availableModules` returns [] for
  // a tLib path that does not exist, and every `R-MODULE-GHOST` below is then
  // green-by-emptiness — no, worse: every declared name becomes a ghost. Both
  // directions are wrong, so refuse rather than report either.
  if (available.length === 0 && !skip.includes("R-IMPORTS-FLOOR")) {
    findings.push({
      rule: "R-IMPORTS-FLOOR",
      file: join(tlib, "shared", "imports"),
      detail:
        "tLib provides no modules at all, which cannot be true. The tLib path is wrong, so " +
        "neither direction of this check can be trusted.",
    });
    return { findings, declared, available, serverOnly: [] };
  }

  const source = luaFiles(root)
    .map((f) => stripLuaComments(readFileSync(join(root, f), "utf8")))
    .join("\n");

  const serverOnly: string[] = [];

  for (const name of declared) {
    if (!available.includes(name) && !skip.includes("R-MODULE-GHOST")) {
      findings.push({
        rule: "R-MODULE-GHOST",
        file: "fxmanifest.lua",
        detail:
          `tlib_modules declares "${name}", which tLib does not provide. ⛔ This is SILENT ` +
          "today: imports.lua's eager loop calls loadModule, which returns nil for a name " +
          "that resolves to no file and raises nothing. It is not a failed load, it is not " +
          "a load at all — and the first `tlib." +
          name +
          "` is then an export proxy that throws " +
          '"attempt to index a function value" wherever it happens to be used.',
      });
      continue;
    }

    // Declared and present. Is it referenced at all? The manifests state the
    // goal themselves -- "the manifest is an honest inventory of what this
    // resource uses" -- and a stale entry costs an eager load of a module
    // nobody calls, in a chain where load order is already load-bearing.
    const used = new RegExp(
      `\\btlib\\s*[.:]\\s*${name}\\b|tlib\\.has\\s*\\(\\s*['"]${name}['"]`
    ).test(source);
    if (!used && !skip.includes("R-MODULE-UNUSED")) {
      findings.push({
        rule: "R-MODULE-UNUSED",
        file: "fxmanifest.lua",
        soft: true,
        detail:
          `tlib_modules declares "${name}" but no runtime Lua in this resource references ` +
          `tlib.${name}. Either it is left over from a feature that was removed, or the ` +
          "reference moved into a bundled .ts — in which case say so beside the entry, " +
          "because the whole value of this block is being an honest inventory.",
      });
    }

    const dir = join(tlib, "shared", "imports", name);
    if (
      existsSync(join(dir, "server.lua")) &&
      !existsSync(join(dir, "client.lua")) &&
      !existsSync(join(dir, "shared.lua"))
    ) {
      serverOnly.push(name);
    }
  }

  return { findings, declared, available, serverOnly };
}

// Reporting

export function formatFindings(
  label: string,
  findings: RuntimeStateFinding[],
  summary: string
): string {
  const lines = [`${label} — ${summary}`];
  if (findings.length === 0) {
    lines.push("  OK");
    return lines.join("\n");
  }
  const byRule = new Map<string, RuntimeStateFinding[]>();
  for (const f of findings) {
    const list = byRule.get(f.rule) ?? [];
    list.push(f);
    byRule.set(f.rule, list);
  }
  for (const [rule, list] of byRule) {
    lines.push(`\n  ${rule} — ${list.length} finding(s)`);
    lines.push(`    ${list[0].detail}`);
    for (const f of list.slice(0, 8)) lines.push(`      ${f.file}`);
    if (list.length > 8) lines.push(`      ... and ${list.length - 8} more`);
  }
  return lines.join("\n");
}

// CLI
//
//   bun runtime-state-contract.ts --dist <staged tree>
//   bun runtime-state-contract.ts --root <resource> --tlib <tLib root>
//
// Either or both. Runnable by path, so it needs no package.json entry to be
// usable from a prod.ts that imports the functions directly instead.

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const dist = flag("--dist");
  const root = flag("--root");
  const tlib = flag("--tlib");
  const skip = flag("--skip")?.split(",").filter(Boolean) ?? [];
  const strict = argv.includes("--strict");

  if (!dist && !root) {
    console.error(
      "usage: bun runtime-state-contract.ts [--dist <staged tree>] [--root <resource> --tlib <tLib root>] [--skip R-X]"
    );
    process.exit(2);
  }

  let failed = false;

  if (dist) {
    const result = checkStagedTree({ dist, skip });
    console.log(
      formatFindings(
        "check:runtime-state",
        result.findings,
        `${result.fileCount} file(s), ${result.totalBytes} B, fxmanifest ${result.sawManifest ? "present" : "ABSENT"}`
      )
    );
    if (failing(result.findings, true).length > 0) failed = true;
  }

  if (root) {
    if (!tlib) {
      console.error(
        "runtime-state-contract: --root needs --tlib, or neither direction can be judged"
      );
      process.exit(2);
    }
    const result = checkDeclaredModules({ root, tlib, skip });
    console.log(
      formatFindings(
        "check:tlib-modules",
        result.findings,
        `${result.declared.length} declared of ${result.available.length} available` +
          (result.serverOnly.length > 0
            ? `; server-only (informational): ${result.serverOnly.join(", ")}`
            : "")
      )
    );
    if (failing(result.findings, strict).length > 0) failed = true;
    const soft = result.findings.filter((f) => f.soft);
    if (soft.length > 0 && !strict) {
      console.log(
        `
  ${soft.length} soft finding(s) above did NOT fail this run. ` +
          "Pass --strict to make them fail; see RuntimeStateFinding.soft for why they are soft."
      );
    }
  }

  process.exit(failed ? 1 : 0);
}
