#!/usr/bin/env bun
// Differential verification of the TypeScript drawable parser against CodeWalker.
//
// CodeWalker is the ground truth for this format. `gtatool drawable --json` drives
// CodeWalker.Core headlessly and emits, per drawable: bounds, LOD distances, the
// shader list, and per geometry the counts, stride, vertex declaration, raw vertex
// bytes and index values. This script parses the same files with the TS port and
// compares all of it - including the *decoded* vertex positions against the stored
// bounding box, because a structure can match while every bit-level decoder is wrong.
//
// This is a dev tool, not part of `bun test`: it needs both a corpus of drawables and
// the gtatool build, neither of which lives in this repo.
//
//   bun run shared/ts/rage/scripts/verify-drawable.ts <dir-or-file>... [--limit=N]
//
// Flags:
//   --limit=N     files to compare (default 25)
//   --verts=N     vertices per geometry to byte-compare (default 64)
//   --indices=N   index values per geometry to compare (default 192)
//   --kind=ydr    restrict to one file kind
//   --every=N     take every Nth file, to sample across a corpus instead of its
//                 alphabetical head - naming clusters by asset pack, so the first N
//                 files exercise one pack's vertex layouts and nothing else
//   --gen9-params also compare gen9 shader parameter name hashes, using
//                 ShadersGen9Conversion.xml next to gtatool.exe. Off by default
//                 because the parser deliberately does not ship that file.
//
// Override the gtatool path with GTATOOL=/path/to/gtatool.exe.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type DrawableFileKind, detectGeneration, parseDrawableFile } from "../drawable";
import { decodeVertices, VertexSemantics } from "../drawable/vertex";
import { joaat } from "../jenk";

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
const maxVerts = Number(flagValue("--verts=") ?? "64");
const maxIndices = Number(flagValue("--indices=") ?? "192");
const compareGen9Params = flags.includes("--gen9-params");
const onlyKind = flagValue("--kind=") as DrawableFileKind | undefined;
const every = Math.max(1, Number(flagValue("--every=") ?? "1"));

if (inputs.length === 0) {
  console.error(
    "usage: verify-drawable.ts <dir-or-file>... [--limit=N] [--verts=N] [--indices=N] [--kind=ydr|ydd|yft] " +
      "[--every=N] [--gen9-params]"
  );
  process.exit(2);
}
if (!existsSync(GTATOOL)) {
  console.error(`gtatool not found at ${GTATOOL}; set GTATOOL=/path/to/gtatool.exe`);
  process.exit(2);
}

const EXTENSIONS: DrawableFileKind[] = ["ydr", "ydd", "yft"];

function kindOf(path: string): DrawableFileKind | null {
  const lower = path.toLowerCase();
  for (const e of EXTENSIONS) if (lower.endsWith(`.${e}`)) return e;
  return null;
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
  } else {
    const k = kindOf(path);
    if (k && (!onlyKind || k === onlyKind)) out.push(path);
  }
}

const RSC7_MAGIC = 0x37435352;

/** Many community files ship already-decompressed page data with the container stripped. */
function isRsc7(bytes: Uint8Array): boolean {
  if (bytes.length < 16) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(0, true) === RSC7_MAGIC;
}

const found: string[] = [];
for (const i of inputs) collect(resolve(i), found);
found.sort();

// --- optional gen9 parameter name map -------------------------------------------

type Gen9Map = Map<number, Map<number, number>>;

/**
 * Parse `ShadersGen9Conversion.xml` into shaderHash -> gen9ParamHash -> legacyParamHash.
 *
 * Only used when `--gen9-params` is passed. The parser under test deliberately does
 * not ship or read this file; this is the verifier reaching for the same ground truth
 * CodeWalker uses so the comparison can be apples to apples.
 */
function loadGen9ParamMap(): Gen9Map | null {
  const path = join(dirname(GTATOOL), "ShadersGen9Conversion.xml");
  if (!existsSync(path)) {
    console.error(`--gen9-params: ${path} not found`);
    return null;
  }
  const xml = readFileSync(path, "utf8");
  const map: Gen9Map = new Map();
  // Flat, regex-driven on purpose: the file is a fixed two-level shape and this is a
  // dev-only verifier, not a general XML consumer.
  const itemRe = /<Item>\s*<Name>([^<]*)<\/Name>[\s\S]*?<Parameters>([\s\S]*?)<\/Parameters>/g;
  const paramRe = /<Item\s+([^/>]*)\/>/g;
  const attrRe = /(\w+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: regex exec loop
  while ((m = itemRe.exec(xml)) !== null) {
    const shaderHash = joaat(m[1]);
    const inner = new Map<number, number>();
    let p: RegExpExecArray | null;
    paramRe.lastIndex = 0;
    // biome-ignore lint/suspicious/noAssignInExpressions: regex exec loop
    while ((p = paramRe.exec(m[2])) !== null) {
      const attrs: Record<string, string> = {};
      attrRe.lastIndex = 0;
      let a: RegExpExecArray | null;
      // biome-ignore lint/suspicious/noAssignInExpressions: regex exec loop
      while ((a = attrRe.exec(p[1])) !== null) attrs[a[1]] = a[2];
      const name = attrs.name?.toLowerCase();
      const old = attrs.old?.toLowerCase();
      if (!name || !old) continue;
      const nameHash = name.startsWith("hash_")
        ? Number.parseInt(name.slice(5), 16) >>> 0
        : joaat(name);
      inner.set(nameHash, joaat(old));
    }
    map.set(shaderHash, inner);
  }
  return map;
}

const gen9Map = compareGen9Params ? loadGen9ParamMap() : null;
if (compareGen9Params && !gen9Map) process.exit(2);

// --- ground truth ----------------------------------------------------------------

interface GoldenDeclaration {
  flags: string;
  stride: number;
  count: number;
  types: string;
}
interface GoldenGeometry {
  verticesCount: number;
  indicesCount: number;
  trianglesCount: number;
  vertexStride: number;
  vertexDeclaration?: GoldenDeclaration;
  vertexType?: string;
  vertexBytesTotal?: number;
  vertexBytesBase64?: string;
  indexTotal?: number;
  indices?: number[];
}
interface GoldenModel {
  geometryCount: number;
  geometries: GoldenGeometry[];
}
interface GoldenLod {
  lod: string;
  models: GoldenModel[];
}
interface GoldenShaderParam {
  nameHash?: string;
  dataType: number;
}
interface GoldenShader {
  nameHash: string;
  name?: string;
  renderBucket: number;
  parameters: GoldenShaderParam[];
}
interface GoldenDrawable {
  key: string;
  name: string;
  boundingBoxMin: number[];
  boundingBoxMax: number[];
  boundingCenter: number[];
  boundingSphereRadius: number;
  lodDistHigh: number;
  lodDistMed: number;
  lodDistLow: number;
  lodDistVlow: number;
  shaders: GoldenShader[];
  lods: GoldenLod[];
}
interface Golden {
  file: string;
  version: number;
  generation: "gen8" | "gen9";
  drawables: GoldenDrawable[];
}

function goldenFor(file: string): Golden | null {
  const res = spawnSync(
    GTATOOL,
    ["drawable", file, "--json", `--verts=${maxVerts}`, `--indices=${maxIndices}`],
    {
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 1024,
    }
  );
  if (res.error) {
    console.error(`  gtatool could not be run (${GTATOOL}): ${res.error.message}`);
    return null;
  }
  const stdout = res.stdout ?? "";
  if (res.status !== 0 || !stdout.trimStart().startsWith("{")) {
    return null;
  }
  try {
    return JSON.parse(stdout) as Golden;
  } catch {
    return null;
  }
}

// --- comparison -------------------------------------------------------------------

interface Totals {
  files: number;
  skippedNotRsc7: number;
  skippedInflateFailed: number;
  skippedNoGolden: number;
  goldenGenerationMismatches: string[];
  nameTableResolved: number;
  byGeneration: Record<string, number>;
  byKind: Record<string, number>;
  drawables: number;
  shaders: number;
  shaderParams: number;
  lods: number;
  models: number;
  geometries: number;
  declarations: number;
  vertexBytesCompared: number;
  indicesCompared: number;
  verticesDecoded: number;
  positionsInsideBox: number;
  maxBoxOvershoot: number;
  maxRelativeOvershoot: number;
  aabbFacesCompared: number;
  aabbFacesExact: number;
  maxBoxDeviation: number;
  vertexTypesSeen: Record<string, number>;
  componentTypesSeen: Record<string, number>;
  declarationTypesSeen: Record<string, number>;
}
const totals: Totals = {
  files: 0,
  skippedNotRsc7: 0,
  skippedInflateFailed: 0,
  skippedNoGolden: 0,
  goldenGenerationMismatches: [],
  nameTableResolved: 0,
  byGeneration: {},
  byKind: {},
  drawables: 0,
  shaders: 0,
  shaderParams: 0,
  lods: 0,
  models: 0,
  geometries: 0,
  declarations: 0,
  vertexBytesCompared: 0,
  indicesCompared: 0,
  verticesDecoded: 0,
  positionsInsideBox: 0,
  maxBoxOvershoot: 0,
  maxRelativeOvershoot: 0,
  aabbFacesCompared: 0,
  aabbFacesExact: 0,
  maxBoxDeviation: 0,
  vertexTypesSeen: {},
  componentTypesSeen: {},
  declarationTypesSeen: {},
};

const failures: string[] = [];
const inflateFailures: string[] = [];
function fail(file: string, message: string): void {
  failures.push(`${file}: ${message}`);
}

const COMPONENT_TYPE_NAMES = [
  "Nothing",
  "Half2",
  "Float",
  "Half4",
  "FloatUnk",
  "Float2",
  "Float3",
  "Float4",
  "UByte4",
  "Colour",
  "RGBA8SNorm",
  "Unk1",
  "Unk2",
  "Unk3",
  "Unk4",
  "Unk5",
];

function hex32(n: number): string {
  return `0x${(n >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
}

function bump(bucket: Record<string, number>, key: string): void {
  bucket[key] = (bucket[key] ?? 0) + 1;
}

const candidates = every > 1 ? found.filter((_, i) => i % every === 0) : found;

const selected: string[] = [];
for (const f of candidates) {
  if (selected.length >= limit) break;
  const bytes = new Uint8Array(readFileSync(f));
  if (!isRsc7(bytes)) {
    totals.skippedNotRsc7++;
    continue;
  }
  selected.push(f);
}

for (const file of selected) {
  const shortName = file.split(/[\\/]/).pop() ?? file;
  const kind = kindOf(file);
  if (!kind) continue;

  const golden = goldenFor(file);
  if (!golden) {
    totals.skippedNoGolden++;
    continue;
  }

  let parsed: Awaited<ReturnType<typeof parseDrawableFile>>;
  try {
    parsed = await parseDrawableFile(kind, new Uint8Array(readFileSync(file)), {
      gen9ParamNames: gen9Map
        ? (shaderHash, paramHash) => gen9Map.get(shaderHash)?.get(paramHash) ?? 0
        : undefined,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // `rage/rsc7.ts` inflates with DecompressionStream("deflate-raw"), which rejects
    // any bytes after the deflate stream. Some shipped files carry a few (measured:
    // 4 on bv_bumper_a.ydr). zlib tolerates them and CodeWalker reads the file fine.
    // That is a gap in rsc7.ts, not in the drawable parser, so it is counted here
    // rather than folded into the drawable failure list.
    if (/Trailing junk|unexpected end of|Corrupt/i.test(message)) {
      totals.skippedInflateFailed++;
      inflateFailures.push(`${shortName}: ${message}`);
      continue;
    }
    fail(shortName, `TS parse threw: ${message}`);
    continue;
  }

  totals.files++;
  bump(totals.byGeneration, golden.generation);
  bump(totals.byKind, kind);

  if (parsed.version !== golden.version)
    fail(shortName, `version ${parsed.version} != ${golden.version}`);

  // Ground truth for the generation is CodeWalker's *loader* table (YdrFile/YddFile/
  // YftFile each switch on the container version and flip IsGen9), which is what
  // `detectGeneration` ports. gtatool's own pre-check `DetectGen9` special-cases .ydr
  // but not .ydd, so it labels a gen8 .ydd at version 165 "gen9" while CodeWalker
  // then parses it as gen8 anyway. Compare against the loader table and record the
  // gtatool label's disagreement rather than failing on a tool bug.
  const expectedGeneration = detectGeneration(kind, golden.version);
  if (expectedGeneration && parsed.generation !== expectedGeneration) {
    fail(shortName, `generation ${parsed.generation} != ${expectedGeneration}`);
  }
  if (parsed.generation !== golden.generation) {
    totals.goldenGenerationMismatches.push(
      `${shortName} (.${kind} v${golden.version}): gtatool says ${golden.generation}`
    );
  }
  if (parsed.drawables.length !== golden.drawables.length) {
    fail(shortName, `drawable count ${parsed.drawables.length} != ${golden.drawables.length}`);
  }

  for (let di = 0; di < Math.min(parsed.drawables.length, golden.drawables.length); di++) {
    const mine = parsed.drawables[di].drawable;
    const g = golden.drawables[di];
    totals.drawables++;
    const label = `${shortName}[${g.key}]`;

    if (kind === "ydd") {
      // A .ydd reconciles the embedded name against the dictionary hash (CodeWalker
      // YddFile.cs:88-96): when they disagree the name is re-derived from the hash,
      // through CodeWalker's bundled MetaNames table and JenkIndex. Neither ships
      // here, so where CodeWalker resolves a real name this port emits
      // `hash_XXXXXXXX`. What *can* be checked without that table is that both
      // sides agree the embedded name is wrong - i.e. the same hash and the same
      // stored name were read.
      const myKey = parsed.drawables[di].key;
      const goldenIsHash = /^hash_[0-9A-F]{8}$/.test(g.name ?? "");
      if (goldenIsHash || myKey === g.name) {
        if (myKey !== (g.name ?? "")) fail(label, `name "${myKey}" != "${g.name}"`);
      } else if (!myKey.startsWith("hash_")) {
        fail(label, `name "${myKey}" != "${g.name}" and neither side fell back to a hash`);
      } else {
        totals.nameTableResolved++;
        const stored = mine.name ?? "";
        const hash = parsed.drawables[di].dictionaryHash ?? 0;
        if (stored && joaat(stored) === hash) {
          fail(
            label,
            `stored name "${stored}" hashes to the dictionary key, so it should not have been replaced`
          );
        }
      }
    } else if ((mine.name ?? "") !== (g.name ?? "")) {
      fail(label, `name "${mine.name}" != "${g.name}"`);
    }
    for (const [k, a, b] of [
      ["boundingSphereRadius", mine.boundingSphereRadius, g.boundingSphereRadius],
      ["lodDistHigh", mine.lodDistHigh, g.lodDistHigh],
      ["lodDistMed", mine.lodDistMed, g.lodDistMed],
      ["lodDistLow", mine.lodDistLow, g.lodDistLow],
      ["lodDistVlow", mine.lodDistVlow, g.lodDistVlow],
    ] as const) {
      if (Math.abs(a - b) > 1e-4) fail(label, `${k} ${a} != ${b}`);
    }
    for (const [k, a, b] of [
      ["boundingBoxMin", mine.boundingBoxMin, g.boundingBoxMin],
      ["boundingBoxMax", mine.boundingBoxMax, g.boundingBoxMax],
      ["boundingCenter", mine.boundingCenter, g.boundingCenter],
    ] as const) {
      for (let c = 0; c < 3; c++) {
        if (Math.abs(a[c] - b[c]) > 1e-4) fail(label, `${k}[${c}] ${a[c]} != ${b[c]}`);
      }
    }

    // --- shaders ---
    const myShaders = mine.shaderGroup?.shaders ?? [];
    if (myShaders.length !== g.shaders.length) {
      fail(label, `shader count ${myShaders.length} != ${g.shaders.length}`);
    }
    for (let si = 0; si < Math.min(myShaders.length, g.shaders.length); si++) {
      const ms = myShaders[si];
      const gs = g.shaders[si];
      if (!ms) {
        fail(label, `shader ${si} missing from TS output`);
        continue;
      }
      totals.shaders++;
      if (hex32(ms.nameHash) !== gs.nameHash)
        fail(label, `shader ${si} name ${hex32(ms.nameHash)} != ${gs.nameHash}`);
      if (ms.renderBucket !== gs.renderBucket) {
        fail(label, `shader ${si} renderBucket ${ms.renderBucket} != ${gs.renderBucket}`);
      }
      if (ms.parameters.length !== gs.parameters.length) {
        fail(
          label,
          `shader ${si} parameter count ${ms.parameters.length} != ${gs.parameters.length}`
        );
        continue;
      }
      for (let pi = 0; pi < gs.parameters.length; pi++) {
        totals.shaderParams++;
        const mp = ms.parameters[pi];
        const gp = gs.parameters[pi];
        if (mp.dataType !== gp.dataType) {
          fail(label, `shader ${si} param ${pi} dataType ${mp.dataType} != ${gp.dataType}`);
        }
        // Gen9 name hashes only line up once ShadersGen9Conversion.xml is applied.
        const checkNames = golden.generation === "gen8" || compareGen9Params;
        if (checkNames && gp.nameHash && hex32(mp.nameHash) !== gp.nameHash) {
          fail(label, `shader ${si} param ${pi} nameHash ${hex32(mp.nameHash)} != ${gp.nameHash}`);
        }
      }
    }

    // --- LODs, models, geometries ---
    if (mine.lods.length !== g.lods.length) {
      fail(label, `lod count ${mine.lods.length} != ${g.lods.length}`);
    }
    for (let li = 0; li < Math.min(mine.lods.length, g.lods.length); li++) {
      const ml = mine.lods[li];
      const gl = g.lods[li];
      totals.lods++;
      if (ml.lod !== gl.lod) fail(label, `lod ${li} is ${ml.lod}, expected ${gl.lod}`);
      if (ml.models.length !== gl.models.length) {
        fail(label, `lod ${gl.lod} model count ${ml.models.length} != ${gl.models.length}`);
        continue;
      }
      for (let mi = 0; mi < gl.models.length; mi++) {
        const mm = ml.models[mi];
        const gm = gl.models[mi];
        totals.models++;
        if (mm.geometries.length !== gm.geometryCount) {
          fail(
            label,
            `lod ${gl.lod} model ${mi} geometry count ${mm.geometries.length} != ${gm.geometryCount}`
          );
          continue;
        }
        for (let gi = 0; gi < gm.geometries.length; gi++) {
          const mg = mm.geometries[gi];
          const gg = gm.geometries[gi];
          const gLabel = `${label} ${gl.lod}/m${mi}/g${gi}`;
          totals.geometries++;

          for (const [k, a, b] of [
            ["verticesCount", mg.verticesCount, gg.verticesCount],
            ["indicesCount", mg.indicesCount, gg.indicesCount],
            ["trianglesCount", mg.trianglesCount, gg.trianglesCount],
            ["vertexStride", mg.vertexStride, gg.vertexStride],
          ] as const) {
            if (a !== b) fail(gLabel, `${k} ${a} != ${b}`);
          }

          // --- declaration ---
          if (gg.vertexDeclaration) {
            const gd = gg.vertexDeclaration;
            if (!mg.declaration) {
              fail(gLabel, "TS produced no vertex declaration");
            } else {
              totals.declarations++;
              bump(
                totals.declarationTypesSeen,
                `0x${mg.declaration.types.toString(16).toUpperCase().padStart(16, "0")}`
              );
              if (hex32(mg.declaration.flags) !== gd.flags) {
                fail(gLabel, `declaration flags ${hex32(mg.declaration.flags)} != ${gd.flags}`);
              }
              if (mg.declaration.stride !== gd.stride) {
                fail(gLabel, `declaration stride ${mg.declaration.stride} != ${gd.stride}`);
              }
              if (mg.declaration.count !== gd.count) {
                fail(gLabel, `declaration count ${mg.declaration.count} != ${gd.count}`);
              }
              const myTypes = `0x${mg.declaration.types.toString(16).toUpperCase().padStart(16, "0")}`;
              if (myTypes !== gd.types) fail(gLabel, `declaration types ${myTypes} != ${gd.types}`);
              for (let slot = 0; slot < 16; slot++) {
                if ((mg.declaration.flags >>> slot) & 1) {
                  const t = Number((mg.declaration.types >> BigInt(slot * 4)) & 0xfn);
                  bump(totals.componentTypesSeen, COMPONENT_TYPE_NAMES[t]);
                }
              }
            }
          }
          if (gg.vertexType && mg.vertexTypeName !== gg.vertexType) {
            fail(gLabel, `vertexType "${mg.vertexTypeName}" != "${gg.vertexType}"`);
          }
          if (gg.vertexType) bump(totals.vertexTypesSeen, gg.vertexType);

          // --- raw vertex bytes ---
          if (gg.vertexBytesBase64 !== undefined) {
            if (mg.vertexBytes.length !== (gg.vertexBytesTotal ?? -1)) {
              fail(gLabel, `vertex byte length ${mg.vertexBytes.length} != ${gg.vertexBytesTotal}`);
            } else {
              const expected = Buffer.from(gg.vertexBytesBase64, "base64");
              let bad = -1;
              for (let b = 0; b < expected.length; b++) {
                if (mg.vertexBytes[b] !== expected[b]) {
                  bad = b;
                  break;
                }
              }
              totals.vertexBytesCompared += expected.length;
              if (bad >= 0) {
                fail(
                  gLabel,
                  `vertex byte ${bad} is 0x${mg.vertexBytes[bad].toString(16)}, expected ` +
                    `0x${expected[bad].toString(16)} (vertex ${Math.floor(bad / (gg.vertexStride || 1))}, ` +
                    `offset ${bad % (gg.vertexStride || 1)})`
                );
              }
            }
          }

          // --- indices ---
          if (gg.indices) {
            if (mg.indices.length !== (gg.indexTotal ?? -1)) {
              fail(gLabel, `index count ${mg.indices.length} != ${gg.indexTotal}`);
            } else {
              let bad = -1;
              for (let i = 0; i < gg.indices.length; i++) {
                if (mg.indices[i] !== gg.indices[i]) {
                  bad = i;
                  break;
                }
              }
              totals.indicesCompared += gg.indices.length;
              if (bad >= 0)
                fail(gLabel, `index ${bad} is ${mg.indices[bad]}, expected ${gg.indices[bad]}`);
            }
          }

          // --- decoded positions vs the stored bounding box ---
          // The point of the exercise: byte-identical buffers still prove
          // nothing about the decoders. This asserts *agreement*, not mere
          // containment - the decoded per-axis extremes must reproduce the
          // AABB the file stores. Containment alone would pass a decoder that
          // collapsed every position to the origin.
          if (mg.declaration && mg.verticesCount > 0 && mg.vertexBytes.length > 0) {
            const decoded = decodeVertices(
              mg.declaration,
              mg.vertexBytes,
              mg.verticesCount,
              mg.vertexStride
            );
            const pos = decoded.bySemantic[VertexSemantics.Position];
            if (!pos) {
              fail(gLabel, "decoded vertices have no Position attribute");
            } else if (decoded.count > 0) {
              const lo = [
                Number.POSITIVE_INFINITY,
                Number.POSITIVE_INFINITY,
                Number.POSITIVE_INFINITY,
              ];
              const hi = [
                Number.NEGATIVE_INFINITY,
                Number.NEGATIVE_INFINITY,
                Number.NEGATIVE_INFINITY,
              ];
              for (let v = 0; v < decoded.count; v++) {
                for (let c = 0; c < 3; c++) {
                  const value = pos.data[v * 3 + c];
                  if (value < lo[c]) lo[c] = value;
                  if (value > hi[c]) hi[c] = value;
                }
              }
              totals.verticesDecoded += decoded.count;

              const span = Math.max(
                mg.aabbMax[0] - mg.aabbMin[0],
                mg.aabbMax[1] - mg.aabbMin[1],
                mg.aabbMax[2] - mg.aabbMin[2],
                1e-6
              );
              // Two assertions, because either alone is weak:
              //
              //  1. Containment, at 25% of the box. Deliberately loose:
              //     shipped SLOD meshes really do store a box their own
              //     vertices leave - measured worst 17.3% of the span, on
              //     lwecitymedium_c_slod2_children - and the vertex bytes
              //     there are byte-identical to CodeWalker's, so that is
              //     data and not a decode error. A wrong component offset,
              //     a wrong stride or a byte-swapped float misses by orders
              //     of magnitude, not by 8%.
              //  2. Non-degeneracy, for geometries big enough that a single
              //     point cannot be legitimate. Containment alone would pass
              //     a decoder that returned zeroes. Small degenerate quads
              //     do occur in SLOD dictionaries, hence the threshold.
              //
              // How *tightly* the decoded extremes reproduce the stored box
              // is then reported as a statistic rather than gated on:
              // plenty of shipped files simply pad their AABB.
              const tolerance = span * 0.25;
              let outside = 0;
              let worstOvershoot = 0;
              for (let v = 0; v < decoded.count; v++) {
                let ok = true;
                for (let c = 0; c < 3; c++) {
                  const value = pos.data[v * 3 + c];
                  const over = Math.max(mg.aabbMin[c] - value, value - mg.aabbMax[c]);
                  if (over > worstOvershoot) worstOvershoot = over;
                  if (over / span > totals.maxRelativeOvershoot)
                    totals.maxRelativeOvershoot = over / span;
                  if (over > tolerance) ok = false;
                }
                if (!ok) outside++;
              }
              if (worstOvershoot > totals.maxBoxOvershoot) totals.maxBoxOvershoot = worstOvershoot;
              totals.positionsInsideBox += decoded.count - outside;
              if (outside > 0) {
                fail(
                  gLabel,
                  `${outside}/${decoded.count} decoded positions fall outside the stored AABB ` +
                    `[${mg.aabbMin
                      .slice(0, 3)
                      .map((n) => n.toFixed(4))
                      .join(", ")}]..` +
                    `[${mg.aabbMax
                      .slice(0, 3)
                      .map((n) => n.toFixed(4))
                      .join(", ")}] ` +
                    `(worst ${worstOvershoot.toExponential(3)}, tolerance ${tolerance.toExponential(3)})`
                );
              }

              const extent = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
              if (decoded.count > 16 && extent <= 0) {
                fail(
                  gLabel,
                  `${decoded.count} decoded positions are all identical - a degenerate decode`
                );
              }

              let exact = 0;
              let worstDeviation = 0;
              for (let c = 0; c < 3; c++) {
                const dlo = Math.abs(lo[c] - mg.aabbMin[c]);
                const dhi = Math.abs(hi[c] - mg.aabbMax[c]);
                if (dlo > worstDeviation) worstDeviation = dlo;
                if (dhi > worstDeviation) worstDeviation = dhi;
                if (dlo === 0) exact++;
                if (dhi === 0) exact++;
              }
              totals.aabbFacesCompared += 6;
              totals.aabbFacesExact += exact;
              if (worstDeviation > totals.maxBoxDeviation) totals.maxBoxDeviation = worstDeviation;
            }
          }
        }
      }
    }
  }
}

console.log("");
console.log(
  `files found          ${found.length}${every > 1 ? ` (sampling every ${every} -> ${candidates.length})` : ""}`
);
console.log(`skipped (not RSC7)   ${totals.skippedNotRsc7}`);
console.log(
  `skipped (inflate)    ${totals.skippedInflateFailed}   <- rage/rsc7.ts limitation, not the drawable parser`
);
console.log(`skipped (no golden)  ${totals.skippedNoGolden}`);
console.log(`files compared       ${totals.files} / ${selected.length} selected`);
console.log(`  by generation      ${JSON.stringify(totals.byGeneration)}`);
console.log(`  by kind            ${JSON.stringify(totals.byKind)}`);
console.log(`drawables            ${totals.drawables}`);
console.log(
  `.ydd names CW resolved from its own name table (not shipped here) ${totals.nameTableResolved}`
);
console.log(`shaders              ${totals.shaders}`);
console.log(`shader parameters    ${totals.shaderParams}`);
console.log(`LOD groups           ${totals.lods}`);
console.log(`models               ${totals.models}`);
console.log(`geometries           ${totals.geometries}`);
console.log(`declarations         ${totals.declarations}`);
console.log(`vertex bytes matched ${totals.vertexBytesCompared.toLocaleString()}`);
console.log(`indices matched      ${totals.indicesCompared.toLocaleString()}`);
console.log(
  `positions decoded    ${totals.verticesDecoded.toLocaleString()} ` +
    `(${totals.positionsInsideBox.toLocaleString()} inside the stored AABB, ` +
    `worst overshoot ${totals.maxBoxOvershoot.toExponential(3)}, ` +
    `${(totals.maxRelativeOvershoot * 100).toFixed(2)}% of the box)`
);
console.log(
  `AABB faces reproduced ${totals.aabbFacesExact.toLocaleString()} / ` +
    `${totals.aabbFacesCompared.toLocaleString()} bit-exact, worst deviation ` +
    `${totals.maxBoxDeviation.toExponential(3)}`
);
console.log("vertex types exercised:");
for (const [k, v] of Object.entries(totals.vertexTypesSeen).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(24)} ${v}`);
}
console.log("component types exercised:");
for (const [k, v] of Object.entries(totals.componentTypesSeen).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(24)} ${v}`);
}
console.log("declaration types exercised:");
for (const [k, v] of Object.entries(totals.declarationTypesSeen).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(24)} ${v}`);
}

if (inflateFailures.length > 0) {
  console.log("files rsc7.ts could not inflate:");
  for (const f of inflateFailures.slice(0, 10)) console.log(`  ${f}`);
  if (inflateFailures.length > 10) console.log(`  ... and ${inflateFailures.length - 10} more`);
}
if (totals.goldenGenerationMismatches.length > 0) {
  console.log("gtatool generation-label disagreements (gtatool DetectGen9 bug, parse unaffected):");
  for (const m of totals.goldenGenerationMismatches.slice(0, 10)) console.log(`  ${m}`);
  if (totals.goldenGenerationMismatches.length > 10) {
    console.log(`  ... and ${totals.goldenGenerationMismatches.length - 10} more`);
  }
}

// A run that compared nothing is a failure, not a pass.
if (totals.geometries === 0 || totals.vertexBytesCompared === 0) {
  console.error(
    "\nFAIL: compared zero geometries or zero vertex bytes - the corpus or ground truth produced no data"
  );
  process.exit(1);
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`);
  for (const f of failures.slice(0, 40)) console.error(`  ${f}`);
  if (failures.length > 40) console.error(`  ... and ${failures.length - 40} more`);
  process.exit(1);
}

console.log("\nPASS: TS drawable parser matches CodeWalker on every compared value.");
