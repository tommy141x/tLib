import { describe, expect, test } from "bun:test";
import { EDGE_GAIN, falloffDbAt, falloffGainAt, spatialFalloff } from "./falloff";

/**
 * The curve, asserted rather than described.
 *
 * The defect this shape replaces is a PLATEAU: Web Audio's distance models clamp
 * at maxDistance instead of silencing, so a panner whose maxDistance is shorter
 * than the transport's reach plays one constant level across the whole outer
 * band. These tests are the measurement that says it did not come back.
 */

/** The clamping "inverse" curve, kept as the before-shape to compare against. */
function inverseGain(ref: number, rolloff: number, max: number, d: number): number {
  const clamped = Math.min(Math.max(d, ref), max);
  return ref / (ref + rolloff * (clamped - ref));
}

describe("the solved exponential curve", () => {
  test("gain at the configured range is EDGE_GAIN exactly, for any range", () => {
    for (const range of [12, 25, 40, 60, 140]) {
      const f = spatialFalloff(range, 1.5);
      expect(falloffGainAt(f, range)).toBeCloseTo(EDGE_GAIN, 9);
      expect(falloffDbAt(f, range)).toBeCloseTo(-50.46, 1);
    }
  });

  test("inside refDistance an emitter is at full gain", () => {
    const f = spatialFalloff(25, 1.5);
    expect(falloffGainAt(f, 0)).toBe(1);
    expect(falloffGainAt(f, 1.5)).toBe(1);
  });

  test("it is monotonic — every extra metre is quieter, out to the edge", () => {
    for (const range of [12, 25, 60]) {
      const f = spatialFalloff(range, 1.5);
      let previous = Number.POSITIVE_INFINITY;
      for (let d = f.refDistance; d <= f.maxDistance; d += 0.25) {
        const g = falloffGainAt(f, d);
        expect(g).toBeLessThan(previous);
        previous = g;
      }
    }
  });

  test("there is no plateau: the old curve's 10 m and 35 m levels were identical", () => {
    const old = (d: number) => inverseGain(1.5, 2.5, 10, d);
    expect(20 * Math.log10(old(10))).toBeCloseTo(20 * Math.log10(old(35)), 6);

    const f = spatialFalloff(35, 1.5);
    expect(falloffDbAt(f, 10) - falloffDbAt(f, 35)).toBeGreaterThan(15);
  });

  test("a wider range stretches the same curve instead of re-adding a plateau", () => {
    const narrow = spatialFalloff(25, 1.5);
    const wide = spatialFalloff(60, 1.5);
    // 25 m used to be the edge; at the wider setting it is merely distant.
    expect(falloffDbAt(narrow, 25)).toBeCloseTo(-50.46, 1);
    expect(falloffDbAt(wide, 25)).toBeGreaterThan(-40);
    // And the near field is not sacrificed to reach the further edge.
    expect(falloffDbAt(wide, 5)).toBeGreaterThan(falloffDbAt(narrow, 5));
  });

  test("a degenerate range cannot invert the curve into getting LOUDER with distance", () => {
    for (const range of [0, 1, -8, Number.NaN, Number.POSITIVE_INFINITY]) {
      const f = spatialFalloff(range, 1.5);
      expect(f.rolloff).toBeGreaterThan(0);
      expect(Number.isFinite(f.rolloff)).toBe(true);
      expect(f.maxDistance).toBeGreaterThan(f.refDistance);
      expect(falloffGainAt(f, f.maxDistance)).toBeLessThan(falloffGainAt(f, f.refDistance));
    }
  });

  test("a non-finite refDistance falls back rather than producing NaN", () => {
    const f = spatialFalloff(25, Number.NaN);
    expect(Number.isFinite(f.rolloff)).toBe(true);
    expect(Number.isFinite(falloffGainAt(f, 12))).toBe(true);
  });

  test("the model is exponential and maxDistance is pinned to the range", () => {
    const f = spatialFalloff(25, 1.5);
    expect(f.distanceModel).toBe("exponential");
    expect(f.maxDistance).toBe(25);
  });
});
