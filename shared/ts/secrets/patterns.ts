/**
 * The credential-name pattern list, read from the Lua that already owns it.
 *
 * ── Why this parses Lua instead of declaring an array ───────────────────────
 *
 * `shared/imports/diag/shared.lua` has owned `Diag.SECRET_PATTERNS` since the
 * diagnostics module was unified, and its own header states the governing rule:
 * "a redactor that has to be updated to keep working is a redactor that
 * silently stops working." A second list here would be exactly that — two
 * places to update, one of which nobody remembers, and the failure is silent in
 * both directions (a pattern added to Lua and not to TS lets the commit gate
 * through; a pattern added to TS and not to Lua lets the runtime report print
 * the value).
 *
 * The alternative considered and rejected was moving the list into a `.json`
 * both sides read. Lua in a FiveM resource cannot read JSON without a decoder
 * in scope at load time, and the redactor has to work before anything else has
 * initialised. Parsing one table literal from one file is the cheaper half.
 *
 * ⛔ The parser is strict on purpose. Every failure mode of a loose parser here
 * is "returns a SHORTER list than Lua has", which reads as a clean gate. It
 * throws instead, and `scripts/secret-gate.test.ts` asserts the parsed set
 * equals the set a real Lua VM reports from the same file.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Where the Lua that owns the list lives, relative to this file. */
export const PATTERNS_LUA_PATH = path.join(
  import.meta.dir,
  "..",
  "..",
  "imports",
  "diag",
  "shared.lua"
);

const TABLE = /Diag\.SECRET_PATTERNS\s*=\s*\{([^}]*)\}/;

/**
 * Parse the pattern list out of Lua source text.
 *
 * Throws on anything it does not fully understand: a missing table, an empty
 * table, a non-lowercase entry, or any token inside the braces that is not a
 * quoted string or a comma. A pattern list that silently came back short is the
 * one outcome this must not have.
 */
export function parseSecretPatterns(luaSource: string): string[] {
  const table = luaSource.match(TABLE);
  if (!table) {
    throw new Error(
      "parseSecretPatterns: no `Diag.SECRET_PATTERNS = { ... }` table literal found. " +
        "The list moved or changed shape; this parser must be updated with it, because " +
        "every secret gate in every resource derives its key set from here."
    );
  }

  const body = table[1];
  const patterns: string[] = [];
  // Strip Lua line comments first: the literal carries an explanatory comment
  // and a quoted word inside prose would otherwise land in the list.
  for (const rawLine of body.split("\n")) {
    const line = rawLine.replace(/--.*$/, "");
    const residue = line.replace(/'[^']*'|"[^"]*"/g, (match) => {
      patterns.push(match.slice(1, -1));
      return "";
    });
    const leftover = residue.replace(/[\s,]/g, "");
    if (leftover !== "") {
      throw new Error(
        `parseSecretPatterns: unparsed token ${JSON.stringify(leftover)} inside the ` +
          "SECRET_PATTERNS literal. Keep it a flat list of quoted lowercase strings — " +
          "a parser that skipped this would return a short list, and a short list is a " +
          "gate that passes."
      );
    }
  }

  if (patterns.length === 0) {
    throw new Error(
      "parseSecretPatterns: the SECRET_PATTERNS literal parsed to zero patterns. " +
        "An empty list matches no key name, so every gate downstream would report clean."
    );
  }
  for (const pattern of patterns) {
    if (pattern !== pattern.toLowerCase() || pattern.trim() !== pattern || pattern === "") {
      throw new Error(
        `parseSecretPatterns: ${JSON.stringify(pattern)} is not a trimmed lowercase ` +
          "string. `Diag.isSecretName` lowercases the key name and does a plain substring " +
          "find, so an entry with an uppercase letter can never match anything."
      );
    }
  }
  return patterns;
}

let cached: string[] | null = null;

/** The live pattern list. Read once per process from the Lua source. */
export function secretPatterns(): string[] {
  if (cached) return cached;
  cached = parseSecretPatterns(fs.readFileSync(PATTERNS_LUA_PATH, "utf8"));
  return cached;
}

/**
 * `Diag.isSecretName`, in TypeScript. Same rule, same direction: lowercase the
 * key name, plain substring find against every pattern.
 */
export function isSecretName(name: string, patterns = secretPatterns()): boolean {
  const lower = String(name).toLowerCase();
  return patterns.some((pattern) => lower.includes(pattern));
}
