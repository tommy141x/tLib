# `@tlib/shared`

The shared TypeScript surface: UI components, the marketplace client, the RAGE
readers, the Solid 1 → 2 compatibility layer, and the build helpers every
consumer's `uno.config.ts` and Vite config are assembled from.

Sub-packages with their own notes: [`rage/`](./rage/README.md),
[`solid-compat/`](./solid-compat/README.md), [`css/`](./css/README.md).

A note on notation below: utilities are written as namespace-plus-placeholder
(`<text-colour-token>`) rather than as complete class names, because UnoCSS's
extractor reads raw file text and cannot tell prose from code. A plain `.ts` is
not scanned today and a repo README is not either, but the convention is kept in
both so that neither becomes a source of dead CSS if that ever changes.
`tests/unit/cn-contract.test.ts` asserts every case below with real class
strings; read it when you need the exact spelling.

## `cn.ts` — the class-name joiner, and the shield

`clsx` flattens conditionals and arrays; `unoMerge` then resolves conflicts so
the **last** utility wins. That second half is the reason this is not just
`clsx`: a component that hard-codes a padding must be overridable by a caller
passing a different one, and without the merge both classes ship and the winner
is whichever UnoCSS happened to emit later — stable in a given build, and
silently different in the next.

It is `unocss-merge`, not `tailwind-merge`, because it reads UnoCSS's own
conflict groups. tailwind-merge hard-codes Tailwind's, which are close enough to
look correct and wrong on anything from a custom preset or shortcut.

`clsx` and `unocss-merge` are real `dependencies` of this package and
deliberately not `peerDependencies`. Bun auto-installs peers, which is how
`shared/ts/node_modules` acquired its own `solid-js` and gave every consumer two
copies of the Solid runtime. Duplicating these two is harmless — both are pure
string functions with no shared state or identity checks — but do not add a
*stateful* package here without making it a peer and deduping it in every
consumer's Vite config.

### Why `SHIELDED` exists

`unocss-merge` classifies a utility by, in order: an exact-name table, a table of
regexes, a table of namespace prefixes, and finally a "split at the last dash"
fallback. Four gaps in that chain make it **delete** a class that conflicts with
nothing, and a deletion is not recoverable after the fact — which is why these
namespaces are held back from the merge rather than cleaned up behind it.

| Gap | Shape | Effect |
| --- | --- | --- |
| 1 | An **arbitrary bracketed value** misses the regex tables and falls through to the prefix table. The text namespace's prefix entry maps to `color`. | An arbitrary font size is filed as a text colour and the two annihilate each other: `<bracketed-text-size> <text-colour-token>` keeps only the colour, and the reverse order keeps only the size. |
| 2 | The variant parser only recognises a variant that is a bare word or is *entirely* bracketed. A variant that merely **contains** brackets — the data-, aria- and group/peer-data forms Ark UI's state styling is built on — matches neither, so the prefix is never stripped and the token drops to the last-dash fallback. | Under such a variant, a width and a colour in one namespace become one group and one is deleted. Measured for border width vs colour, ring width vs colour, border width vs style and text size vs colour. |
| 3 | The **ring-offset** namespace has no colour group of its own, so the offset's colour is filed with the ring's colour. | The ring silently loses its own colour. No variant and no custom tokens needed; it reaches every focusable element whose focus is assembled through `cn`. |
| 4 | The **same shape one namespace over**, in `outline-*`, which is the one that matters now that this estate's focus indicator is an outline. A positive offset, the explicit width aliases and a bracketed arbitrary length all land in the outline *colour*'s group. | Whichever of the two came first is annihilated — the offset, the colour, the width or the length depending on order. |

Gap 4 has a second half, which is a *missed* conflict rather than an invented
one: the **negative** offset spelling escapes every table in the chain, so it is
never deduplicated at all and two values of one property ship side by side. That
escape is why the negative spelling reads as a workaround for the first defect.
It is not a fix, it is a different bug — and it is why the `outline-offset` entry
groups both signs together.

Gap 1 is not a custom-token problem and not an arbitrary-vs-named problem: an
arbitrary *colour* — a bracketed CSS variable, the dominant spelling in tRadio's
admin UI — collides with an arbitrary pixel size exactly the same way, because
both land in `color`. Most named sizes escape because the font-size regex lists
them, but the base size's name is absent from that regex and collides too.

Gaps 3 and 4 were both live in shipped code: two tUnit surfaces silently lost
their focus colour and painted focus in `currentColor`. The pairs that look like
they ought to break but do **not** — a bare numeric width, a style keyword and
the bare namespace word each survive beside a colour — are exactly why this
hides. None of it is catchable by any other check here, because every class
involved is real and resolves to CSS; only the merged *output* is wrong.

### Reading the `SHIELDED` table

Each entry names a group and matches the utilities that belong to it. The groups
are the CSS properties actually at stake, and they are independent: overriding a
ring's colour must not lose its width, and a text colour must not cost a text
size.

**Order matters — first match wins, and the colour entries are catch-alls.**
Offset width before offset colour and both before the plain ring entries; the
outline offset and then the outline style before the outline width, because the
style keywords and the bare namespace word must not be read as widths; line style
and width before the border colour catch-all; every font-size spelling before the
text colour catch-all.

A `$1` in a group name is substituted from capture group 1 of the match, which is
how one entry covers every side of the border box without eight near-identical
rows: a top width and a bottom width are different properties and must not
collide, while two plain widths must.

Two namespace quirks the entries encode. `outline-offset` takes a length and
nothing else — CSS has no outline-offset colour — so one group suffices where
ring-offset needs two. And **the bare namespace word is a *style* in `outline-*`,
not a width**, which is where that namespace parts company with border and ring;
the reset spelling is filed with the styles, as `border`'s is.

**Deliberate omissions**, each a boolean or an unrelated property with nothing in
these groups to conflict with, where sweeping it in would break a merge that
already works: the ring inset flag; the three table utilities in the border
namespace; the rounded-corner aliases that may be written with a border prefix;
and in the text namespace the alignment, text-wrap and text-overflow keywords
plus the shadow, stroke and opacity sub-namespaces. Those last three sit in the
same `color` group as a text colour today and so damage it — leaving them *out*
of the shield is what separates them from it, since the colour is held back and
they are not.

### `LENGTH`, and why it guesses colour

The width-or-colour distinction cannot be made from the namespace alone once the
value is arbitrary: the border, ring and ring-offset namespaces all take both, in
brackets, with the same spelling. `LENGTH` treats a value opening with a number,
a sign, a decimal point or one of the four CSS sizing functions as a length, and
everything else — a CSS variable, a colour keyword, a colour function — as a
colour.

It is a heuristic, and a CSS variable is genuinely ambiguous, so it guesses
colour, which is what every bracketed border and ring value in this repo actually
is. Without the distinction a bare border width and a bracketed border *colour*
were classified into one group and one was deleted — the shield reproducing the
exact defect it exists to prevent. Guessing wrong in the other direction only
leaves that one token grouped where `unocss-merge` already put it, so it is never
worse than having no shield.

### The ring-offset groups stay

A live-call-site test says they are dead weight: every consumer that imports this
`cn` has migrated to the outline spelling. They stay anyway, because the failure
mode is still **reachable**.

tRadio's dispatch panel passes `nuiElevationException`, which exempts it from the
nui blocklist, so it is the one bundle on that target where `ring-*` still
compiles — and it is a caller of this function. Retiring the groups re-opens
Gap 3 there: the offset's colour gets filed under the ring's colour group and the
ring silently loses its own, on every focusable element. Every class involved
resolves to CSS, so the defect is invisible in review. Retiring them would also
make this copy and tWeb's vendored one disagree about a correctness rule, in the
direction of the weaker of the two.

What would make them retirable: `nuiElevationException` ceasing to exist, or the
preset blocklisting `ring-*` with no exemption. Count then; do not assume.

### `mergeShielded` and `splitVariants`

Shielded utilities are still deduplicated, just among themselves and per variant
prefix, so a caller can override a shielded utility with another from the same
group. What they no longer do is annihilate an unrelated class on the way
through.

`mergeShielded` takes a string rather than `ClassValue[]` because `clsx` has
already run: the shield needs individual tokens, and `unoMerge`'s own internal
`clsx` call would otherwise happen after this has split on spaces. `unoMerge`
only ever removes entries, so there is nothing for a second pass to find.

`splitVariants` splits on the **last** colon. That is what makes it work where
`unocss-merge`'s own parser does not: a data- or aria-attribute variant contains
brackets without starting with one, and the last-colon rule handles it along with
a fully-bracketed selector variant and a double-colon pseudo-element. Scoping by
prefix is not cosmetic — a responsive or state override is not a conflict, since
the two apply at different times, so collapsing across prefixes would silently
delete the override.

Three known blind spots, none currently reachable from this repo's components:

- A utility in **variant-group form** is one opaque token and the shield cannot
  see inside it. The group transformer is enabled in the shared preset, so this
  is possible. Write the utilities longhand, or teach `mergeShielded` to expand
  groups first.
- An **important marker** is not stripped before matching, so an
  important-marked utility falls through to `unoMerge`, which handles the marker
  itself. That keeps existing behaviour for those tokens rather than shielding
  them.
- `splitVariants` **mis-splits a value containing a colon**, which in these
  namespaces means only the explicit length and colour hints. Those appear before
  the value, so the hint becomes the prefix, the remainder matches nothing, and
  the token passes through unshielded — the pre-shield behaviour, not a new
  failure.

## `build/uno-preset.ts` — one preset for every bundle

Eleven `uno.config.ts` files had grown into near-duplicates: the same colour map,
the same background rule, the same radius steps, the same two transformers, each
copied and then drifted. The drift is the problem — a component moved between
projects renders differently for reasons that live in a config file nobody opened.

### The dialect argument is not a version number

`target: "nui"` means presetWind3 and `target: "web"` means presetWind4, and the
split is permanent rather than a migration in progress.

A NUI page runs inside the game client's CEF, which is Chrome 103. Wind4 compiles
every colour utility to `color-mix(in oklab, …)` and ships its default palette as
`oklch()` literals; both landed in Chromium 111, so CEF parses them as invalid
and drops the declaration. Layout utilities are unaffected, which is what makes
the failure confusing: the UI renders with correct geometry and no colour at all
— transparent surfaces, `currentColor` borders, default-white text. Wind3 emits
`rgb(… / var(--un-*-opacity))`, which CEF 103 understands.

The same split decides how a colour token is spelled. A NUI stylesheet declares
`--background` as a bare HSL triplet so Wind3's alpha machinery can compose it,
and the theme reads it as `hsl(var(--background))`. A web stylesheet declares a
complete colour and the theme reads `var(--background)`. Getting this backwards
is silent: every colour utility resolves to an invalid value and is dropped.

`colorSyntax` is a separate axis rather than a consequence of `target` because
tRadio's dispatch panel is both — it is on presetWind3 for the CEF reason, while
its token generator emits complete colours.

### Why the caller passes its own `unocss`

The installed `unocss` differs per project across the eleven bundles. If this
module imported `unocss` itself, every project's sub-presets would come from one
copy resolved next to this file while its `createGenerator` came from another — a
second rule table, silently, in almost all of them. So the module is handed the
caller's own namespace import and builds the presets from that. The `unocss`
entry in this package is a peer/type dependency for exactly that reason; nothing
here may import it at runtime.

### `tPreset` returns a list, not a nested preset

Nesting `presetWind3()` inside the shared preset inverted both orderings that
matter. A nested preset's theme merges *over* its parent's, so every radius
utility came out at presetWind3's fixed rem values and the `--radius` token
stopped reaching the CSS; and a parent preset's rules sort before its children's,
so the background override moved from the end of the sheet to the start and
stopped winning. Both were visible in the generated stylesheet and neither would
have been visible in the config. As a flat list the shared entry comes last,
which is where a config-level `rules`/`theme` block sat before, and the output is
byte-identical.

`extraPresets` is inserted immediately after the dialect preset rather than at
the end, because that is where the projects that need one already had it and a
preset's theme merges over the ones before it. Moving it changes generated CSS.

### `NUI_BLOCKLIST` — what a nui bundle may not contain

Two separate reasons, and the second is what makes this a build rule rather than
a review note:

1. **CEF does not composite elevation or a translucency effect usefully.** The
   measurement is in `shared/css/surface.css`; the short version is that a
   large-radius elevation over a moving 3D scene costs a compositor pass every
   frame and buys nothing visible. Every focus affordance in this stack is
   therefore an `outline`.
2. **UnoCSS's extractor cannot tell code from a comment**, so a sentence that
   *names* one of these utilities in order to explain why it was removed is
   itself enough to emit the rule. Four elevation utilities and one translucency
   utility were present in built stylesheets whose source contained no such
   class — only prose about one. That is dead CSS rather than a visible defect,
   which is worse: it defeats the one check anybody runs on a built file
   ("search the CSS for a blurred box-shadow") and makes it cry wolf until
   someone stops running it.

Each entry allows an arbitrary variant prefix, because a variant is part of the
raw candidate the blocklist is matched against and a prefixed spelling is
otherwise waved straight through.

`ring-*` is blocklisted, and the delay before adding it was the point rather than
an oversight. UnoCSS composes `box-shadow` out of three variables and only one of
them is the blurred one, so a ring is not elevation — but under presetWind3 it is
still a `box-shadow`, and a box-shadow painted outward from an element that fills
an `overflow: hidden` ancestor is clipped to nothing. Measured in Chromium 103 by
`scripts/probe-focus-paint.ts`: in that geometry the outward box-shadow a ring
compiles to paints **0** accent pixels, as does the same outline pushed to a
positive offset, while the outline at a negative offset paints 404. The fix is to
make focus an outline, which `shared/ts/ui/` already was. Blocking the family
before the consumers that still spelt focus with a ring had followed would have
*deleted* their focus indication rather than corrected it, so it waited for them;
the condition was a count, not a date. `bun run probe:focus` re-measures every
consumer on demand.

The anchored pattern also matches the **bare** namespace word, which is what the
extractor emits for the English word in a comment — one consumer's built sheet
carried that rule from the phrase "a managed focus ring" alone. The anchoring is
what keeps the `ring` *colour* token resolving, since there the word is not at
the start.

`nuiElevationException` is one documented exception, not a switch. Nine bundles
build with `target: "nui"` and eight must keep the ban non-negotiable. The one
caller is tRadio's dispatch panel, the only dual-home app here: served to a real
browser *and* embedded in a CEF iframe, on `target: "nui"` for the Wind3 reason
rather than because NUI is its only home. In the browser half these families
composite properly and the design uses them. Accepted cost: in the CEF half they
still will not paint, and the game renders the flat surface underneath — the same
recipe every other bundle ships. Do not reach for this flag to make a gate go
green.

### What is deliberately not in the preset

- **`presetWebFonts`.** It is the only thing that emits `@font-face`, and every
  face it emitted was a `fonts.gstatic.com` URL. Not a request a game client
  *cannot* make — CEF has a network — but one it must not depend on: a customer's
  server or a player's network may not reach gstatic, an offline headless preview
  render has no network at all, a NUI bundle makes no third-party requests as
  policy, and a CORS-mode `@font-face` fetch needs an explicit ACAO from whoever
  hosts it. Faces are self-hosted through `selfHostWebFonts` in the same
  directory.
- **`theme.fontFamily`**, because no two consumers ship the same stack.
- **`safelist`**, because it is a statement about what one bundle renders
  dynamically and a shared one would only ever grow.

### `sharedTokens` and `PROSE_SHADCN_TOKENS`

`sharedTokens` is on by default and every consumer is on it. Enabling it on a
bundle that names no tokens is a no-op — UnoCSS only generates the names a bundle
references — which is why the opt-in shipped with byte-identical CSS. The colour
arrives with the components, not with the flag.

`PROSE_SHADCN_TOKENS` repaints presetTypography's prose defaults in the shared
tokens. Without it `.prose` keeps the preset's own fixed greys, so a dark theme
gets dark body text on a dark surface, and only inside prose — which reads as an
MDX bug rather than a theme one. It is opt-in because two consumers ship the
preset's own palette on purpose.
