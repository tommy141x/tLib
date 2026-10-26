/**
 * Hardware fields collected from the NUI. Probed against pinned Chromium
 * 103.0.5058.0 over CDP (`scripts/probe-nui-hardware.ts`), not guessed: that
 * probe found `navigator.userAgentData` exists in this build (`typeof` is
 * `object`) but every field on it is empty, which `Object.keys()` alone can't
 * tell apart from a populated object behind prototype accessors — so it, and
 * `navigator.connection.effectiveType`, are not collected.
 *
 * `deviceMemory` is origin-gated: absent (`typeof undefined`) on a `data:` URL,
 * present over a real origin — FiveM serves NUI from `https://cfx-nui-<resource>/`,
 * so it's available in game. It's also clamped to 0.25-8 GiB in powers of two,
 * so `8` means "at least 8 GiB", hence the field name `deviceMemoryGbAtLeast`.
 * `localStorage` throws on a `data:` URL but round-trips over a real origin;
 * already known to work in game — tRadio's session ledger caught eight real
 * renderer kills with it.
 *
 * The probe build is two patches behind cfx's CEF (103.0.5060.141), so a field
 * present here can still be absent in game. Every reader below is guarded, and
 * an absent field is omitted from the payload rather than sent as `undefined`,
 * so a reader downstream can tell "not available" from "zero".
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
 * The GPU string, from the one API that names the real adapter. Tries `webgl`
 * then `webgl2`: either context can be refused independently, and the debug
 * extension is registered per context. The canvas is never attached to the
 * document and the context is dropped immediately — a WebGL context is a real
 * GPU allocation, and this is read once at boot, not kept alive for the session.
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
      // which names no adapter — treated as absent, not collected.
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
 * declares — nothing else. Measured-available but not collected, because the
 * append-only contract has no slot for them: the CEF build (from the user
 * agent — tells whether a crash mechanism still exists in the player's
 * build), `performance.memory.jsHeapSizeLimit`/`usedJSHeapSize` (decides
 * whether a renderer OOM was plausible; `tlib.crash_reported` carries only
 * `uptimeSeconds`), and screen size/`devicePixelRatio`. All still appear in
 * the local F8 trajectory, which is where a player pasting a report gets them.
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
    // `navigator.platform`, not the UA string: the UA has spaces/slashes/
    // parens the dimension charset refuses, and the contract has no slot for it.
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
    // Omitted, not sent as -1: the ingest clamps a measure rather than refusing
    // it, so -1 would be stored as 0 — "no CPU cores" — a wrong reading.
    measures: hw.cpuCores > 0 ? { cpuCores: hw.cpuCores } : {},
  };
}
