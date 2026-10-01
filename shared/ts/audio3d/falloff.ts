/**
 * The distance curve a world-audible device is heard over.
 *
 * This is one shared copy of a curve that was solved — not tuned — in tRadio
 * (`shared/ui/src/audio/audio3d.ts`) after a measured defect, and it is here so
 * that the next resource to spatialise something does not rediscover the defect.
 * Nothing in this file knows what a radio, a radar or a detector is: it takes a
 * range and a reference distance and returns panner parameters.
 *
 * ## The defect this shape exists to prevent
 *
 * Web Audio's distance models CLAMP at `maxDistance`; they do not silence there.
 * A panner whose `maxDistance` is shorter than the range the transport actually
 * delivers over therefore plays ONE constant level from `maxDistance` out to the
 * transport's cutoff, and then stops dead. tRadio shipped exactly that — panner
 * maxDistance 8/10 m against a 35/60 m broadcast — and it measured as a flat
 * −22.5 dB plateau across the whole band. A plateau followed by a cliff is the
 * opposite of how sound behaves.
 *
 * The fix is to make the curve END where the transport ends, and to pick a model
 * whose shape can be solved for that:
 *
 *   • "inverse" is asymptotic. Reaching −50 dB at the edge needs a rolloff so
 *     large it craters the near field as well.
 *   • "linear" reaches true zero at maxDistance, but its near field is flat and
 *     unphysical.
 *   • "exponential" is `gain = (d / refDistance) ** -rolloffFactor` — a power
 *     law, which is what spreading loss actually is, and whose exponent is a
 *     free parameter with a closed-form solution.
 *
 * So the exponent is derived rather than chosen:
 *
 *     rolloffFactor = ln(1 / EDGE_GAIN) / ln(range / refDistance)
 *
 * which puts the gain at `range` exactly at EDGE_GAIN by construction, for ANY
 * range. That is the property that matters: an owner who widens the range in
 * config stretches the same curve instead of re-introducing a plateau.
 */

/**
 * The gain a source is reduced to at the edge of its range: −50.5 dB.
 *
 * Multiplied on top of the per-sound volume and the player's own slider, so it
 * lands far below the noise floor of everything else in the mix. It is the
 * number that makes "the transport stopped sending" and "the sound faded out"
 * the same moment rather than two.
 */
export const EDGE_GAIN = 0.003;

/** Panner parameters for one emitter. Assign straight onto a `PannerNode`. */
export interface SpatialFalloff {
  rolloff: number;
  refDistance: number;
  maxDistance: number;
  distanceModel: "exponential";
}

/**
 * Solve the curve that is at full gain inside `refDistance` and at exactly
 * `EDGE_GAIN` at `range`.
 *
 * Both inputs reach this from a resource's config file, so the degenerate cases
 * are clamped rather than trusted. A range at or below `refDistance` makes
 * `ln(range / refDistance)` zero or negative, and the resulting rolloff infinite
 * or inverted — an inverted rolloff makes a source get LOUDER the further away
 * it is, which is the one failure that would be reported as "the audio is
 * haunted" rather than as a config error.
 */
export function spatialFalloff(range: number, refDistance: number): SpatialFalloff {
  const ref = Number.isFinite(refDistance) && refDistance > 0 ? refDistance : 1;
  // Never let the audible range collapse into the near field. 2x ref is the
  // tightest shape that still has a curve in it at all.
  const max = Math.max(ref * 2, Number.isFinite(range) && range > 0 ? range : 0);
  return {
    rolloff: Math.log(1 / EDGE_GAIN) / Math.log(max / ref),
    refDistance: ref,
    maxDistance: max,
    distanceModel: "exponential",
  };
}

/**
 * The gain the panner applies at `distance`.
 *
 * A pure mirror of the Web Audio "exponential" distance model, and the oracle
 * the falloff tests measure against — the panner itself cannot be read back, so
 * without this the curve could only be described rather than asserted.
 */
export function falloffGainAt(f: SpatialFalloff, distance: number): number {
  const d = Math.min(Math.max(distance, f.refDistance), f.maxDistance);
  return (d / f.refDistance) ** -f.rolloff;
}

/** `falloffGainAt` in dB. Reporting and tests. */
export function falloffDbAt(f: SpatialFalloff, distance: number): number {
  return 20 * Math.log10(falloffGainAt(f, distance));
}
