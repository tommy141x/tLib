/**
 * Find and blank credential-shaped assignments in a config file.
 *
 * What counts as a finding
 *
 * An assignment whose KEY NAME reads like a credential (see `patterns.ts`) and
 * whose value is a non-empty string literal. Nothing names a secret; a key is
 * one because of what it is called. That is the same rule the runtime redactor
 * uses, derived from the same list, which is the point — tRadio's release
 * packager carried a four-name array (`authToken`, `adminPassword`,
 * `clientSecret`, `botToken`) and that array is precisely the shape that would
 * have missed `Advanced.S3.AccessKey`.
 *
 * What is deliberately NOT a finding
 *
 * - A blank value. There is nothing to disclose and nothing to strip.
 * - A commented-out line. It is not config; and a template's instructions
 *   ("set authToken to a long random string") would otherwise be an offence.
 * - A boolean, number or table value. `authEnabled = false` is not a secret,
 *   and a credential typed without quotes is caught by `Diag.secretKeys` at
 *   runtime, not here, because there is no value to blank into `""`.
 *
 * What it refuses rather than skips
 *
 * A credential-named key assigned a Lua LONG STRING (`key = [[...]]`). The
 * value may span lines, this cannot blank it in place, and skipping it would be
 * a gate reporting clean over a committed credential. It is reported as an
 * `unblankable` finding, which every caller treats as a failure.
 */

import { isSecretName, secretPatterns } from "./patterns.ts";

export type SecretFinding = {
  /** The key name exactly as written. */
  key: string;
  /** Dotted path where one was written (`Advanced.S3.AccessKey`), else `key`. */
  path: string;
  /** 1-based line number. */
  line: number;
  /** 0-based index of the value's opening quote within the line. */
  column: number;
  /** Characters in the value. NEVER the value: a finding gets printed. */
  length: number;
  /** True when the value cannot be blanked in place and must stop the gate. */
  unblankable: boolean;
};

export type ScanResult = {
  findings: SecretFinding[];
  /** Credential-named keys seen with a blank value — proof the scan looked. */
  blankKeys: string[];
};

/** Lua line comment, or a `--[[` block opener used as one. */
function isLuaComment(line: string): boolean {
  return /^\s*--/.test(line);
}

/**
 * One pass over a line, matching either an assignment head, a `{` or a `}`, in
 * source order.
 *
 * MEASURED 2026-10-06. The first version of this anchored on `^[ \t]*key =`
 * — one assignment per line — and so did not see `AccessKey` in
 *
 *     S3 = { AccessKey = "", SecretKey = "" },
 *
 * which is how tDB's config.lua is actually written. That is the same key the
 * hand-written list missed, missed a second time for a different reason, and
 * the end-to-end control is what caught it. A line-anchored scanner is a gate
 * with a blind spot that depends on formatting.
 */
const LUA_TOKEN =
  /(?<key>\[\s*["'][^"']+["']\s*\]|[A-Za-z_][\w.]*)[ \t]*=(?!=)[ \t]*|(?<open>\{)|(?<close>\})/g;

/** The key name a bracketed or dotted token was written as. */
function keyText(token: string): string {
  const bracket = token.match(/^\[\s*["']([^"']+)["']\s*\]$/);
  return bracket?.[1] ?? token;
}

/**
 * Scan Lua config source.
 *
 * Nesting is tracked only to build a readable dotted path for the report — the
 * MATCH is on the leaf key name, because that is the name the runtime redactor
 * sees too and because a nested key is reached by many paths.
 */
export function scanLua(source: string, patterns = secretPatterns()): ScanResult {
  const findings: SecretFinding[] = [];
  const blankKeys: string[] = [];
  const stack: string[] = [];
  let inBlockComment = false;

  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";

    // Long-bracket comment bodies are not config. Tracked crudely — opener and
    // closer on their own lines — which is how every header in this tree is
    // written, and a mistake here can only ADD findings from prose, never hide
    // one, because prose has no `= "value"` with a credential key name.
    if (inBlockComment) {
      if (/]]/.test(raw)) inBlockComment = false;
      continue;
    }
    if (/^\s*--\[\[/.test(raw) && !/]]/.test(raw)) {
      inBlockComment = true;
      continue;
    }
    if (isLuaComment(raw)) continue;

    // A trailing line comment is not config either, and a quoted word inside one
    // would otherwise be read as a value. Cut at the first `--` that is not
    // inside a string literal.
    const line = stripTrailingComment(raw);

    let pendingName: string | null = null;
    LUA_TOKEN.lastIndex = 0;
    for (;;) {
      const token = LUA_TOKEN.exec(line);
      if (token === null) break;
      const groups = token.groups ?? {};

      if (groups.open != null) {
        stack.push(pendingName ?? "");
        pendingName = null;
        continue;
      }
      if (groups.close != null) {
        stack.pop();
        pendingName = null;
        continue;
      }

      const written = groups.key ?? "";
      // A key must start a statement or a table field: line start, or after
      // `{`, `,`, `;` or `(`. Without this, the `b` of `a.b` or a word inside
      // prose can present itself as a key.
      const before = token.index === 0 ? "" : line[token.index - 1];
      if (before !== "" && before != null && !/[\s{,;(]/.test(before)) continue;

      const valueStart = token.index + token[0].length;
      const rest = line.slice(valueStart);
      const leaf = keyText(written).split(".").pop() ?? written;
      const dottedPath = [...stack, keyText(written)].filter(Boolean).join(".");

      const quoted = rest.match(/^(["'])((?:\\.|(?!\1).)*)\1/);
      const longString = /^\[(=*)\[/.test(rest);

      if (rest.startsWith("{")) {
        // A table value. The `{` is the next token; remember the name for it.
        pendingName = keyText(written);
        continue;
      }

      if (isSecretName(leaf, patterns)) {
        if (longString) {
          findings.push({
            key: leaf,
            path: dottedPath,
            line: i + 1,
            column: valueStart,
            length: -1,
            unblankable: true,
          });
        } else if (quoted) {
          const value = quoted[2] ?? "";
          if (value === "") blankKeys.push(dottedPath);
          else
            findings.push({
              key: leaf,
              path: dottedPath,
              line: i + 1,
              column: valueStart,
              length: value.length,
              unblankable: false,
            });
        }
      }

      // Skip past the value so a string containing `x = "y"` is not re-parsed.
      if (quoted) LUA_TOKEN.lastIndex = valueStart + quoted[0].length;
    }
  }

  return { findings, blankKeys };
}

/** Everything before the first `--` that is not inside a string literal. */
export function stripTrailingComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quote) {
      if (char === "\\") i++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "-" && line[i + 1] === "-") return line.slice(0, i);
  }
  return line;
}

const ENV_ASSIGN = /^(?<indent>\s*)(?:export\s+)?(?<key>[A-Za-z_][\w]*)\s*=\s*(?<rest>.*)$/;

/** The same rule for a dotenv file. `#` comments, optional quotes, no nesting. */
export function scanEnv(source: string, patterns = secretPatterns()): ScanResult {
  const findings: SecretFinding[] = [];
  const blankKeys: string[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    if (/^\s*#/.test(raw) || raw.trim() === "") continue;
    const match = raw.match(ENV_ASSIGN);
    if (!match?.groups) continue;
    const key = match.groups.key ?? "";
    if (!isSecretName(key, patterns)) continue;
    const rest = (match.groups.rest ?? "").trim();
    const quoted = rest.match(/^(["'])((?:\\.|(?!\1).)*)\1\s*$/);
    const value = quoted ? (quoted[2] ?? "") : rest.replace(/\s+#.*$/, "");
    if (value === "") blankKeys.push(key);
    else {
      const column = raw.indexOf(rest, raw.indexOf("=") + 1);
      findings.push({
        key,
        path: key,
        line: i + 1,
        column: quoted ? column : -1,
        length: value.length,
        // An UNQUOTED dotenv value has no delimiters to blank between, so it is
        // refused rather than rewritten. `.env` files are never packaged into a
        // release anyway (only `.env.example` is tracked at all); this path
        // exists so the refusal is explicit instead of a confusing throw.
        unblankable: !quoted,
      });
    }
  }
  return { findings, blankKeys };
}

/** Which scanner a path gets. `null` means "not a file this gate reads". */
export function scannerFor(filePath: string): ((source: string) => ScanResult) | null {
  const base = filePath.split("/").pop() ?? filePath;
  if (base.endsWith(".lua")) return (source) => scanLua(source);
  if (base === ".env" || base.startsWith(".env.")) return (source) => scanEnv(source);
  return null;
}

export type BlankResult = {
  source: string;
  /** `key (was N chars)` per value actually blanked. Never the value. */
  cleared: string[];
  /** Findings this could not blank. A caller must treat these as fatal. */
  refused: SecretFinding[];
};

/**
 * Blank every credential value in place, preserving indentation, quote style
 * and alignment so a shipped template stays readable.
 *
 * Verifies its own write by re-scanning the result: a regex that matched but
 * replaced nothing would otherwise report success over a shipped secret. That
 * self-check is tRadio's, kept because it is the one assertion that catches a
 * blanker which has stopped blanking.
 */
export function blankSecrets(
  source: string,
  filePath: string,
  patterns = secretPatterns()
): BlankResult {
  const plain = scannerFor(filePath);
  if (!plain) {
    throw new Error(
      `blankSecrets: no scanner for ${filePath}. Only .lua and .env* files are read; ` +
        "a caller handing this anything else is pointing at the wrong file."
    );
  }
  // Threaded through rather than letting the scanner re-read the pattern list, so
  // a caller that narrowed it (the broken-gate drill does) narrows BOTH halves.
  // A blanker still using the full list while the scan used a narrow one would
  // make the drill prove nothing.
  const scanner = (text: string) =>
    filePath.endsWith(".lua") ? scanLua(text, patterns) : scanEnv(text, patterns);

  const before = scanner(source);
  const refused = before.findings.filter((f) => f.unblankable);
  const cleared: string[] = [];

  const lines = source.split("\n");
  // Right-to-left within each line, so an earlier blank cannot shift the column
  // of a later one. Two credentials on one line is not hypothetical:
  // `S3 = { AccessKey = "", SecretKey = "" }` is how tDB writes it.
  const targets = before.findings
    .filter((f) => !f.unblankable)
    .sort((a, b) => b.line - a.line || b.column - a.column);

  for (const finding of targets) {
    const index = finding.line - 1;
    const text = lines[index] ?? "";
    const quote = text[finding.column];
    if (quote !== '"' && quote !== "'") {
      throw new Error(
        `blankSecrets: ${filePath}:${finding.line}:${finding.column} was reported as a ` +
          `credential value (${finding.key}) but does not start with a quote. Refusing to ` +
          "report a clean file."
      );
    }
    const closing = text.indexOf(quote, finding.column + 1 + finding.length);
    if (closing === -1) {
      throw new Error(
        `blankSecrets: ${filePath}:${finding.line}: could not find the closing quote of ` +
          `${finding.key}. Refusing.`
      );
    }
    lines[index] = text.slice(0, finding.column) + quote + quote + text.slice(closing + 1);
    cleared.push(`${finding.path} (was ${finding.length} chars)`);
  }

  const out = lines.join("\n");
  const after = scanner(out);
  const stillSet = after.findings.filter((f) => !f.unblankable);
  if (stillSet.length > 0) {
    throw new Error(
      `blankSecrets: ${filePath} still carries ${stillSet.length} set credential(s) after ` +
        `blanking (${stillSet.map((f) => `${f.path}:${f.line}`).join(", ")}). Refusing.`
    );
  }

  cleared.sort();
  return { source: out, cleared, refused };
}
