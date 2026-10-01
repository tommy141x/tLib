/**
 * Mutation-proof for the spawn gate.
 *
 * A green test suite proves nothing about a *refusal* unless the refusal can be
 * removed and watched to fail. Each entry below disables exactly one check in
 * `server/lib/spawn/gate.ts`, runs the suite, and records which tests broke. A
 * mutation that breaks nothing is a test that was passing for another reason.
 *
 *   bun run scripts/mutate-spawn-gate.ts
 *
 * The original file is restored in a `finally`, so an interrupted run does not
 * leave a hole in the gate on disk.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const GATE = join(ROOT, "server", "lib", "spawn", "gate.ts");
const SUITE = "server/lib/spawn/gate.test.ts";

interface Mutation {
  name: string;
  /** The check being removed, so the report says what was proven. */
  proves: string;
  from: string;
  to: string;
}

const MUTATIONS: Mutation[] = [
  {
    name: "caller-allowlist",
    proves: "an unlisted resource is refused",
    from: "  const caller = findCaller(resource);\n  if (!caller) {",
    to: "  const caller = findCaller(resource);\n  if (false) {",
  },
  {
    name: "program-allowlist",
    proves: "a caller may only run the programs declared for it",
    from: "  const program = findProgram(caller, request.program);\n  if (!program) {",
    to: "  const program = findProgram(caller, request.program) ?? caller.programs[0];\n  if (!program) {",
  },
  {
    name: "containment",
    proves: "a binary resolving outside the caller's directory is refused",
    from: "    if (target !== realRoot && !target.startsWith(realRoot + probes.sep)) return \"\";",
    to: "    if (false) return \"\";",
  },
  {
    name: "case-folding-is-not-containment",
    proves: "the containment prefix test compares paths exactly, not case-insensitively",
    from: '    if (target !== realRoot && !target.startsWith(realRoot + probes.sep)) return "";',
    to: [
      "    const folded = target.toLowerCase();",
      "    const foldedRoot = realRoot.toLowerCase();",
      '    if (folded !== foldedRoot && !folded.startsWith(foldedRoot + probes.sep)) return "";',
    ].join(String.fromCharCode(10)),
  },
  {
    name: "cwd-empty-is-the-root",
    proves: 'cwd "" means the resource root, not "not supplied"',
    from: "  if (request.cwd !== undefined && request.cwd !== null) {",
    to: '  if (request.cwd !== undefined && request.cwd !== null && request.cwd !== "") {',
  },
  {
    name: "cwd-allowlist",
    proves: "a `..` cwd is refused",
    from: "    if (!program.cwd.includes(wanted)) {",
    to: "    if (false) {",
  },
  {
    name: "argument-shape",
    proves: "an undeclared flag, a repeat, or a second command is refused",
    from: "    if (!progressed) return null;",
    to: "    if (!progressed) { argv.push(tokens[i] as string); loggable.push(tokens[i] as string); i++; }",
  },
  {
    name: "loopback",
    proves: "a public bind address is refused",
    from: '    case "loopback":\n      return LOOPBACK_HOSTS.has(value);',
    to: '    case "loopback":\n      return true;',
  },
  {
    name: "loopback-address",
    proves: "a public `--http=` is refused",
    from: "      if (!LOOPBACK_HOSTS.has(host)) return false;",
    to: "      if (false) return false;",
  },
  {
    name: "control-characters",
    proves: "a NUL inside a value is refused",
    from: "  if (hasControlCharacters(value)) return false;",
    to: "  if (false) return false;",
  },
  {
    name: "port-range",
    proves: "a port outside 1..65535 is refused",
    from: "      return port >= 1 && port <= 65535;",
    to: "      return true;",
  },
  {
    name: "env-allowlist",
    proves: "LD_PRELOAD and friends are refused",
    from: "      if (!program.env.includes(name)) {",
    to: "      if (false) {",
  },
  {
    name: "sha256-pin",
    proves: "a program that declares a pin is checked against it",
    from: "    if (!program.sha256.includes(digest)) {",
    to: "    if (false) {",
  },
  {
    name: "prepend-presence",
    proves: "an interpreter without its catalog-supplied script is refused",
    from: "    if (!resolved || !probes.isFile(resolved)) {",
    to: "    if (false) {",
  },
  {
    name: "prepend-position",
    proves: "tLib's script goes in FRONT of the caller's arguments",
    from: "  let argv = [...prefix, ...matched.argv];",
    to: "  let argv = [...matched.argv, ...prefix];",
  },
  {
    name: "author-is-not-a-gate",
    proves: "a mismatched author warns and does NOT refuse — the inverse assertion",
    from: "  if (declared.includes(caller.author)) return undefined;",
    to: "  if (!declared.includes(caller.author)) return undefined;",
  },
];

function failures(): string[] {
  const run = spawnSync("bun", ["test", SUITE], { cwd: ROOT, encoding: "utf8", shell: true });
  const text = `${run.stdout}${run.stderr}`;
  return [...text.matchAll(/^\(fail\) (.+?) \[/gm)].map((m) => m[1] as string);
}

const original = readFileSync(GATE, "utf8");
let bad = 0;

try {
  const baseline = failures();
  if (baseline.length > 0) {
    console.log(`baseline is not green (${baseline.length} failing); fix that first`);
    process.exit(1);
  }
  console.log(`baseline: green\n`);

  for (const mutation of MUTATIONS) {
    if (!original.includes(mutation.from)) {
      console.log(`✗ ${mutation.name}: anchor no longer present in gate.ts`);
      bad++;
      continue;
    }
    writeFileSync(GATE, original.replace(mutation.from, mutation.to));
    const broken = failures();
    if (broken.length === 0) {
      console.log(`✗ ${mutation.name}: removing this check broke NOTHING — ${mutation.proves}`);
      bad++;
    } else {
      console.log(`✓ ${mutation.name}: ${broken.length} test(s) failed — ${mutation.proves}`);
      for (const name of broken) console.log(`    ${name}`);
    }
  }
} finally {
  writeFileSync(GATE, original);
}

console.log(bad === 0 ? "\nevery gate is load-bearing" : `\n${bad} mutation(s) proved nothing`);
process.exit(bad === 0 ? 0 : 1);
