// `uncoveredFonts` answers the question `stageFontLicences` would otherwise
// answer by making it true.
//
// The stager copies. A release gate that called it would repair the tree it was
// checking -- a missing licence gets copied in by the act of testing, and the run
// reports success -- so it is a gate that cannot fail, and a test that writes
// into the artifact. tRadio hit exactly that and worked around it by re-deriving
// the family itself, which is where its real bug was: it split on the first
// hyphen, so `hanken-grotesk-latin.woff2` became `hanken` and matched nothing.
//
// These tests pin the two properties that make a single shared matcher worth
// having: the normalisation handles a two-word family with no alias table, and
// asking the question changes nothing on disk.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageFontLicences, uncoveredFonts } from "../../shared/ts/build/font-licences.ts";

let root = "";
let dist = "";
let licences = "";

/** Every file under a tree, relative and sorted — the "did anything change" oracle. */
function treeOf(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string, prefix: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      if (entry.isDirectory()) walk(join(at, entry.name), `${prefix}${entry.name}/`);
      else out.push(`${prefix}${entry.name}`);
    }
  };
  walk(dir, "");
  return out;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uncovered-fonts-"));
  dist = join(root, "dist", "assets");
  licences = join(root, "licences");
  mkdirSync(dist, { recursive: true });
  mkdirSync(licences, { recursive: true });
  writeFileSync(join(licences, "OFL-HankenGrotesk.txt"), "licence text\n");
  writeFileSync(join(licences, "OFL-Inter.txt"), "licence text\n");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

test("a two-word family matches its licence with no alias table", () => {
  writeFileSync(join(dist, "hanken-grotesk-latin-CaVRRdDk.woff2"), "font");

  expect(uncoveredFonts(dist, [licences])).toEqual([]);
});

test("asking the question writes nothing — the whole point of the split", () => {
  writeFileSync(join(dist, "hanken-grotesk-latin-CaVRRdDk.woff2"), "font");
  const before = treeOf(root);

  uncoveredFonts(dist, [licences]);

  expect(treeOf(root)).toEqual(before);
  expect(existsSync(join(dist, "OFL-HankenGrotesk.txt"))).toBe(false);
});

test("the stager, by contrast, repairs it — which is why a gate must not call it", () => {
  writeFileSync(join(dist, "hanken-grotesk-latin-CaVRRdDk.woff2"), "font");

  stageFontLicences(dist, [licences]);

  expect(existsSync(join(dist, "OFL-HankenGrotesk.txt"))).toBe(true);
});

test("a font whose licence is in no source directory is reported", () => {
  writeFileSync(join(dist, "poppins-400-latin-cpxAROuN.woff2"), "font");

  expect(uncoveredFonts(dist, [licences])).toEqual(["poppins-400-latin-cpxAROuN.woff2"]);
});

test("a licence already beside the font counts as covered", () => {
  writeFileSync(join(dist, "poppins-400-latin-cpxAROuN.woff2"), "font");
  writeFileSync(join(dist, "OFL-Poppins.txt"), "licence text\n");

  expect(uncoveredFonts(dist, [licences])).toEqual([]);
});

test("a LICENSES.md beside the faces covers them, as tUnit's web/fonts does", () => {
  writeFileSync(join(dist, "poppins-400-latin-cpxAROuN.woff2"), "font");
  writeFileSync(join(dist, "LICENSES.md"), "three display faces, documented\n");

  expect(uncoveredFonts(dist, [licences])).toEqual([]);
});

test("the matcher is a prefix match, so a short family cannot swallow a longer one", () => {
  writeFileSync(join(licences, "OFL-JetBrainsMono.txt"), "licence text\n");
  writeFileSync(join(dist, "jetbrains-mono-100-800-latin-B9CIFXIH.woff2"), "font");

  // `inter` must not match `jetbrainsmono…`, and `jetbrainsmono` must win over a
  // hypothetical shorter `jetbrains` rather than being chosen by map order.
  expect(uncoveredFonts(dist, [licences])).toEqual([]);
});

test("the stager and the gate cannot disagree: stage, then ask, and nothing is uncovered", () => {
  writeFileSync(join(dist, "hanken-grotesk-latin-CaVRRdDk.woff2"), "font");
  writeFileSync(join(dist, "inter-100-900-latin-Dx4kXJAl.woff2"), "font");

  stageFontLicences(dist, [licences]);

  expect(uncoveredFonts(dist, [licences])).toEqual([]);
});
