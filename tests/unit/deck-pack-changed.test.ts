// `changed` must answer "did the SOURCES move", not "did the artifact bytes move".
//
// `streamdeck pack` is Elgato's CLI and embeds entry timestamps, so a pack of an
// unchanged tree is never byte-identical to the last one. Comparing artifact
// bytes made CHANGED fire on every build and ask a human to commit a new binary
// each time. The fake `execute` below reproduces that exactly: it writes
// different bytes every call.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deckPaths, packDeckPlugin, readDeckStamp } from "../../shared/ts/build/deck-pack.ts";

const PLUGIN_ID = "com.example.test";

let root = "";

/** Stands in for `streamdeck pack` — new bytes every time, like the real one. */
function fakePack(_cmd: string, args: string[]): void {
  if (args[1] !== "pack") return;
  writeFileSync(deckPaths({ root, pluginId: PLUGIN_ID }).packed, randomBytes(64));
}

function pack() {
  return packDeckPlugin({ root, pluginId: PLUGIN_ID, install: false }, fakePack as never);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "deck-pack-"));
  const pluginRoot = join(root, "client/stream-deck");
  mkdirSync(join(pluginRoot, `${PLUGIN_ID}.sdPlugin`), { recursive: true });
  mkdirSync(join(pluginRoot, "src"), { recursive: true });
  mkdirSync(join(root, "docs/public"), { recursive: true });

  writeFileSync(join(pluginRoot, `${PLUGIN_ID}.sdPlugin`, "manifest.json"), "{}\n");
  writeFileSync(join(pluginRoot, "src", "plugin.ts"), "export const x = 1;\n");
  for (const name of ["rollup.config.mjs", "tsconfig.json", "package.json"]) {
    writeFileSync(join(pluginRoot, name), "{}\n");
  }
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test("the first pack is NEW: there is no stamp to compare against", () => {
  expect(existsSync(deckPaths({ root, pluginId: PLUGIN_ID }).stamp)).toBe(false);
  expect(pack().changed).toBe(true);
});

test("re-packing unchanged sources is not a change, though the bytes differ", () => {
  const first = pack();
  const second = pack();

  // The regression this guards: different artifact bytes from one source tree.
  expect(second.sha256).not.toBe(first.sha256);
  expect(second.changed).toBe(false);
});

test("editing a source file is a change", () => {
  pack();
  writeFileSync(join(root, "client/stream-deck/src", "plugin.ts"), "export const x = 2;\n");

  expect(pack().changed).toBe(true);
});

test("adding a source file is a change", () => {
  pack();
  writeFileSync(join(root, "client/stream-deck/src", "extra.ts"), "export const y = 1;\n");

  const result = pack();
  expect(result.changed).toBe(true);
  expect(readDeckStamp({ root, pluginId: PLUGIN_ID })?.sourceFiles).toBe(6);
});

test("the stamp still records both hashes, so a stale artifact needs two forgeries", () => {
  const result = pack();
  const stamp = readDeckStamp({ root, pluginId: PLUGIN_ID });

  expect(stamp?.artifactSha256).toBe(result.sha256);
  expect(stamp?.sourceHash).not.toBe(stamp?.artifactSha256);
});
