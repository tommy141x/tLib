/**
 * `cliArg`'s contract, and the three variants it replaced run against the same
 * checks to show what each of them did instead.
 *
 * The negative controls here are not hypothetical broken drafts — they are the
 * exact bodies that were in tRadio's `scripts/panel-gallery/`, `radio-frames/`
 * and `watermark/` tools. Keeping them in the suite is what makes "the strict
 * one is the right one" a measurement rather than an assertion, and it means a
 * future "simplification" back toward any of them fails here.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cliArg } from "../../shared/ts/build/argv.ts";

const REAL_ARGV = process.argv;
afterEach(() => {
  process.argv = REAL_ARGV;
});

function withArgv<T>(tail: string[], run: () => T): T {
  process.argv = ["bun", "script.ts", ...tail];
  try {
    return run();
  } finally {
    process.argv = REAL_ARGV;
  }
}

type Reader = (name: string, fallback?: string) => string | undefined;

/** Each check throws on violation, so it can be run against a control too. */
const CHECKS: Record<string, (arg: Reader) => void> = {
  "reads a value that is present"(arg) {
    const got = withArgv(["--out", "D:/pics"], () => arg("out", "default"));
    if (got !== "D:/pics") throw new Error(`got ${JSON.stringify(got)}`);
  },

  "falls back when the flag is absent"(arg) {
    const got = withArgv(["--other", "x"], () => arg("out", "default"));
    if (got !== "default") throw new Error(`got ${JSON.stringify(got)}`);
  },

  "returns undefined for an absent flag with no fallback"(arg) {
    const got = withArgv([], () => arg("out"));
    if (got !== undefined) throw new Error(`got ${JSON.stringify(got)}`);
  },

  /** The whole point: `--out` typed last must not resolve to anything. */
  "refuses a flag with no value at all"(arg) {
    let threw = false;
    withArgv(["--out"], () => {
      try {
        arg("out", "default");
      } catch {
        threw = true;
      }
    });
    if (!threw) throw new Error("a valueless --out was accepted");
  },

  /** `--out --force` must not take `--force` as the value, nor silently default. */
  "refuses a flag whose value is another flag"(arg) {
    let threw = false;
    withArgv(["--out", "--force"], () => {
      try {
        arg("out", "default");
      } catch {
        threw = true;
      }
    });
    if (!threw) throw new Error("--out --force was accepted");
  },

  /** An empty value is a typo too, and `path.resolve("")` is the cwd. */
  "refuses an empty value"(arg) {
    let threw = false;
    withArgv(["--out", ""], () => {
      try {
        arg("out", "default");
      } catch {
        threw = true;
      }
    });
    if (!threw) throw new Error('--out "" was accepted');
  },

  /** A value that merely starts with a dash is not a flag. */
  "accepts a negative number as a value"(arg) {
    const got = withArgv(["--offset", "-3"], () => arg("offset", "0"));
    if (got !== "-3") throw new Error(`got ${JSON.stringify(got)}`);
  },
};

const CHECK_NAMES = Object.keys(CHECKS);

describe("cliArg", () => {
  for (const name of CHECK_NAMES) {
    test(name, () => {
      CHECKS[name](cliArg as Reader);
    });
  }
});

// ── Negative controls: the three variants this replaced ──────────────────────

/** tRadio `panel-gallery/gallery.ts`, `assets/audit/probe.ts`. */
const silentDefault: Reader = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : fallback;
};

/** tRadio `panel-gallery/run.ts`, `radio-frames/from-gallery.ts`. */
const emptyString: Reader = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1]?.startsWith("--") ? "" : process.argv[i + 1]) : fallback;
};

/** tRadio `watermark/{embed,extract,survival}.ts`. */
const unguarded: Reader = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

const CONTROLS: { name: string; reader: Reader; breaks: string[] }[] = [
  {
    name: "silent default",
    reader: silentDefault,
    breaks: ["refuses a flag with no value at all", "refuses a flag whose value is another flag", "refuses an empty value"],
  },
  {
    name: 'returns ""',
    reader: emptyString,
    breaks: ["refuses a flag with no value at all", "refuses a flag whose value is another flag", "refuses an empty value"],
  },
  {
    name: "no guard at all",
    reader: unguarded,
    breaks: ["refuses a flag with no value at all", "refuses a flag whose value is another flag", "refuses an empty value"],
  },
];

describe("negative controls", () => {
  for (const control of CONTROLS) {
    test(`${control.name}: names only real checks`, () => {
      for (const name of control.breaks) expect(CHECK_NAMES).toContain(name);
      expect(control.breaks.length).toBeGreaterThan(0);
    });

    for (const name of CHECK_NAMES) {
      const mustFail = control.breaks.includes(name);
      test(`${control.name}: ${mustFail ? "FAILS" : "still passes"} "${name}"`, () => {
        let error: unknown;
        try {
          CHECKS[name](control.reader);
        } catch (caught) {
          error = caught;
        }
        if (mustFail) expect(error).toBeInstanceOf(Error);
        else expect(error).toBeUndefined();
      });
    }
  }
});
