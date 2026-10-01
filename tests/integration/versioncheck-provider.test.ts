import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

// Execute the real sibling provider in an isolated scope. Only imports/exports
// are stripped; no global mocks or logger.wrapAll side effects leak to other suites.
//
// tRadio is a sibling resource, not a dependency: this suite is skipped wherever
// tLib is checked out on its own, which includes CI.
const root = new URL("../../../tRadio/server/lib/", import.meta.url);
const available = existsSync(new URL("updates.ts", root));
const describeWithRadio = available ? describe : describe.skip;
function load(file: string, names: string[], host: Record<string, unknown>) {
  const source = readFileSync(new URL(file, root), "utf8")
    .replace(/^import\b[^;]*;\r?\n/gm, "")
    .replace(/^export /gm, "");
  const js = new Bun.Transpiler({ loader: "ts" }).transformSync(source);
  return new Function(...Object.keys(host), `${js}\nreturn {${names.join(",")}};`)(
    ...Object.values(host)
  );
}
function fixture(current = "v1.0.0") {
  const urls: string[] = [];
  let response: unknown = { product: { currentVersion: "v1.1.0" }, updates: [] };
  let status = 200;
  let gate: Promise<void> = Promise.resolve();
  const api = load("updates.ts", ["checkForUpdates", "isNewerVersion", "getCachedUpdateResult"], {
    serverLogger: { debug() {}, warn() {}, error() {} },
    // `load` strips imports, so updates.ts's import of tLib's single base-URL
    // definition has to be handed in. Production reads the convar here.
    marketplaceBaseUrl: () => "https://timmygstudios.com",
    GetResourceMetadata: () => current,
    GetCurrentResourceName: () => "tRadio",
    fetch: async (url: string) => {
      urls.push(url);
      await gate;
      return new Response(JSON.stringify(response), { status });
    },
  });
  return {
    api,
    urls,
    setResponse(value: unknown, code = 200) {
      response = value;
      status = code;
    },
    setCurrent(value: string) {
      current = value;
    },
    setGate(value: Promise<void>) {
      gate = value;
    },
  };
}

describeWithRadio("tRadio update provider contract", () => {
  test("SemVer precedence agrees with Lua, including abbreviated tags", () => {
    const { api } = fixture();
    for (const [current, latest, newer] of [
      ["v6.3", "6.3.1", true],
      ["1.0.0-rc.2", "1.0.0-rc.10", true],
      ["1.0.0-rc.1", "1.0.0", true],
      ["1.0.0", "1.0.0-rc.1", false],
      ["1.0+42", "1.0.0+99", false],
      ["2.0", "1.9.9", false],
      ["unknown", "9.0.0", false],
      ["1.0.0", "release42", false],
    ])
      expect(api.isNewerVersion(latest, current)).toBe(newer);
  });

  test("newer version is independent of changelog count and results are cached", async () => {
    const f = fixture();
    const result = await f.api.checkForUpdates();
    expect(result).toMatchObject({ success: true, hasUpdate: true, latestVersion: "v1.1.0" });
    expect(f.urls[0]).toContain("since=v1.0.0&limit=10");
    expect(await f.api.checkForUpdates()).toBe(result);
    expect(f.urls).toHaveLength(1);
  });

  test("cache distinguishes release channel and installed version", async () => {
    const f = fixture();
    await f.api.checkForUpdates(false);
    await f.api.checkForUpdates(true);
    expect(f.urls).toHaveLength(2);
    expect(f.urls[1]).toContain("prerelease=1");
    f.setCurrent("v1.1.0");
    expect((await f.api.checkForUpdates(true)).hasUpdate).toBe(false);
    expect(f.urls).toHaveLength(3);
  });

  test("same-key requests share in-flight work; changed channel waits then refetches", async () => {
    const f = fixture();
    let release!: () => void;
    f.setGate(
      new Promise<void>((resolve) => {
        release = resolve;
      })
    );
    const first = f.api.checkForUpdates(false);
    expect(f.api.checkForUpdates(false)).toBe(first);
    const second = f.api.checkForUpdates(true);
    expect(f.urls).toHaveLength(1);
    release();
    await Promise.all([first, second]);
    expect(f.urls).toHaveLength(2);
    expect(f.urls[1]).toContain("prerelease=1");
  });

  test("unpublished, malformed, invalid versions and HTTP failures are not success", async () => {
    for (const body of [
      null,
      {},
      { product: { currentVersion: "" }, updates: [] },
      { product: { currentVersion: "release42" }, updates: [] },
      { product: { currentVersion: "v2.0" }, updates: {} },
    ]) {
      const f = fixture();
      f.setResponse(body);
      expect((await f.api.checkForUpdates()).success).toBe(false);
      await f.api.checkForUpdates();
      expect(f.urls).toHaveLength(1); // negative cache
    }
    const f = fixture();
    f.setResponse({}, 429);
    expect((await f.api.checkForUpdates()).error).toContain("Rate limited");
  });

  test("oversized HTTP bodies fail within the existing one-megabyte cap", async () => {
    const f = fixture();
    f.setResponse({
      product: { currentVersion: "v2.0" },
      updates: [],
      padding: "x".repeat(1024 * 1024),
    });
    expect((await f.api.checkForUpdates()).error).toContain("exceeded 1MB");
  });

  test("startup bridge preserves real version and provider failure status", () => {
    const output: any[] = [];
    const { emitVersionResult } = load("startup.ts", ["emitVersionResult"], {
      emit: (event: string, data: unknown) => output.push({ event, data }),
    });
    emitVersionResult(null);
    emitVersionResult({ success: false, error: "No published version available" });
    emitVersionResult({ success: true, hasUpdate: false, latestVersion: "v0.9" });
    expect(output.map((entry) => entry.data)).toEqual([
      { status: "Update check not run" },
      { status: "No published version available" },
      { version: "v0.9", changelog: "", url: "" },
    ]);
  });
});
