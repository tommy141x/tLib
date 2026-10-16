import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FALLBACK_ICON,
  ICONS_RESOURCE_PATH,
  iconBody,
  isKnownIcon,
} from "../../server/lib/http/icons";

/**
 * Three bugs met here on 2026-10-15 and between them meant NO shipped tLib
 * rendered a hub icon, while the dev box looked fine:
 *
 *   1. The FXServer branch asked for `<root>/server/http/icons.json`, missing
 *      the `lib` segment, so it never matched.
 *   2. It therefore fell through to `join(__dirname, ...)`, which the bundler
 *      resolves at BUILD time -- so the server bundle carried the build
 *      machine's absolute Windows path and asked a Linux host for it.
 *   3. `scripts/prod.ts` never shipped the file at all.
 *
 * Each one alone is invisible on a developer's machine, because there the
 * source tree IS the runtime. These assert the two halves that are checkable
 * without a game: the path constant matches where the generator writes, and the
 * release carries it.
 */

const REPO = join(import.meta.dir, "..", "..");

describe("icon set", () => {
  test("the path constant is where build-icons.ts actually writes", () => {
    // Read the generator rather than restating its path: a second copy of a
    // path is the thing that drifted in the first place.
    const generator = readFileSync(join(REPO, "scripts", "build-icons.ts"), "utf8");
    const out = generator.match(/const OUT\s*=\s*["']\.?\/?(.+?)["']/);
    expect(out, "scripts/build-icons.ts no longer declares OUT").not.toBeNull();
    expect(out![1]).toBe(ICONS_RESOURCE_PATH);
  });

  test("the file exists where the constant says", () => {
    expect(existsSync(join(REPO, ICONS_RESOURCE_PATH))).toBe(true);
  });

  test("the release ships it", () => {
    // Without this the hub renders with no icons for every customer, and
    // nothing upstream fails -- load() degrades to {} by design.
    const prod = readFileSync(join(REPO, "scripts", "prod.ts"), "utf8");
    expect(prod).toContain(`"${ICONS_RESOURCE_PATH}"`);
  });

  test("no absolute path is baked into the loader", () => {
    // `__dirname` survives as the outside-the-game fallback, but the FXServer
    // path must go through LoadResourceFile, which is resource-relative.
    const src = readFileSync(join(REPO, "server", "lib", "http", "icons.ts"), "utf8");
    expect(src).toContain("fLoadResourceFile");
    expect(src).not.toContain('"server", "http"');
  });

  test("resolves a real icon and falls back for an unknown one", () => {
    expect(isKnownIcon(FALLBACK_ICON)).toBe(true);
    expect(iconBody(FALLBACK_ICON).length).toBeGreaterThan(0);
    // An unknown name costs the card its icon, never the hub its render.
    expect(iconBody("definitely-not-an-icon")).toBe(iconBody(FALLBACK_ICON));
  });

  test("rejects a name that is not kebab-case ASCII before looking it up", () => {
    expect(isKnownIcon("../../etc/passwd")).toBe(false);
    expect(isKnownIcon("Circle-Help")).toBe(false);
    expect(isKnownIcon(42)).toBe(false);
  });
});
