# `shared/ts/marketplace/` — the headless marketplace

Pure modules: strings and numbers in, strings and numbers out. No DOM, no Solid,
no `fs`. That is what lets the NUI graph (CEF 103), tRadio's Node server bundle
and a Cloudflare Workers build all call the same code.

## Why any of it is shared

Four surfaces drew a marketplace card and three of them had written their own:
the shared `ui/ItemCard.tsx`, tRadio's admin panel, tWeb, and tELS's NUI. Every
parity complaint traced to that — tRadio's card rendered no likes and hid
download counts behind `> 0`, which on a freshly imported catalogue hides every
item.

Styling is deliberately **not** shared. tWeb is presetWind4 + `lucide-solid`; the
NUI surfaces are presetWind3 + `~icons/*` + `--nui-*` under CEF 103, which has
neither `oklch()` nor `color-mix()`. Importing one styled component into both
would break a working surface. So these modules describe a card and never return
JSX, and a card that matches in structure, field set and wording while differing
in theme is the goal.

### Tokens, never sentences

Every function returns tokens and values. `CARD_COPY` is the default English for
hosts that are English-only (every string under `ui/` is a literal). A localising
host — tRadio's panel runs everything through `t()` — maps `CardStatKey` through
its own catalogue and must not import `CARD_COPY`. `install-machine.ts` makes the
same split between `installAction` and `INSTALL_ACTION_LABEL`. Returning a
finished sentence forces a localising host to accept English or derive its own,
which is how the duplication started.

### Narrow structural contracts, not `MarketplaceItem`

`cardStatsOf` takes `CardCounts` rather than an item because tELS's marketplace
tab merges two catalogues — `tels_community_configs` for LED layouts and vehicle
setups, tLib's for HUD layouts and sound packs — into one `CardView` so its card
never branches on provenance. Forcing that shape to satisfy `MarketplaceItem`
would mean inventing `size_bytes`, `slug` and `created_at` for a community config
that has none, and a card then prints a confident `0B` for something nobody
measured. `sort.ts` and `filter.ts` take an accessor per field for the same
reason, and already had three consumers each while `card-model.ts` had one.

## The two counting rules

| Field | Rule | Why |
| --- | --- | --- |
| `downloads` | always shown, **including `0`** | Non-optional on the wire and run through `num()`, so there is no unknown state. A `> 0` gate hides a known zero, not an unknown. |
| `likes` | shown on **presence**, not truthiness | `0` is a real count. Absent means *this host has no likes* — an older or self-hosted backend. |

`likes` therefore must not go through `num()`, which maps missing to `0` and
collapses the distinction. `liked` is checked with `typeof === "boolean"` and not
`=== true`, because a real `false` ("you have not liked this") must survive and is
rendered differently from absence ("we did not ask").

Absence of `liked` makes `likeAffordance` return `"none"`, and the card hiding the
heart is the card working: the deployed backend sends no `likes` and no `liked`
yet. Guessing a state draws an empty heart on something the player may have liked
yesterday, inviting a press the server refuses. "Never a control that cannot
succeed."

`nextLikedState` returns the state being asked **for** rather than toggling,
because the round trip is NUI → Lua → game server → HTTP and can time out with
the write already committed. A caller retrying after a timeout must not be able
to invert anything.

## Wire shape versus internal shape

| Layer | Type | Spelling |
| --- | --- | --- |
| Wire | `CatalogueItem` | camelCase, as `/api/v2/marketplace` sends it |
| Internal | `MarketplaceItem` | snake_case, what every consumer reads |
| Bridge | `toCanonicalItem` | the only translation anywhere |

Not a style inconsistency to tidy away — two layers. A mismatch is silent:
reading `creator_name` off a camelCase object yields `undefined`, not an error.
While two internal shapes disagreed, tRadio's sound cards rendered no player and
theme cards rendered no swatches, both falling through to the placeholder tile.

`toCanonicalItem` used to be a private `toItem` inside
`server/lib/marketplace/browse.ts`. Being private is exactly why tRadio could not
use it and grew its own shape. Do not re-inline it.

**Optional fields are omitted, never set to `undefined`.** Every card checks
presence: a `preview_url` present on a UI item makes it claim to be playable, and
an empty `preview_colors` renders a blank swatch row instead of the placeholder
tile. `{...(x ? {k: x} : {})}` preserves this; `{k: x}` does not.

The **wire** type lives in `item.ts` and not in `catalogue.ts` because `item.ts`
must stay free of Node imports: it is reached from the NUI type graph via
`ui/types.ts`, and `catalogue.ts` pulls in `node:crypto` and holds the marketplace
credential. Importing the type from there made the browser typecheck follow the
edge and fail on `Cannot find module 'node:crypto'`. The dependency is inverted
deliberately — the pure shape module owns both shapes and the transport imports
from it.

`thumbnail` and `preview_url` are **absolute**. A consumer may be an in-game NUI
frame, where a site-relative `/api/storage/…` resolves against the game's origin
and fetches nothing. `preview_url` is the raw storage object and not `/download`,
which counts an install per hit.

## Matching an install on disk

A catalogue slug is namespaced by product; a local install name is not.

| catalogue slug | on-disk directory |
| --- | --- |
| `tradio-qrx-720` | `layouts/QRX-720` |
| `tradio-swx-250` | `layouts/SWX-250` |
| `tels-wcc2` | … |
| `tdetector-rdx-4000` | … |

tRadio's panel asked `new Set(readdir(layouts/)).has(item.slug)`, so the answer
was `false` for every shipped radio head and each one offered Install for
something already installed. Pressing it was not harmless: the install route
hands the **raw slug** to `installFromData`, so it wrote a second copy to
`layouts/tradio-qrx-720/` beside the existing `layouts/QRX-720/`.

`installedNameCandidates` returns both spellings because both genuinely occur —
the raw slug for anything installed through the panel, the stripped slug for
anything that shipped with the resource. Matching only one form trades one set of
false negatives for another.

It is **not** a function for choosing an install target. `layouts/qrx-720` and
`layouts/QRX-720` are one directory on Windows and two on Linux, every `t*`
resource ships to Linux containers, and a receipt written against one name cannot
uninstall the other. Deciding the on-disk name is a migration, not a string
transform.

### `managed` versus `builtin`

A boolean is not enough, because flipping a card to its installed state offers
**Delete**, and for a shipped built-in that is a control that cannot succeed: the
uninstaller addresses `<installPath>/<slug.toLowerCase()>` and requires an
ownership receipt beside it, so Delete on `QRX-720` forms
`layouts/tradio-qrx-720`, finds nothing, and reports it is not installed.

The discriminator is the installer's own target, not provenance inference —
`installFromData` is handed the raw slug, so that is the only name the
marketplace ever writes and the only one `uninstallItem` can address:

- matched the **raw slug** → `"managed"`; Delete can address it.
- matched **only the stripped** spelling → `"builtin"`; the installer never
  writes that name, so the files shipped with the consumer.

`"managed"` wins when both are on disk, which is a real state: installing through
the panel before this existed wrote the duplicate. Nothing here deletes or
migrates it, so preferring `"managed"` leaves such a user a Delete that works;
reporting `"builtin"` would strand the duplicate with no control at all.

Comparison is case-insensitive on both sides: the catalogue lowercases slugs and a
directory name is whatever the author typed (`QRX-720`, `HLX-120G`). The resource
name is CamelCase (`tRadio`), so a case-sensitive prefix strip never strips
anything.

**The one case this cannot separate:** a slug that was never namespaced has
`raw === stripped`, so a shipped directory of that name reports `"managed"` and is
offered a Delete. There is no information to distinguish them from a string
compare. Not reachable on this estate — every shipped layout is model-named and
every catalogue slug is product-namespaced — and not destructive in game either,
because the ownership receipt check still refuses a directory without one. The
authoritative answer is a real `protectedInventory`, which is inert today:
nothing calls `writeMarketplaceReleaseMetadata` and no consumer passes one.

## The preview

`previewKind`'s branch order is the contract, not an implementation detail.
`thumbnail` beats the live `ui` render because a thumbnail is what the creator
chose to show; the live render beats `swatches` because a `ui` item has no
colours; and `none` is a real answer that draws a placeholder tile at the same box
size rather than collapsing the card. Three surfaces had three nestings of this
and disagreed about where `thumbnail` sat. `thumbFailed` is a parameter because
only the host knows its `<img>` errored.

### Three reported symptoms, one cause

`parsePreviewCanvasSize` matched the canvas attributes with `parseInt`, so a
**fractional** canvas missed that tier entirely and fell through to "largest
explicit px in the CSS", which picks some inner element. Six of tRadio's eleven
shipped heads resolve wrong under an integer regex — `QRX-720` declares
209.5×426.5 and resolved to 98×96.

Rendering a 209.5×426.5 document into a 98×96 frame does all three reported
things at once: the box is the wrong shape; the document overflows and the iframe
grows scrollbars; and what shows through that window is the top-left corner of a
blank bezel, which reads as "blank, no mock state" while the mock state is being
applied perfectly to pixels outside the window. Nothing errors, because a bad
scale factor is not an error.

`fitScale`'s `allowUpscale` is a parameter because the two call sites genuinely
want different answers: a full-size overlay caps at 1, since blowing a 200px skin
up to fill a 1080p dialog shows only interpolation artefacts, while a thumbnail
grid passes `true` because its box is smaller than most canvases and refusing to
upscale marooned a small layout in the middle of a large tile.

### The frame contract

| Carrier | Setting | Why |
| --- | --- | --- |
| scaled wrapper | `overflow: hidden` | The wrapper is exactly canvas-sized then transformed; a document one pixel over — which rounding a fractional 426.5 guarantees — scrolls inside it. `PreviewOverlay.tsx` set this and tRadio's panel did not, which is the whole of the scrollbar divergence. |
| scaled wrapper | `flex-shrink: 0` | The wrapper is a flex child in both hosts. Without it the browser shrinks the box *before* the transform runs, so the scale is computed against a width the element no longer has. |
| `<iframe>` | `scrolling="no"` | Deprecated in HTML5 and used on purpose. The standards-track replacement is `overflow: hidden` on the **framed** document's root, which we do not control — these are customer-authored documents the panel injects into rather than rewrites. It is the only scroll suppression applicable from outside, and Chrome 103 still honours it. |
| `<iframe>` | `sandbox="allow-scripts"` **without** `allow-same-origin` | Load-bearing twice: `allow-scripts` lets the injected binder run, and omitting `allow-same-origin` keeps the frame in an opaque origin. Adding it would hand arbitrary marketplace HTML the admin session. |

Centering goes through `previewBoxStyle` in both hosts — the grid tile centres by
absolute positioning because its media slot is a fixed-aspect box the preview must
not stretch, the overlay centres with flexbox — so the transform and the
positioning cannot disagree about the origin and leave a centred preview offset by
half its own size.

### `DEFAULT_HUD_PREVIEW_STATE`

A default exists because most hosts have no preset and the fallback was painting
nothing: `previewState` is optional all the way down and the binder script is only
built `if (state)`. Three resources supply one as a hand-written Lua table
(tRadio, tRadar, tDetector); **tELS supplies none**, so every tELS layout
previewed unbound — every `data-hud-show` element visible at once and every
readout left at the author's placeholder. That is the literal "blank previews, no
mock state" for that surface, and no amount of fixing the geometry touches it.

A resource-specific preset still wins and should: tRadio derives its own through
`deriveBinderState`, which can only express states the engine can actually
produce. This is what a surface uses when it has nothing.

Keys are the `data-hud-*` **dot paths** the grammar reads, nested exactly as the
runtime sends them — `leds.power`, not `leds_power`. The binder resolves dot
paths; a flat object silently matches nothing.

`leds.power: true` is not arbitrary. Pre-binder creator HTML uses that key as an
LCD *visibility gate* rather than as a physical lamp, so defaulting it to `false`
blanks the entire screen of every older skin.

## Why browse goes through Lua

The NUI used to `fetch` the catalogue directly. CEF's origin is `cfx-nui-tLib`
and the marketplace host sends no `Access-Control-Allow-Origin` on that route, so
the browser fetched it and refused to hand over the body — every browse failed.
Being a public read-only endpoint is not what makes a response readable
cross-origin; the header is. tDetector and tRadar have no marketplace UI other
than that panel, which is why they present as having no marketplace at all
despite being fully wired into the agent.

Routing through Lua is not merely a way around CORS, it is the precondition for
speaking **v2**: v1 drops the `X-Resource-Secret` check specifically because its
callers ship inside a game client and cannot hold a credential. Once the request
originates server-side that objection is gone, and v2 takes a `resource` filter,
serves `theme` alongside `ui` and `sound`, and answers with a real error envelope.

Preview **HTML** must come through this transport because the panel does not
merely display it — it injects centering CSS, appends the `data-hud-*` preview
script, and derives the canvas size from a base64 `studio-design:` comment inside
the markup. A cross-origin `<iframe src>` renders the page and gives the parent
none of that.

The **sound** preview needs none of it: the waveform is drawn from the
`preview_waveform` array the list already carries, and playback, duration and
seeking are an `<audio>` element's own job. So it stays a media element pointed at
`preview_url`. An element load is exempt from CORS and a `fetch` is not — which
also means adding a `crossOrigin` attribute would *break* playback by opting the
element into a check it currently escapes. Pulling audio bytes through Lua would
mean shipping binary across the Lua↔JS boundary.

The preview size cap is a stall backstop, not a content policy: the string crosses
the Lua VM and then a NUI message. It was raised from 2 MB once two shipped tELS
documents (12.9 MB and 8.6 MB) turned out to exceed it, which made real catalogue
items unpreviewable rather than acting as a backstop. The account quota is the
only size gate that should exist.

## Like identity

`likeItem`'s `license` must come from `GetPlayerIdentifierByType(src, 'license')`
and from nowhere else. `server/sv_marketplace.lua` is the only place it should be
filled in.

- The outbound credential is `TLIB_PUBLIC_KEY`, public by design and shared by
  every install. With `x-install-id` beside it, the request identifies an
  *install* and says nothing about a person.
- The person is named by that argument. Resolved from the `source` of a net event
  it is a value the player cannot choose, which is what lets
  `UNIQUE(item_id, subject)` stop a player liking twice.
- Resolved from a NUI payload, an export argument or a convar, it becomes a value
  the *caller* chooses and the per-player guarantee is gone.

**Residual risk this cannot fix:** whoever runs the game server can call the HTTP
endpoint directly with any license they invent. The backend rate-limits by calling
server and by subject, which bounds how fast, not whether. The count is resistant
to a player and not to an operator.
