#!/usr/bin/env bun
// End-to-end probe: a real .ycd on disk -> @tlib/shared/rage parser -> rage-viewer
// skeleton + THREE.AnimationClip.
//
// The unit tests on each side stub at the boundary between them (the parser is verified
// against CodeWalker; the clip builder is tested against synthetic animations). This
// script is the only thing that exercises the actual seam, which is where two separately
// built halves fail to meet.
//
// Dev tool, not part of `bun test`: it needs a .ycd corpus and the gitignored,
// Rockstar-derived skeletons in assets/, neither of which is in this repo.
//
//   bun run shared/ts/rage-viewer/scripts/probe-end-to-end.ts <file.ycd>... [--skeleton=PATH]

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseYcd } from "../../rage/ycd";
import { TrackType } from "../../rage/ycd/clip";
import { buildAnimationClip } from "../anim-clip";
import { type AnimationKind, classifyAnimation, isPreviewableOnPed } from "../classify";
import { buildSkeleton, parseSkeletonJson } from "../skeleton";

// A throwing top-level-await script exits 0 with no output, which would make this a
// probe that reports success having proved nothing.
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
const files = args.filter((a) => !a.startsWith("--"));
const skeletonPath = resolve(
  flags.find((f) => f.startsWith("--skeleton="))?.slice("--skeleton=".length) ??
    resolve(import.meta.dir, "../../../../assets/rage/skeletons/mp_m_freemode_01.json")
);

if (files.length === 0) {
  console.error("usage: probe-end-to-end.ts <file.ycd>... [--skeleton=PATH]");
  process.exit(2);
}
if (!existsSync(skeletonPath)) {
  console.error(`skeleton not found: ${skeletonPath}`);
  console.error("generate it with: tools/gtatool.sh skeleton <ped>.yft --out=<path>");
  process.exit(2);
}

const skeleton = buildSkeleton(parseSkeletonJson(JSON.parse(readFileSync(skeletonPath, "utf8"))));
console.log(
  `skeleton ${skeletonPath.split(/[\\/]/).pop()}: ${skeleton.byTag.size} bones, ${skeleton.warnings.length} warnings`
);

let clipsBuilt = 0;
let tracksBound = 0;
let unresolved = 0;
let flipsFixed = 0;
let keyframes = 0;
let worstQuatDeviation = 0;
let worstQuatWhere = "(none)";
let degenerateQuats = 0;
const skippedKinds = new Map<number, number>();
const byKind = new Map<AnimationKind, string[]>();
const builtKinds = new Map<string, number>();
let failures = 0;
/** Files both this reader and CodeWalker refuse. Reported, not counted as failures. */
const rejected: string[] = [];

for (const file of files) {
  const name = file.split(/[\\/]/).pop() ?? file;
  let dict: Awaited<ReturnType<typeof parseYcd>>;
  try {
    dict = await parseYcd(new Uint8Array(readFileSync(file)));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // Some shipped .ycd files have the RSC7 container stripped. CodeWalker rejects
    // them identically (verified with gtatool), so this is a correct rejection of a
    // broken file, not a reader defect - but it is still printed, not swallowed.
    if (message.includes("not an RSC7 container")) {
      rejected.push(`${name}: ${message.split(".")[0]}`);
    } else {
      console.error(`  ${name}: parse failed: ${message}`);
      failures++;
    }
    continue;
  }

  for (const clip of dict.clips) {
    if (clip.content.kind !== "animation" || !clip.content.animation) continue;
    const anim = clip.content.animation;
    const where = `${name} / ${clip.shortName}`;

    // Classification is the exported function, not probe-local logic: marketplace
    // upload validation consumes exactly this, so the probe must exercise the same
    // code path rather than a lookalike.
    const classification = classifyAnimation(anim, skeleton);
    const list = byKind.get(classification.kind) ?? [];
    list.push(`${where}: ${classification.reason}`);
    byKind.set(classification.kind, list);

    try {
      const built = buildAnimationClip(anim, skeleton, { rootMotion: false });
      clipsBuilt++;
      tracksBound += built.boundTracks;
      unresolved += built.unresolvedBoneTags.length;
      flipsFixed += built.quaternionFlips;
      degenerateQuats += built.degenerateQuaternions;
      builtKinds.set(built.kind, (builtKinds.get(built.kind) ?? 0) + 1);
      for (const t of built.clip.tracks) keyframes += t.times.length;
      for (const s of built.skippedTracks) {
        skippedKinds.set(s.track, (skippedKinds.get(s.track) ?? 0) + 1);
      }
      if (built.maxQuaternionDeviation > worstQuatDeviation) {
        worstQuatDeviation = built.maxQuaternionDeviation;
        worstQuatWhere = where;
      }

      // The two things that must agree: anything the classifier says is
      // previewable on a ped MUST produce tracks, and anything that produces no
      // tracks must have a reason the classifier can name.
      if (isPreviewableOnPed(classification.kind) && built.boundTracks === 0) {
        console.error(`  ${where}: classified ${classification.kind} but bound 0 tracks`);
        failures++;
      }
      // A non-ped clip can still bind a track or two incidentally - tag 0 is
      // SKEL_ROOT on almost every rig - so the check is on the share that bound,
      // against the same threshold the classifier used.
      const boundShare =
        classification.bodyTracks > 0 ? built.boundTracks / classification.bodyTracks : 0;
      if (!isPreviewableOnPed(classification.kind) && boundShare >= 0.5) {
        console.error(
          `  ${where}: classified ${classification.kind} yet bound ${built.boundTracks} of ` +
            `${classification.bodyTracks} body tracks`
        );
        failures++;
      }
      if (built.classification.kind !== classification.kind) {
        console.error(`  ${where}: buildAnimationClip disagrees with classifyAnimation`);
        failures++;
      }
      if (classification.kind === "pose" && built.kind !== "pose") {
        console.error(`  ${where}: classified pose but built kind=${built.kind}`);
        failures++;
      }

      // Rotation tracks must be unit quaternions or the pose shears.
      for (const t of built.clip.tracks) {
        if (!t.name.endsWith(".quaternion")) continue;
        for (let i = 0; i + 3 < t.values.length; i += 4) {
          const len = Math.hypot(t.values[i], t.values[i + 1], t.values[i + 2], t.values[i + 3]);
          if (Math.abs(len - 1) > 1e-6) {
            console.error(`  ${where}: non-unit quaternion |q|=${len.toFixed(9)} in ${t.name}`);
            failures++;
            i = t.values.length;
          }
        }
      }
    } catch (e) {
      console.error(`  ${where}: clip build threw: ${e instanceof Error ? e.message : String(e)}`);
      failures++;
    }
  }
}

const trackName = (t: number) => TrackType[t] ?? `track${t}`;
console.log("");
console.log(`files              ${files.length} (${rejected.length} rejected as non-RSC7)`);
for (const r of rejected) console.log(`  ! ${r}`);
console.log(`clips built        ${clipsBuilt}`);
console.log(`tracks bound       ${tracksBound}`);
console.log(`keyframes emitted  ${keyframes}`);
console.log(`unresolved tags    ${unresolved}`);
console.log(`hemisphere flips   ${flipsFixed}`);
console.log(
  `skipped track kinds ${[...skippedKinds].map(([t, n]) => `${trackName(t)}=${n}`).join(" ") || "(none)"}`
);
console.log(
  `built kinds        ${[...builtKinds].map(([k, n]) => `${k}=${n}`).join(" ") || "(none)"}`
);
console.log(`worst |q|-1        ${worstQuatDeviation.toExponential(3)} at ${worstQuatWhere}`);
console.log(`degenerate quats   ${degenerateQuats}`);
console.log("");
console.log("classification:");
for (const [kind, entries] of [...byKind].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${kind.padEnd(16)} ${entries.length}`);
  if (kind !== "animation") for (const e of entries) console.log(`      - ${e}`);
}

if (clipsBuilt === 0) {
  console.error("\nFAIL: built zero clips - proved nothing");
  process.exit(1);
}
if (failures > 0) {
  console.error(`\nFAIL: ${failures} problem(s)`);
  process.exit(1);
}
const notPreviewable = [...byKind]
  .filter(([kind]) => !isPreviewableOnPed(kind))
  .reduce((n, [, entries]) => n + entries.length, 0);
console.log(
  "\nPASS: real .ycd -> parser -> AnimationClip. Every previewable clip bound tracks, every " +
    `quaternion unit-length, ${notPreviewable} clip(s) classified as not previewable on a ped rig.`
);
