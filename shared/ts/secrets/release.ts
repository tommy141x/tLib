/**
 * Layer 2: blank every credential in a STAGED RELEASE TREE.
 *
 * Asserted on the artifact rather than on an include list, which is the point:
 * anything that puts a copy there after staging — a post-staging step, a
 * hand-copied file, a sibling script writing into the stage — is blanked too
 * instead of shipping. tCAD states the same rationale at
 * `assertNothingForbiddenStaged`.
 *
 * What changed, and why
 *
 * tRadio had the only implementation of this and it carried
 *
 *     const SECRET_KEYS = ["authToken", "adminPassword", "clientSecret", "botToken"];
 *
 * and threw on a key it could not find, so a rename broke the build. That was
 * the best a hand-written list could do, and it is still the wrong shape: the
 * list is correct on the day it is written. It is exactly the shape that would
 * have missed `Advanced.S3.AccessKey`, which is a live credential in tDB's
 * config and the one name `SECRET_PATTERNS` itself also missed until
 * 2026-10-06.
 *
 * This derives the key set from `Diag.SECRET_PATTERNS` — the same list the
 * runtime redactor, the pre-commit hook and the CI assertion all derive from —
 * so a credential added to any config next year is blanked with no edit here
 * and no edit in any resource.
 *
 * Three things it refuses rather than skips
 *
 * 1. A stage with no config file in it. Every resource here ships at least one;
 *    zero means staging stopped including it, and a sanitizer that sanitized
 *    nothing prints a tick either way.
 * 2. `config.local.lua` present in the stage. That file is the developer's real
 *    credentials. It is gitignored, so it should never be staged — but a glob
 *    that widened would carry it, and it would carry the one thing this whole
 *    mechanism exists to keep out of a release.
 * 3. A credential assigned a Lua long string, which cannot be blanked in place.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { isConfigPath } from "./gate.ts";
import { blankSecrets } from "./scan.ts";

export type SanitizeResult = {
  /** `path (was N chars)` per value blanked. Never a value. */
  cleared: string[];
  /** Stage-relative config files read. */
  files: string[];
};

/** Every file under `dir`, as POSIX paths relative to it. */
function walk(dir: string, rel = ""): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const next = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), next));
    else out.push(next);
  }
  return out;
}

/**
 * @param stageRoot the staged release tree
 * @param opts.expectConfig set false only for a resource that ships no config
 *        file — and say why at the call site.
 */
export function sanitizeStagedSecrets(
  stageRoot: string,
  opts: { expectConfig?: boolean } = {}
): SanitizeResult {
  const expectConfig = opts.expectConfig ?? true;

  if (!fs.existsSync(stageRoot)) {
    throw new Error(
      `sanitizeStagedSecrets: ${stageRoot} does not exist. A sanitizer pointed at a ` +
        "directory that is not there reports a clean release."
    );
  }

  const all = walk(stageRoot);

  const sidecars = all.filter((file) => path.posix.basename(file) === "config.local.lua");
  if (sidecars.length > 0) {
    throw new Error(
      `sanitizeStagedSecrets: the staged tree contains ${sidecars.join(", ")}. That file ` +
        "holds the developer's REAL credentials and is gitignored precisely so it cannot " +
        "ship. Refusing to package."
    );
  }

  const files = all.filter((file) => isConfigPath(file));
  if (files.length === 0 && expectConfig) {
    throw new Error(
      `sanitizeStagedSecrets: no config file in the staged tree at ${stageRoot}.\n` +
        "  Every resource here ships one, and it is loaded from fxmanifest.lua — if staging\n" +
        "  stopped including it, that is the bug, not this check. Pass\n" +
        "  `{ expectConfig: false }` only for a resource that genuinely ships none."
    );
  }

  const cleared: string[] = [];
  const refusals: string[] = [];

  for (const file of files.sort()) {
    const full = path.join(stageRoot, file);
    const source = fs.readFileSync(full, "utf8");
    const result = blankSecrets(source, file);
    for (const entry of result.cleared) cleared.push(`${file}: ${entry}`);
    for (const refused of result.refused) {
      refusals.push(`${file}:${refused.line} ${refused.path} — a long-string value`);
    }
    if (result.source !== source) fs.writeFileSync(full, result.source, "utf8");
  }

  if (refusals.length > 0) {
    throw new Error(
      "sanitizeStagedSecrets: cannot blank these in place, so refusing to package:\n" +
        refusals.map((r) => `  ✗ ${r}`).join("\n") +
        "\n  Rewrite the value as a quoted literal."
    );
  }

  return { cleared, files };
}

/** The release-log line. Prints what was blanked, by name, never the value. */
export function describeSanitize(result: SanitizeResult): string {
  if (result.cleared.length === 0) {
    return `  🔒 ${result.files.length} staged config file(s) checked; no credential was set`;
  }
  return [
    `  🔒 ${result.cleared.length} credential(s) blanked in ${result.files.length} staged ` +
      "config file(s):",
    ...result.cleared.map((entry) => `     • ${entry}`),
  ].join("\n");
}
