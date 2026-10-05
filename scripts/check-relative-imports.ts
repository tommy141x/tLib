// Every relative import/require in the resource's own TypeScript and JavaScript
// resolves to a file that exists: bun run scripts/check-relative-imports.ts
//
// A move changes how deep a file sits, and a relative specifier encodes that
// depth. `../../shared/ts/x` is correct from server/marketplace/ and wrong from
// server/lib/marketplace/ -- same text, one directory further down. Bun only
// reports it when the module is actually loaded, so a path that is only reached
// on one branch survives a green test run and fails in production instead.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
// ui/ and .build/dist/ are emitted; assets/ is source material, not code.
const SKIP = new Set(["node_modules", ".git", "assets", ".build", "dist", "ui"]);
const CODE = /\.(ts|tsx|js|mjs|cjs)$/;
const SPECIFIER = /(?:from\s*|require\(\s*|import\(\s*)["'](\.[^"']*)["']/g;
// `.d.ts` is on the list because a declaration file is a real resolution
// target: `client/web/src/types/solid-js.d.ts` re-exports
// `../../node_modules/solid-js/types/index`, which exists only as `index.d.ts`.
// Without it that reads as a broken path when it is the checker that is short.
const CANDIDATE_SUFFIXES = ["", ".ts", ".tsx", ".d.ts", ".js", ".jsx", ".json", ".css"];

/**
 * Blanks comment bodies, keeping every byte position and newline.
 *
 * Without this the scan reads prose as code. Measured: the sentence
 * ``// `export { a, b as c } from "./x"` — the EXPORTED name …`` in
 * solid-compat-surface-suite.ts was reported as an unresolved specifier, and
 * the only ways out were to reword a comment that is the valuable part or to
 * leave the gate red. A specifier inside a comment imports nothing.
 *
 * A state machine rather than a regex because a naive `//` strip eats the `//`
 * in a URL inside a string literal, silently removing real code after it.
 */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (c === "/" && next === "*") {
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      out += "  ";
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c;
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\\") {
          out += src[i] + (src[i + 1] ?? "");
          i += 2;
          continue;
        }
        out += src[i];
        i++;
      }
      out += src[i] ?? "";
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (CODE.test(entry)) out.push(full);
  }
  return out;
}

function resolves(target: string): boolean {
  for (const suffix of CANDIDATE_SUFFIXES) {
    const candidate = target + suffix;
    if (existsSync(candidate) && statSync(candidate).isFile()) return true;
  }
  for (const index of ["index.ts", "index.tsx", "index.js"]) {
    const candidate = join(target, index);
    if (existsSync(candidate) && statSync(candidate).isFile()) return true;
  }
  return false;
}

const unresolved: string[] = [];
let checked = 0;

for (const file of walk(ROOT)) {
  const source = stripComments(readFileSync(file, "utf8"));
  for (const match of source.matchAll(SPECIFIER)) {
    checked++;
    const specifier = match[1];
    if (resolves(resolve(dirname(file), specifier))) continue;
    const from = relative(ROOT, file).split("\\").join("/");
    unresolved.push(`  ${from}  ->  ${specifier}`);
  }
}

if (checked === 0) {
  // A scan that finds nothing is a broken scan, not a clean tree.
  throw new Error("no relative specifiers found at all; the walk is not reaching the source");
}

console.log(`${checked} relative specifier(s) checked`);
if (unresolved.length > 0) {
  console.log(`\n${unresolved.length} unresolved:`);
  for (const line of unresolved) console.log(line);
  process.exitCode = 1;
} else {
  console.log("all resolve");
}
