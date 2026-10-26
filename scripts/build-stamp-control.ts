#!/usr/bin/env bun
// Negative control for the build stamp (shared/ts/build/core.ts, `stampBuildId`),
// whose job is to let a diagnostic tell two releases apart. tLib v1.0 was
// republished in place with a crash fix in it and no version change, and the
// thing that cost support a thread was not a missing feature: it was that
// `tLib 1.0.0` was a TRUE statement about both trees.
//
// So the claim under control is not "prod printed a build id". It is four
// properties, and a stamper can satisfy the first while failing any of the rest:
//
//   distinguishes  one changed byte in one shipped file changes the id
//   stable         an unchanged tree restamps to the SAME id
//   idempotent     restamping a stamped tree does not compound
//   versionSafe    `version` is untouched, so imports.lua's tlib_min_version
//                  gate still accepts a consumer pinning '1.0'
//
// `properties()` below is the measurement. It is run against the real stamper,
// which must satisfy all four, and then against four deliberately broken ones --
// each of which must FAIL the property it breaks. Without those drills, "all four
// green" is a claim about one implementation and says nothing about whether the
// measurement can still go red.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stampBuildId } from "../shared/ts/build/core.ts";

type Stamper = (dist: string, now?: Date) => string;

const MANIFEST = "fx_version 'cerulean'\nversion '1.0.0'\nui_page 'client/ui/index.html'\n";
const DAY = new Date("2026-10-24T14:59:00Z");
const PROPERTIES = ["distinguishes", "stable", "idempotent", "versionSafe"] as const;

function stage(adapters: string): string {
  const dist = mkdtempSync(join(tmpdir(), "tlib-stamp-control-"));
  mkdirSync(join(dist, "shared/imports/access"), { recursive: true });
  writeFileSync(join(dist, "fxmanifest.lua"), MANIFEST);
  writeFileSync(join(dist, "shared/imports/access/adapters.lua"), adapters);
  return dist;
}

/** Which of PROPERTIES this stamper fails. */
function failures(stamp: Stamper): string[] {
  // Three trees: two that differ by one byte in a shipped Lua file -- which is
  // the whole of c9a8f8f -- and a third identical to the first.
  const trees = [stage("before\n"), stage("after\n"), stage("before\n")];
  try {
    const [a, b, again] = trees.map((dist) => stamp(dist, DAY));
    const failed: string[] = [];
    if (a === b) failed.push("distinguishes");
    if (again !== a) failed.push("stable");
    if (stamp(trees[0], DAY) !== a) failed.push("idempotent");
    if (!/^version '1\.0\.0'$/m.test(readFileSync(join(trees[0], "fxmanifest.lua"), "utf8"))) {
      failed.push("versionSafe");
    }
    return failed;
  } finally {
    for (const dist of trees) rmSync(dist, { recursive: true, force: true });
  }
}

let checks = 0;
let bad = 0;
function check(name: string, ok: boolean, detail = "") {
  checks++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : `\n     ${detail}`}`);
  if (!ok) bad++;
}

const real = failures(stampBuildId);
check(
  `the real stamper satisfies all ${PROPERTIES.length} properties`,
  real.length === 0,
  `failed: ${real.join(", ")}`
);

// One broken stamper per property. Each writes a plausible-looking id, so the
// difference between these and the real one is invisible in a build log.
const append = (dist: string, id: string) => {
  const path = join(dist, "fxmanifest.lua");
  writeFileSync(path, `${readFileSync(path, "utf8").trimEnd()}\n\ntlib_build '${id}'\n`);
  return id;
};

const drills: Array<[(typeof PROPERTIES)[number], string, Stamper]> = [
  [
    "distinguishes",
    "hashes only the manifest, so a fix in a shipped Lua file is invisible",
    (dist, now = DAY) => append(dist, `${now.getUTCFullYear()}-manifest`),
  ],
  [
    "stable",
    "writes a timestamp wearing a hash, so two installs of one release never match",
    (dist) => append(dist, `20261024-${process.hrtime.bigint().toString(16).slice(-8)}`),
  ],
  [
    "idempotent",
    "hashes the stamp it previously wrote, so every restamp invents a new id",
    (dist, now = DAY) => {
      const path = join(dist, "fxmanifest.lua");
      const text = readFileSync(path, "utf8");
      const id = `${now.toISOString().slice(0, 10).replace(/-/g, "")}-${text.length.toString(16).padStart(8, "0")}`;
      writeFileSync(path, `${text.trimEnd()}\n\ntlib_build '${id}'\n`);
      return id;
    },
  ],
  [
    "versionSafe",
    "folds the id into `version`, which is what imports.lua compares '1.0' against",
    (dist, now = DAY) => {
      const path = join(dist, "fxmanifest.lua");
      const id = `${now.toISOString().slice(0, 10).replace(/-/g, "")}-deadbeef`;
      writeFileSync(path, readFileSync(path, "utf8").replace("'1.0.0'", `'1.0.0+${id}'`));
      return id;
    },
  ],
];

for (const [property, why, stamp] of drills) {
  const failed = failures(stamp);
  check(
    `a stamper that ${why} fails "${property}"`,
    failed.includes(property),
    `failed only: ${failed.join(", ") || "nothing — the measurement cannot see this"}`
  );
}

console.log(`\n${checks - bad}/${checks} checks passed`);
if (bad > 0) process.exit(1);
