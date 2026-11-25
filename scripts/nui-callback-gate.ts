#!/usr/bin/env bun
/**
 * Fails on a Lua file that registers an NUI callback without `tlib.nui.register`.
 *
 * cfx's RegisterNUICallback catches a throw and prints it but never answers, so
 * the page's fetch hangs to its deadline. `tlib.nui.register` is the one place
 * that guarantees an answer, which makes a bare registration the bug itself.
 *
 *   bun run check:nui                 tLib's own tree; exit 1 on a finding
 *   bun run check:nui --siblings      also count the bare registrations in each
 *                                     checked-out sibling resource (report only:
 *                                     they migrate in their own releases)
 *
 * Exit 0 pass, 1 a finding, 2 the gate could not run.
 */

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { siblingResources } from "./siblings.ts";

/** The one file allowed to call the host: it is the implementation. */
export const REGISTRAR = "shared/imports/nui/client.lua";

const SKIP_DIRS = new Set(["node_modules", ".git", "internal", "tests", "dist", "build"]);

// `RegisterNuiCallbackType` and the raw `__cfx_nui:` event are the same
// registration one level down, which is how the menu adapter did it.
const BARE = [
  { re: /\bRegisterNUICallback\s*\(/, what: "RegisterNUICallback" },
  // The REGISTER_NUI_CALLBACK native, which Lua spells this way.
  { re: /\bRegisterNuiCallback\s*\(/, what: "RegisterNuiCallback" },
  { re: /\bRegisterNuiCallbackType\s*\(/, what: "RegisterNuiCallbackType" },
  { re: /['"]__cfx_nui:/, what: "a raw __cfx_nui: handler" },
];

export interface Finding {
  file: string;
  line: number;
  what: string;
}

/** Lua with comments blanked, keeping line numbers. */
function stripComments(source: string): string {
  const blanked = source.replace(/--\[(=*)\[[\s\S]*?\]\1\]/g, (block) =>
    block.replace(/[^\n]/g, " ")
  );
  return blanked
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

export function scanSource(file: string, source: string): Finding[] {
  const findings: Finding[] = [];
  stripComments(source)
    .split("\n")
    .forEach((text, index) => {
      for (const { re, what } of BARE) {
        if (re.test(text)) findings.push({ file, line: index + 1, what });
      }
    });
  return findings;
}

function luaFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) out.push(...luaFiles(join(dir, entry.name)));
    } else if (entry.name.endsWith(".lua")) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

/**
 * The gate judges a resource's OWN Lua, and git is what decides which that is.
 * A resource's ignored paths hold other people's code — vendored reference
 * copies of rival lighting scripts, marketplace layouts, pma-voice — which we
 * did not write and cannot fix. Walking the filesystem blind read 271 files in
 * tLS against 109 tracked and failed on 20 bare registrations, every one of
 * them under the gitignored assets/reference/; tRadio's tree walks 540 Lua
 * files of which all 540 are ignored.
 *
 * Returns null outside a work tree (a release tarball, a vendored copy), where
 * "tracked" means nothing and the walk is the only answer available.
 */
function trackedLuaFiles(root: string): string[] | null {
  const res = spawnSync("git", ["-C", root, "ls-files", "-z", "--", "*.lua"], {
    encoding: "buffer",
  });
  if (res.status !== 0) return null;
  const rels = res.stdout.toString("utf8").split("\0").filter(Boolean);
  return rels.map((r) => join(root, r));
}

export function scanTree(root: string): { files: number; findings: Finding[] } {
  // SKIP_DIRS is applied to both sources: the walk prunes as it descends, and a
  // tracked path can still sit under tests/ or internal/.
  const files = (trackedLuaFiles(root) ?? luaFiles(root)).filter((abs) =>
    relative(root, abs)
      .split("\\")
      .join("/")
      .split("/")
      .every((seg) => !SKIP_DIRS.has(seg))
  );
  const findings: Finding[] = [];
  for (const abs of files) {
    const rel = relative(root, abs).split("\\").join("/");
    if (rel === REGISTRAR) continue;
    findings.push(...scanSource(rel, readFileSync(abs, "utf8")));
  }
  return { files: files.length, findings };
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  const { files, findings } = scanTree(root);
  if (files < 50) {
    console.error(
      `check:nui: read only ${files} Lua files under ${root}; the walk is broken, not clean.`
    );
    process.exit(2);
  }

  if (process.argv.includes("--siblings")) {
    for (const name of siblingResources(root)) {
      const found = scanTree(resolve(root, "..", name)).findings;
      console.log(`${name}: ${found.length} bare NUI registration(s)`);
    }
  }

  if (findings.length > 0) {
    for (const f of findings)
      console.error(`${f.file}:${f.line}: ${f.what} -- use tlib.nui.register`);
    console.error(`check:nui: ${findings.length} bare NUI registration(s)`);
    process.exit(1);
  }
  console.log(`check:nui: ${files} Lua files, no bare NUI registrations`);
}
