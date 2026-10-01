/**
 * Positional audio for world-audible devices.
 *
 * The NUI half. Its transport half is `tLib/shared/imports/audio3d/*.lua`, which
 * decides who is close enough to be told about an emitter and feeds this module
 * the listener pose and the emitter positions.
 *
 * Deliberately free of any resource's vocabulary — emitters, samples, cadences
 * and tones — so that tRadio's own graph can be retired onto it later without
 * the API moving.
 */

export {
  EDGE_GAIN,
  falloffDbAt,
  falloffGainAt,
  type SpatialFalloff,
  spatialFalloff,
} from "./falloff";
export {
  type Cadence,
  type FieldOptions,
  type ListenerPose,
  MAX_CONCURRENT_SAMPLES,
  MAX_EMITTER_AGE_MS,
  MIN_CADENCE_MS,
  MIN_SAMPLE_INTERVAL_MS,
  PositionalAudioField,
  type Tone,
  type Vec3,
} from "./field";
