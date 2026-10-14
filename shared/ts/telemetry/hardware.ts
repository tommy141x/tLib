/**
 * What machine the NUI is running on — every field MEASURED in the pinned
 * Chromium 103 that FiveM's CEF is, and nothing collected that was not.
 *
 * A FIELD THAT SILENTLY REPORTS `undefined` FOREVER IS WORSE THAN NO FIELD,
 * so this module has a probe behind it rather than a guess:
 * `scripts/probe-nui-hardware.ts` drives Chromium 103.0.5058.0 over CDP in both
 * headless and headed modes and prints a COLLECT / DO NOT COLLECT verdict per
 * candidate. What follows is that run's output, 2026-10-11, on an RTX 5070 Ti /
 * 24-thread Windows machine:
 *
 *   navigator.hardwareConcurrency        24                              COLLECT
 *   navigator.deviceMemory               8                               COLLECT*
 *   navigator.userAgent                  Mozilla/5.0 (Windows NT 10.0…)  COLLECT
 *   navigator.platform                   Win32                           COLLECT
 *   performance.memory.jsHeapSizeLimit   3760000000 / 4294705152         COLLECT
 *   performance.memory.usedJSHeapSize    10000000 / 1277201              COLLECT
 *   screen.width × height                800×600 (headless) 3440×1440    COLLECT
 *   devicePixelRatio                     1                               COLLECT
 *   WEBGL_debug_renderer_info            present, both webgl and webgl2  COLLECT
 *     UNMASKED_RENDERER_WEBGL            ANGLE (NVIDIA, NVIDIA GeForce
 *                                        RTX 5070 Ti Direct3D11 …, D3D11)
 *   navigator.userAgentData              present but EMPTY               DO NOT
 *   navigator.connection.effectiveType   "4g"                            DO NOT
 *
 * THE TWO FINDINGS THAT WOULD HAVE BEEN WRONG BY ASSUMPTION
 *
 * **`deviceMemory` is origin-gated.** The brief for this work recorded it as
 * "may be absent". On a `data:` URL it IS absent — `typeof undefined` — and the
 * first probe run reported exactly that and concluded DO NOT COLLECT. Served
 * over a real `http://127.0.0.1` origin the same build answers `8`. FiveM serves
 * NUI pages from `https://cfx-nui-<resource>/`, a real origin, so the field is
 * available in game. The asterisk above is the second half of the finding: the
 * Device Memory API clamps its answer to the range 0.25–8 GiB in powers of two,
 * so **`8` means "at least 8 GiB" and not "8 GB"** on a machine with 32. The
 * field below is named `deviceMemoryGbAtLeast` for that reason.
 *
 * **`localStorage` is NOT refused.** The same `data:`-URL artefact made it throw
 * `Storage is disabled inside 'data:' URLs`, which would have read as "CEF
 * refuses site data" — the one finding that would have killed the crash detector
 * in `session.ts` outright. Over a real origin it round-trips. (It was already
 * known to work in game, since tRadio's session ledger identified eight real
 * renderer kills with it; the probe is what makes that a measurement rather than
 * an inference from a bug report.)
 *
 * WHAT THIS PROBE CANNOT PROVE
 *
 * Chromium 103.0.5058.0 is two patch builds from cfx's 103.0.5060.141, and cfx
 * patches CEF. A field present here can still be absent in game. Every reader
 * below is therefore guarded AND the result OMITS the key rather than writing
 * `undefined`, so an absent field is absent in the payload and a reader on the
 * other side can tell "not available on that machine" from "zero".
 *
 * `navigator.userAgentData` is the live example of why that matters: it EXISTS
 * in this build — `typeof` is `object`, so a `!== undefined` guard passes — and
 * every field on it is empty (`platform: ""`, `brands: []`). A probe that asked
 * `Object.keys()` reported `[]` for it, which is indistinguishable from an
 * object that is fully populated behind prototype accessors. It is not collected.
 */

import {
  DIMENSION_CAPS,
  type DiagGpuVendor,
  type DiagOs,
  type DiagRamBucket,
  gpuModelFor,
  gpuVendorFor,
  osFor,
  ramBucketFor,
} from "./payload";

/** One guarded read. Returns `undefined` on absence OR on a throw. */
function reader<T>(fn: () => T | undefined): T | undefined {
  try {
    const v = fn();
    return v === null ? undefined : v;
  } catch {
    return undefined;
  }
}

/**
 * The GPU string, from the one API that names the real adapter.
 *
 * `webgl` IS TRIED BEFORE `webgl2` and both are tried, because a context can
 * be refused independently of the other and the extension is registered per
 * context. Measured: both answered in both modes here, and the unmasked strings
 * were identical — but one of them failing is the case this exists for.
 *
 * THE CANVAS IS NEVER ATTACHED TO THE DOCUMENT and the context is dropped
 * immediately. A WebGL context is a real GPU allocation; a diagnostic that keeps
 * one alive for the session would be a diagnostic with a cost, and this is read
 * once at boot.
 */
export function rendererString(): string | undefined {
  for (const kind of ["webgl", "webgl2"] as const) {
    const found = reader(() => {
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext(kind) as WebGLRenderingContext | null;
      if (!gl) return undefined;
      const ext = gl.getExtension("WEBGL_debug_renderer_info") as {
        UNMASKED_RENDERER_WEBGL: number;
      } | null;
      // Without the extension the answer is the useless constant "WebKit WebGL",
      // which names no adapter. Treated as absent rather than collected: a
      // dimension whose every value is the same string is a dimension that
      // cannot answer a question.
      if (!ext) return undefined;
      const value = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
      return typeof value === "string" && value.length > 0 ? value : undefined;
    });
    if (found) return found;
  }
  return undefined;
}

/**
 * The machine context, in exactly the dimensions `tlib.environment_reported`
 * declares — and nothing else.
 *
 * FIVE FACTS THIS PROBE PROVED AVAILABLE HAVE NO SLOT IN THE CONTRACT and
 * are therefore NOT collected. Stated here so their absence is a known loss
 * rather than a mystery, because every one of them was measured present in
 * Chromium 103 and three of them are diagnostically sharp:
 *
 *   • the CEF build, from the user agent — `103.0.5058`. The one fact that says
 *     whether a crash mechanism still exists in the build the player is running.
 *   • `performance.memory.jsHeapSizeLimit` — 3.76 GB headless, 4.29 GB headed in
 *     the same probe. It is what decides whether a renderer OOM was plausible at
 *     all, and `tlib.crash_reported` carries only `uptimeSeconds`.
 *   • `performance.memory.usedJSHeapSize`.
 *   • the screen size — 3440×1440 measured — and `devicePixelRatio`.
 *
 * All five still appear in the LOCAL F8 trajectory, which is where a player
 * pasting a report gets them from. Nothing in the payload carries them, and the
 * append-only rule means this side cannot add a slot.
 */
export interface HardwareSnapshot {
  os: DiagOs;
  ramBucket: DiagRamBucket;
  gpuVendor: DiagGpuVendor;
  /** Slugged model, `-` separated, cap 48. `""` when the adapter is unnamed. */
  gpuModel: string;
  /** `navigator.hardwareConcurrency`. `-1` when absent, which is omitted. */
  cpuCores: number;
  /** The unslugged renderer string. Not sent — used for the vendor/model split. */
  rawGpu?: string;
  rawUserAgent?: string;
}

export function readHardware(): HardwareSnapshot {
  const ua = reader(() => navigator.userAgent);
  const platform = reader(() => navigator.platform);
  const gpu = rendererString();

  const cores = reader(() => navigator.hardwareConcurrency);
  const ram = reader(() => (navigator as unknown as { deviceMemory?: number }).deviceMemory);

  return {
    // `navigator.platform` and NOT the user agent. The UA string is not a
    // dimension — it has spaces, slashes and parentheses, so the charset refuses
    // it — and the contract declares no slot for it either. `platform` answers
    // the one fact `os` wants, in one word.
    os: osFor(platform),
    ramBucket: ramBucketFor(ram),
    gpuVendor: gpuVendorFor(gpu),
    gpuModel: gpuModelFor(gpu),
    cpuCores:
      typeof cores === "number" && Number.isFinite(cores) && cores > 0 ? Math.round(cores) : -1,
    rawGpu: gpu,
    rawUserAgent: ua,
  };
}

/** The dimensions and measures for one `tlib.environment_reported` row. */
export function environmentRow(hw: HardwareSnapshot): {
  dimensions: Record<string, string>;
  measures: Record<string, number>;
} {
  return {
    dimensions: {
      os: hw.os,
      ramBucket: hw.ramBucket,
      gpuVendor: hw.gpuVendor,
      gpuModel: hw.gpuModel.slice(0, DIMENSION_CAPS.gpuModel),
    },
    // Omitted rather than sent as -1 when the reading was absent. A measure
    // is CLAMPED by the ingest rather than refused, so a -1 would be stored as 0
    // — "this machine has no CPU cores" — which is a wrong number that looks
    // like a reading.
    measures: hw.cpuCores > 0 ? { cpuCores: hw.cpuCores } : {},
  };
}
