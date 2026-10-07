/**
 * The repository-facing half of the secret gate: which tracked files are config,
 * what they look like at HEAD or in the index, and whether that is acceptable.
 *
 * ── The three layers, and why there are three ──────────────────────────────
 *
 * 1. `pre-commit` (this module, `source: "staged"`). Convenience. Catches the
 *    value before it is a commit, with a message naming the key and the fix.
 *    It lives in a TRACKED `.githooks/` and is installed by `core.hooksPath`,
 *    because `.git/hooks` is not tracked and cannot ship. A developer who never
 *    runs `setup` has no hook at all — which is why this is not the guarantee.
 *
 * 2. The release packager (`shared/ts/secrets/scan.ts#blankSecrets`). Blanks the
 *    STAGED COPY of a release, so a dev value can never reach a customer even if
 *    it reached a commit. This layer already existed in tRadio and was the only
 *    one that did; it is why the committed `adminPassword = "141"` shipped to
 *    nobody but is still in the history.
 *
 * 3. This module, `source: "head"`, run by CI. The backstop, and the only layer
 *    that cannot be skipped: it does not care what is configured on the
 *    developer's clone, only what the commit actually contains.
 *
 * Layer 1 was missing and layer 3 only inspected the zip. That is the whole
 * reason `adminPassword` was committed twice.
 *
 * ── Which files are read ───────────────────────────────────────────────────
 *
 * A RULE, not a list. A tracked file is config when its basename contains
 * `config`, or it sits under a `config/` directory, or it is a dotenv file.
 * `secretGate.extraFiles` adds paths the rule misses. A hand-maintained list of
 * files is the same failure as a hand-maintained list of keys: it is correct on
 * the day it is written.
 *
 * The count of files read is always printed, and a gate that found zero config
 * files in a repo that has some is an error — a gate that checks nothing reads
 * exactly like a gate that passed.
 */

import * as path from "node:path";
import { isSecretName, secretPatterns } from "./patterns.ts";
import { type SecretFinding, scannerFor } from "./scan.ts";

export type GatePolicy = {
  /** Glob-ish path prefixes/suffixes to skip, each with the reason it is skipped. */
  ignore: Record<string, string>;
  /** Key names allowed to be non-blank, each with the reason. */
  allow: Record<string, string>;
  /** Paths the config rule does not catch but which must be read anyway. */
  extraFiles: string[];
  /**
   * Why this repo has no config file at all. Set it and "zero files" becomes a
   * pass instead of a refusal.
   *
   * ⚠️ This exists because the alternative is worse. tAFK genuinely tracks no
   * config file, so without an opt-out the gate fails forever there and gets
   * removed from `verify` — at which point the repo has no gate. With the
   * opt-out the "zero files" state has to be ASSERTED by a human with a reason,
   * and the day tAFK gains a `config.lua` the rule matches it and the opt-out
   * becomes a lie that nobody notices... which is why `noConfig` is checked
   * AGAINST the file list: a repo that declares it and then has config files is
   * an error, not a pass.
   */
  noConfig?: string;
};

/**
 * Defaults every resource inherits. Only `node_modules` is here: a dependency's
 * own config is not ours to police and the tree is large enough to matter.
 *
 * Test fixtures are deliberately NOT ignored by default. A credential-shaped
 * value in a fixture is either a real secret (the thing being prevented) or a
 * synthetic one that should have been written blank or obviously fake — and
 * "obviously fake" is not a judgement a script can make, so the fixture gets an
 * explicit `allow` entry with a reason instead of a blanket exemption.
 */
export const DEFAULT_POLICY: GatePolicy = {
  ignore: {
    "node_modules/": "a dependency's own config is not this repo's to police",
  },
  allow: {},
  extraFiles: [],
};

export function readPolicy(packageJson: unknown): GatePolicy {
  const raw = (packageJson as { secretGate?: unknown } | null)?.secretGate;
  if (raw == null) return DEFAULT_POLICY;
  if (typeof raw !== "object") {
    throw new Error("secretGate in package.json must be an object");
  }
  const config = raw as Partial<GatePolicy>;

  for (const field of ["ignore", "allow"] as const) {
    const entries = config[field];
    if (entries == null) continue;
    if (typeof entries !== "object" || Array.isArray(entries)) {
      throw new Error(
        `secretGate.${field} must be an object mapping each entry to the REASON it is ` +
          "there. An array would let an exemption in with no justification, which is how " +
          "an exemption outlives the thing it was for."
      );
    }
    for (const [key, reason] of Object.entries(entries)) {
      if (typeof reason !== "string" || reason.trim().length < 12) {
        throw new Error(
          `secretGate.${field}["${key}"] needs a real reason string (12+ chars), not ` +
            `${JSON.stringify(reason)}.`
        );
      }
    }
  }

  if (
    config.noConfig != null &&
    (typeof config.noConfig !== "string" || config.noConfig.trim().length < 12)
  ) {
    throw new Error(
      "secretGate.noConfig must be the REASON this repo tracks no config file (12+ chars), " +
        `not ${JSON.stringify(config.noConfig)}.`
    );
  }

  return {
    ignore: { ...DEFAULT_POLICY.ignore, ...(config.ignore ?? {}) },
    allow: { ...DEFAULT_POLICY.allow, ...(config.allow ?? {}) },
    extraFiles: config.extraFiles ?? [],
    noConfig: config.noConfig,
  };
}

/** The config rule. Exported so the tests can assert it against a real repo. */
export function isConfigPath(repoRelative: string): boolean {
  const posix = repoRelative.replace(/\\/g, "/");
  const base = path.posix.basename(posix);
  if (base === ".env" || base.startsWith(".env.")) return true;
  if (!base.endsWith(".lua")) return false;
  if (base.toLowerCase().includes("config")) return true;
  return posix.split("/").slice(0, -1).includes("config");
}

export function isIgnored(repoRelative: string, policy: GatePolicy): string | null {
  const posix = repoRelative.replace(/\\/g, "/");
  for (const [entry, reason] of Object.entries(policy.ignore)) {
    if (
      entry.endsWith("/") ? posix.startsWith(entry) || posix.includes(`/${entry}`) : posix === entry
    ) {
      return reason;
    }
  }
  return null;
}

export type FileReport = {
  file: string;
  findings: SecretFinding[];
  blankKeys: string[];
};

export type GateReport = {
  /** Where the bytes came from, for the message. */
  source: "head" | "staged" | "worktree";
  filesRead: string[];
  /** Findings that are not allowed. Non-empty means the gate fails. */
  offences: Array<FileReport & { findings: SecretFinding[] }>;
  /** Allowed findings, reported so an exemption stays visible. */
  allowed: Array<{ file: string; finding: SecretFinding; reason: string }>;
  /** Every credential-shaped key seen blank. The proof the scan looked. */
  blankKeys: Array<{ file: string; key: string }>;
};

/**
 * Apply the policy to already-read file contents.
 *
 * Split from any git call so the tests can drive the whole decision with
 * synthetic inputs and so the same function serves HEAD, the index and the
 * working tree.
 */
export function judge(
  source: GateReport["source"],
  files: Array<{ file: string; content: string }>,
  policy: GatePolicy
): GateReport {
  const report: GateReport = {
    source,
    filesRead: files.map((f) => f.file),
    offences: [],
    allowed: [],
    blankKeys: [],
  };

  for (const { file, content } of files) {
    const scanner = scannerFor(file);
    if (!scanner) continue;
    const { findings, blankKeys } = scanner(content);
    for (const key of blankKeys) report.blankKeys.push({ file, key });

    const unallowed: SecretFinding[] = [];
    for (const finding of findings) {
      const reason = policy.allow[finding.key] ?? policy.allow[finding.path];
      // An unblankable long-string value is never allowable: the exemption
      // mechanism cannot reason about a value it cannot even delimit.
      if (reason && !finding.unblankable) report.allowed.push({ file, finding, reason });
      else unallowed.push(finding);
    }
    if (unallowed.length > 0) report.offences.push({ file, findings: unallowed, blankKeys });
  }

  return report;
}

/**
 * The human-readable verdict. Never prints a value — only the key, the line and
 * the length, because this text lands in CI logs and in a developer's terminal.
 */
export function formatReport(report: GateReport, hint: string): string {
  const lines: string[] = [];
  const where =
    report.source === "head"
      ? "at HEAD"
      : report.source === "staged"
        ? "in the staged changes"
        : "in the working tree";

  if (report.offences.length === 0) {
    lines.push(
      `  🔒 ${report.filesRead.length} tracked config file(s) read ${where}; ` +
        `${report.blankKeys.length} credential-shaped key(s), all blank.`
    );
    for (const { file, finding, reason } of report.allowed) {
      lines.push(`     • allowed non-blank: ${file}:${finding.line} ${finding.path} — ${reason}`);
    }
    return lines.join("\n");
  }

  const total = report.offences.reduce((n, o) => n + o.findings.length, 0);
  lines.push(
    `✗ ${total} credential-shaped key(s) hold a value ${where}, in ` +
      `${report.offences.length} file(s):`
  );
  for (const offence of report.offences) {
    for (const finding of offence.findings) {
      lines.push(
        finding.unblankable
          ? `    ${offence.file}:${finding.line}  ${finding.path} = [[…]] — a long-string ` +
              "value cannot be blanked in place; rewrite it as a quoted literal"
          : `    ${offence.file}:${finding.line}  ${finding.path} — ${finding.length} chars`
      );
    }
  }
  lines.push("");
  lines.push(hint);
  return lines.join("\n");
}

/** Every credential-shaped key name present in a set of files, blank or not. */
export function coverage(files: Array<{ file: string; content: string }>): Set<string> {
  const patterns = secretPatterns();
  const names = new Set<string>();
  for (const { file, content } of files) {
    const scanner = scannerFor(file);
    if (!scanner) continue;
    const { findings, blankKeys } = scanner(content);
    for (const f of findings) names.add(f.key);
    for (const key of blankKeys) {
      const leaf = key.split(".").pop() ?? key;
      if (isSecretName(leaf, patterns)) names.add(leaf);
    }
  }
  return names;
}
