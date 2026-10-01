/**
 * `tmarketplace_base_url` is meant to be ONE switch: point it at a local dev
 * worker and every call this codebase makes to the TIMMYG Studios API follows
 * it. Two things used to stop that, and this suite is what keeps them fixed.
 *
 *  1. The default host was written out five separate times — tLib's
 *     `config.ts`, `cl_marketplace.lua`, `sv_marketplace.lua`, `catalogue.ts`
 *     and tRadio's `cl_bridge.lua`. Five copies of a value that must agree.
 *  2. `shared/imports/versioncheck/server.lua` did not read the convar at all,
 *     so with it pointed at localhost the installs went to the dev worker while
 *     the version check and its changelog still hit production.
 *
 * There is now one definition per language — `MARKETPLACE_DEFAULT_BASE_URL` in
 * `shared/ts/marketplace/catalogue.ts` and `StudioApi.DEFAULT_BASE_URL` in
 * `shared/sh_api.lua`. No single source can span TypeScript and Lua, so the two
 * literals are asserted equal here instead, the way this codebase already holds
 * other cross-file pairs together.
 *
 * These assertions are made against the FILES, not against a re-implementation:
 * a test that hard-codes the host would pass while the source drifted, which is
 * the exact failure it exists to catch.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import {
  MARKETPLACE_BASE_URL_CONVAR,
  MARKETPLACE_DEFAULT_BASE_URL,
  marketplaceBaseUrl,
  normalizeStudioBaseUrl,
} from "../../shared/ts/marketplace/catalogue";

const root = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

/** The single Lua definition, taken from the file rather than restated. */
function luaDefault(): string {
  const source = read("shared/sh_api.lua");
  const match = source.match(/StudioApi\.DEFAULT_BASE_URL\s*=\s*'([^']+)'/);
  if (!match) throw new Error("StudioApi.DEFAULT_BASE_URL not found in shared/sh_api.lua");
  return match[1];
}

describe("the studio API base URL has one definition per language", () => {
  test("the Lua and TypeScript defaults are byte-identical", () => {
    expect(luaDefault()).toBe(MARKETPLACE_DEFAULT_BASE_URL);
  });

  test("the convar name agrees, and is still the contract name", () => {
    expect(MARKETPLACE_BASE_URL_CONVAR).toBe("tmarketplace_base_url");
    expect(read("shared/sh_api.lua")).toContain("StudioApi.CONVAR = 'tmarketplace_base_url'");
  });

  test("no tLib reader carries its own copy of the host or its own convar read", () => {
    // Every runtime file that resolves the base URL. A new one that inlines the
    // literal, or calls GetConvar directly, is a fifth copy by another name.
    for (const file of [
      "client/cl_marketplace.lua",
      "server/sv_marketplace.lua",
      "shared/imports/versioncheck/server.lua",
      "server/lib/marketplace/config.ts",
    ]) {
      const source = read(file);
      expect(`${file}: ${source.includes("https://timmygstudios.com")}`).toBe(`${file}: false`);
      expect(`${file}: ${/GetConvar\(\s*['"]tmarketplace_base_url/.test(source)}`).toBe(
        `${file}: false`
      );
    }
  });

  test("every Lua reader goes through StudioApi.baseUrl()", () => {
    for (const file of [
      "client/cl_marketplace.lua",
      "server/sv_marketplace.lua",
      "shared/imports/versioncheck/server.lua",
    ])
      expect(`${file}: ${read(file).includes("StudioApi.baseUrl()")}`).toBe(`${file}: true`);
  });

  test("sh_api.lua is in both shared_scripts and files, or one VM silently has no rule", () => {
    // Loaded into tLib's own VMs by shared_scripts; read out of the resource by
    // a consumer's versioncheck through LoadResourceFile, which needs `files`.
    const manifest = read("fxmanifest.lua");
    expect(manifest.match(/'shared\/sh_api\.lua'/g)?.length).toBe(2);
  });
});

describe("versioncheck follows the override", () => {
  const source = read("shared/imports/versioncheck/server.lua");

  test("the studios provider builds its URL from StudioApi, not a literal", () => {
    // The `studios` provider hits /api/products on the same host the marketplace
    // does. It used to hard-code it; the format string now takes the base URL.
    expect(source).toContain("/api/products/%s/changelog?since=%s&limit=10");
    expect(source).toContain(":format(StudioApi.baseUrl(), product, encoded)");
  });

  test("the github provider is untouched — it really does point at GitHub", () => {
    expect(source).toContain("https://api.github.com/repos/");
  });

  test("it loads the shared module rather than assuming tLib's VM", () => {
    // versioncheck runs inside the CONSUMER resource's VM, where tLib's
    // shared_scripts were never loaded. Same bootstrap as sh_branding.lua.
    expect(source).toContain("LoadResourceFile('tLib', path)");
    expect(source).toContain("local path = 'shared/sh_api.lua'");
  });
});

describe("value sanity", () => {
  test("whitespace and trailing slashes are stripped", () => {
    expect(normalizeStudioBaseUrl("  http://localhost:8787/  ")).toBe("http://localhost:8787");
    expect(normalizeStudioBaseUrl("http://localhost:8787///")).toBe("http://localhost:8787");
  });

  test("an API path the callers append themselves is trimmed, not doubled", () => {
    for (const suffix of ["/api", "/api/v1", "/api/v2", "/api/v2/marketplace"])
      expect(normalizeStudioBaseUrl(`http://localhost:8787${suffix}`)).toBe("http://localhost:8787");
    expect(normalizeStudioBaseUrl("http://localhost:8787/api/v1/")).toBe("http://localhost:8787");
  });

  test("a path that merely looks like one is left alone", () => {
    expect(normalizeStudioBaseUrl("http://localhost:3000/marketplace")).toBe(
      "http://localhost:3000/marketplace"
    );
    expect(normalizeStudioBaseUrl("https://host/apiary")).toBe("https://host/apiary");
  });

  test("empty, blank and non-string values fall back to the default, never to ''", () => {
    // An empty base URL would build `/api/v1/items/...` — a relative URL that
    // PerformHttpRequest cannot resolve, and a silent break rather than a loud one.
    for (const raw of ["", "   ", "/", "///", null, undefined, 42])
      expect(normalizeStudioBaseUrl(raw)).toBe(MARKETPLACE_DEFAULT_BASE_URL);
  });

  test("the Lua mirror trims the same four suffixes, in the same order", () => {
    // Longest first: '/api' is a suffix of '/api/v1' reversed-order matches would
    // leave '/v1' behind. Both files list them, and the order is the contract.
    const lua = read("shared/sh_api.lua");
    expect(lua).toContain("'/api/v2/marketplace', '/api/v2', '/api/v1', '/api'");
    expect(read("shared/ts/marketplace/catalogue.ts")).toContain(
      '["/api/v2/marketplace", "/api/v2", "/api/v1", "/api"]'
    );
  });

  test("marketplaceBaseUrl() reads the convar and normalises it on every call", () => {
    const g = globalThis as { GetConvar?: (n: string, d: string) => string };
    const original = g.GetConvar;
    try {
      let value = "http://localhost:8787/api/v1/";
      g.GetConvar = (name, fallback) =>
        name === MARKETPLACE_BASE_URL_CONVAR ? value : fallback;
      expect(marketplaceBaseUrl()).toBe("http://localhost:8787");
      // No memoisation anywhere on this path: a mid-session change takes effect.
      value = "http://127.0.0.1:9999";
      expect(marketplaceBaseUrl()).toBe("http://127.0.0.1:9999");
    } finally {
      if (original) g.GetConvar = original;
      else delete g.GetConvar;
    }
  });
});

describe("resolveConfig is not memoised", () => {
  test("a convar change mid-session is picked up without a resource restart", async () => {
    // It used to cache into a module-scope `cached` at first use, so someone
    // iterating against a dev server got tRadio (which always re-read) on the
    // new host and tLib still on the old one, with nothing to explain it.
    const { resolveConfig } = await import("../../server/lib/marketplace/config");
    const g = globalThis as { GetConvar?: (n: string, d: string) => string };
    const original = g.GetConvar;
    try {
      let value = "http://localhost:8787";
      g.GetConvar = (name, fallback) =>
        name === MARKETPLACE_BASE_URL_CONVAR ? value : fallback;
      expect(resolveConfig().apiBase).toBe("http://localhost:8787/api/v1");
      value = "http://localhost:9999";
      expect(resolveConfig()).toMatchObject({
        baseUrl: "http://localhost:9999",
        apiBase: "http://localhost:9999/api/v1",
        apiBaseV2: "http://localhost:9999/api/v2/marketplace",
      });
    } finally {
      if (original) g.GetConvar = original;
      else delete g.GetConvar;
    }
  });
});

/**
 * tRadio is a sibling resource, not a dependency, so this block is skipped
 * wherever tLib is checked out on its own — the same shape as
 * tests/integration/versioncheck-provider.test.ts.
 */
const radio = new URL("../../../tRadio/", import.meta.url);
const withRadio = existsSync(new URL("client/cl_bridge.lua", radio)) ? describe : describe.skip;

withRadio("tRadio, the one copy that cannot import tLib's Lua", () => {
  const radioRead = (path: string) => readFileSync(new URL(path, radio), "utf8");

  test("its client default matches tLib's, exactly", () => {
    // tRadio's client VM cannot LoadResourceFile tLib's module: its own Lua VM
    // test fixtures stub LoadResourceFile to a fixed file table, so the call
    // would resolve to nil under test. The copy is deliberate and held here.
    const source = radioRead("client/cl_bridge.lua");
    const match = source.match(/local MARKETPLACE_DEFAULT_BASE_URL = '([^']+)'/);
    expect(match?.[1]).toBe(MARKETPLACE_DEFAULT_BASE_URL);
    // And it is the only copy in that file.
    expect(source.match(/https:\/\/timmygstudios\.com/g)?.length ?? 0).toBe(1);
  });

  test("its update check follows the convar instead of a hardcoded host", () => {
    // Same gap as tLib's versioncheck had: /api/products was a module-scope
    // literal, so update checks ignored a localhost override entirely.
    const source = radioRead("server/lib/updates.ts");
    expect(source).not.toContain("https://timmygstudios.com/api/products");
    // Assembled rather than written out: a literal `${...}` here is a template
    // placeholder to the linter, and escaping it would obscure what is asserted.
    const interp = (expr: string) => `$\{${expr}}`;
    expect(source).toContain(
      `${interp("marketplaceBaseUrl()")}/api/products/${interp("PRODUCT_SLUG")}/changelog`
    );
  });
});
