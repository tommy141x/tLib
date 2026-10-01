# `@tlib/shared/rage`

Readers for RAGE (GTA V) resource files, ported from
[CodeWalker](https://github.com/dexyfex/CodeWalker) (MIT, dexyfex/Neodymium).

Zero runtime dependencies. Runs in the browser, in FiveM's NUI (CEF 103) and in
bun/node alike. Parsing is deliberately separate from rendering so it stays testable
headlessly and keeps `three` out of the import graph for callers that only need data.

```ts
import { parseYcd, sampleTrack, findTrackIndex, TrackType } from "@tlib/shared/rage/ycd";

const dict = await parseYcd(new Uint8Array(await file.arrayBuffer()));
const clip = dict.clips.find((c) => c.shortName === "radio_check");
if (clip?.content.kind === "animation" && clip.content.animation) {
  const anim = clip.content.animation;
  const i = findTrackIndex(anim, 11816 /* SKEL_Pelvis */, TrackType.BoneRotation);
  const q = sampleTrack(anim, i, 0); // [x, y, z, w] at frame 0
}
```

## Scope

Loose, unencrypted resource files — what a FiveM resource streams from `stream/`.
RPF archive entries are NG-encrypted and **out of scope**: decrypting them means
hash-scanning keys out of `GTA5.exe`, which is neither shippable in a browser nor
something this repo should do.

Implemented: RSC7 container, paged reader, joaat, `.ycd` clip dictionaries (all nine
channel encodings), drawables (`.ydr`/`.ydd`/`.yft` — geometry, vertex declarations,
shaders, skeletons, both generations) and textures (`.ytd` — parsing plus BC1–BC7 and
uncompressed decoding, with a GPU upload path).

## Format notes worth knowing

- **Trailing bytes after the deflate stream are normal, and `DecompressionStream` cannot
  be trusted with them.** 20 of 156 real files in this corpus carry exactly 4 bytes of
  padding. The stream raises "Trailing junk found after the end of the compressed stream"
  *and discards output it has already buffered* — measured, a single-shot read loses half
  the file while still looking like a clean parse failure. Draining concurrently only
  recovers ~91%. `inflateRaw` therefore trims trailing bytes and requires the result to be
  exactly the size the page flags declare (which, across 165 files, it always is).
- **Container versions differ per type and the comparison direction is not consistent.**
  `.ydr`/`.ydd` are 165 gen8 / **159** gen9; `.yft` is 162 / **171**; `.ytd` is 13 / **5**.
  Match the exact value, never a `>=` threshold — every threshold tried here has
  mislabelled some type.
- **`.ycd` is generation-agnostic.** `Clip.cs` and `YcdFile.cs` have zero gen9 branches,
  so one code path reads Legacy and Enhanced alike. Drawables and textures are not like
  this — `Drawable.cs` has 291 gen9 branches and a parallel vertex declaration.
- **Animation tracks address bones by *tag*, not index.** A tag is a joaat of the bone
  name. Resolve through the skeleton; never assume track order matches bone order.
- **Sequence blocks are an encoding detail.** Frame `F` lives in block
  `F / sequenceFrameLimit` at local index `F % sequenceFrameLimit`. `sampleTrack()`
  handles this; do not index `sequences` directly.
- **Quaternion reconstruction must round in float32.** The dropped component is
  `sqrt(1 - x² - y² - z²)`, and the game evaluates that sum in float32 where a
  unit-length vector often rounds slightly *above* 1, making the clamp fire and the
  component exactly 0. In float64 the same data yields ~1e-4 instead. See
  `reconstructQuatComponent`.
- **Some shipped `.ycd` files are not RSC7 at all.** Two files in a widely-used emote
  pack contain already-decompressed page data with the container stripped. CodeWalker
  rejects them too. Report this to the user rather than guessing.

## Verifying against CodeWalker

`scripts/verify-ycd.ts` parses a corpus with this code and with CodeWalker (via
`gtatool`) and compares every clip, track and per-frame component. It is a dev tool, not
part of `bun test`, because it needs both a `.ycd` corpus and the gtatool build — neither
of which lives in this repo.

```bash
bun run shared/ts/rage/scripts/verify-ycd.ts <dir-or-file>... [--limit=N] [--eps=1e-4]
# GTATOOL=/path/to/gtatool.exe to override the tool location
```

It exits non-zero if it compared **zero** components, so a corpus that failed to load
cannot be mistaken for a pass.

Last full run: 58 files, 23,855 tracks, 18,555,900 components compared, max absolute
delta 4.9e-6. A targeted run over five files chosen to cover every encoding exercised
all nine channel types, 8,416,056 components, max delta 4.1e-7.

## Regenerating the ped skeletons

Rest-pose skeletons are **Rockstar-derived and must never be committed** — this repo is
public MIT. They are generated locally into `assets/`, which is gitignored.

```bash
# extract from your own game install
powershell -File <muto-atlas>/scripts/extract_asset.ps1 \
  -Pattern 'mp_m_freemode_01.yft' -Out "$TEMP/pedskel"

# hierarchy + local rest TRS as JSON
tools/gtatool.sh skeleton "$TEMP/pedskel/mp_m_freemode_01.yft" \
  --out=assets/rage/skeletons/mp_m_freemode_01.json
```

Both `mp_m_freemode_01` and `mp_f_freemode_01` are 128 bones.
