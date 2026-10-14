/**
 * Moved from `tRadio/shared/ui/src/error-report.test.ts` with the module it
 * covers. Every assertion is the one that was there, plus the three at the end
 * for the redaction that was ADDED in the move (home-directory paths and
 * registered identifying values) — see `shared/ts/telemetry/scrub.ts`.
 *
 * `error-report.ts` exists because both `ErrorBoundary` fallbacks threw away
 * the only parts of an exception a bug report needs — BUG-68735 is blocked on
 * precisely that. So these tests assert the two halves of its contract:
 *
 *   1. nothing diagnosable is lost (name, stack, `.cause`, non-Error throws)
 *   2. nothing credential-shaped survives into the string
 *
 * (2) is the one that matters for a customer-facing panel, and it is the half
 * that would rot silently: a redactor that stops matching still produces a
 * perfectly readable report.
 */

import { describe, expect, test } from "bun:test";
import { describeError, formatErrorReport } from "../../shared/ts/telemetry/error-report";
import {
  REDACTED,
  redactSecrets,
  registerScrubValue,
  resetScrubValues,
} from "../../shared/ts/telemetry/scrub";

describe("describeError — nothing diagnosable is lost", () => {
  test("an Error keeps its name, message and stack", () => {
    const err = new TypeError("Cannot read properties of null (reading 'replaceChild')");
    const r = describeError(err);

    expect(r.name).toBe("TypeError");
    expect(r.message).toContain("replaceChild");
    // The whole point: `String(err)` would have dropped this.
    expect(r.stack).toBeTruthy();
    expect(r.stack).toContain("telemetry-error-report.test");
  });

  test("the cause chain is surfaced, outermost first", () => {
    const root = new RangeError("offset out of bounds");
    const mid = new Error("decode failed", { cause: root });
    const top = new Error("could not apply settings", { cause: mid });

    const r = describeError(top);
    expect(r.message).toBe("could not apply settings");
    expect(r.causes).toEqual(["Error: decode failed", "RangeError: offset out of bounds"]);
  });

  test("a cause cycle terminates instead of hanging the fallback", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as { cause?: unknown }).cause = b;

    const r = describeError(b);
    // Capped, not infinite — a hung fallback is a white panel.
    expect(r.causes.length).toBeLessThanOrEqual(4);
  });

  test("a thrown plain object does not become [object Object]", () => {
    const r = describeError({ code: 418, detail: "teapot" });
    expect(r.message).not.toContain("[object Object]");
    expect(r.message).toContain("teapot");
    expect(r.message).toContain("418");
  });

  test("a thrown string, null and undefined are each distinguishable", () => {
    expect(describeError("boom").message).toBe("boom");
    expect(describeError(null).name).toBe("ThrownNull");
    expect(describeError(undefined).name).toBe("ThrownUndefined");
  });

  test("an Error with no stack says so rather than rendering empty", () => {
    const err = new Error("no stack here");
    err.stack = "";
    const r = describeError(err);
    expect(r.stack).toBeUndefined();
    expect(formatErrorReport(r, { surface: "admin" })).toContain("no stack");
  });
});

describe("redactSecrets — nothing credential-shaped survives", () => {
  const leaks: Array<[string, string]> = [
    ["query token", "GET /admin/api/config?token=s3cr3tvalue failed"],
    ["query api_key", "fetch https://x.invalid/a?api_key=abcdef123456&page=2"],
    ["fragment secret", "nav to /admin#secret=hunter2"],
    ["assigned password", 'bad body: {"password":"hunter2","user":"tommy"}'],
    ["assigned session", "session = 9f8e7d6c5b4a"],
    ["bearer header", "Authorization: Bearer abc.def.ghi rejected"],
    ["bare jwt", "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig7 expired"],
  ];

  for (const [label, text] of leaks) {
    test(`${label} is blanked`, () => {
      const out = redactSecrets(text);
      expect(out).toContain(REDACTED);
      for (const needle of [
        "s3cr3tvalue",
        "abcdef123456",
        "hunter2",
        "9f8e7d6c5b4a",
        "abc.def.ghi",
        "eyJhbGciOiJIUzI1NiJ9",
      ]) {
        expect(out).not.toContain(needle);
      }
    });
  }

  test("the diagnostically useful half survives redaction", () => {
    // A redactor that eats the path, the line numbers or the chunk hash
    // produces an unreadable report, which is worth the same as no report.
    const out = redactSecrets(
      "TypeError at /admin/api/settings?token=abc (assets/index-9f2a1b.js:412:17)"
    );
    expect(out).toContain("/admin/api/settings");
    expect(out).toContain("assets/index-9f2a1b.js:412:17");
    expect(out).toContain("TypeError");
    expect(out).not.toContain("abc");
  });

  test("words that merely contain a secret key are not mangled", () => {
    const out = redactSecrets("keyboard shortcut passthrough on tokenizer line 4");
    expect(out).toBe("keyboard shortcut passthrough on tokenizer line 4");
  });

  test("a secret in the message and in the stack are both redacted", () => {
    const err = new Error("POST /admin/api/auth?token=leaked11111 -> 500");
    err.stack = "Error: POST /admin/api/auth?token=leaked11111\n    at f (a.js:1:1)";
    const r = describeError(err);
    const text = formatErrorReport(r, { surface: "admin", location: "settings" });

    expect(text).not.toContain("leaked11111");
    expect(text).toContain("/admin/api/auth");
    expect(text).toContain("a.js:1:1");
  });
});

describe("formatErrorReport — it is a paste, not a table", () => {
  // The two version lines are labelled `serverVersion`/`panelVersion`, not a bare
  // `version`, and the distinction is the point: a paste carrying both a resource
  // version and a NUI bundle version is ambiguous if either is called `version`,
  // and the whole value of this block is that someone can read it in Discord
  // without asking a follow-up question. Asserting the exact prefix is therefore
  // the contract, not an implementation detail — `toContain("version: 7.0.1")`
  // would pass against either label and so would prove nothing.
  test("it names the surface, the location and BOTH versions distinguishably", () => {
    const text = formatErrorReport(describeError(new Error("x")), {
      surface: "admin",
      location: "marketplace",
      version: "7.0.1",
      panelVersion: "0.17.0",
    });
    expect(text).toContain("surface: admin");
    expect(text).toContain("location: marketplace");
    expect(text).toContain("serverVersion: 7.0.1");
    expect(text).toContain("panelVersion: 0.17.0");
  });

  test("a missing location is explicit rather than blank", () => {
    expect(formatErrorReport(describeError(new Error("x")), { surface: "nui" })).toContain(
      "location: (unknown)"
    );
  });
});

/**
 * What the move ADDED. These three are not ports — they are the behaviour change
 * `error-report.ts`'s header calls out, and they are here rather than in
 * `telemetry-scrub.test.ts` because the question is specifically whether
 * `describeError` reaches the new rules at all. It would be entirely possible for
 * `scrub()` to be correct and `describeError` to still be calling the old
 * `redactSecrets`, and every assertion above would pass.
 */
describe("describeError — the redaction added in the move", () => {
  test("a Windows home directory in a stack loses the account name and keeps the path", () => {
    const err = new Error("could not read config");
    err.stack =
      "Error: could not read config\n" +
      "    at load (C:\\Users\\SomePlayer\\FiveM\\FiveM.app\\resources\\tRadio\\server\\sv_main.lua:12:3)";
    const r = describeError(err);
    expect(r.stack).not.toContain("SomePlayer");
    // The diagnostically useful half — which file and which line — survives.
    expect(r.stack).toContain("resources");
    expect(r.stack).toContain("sv_main.lua:12:3");
  });

  test("a Linux home directory is collapsed too, because servers run in containers", () => {
    const r = describeError(new Error("ENOENT /home/fivem/txData/resources/tRadio/data.json"));
    expect(r.message).not.toContain("fivem");
    expect(r.message).toContain("txData/resources/tRadio/data.json");
  });

  test("a registered identifying value never survives into the message", () => {
    resetScrubValues();
    registerScrubValue("Tommy_Johnston");
    const r = describeError(new Error("channel join refused for Tommy_Johnston"));
    expect(r.message).not.toContain("Tommy_Johnston");
    expect(r.message).toContain(REDACTED);
    resetScrubValues();
  });
});
