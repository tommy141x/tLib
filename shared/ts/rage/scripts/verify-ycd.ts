#!/usr/bin/env bun
// Differential verification of the TypeScript .ycd parser against CodeWalker.
//
// CodeWalker is the ground truth for this format. gtatool drives CodeWalker.Core
// headlessly and emits per-frame sampled values as JSON; this script parses the same
// files with the TS port and compares every clip, track and frame.
//
// This is a dev tool, not part of `bun test`: it needs both a corpus of .ycd files and
// the gtatool build, neither of which live in this repo.
//
//   bun run shared/ts/rage/scripts/verify-ycd.ts <dir-or-file>... [--limit=N] [--eps=1e-4]
//
// Override the gtatool path with GTATOOL=/path/to/gtatool.sh.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseYcd } from "../ycd";
import { AnimChannelType } from "../ycd/channels";

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
const eps = Number(flagValue("--eps=") ?? "1e-4");

if (inputs.length === 0) {
  console.error("usage: verify-ycd.ts <dir-or-file>... [--limit=N] [--eps=1e-4]");
  process.exit(2);
}
if (!existsSync(GTATOOL)) {
  console.error(`gtatool not found at ${GTATOOL}; set GTATOOL=/path/to/gtatool.sh`);
  process.exit(2);
}

function collect(path: string, out: string[]): void {
  const st = statSync(path);
  if (st.isDirectory()) {
    for (const e of readdirSync(path)) collect(join(path, e), out);
  } else if (path.toLowerCase().endsWith(".ycd")) {
    out.push(path);
  }
}

const files: string[] = [];
for (const i of inputs) collect(resolve(i), files);
files.sort();
const selected = files.slice(0, limit);

/** CodeWalker's shape, as emitted by `gtatool ycd --json --frames`. */
interface GoldenTrack {
  index: number;
  boneId: number;
  track: number;
  isType7Quat?: boolean;
  channels?: ({ type: string; quatIndex?: number } | null)[];
  values?: number[][];
}
interface GoldenAnim {
  hash: string;
  frames: number;
  sequenceFrameLimit: number;
  duration: number;
  sequenceCount: number;
  tracks: GoldenTrack[];
}
interface GoldenClip {
  name: string;
  shortName: string;
  hash: string;
  type: string;
  animationHash?: string;
  startTime?: number;
  endTime?: number;
  rate?: number;
}
interface Golden {
  file: string;
  version: number;
  clips: GoldenClip[];
  animations: GoldenAnim[];
}

function goldenFor(file: string): Golden | null {
  const res = spawnSync(GTATOOL, ["ycd", file, "--json", "--frames"], {
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
  });
  if (res.error) {
    console.error(`  gtatool could not be run (${GTATOOL}): ${res.error.message}`);
    return null;
  }
  if (res.status !== 0 || !res.stdout?.trim().startsWith("{")) {
    console.error(
      `  gtatool failed (${res.status}): ${(res.stderr || res.stdout || "").trim().slice(0, 300)}`
    );
    return null;
  }
  return JSON.parse(res.stdout) as Golden;
}

const CHANNEL_NAME: Record<number, string> = {
  [AnimChannelType.StaticQuaternion]: "StaticQuaternion",
  [AnimChannelType.StaticVector3]: "StaticVector3",
  [AnimChannelType.StaticFloat]: "StaticFloat",
  [AnimChannelType.RawFloat]: "RawFloat",
  [AnimChannelType.QuantizeFloat]: "QuantizeFloat",
  [AnimChannelType.IndirectQuantizeFloat]: "IndirectQuantizeFloat",
  [AnimChannelType.LinearFloat]: "LinearFloat",
  [AnimChannelType.CachedQuaternion1]: "CachedQuaternion1",
  [AnimChannelType.CachedQuaternion2]: "CachedQuaternion2",
};

interface Totals {
  files: number;
  clips: number;
  animations: number;
  tracks: number;
  frames: number;
  components: number;
  maxDelta: number;
  channelsSeen: Record<string, number>;
}
const totals: Totals = {
  files: 0,
  clips: 0,
  animations: 0,
  tracks: 0,
  frames: 0,
  components: 0,
  maxDelta: 0,
  channelsSeen: {},
};
const failures: string[] = [];

function fail(file: string, message: string): void {
  failures.push(`${file}: ${message}`);
}

for (const file of selected) {
  const name = file.split(/[\\/]/).pop() ?? file;
  const golden = goldenFor(file);
  if (!golden) {
    fail(name, "no ground truth (gtatool failed)");
    continue;
  }

  let parsed: Awaited<ReturnType<typeof parseYcd>>;
  try {
    parsed = await parseYcd(new Uint8Array(readFileSync(file)));
  } catch (e) {
    fail(name, `TS parse threw: ${e instanceof Error ? e.message : String(e)}`);
    continue;
  }

  totals.files++;

  if (parsed.version !== golden.version) {
    fail(name, `version ${parsed.version} != ${golden.version}`);
  }
  if (parsed.clips.length !== golden.clips.length) {
    fail(name, `clip count ${parsed.clips.length} != ${golden.clips.length}`);
  }

  // Clips are hash-bucketed, so file order is not meaningful; match by hash.
  const mine = new Map(
    parsed.clips.map((c) => [`0x${(c.hash >>> 0).toString(16).toUpperCase().padStart(8, "0")}`, c])
  );
  for (const g of golden.clips) {
    const c = mine.get(g.hash);
    if (!c) {
      fail(name, `clip ${g.name} (${g.hash}) missing from TS output`);
      continue;
    }
    totals.clips++;
    if ((c.name ?? "") !== g.name) fail(name, `clip ${g.hash} name "${c.name}" != "${g.name}"`);
    if (g.type === "Animation" && c.content.kind === "animation") {
      for (const [k, a, b] of [
        ["startTime", c.content.startTime, g.startTime],
        ["endTime", c.content.endTime, g.endTime],
        ["rate", c.content.rate, g.rate],
      ] as const) {
        if (Math.abs((a ?? 0) - (b ?? 0)) > 1e-5) fail(name, `clip ${g.name} ${k} ${a} != ${b}`);
      }
    }
  }

  const goldenAnims = new Map(golden.animations.map((a) => [a.hash, a]));
  for (const a of parsed.animations) {
    const key = `0x${(a.hash >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
    const g = goldenAnims.get(key);
    if (!g) {
      fail(name, `animation ${key} missing from ground truth`);
      continue;
    }
    totals.animations++;

    if (a.frames !== g.frames) fail(name, `anim ${key} frames ${a.frames} != ${g.frames}`);
    if (a.sequenceFrameLimit !== g.sequenceFrameLimit) {
      fail(name, `anim ${key} seqFrameLimit ${a.sequenceFrameLimit} != ${g.sequenceFrameLimit}`);
    }
    if (Math.abs(a.duration - g.duration) > 1e-5) {
      fail(name, `anim ${key} duration ${a.duration} != ${g.duration}`);
    }
    if (a.sequences.length !== g.sequenceCount) {
      fail(name, `anim ${key} sequenceCount ${a.sequences.length} != ${g.sequenceCount}`);
    }
    if (a.boneIds.length !== g.tracks.length) {
      fail(name, `anim ${key} track count ${a.boneIds.length} != ${g.tracks.length}`);
      continue;
    }

    for (const gt of g.tracks) {
      const bone = a.boneIds[gt.index];
      if (bone.boneId !== gt.boneId || bone.track !== gt.track) {
        fail(
          name,
          `anim ${key} track ${gt.index} is ${bone.boneId}/${bone.track}, expected ${gt.boneId}/${gt.track}`
        );
        continue;
      }
      totals.tracks++;

      const track0 = a.sequences[0]?.tracks[gt.index];
      if (track0 && gt.channels) {
        if (gt.isType7Quat !== undefined && track0.isType7Quat !== gt.isType7Quat) {
          fail(
            name,
            `anim ${key} track ${gt.index} isType7Quat ${track0.isType7Quat} != ${gt.isType7Quat}`
          );
        }
        for (let ci = 0; ci < gt.channels.length; ci++) {
          const expected = gt.channels[ci];
          if (!expected) continue;
          const got = track0.channels[ci];
          const gotName = got ? CHANNEL_NAME[got.type] : "null";
          totals.channelsSeen[expected.type] = (totals.channelsSeen[expected.type] ?? 0) + 1;
          if (gotName !== expected.type) {
            fail(
              name,
              `anim ${key} track ${gt.index} channel ${ci} is ${gotName}, expected ${expected.type}`
            );
          }
        }
      }

      // The values are the point of the whole exercise: structure can match while
      // every bit-level decoder is wrong.
      if (!gt.values) continue;
      for (let f = 0; f < gt.values.length; f++) {
        const limitFrames = a.sequenceFrameLimit;
        const block = a.sequences[Math.floor(f / limitFrames)];
        const track = block?.tracks[gt.index];
        if (!track) {
          fail(name, `anim ${key} track ${gt.index} frame ${f}: no track data`);
          break;
        }
        const got = track.evaluateVector(f % limitFrames);
        totals.frames++;
        for (let c = 0; c < 4; c++) {
          const delta = Math.abs(got[c] - gt.values[f][c]);
          totals.components++;
          if (delta > totals.maxDelta) totals.maxDelta = delta;
          if (delta > eps) {
            fail(
              name,
              `anim ${key} track ${gt.index} (bone ${gt.boneId}/${gt.track}) frame ${f} comp ${c}: ` +
                `${got[c]} != ${gt.values[f][c]} (delta ${delta.toExponential(3)})`
            );
            f = gt.values.length; // one bad track is enough; stop flooding
            break;
          }
        }
      }
    }
  }
}

console.log("");
console.log(
  `files compared      ${totals.files} / ${selected.length} selected (${files.length} found)`
);
console.log(`clips               ${totals.clips}`);
console.log(`animations          ${totals.animations}`);
console.log(`tracks              ${totals.tracks}`);
console.log(`frames sampled      ${totals.frames}`);
console.log(`components compared ${totals.components}`);
console.log(`max abs delta       ${totals.maxDelta.toExponential(3)} (epsilon ${eps})`);
console.log("channel types exercised:");
for (const [k, v] of Object.entries(totals.channelsSeen).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(24)} ${v}`);
}

// A run that compared nothing is a failure, not a pass.
if (totals.components === 0) {
  console.error("\nFAIL: compared zero components - the corpus or ground truth produced no data");
  process.exit(1);
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`);
  for (const f of failures.slice(0, 40)) console.error(`  ${f}`);
  if (failures.length > 40) console.error(`  ... and ${failures.length - 40} more`);
  process.exit(1);
}

console.log("\nPASS: TS parser matches CodeWalker on every compared value.");
