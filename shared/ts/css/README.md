# `shared/ts/css/` — package-relative specifiers for `shared/css/`

Every file here is a one-line `@import` of the real stylesheet in
`tLib/shared/css/`. Nothing is authored here; edit the target.

## Why the indirection exists

The stylesheets belong beside each other in `shared/css/`, which is OUTSIDE this
package (`@tlib/shared` is rooted at `shared/ts`). Node's `exports` map cannot
name a target above its own package root, so `"./css/surface.css": "../../css/surface.css"`
is not a legal entry and a consumer could only reach the file by relative path.

That relative path is a real trap, not a stylistic one. tUnit's global.css reaches
theme-tokens.css with `../../../../tLib/shared/css/theme-tokens.css` and carries a
20-line comment explaining that the depth is four because the file sits in
`src/`, while the `@tlib` alias resolves from `client/web` and climbs three — and
that **getting it wrong does not fail the build**. Vite prints "Unable to resolve
@import" and exits 0, so the bundle ships with the palette simply absent and every
surface silently falls back.

With these shims that becomes:

```css
@import "@tlib/shared/css/theme-tokens.css";
@import "@tlib/shared/css/fonts.css";
@import "@tlib/shared/css/surface.css";
```

— no depth to count, and it resolves identically from any directory in any
consumer, through the same alias the TypeScript imports already use.

`url()`s inside the target are rebased against the TARGET's directory by Vite's
CSS pipeline, so `fonts.css` still finds `shared/css/fonts/*.woff2` and still
emits them into the consuming bundle's own asset directory. Verify that after a
build — four `.woff2` in the consumer's `client/ui/assets` — rather than assuming
it, for the same reason as above: a failed `@import` is a warning, not an error.
