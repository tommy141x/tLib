/**
 * The secret gate's unit oracle.
 *
 * The load-bearing test in this file is the FIRST one: the TypeScript pattern
 * list and the Lua one must be the same SET OF NAMES, proved by running a real
 * Lua VM over the real `shared/imports/diag/shared.lua` and comparing. Every
 * other test here is about the scanner; that one is about the thing the whole
 * design rests on, which is that there is only one list.
 *
 * Coverage is asserted as a SET OF NAMES, never as a count. Three precedents
 * in this tree for why: a control that passed by accident, one with a stale
 * expected count that refused its own run, and one that asserted what a stub had
 * been told to record. A count is satisfied by the wrong members.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  coverage,
  DEFAULT_POLICY,
  isConfigPath,
  isIgnored,
  judge,
  readPolicy,
} from "../../shared/ts/secrets/gate.ts";
import {
  isSecretName,
  PATTERNS_LUA_PATH,
  parseSecretPatterns,
  secretPatterns,
} from "../../shared/ts/secrets/patterns.ts";
import { blankSecrets, scanEnv, scanLua, scannerFor } from "../../shared/ts/secrets/scan.ts";

const repoRoot = path.resolve(import.meta.dir, "..", "..");

describe("the pattern list has exactly one home", () => {
  test("the TS list equals what a real Lua VM reports from the Lua file", () => {
    // fengari, the same VM tests/lua/* run in. Asserting against the file we
    // just parsed would be asserting that a parser agrees with itself.
    const script = path.join(os.tmpdir(), `tlib-secret-patterns-${process.pid}.lua`);
    fs.writeFileSync(
      script,
      [
        "local Diag = dofile('shared/imports/diag/shared.lua')",
        "local out = {}",
        "for _, p in ipairs(Diag.SECRET_PATTERNS) do out[#out+1] = p end",
        "table.sort(out)",
        "print(table.concat(out, '\\n'))",
      ].join("\n"),
      "utf8"
    );
    const run = Bun.spawnSync(
      ["bunx", "--bun", "--package", "fengari-node-cli", "fengari", script],
      { cwd: repoRoot, stdout: "pipe", stderr: "pipe" }
    );
    fs.rmSync(script, { force: true });

    const stdout = new TextDecoder().decode(run.stdout).trim();
    expect(run.exitCode).toBe(0);
    const fromLua = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    // A VM that printed nothing would make `new Set()` equal `new Set()` only if
    // the TS side were empty too — but assert it outright, because an empty
    // oracle is the failure mode this test exists to not have.
    expect(fromLua.length).toBeGreaterThan(10);
    expect(new Set(secretPatterns())).toEqual(new Set(fromLua));
  });

  test("the six patterns added for the measured gaps are present, by name", () => {
    const present = new Set(secretPatterns());
    for (const pattern of [
      "accesskey",
      "access_key",
      "privkey",
      "passphrase",
      "bearer",
      "signingkey",
    ]) {
      expect(present).toContain(pattern);
    }
  });

  test("Advanced.S3.AccessKey — the one credential the old lists missed — matches", () => {
    expect(isSecretName("AccessKey")).toBe(true);
    // And the reason it was missed: `accesskey` is not a substring of `apikey`.
    expect(isSecretName("AccessKey", ["apikey", "api_key"])).toBe(false);
  });

  test("the parser refuses rather than returning a short list", () => {
    expect(() => parseSecretPatterns("nothing here")).toThrow(/no .*SECRET_PATTERNS/);
    expect(() => parseSecretPatterns("Diag.SECRET_PATTERNS = {}")).toThrow(/zero patterns/);
    expect(() => parseSecretPatterns("Diag.SECRET_PATTERNS = { 'a', b }")).toThrow(
      /unparsed token/
    );
    expect(() => parseSecretPatterns("Diag.SECRET_PATTERNS = { 'Token' }")).toThrow(/lowercase/);
  });

  test("the Lua file it parses is the one the runtime redactor uses", () => {
    expect(fs.existsSync(PATTERNS_LUA_PATH)).toBe(true);
    expect(PATTERNS_LUA_PATH.replace(/\\/g, "/")).toMatch(/shared\/imports\/diag\/shared\.lua$/);
  });
});

const TEMPLATE = `Config = {
    authToken          = "",
    adminPassword      = "141",
    dispatchNacId      = "141",
    discord            = {
        authEnabled  = false,
        clientId     = "",
        clientSecret = "a-synthetic-client-secret",
        botToken     = "",
    },
}
`;

describe("scanLua", () => {
  test("finds set credentials and ignores blank ones, by name", () => {
    const { findings, blankKeys } = scanLua(TEMPLATE);
    expect(new Set(findings.map((f) => f.path))).toEqual(
      new Set(["Config.adminPassword", "Config.discord.clientSecret"])
    );
    expect(new Set(blankKeys)).toEqual(
      // `clientId` is absent on purpose: it is not credential-shaped, so it is
      // not something this gate has an opinion about in either direction.
      new Set(["Config.authToken", "Config.discord.botToken"])
    );
  });

  test("never carries the value into a finding — only its length", () => {
    const { findings } = scanLua(TEMPLATE);
    expect(JSON.stringify(findings)).not.toContain("a-synthetic-client-secret");
    expect(findings.find((f) => f.key === "adminPassword")?.length).toBe(3);
  });

  test("dispatchNacId is not a credential and is left entirely alone", () => {
    // It ships as the public demo's code on purpose and blanking it breaks first
    // boot. It is not exempted anywhere — the NAME rule simply does not match it,
    // which is the right reason for it to be safe.
    expect(isSecretName("dispatchNacId")).toBe(false);
    expect(scanLua(TEMPLATE).findings.some((f) => f.key === "dispatchNacId")).toBe(false);
  });

  test("a commented-out line is not config", () => {
    const source = `--   2) Change authToken to a long random string (20+ chars)\n`;
    expect(scanLua(source).findings).toEqual([]);
  });

  test("a block comment's body is not config either", () => {
    const source = [
      "--[[",
      '    authToken = "an example in the header prose"',
      "]]",
      'Config.authToken = ""',
    ].join("\n");
    expect(scanLua(source).findings).toEqual([]);
    expect(scanLua(source).blankKeys).toEqual(["Config.authToken"]);
  });

  test("a long-string credential is REFUSED, not skipped", () => {
    const source = "Config = {\n    authToken = [[multi\nline]],\n}\n";
    const finding = scanLua(source).findings[0];
    expect(finding?.key).toBe("authToken");
    expect(finding?.unblankable).toBe(true);
  });

  test("a bracketed key is read", () => {
    const source = `Config = {\n    ["webhookUrl"] = "https://example.invalid/hook",\n}\n`;
    expect(scanLua(source).findings.map((f) => f.key)).toEqual(["webhookUrl"]);
  });

  test("a dotted top-level assignment is read, and reported by its leaf", () => {
    const source = `Config.Advanced.S3.AccessKey = "SYNTHETICACCESSKEY"\n`;
    const finding = scanLua(source).findings[0];
    expect(finding?.key).toBe("AccessKey");
    expect(finding?.path).toBe("Config.Advanced.S3.AccessKey");
  });

  test("a non-string value is not a finding", () => {
    expect(scanLua("Config = { tokenCount = 12, secretEnabled = false }\n").findings).toEqual([]);
  });
});

describe("scanEnv", () => {
  test("reads quoted, unquoted and exported assignments", () => {
    const source = [
      "# a comment",
      "STRIPE_SECRET_KEY=sk_test_synthetic",
      'TEBEX_WEBHOOK_SECRET="also-synthetic"',
      "export POLAR_ACCESS_TOKEN=bare-value",
      "BETTER_AUTH_SECRET=",
      "PUBLIC_BASE_URL=https://example.invalid",
    ].join("\n");
    const { findings, blankKeys } = scanEnv(source);
    expect(new Set(findings.map((f) => f.key))).toEqual(
      new Set(["STRIPE_SECRET_KEY", "TEBEX_WEBHOOK_SECRET", "POLAR_ACCESS_TOKEN"])
    );
    expect(blankKeys).toEqual(["BETTER_AUTH_SECRET"]);
  });
});

describe("blankSecrets", () => {
  test("blanks every credential and preserves the template's alignment", () => {
    const { source, cleared, refused } = blankSecrets(TEMPLATE, "config.lua");
    expect(refused).toEqual([]);
    expect(source).toContain('    adminPassword      = ""');
    expect(source).toContain('    clientSecret = ""');
    expect(source).not.toContain("a-synthetic-client-secret");
    expect(source).not.toContain('"141"\n    dispatchNacId');
    // Reports what it changed, by name and length, never the value.
    expect(cleared).toEqual([
      "Config.adminPassword (was 3 chars)",
      "Config.discord.clientSecret (was 25 chars)",
    ]);
    expect(cleared.join()).not.toContain("141");
  });

  test("leaves dispatchNacId shipping as the demo code", () => {
    expect(blankSecrets(TEMPLATE, "config.lua").source).toContain('dispatchNacId      = "141"');
  });

  test("is idempotent", () => {
    const once = blankSecrets(TEMPLATE, "config.lua").source;
    const twice = blankSecrets(once, "config.lua");
    expect(twice.cleared).toEqual([]);
    expect(twice.source).toBe(once);
  });

  test("a renamed key does NOT break it — the rule is the name's shape", () => {
    // The old hand-listed sanitizer threw here, which was the best it could do:
    // it had no way to know whether `panelPassword` was the renamed secret or a
    // new setting. The derived rule simply catches it.
    const renamed = TEMPLATE.replace("adminPassword", "panelPassword");
    const { cleared } = blankSecrets(renamed, "config.lua");
    expect(cleared).toContain("Config.panelPassword (was 3 chars)");
  });

  test("refuses a file type it does not know how to read", () => {
    expect(() => blankSecrets("x", "config.json")).toThrow(/no scanner/);
  });

  test("reports an unblankable long string instead of silently leaving it", () => {
    const { refused } = blankSecrets("Config = {\n    authToken = [[a]],\n}\n", "config.lua");
    expect(refused.map((f) => f.key)).toEqual(["authToken"]);
  });
});

describe("the config-file rule", () => {
  test("matches the real config paths in this tree, and not an arbitrary .lua", () => {
    for (const file of [
      "config.lua",
      "config/config.lua",
      "config.example.lua",
      "shared/sh_config_check.lua",
      "config/sv_functions.lua",
      ".env",
      ".env.example",
    ]) {
      expect(isConfigPath(file)).toBe(true);
    }
    for (const file of ["client/cl_main.lua", "fxmanifest.lua", "package.json", "docs/x.mdx"]) {
      expect(isConfigPath(file)).toBe(false);
    }
  });

  test("scannerFor refuses to guess", () => {
    expect(scannerFor("config.json")).toBeNull();
    expect(scannerFor("config.lua")).not.toBeNull();
    expect(scannerFor(".env.local")).not.toBeNull();
  });
});

describe("the policy refuses an unjustified exemption", () => {
  test("allow and ignore entries need a reason", () => {
    expect(() => readPolicy({ secretGate: { allow: ["authToken"] } })).toThrow(/REASON/);
    expect(() => readPolicy({ secretGate: { allow: { authToken: "nope" } } })).toThrow(/reason/);
    expect(() => readPolicy({ secretGate: { noConfig: true } })).toThrow(/REASON/);
    expect(
      readPolicy({ secretGate: { allow: { authToken: "a twelve-plus character reason" } } }).allow
        .authToken
    ).toBe("a twelve-plus character reason");
  });

  test("node_modules is ignored by default and test fixtures are NOT", () => {
    expect(isIgnored("node_modules/x/config.lua", DEFAULT_POLICY)).not.toBeNull();
    expect(isIgnored("client/node_modules/x/config.lua", DEFAULT_POLICY)).not.toBeNull();
    expect(isIgnored("scripts/tests/config.lua", DEFAULT_POLICY)).toBeNull();
  });
});

describe("judge", () => {
  const files = [{ file: "config/config.lua", content: TEMPLATE }];

  test("a set credential is an offence", () => {
    const report = judge("head", files, DEFAULT_POLICY);
    expect(report.offences).toHaveLength(1);
    expect(new Set(report.offences[0]?.findings.map((f) => f.path))).toEqual(
      new Set(["Config.adminPassword", "Config.discord.clientSecret"])
    );
  });

  test("an allowed key is reported as allowed, not as clean", () => {
    const policy = {
      ...DEFAULT_POLICY,
      allow: {
        adminPassword: "the demo password, documented in the template header",
        clientSecret: "likewise, for this test",
      },
    };
    const report = judge("head", files, policy);
    expect(report.offences).toHaveLength(0);
    expect(new Set(report.allowed.map((a) => a.finding.path))).toEqual(
      new Set(["Config.adminPassword", "Config.discord.clientSecret"])
    );
  });

  test("an unblankable value can never be allowed", () => {
    const report = judge(
      "head",
      [{ file: "config.lua", content: "Config = {\n  authToken = [[x]],\n}\n" }],
      { ...DEFAULT_POLICY, allow: { authToken: "exempted on purpose for this test" } }
    );
    expect(report.offences).toHaveLength(1);
  });

  test("coverage names every credential-shaped key, blank or not", () => {
    expect(coverage(files)).toEqual(
      new Set(
        ["authToken", "adminPassword", "clientId", "clientSecret", "botToken"].filter((k) =>
          isSecretName(k)
        )
      )
    );
  });
});
