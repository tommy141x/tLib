# `shared/css/` — the shared NUI stylesheets

Three files, imported by every resource's NUI through the package-relative shims
in `shared/ts/css/` (see that directory's README for why the indirection exists):

```css
@import "@tlib/shared/css/theme-tokens.css";  /* tokens + the surface layer */
@import "@tlib/shared/css/fonts.css";         /* self-hosted faces */
```

`theme-tokens.css` re-exports `surface.css`, so importing the tokens brings the
recipe that reads them. The two are useless apart: every rule in `surface.css`
is written in terms of `hsl(var(--card))`, `var(--radius-control)` and friends.

## Why the tokens are shared

They used to be declared inline in tLib's own `global.css`, and every other
resource hand-copied the token *names* with its own *values*. The shared
`admin-ui` controls style themselves from those names, so the same control
rendered a different colour in each host — tELS had drifted to a blue-tinted
palette while importing tLib's components, so one control was grey in a tLib
dialog and blue in the tELS editor. Nothing was broken; the two were simply
maintained apart with no reason to converge.

Importing this file is what makes a change here reach every consumer without a
matching commit in each resource.

## What is deliberately not here

- **`--font-sans`.** A face has to be shipped to resolve, and each resource
  self-hosts a different one, so a shared value would name a file that is only
  on disk in one of them. Each resource sets its own beside its own
  `@font-face`.
- **Anything resource-specific.** tELS's gizmo axis and LED-side colours have no
  meaning in a tLib dialog.

## The layer order is declared, not inferred

`theme-tokens.css` opens with `@layer base, components;` and that statement must
stay above the `@import`. A `@layer a, b;` statement fixes the order of both
layers wherever either is later opened; without it the order is **first
appearance**, and the `surface.css` re-export appears at whatever line the host
put its `@import` on — above its own `@layer base` block in most consumers. That
silently inverts base and components, and every `@layer base` rule starts
beating the surface recipe.

Keep the statement first: `@import` may only be preceded by `@charset` and by
`@layer` *statement* rules, so it is the one thing allowed in front of it.

## Overriding a token

Declare it again **after** the import, in a bare `:root { … }`.

**Not inside `@layer base`.** This file is unlayered, and an unlayered
declaration beats a layered one regardless of source order, so a token
re-declared inside `@layer base { :root { … } }` is silently ignored and the
shared value wins. Two consumers shipped the layered form and lost every
override that collided with a shared token — including one that flattened its
shell and its panels to the same colour.

What hides it: a token this file does *not* declare applies either way, because
there is nothing for it to lose the cascade to. So the override block looks like
it works, and only the half that collides quietly does nothing.

## The elevation ladder

The four surface tokens are not four independent colours. They are four rungs,
and every component in `internal/shared-ts/ui/` and `internal/shared-ts/admin-ui/` assumes the
order:

```
--background  ≤  --card  <  --input = --popover  <  --border
```

| Token | Rung |
| --- | --- |
| `--background` | the page or dialog shell — the floor |
| `--card` | a panel standing on the floor |
| `--input` | a control recessed into a panel; also `--popover`, since a dropdown is one rung above the panel |
| `--border` | the edge of any of the above |

A tLib control fills itself from `--input` and draws its edge from `--input` or
`--border`. If `--card` ever rises above `--input`, every field and every edge in
the product becomes *darker* than the panel it sits on, which reads as black
outlines drawn around things. It has happened twice, and nothing warns you —
each token on its own still looks like a reasonable colour.

**The rule, and it is the only one:** never re-declare one of `--background`,
`--card`, `--input`, `--popover` or `--border` on its own. Move the ladder or
move nothing. If a surface needs to separate from the one behind it, use
`--border`, which is above every fill and cannot invert anything.

`tests/unit/theme-ladder.test.ts` parses this file and fails if any palette block
in it breaks the ordering, so adding a block without keeping the order fails
`bun test`.

### Overlay resources and `.tlib-overlay`

The ladder assumes a page shell. A resource whose NUI page is opaque — a
full-screen editor — has `--background` painted behind everything, so `--card`
separates from it and the ladder reads correctly. Lowering `--background` moves
the bottom rung, which is safe.

An **overlay** resource draws a transparent page over the running game. There is
no shell, `--background` is never painted, and a `--card` panel has nothing to
separate from except the moving 3D scene, so it reads flat. The instinct is to
raise `--card`. That is the inversion.

The supported fix is `class="tlib-overlay"` on the overlay's root element. It
re-declares the whole ladder one step brighter, in order, so every rung keeps its
relationship to the rungs either side. Because it is a scope rather than a
`:root` override, tLib's components inside it read the shifted values and nothing
outside it changes.

## The radius scale

One knob. `--radius` is authored and `--radius-control`, `--radius-surface` and
`--radius-tight` are derived from it, so a control, a popover and a panel stay in
proportion when a consumer moves it. That is the supported way to be less rounded
than tLib without forking the scale.
