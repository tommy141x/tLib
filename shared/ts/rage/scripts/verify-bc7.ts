#!/usr/bin/env bun
// Differential verification of the BC7 decoder against a GPU.
//
// CodeWalker cannot serve as the oracle for BC7: `DDSIO.cs:167` is literally
// `//BC7 TODO!!`, so `verify-ytd.ts` can only prove the compressed bytes for a BC7
// texture, never the pixels they decode to. This script supplies the missing oracle by
// handing the same blocks to a real BC7 decoder - ANGLE/SwiftShader inside headless
// Chrome, via `EXT_texture_compression_bptc` - and comparing texel for texel.
//
//   bun run shared/ts/rage/scripts/verify-bc7.ts <dir-or-file>... [--limit=N]
//                                                [--max-pixels=N] [--chrome=PATH]
//
// Two traps this file already pays for, both of which produce a plausible-looking
// all-wrong result rather than an error:
//
//   * `readPixels` row 0 is the BOTTOM of the framebuffer, but `texelFetch` texel row 0
//     is the FIRST row uploaded, which is the top row of a DDS mip. The two cancel out:
//     readPixels row 0 already IS mip row 0 and must NOT be flipped. Flipping it scores
//     ~21% of components wrong, which reads exactly like a decoder bug.
//   * Chrome on this machine refuses some fixed debugging ports, so the port is chosen
//     by Chrome (`--remote-debugging-port=0`) and read back from `DevToolsActivePort`.

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DxgiFormat, decodeBc7Block, mipBytes, parseYtd } from "../ytd";

process.on("uncaughtException", (e) => {
  console.error("uncaught:", e);
  process.exit(1);
});
process.on("unhandledRejection", (e) => {
  console.error("unhandled rejection:", e);
  process.exit(1);
});

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith("--"));
const inputs = args.filter((a) => !a.startsWith("--"));
const flagValue = (p: string) => flags.find((f) => f.startsWith(p))?.slice(p.length);
const limit = Number(flagValue("--limit=") ?? "500");
const maxPixels = Number(flagValue("--max-pixels=") ?? "400000");

const CHROME_CANDIDATES = [
  flagValue("--chrome="),
  process.env.CHROME,
  ...chromeUnderPuppeteerCache(),
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter((p): p is string => typeof p === "string" && p.length > 0);

function chromeUnderPuppeteerCache(): string[] {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  const root = join(home, ".cache", "puppeteer", "chrome");
  try {
    return readdirSync(root).map((d) => join(root, d, "chrome-win64", "chrome.exe"));
  } catch {
    return [];
  }
}

const CHROME = CHROME_CANDIDATES.find((p) => existsSync(p));
if (inputs.length === 0) {
  console.error(
    "usage: verify-bc7.ts <dir-or-file>... [--limit=N] [--max-pixels=N] [--chrome=PATH]"
  );
  process.exit(2);
}
if (!CHROME) {
  console.error(`no Chrome found; tried:\n  ${CHROME_CANDIDATES.join("\n  ")}\nset --chrome=PATH`);
  process.exit(2);
}

function collect(path: string, out: string[]): void {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(path);
  } catch {
    return;
  }
  if (st.isDirectory()) {
    for (const e of readdirSync(path)) collect(join(path, e), out);
  } else if (path.toLowerCase().endsWith(".ytd")) {
    out.push(path);
  }
}

const files: string[] = [];
for (const i of inputs) collect(resolve(i), files);
files.sort();

const RSC7_MAGIC = 0x37435352;

interface Sample {
  label: string;
  width: number;
  height: number;
  /** Whether the file declared the sRGB variant; the block bits are identical either way. */
  srgb: boolean;
  blocks: Uint8Array;
}

const samples: Sample[] = [];
let pixels = 0;
let filesScanned = 0;
let skippedNotRsc7 = 0;
let skippedParse = 0;

for (const file of files.slice(0, limit)) {
  if (pixels >= maxPixels) break;
  const raw = new Uint8Array(readFileSync(file));
  if (
    raw.length < 16 ||
    new DataView(raw.buffer, raw.byteOffset).getUint32(0, true) !== RSC7_MAGIC
  ) {
    skippedNotRsc7++;
    continue;
  }
  let dict: Awaited<ReturnType<typeof parseYtd>>;
  try {
    dict = await parseYtd(raw);
  } catch {
    skippedParse++;
    continue;
  }
  filesScanned++;
  // Cap what one file may contribute: otherwise a single 2048px BC7 texture consumes
  // the whole pixel budget and the run exercises one encoder's habits, not the format.
  const perFileBudget = Math.max(16384, Math.floor(maxPixels / 8));
  let fromThisFile = 0;
  const short = file.split(/[\\/]/).pop() ?? file;
  for (const tex of dict.textures) {
    if (tex.dxgi !== DxgiFormat.BC7_UNORM && tex.dxgi !== DxgiFormat.BC7_UNORM_SRGB) continue;
    for (let level = 0; level < tex.levels; level++) {
      if (pixels >= maxPixels || fromThisFile >= perFileBudget) break;
      const mip = tex.mips[level];
      // A mip narrower than 4 makes the GPU pad the texture, which would compare a
      // texel this decoder never wrote. Stick to whole blocks.
      if (mip.width < 4 || mip.height < 4 || mip.width % 4 || mip.height % 4) continue;
      const blocks = mipBytes(tex, level);
      if (blocks.length < mip.slicePitch) continue;
      samples.push({
        label: `${short}:${tex.name}#${level}`,
        width: mip.width,
        height: mip.height,
        srgb: tex.dxgi === DxgiFormat.BC7_UNORM_SRGB,
        blocks,
      });
      pixels += mip.width * mip.height;
      fromThisFile += mip.width * mip.height;
    }
  }
}

if (samples.length === 0) {
  console.error("FAIL: found no BC7 mip levels in the corpus - nothing was verified");
  process.exit(1);
}

console.log(
  `scanned ${filesScanned} .ytd files (${skippedNotRsc7} not RSC7, ${skippedParse} unparsable)`
);
console.log(`collected ${samples.length} BC7 mip levels, ${pixels.toLocaleString()} pixels`);

// --- the page -------------------------------------------------------------------

const NL = String.fromCharCode(10);
const VS = `#version 300 es${NL}void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.0-1.0,0,1);}`;
const FS = `#version 300 es${NL}precision highp float;uniform highp sampler2D t;out vec4 o;void main(){o=texelFetch(t,ivec2(gl_FragCoord.xy),0);}`;

const payload = samples.map((s) => ({
  w: s.width,
  h: s.height,
  srgb: s.srgb,
  b: Buffer.from(s.blocks).toString("base64"),
}));

const page = `<!doctype html><meta charset=utf-8><title>bc7 oracle</title><canvas id=c></canvas>
<script id=data type=application/json>${JSON.stringify(payload)}</script>
<script>
const SAMPLES=JSON.parse(document.getElementById('data').textContent);
const VS=${JSON.stringify(VS)}, FS=${JSON.stringify(FS)};
function b64(s){const b=atob(s);const u=new Uint8Array(b.length);for(let i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return u;}
function toB64(u){let s='';for(let i=0;i<u.length;i+=0x8000)s+=String.fromCharCode.apply(null,u.subarray(i,i+0x8000));return btoa(s);}
function rendererInfo(gl){const d=gl.getExtension('WEBGL_debug_renderer_info');return d?gl.getParameter(d.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER);}
function run(){
  const canvas=document.getElementById('c');
  const gl=canvas.getContext('webgl2',{antialias:false,preserveDrawingBuffer:true});
  if(!gl) return {error:'no webgl2 context'};
  const ext=gl.getExtension('EXT_texture_compression_bptc');
  if(!ext) return {error:'no EXT_texture_compression_bptc', renderer:rendererInfo(gl)};
  const p=gl.createProgram();
  for(const pair of [[gl.VERTEX_SHADER,VS],[gl.FRAGMENT_SHADER,FS]]){
    const s=gl.createShader(pair[0]);gl.shaderSource(s,pair[1]);gl.compileShader(s);
    if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)) return {error:'shader: '+gl.getShaderInfoLog(s)};
    gl.attachShader(p,s);
  }
  gl.linkProgram(p);
  if(!gl.getProgramParameter(p,gl.LINK_STATUS)) return {error:'link: '+gl.getProgramInfoLog(p)};
  gl.useProgram(p);
  gl.bindVertexArray(gl.createVertexArray());
  const out=[];
  for(const s of SAMPLES){
    canvas.width=s.w;canvas.height=s.h;
    const tex=gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D,tex);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
    // Always the UNORM enum: sRGB would make the GPU transform the values, and this is
    // a comparison of the decoder, not of the colour space.
    gl.compressedTexImage2D(gl.TEXTURE_2D,0,ext.COMPRESSED_RGBA_BPTC_UNORM_EXT,s.w,s.h,0,b64(s.b));
    const e=gl.getError(); if(e){out.push({error:'gl error '+e});gl.deleteTexture(tex);continue;}
    gl.viewport(0,0,s.w,s.h);
    gl.drawArrays(gl.TRIANGLES,0,3);
    const got=new Uint8Array(s.w*s.h*4);
    gl.readPixels(0,0,s.w,s.h,gl.RGBA,gl.UNSIGNED_BYTE,got);
    // NOT flipped: see the header comment. texelFetch row 0 is the first uploaded row,
    // and readPixels row 0 is the bottom of the viewport, so the two already agree.
    out.push({rgba:toB64(got)});
    gl.deleteTexture(tex);
  }
  return {ok:true,renderer:rendererInfo(gl),results:out};
}
try{window.__result=run();}catch(e){window.__result={error:String(e)+' '+(e&&e.stack)};}
</script>`;

const workDir = mkdtempSync(join(tmpdir(), "verify-bc7-"));
const pagePath = join(workDir, "oracle.html");
writeFileSync(pagePath, page);

const profile = join(workDir, "profile");
const child = spawn(
  CHROME,
  [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-sandbox",
    "--no-first-run",
    "--disable-extensions",
    // SwiftShader is the point: a software rasteriser that implements BPTC to spec,
    // so the oracle does not depend on which GPU this machine happens to have.
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--allow-file-access-from-files",
    `file:///${pagePath.replace(/\\/g, "/")}`,
  ],
  { stdio: "ignore" }
);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let cleaned = false;
function cleanup(): void {
  if (cleaned) return;
  cleaned = true;
  child.kill();
  // Chrome keeps the profile directory locked for a moment after being killed, and on
  // Windows that surfaces as EBUSY. Retry briefly, then leave it - a leftover temp
  // directory is not worth failing a verification run over, and this only ever touches
  // the directory this run created.
  for (let i = 0; i < 20; i++) {
    try {
      rmSync(workDir, { recursive: true, force: true });
      return;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  console.error(`note: could not remove ${workDir}; Chrome still had it open`);
}

let port = 0;
for (let i = 0; i < 60 && !port; i++) {
  await sleep(500);
  try {
    port = Number(readFileSync(join(profile, "DevToolsActivePort"), "utf8").split(NL)[0].trim());
  } catch {
    // not written yet
  }
}
if (!port) {
  cleanup();
  console.error("FAIL: Chrome never wrote DevToolsActivePort");
  process.exit(1);
}

interface Target {
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}
let target: Target | undefined;
for (let i = 0; i < 40 && !target; i++) {
  await sleep(500);
  try {
    const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Target[];
    target = list.find((t) => t.type === "page" && t.url.includes("oracle.html"));
  } catch {
    // devtools not up yet
  }
}
if (!target) {
  cleanup();
  console.error("FAIL: Chrome never opened the oracle page");
  process.exit(1);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise<void>((res, rej) => {
  ws.onopen = () => res();
  ws.onerror = () => rej(new Error("devtools websocket failed"));
});

function send(
  method: string,
  params: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const id = Math.floor(Math.random() * 1e9);
  return new Promise((res) => {
    const handler = (ev: MessageEvent) => {
      const m = JSON.parse(String(ev.data));
      if (m.id === id) {
        ws.removeEventListener("message", handler);
        res(m.result ?? {});
      }
    };
    ws.addEventListener("message", handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

interface OracleResult {
  ok?: boolean;
  error?: string;
  renderer?: string;
  results?: { rgba?: string; error?: string }[];
}

let oracle: OracleResult | null = null;
for (let i = 0; i < 120; i++) {
  const r = await send("Runtime.evaluate", {
    expression: "JSON.stringify(window.__result ?? null)",
    returnByValue: true,
  });
  const value = (r.result as { value?: string } | undefined)?.value;
  if (value && value !== "null") {
    oracle = JSON.parse(value) as OracleResult;
    break;
  }
  await sleep(500);
}
ws.close();
cleanup();

if (!oracle) {
  console.error("FAIL: the oracle page produced no result (WebGL init may have hung)");
  process.exit(1);
}
if (oracle.error || !oracle.results) {
  console.error(`FAIL: oracle page error: ${oracle.error}`);
  if (oracle.renderer) console.error(`  renderer: ${oracle.renderer}`);
  process.exit(1);
}
console.log(`oracle renderer: ${oracle.renderer}`);

// --- compare --------------------------------------------------------------------

interface ModeStats {
  blocks: number;
  badBlocks: number;
  maxDelta: number;
}
const byMode = new Map<number, ModeStats>();
const failures: string[] = [];
let blocksCompared = 0;
let componentsCompared = 0;
let mipsCompared = 0;

const scratch = new Uint8Array(64);
for (let i = 0; i < samples.length; i++) {
  const s = samples[i];
  const got = oracle.results[i];
  if (!got?.rgba) {
    failures.push(`${s.label}: oracle produced no pixels (${got?.error ?? "missing"})`);
    continue;
  }
  const gpu = new Uint8Array(Buffer.from(got.rgba, "base64"));
  if (gpu.length !== s.width * s.height * 4) {
    failures.push(
      `${s.label}: oracle returned ${gpu.length} bytes, expected ${s.width * s.height * 4}`
    );
    continue;
  }
  mipsCompared++;
  const bw = s.width / 4;
  const bh = s.height / 4;
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const at = (by * bw + bx) * 16;
      let mode = 0;
      while (mode < 8 && ((s.blocks[at] >> mode) & 1) === 0) mode++;
      const stats = byMode.get(mode) ?? { blocks: 0, badBlocks: 0, maxDelta: 0 };
      stats.blocks++;
      blocksCompared++;
      decodeBc7Block(s.blocks, at, scratch);
      let bad = false;
      for (let py = 0; py < 4; py++) {
        for (let px = 0; px < 4; px++) {
          const src = (4 * py + px) * 4;
          const dst = ((by * 4 + py) * s.width + bx * 4 + px) * 4;
          for (let c = 0; c < 4; c++) {
            componentsCompared++;
            const delta = Math.abs(scratch[src + c] - gpu[dst + c]);
            if (delta > stats.maxDelta) stats.maxDelta = delta;
            if (delta !== 0 && !bad) {
              bad = true;
              if (failures.length < 20) {
                failures.push(
                  `${s.label} block (${bx},${by}) mode ${mode}: ` +
                    `mine [${scratch.subarray(src, src + 4)}] vs GPU [${gpu.subarray(dst, dst + 4)}]`
                );
              }
            }
          }
        }
      }
      if (bad) stats.badBlocks++;
      byMode.set(mode, stats);
    }
  }
}

console.log("");
console.log(`BC7 mips compared    ${mipsCompared} / ${samples.length}`);
console.log(`blocks compared      ${blocksCompared.toLocaleString()}`);
console.log(`components compared  ${componentsCompared.toLocaleString()}`);
console.log("by BC7 mode:");
const missing: number[] = [];
for (let m = 0; m < 8; m++) {
  const s = byMode.get(m);
  if (!s) {
    missing.push(m);
    continue;
  }
  console.log(
    `  mode ${m}  ${String(s.blocks).padStart(9)} blocks  ` +
      `${String(s.badBlocks).padStart(7)} bad  max delta ${s.maxDelta}`
  );
}
if (missing.length > 0) {
  console.log(`  modes NOT exercised by this corpus: ${missing.join(", ")}`);
}

if (blocksCompared === 0) {
  console.error("\nFAIL: compared zero blocks");
  process.exit(1);
}
if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`);
  for (const f of failures.slice(0, 20)) console.error(`  ${f}`);
  process.exit(1);
}

console.log("\nPASS: the BC7 decoder is byte-identical to the GPU on every compared texel.");
