# `@tlib/shared/rage-viewer`

three.js rendering for the readers in [`@tlib/shared/rage`](../rage/README.md).

`rage/` parses and has zero dependencies, so it stays headlessly testable and stays
out of the way of callers that only want data. Everything that needs `three` lives
here, with `three` as a **peer** dependency (`>=0.150.0`), matching `gizmo/`.

```ts
import { AnimViewerScene, PH_R_HAND_TAG } from "@tlib/shared/rage-viewer";
import { parseYcd } from "@tlib/shared/rage/ycd";

const viewer = new AnimViewerScene({ canvas, skeleton: await loadSkeletonJson() });
const dict = await parseYcd(new Uint8Array(await file.arrayBuffer()));
const clip = dict.clips.find((c) => c.shortName === "radio_check");
if (clip?.content.kind === "animation" && clip.content.animation) {
  viewer.setAnimation(clip.content.animation, clip.shortName ?? "clip");
}
viewer.attachProp("prop_cs_hand_radio", PH_R_HAND_TAG, [0.13, 0.05, 0.01, -113, 0, -60], {
  bounds: { min: [-0.03, -0.02, -0.09], max: [0.03, 0.03, 0.09] },
});
viewer.onPlacementChange = (record) => console.log(record); // feed a form
viewer.frameSkeleton();
viewer.play();
viewer.startLoop();
```

## Skeletons are never committed

Ped skeletons are Rockstar-derived and this repo is public MIT. Nothing here embeds
one: `buildSkeleton()` takes the parsed JSON the caller loaded. Regenerating the
files is documented in `rage/README.md`.

## Coordinate handling - one conversion, in one place

GTA is Z-up, three is Y-up. The conversion happens exactly once, in the `zUp` group
that wraps the whole rig (a -90 deg rotation about X). **Every bone local transform
below it stays in GTA space.**

That is not a detail, it is the reason `prop-attach.ts` needs no conversion at all.
A prop parented to a bone has a local position and rotation that are numerically
identical to the arguments `AttachEntityToEntity` takes, so the preview and the game
agree by construction rather than by a conversion someone has to remember to keep in
sync. `TransformControls` writes a dragged object's transform back in parent space,
which here *is* bone-local GTA space, so a drag produces a game-ready number with no
maths in between.

## The record this emits

`PropAttachment.getRecord()` produces exactly what tRadio's `RadioCreateAnimProp`
(`tRadio/client/cl_props.lua`) consumes:

```lua
{ model = "prop_cs_hand_radio", bone = 28422,
  placement = { x, y, z, rotX, rotY, rotZ } }
```

- `bone` is a bone **TAG**, not an index - `GetPedBoneIndex` maps tag to index. The
  default `28422` is the same default the Lua side applies.
- **28422 is `PH_R_Hand`, not `SKEL_R_Hand`.** Measured against both generated
  freemode skeletons: `PH_R_Hand` is tag 28422 and a child of `SKEL_R_Hand`, which is
  tag **57005**. The `PH_*` bones are the dedicated prop-attach helpers, so 28422 is
  the correct default - but it is routinely mislabelled, and authoring against 57005
  puts the prop in the wrist rather than the grip. Exported as `PH_R_HAND_TAG` (and
  `DEFAULT_PROP_BONE_TAG`); `SKEL_R_HAND_TAG` is 57005 and is *not* the default.
- `placement` is metres then degrees, in the bone's local frame, passed straight
  through to `AttachEntityToEntity`.
- `normalisePlacementRecord()` mirrors the Lua reader's coercions (missing slot ->
  `0`, missing bone -> the right-hand default), so a record it accepts is a record
  the game accepts.

**Euler convention.** The degrees compose as `Rz(rz) * Ry(ry) * Rx(rx)` in GTA axes.
That is the same rotation `GizmoScene`'s prop gizmo already uses, which expresses it
as a three.js `"YZX"` Euler in Y-up axes - identical once the -90 deg X frame change
is applied. It is asserted by round-trip tests, and it is the one thing in this
module that has **not** been confirmed against a running game.

## The drawable seam

The `.ydr` drawable reader is being written in parallel and is not available yet, so
`PropSource` is defined now and will not change when it lands:

```ts
interface PropSource {
  bounds: { min: [number, number, number]; max: [number, number, number] };
  object3D?: THREE.Object3D;   // the real drawable, once there is one
  name?: string;
}
```

- With `bounds` only, `PropAttachment` renders a correctly-sized wireframe box.
  The box is translated by the AABB centre so it sits where the model would relative
  to its **origin** - the attach offset is measured from the model origin, not from
  the box centre, and conflating the two offsets every authored placement by half the
  prop.
- When `object3D` is present it is rendered instead, and the box is hidden unless
  `showBoundsWithObject` is set.
- `object3D`'s origin **must** be the model origin. That is the whole contract.
- Dropping the drawable renderer in touches `PropAttachment.setSource()` and nothing
  else. `PropAttachment` never disposes a caller-supplied `object3D`.

## Track handling

| `TrackType` | | emitted as |
| --- | --- | --- |
| `BonePosition` | 0 | `VectorKeyframeTrack` on `<bone>.position` |
| `BoneRotation` | 1 | `QuaternionKeyframeTrack` on `<bone>.quaternion` |
| `BoneScale` | 2 | `VectorKeyframeTrack` on `<bone>.scale` |
| `MoverPosition` | 5 | root motion - on the mover node, or dropped |
| `MoverRotation` | 6 | root motion - on the mover node, or dropped |
| anything else | | skipped, counted in `skippedTracks`, and reported in `warnings` |

Bones with no track keep their rest transform: no track is emitted for them, so the
mixer never touches them.

### Held poses are not broken files

`frames <= 1` or `duration <= 0` is a **pose**, not an error. Emote packs ship these
constantly - one real corpus file (`sitdownonknees@queensisters.ycd / sitdown_clip`)
is `frames=1, duration=0` with 384 bone ids across all 128 ped tags. Returning an
empty clip was arithmetically correct and showed a blank preview of a perfectly good
asset.

A pose builds a **one-key clip of duration 0** and reports `kind: "pose"`. Do not put
that clip through an `AnimationMixer` with `LoopRepeat` - three divides by the clip
duration. `AnimViewerScene` doesn't: it calls `applyPose()`, which writes the frame's
transforms straight onto the bones, reports `isPose`, and exposes no timeline.
`applyPose(animation, skeleton, frame)` is exported for the same reason.

### Rotation keys are normalised

A non-type-7 rotation track is **four independently QuantizeFloat-encoded channels**,
so the reassembled quaternion is only approximately unit. This is the format, not a
parse error - type-7 tracks are reconstructed on the unit sphere and are already
fine. Measured worst case over a 60-file corpus: `|q| - 1 = 7.8e-3`. three's slerp
assumes unit input, so it degrades subtly and cumulatively.

Every rotation key is normalised after the hemisphere pass.
`maxQuaternionDeviation` reports the worst pre-normalisation deviation, so ordinary
quantisation noise (~1e-3) stays distinguishable from a corrupt track; zero-length
keys become identity and are counted separately in `degenerateQuaternions`.

Three more things produce a wrong-looking result rather than an error, and are handled:

- **Tracks address bones by tag, not index.** Resolving a tag as an index gives a
  fully animated skeleton with every joint driven by the wrong track.
- **Quaternion hemisphere flips.** `q` and `-q` are the same orientation, but three's
  interpolant takes the shorter arc *between the stored values*, so an un-flipped
  pair spins the joint ~360 deg in one frame interval. `enforceQuaternionContinuity`
  negates any key whose dot with the previous key is negative;
  `BuildAnimationClipResult.quaternionFlips` reports how many.
- **Native rate.** Keys are emitted at `frames / duration`, frame `f` at `f / fps`.
  The last key therefore sits one interval short of `duration`, and that final
  interval holds the last pose - which is what a loop wants.

## Classifying an asset - `classifyAnimation()`

"Bound zero tracks against a ped skeleton" is not one thing, and telling a creator
the wrong one is worse than saying nothing. `classifyAnimation(animation, skeleton?)`
returns a `kind` plus the evidence behind it, and `buildAnimationClip` includes the
same verdict on its result so the two cannot disagree.

| `kind` | what it is | previewable on a ped |
| --- | --- | --- |
| `animation` | ped body clip, more than one frame | yes |
| `pose` | ped body clip, one frame or zero duration | yes |
| `facial` | expression tracks, no body tracks | no |
| `uv` | texture UV scroll, no skeleton at all | no |
| `other-skeleton` | body tracks for a vehicle/prop/creature rig | no |
| `empty` | no tracks | no |
| `unknown` | tracks matching no known modality - deliberately not guessed | no |

Every threshold is measured against a 60-file / 82-clip corpus, not assumed:

- **Facial track ids** are `22-26` and `134-140`. Observed shapes: 39 ids / 35 tags
  and 114 ids / 94 tags. Both resolve exactly **one** tag against a body skeleton, so
  a tag-count heuristic misclassifies them.
- **`PED_RIG_MIN_MATCH = 0.5`** is the share of bone tags that must exist on the
  skeleton. The lowest genuine ped clip matched **0.738** (45/61); the highest non-ped
  clip matched **0.091** (1/11 - a prop rig matching only tag 0). Nothing lands
  between, and 0.5 sits in that gap.
- A non-ped clip can still bind a track or two incidentally, because tag 0 is
  `SKEL_ROOT` on nearly every rig. "Bound zero tracks" is therefore the wrong test;
  the share is the right one.

Without a skeleton the rig cannot be judged, so `resolvedTags`/`matchRatio` come back
`null` and the kind is **not** guessed as `other-skeleton`.

## Testing

`bun test shared/ts/rage-viewer` from the tLib root.

Tested headlessly: skeleton building and tag lookup, clip construction (track
targeting, key times, quaternion continuity, root-motion toggle, unsupported-track
handling), Z-up conversion, the placement record round-trip and its Lua-matching
coercions, and `AnimViewerScene` with the `WebGLRenderer` and the addon controls
mocked - the same approach `gizmo/GizmoScene.test.ts` uses.

**Not covered:** anything that needs a real GL context (PMREM/`RoomEnvironment`,
actual pixels), pointer interaction with `TransformControls`, and whether the Euler
convention above matches `AttachEntityToEntity` in the running game.

### The end-to-end probe

`scripts/probe-end-to-end.ts` is the only thing that exercises the real seam: a `.ycd`
on disk -> the parser -> a `THREE.AnimationClip`. The unit tests on each side stub at
that boundary. It is a dev tool, not part of `bun test`, because it needs a `.ycd`
corpus and the gitignored skeletons.

```bash
bun run shared/ts/rage-viewer/scripts/probe-end-to-end.ts <file.ycd>... [--skeleton=PATH]
```

It fails if it built zero clips, so a corpus that failed to load cannot read as a
pass. Last run - 60 files, 82 clips: 20,066 tracks bound, 3,531,447 keyframes, 0
hemisphere flips remaining, 0 non-unit quaternions, 0 degenerate keys, worst
pre-normalisation `|q|-1` of 7.837e-3. Classified 63 animation, 10 facial, 6 UV, 2
other-skeleton, 1 pose.

Two files (`drx@femalestand9.ycd`, `drx@sitcarfemale.ycd`) have the RSC7 container
stripped and are rejected. **CodeWalker rejects them identically** - verified with
`tools/gtatool.sh info`, which reports the same `not an RSC7 container` - so the probe
lists them rather than counting them as defects.

Also verified against the real 128-bone skeletons: both freemode rigs build with 0
warnings, 128 unique tags and 128 unique node names.
