#!/usr/bin/env bun
// Differential verification of the TypeScript .ytd parser against CodeWalker.
//
// CodeWalker is the ground truth for this format. `gtatool ytd <file> --dds --out=DIR`
// drives CodeWalker.Core headlessly and writes its own DDS bytes for every texture -
// full header plus the untouched mip chain - so this script can compare, per texture:
// name, dimensions, format, mip count, and the raw mip bytes against the DDS payload.
//
// What this does NOT prove: decoded pixels. The oracle here is the byte stream, not the
// image. CodeWalker has no BC7 decoder at all (`DDSIO.cs:167` is `//BC7 TODO!!`) and its
// BC5 decoder is broken, so pixels are covered elsewhere - `verify-bc7.ts` compares the
// BC7 decoder against a real GPU, and `ytd/decode.test.ts` pins the rest.
//
// A dev tool, not part of `bun test`: it needs both a `.ytd` corpus and the gtatool
// build, neither of which lives in this repo.
//
//   bun run shared/ts/rage/scripts/verify-ytd.ts <dir-or-file>... [--limit=N] [--quiet]
//
// Override the gtatool path with GTATOOL=/path/to/gtatool.exe.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DxgiFormat, dxgiFromLegacy, mipBytes, parseYtd, TextureFormatG9 } from "../ytd";

// A top-level-await script that throws silently exits 0, which would make this a gate
// that reports success having measured nothing.
process.on("uncaughtException", (e) => {
  console.error("uncaught:", e);
  process.exit(1);
});
process.on("unhandledRejection", (e) => {
  console.error("unhandled rejection:", e);
  process.exit(1);
});

// The .exe, not gtatool.sh: spawnSync cannot exec a shell script on Windows.
// scripts -> rage -> ts -> shared -> tLib -> [tScripts] -> resources -> data -> repo root
const DEFAULT_GTATOOL = resolve(import.meta.dir, "../../../../../../../../tools/bin/gtatool.exe");
const GTATOOL = process.env.GTATOOL ?? DEFAULT_GTATOOL;

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith("--"));
const inputs = args.filter((a) => !a.startsWith("--"));
const flagValue = (p: string) => flags.find((f) => f.startsWith(p))?.slice(p.length);
const limit = Number(flagValue("--limit=") ?? "25");
const quiet = flags.includes("--quiet");

if (inputs.length === 0) {
  console.error("usage: verify-ytd.ts <dir-or-file>... [--limit=N] [--quiet]");
  process.exit(2);
}
if (!existsSync(GTATOOL)) {
  console.error(`gtatool not found at ${GTATOOL}; set GTATOOL=/path/to/gtatool.exe`);
  process.exit(2);
}

function collect(path: string, out: string[]): void {
  // A corpus root can contain dangling symlinks (broken worktree skill links, for one),
  // and one of those must not abort the whole sweep.
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
const selected = files.slice(0, limit);

const RSC7_MAGIC = 0x37435352;

/** One row of `gtatool ytd`'s table. */
interface GoldenTexture {
  name: string;
  width: number;
  height: number;
  format: string;
  g9Format: string | null;
  levels: number;
  bytes: number;
}

// The table is space-padded, and names contain spaces ("Center Dash Touch emis"), so the
// only safe anchor is the shape of the tail: WxH, format, then three integers.
const ROW = /^(.*?)\s+(\d+)x(\d+)\s+(\S+)(?:\s+\/g9:(\S+))?\s+(\d+)\s+(\d+)\s+(\d+)\s*$/;

interface Golden {
  version: number;
  textures: GoldenTexture[];
  /** Textures CodeWalker itself refused to export, name -> its own error message. */
  declined: Map<string, string>;
}

function goldenFor(file: string, ddsDir: string): Golden | null {
  const res = spawnSync(GTATOOL, ["ytd", file, "--dds", `--out=${ddsDir}`], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (res.error) {
    console.error(`  gtatool could not be run (${GTATOOL}): ${res.error.message}`);
    return null;
  }
  const stdout = res.stdout ?? "";
  if (res.status !== 0 || !stdout.startsWith("== ")) {
    console.error(
      `  gtatool failed (${res.status}): ${(res.stderr || stdout).trim().slice(0, 300)}`
    );
    return null;
  }
  const lines = stdout.split(/\r?\n/);
  const version = Number(/ver=(\d+)/.exec(lines[0] ?? "")?.[1] ?? "-1");
  const textures: GoldenTexture[] = [];
  const declined = new Map<string, string>();
  for (const line of lines.slice(2)) {
    if (line.startsWith("(") || line.startsWith("wrote ") || line.trim() === "") continue;
    // CodeWalker's own DDS export can throw - "Invalid slice pitch." fires on any
    // texture whose mip chain drives a dimension to zero. That is the oracle
    // declining, not this parser failing, so it is counted apart from the failures.
    const dec = /^\s{3}(.*?): DDS export FAILED: (.*)$/.exec(line);
    if (dec) {
      declined.set(dec[1], dec[2]);
      continue;
    }
    const m = ROW.exec(line);
    if (!m) continue;
    textures.push({
      name: m[1].trim(),
      width: Number(m[2]),
      height: Number(m[3]),
      format: m[4],
      g9Format: m[5] ?? null,
      levels: Number(m[6]),
      bytes: Number(m[8]),
    });
  }
  return { version, textures, declined };
}

/** `Path.GetInvalidFileNameChars()` replacement, as gtatool does it. */
function ddsFileName(name: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching .NET's set exactly.
  return `${name.replace(/["<>|:*?\\/\u0000-\u001f]/g, "_")}.dds`;
}

/** Header size of a CodeWalker-written DDS: 4 magic + 124 header + 20 if DX10. */
function ddsPayloadOffset(dds: Uint8Array): number {
  const fourCC = String.fromCharCode(dds[84], dds[85], dds[86], dds[87]);
  return fourCC === "DX10" ? 148 : 128;
}

function ddsHeaderInfo(dds: Uint8Array): { width: number; height: number; mips: number } {
  const view = new DataView(dds.buffer, dds.byteOffset, dds.byteLength);
  return {
    height: view.getUint32(12, true),
    width: view.getUint32(16, true),
    mips: view.getUint32(28, true),
  };
}

interface Totals {
  filesSeen: number;
  filesCompared: number;
  skippedNotRsc7: number;
  skippedGtatool: number;
  skippedParse: number;
  oracleDeclined: number;
  textures: number;
  mips: number;
  bytes: number;
  byFormat: Record<string, { textures: number; mips: number; bytes: number }>;
}
const totals: Totals = {
  filesSeen: 0,
  filesCompared: 0,
  skippedNotRsc7: 0,
  skippedGtatool: 0,
  skippedParse: 0,
  oracleDeclined: 0,
  textures: 0,
  mips: 0,
  bytes: 0,
  byFormat: {},
};
const failures: string[] = [];
/** CodeWalker's own DDS-export errors, tallied by message. */
const declinedReasons = new Map<string, number>();
const fail = (file: string, message: string) => failures.push(`${file}: ${message}`);

function tally(format: string, mips: number, bytes: number): void {
  let e = totals.byFormat[format];
  if (!e) {
    e = { textures: 0, mips: 0, bytes: 0 };
    totals.byFormat[format] = e;
  }
  e.textures++;
  e.mips += mips;
  e.bytes += bytes;
}

const workDir = mkdtempSync(join(tmpdir(), "verify-ytd-"));

for (const file of selected) {
  const name = file.split(/[\\/]/).pop() ?? file;
  totals.filesSeen++;

  const raw = new Uint8Array(readFileSync(file));
  if (
    raw.length < 16 ||
    new DataView(raw.buffer, raw.byteOffset).getUint32(0, true) !== RSC7_MAGIC
  ) {
    totals.skippedNotRsc7++;
    continue;
  }

  // One directory per file so a name collision between two .ytds cannot cross over.
  const ddsDir = join(workDir, String(totals.filesSeen));
  const golden = goldenFor(file, ddsDir);
  if (!golden) {
    totals.skippedGtatool++;
    fail(name, "no ground truth (gtatool failed)");
    continue;
  }

  let dict: Awaited<ReturnType<typeof parseYtd>>;
  try {
    dict = await parseYtd(raw);
  } catch (e) {
    totals.skippedParse++;
    fail(name, `TS parse threw: ${e instanceof Error ? e.message : String(e)}`);
    continue;
  }
  totals.filesCompared++;

  if (dict.version !== golden.version) {
    fail(name, `version ${dict.version} != ${golden.version}`);
  }
  if (dict.textures.length !== golden.textures.length) {
    fail(name, `texture count ${dict.textures.length} != ${golden.textures.length}`);
  }

  // The table is in file order and so is `dict.textures`, so index is the join key.
  for (let i = 0; i < Math.min(dict.textures.length, golden.textures.length); i++) {
    const tex = dict.textures[i];
    const g = golden.textures[i];
    const label = `texture ${i} "${g.name}"`;

    if ((tex.name ?? "") !== g.name) fail(name, `${label}: name "${tex.name}" != "${g.name}"`);
    if (tex.width !== g.width || tex.height !== g.height) {
      fail(name, `${label}: ${tex.width}x${tex.height} != ${g.width}x${g.height}`);
    }
    if (tex.levels !== g.levels) fail(name, `${label}: ${tex.levels} mips != ${g.levels}`);

    // CodeWalker prints the *legacy* format name for both generations, and the gen9
    // name after it. Compare both against what the parser derived.
    const legacyName = tex.format ? `D3DFMT_${describeLegacy(tex.format)}` : "0";
    if (legacyName !== g.format) fail(name, `${label}: legacy format ${legacyName} != ${g.format}`);
    if (g.g9Format !== null) {
      const mine = tex.formatG9 ? formatG9Name(tex.formatG9) : "UNKNOWN";
      if (mine !== g.g9Format) fail(name, `${label}: gen9 format ${mine} != ${g.g9Format}`);
    }

    // The DDS carries CodeWalker's own view of the format, derived from the legacy
    // value - so that, not the sRGB-preserving gen9 mapping, is what it can prove.
    const declinedWhy = golden.declined.get(g.name);
    if (declinedWhy !== undefined) {
      totals.oracleDeclined++;
      declinedReasons.set(declinedWhy, (declinedReasons.get(declinedWhy) ?? 0) + 1);
      continue;
    }
    const ddsPath = join(ddsDir, ddsFileName(g.name));
    if (!existsSync(ddsPath)) {
      fail(name, `${label}: gtatool wrote no DDS and reported no error`);
      continue;
    }
    const dds = new Uint8Array(readFileSync(ddsPath));
    const header = ddsHeaderInfo(dds);
    if (header.width !== tex.width || header.height !== tex.height) {
      fail(name, `${label}: DDS says ${header.width}x${header.height}`);
    }
    if (header.mips !== tex.levels) fail(name, `${label}: DDS says ${header.mips} mips`);

    const payload = dds.subarray(ddsPayloadOffset(dds));
    const expectedDxgi = dxgiFromLegacy(tex.format);
    if (expectedDxgi !== DxgiFormat.UNKNOWN && expectedDxgi !== tex.dxgi) {
      // Only flagged when the two disagree for a reason other than sRGB, which is a
      // known and deliberate difference.
      const srgbPair =
        tex.dxgi === DxgiFormat.BC7_UNORM_SRGB || tex.dxgi === DxgiFormat.BC3_UNORM_SRGB;
      if (!srgbPair) fail(name, `${label}: dxgi ${tex.dxgi} != legacy-derived ${expectedDxgi}`);
    }

    let mipsChecked = 0;
    let bytesChecked = 0;
    let bad = false;
    for (let level = 0; level < tex.levels; level++) {
      const mip = tex.mips[level];
      const mine = mipBytes(tex, level);
      const theirs = payload.subarray(mip.offset, mip.offset + mip.slicePitch);
      if (theirs.length === 0) break; // CodeWalker clamps a truncated data block too
      if (mine.length !== theirs.length) {
        fail(name, `${label} mip ${level}: ${mine.length} bytes vs DDS ${theirs.length}`);
        bad = true;
        break;
      }
      const at = firstDifference(mine, theirs);
      if (at >= 0) {
        fail(
          name,
          `${label} mip ${level}: first byte difference at +${at} ` +
            `(0x${mine[at].toString(16)} vs 0x${theirs[at].toString(16)})`
        );
        bad = true;
        break;
      }
      mipsChecked++;
      bytesChecked += mine.length;
    }
    if (!bad && mipsChecked > 0) {
      totals.textures++;
      totals.mips += mipsChecked;
      totals.bytes += bytesChecked;
      tally(g.g9Format ?? g.format, mipsChecked, bytesChecked);
    }
  }

  // Only ever removes the directory this run created.
  rmSync(ddsDir, { recursive: true, force: true });
  if (!quiet) {
    console.log(
      `${name.padEnd(40)} ${dict.textures.length} textures, ${dict.gen9 ? "gen9" : "gen8"}`
    );
  }
}

rmSync(workDir, { recursive: true, force: true });

function firstDifference(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return i;
  }
  return -1;
}

function describeLegacy(format: number): string {
  switch (format) {
    case 21:
      return "A8R8G8B8";
    case 22:
      return "X8R8G8B8";
    case 25:
      return "A1R5G5B5";
    case 28:
      return "A8";
    case 32:
      return "A8B8G8R8";
    case 50:
      return "L8";
    case 0x31545844:
      return "DXT1";
    case 0x33545844:
      return "DXT3";
    case 0x35545844:
      return "DXT5";
    case 0x31495441:
      return "ATI1";
    case 0x32495441:
      return "ATI2";
    case 0x20374342:
      return "BC7";
    default:
      return String(format);
  }
}

function formatG9Name(format: number): string {
  return TextureFormatG9[format] ?? String(format);
}

console.log("");
console.log(`files found          ${files.length} (${selected.length} selected)`);
console.log(`files compared       ${totals.filesCompared}`);
console.log(`skipped: not RSC7    ${totals.skippedNotRsc7}`);
console.log(`skipped: gtatool     ${totals.skippedGtatool}`);
console.log(`skipped: TS parse    ${totals.skippedParse}`);
console.log(`textures compared    ${totals.textures}`);
console.log(`oracle declined      ${totals.oracleDeclined}`);
console.log(`mip levels compared  ${totals.mips}`);
console.log(`bytes compared       ${totals.bytes.toLocaleString()}`);
if (declinedReasons.size > 0) {
  console.log("CodeWalker declined to export these (its error, not the parser's):");
  for (const [why, n] of declinedReasons) console.log(`  ${String(n).padStart(5)}x ${why}`);
}
console.log("by format:");
for (const [k, v] of Object.entries(totals.byFormat).sort((a, b) => b[1].bytes - a[1].bytes)) {
  console.log(
    `  ${k.padEnd(24)} ${String(v.textures).padStart(6)} textures  ` +
      `${String(v.mips).padStart(7)} mips  ${v.bytes.toLocaleString().padStart(15)} bytes`
  );
}
console.log("");
console.log("Note: this compares COMPRESSED BYTES, not decoded pixels - CodeWalker's own");
console.log("software decoder is the oracle for BC1-BC5 only, and it has none for BC7.");
console.log("Decoded BC7 pixels are verified separately against a GPU: verify-bc7.ts.");

// A run that compared nothing is a failure, not a pass.
if (totals.mips === 0) {
  console.error("\nFAIL: compared zero mip levels - the corpus or ground truth produced no data");
  process.exit(1);
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`);
  for (const f of failures.slice(0, 40)) console.error(`  ${f}`);
  if (failures.length > 40) console.error(`  ... and ${failures.length - 40} more`);
  process.exit(1);
}

console.log("\nPASS: TS parser matches CodeWalker on every compared texture and byte.");
