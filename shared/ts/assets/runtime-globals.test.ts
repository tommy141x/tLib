/**
 * These modules are compiled into a CONSUMER'S SERVER BUNDLE and run inside
 * FiveM's Node-based JS runtime. `Bun` does not exist there, so a `Bun.*` call
 * is a `ReferenceError` at the moment it runs -- and when it runs inside an
 * async function, it surfaces only as FiveM's context-free "Unhandled promise
 * rejection in resource <name>".
 *
 * A behavioural test cannot catch this: the test runner IS Bun, so the call
 * succeeds here and fails only in the game. Hence a source check.
 *
 * Regression: `readMarker` used `Bun.file().text()`, which escaped
 * `ensureAssets` (breaking its documented "never throws" contract), escaped
 * tRadio's fire-and-forget weights sync, and left AI Dispatching stuck in
 * `working` forever with nothing in the log naming the subsystem.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const RUNTIME_FILES = ["index.ts", "fetch.ts", "pinned.ts"];

describe("asset subsystem runs on plain node", () => {
  for (const file of RUNTIME_FILES) {
    test(`${file} uses no Bun-only global`, () => {
      const source = readFileSync(join(import.meta.dir, file), "utf8")
        // Comments are allowed to say the word -- the one above `readMarker`
        // does, on purpose. Only executable code is checked.
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|\s)\/\/.*$/gm, "");
      expect(source).not.toMatch(/(?<![\w.])(Bun|Deno)\s*\./);
    });
  }
});
