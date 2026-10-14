import { describe, expect, test } from "bun:test";
import {
  BC7_ANCHOR_2,
  BC7_ANCHOR_3_1,
  BC7_ANCHOR_3_2,
  BC7_MODES,
  BC7_PARTITION_2,
  BC7_PARTITION_3,
  bc7Anchor,
  bc7Subsets,
} from "./bc7-tables";

// These tables were transcribed by hand, and three entries were wrong in a way that
// produced correct-looking output for 99% of real blocks - the kind of error that hides
// until someone renders a specific texture. The invariants below catch exactly that
// class of mistake without needing a GPU: an anchor pixel must belong to the subset it
// anchors, and a partition must use every subset it claims.
//
// `scripts/verify-bc7.ts` is the stronger check - it compares against a real hardware
// decoder - but it needs Chrome and a corpus, so this file is the one that runs in CI.

describe("BC7 partition tables", () => {
  test("there are 64 two-subset and 64 three-subset partitions", () => {
    expect(BC7_PARTITION_2.length).toBe(64);
    expect(BC7_PARTITION_3.length).toBe(64);
  });

  test.each([...Array(64).keys()])("two-subset partition %i is well formed", (p) => {
    const row = BC7_PARTITION_2[p];
    expect(row.length).toBe(16);
    expect(row[0]).toBe(0); // pixel 0 anchors subset 0, so it must be in subset 0
    expect(new Set(row)).toEqual(new Set([0, 1]));
    // The anchor pixel must belong to the subset it anchors, or its dropped index bit
    // is dropped from the wrong pixel.
    expect(row[BC7_ANCHOR_2[p]]).toBe(1);
  });

  test.each([...Array(64).keys()])("three-subset partition %i is well formed", (p) => {
    const row = BC7_PARTITION_3[p];
    expect(row.length).toBe(16);
    expect(row[0]).toBe(0);
    expect(new Set(row)).toEqual(new Set([0, 1, 2]));
    expect(row[BC7_ANCHOR_3_1[p]]).toBe(1);
    expect(row[BC7_ANCHOR_3_2[p]]).toBe(2);
  });
});

describe("entries corrected against a GPU", () => {
  // Pinned by value: `verify-bc7.ts` probed ANGLE/SwiftShader for the hardware's own
  // partition layout and anchor positions, and these four entries disagreed with the
  // first transcription. Changing them back reintroduces ~1% wrong blocks in BC7 modes
  // 1, 2 and 3 - visible as scattered wrong-coloured 4x4 squares, not as an error.
  test("two-subset partition 18", () => {
    expect([...BC7_PARTITION_2[18]]).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 0]);
  });

  test("three-subset subset-2 anchors 59, 60 and 63", () => {
    expect(BC7_ANCHOR_3_2[59]).toBe(15);
    expect(BC7_ANCHOR_3_2[60]).toBe(3);
    expect(BC7_ANCHOR_3_2[63]).toBe(8);
  });
});

describe("mode table", () => {
  test("every mode's fields add up to exactly 128 bits", () => {
    for (let mode = 0; mode < 8; mode++) {
      const m = BC7_MODES[mode];
      const endpoints = m.subsets * 2;
      const bits =
        mode +
        1 + // the unary mode prefix
        m.partitionBits +
        m.rotationBits +
        m.indexSelectionBits +
        endpoints * m.colorBits * 3 +
        endpoints * m.alphaBits +
        endpoints * m.endpointPBits +
        m.subsets * m.sharedPBits +
        (16 * m.indexBits - m.subsets) +
        (m.indexBits2 > 0 ? 16 * m.indexBits2 - 1 : 0);
      expect({ mode, bits }).toEqual({ mode, bits: 128 });
    }
  });

  test("only modes 4 and 5 carry a second index set, and only 4 can swap them", () => {
    for (let mode = 0; mode < 8; mode++) {
      const m = BC7_MODES[mode];
      expect(m.indexBits2 > 0).toBe(mode === 4 || mode === 5);
      expect(m.rotationBits > 0).toBe(mode === 4 || mode === 5);
      expect(m.indexSelectionBits > 0).toBe(mode === 4);
    }
  });

  test("a mode never carries both per-endpoint and shared P-bits", () => {
    for (const m of BC7_MODES) {
      expect(m.endpointPBits > 0 && m.sharedPBits > 0).toBe(false);
    }
  });
});

describe("lookup helpers", () => {
  test("a single-subset mode puts every pixel in subset 0 and anchors at pixel 0", () => {
    expect([...bc7Subsets(1, 0)]).toEqual(new Array(16).fill(0));
    expect(bc7Anchor(1, 0, 0)).toBe(0);
  });

  test("subset 0 always anchors at pixel 0, whatever the partition", () => {
    for (let p = 0; p < 64; p++) {
      expect(bc7Anchor(2, p, 0)).toBe(0);
      expect(bc7Anchor(3, p, 0)).toBe(0);
    }
  });

  test("bc7Anchor returns the table entry for the other subsets", () => {
    expect(bc7Anchor(2, 18, 1)).toBe(BC7_ANCHOR_2[18]);
    expect(bc7Anchor(3, 63, 1)).toBe(BC7_ANCHOR_3_1[63]);
    expect(bc7Anchor(3, 63, 2)).toBe(BC7_ANCHOR_3_2[63]);
  });
});
