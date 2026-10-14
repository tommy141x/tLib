/**
 * tLib's diagnostics core.
 *
 * NOT exported from `shared/ts/index.ts`. The top-level barrel is imported by
 * every consumer's NUI bundle, and this directory reaches `document`,
 * `localStorage`, `performance.memory` and a WebGL context — pulling it into a
 * barrel would put all of that in the dependency graph of a bundle that never
 * asked for diagnostics, and three of the four throw outside a browser. A
 * consumer imports `@tlib/shared/telemetry` explicitly, which is also how
 * `escape-layer` and `prop-editor` are reached.
 *
 * And nothing here is `tlib.diag`. `tlib.diag` is 75 curated OPERATOR-ERROR
 * diagnostics — a bad config key, a missing file, a convar set to nonsense —
 * and its own header says "Nothing here decides anything. It prints." Those are
 * not faults anybody can fix from a dashboard: they are a customer typing a
 * wrong value, and routing them here would fill a store that cannot delete a row
 * with other people's configuration mistakes. The two must not be wired
 * together.
 */

export {
  hasAmbientTimers,
  recordNui,
  registerAmbientTimers,
  timeNui,
  timeNuiAsync,
} from "./ambient";
export type { DiagFlush, Diagnostics, InstallOptions } from "./collect";
export {
  DEDUPE_WINDOW_MS,
  DIAG_NUI_CALLBACK,
  FLUSH_INTERVAL_MS,
  installDiagnostics,
  MAX_BUFFERED_EVENTS,
} from "./collect";
export type { ErrorContext, ErrorReport } from "./error-report";
export { describeError, formatErrorReport, MAX_STACK_CHARS } from "./error-report";
export type { HardwareSnapshot } from "./hardware";
export { environmentRow, readHardware, rendererString } from "./hardware";
export type {
  AnalyticsBatchBody,
  DiagContext,
  DiagCrashKind,
  DiagErrorKind,
  DiagEvent,
  DiagEventName,
  DiagGpuVendor,
  DiagOs,
  DiagOutlierKind,
  DiagRamBucket,
  DiagSurface,
  DiagWarningKind,
} from "./payload";
// The install id is NOT re-exported here any more, and `install-id.ts` has
// moved out of this directory to `shared/ts/install-id.ts`. It is no longer a
// telemetry concern: it travels on every tWeb-bound request — marketplace
// browse, install, community configs, the update check — whether or not
// diagnostics are on. Re-exporting it from the diagnostics barrel is how the
// next reader comes to believe `tlib_telemetry` governs it. Import it from
// `shared/ts/install-id` instead.
export {
  ANALYTICS_PATH,
  compact,
  crashKindFor,
  DIAG_CRASH_KINDS,
  DIAG_ERROR_KINDS,
  DIAG_EVENTS,
  DIAG_GPU_VENDORS,
  DIAG_OS,
  DIAG_OUTLIER_KINDS,
  DIAG_PRODUCT,
  DIAG_RAM_BUCKETS,
  DIAG_SURFACES,
  DIAG_WARNING_KINDS,
  DIMENSION_CAPS,
  DIMENSION_ID_PATTERN,
  FINGERPRINT_FRAMES,
  fnv1a,
  gpuModelFor,
  gpuVendorFor,
  MAX_EVENTS_PER_BATCH,
  MAX_EVENTS_PER_CLIENT_PER_MINUTE,
  MAX_QUEUED_EVENTS,
  MAX_STACK_CHARS_SENT,
  MEASURE_RANGES,
  normaliseStack,
  osFor,
  pathSlug,
  ramBucketFor,
  slug,
  stackHash,
  unsafeDimensions,
  versionSlug,
} from "./payload";
export {
  HOME,
  REDACTED,
  redactSecrets,
  registerScrubValue,
  resetScrubValues,
  scrub,
  scrubIdentifiers,
  scrubIdentifying,
  scrubPaths,
  scrubValues,
} from "./scrub";
export type {
  CrashReport,
  CrashVerdict,
  ResourceSample,
  SessionHandle,
  SessionLogOptions,
} from "./session";
export { formatSample, readTrend, sampleResources, startSessionLog } from "./session";
export type { TimedOutlier, TimerOptions, Timers } from "./timed";
export {
  createTimers,
  P95_BUDGET_FRACTION,
  P95_INTERVAL_MS,
  p95,
  SAMPLE_WINDOW,
  THRESHOLD_COOLDOWN_MS,
} from "./timed";
