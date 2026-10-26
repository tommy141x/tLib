/**
 * The credential-name pattern list, parsed from the Lua that already owns it
 * (`shared/imports/diag/shared.lua`'s `Diag.SECRET_PATTERNS`), rather than
 * declared a second time here — a pattern added to one list and not the other
 * fails silently either way (a gate that passes it through, or a runtime that
 * prints a value it should redact). A shared `.json` was rejected: Lua in a
 * FiveM resource can't read JSON without a decoder in scope at load time, and
 * the redactor must work before anything else initialises.
 *
 * The parser is strict on purpose: every failure mode of a loose parser here
 * is "returns a shorter list than Lua has", which reads as a clean gate. It
 * throws instead; `scripts/secret-gate.test.ts` asserts the parsed set equals
 * what a real Lua VM reports from the same file.
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
 * Parse the pattern list out of Lua source text. Throws on anything it
 * doesn't fully understand — missing/empty table, non-lowercase entry, any
 * unquoted token inside the braces — since a list that silently came back
 * short is the one outcome this must not have.
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
