/**
 * Scrubbing. The half of this feature that cannot be undone.
 *
 * WHY THIS SUITE IS THE IMPORTANT ONE. The destination store is Cloudflare
 * Analytics Engine, which has no DELETE and no UPDATE — the only eraser is a
 * three-month expiry. A value that reaches it is there until it expires. So a
 * scrubber that silently stops matching does not produce a visible failure; it
 * produces a readable report with a credential in it, for three months.
 *
 * AND IT PINS BOTH DIRECTIONS. A redactor that blanks everything passes every
 * "the secret is gone" assertion and is useless, because the report it produces
 * has no diagnostic content left. Half the tests below assert what SURVIVES.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  HOME,
  REDACTED,
  redactSecrets,
  registerScrubValue,
  resetScrubValues,
  scrub,
  scrubIdentifiers,
  scrubIdentifying,
  scrubPaths,
  scrubValues,
} from "../../shared/ts/telemetry/scrub";

afterEach(() => {
  resetScrubValues();
});

describe("scrubPaths — the account name goes, the path stays", () => {
  const cases: Array<[string, string, string]> = [
    [
      "windows backslashes",
      "C:\\Users\\SomePlayer\\FiveM\\FiveM.app\\resources\\tRadio\\sv.lua",
      "SomePlayer",
    ],
    // Measured, not assumed: a Windows FXServer logs `C:/Users/...` as often
    // as `C:\Users\...` — Node normalises one way and Lua's string.format the
    // other, and both forms appear in this estate's own logs. A rule that only
    // matched backslashes would miss half of them.
    ["windows forward slashes", "C:/Users/SomePlayer/FiveM/cache/x.js", "SomePlayer"],
    ["linux home", "/home/fivem/txData/resources/tRadio/data.json", "fivem"],
    ["macos home", "/Users/dev/code/tRadio/index.ts", "dev"],
  ];

  for (const [label, input, leaked] of cases) {
    test(`${label}: the account name is gone`, () => {
      const out = scrubPaths(input);
      expect(out).not.toContain(leaked);
      expect(out).toContain(HOME);
    });
  }

  test("everything after the home segment survives, because that is the diagnosis", () => {
    const out = scrubPaths(
      "at load (C:\\Users\\SomePlayer\\FiveM\\FiveM.app\\resources\\tRadio\\server\\sv_main.lua:12:3)"
    );
    expect(out).toContain("resources");
    expect(out).toContain("sv_main.lua:12:3");
  });

  test("a NUI stack frame is untouched — it carries no path at all", () => {
    const frame = "at render (https://cfx-nui-tRadio/assets/index-9f2a1b.js:412:17)";
    expect(scrubPaths(frame)).toBe(frame);
  });

  test("a relative path is not a home directory and is left alone", () => {
    expect(scrubPaths("shared/ts/telemetry/scrub.ts")).toBe("shared/ts/telemetry/scrub.ts");
  });
});

describe("scrubIdentifying — what the host told us is the player's", () => {
  test("a registered name never survives, in any casing", () => {
    registerScrubValue("Tommy_Johnston");
    expect(scrubIdentifying("join refused for tommy_johnston")).toBe(
      `join refused for ${REDACTED}`
    );
  });

  test("a value under the length floor is REFUSED rather than registered", () => {
    // The floor is load-bearing. A player called `Al` would otherwise turn
    // every `Already` in a stack into `[redacted]ready`, and an unreadable
    // report is worth the same as no report.
    expect(registerScrubValue("Al")).toBe(false);
    expect(scrubIdentifying("Already connected")).toBe("Already connected");
  });

  test("a regex metacharacter in a name is matched literally, not as a pattern", () => {
    registerScrubValue("a.b(c)");
    expect(scrubIdentifying("user a.b(c) left")).toContain(REDACTED);
    // `a.b(c)` as a PATTERN would match `axbc`; as a literal it must not.
    expect(scrubIdentifying("axbc")).toBe("axbc");
  });

  test("longest first, so a substring cannot leave a fragment behind", () => {
    registerScrubValue("Tommy");
    registerScrubValue("TommyJohnston");
    expect(scrubValues()[0]).toBe("TommyJohnston");
    const out = scrubIdentifying("TommyJohnston said hi");
    // With shortest-first the `Tommy` rule would fire and leave `Johnston`.
    expect(out).not.toContain("Johnston");
  });

  test("double registration does not grow the list without bound", () => {
    for (let i = 0; i < 50; i += 1) registerScrubValue("SomePlayer");
    expect(scrubValues()).toHaveLength(1);
  });

  test("a non-string is refused", () => {
    expect(registerScrubValue(undefined)).toBe(false);
    expect(registerScrubValue(12345)).toBe(false);
  });
});

/**
 * THE HOLE tWeb MEASURED IN ITS OWN CHARSET
 *
 * `[A-Za-z0-9._:-]` admits every FiveM player identifier VERBATIM, because `:`
 * is in it for namespaced ids and a FiveM identifier is exactly that shape. The
 * ingest now refuses those shapes, which flips the symptom on this side from
 * "an identifier is in a store that cannot delete a row" to "telemetry we
 * thought we were collecting silently vanishes". Both are fixed here.
 */
describe("scrubIdentifiers", () => {
  const cases: Array<[string, string]> = [
    ["steam", "steam:110000100000000"],
    ["license", "license:4d1f8a9c0b7e6d5c4b3a2918f7e6d5c4b3a29180"],
    ["license2", "license2:4d1f8a9c0b7e6d5c4b3a2918f7e6d5c4b3a29180"],
    ["discord", "discord:1345874347281088565"],
    ["fivem", "fivem:1234567"],
    ["ip", "ip:192.168.8.141"],
    ["bare steam id", "110000100000000"],
    ["bare snowflake", "1345874347281088565"],
    ["bare ipv4", "192.168.8.141"],
  ];

  for (const [label, raw] of cases) {
    test(`${label} is blanked`, () => {
      const out = scrubIdentifiers(`refused for ${raw} at boot`);
      expect(out).not.toContain(raw);
      expect(out).toContain(REDACTED);
      // The surrounding words are the diagnostic half and must survive.
      expect(out).toContain("refused for");
      expect(out).toContain("at boot");
    });
  }

  test("⚠️ a 13-digit timestamp is NOT an identifier", () => {
    // The bare-id rule needs a 15-digit floor for exactly this: a rule that
    // ate epoch milliseconds would redact every duration in every message.
    expect(scrubIdentifiers("took 1760000000000 ms")).toContain("1760000000000");
  });

  test("a short number is not an identifier either", () => {
    expect(scrubIdentifiers("42 channels, 7 zones")).toBe("42 channels, 7 zones");
  });

  test("a real Windows home path loses the account name", () => {
    const path = `C:${String.fromCharCode(92)}Users${String.fromCharCode(92)}Tommy${String.fromCharCode(92)}Documents`;
    expect(scrubIdentifiers(path)).not.toContain("Tommy");
  });

  test("and so does the residue of naive separator mapping", () => {
    expect(scrubIdentifiers("C:Users.Tommy.Documents")).not.toContain("Tommy");
  });

  test("a non-string is ''", () => {
    expect(scrubIdentifiers("")).toBe("");
  });
});

describe("redactSecrets — the list is deliberately narrow", () => {
  test("the real PocketBase-shaped case: a password in a config dump", () => {
    // Not hypothetical. A real PocketBase password was found sitting in a config
    // in this estate, and an error string can carry one.
    const out = redactSecrets('config load failed: {"adminPassword":"hunter2hunter2","host":"x"}');
    expect(out).not.toContain("hunter2hunter2");
    expect(out).toContain("host");
  });

  /**
   * THE GAP THIS SUITE FOUND. `ASSIGNED_PAIR` anchors on `\b`, and there is
   * no `\b` between `n` and `P` in `adminPassword` nor between `_` and `p` in
   * `admin_password`. Both went out unredacted, in the module this was moved
   * from, for the whole life of that module.
   */
  const suffixCases: Array<[string, string]> = [
    ["camelCase", 'config load failed: {"adminPassword":"hunter2hunter2","host":"x"}'],
    ["snake_case", "admin_password = hunter2hunter2"],
    ["SCREAMING_SNAKE", "POCKETBASE_PASSWORD=hunter2hunter2"],
    ["kebab-case", "x-api-secret: hunter2hunter2"],
    ["dotted", "Advanced.S3.AccessKey = hunter2hunter2"],
    ["camel compound", "s3SecretAccessKey: 'hunter2hunter2'"],
  ];
  for (const [label, text] of suffixCases) {
    test(`a ${label} credential suffix is blanked`, () => {
      const out = redactSecrets(text);
      expect(out).not.toContain("hunter2hunter2");
      expect(out).toContain(REDACTED);
    });
  }

  test("words that merely contain a key name are not mangled", () => {
    const text = "keyboard shortcut passthrough on tokenizer line 4";
    expect(redactSecrets(text)).toBe(text);
  });

  /**
   * THE OTHER DIRECTION, and the reason the suffix list is narrower than the
   * whole-word list. `lowPass` and `low_pass` are REAL keys in tRadio's audio
   * filter config: a rule that blanked a crossover frequency would lose
   * diagnostic information to protect nothing. These must stay readable.
   */
  const notCredentials = [
    "lowPass = 1200",
    "low_pass = 1200",
    "highPass: 300",
    "sortKey = name",
    "monkey = 3",
    "cacheKey: layout",
  ];
  for (const text of notCredentials) {
    test(`'${text}' is not treated as a credential`, () => {
      expect(redactSecrets(text)).toBe(text);
    });
  }
});

describe("scrub — the composed order", () => {
  test("a name inside a home path is blanked even though the path is collapsed", () => {
    // The hazard this pins: on Windows the account name and the in-game name
    // are frequently the SAME string. If `scrubPaths` ran first it would consume
    // the only occurrence inside the path, and a second occurrence later in the
    // same message would then be matched by a rule that had no evidence the name
    // was identifying. Identifying values go first.
    registerScrubValue("SomePlayer");
    const out = scrub(
      "C:\\Users\\SomePlayer\\FiveM\\x.lua failed while handling a request for SomePlayer"
    );
    expect(out).not.toContain("SomePlayer");
    expect(out).toContain("FiveM");
  });

  test("a non-string is '' rather than 'undefined'", () => {
    expect(scrub(undefined)).toBe("");
    expect(scrub(null)).toBe("");
    expect(scrub({ a: 1 })).toBe("");
  });

  test("all three rules compose in one call", () => {
    registerScrubValue("SomePlayer");
    const out = scrub("GET /api?token=s3cr3tvalue from /home/someplayer/x for SomePlayer");
    expect(out).not.toContain("s3cr3tvalue");
    expect(out).not.toContain("SomePlayer");
    expect(out).toContain(HOME);
    // And the diagnostically useful half is still there.
    expect(out).toContain("/api?token=");
  });
});
