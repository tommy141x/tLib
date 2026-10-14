/**
 * The seams between the four places this feature lives, each of which is a
 * string or a shape that no type can span.
 *
 * WHY A FILE-READING TEST AND NOT A LUA SUITE. The event names exist twice in
 * Lua — once in `shared/imports/telemetry/shared.lua`, which runs in CONSUMER
 * VMs, and once in `server/sv_telemetry.lua`, which runs in tLib's own. There is
 * no VM in which both are loaded, so neither can import the other and no Lua
 * suite can compare them. `imports.lua` carries its own copy of `parseVer` for
 * exactly this reason. fengari also ships no `io`, so a Lua suite could not read
 * the files either; node can.
 *
 * The failure this closes is total and silent: rename the event on one side and
 * every client's batch is sent to an event nobody is listening for. No error, no
 * log, an empty dashboard.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { stampContext } from "../../server/lib/telemetry/index";
import { DIAG_NUI_CALLBACK } from "../../shared/ts/telemetry/collect";
import { DIAG_EVENTS, DIMENSION_ID_PATTERN } from "../../shared/ts/telemetry/payload";

const root = resolve(import.meta.dir, "../..");
const read = (rel: string) => readFileSync(resolve(root, rel), "utf8");

const consumerLua = read("shared/imports/telemetry/shared.lua");
const serverLua = read("server/sv_telemetry.lua");
const manifest = read("fxmanifest.lua");

/** Pull `NAME = 'value'` out of a Lua file. */
function luaString(source: string, name: string): string | null {
  const m = new RegExp(`${name}\\s*=\\s*'([^']*)'`).exec(source);
  return m ? (m[1] as string) : null;
}

describe("the event names exist twice in Lua and must agree", () => {
  const pairs: Array<[string, string]> = [
    ["Telemetry.INGEST_EVENT", "INGEST_EVENT"],
    ["Telemetry.CONSENT_EVENT", "CONSENT_EVENT"],
    ["Telemetry.CONSENT_REQUEST_EVENT", "CONSENT_REQUEST_EVENT"],
  ];

  for (const [consumerName, serverName] of pairs) {
    test(`${serverName} is the same string on both sides`, () => {
      const a = luaString(consumerLua, consumerName.replace(".", "\\."));
      const b = luaString(serverLua, `local ${serverName}`);
      expect(a).toBeTruthy();
      expect(b).toBeTruthy();
      expect(a).toBe(b);
    });
  }

  test("the convar name is the same in Lua and in TypeScript", () => {
    // Three copies: the consumer module, the bundle's consent resolver, and the
    // operator-facing fallback in the status command's export.
    expect(luaString(consumerLua, "Telemetry\\.CONVAR")).toBe("tlib_telemetry");
    expect(read("server/lib/telemetry/consent.ts")).toContain(
      'export const TELEMETRY_CONVAR = "tlib_telemetry"'
    );
    expect(serverLua).toContain("tlib_telemetry");
  });

  test("the NUI callback name is the same in TypeScript and in Lua", () => {
    // The collector POSTs to this name and the consumer's Lua REGISTERS it.
    // A mismatch means every flush 404s inside the NUI, which `fetchNui`
    // swallows by contract — so the whole feed would go silent with no error.
    expect(luaString(consumerLua, "Telemetry\\.NUI_CALLBACK")).toBe(DIAG_NUI_CALLBACK);
  });

  test("the consent NUI message name is the same on both sides", () => {
    // Lua sends it with SendNUIMessage; collect.ts subscribes with onNuiEvent.
    expect(consumerLua).toContain("'tlib:diag:consent'");
    expect(read("shared/ts/telemetry/collect.ts")).toContain('"tlib:diag:consent"');
  });
});

describe("the event names exist twice more — in Lua and in TypeScript", () => {
  /**
   * tWeb refuses an undeclared event name PER EVENT, counts it on its own
   * dashboard, and says nothing to us. So a rename on one side of this estate is
   * a feed that quietly carries four events instead of five, and the only
   * symptom is one empty chart among four populated ones.
   */
  const luaNames: Array<[string, string]> = [
    ["Telemetry.EVENT_ERROR", "tlib.error_reported"],
    ["Telemetry.EVENT_WARNING", "tlib.warning_reported"],
    ["Telemetry.EVENT_CRASH", "tlib.crash_reported"],
    ["Telemetry.EVENT_SLOW", "tlib.slow_operation"],
    ["Telemetry.EVENT_ENVIRONMENT", "tlib.environment_reported"],
  ];

  for (const [name, expected] of luaNames) {
    test(`${name} is ${expected} in Lua and is declared in TypeScript`, () => {
      expect(luaString(consumerLua, name.replace(".", String.raw`\.`))).toBe(expected);
      expect(DIAG_EVENTS as readonly string[]).toContain(expected);
    });
  }

  test("neither side has an event the other does not", () => {
    const inLua = luaNames.map(([, v]) => v).sort();
    expect([...DIAG_EVENTS].sort()).toEqual(inLua);
  });
});

describe("the manifest", () => {
  test("sv_telemetry.lua is actually loaded", () => {
    // A net-event handler in a file no manifest names is a handler that does not
    // exist, and the symptom is an empty dashboard rather than an error.
    expect(manifest).toContain("server/sv_telemetry.lua");
  });

  test("the release allowlist ships it", () => {
    // `scripts/prod.ts`'s include list is written file by file; a missing entry
    // means the release is missing a server script that the manifest names.
    expect(read("scripts/prod.ts")).toContain('"server/sv_telemetry.lua"');
  });

  test("shared/imports is shipped as a tree, so the module needs no new entry", () => {
    expect(manifest).toContain("shared/imports/**/*.lua");
  });
});

describe("stampContext", () => {
  const event = {
    event: "tlib.error_reported",
    at: 1,
    dimensions: { stackHash: "00000001" },
    measures: {},
  };

  test("the common dimensions are folded onto every event", () => {
    const out = stampContext([event, event], {
      resource: "tRadio",
      resourceVersion: "1.4.2",
      surface: "nui",
    }) as Array<{ dimensions: Record<string, string> }>;
    expect(out).toHaveLength(2);
    for (const e of out) {
      expect(e.dimensions.resource).toBe("tradio");
      expect(e.dimensions.resourceVersion).toBe("1.4.2");
      // `surface`, not `senderKind`. `senderKind` is which process posted and
      // is always "server"; `surface` is where the fault happened.
      expect(e.dimensions.surface).toBe("nui");
      // And the event's own dimensions survive.
      expect(e.dimensions.stackHash).toBe("00000001");
    }
  });

  test("⚠️ an event cannot overwrite the dimensions a figure is grouped by", () => {
    // Not a bug so much as a way to attribute a fault to the wrong product.
    const out = stampContext([{ ...event, dimensions: { resource: "somebody-else" } }], {
      resource: "tRadio",
    }) as Array<{ dimensions: Record<string, string> }>;
    expect(out[0]?.dimensions.resource).toBe("tradio");
  });

  test("⚠️ a `+` in the version is MAPPED, not refused", () => {
    // `+` is not in the charset, so `1.14.2+ab12cd34` is refused at the ingest —
    // at 15 characters, nothing to do with the 32-character cap, which is
    // exactly how it would be misdiagnosed.
    const out = stampContext([event], { resourceVersion: "1.14.2-rc.3+ab12cd34" }) as Array<{
      dimensions: Record<string, string>;
    }>;
    expect(out[0]?.dimensions.resourceVersion).toBe("1.14.2-rc.3.ab12cd34");
  });

  test("the context is slugged on arrival rather than trusted", () => {
    // It is CLIENT-SUPPLIED. A value outside the charset is refused by the
    // ingest with a counted refusal that is invisible from this side.
    const out = stampContext([event], { resource: 'tRadio "x" /y' }) as Array<{
      dimensions: Record<string, string>;
    }>;
    expect(DIMENSION_ID_PATTERN.test(out[0]?.dimensions.resource ?? "")).toBe(true);
  });

  test("a context field that slugs to nothing is OMITTED, not empty", () => {
    const out = stampContext([event], { resource: "!!!", surface: "nui" }) as Array<{
      dimensions: Record<string, string>;
    }>;
    expect("resource" in (out[0]?.dimensions ?? {})).toBe(false);
    expect(out[0]?.dimensions.surface).toBe("nui");
  });

  test("a non-array or absent context is survivable", () => {
    expect(stampContext(undefined, undefined)).toEqual([]);
    expect(stampContext([event], undefined)).toHaveLength(1);
    expect(stampContext([event], "nope")).toHaveLength(1);
  });
});
