#!/usr/bin/env bun
// Negative control for the licence gate (shared/ts/build/license.ts).
//
// The gate it replaced was green on every tree it was ever pointed at, because
// each of its defects turned a defect into silence: a missing package.json, an
// empty dependency list, a package absent from node_modules and every workspace
// in the product all read as "approved". Each case below is one of those shapes,
// and must go red with the right reason code.
//
// Every case is a synthetic tree under the OS temp directory: nothing installed,
// no network, nothing written inside the repo.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkLicenses, type LicenseFailureCode } from "../shared/ts/build/license.ts";

const base = mkdtempSync(join(tmpdir(), "tlib-license-control-"));

function tree(name: string, files: Record<string, unknown>): string {
  const dir = join(base, name);
  for (const [rel, body] of Object.entries(files)) {
    const file = join(dir, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body, null, 2));
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}

const pkg = (name: string, license?: unknown, deps?: Record<string, string>) => ({
  name,
  version: "1.0.0",
  ...(license === undefined ? {} : { license }),
  ...(deps ? { dependencies: deps } : {}),
});

const reviewed = {
  reason: "synthetic fixture: proves a reviewed exception is honoured and nothing else",
  reviewed: "2026-10-23",
  reviewedBy: "control",
};

interface Case {
  name: string;
  dir: string;
  /** The reason code this shape must produce, or null when it must pass. */
  expect: LicenseFailureCode | null;
  /** Extra assertion on the report, for cases where "it failed" is not enough. */
  also?: (r: ReturnType<typeof checkLicenses>) => string | null;
}

const cases: Case[] = [
  {
    name: "clean-tree-passes",
    dir: tree("clean", {
      "package.json": pkg("product", "UNLICENSED", { alpha: "^1" }),
      "node_modules/alpha/package.json": pkg("alpha", "MIT"),
    }),
    expect: null,
    also: (r) => (r.examined === 1 ? null : `expected 1 package examined, got ${r.examined}`),
  },
  {
    name: "empty-dependency-set",
    dir: tree("empty", { "package.json": pkg("product", "UNLICENSED") }),
    expect: "NO_PACKAGES",
  },
  {
    name: "no-manifest",
    dir: tree("nomanifest", { "README.md": "no package.json here" }),
    expect: "NO_MANIFEST",
  },
  {
    name: "declared-workspace-has-no-manifest",
    dir: tree("wsmissing", {
      "package.json": { ...pkg("product", "UNLICENSED", { alpha: "^1" }), workspaces: ["web"] },
      "node_modules/alpha/package.json": pkg("alpha", "MIT"),
    }),
    expect: "NO_MANIFEST",
  },
  {
    name: "package-with-no-licence-field",
    dir: tree("nolicense", {
      "package.json": pkg("product", "UNLICENSED", { alpha: "^1" }),
      "node_modules/alpha/package.json": pkg("alpha"),
    }),
    expect: "MISSING_LICENSE",
  },
  {
    name: "restricted-licence",
    dir: tree("restricted", {
      "package.json": pkg("product", "UNLICENSED", { gpl: "^1" }),
      "node_modules/gpl/package.json": pkg("gpl", "GPL-3.0"),
    }),
    expect: "RESTRICTED_LICENSE",
  },
  {
    name: "workspace-only-dep",
    dir: tree("wsonly", {
      // The root manifest is deliberately clean. Only the workspace pulls the
      // GPL package in — which is tRadio's real shape, and exactly what the
      // old root-only gate could not see.
      "package.json": { ...pkg("product", "UNLICENSED"), workspaces: ["web"] },
      "web/package.json": { ...pkg("product-web", undefined, { gpl: "^1" }), private: true },
      "node_modules/gpl/package.json": pkg("gpl", "GPL-3.0"),
    }),
    expect: "RESTRICTED_LICENSE",
  },
  {
    name: "policy-declared-root-dep",
    dir: tree("policyroot", {
      // tLib's shape: no bun workspaces at all, sub-trees installed on their
      // own and named by the policy file instead.
      "package.json": pkg("product", "UNLICENSED"),
      "license-policy.json": { roots: ["client/web"], exceptions: [] },
      "client/web/package.json": pkg("product-web", undefined, { gpl: "^1" }),
      "client/web/node_modules/gpl/package.json": pkg("gpl", "GPL-3.0"),
    }),
    expect: "RESTRICTED_LICENSE",
  },
  {
    name: "policy-declared-root-that-is-not-there",
    dir: tree("policyroot-missing", {
      "package.json": pkg("product", "UNLICENSED", { alpha: "^1" }),
      "node_modules/alpha/package.json": pkg("alpha", "MIT"),
      "license-policy.json": { roots: ["client/web"], exceptions: [] },
    }),
    expect: "NO_MANIFEST",
  },
  {
    name: "transitive-dep",
    dir: tree("transitive", {
      "package.json": pkg("product", "UNLICENSED", { alpha: "^1" }),
      "node_modules/alpha/package.json": pkg("alpha", "MIT", { gpl: "^1" }),
      "node_modules/gpl/package.json": pkg("gpl", "GPL-3.0"),
    }),
    expect: "RESTRICTED_LICENSE",
  },
  {
    name: "declared-but-not-installed",
    dir: tree("unresolved", {
      "package.json": pkg("product", "UNLICENSED", { ghost: "^1" }),
    }),
    expect: "UNRESOLVED",
  },
  {
    name: "dual-licence-takes-the-permissive-side",
    dir: tree("dual", {
      "package.json": pkg("product", "UNLICENSED", { alpha: "^1" }),
      "node_modules/alpha/package.json": pkg("alpha", "MIT OR GPL-3.0"),
    }),
    expect: null,
  },
  {
    name: "reviewed-npm-exception-is-honoured",
    dir: tree("exception", {
      "package.json": pkg("product", "UNLICENSED", { gpl: "^1" }),
      "node_modules/gpl/package.json": pkg("gpl", "GPL-3.0"),
      "license-policy.json": {
        exceptions: [{ package: "gpl", license: "GPL-3.0", kind: "npm", ...reviewed }],
      },
    }),
    expect: null,
    also: (r) =>
      r.packages[0]?.status === "excepted"
        ? null
        : `expected status "excepted", got ${r.packages[0]?.status}`,
  },
  {
    name: "exception-that-covers-nothing",
    dir: tree("stale", {
      "package.json": pkg("product", "UNLICENSED", { alpha: "^1" }),
      "node_modules/alpha/package.json": pkg("alpha", "MIT"),
      "license-policy.json": {
        exceptions: [{ package: "retired", license: "GPL-3.0", kind: "npm", ...reviewed }],
      },
    }),
    expect: "STALE_EXCEPTION",
  },
  {
    name: "vendored-exception-with-a-licence-file-that-is-not-there",
    dir: tree("vendored-missing", {
      "package.json": pkg("product", "UNLICENSED", { alpha: "^1" }),
      "node_modules/alpha/package.json": pkg("alpha", "MIT"),
      "license-policy.json": {
        exceptions: [
          {
            package: "codec2",
            license: "LGPL-2.1",
            kind: "vendored",
            licenseFile: "assets/codec2/COPYING",
            ...reviewed,
          },
        ],
      },
    }),
    expect: "VENDORED_LICENSE_MISSING",
  },
  {
    name: "vendored-exception-with-its-licence-file-present",
    dir: tree("vendored-ok", {
      "package.json": pkg("product", "UNLICENSED", { alpha: "^1" }),
      "node_modules/alpha/package.json": pkg("alpha", "MIT"),
      "assets/codec2/COPYING": "GNU LESSER GENERAL PUBLIC LICENSE Version 2.1",
      "license-policy.json": {
        exceptions: [
          {
            package: "codec2",
            license: "LGPL-2.1",
            kind: "vendored",
            licenseFile: "assets/codec2/COPYING",
            ...reviewed,
          },
        ],
      },
    }),
    expect: null,
    also: (r) =>
      r.vendored.length === 1 ? null : `expected 1 vendored component, got ${r.vendored.length}`,
  },
  {
    name: "exception-without-a-recorded-reason",
    dir: tree("policy-invalid", {
      "package.json": pkg("product", "UNLICENSED", { alpha: "^1" }),
      "node_modules/alpha/package.json": pkg("alpha", "MIT"),
      "license-policy.json": {
        exceptions: [
          {
            package: "gpl",
            license: "GPL-3.0",
            kind: "npm",
            reviewed: "2026-10-23",
            reviewedBy: "control",
          },
        ],
      },
    }),
    expect: "POLICY_INVALID",
  },
];

let failed = 0;
for (const c of cases) {
  const report = checkLicenses({ cwd: c.dir });
  const codes = report.failures.map((f) => f.code);
  const problems: string[] = [];

  if (c.expect === null) {
    if (!report.ok)
      problems.push(
        `expected a pass, got: ${report.failures.map((f) => `[${f.code}] ${f.detail}`).join("; ")}`
      );
  } else if (!codes.includes(c.expect)) {
    problems.push(`expected ${c.expect}, got ${codes.length ? codes.join(", ") : "a PASS"}`);
  }
  const extra = c.also?.(report);
  if (extra) problems.push(extra);

  if (problems.length > 0) {
    failed++;
    console.log(`  ✗ ${c.name}: ${problems.join(" | ")}`);
  } else {
    console.log(`  ✓ ${c.name}${c.expect ? ` → ${c.expect}` : " → pass"}`);
  }
}

console.log(
  failed === 0
    ? `license gate control: ${cases.length} cases, all as expected`
    : `license gate control: ${failed}/${cases.length} cases wrong — the gate is not measuring what it claims`
);
process.exit(failed === 0 ? 0 : 1);
