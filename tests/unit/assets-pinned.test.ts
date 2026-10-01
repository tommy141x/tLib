import { describe, expect, test } from "bun:test";
import {
  assertSafeDest,
  formatBytes,
  markerVouchesFor,
  parseAsset,
  parseMarker,
  selectAssets,
  totalBytes,
} from "../../shared/ts/assets/pinned";

const asset = (over: Record<string, unknown> = {}) => ({
  id: "text",
  dest: "server/models/m.gguf",
  url: "https://huggingface.co/x/resolve/main/m.gguf",
  sha256: "a".repeat(64),
  bytes: 2_496_000_000,
  ...over,
});

describe("destination safety", () => {
  test("refuses a destination that escapes the resource", () => {
    // `dest` now ships in a lockfile to machines we do not control, so it is
    // untrusted input. Each of these would write outside the resource root.
    for (const bad of [
      "../../etc/passwd",
      "/etc/passwd",
      "C:/Windows/system32/x.dll",
      "server/../../x",
      "server\\..\\..\\x",
      "",
      " server/x ",
    ]) {
      expect(() => assertSafeDest(bad)).toThrow();
    }
  });

  test("accepts an ordinary nested destination", () => {
    expect(assertSafeDest("server/models/voices/en_US-amy-medium.onnx")).toBe(
      "server/models/voices/en_US-amy-medium.onnx"
    );
  });

  test("a backslash is rejected rather than normalised", () => {
    // Normalising would let `..\\..\\x` through a check that only knew about '/'.
    expect(() => assertSafeDest("server\\models\\m.gguf")).toThrow("must use '/'");
  });
});

describe("parsing", () => {
  test("accepts a well-formed entry and lowercases the digest", () => {
    const parsed = parseAsset(asset({ sha256: "A".repeat(64), capability: "text" }));
    expect(parsed.sha256).toBe("a".repeat(64));
    expect(parsed.capability).toBe("text");
  });

  test("refuses an entry with no usable size", () => {
    // Defaulting to 0 would read as "unknown" downstream and silently disable
    // the mid-stream size cap, which is the only thing bounding a bad response.
    for (const bytes of [undefined, 0, -1, 1.5, "2496000000"]) {
      expect(() => parseAsset(asset({ bytes }))).toThrow("bytes");
    }
  });

  test("refuses a malformed or absent digest", () => {
    for (const sha256 of [undefined, "", "abc", `${"a".repeat(63)}z`]) {
      expect(() => parseAsset(asset({ sha256 }))).toThrow("sha256");
    }
  });

  test("an unlabelled asset is unconditional, not invalid", () => {
    expect(parseAsset(asset()).capability).toBeUndefined();
  });
});

describe("capability selection", () => {
  const assets = [
    parseAsset(asset({ id: "text", capability: "text", bytes: 2_496_000_000 })),
    parseAsset(
      asset({ id: "stt", dest: "m/w.bin", capability: "transcription", bytes: 59_000_000 })
    ),
    parseAsset(asset({ id: "amy", dest: "m/a.onnx", capability: "speech", bytes: 63_000_000 })),
    parseAsset(asset({ id: "ryan", dest: "m/r.onnx", capability: "speech", bytes: 63_000_000 })),
    parseAsset(asset({ id: "always", dest: "m/x.json", bytes: 10 })),
  ];

  test("selects only the capabilities served locally", () => {
    const picked = selectAssets(assets, ["transcription"]).map((a) => a.id);
    expect(picked).toEqual(["stt", "always"]);
  });

  test("a capability with several files takes all of them", () => {
    expect(selectAssets(assets, ["speech"]).map((a) => a.id)).toEqual(["amy", "ryan", "always"]);
  });

  test("everything hosted still keeps unconditional assets", () => {
    expect(selectAssets(assets, []).map((a) => a.id)).toEqual(["always"]);
  });

  test("the fully-local case is the whole set", () => {
    expect(selectAssets(assets, ["text", "speech", "transcription"])).toHaveLength(5);
  });

  test("sending text to a hosted provider avoids the largest file", () => {
    // The point of the whole feature: 2.5 GB not transferred.
    const local = selectAssets(assets, ["speech", "transcription"]);
    expect(local.map((a) => a.id)).not.toContain("text");
    expect(totalBytes(local)).toBeLessThan(200_000_000);
  });
});

describe("markers", () => {
  const pin = parseAsset(asset({ bytes: 100 }));

  test("vouches only when digest, size and mtime all agree", () => {
    const stat = { size: 100, mtimeMs: 1_700_000_000_000 };
    const good = { sha256: "a".repeat(64), bytes: 100, mtimeMs: 1_700_000_000_000 };
    expect(markerVouchesFor(good, pin, stat)).toBe(true);
    expect(markerVouchesFor({ ...good, sha256: "b".repeat(64) }, pin, stat)).toBe(false);
    expect(markerVouchesFor({ ...good, mtimeMs: 1 }, pin, stat)).toBe(false);
    expect(markerVouchesFor(good, pin, { ...stat, size: 99 })).toBe(false);
    expect(markerVouchesFor(undefined, pin, stat)).toBe(false);
    expect(markerVouchesFor(good, pin, undefined)).toBe(false);
  });

  test("a file edited in place stops being vouched for", () => {
    // Size alone would not catch an edit that preserves it; mtime does.
    const marker = { sha256: "a".repeat(64), bytes: 100, mtimeMs: 1_000 };
    expect(markerVouchesFor(marker, pin, { size: 100, mtimeMs: 2_000 })).toBe(false);
  });

  test("a marker for a different pin never vouches", () => {
    // The pin changed under a file that did not: a lockfile bump must re-fetch.
    const marker = { sha256: "c".repeat(64), bytes: 100, mtimeMs: 1_000 };
    expect(markerVouchesFor(marker, pin, { size: 100, mtimeMs: 1_000 })).toBe(false);
  });

  test("unparseable marker files are treated as absent, not as errors", () => {
    expect(parseMarker("not json")).toBeUndefined();
    expect(parseMarker("{}")).toBeUndefined();
    expect(parseMarker('{"sha256":"x","bytes":1,"mtimeMs":2}')?.sha256).toBe("x");
  });
});

describe("formatting", () => {
  test("renders sizes an operator can read", () => {
    expect(formatBytes(512)).toBe("512 B");
    // One decimal below 10, whole units above it: "2.3 GB" is worth the digit,
    // "56.3 MB" is not, and a progress line is read at a glance.
    expect(formatBytes(2_496_000_000)).toBe("2.3 GB");
    expect(formatBytes(59_000_000)).toBe("56 MB");
    expect(formatBytes(9_000_000)).toBe("8.6 MB");
  });
});
