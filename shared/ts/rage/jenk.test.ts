import { describe, expect, test } from "bun:test";
import { HashDictionary, hashToString, joaat } from "./jenk";

describe("joaat", () => {
  // Reference values computed independently in Python, not from this implementation.
  // mp_m_freemode_01 -> 0x705E61F2 is the published GTA V model hash, which anchors
  // the whole table to something externally verifiable.
  test.each([
    ["", 0x00000000],
    ["a", 0xca2e9442],
    ["prop_cs_hand_radio", 0x8ae99900],
    ["cellphone@", 0xc07f261a],
    ["DiffuseSampler", 0xf1fe2b71],
    ["ztr540", 0xed022897],
    ["c_screen", 0x16e4713e],
    ["mp_m_freemode_01", 0x705e61f2],
  ])("hashes %p", (input, expected) => {
    expect(joaat(input)).toBe(expected);
  });

  test("folds case by default", () => {
    expect(joaat("DiffuseSampler")).toBe(joaat("diffusesampler"));
    expect(joaat("ZTR540")).toBe(joaat("ztr540"));
  });

  test("preserveCase changes the result for mixed-case input", () => {
    expect(joaat("DiffuseSampler", true)).not.toBe(joaat("diffusesampler", true));
  });

  test("always returns an unsigned 32-bit value", () => {
    for (const s of ["a", "prop_cs_hand_radio", "ÿþ", "x".repeat(200)]) {
      const h = joaat(s);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(0xffffffff);
      expect(Number.isInteger(h)).toBe(true);
    }
  });
});

describe("hashToString", () => {
  test("pads to eight uppercase hex digits", () => {
    expect(hashToString(0)).toBe("0x00000000");
    expect(hashToString(0x16e4713e)).toBe("0x16E4713E");
    expect(hashToString(0xca2e9442)).toBe("0xCA2E9442");
  });
});

describe("HashDictionary", () => {
  test("round-trips a seeded name", () => {
    const d = new HashDictionary();
    const h = d.add("prop_cs_hand_radio");
    expect(h).toBe(0x8ae99900);
    expect(d.get(h)).toBe("prop_cs_hand_radio");
    expect(d.label(h)).toBe("prop_cs_hand_radio");
  });

  test("looks up case-insensitively, since joaat folds case", () => {
    const d = new HashDictionary();
    d.add("DiffuseSampler");
    expect(d.get(joaat("diffusesampler"))).toBe("DiffuseSampler");
  });

  test("falls back to the hex form for an unknown hash", () => {
    const d = new HashDictionary();
    expect(d.get(0x12345678)).toBeNull();
    expect(d.label(0x12345678)).toBe("0x12345678");
  });

  test("addAll seeds many and reports size", () => {
    const d = new HashDictionary().addAll(["a", "b", "c"]);
    expect(d.size).toBe(3);
    expect(d.get(joaat("b"))).toBe("b");
  });
});
