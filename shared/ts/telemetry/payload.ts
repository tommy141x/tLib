/**
 * The wire contract. One file, so the NUI collector, the game server's batcher
 * and the website's ingest cannot disagree about what a diagnostics event is.
 *
 * The names, enums and caps here are fixed by tWeb's taxonomy and are not ours to
 * adjust: the store is append-only and dimension position is the column. A value
 * outside an enum or charset refuses the event — loudly on tWeb's dashboard,
 * silently here — so everything validates before send.
 *
 * Full rationale, including why `surface` is not `senderKind`:
 * docs/internal/telemetry-wire-contract.md
 */

import { scrubIdentifiers } from "./scrub";

/** The product name tWeb's taxonomy declares for this estate — one for all twelve. */
export const DIAG_PRODUCT = "tlib";

/** Every event name tLib emits. An undeclared name is refused per event. */
export const DIAG_EVENTS = [
  "tlib.error_reported",
  "tlib.warning_reported",
  "tlib.crash_reported",
  "tlib.slow_operation",
  "tlib.environment_reported",
] as const;

export type DiagEventName = (typeof DIAG_EVENTS)[number];

/** Where the FAULT happened, not which process posted. */
export const DIAG_SURFACES = ["client", "server", "nui"] as const;
export type DiagSurface = (typeof DIAG_SURFACES)[number];

export const DIAG_ERROR_KINDS = [
  "lua_error",
  "native_error",
  "nui_error",
  "http_error",
  "config_error",
  "unknown",
] as const;
export type DiagErrorKind = (typeof DIAG_ERROR_KINDS)[number];

export const DIAG_WARNING_KINDS = [
  "deprecation",
  "config",
  "limit",
  "compatibility",
  "unknown",
] as const;
export type DiagWarningKind = (typeof DIAG_WARNING_KINDS)[number];

export const DIAG_CRASH_KINDS = [
  "script_timeout",
  "out_of_memory",
  "native_fault",
  "resource_stop",
  "unknown",
] as const;
export type DiagCrashKind = (typeof DIAG_CRASH_KINDS)[number];

export const DIAG_OS = ["windows", "macos", "linux", "unknown"] as const;
export type DiagOs = (typeof DIAG_OS)[number];

export const DIAG_RAM_BUCKETS = [
  "under_8",
  "8_to_16",
  "16_to_32",
  "32_to_64",
  "64_plus",
  "unknown",
] as const;
export type DiagRamBucket = (typeof DIAG_RAM_BUCKETS)[number];

export const DIAG_GPU_VENDORS = ["nvidia", "amd", "intel", "apple", "other", "unknown"] as const;
export type DiagGpuVendor = (typeof DIAG_GPU_VENDORS)[number];

/** How a `timed()` call came to be reported. NOT a dimension; it only gates sending. */
export const DIAG_OUTLIER_KINDS = ["threshold", "p95"] as const;
export type DiagOutlierKind = (typeof DIAG_OUTLIER_KINDS)[number];

/** Per-dimension length caps. tWeb's. */
export const DIMENSION_CAPS = {
  resource: 32,
  resourceVersion: 32,
  installId: 32,
  errorCode: 64,
  warningCode: 64,
  operation: 64,
  location: 160,
  stackHash: 64,
  gpuModel: 48,
} as const;

/** Measure ranges. A value outside one is CLAMPED by the ingest, not refused. */
export const MEASURE_RANGES = {
  uptimeSeconds: [0, 604_800],
  durationMs: [0, 60_000],
  thresholdMs: [0, 60_000],
  cpuCores: [0, 256],
} as const;

/** Analytics Engine's per-invocation ceiling. A platform fact, not a choice. */
export const MAX_EVENTS_PER_BATCH = 250;

/**
 * The server's queue ceiling. It is a RING — oldest dropped, drop count reported —
 * so tWeb can go offline with nothing degrading and no loss goes unseen.
 */
export const MAX_QUEUED_EVENTS = MAX_EVENTS_PER_BATCH * 2;

/**
 * Per-client ceiling per minute. A client in a render loop would otherwise fill
 * the queue and crowd out every other player.
 */
export const MAX_EVENTS_PER_CLIENT_PER_MINUTE = 20;

/**
 * Longest `stack` this emitter sends, bounded so the BATCH stays inside the
 * body-size cap, which is charged before the per-event one.
 */
export const MAX_STACK_CHARS_SENT = 4000;

/**
 * tWeb's `DIMENSION_ID_PATTERN`, duplicated because no type can span two repos.
 * `_` is absent, contradicting tWeb's own `gpuModel` example, so that field is
 * emitted with `-` — legal under either reading.
 */
export const DIMENSION_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

/**
 * Force an arbitrary string into the dimension charset, or answer `""`.
 *
 * It strips player identifiers FIRST: the ingest's charset admits `steam:` and
 * `discord:` ids verbatim, so a naive slugger launders one into a store that
 * cannot delete it. `""` rather than a placeholder, because an empty value is
 * omitted and an absent dimension is a state the ingest handles by design.
 */
export function slug(value: unknown, maxLength = 64): string {
  if (typeof value !== "string") return "";
  const out = scrubIdentifiers(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.:]+|[-.:]+$/g, "")
    .slice(0, maxLength)
    .replace(/[-.:]+$/g, "");
  return out !== "" && DIMENSION_ID_PATTERN.test(out) ? out : "";
}

/**
 * A version string. `+` is not in the charset, so build metadata is mapped to `.`
 * rather than truncated — and the refusal it avoids looks nothing like a length cap.
 */
export function versionSlug(value: unknown): string {
  if (typeof value !== "string") return "";
  return slug(value.replace(/\+/g, "."), DIMENSION_CAPS.resourceVersion);
}

/**
 * A code-ish identifier: a file and line, a config key, an error code. `/` and `\`
 * are not in the charset and map to `.`, keeping the `:line` suffix. Separate from
 * `slug` because that mapping is right for a path and wrong for prose.
 */
export function pathSlug(value: unknown, maxLength = DIMENSION_CAPS.location): string {
  if (typeof value !== "string") return "";
  return slug(value.replace(/[\\/]+/g, "."), maxLength);
}

/**
 * Refuse a payload whose dimensions the ingest would refuse. Checked here because
 * on the other side the failure is a counted refusal and a dropped event.
 */
export function unsafeDimensions(dimensions: Record<string, string>): string[] {
  return Object.entries(dimensions)
    .filter(([, v]) => v !== "" && !DIMENSION_ID_PATTERN.test(v))
    .map(([k]) => k);
}

/** Drop empty values, so an absent dimension is absent rather than `""`. */
export function compact(dimensions: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(dimensions)) if (v !== "") out[k] = v;
  return out;
}

/**
 * FNV-1a, 32-bit, as 8 LOWERCASE hex characters — lowercase is contract, because
 * tWeb's scrubber refuses a mixed-case 32-character token as a credential shape.
 * A grouping key, not a cryptographic hash, and it must give the same answer in a
 * Lua VM, hence plain arithmetic.
 */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i) & 0xff;
    // The 32-bit FNV prime, as the shift-and-add form, so the intermediate
    // never exceeds what a double represents exactly.
    h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Strip everything machine-specific out of a stack so the same bug on two players'
 * machines hashes alike: bundle content hashes, the resource name, absolute paths,
 * and column numbers, which move with a minifier for an unchanged line.
 */
export function normaliseStack(stack: string): string {
  return stack
    .replace(/https?:\/\/cfx-nui-[^/\s)]+/gi, "nui")
    .replace(/-[0-9a-f]{6,}\.(js|css|mjs)/gi, ".$1")
    .replace(/[A-Za-z]:[\\/][^\s)]+/g, "<abs>")
    .replace(/:(\d+):(\d+)/g, ":$1")
    .trim();
}

/**
 * Three frames: one groups two bugs dying in the same helper, all of them put the
 * whole call path in the key so one bug reached two ways never aggregates.
 */
export const FINGERPRINT_FRAMES = 3;

export function stackHash(name: string, stack?: string): string {
  const frames = (stack ? normaliseStack(stack) : "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    // The first line of a V8 stack is `Name: message`, whose message is
    // machine-specific more often than not; the name comes from the parameter.
    .filter((l) => l.startsWith("at ") || l.includes("@"))
    .slice(0, FINGERPRINT_FRAMES)
    .join("|");
  return fnv1a(`${name}|${frames}`);
}

/**
 * A dead session's trajectory, mapped onto tWeb's five crash kinds. Two verdicts
 * map to `unknown` on purpose: a leak that had not yet killed anything is not an
 * out-of-memory, and naming it one is a confident wrong category.
 */
export function crashKindFor(verdict: string): DiagCrashKind {
  switch (verdict) {
    case "heap-near-limit":
      return "out_of_memory";
    case "main-thread-block":
      return "script_timeout";
    default:
      return "unknown";
  }
}

/** `navigator.platform` and friends, mapped onto tWeb's four. */
export function osFor(platform: unknown): DiagOs {
  const p = typeof platform === "string" ? platform.toLowerCase() : "";
  if (p.includes("win")) return "windows";
  if (p.includes("mac") || p.includes("darwin")) return "macos";
  if (p.includes("linux") || p.includes("x11")) return "linux";
  return "unknown";
}

/**
 * `navigator.deviceMemory` onto tWeb's five RAM buckets — only two are reachable.
 * The API clamps to 0.25–8 GiB in powers of two (measured: `8` on a 32 GB machine),
 * so anything at the clamp is `unknown`, not a wrong bucket that looks right.
 */
export function ramBucketFor(deviceMemoryGb: unknown): DiagRamBucket {
  if (typeof deviceMemoryGb !== "number" || !Number.isFinite(deviceMemoryGb)) return "unknown";
  if (deviceMemoryGb > 0 && deviceMemoryGb < 8) return "under_8";
  return "unknown";
}

/** A renderer string mapped onto tWeb's six GPU vendors. */
export function gpuVendorFor(raw: unknown): DiagGpuVendor {
  const s = typeof raw === "string" ? raw.toLowerCase() : "";
  if (s === "") return "unknown";
  if (s.includes("nvidia") || s.includes("geforce") || s.includes("quadro")) return "nvidia";
  if (s.includes("amd") || s.includes("radeon") || s.includes("ati ")) return "amd";
  if (s.includes("intel")) return "intel";
  if (s.includes("apple")) return "apple";
  return "other";
}

/**
 * A GPU string reduced to a model slug. Real `WEBGL_debug_renderer_info` output
 * carries spaces, parentheses and commas, so it cannot be a dimension value as it
 * stands; the ANGLE wrapper, the vendor and the shader-model tail are all noise.
 */
export function gpuModelFor(raw: unknown): string {
  if (typeof raw !== "string" || raw === "") return "";
  const angle = /^ANGLE\s*\(([^,]+),\s*(.+?)(?:,\s*[^,]*)?\)\s*$/i.exec(raw.trim());
  let text = raw;
  if (angle) {
    const vendor = (angle[1] ?? "").trim();
    const model = (angle[2] ?? "").trim();
    // The vendor is almost always repeated at the head of the model, so prefixing
    // unconditionally would say it twice.
    text = model.toLowerCase().startsWith(vendor.toLowerCase()) ? model : `${vendor} ${model}`;
  }
  // Direct3D/OpenGL shader-model tails: `Direct3D11 vs_5_0 ps_5_0`.
  text = text.replace(/\s+Direct3D\d+(\s+\w+_\d+_\d+)*\s*$/i, "");
  text = text.replace(/\s+\(?OpenGL[^)]*\)?\s*$/i, "");
  // The vendor has its own dimension.
  text = text.replace(/^\s*(nvidia|amd|ati|intel|apple)\s+/i, "");
  return slug(text, DIMENSION_CAPS.gpuModel);
}

/**
 * The context every row carries. Built once and reused — it is identical for every
 * event from one VM, and re-deriving it is how a hardware read reaches a hot path.
 *
 * There is no `tlibVersion`: tWeb declares no slot and the store is append-only, so
 * a collector bug is attributable to a resource version only.
 */
export interface DiagContext {
  /** The resource that produced the event, e.g. `tradio`. Slugged, cap 32. */
  resource: string;
  resourceVersion: string;
  /**
   * The per-install random id. NOT an IP, a licence, a server name or any player
   * identifier — see `shared/ts/install-id.ts`.
   */
  installId: string;
  /** Where the FAULT happened, not who posted. */
  surface: DiagSurface;
}

/** One charset-clean row, exactly as the ingest takes it. */
export interface DiagEvent {
  event: DiagEventName;
  /** Epoch ms. Optional in the contract; always sent, so a clock verdict exists. */
  at: number;
  dimensions: Record<string, string>;
  measures: Record<string, number>;
  /**
   * `tlib.error_reported` ONLY, and never inside `dimensions`. Already scrubbed: a
   * non-zero `redactions` count on a stored stack is a bug here.
   */
  stack?: string;
}

/** The body posted to tWeb's analytics ingest. Its shape, not ours. */
export interface AnalyticsBatchBody {
  /**
   * Which PROCESS posted, always the game server. tWeb drops `sessionKey` for a
   * server sender, so the per-install id travels as the `installId` dimension
   * instead — otherwise the one countable axis would vanish behind a 202.
   */
  senderKind: "server";
  events: Array<{
    event: string;
    at: number;
    dimensions: Record<string, string>;
    measures: Record<string, number>;
    stack?: string;
  }>;
}

/** `POST` path on the studio API. The existing v1 endpoint; there is no other. */
export const ANALYTICS_PATH = "/api/v1/analytics/events";
