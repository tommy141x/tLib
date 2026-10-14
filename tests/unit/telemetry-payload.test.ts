/**
 * The wire contract — the half of this feature that cannot be fixed later.
 *
 * EVERY FAILURE THIS SUITE GUARDS IS ONE-SIDED AND SILENT. The ingest refuses
 * a bad dimension loudly, on tWeb's own dashboard, with a counted
 * `unsafe_dimension` outcome — and says nothing to the emitter. **A refused
 * event is a lost event.** So a regression here does not break anything
 * visible: diagnostics simply stop arriving, and the first sign is an empty
 * chart.
 *
 * Four things are permanent and one is cross-language:
 *
 *   • **The charset.** `^[A-Za-z0-9._:-]+$`. No space, no slash, no quote, no
 * `+`, and no `_` — see `DIMENSION_ID_PATTERN` on the one place that
 *     contradicts.
 *   • **The enums.** A value outside one refuses the event.
 *   • **The player-identifier hole.** The charset admits
 *     `steam:110000100000000` verbatim, which is how an identifier reaches a
 *     store that cannot delete a row.
 *   • **The stack hash.** A grouping key computed in two languages, with no
 * single source able to span them. `fnv1a("")` and `fnv1a("a")` are the
 *     published FNV-1a 32-bit vectors (`0x811c9dc5`, `0xe40c292c`), so this is
 *     an oracle and not a snapshot of whatever the code happened to do, and
 *     `tests/lua/telemetry-core.lua` pins the SAME literals against Lua.
 *   • **The GPU normalisation**, whose input is MEASURED — the two strings below
 *     are verbatim what Chromium 103 answered in
 *     `scripts/probe-nui-hardware.ts`.
 */

import { describe, expect, test } from "bun:test";
import {
  crashKindFor,
  DIAG_CRASH_KINDS,
  DIAG_EVENTS,
  DIAG_GPU_VENDORS,
  DIAG_OS,
  DIAG_RAM_BUCKETS,
  DIMENSION_CAPS,
  DIMENSION_ID_PATTERN,
  FINGERPRINT_FRAMES,
  fnv1a,
  gpuModelFor,
  gpuVendorFor,
  MAX_EVENTS_PER_BATCH,
  MAX_QUEUED_EVENTS,
  normaliseStack,
  osFor,
  pathSlug,
  ramBucketFor,
  slug,
  stackHash,
  unsafeDimensions,
  versionSlug,
} from "../../shared/ts/telemetry/payload";

const WINDOWS_HOME = `C:${String.fromCharCode(92)}Users${String.fromCharCode(92)}Tommy${String.fromCharCode(92)}Documents`;

describe("the event names are tWeb's", () => {
  test("all five, exactly", () => {
    // An undeclared name is refused PER EVENT and counted on their dashboard.
    expect([...DIAG_EVENTS]).toEqual([
      "tlib.error_reported",
      "tlib.warning_reported",
      "tlib.crash_reported",
      "tlib.slow_operation",
      "tlib.environment_reported",
    ]);
  });
});

describe("fnv1a — the cross-language pin", () => {
  test("matches the published FNV-1a 32-bit test vectors", () => {
    expect(fnv1a("")).toBe("811c9dc5");
    expect(fnv1a("a")).toBe("e40c292c");
  });

  test("the literals tests/lua/telemetry-core.lua pins", () => {
    expect(fnv1a("tlib")).toBe("a3620e9a");
    expect(fnv1a("TypeError|at x (nui/assets/index.js:1)")).toBe("9e6c6ac2");
    expect(fnv1a("warning:layout-missing")).toBe("d581e878");
    expect(fnv1a("crash:heap-near-limit")).toBe("f28ad9db");
  });

  test("⚠️ it is LOWERCASE hex, which is contract and not style", () => {
    /**
     * tWeb requires `stackHash` to be lowercase hex: a 32-character MIXED-CASE
     * token is refused by its own scrubber as a credential shape — correctly. So
     * an upper-cased hash would be refused and the event lost, for a reason that
     * reads as nothing to do with hashing at all.
     */
    for (const input of ["", "a", "ffffffff", "deadbeef", "x".repeat(99)]) {
      const h = fnv1a(input);
      expect(h).toBe(h.toLowerCase());
      expect(h).toMatch(/^[0-9a-f]{8}$/);
      expect(DIMENSION_ID_PATTERN.test(h)).toBe(true);
    }
  });
});

describe("stackHash — the same fault on two machines groups together", () => {
  const stackA =
    "TypeError: x is null\n" +
    "    at render (https://cfx-nui-tRadio/assets/index-9f2a1b.js:412:17)\n" +
    "    at mount (https://cfx-nui-tRadio/assets/index-9f2a1b.js:51:9)";
  // Same bug, a different player, a different RELEASE: a new content hash, a
  // different column after minification, and the resource under its own origin.
  const stackB =
    "TypeError: x is null\n" +
    "    at render (https://cfx-nui-tradio/assets/index-c4d5e6.js:412:30)\n" +
    "    at mount (https://cfx-nui-tradio/assets/index-c4d5e6.js:51:2)";

  test("a new bundle hash and a moved column do not change the group", () => {
    expect(stackHash("TypeError", stackA)).toBe(stackHash("TypeError", stackB));
  });

  test("a different error name is a different group", () => {
    expect(stackHash("TypeError", stackA)).not.toBe(stackHash("RangeError", stackA));
  });

  test("a different call path is a different group", () => {
    expect(stackHash("TypeError", stackA)).not.toBe(
      stackHash("TypeError", stackA.replace("at render", "at tick"))
    );
  });

  test("the MESSAGE does not change the group", () => {
    // The first line of a V8 stack is `Name: message`, and a message
    // interpolates an id or a count far more often than not. Hashing it would
    // make every occurrence its own group of one.
    expect(stackHash("TypeError", stackA)).toBe(
      stackHash("TypeError", stackA.replace("x is null", "y is null (attempt 41)"))
    );
  });

  test("frames beyond the cap do not change the group", () => {
    expect(FINGERPRINT_FRAMES).toBe(3);
    const three = `${stackA}\n    at menu (https://cfx-nui-tRadio/assets/index-9f2a1b.js:900:1)`;
    const four = `${three}\n    at boot (https://cfx-nui-tRadio/assets/index-9f2a1b.js:7:1)`;
    expect(stackHash("TypeError", three)).not.toBe(stackHash("TypeError", stackA));
    expect(stackHash("TypeError", three)).toBe(stackHash("TypeError", four));
  });

  test("a throw with no stack still hashes, on the name alone", () => {
    expect(stackHash("ThrownNull")).toHaveLength(8);
    expect(stackHash("ThrownNull")).toBe(stackHash("ThrownNull", ""));
  });

  test("it fits the cap", () => {
    expect(stackHash("TypeError", stackA).length).toBeLessThanOrEqual(DIMENSION_CAPS.stackHash);
  });
});

describe("normaliseStack", () => {
  test("drops the nui origin, the content hash and the column", () => {
    expect(
      normaliseStack("Error: x\n    at f (https://cfx-nui-tRadio/assets/index-9f2a1b.js:412:17)")
    ).toBe("Error: x\n    at f (nui/assets/index.js:412)");
  });

  test("collapses a Windows absolute path, which a Lua or Node frame carries", () => {
    expect(normaliseStack(`at load (${WINDOWS_HOME}:9:1)`)).toContain("<abs>");
  });
});

describe("slug — nothing illegal reaches a dimension", () => {
  test("normalises a version and a resource name", () => {
    expect(slug("tRadio 1.4.2")).toBe("tradio-1.4.2");
  });

  test("answers '' rather than a placeholder when nothing survives", () => {
    // A placeholder would be a category every later query counts as if it meant
    // something. An empty value is omitted, and an absent dimension is a state
    // the ingest handles by design — an older build keeps working.
    for (const input of ["!!!", "   ", "---", "..:.."]) expect(slug(input)).toBe("");
    expect(slug(undefined)).toBe("");
    expect(slug(42)).toBe("");
  });

  test("every output is a legal dimension value", () => {
    const nasty = [
      "Cannot read properties of null (reading 'replaceChild')",
      'POST /admin/api?x="y"',
      WINDOWS_HOME,
      "a@b.invalid",
      "   leading and trailing   ",
      "tab\there\nnewline",
      "日本語",
      "1.14.2-rc.3+ab12cd34",
    ];
    for (const input of nasty) {
      const out = slug(input);
      if (out !== "") expect(DIMENSION_ID_PATTERN.test(out)).toBe(true);
    }
  });

  test("is bounded, and a truncation cannot land on a separator", () => {
    const out = slug("a".repeat(40) + "-".repeat(40), 45);
    expect(out.length).toBeLessThanOrEqual(45);
    expect(DIMENSION_ID_PATTERN.test(out)).toBe(true);
    expect(out.endsWith("-")).toBe(false);
  });
});

/**
 * THE MEASURED HOLE, AND THE MOST IMPORTANT BLOCK IN THIS FILE
 *
 * The ingest's charset admits every FiveM player identifier VERBATIM, because
 * `:` is in it for namespaced ids and a FiveM identifier is exactly that shape.
 * tWeb measured it and now refuses those shapes, so on this side the symptom
 * flips from "we leaked an identifier into a store that cannot delete a row" to
 * "telemetry we thought we were collecting silently vanishes". Both are bad and
 * both are fixed in one place: `slug`.
 *
 * `errorCode` ON A GAME CLIENT IS THE LIKELIEST FIELD IN THE TAXONOMY TO
 * RECEIVE ONE. "no permission for steam:110000100000000" is the natural thing
 * for an access gate to put in an error.
 */
describe("slug — player identifiers never reach a dimension", () => {
  const identifiers: Array<[string, string[]]> = [
    ["steam", ["110000100000000"]],
    ["license", ["4d1f8a9c0b7e6d5c4b3a2918f7e6d5c4b3a29180"]],
    ["license2", ["4d1f8a9c0b7e6d5c4b3a2918f7e6d5c4b3a29180"]],
    ["discord", ["1345874347281088565"]],
    ["ip", ["192.168.8.141"]],
  ];

  for (const [ns, leaks] of identifiers) {
    test(`${ns}: is blanked, inside a message, in a dimension`, () => {
      const out = slug(`no permission for ${ns}:${leaks[0]}`, DIMENSION_CAPS.errorCode);
      for (const leak of leaks) expect(out).not.toContain(leak);
      expect(DIMENSION_ID_PATTERN.test(out)).toBe(true);
    });
  }

  test("a bare Steam id or Discord snowflake with no namespace is blanked", () => {
    expect(slug("player 110000100000000 refused")).not.toContain("110000100000000");
    expect(slug("author 1345874347281088565")).not.toContain("1345874347281088565");
  });

  test("a bare IPv4 is blanked, in every separator form a slugger produces", () => {
    for (const form of ["192.168.8.141", "192-168-8-141", "192_168_8_141"]) {
      expect(slug(`connect failed ${form}`)).not.toContain("141");
    }
  });

  test("⚠️ a real Windows home path loses the account name", () => {
    // Measured: with `\` missing from the separator class this slugged to
    // `c:-users-tommy-documents` — the account name intact, in a dimension, in
    // a store with no DELETE.
    expect(slug(WINDOWS_HOME)).not.toContain("tommy");
  });

  test("⚠️ and so does the residue of naive separator mapping", () => {
    // `C:Users.Tommy.Documents` is what a slugger leaves behind when the
    // home-path rule has already failed to match because the slashes were gone.
    expect(slug("C:Users.Tommy.Documents")).not.toContain("tommy");
  });

  test("a Linux home path loses the account name", () => {
    expect(slug("/home/someplayer/txData/resources")).not.toContain("someplayer");
  });

  test("the other direction: a 13-digit timestamp is NOT an identifier", () => {
    // A rule that ate those would redact every duration and counter in every
    // message, which is the readability half of the same trade the credential
    // list makes.
    expect(slug("took 1760000000000 ms")).toContain("1760000000000");
  });
});

describe("versionSlug — the `+` that is refused at 21 characters", () => {
  test("semver build metadata is MAPPED, not truncated", () => {
    // `+` is not in the charset, so `1.14.2-rc.3+ab12cd34` is refused —
    // nothing to do with any length cap, which is exactly how it would be
    // misdiagnosed as "the version is too long".
    expect(versionSlug("1.14.2-rc.3+ab12cd34")).toBe("1.14.2-rc.3.ab12cd34");
    expect(DIMENSION_ID_PATTERN.test(versionSlug("1.14.2-rc.3+ab12cd34"))).toBe(true);
  });

  test("a plain version is unchanged and fits the cap", () => {
    expect(versionSlug("1.0.0")).toBe("1.0.0");
    expect(versionSlug("v2.3.4-beta.1").length).toBeLessThanOrEqual(DIMENSION_CAPS.resourceVersion);
  });
});

describe("pathSlug — the `/` that is refused", () => {
  test("separators become dots and the line survives", () => {
    expect(pathSlug("client/cl_radio.lua:218")).toBe("client.cl_radio.lua:218");
  });

  test("a backslash is mapped too", () => {
    expect(pathSlug(`server${String.fromCharCode(92)}sv_main.lua:9`)).toBe("server.sv_main.lua:9");
  });

  test("it respects the location cap", () => {
    expect(pathSlug("a/".repeat(200)).length).toBeLessThanOrEqual(DIMENSION_CAPS.location);
  });
});

describe("the enum mappings", () => {
  test("every crash verdict maps into tWeb's five kinds", () => {
    for (const verdict of [
      "heap-near-limit",
      "heap-growth",
      "main-thread-block",
      "dom-growth",
      "inconclusive",
      "no-samples",
      "something-new",
    ]) {
      expect(DIAG_CRASH_KINDS).toContain(crashKindFor(verdict));
    }
  });

  test("the two conclusive shapes map to their real kinds", () => {
    expect(crashKindFor("heap-near-limit")).toBe("out_of_memory");
    expect(crashKindFor("main-thread-block")).toBe("script_timeout");
  });

  test("⚠️ a leak that had not yet killed anything is `unknown`, not out_of_memory", () => {
    // A heap that grew 300 MB without reaching the limit is not an OOM, and
    // calling it one would put a confident wrong category on a dashboard.
    expect(crashKindFor("heap-growth")).toBe("unknown");
    expect(crashKindFor("dom-growth")).toBe("unknown");
  });

  test("os", () => {
    expect(osFor("Win32")).toBe("windows");
    expect(osFor("Linux x86_64")).toBe("linux");
    expect(osFor("MacIntel")).toBe("macos");
    expect(osFor(undefined)).toBe("unknown");
    for (const p of ["Win32", "Linux", "MacIntel", "", undefined, 42]) {
      expect(DIAG_OS).toContain(osFor(p));
    }
  });

  /**
   * ONLY TWO OF THE FIVE RAM BUCKETS ARE REACHABLE, AND THAT IS MEASURED.
   * The Device Memory API clamps its answer to 0.25–8 GiB in powers of two;
   * `scripts/probe-nui-hardware.ts` read `8` on a 32 GB machine. So `8` carries
   * NO information about which of `8_to_16`, `16_to_32`, `32_to_64` or `64_plus`
   * is true, and answering one of them would be a wrong value on an axis
   * somebody would then filter a dashboard by.
   */
  test("under 8 GB is reported, because that is the actionable case", () => {
    for (const gb of [0.25, 0.5, 1, 2, 4]) expect(ramBucketFor(gb)).toBe("under_8");
  });

  test("⚠️ the clamp value 8 is `unknown`, NOT `8_to_16`", () => {
    expect(ramBucketFor(8)).toBe("unknown");
  });

  test("an absent reading is unknown, and every answer is in the enum", () => {
    for (const v of [undefined, null, Number.NaN, -1, 0, 8, 64]) {
      expect(DIAG_RAM_BUCKETS).toContain(ramBucketFor(v));
    }
    expect(ramBucketFor(undefined)).toBe("unknown");
  });
});

describe("the GPU split — measured inputs from Chromium 103", () => {
  const REAL = "ANGLE (NVIDIA, NVIDIA GeForce RTX 5070 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)";
  const HEADLESS =
    "ANGLE (Google, Vulkan 1.2.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)";

  test("a real adapter yields a vendor enum and a model slug", () => {
    expect(gpuVendorFor(REAL)).toBe("nvidia");
    expect(gpuModelFor(REAL)).toBe("geforce-rtx-5070-ti");
  });

  test("⚠️ the model uses `-` and not `_`", () => {
    /**
     * tWeb's worked example is `geforce_rtx_4080`, and `_` IS NOT IN THE CHARSET
     * it also specifies. The two disagree; `-` is legal under both readings, and
     * the cost of guessing wrong is a refused event nobody hears about.
     */
    expect(gpuModelFor(REAL)).not.toContain("_");
    expect(DIMENSION_ID_PATTERN.test(gpuModelFor(REAL))).toBe(true);
  });

  test("the vendor is not repeated in the model", () => {
    // It has its own dimension; repeating it spends 6 of 48 characters saying
    // what the row already says. Measured: the real string is `NVIDIA, NVIDIA …`.
    expect(gpuModelFor(REAL).startsWith("nvidia")).toBe(false);
  });

  test("headless SwiftShader is legal, bounded, and not claimed as a vendor", () => {
    const model = gpuModelFor(HEADLESS);
    expect(DIMENSION_ID_PATTERN.test(model)).toBe(true);
    expect(model.length).toBeLessThanOrEqual(DIMENSION_CAPS.gpuModel);
    // A software renderer is not a GPU vendor.
    expect(gpuVendorFor(HEADLESS)).toBe("other");
  });

  test("every vendor answer is in the enum", () => {
    for (const s of [
      REAL,
      HEADLESS,
      "AMD Radeon RX 7900",
      "Intel Iris Xe",
      "Apple M2 Pro",
      "",
      undefined,
    ]) {
      expect(DIAG_GPU_VENDORS).toContain(gpuVendorFor(s));
    }
    expect(gpuVendorFor("AMD Radeon RX 7900")).toBe("amd");
    expect(gpuVendorFor("Intel(R) Iris(R) Xe")).toBe("intel");
    expect(gpuVendorFor("Apple M2 Pro")).toBe("apple");
  });

  test("an absent GPU is '' and 'unknown', not a fabricated category", () => {
    expect(gpuModelFor(undefined)).toBe("");
    expect(gpuVendorFor(undefined)).toBe("unknown");
  });
});

describe("unsafeDimensions — refuse locally rather than remotely", () => {
  test("names the offending keys", () => {
    expect(
      unsafeDimensions({ ok: "tradio", bad: "has a space", worse: 'has "quotes"' }).sort()
    ).toEqual(["bad", "worse"]);
  });

  test("an EMPTY value is not unsafe — it is omitted", () => {
    expect(unsafeDimensions({ gpuModel: "" })).toEqual([]);
  });

  test("a message or a stack can never be a dimension", () => {
    // The single most important consequence of the charset, and the reason
    // `tlib.error_reported` carries a TOP-LEVEL `stack` instead.
    expect(unsafeDimensions({ message: "Cannot read properties of null (reading 'x')" })).toEqual([
      "message",
    ]);
  });

  test("a `+` in a version is caught before it is sent", () => {
    expect(unsafeDimensions({ resourceVersion: "1.14.2+ab12cd34" })).toEqual(["resourceVersion"]);
  });
});

describe("caps", () => {
  test("the batch cap is Analytics Engine's own per-invocation ceiling", () => {
    expect(MAX_EVENTS_PER_BATCH).toBe(250);
  });

  test("the queue is bounded and is a small multiple of one batch", () => {
    expect(MAX_QUEUED_EVENTS).toBe(MAX_EVENTS_PER_BATCH * 2);
  });

  test("the per-dimension caps are tWeb's numbers", () => {
    expect(DIMENSION_CAPS).toEqual({
      resource: 32,
      resourceVersion: 32,
      installId: 32,
      errorCode: 64,
      warningCode: 64,
      operation: 64,
      location: 160,
      stackHash: 64,
      gpuModel: 48,
    });
  });
});
