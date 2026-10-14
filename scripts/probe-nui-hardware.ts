/**
 * What hardware context a NUI page can ACTUALLY read, measured in the pinned
 * Chromium 103 that FiveM's CEF is.
 *
 * ## Why this exists
 *
 * The diagnostics payload wants machine context — cores, RAM, GPU — so a "this is
 * slow on my machine" report arrives with the machine attached. Every candidate
 * API for that is either non-standard, origin-gated, or shipped behind a flag that
 * moved between Chromium versions:
 *
 *   • `navigator.hardwareConcurrency` — standard, but CEF has historically been
 *     built with a renderer process limit, and a value of 1 would be a lie.
 *   • `navigator.deviceMemory` — DOES NOT EXIST. The real name is
 *     `navigator.deviceMemory` in no spec; the Device Memory API ships as
 *     `navigator.deviceMemory` only in some vendor docs and as
 *     `navigator.deviceMemory`/`navigator.deviceMemoryEnabled` nowhere. Chromium
 *     implements it as **`navigator.deviceMemory`** behind
 *     `--enable-blink-features=DeviceMemory`... or not at all. This probe is the
 *     only way to know, and the answer is recorded in the diagnostics module.
 *   • `WEBGL_debug_renderer_info` — gated on a runtime-enabled feature and, since
 *     Chromium 92ish, deliberately coarsened for privacy on some platforms.
 *
 * WHAT THIS PROBE CANNOT PROVE. It drives Chromium 103.0.5058.0, which is two
 * patch builds from cfx's 103.0.5060.141 — the same engine, but NOT the same
 * build, and cfx applies its own patches to CEF. A field that exists here can
 * still be absent in game, which is why every field this produces is collected
 * through a guarded reader that OMITS the key rather than sending `undefined`.
 * Headless also has no real GPU: the renderer string under `--headless` is
 * SwiftShader, so the probe runs BOTH modes and reports both.
 *
 * Run:  bun run scripts/probe-nui-hardware.ts
 * Exit: 0 probe ran, 2 the probe could not run (NOT a pass).
 */

import { launch } from "../shared/ts/build/nui-chromium.ts";

/**
 * Read every candidate in one page evaluation.
 *
 * Deliberately a single string rather than a serialised function: `Runtime.evaluate`
 * takes an expression, and a template-interpolated function body is how the other
 * probes in this directory do it.
 */
const READER = `(() => {
  const out = {};
  const probe = (name, fn) => {
    try {
      const v = fn();
      out[name] = { present: v !== undefined && v !== null, value: v === undefined ? null : v, typeOf: typeof v };
    } catch (e) {
      out[name] = { present: false, value: null, typeOf: "throw", error: String(e && e.message || e) };
    }
  };

  probe("navigator.hardwareConcurrency", () => navigator.hardwareConcurrency);
  probe("navigator.deviceMemory", () => navigator.deviceMemory);
  probe("navigator.userAgent", () => navigator.userAgent);
  probe("navigator.platform", () => navigator.platform);
  probe("navigator.language", () => navigator.language);
  probe("navigator.connection.effectiveType", () => navigator.connection && navigator.connection.effectiveType);
  // UA-CH. Asked for the real GETTERS, not Object.keys: the own-property list of
  // a NavigatorUAData is empty (everything is a prototype accessor), so a keys
  // probe reports \`[]\` for an object that is fully populated — measured, and it
  // is why this reads the three fields by name.
  probe("navigator.userAgentData", () => {
    const d = navigator.userAgentData;
    if (!d) return undefined;
    return { mobile: d.mobile, platform: d.platform, brands: JSON.stringify(d.brands) };
  });
  // Is \`deviceMemory\` the real system RAM, or a bucket? The spec clamps it to
  // [0.25, 8] GiB in powers of two, so on a 32 GB machine an 8 means ">= 8" and
  // NOT "8 GB". Recorded here so the payload's field name cannot imply otherwise.
  probe("deviceMemory:isSecureContext", () => isSecureContext);
  probe("performance.memory.jsHeapSizeLimit", () => performance.memory && performance.memory.jsHeapSizeLimit);
  probe("performance.memory.usedJSHeapSize", () => performance.memory && performance.memory.usedJSHeapSize);
  probe("performance.now", () => typeof performance.now === "function" ? performance.now() : undefined);
  probe("screen.width", () => screen.width);
  probe("screen.height", () => screen.height);
  probe("devicePixelRatio", () => devicePixelRatio);
  probe("localStorage", () => { localStorage.setItem("__tlibprobe", "1"); const v = localStorage.getItem("__tlibprobe"); localStorage.removeItem("__tlibprobe"); return v; });

  // WebGL. Both contexts, because CEF can have one and not the other, and the
  // debug extension is the only thing that names the real adapter.
  for (const kind of ["webgl", "webgl2"]) {
    probe("gl:" + kind, () => {
      const c = document.createElement("canvas");
      const gl = c.getContext(kind);
      if (!gl) return undefined;
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      return {
        vendor: gl.getParameter(gl.VENDOR),
        renderer: gl.getParameter(gl.RENDERER),
        version: gl.getParameter(gl.VERSION),
        debugExt: !!ext,
        unmaskedVendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : null,
        unmaskedRenderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null,
        maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
        extensionCount: (gl.getSupportedExtensions() || []).length,
      };
    });
  }

  return out;
})()`;

interface Probed {
  present: boolean;
  value: unknown;
  typeOf: string;
  error?: string;
}

/**
 * The page is served over real `http://` on a loopback port.
 *
 * This is load-bearing and was a measured probe artefact first: on a `data:`
 * URL Chromium 103 THROWS `Storage is disabled inside 'data:' URLs` for
 * `localStorage`, which would have read as "CEF refuses site data" — the one
 * finding that would have killed the crash detector. A real origin is the only
 * way to ask the question. FiveM NUI pages are served from
 * `https://cfx-nui-<resource>/`, i.e. a real scheme with a real origin, so this
 * is the closer double.
 */
async function run(headless: boolean, origin: string): Promise<Record<string, Probed>> {
  const b = await launch({ headless, log: () => {} });
  try {
    await b.page.navigate(origin);
    return await b.page.evaluate<Record<string, Probed>>(READER);
  } finally {
    await b.close();
  }
}

function line(name: string, p: Probed | undefined): string {
  if (!p) return `  ${name.padEnd(40)} (not probed)`;
  if (p.error) return `  ${name.padEnd(40)} THREW: ${p.error}`;
  if (!p.present) return `  ${name.padEnd(40)} ABSENT (typeof ${p.typeOf})`;
  const v = typeof p.value === "object" ? JSON.stringify(p.value) : String(p.value);
  return `  ${name.padEnd(40)} ${v.length > 200 ? `${v.slice(0, 200)}…` : v}`;
}

async function main(): Promise<number> {
  const modes: Array<[string, boolean]> = [
    ["headless", true],
    ["headed (real GPU)", false],
  ];
  const results: Record<string, Record<string, Probed>> = {};

  const server = Bun.serve({
    port: 0,
    fetch: () =>
      new Response("<html><body>probe</body></html>", {
        headers: { "content-type": "text/html" },
      }),
  });
  const origin = `http://127.0.0.1:${server.port}/`;
  console.log(`probe origin: ${origin}`);

  try {
    for (const [label, headless] of modes) {
      console.log(`\n=== Chromium 103, ${label} ===`);
      try {
        const r = await run(headless, origin);
        results[label] = r;
        for (const k of Object.keys(r)) console.log(line(k, r[k]));
      } catch (e) {
        console.log(`  could not run: ${e instanceof Error ? e.message : String(e)}`);
        return 2;
      }
    }
  } finally {
    server.stop(true);
  }

  console.log("\n=== VERDICT (what the payload may carry) ===");
  const headlessR = results.headless ?? {};
  const headedR = results["headed (real GPU)"] ?? {};
  const both = (k: string) => (headlessR[k]?.present ? 1 : 0) + (headedR[k]?.present ? 1 : 0);
  for (const k of Object.keys(headlessR)) {
    const n = both(k);
    console.log(
      `  ${k.padEnd(40)} ${n === 2 ? "COLLECT" : n === 1 ? "MODE-DEPENDENT" : "DO NOT COLLECT"}`
    );
  }
  console.log(`\nraw: ${JSON.stringify(results)}`);
  return 0;
}

main().then(
  (c) => process.exit(c),
  (e) => {
    console.error(e);
    process.exit(2);
  }
);
