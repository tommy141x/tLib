/**
 * `--name value` off `process.argv`, for the one-file tools in `scripts/`.
 *
 * Eleven of those tools had their own `arg()`, in four variants, and the
 * variants were a safety ladder rather than four tastes:
 *
 *   throws on a bad value            4 copies  (tAFK, tELS ×2, tLib)
 *   silently returns the default     2 copies
 *   returns `""`                     2 copies
 *   no guard at all                  3 copies
 *
 * Only the first is right, so that is the one this is. The others all turn
 * `--out` typed without a value — or typed last, or followed immediately by
 * another flag — into a *plausible* value:
 *
 *   silent default  `--out` alone writes to the default directory, which is
 *                   usually not the one the operator was redirecting away from.
 *   `""`            flows into `path.resolve("")`, which is the CURRENT WORKING
 *                   DIRECTORY. A gallery tool then empties and rewrites it.
 *   no guard        `--out --force` yields the string `"--force"` as a path,
 *                   and `--out` last yields `undefined` out of a function
 *                   declared `: string` — a type lie the compiler cannot see.
 *
 * None of those report anything. Throwing is the only behaviour that tells the
 * operator the command they typed is not the command that ran, which for a tool
 * whose whole job is to write files somewhere is the difference that matters.
 *
 * ── Scope ──
 *
 * Deliberately not an argument parser: no short flags, no `=` form, no
 * `--no-x`, no repeats. Every caller wants "a named value or a default", and a
 * parser that accepts more shapes than the callers document is a surface nobody
 * tested. `--flag` on its own as a boolean is `process.argv.includes("--flag")`
 * at the call site, which needs no helper.
 */

/** Read `--name value`, or `undefined` when `--name` is absent. */
export function cliArg(name: string): string | undefined;
/** Read `--name value`, or `fallback` when `--name` is absent. */
export function cliArg(name: string, fallback: string): string;
export function cliArg(name: string, fallback?: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  if (at < 0) return fallback;
  const value = process.argv[at + 1];
  // `--name` present means the operator meant to set it. An absent or
  // flag-shaped value is a typo, never an instruction to use the default.
  if (!value || value.startsWith("--")) throw new Error(`--${name} needs a value`);
  return value;
}
