/**
 * The TYPE-level half of the Solid 1 compatibility layer, for `shared/ts`.
 *
 * `solid-compat/` shims Solid 1 at RUNTIME, for vendor code only — this package's
 * own source is native Solid 2. This file is the counterpart for the type checker.
 * It is a copy of the one portfolio-next, web-next and tCAD each carry; ha-dash
 * reaches the same end with a `paths` redirect instead, having measured the
 * augmentation merging nothing under its own config. The augmentation is what
 * works here: measured, it takes `tsc -p shared/ts` from 281 reported lines to 57.
 *
 * Solid 2 moved the whole DOM/JSX namespace out of `solid-js` into `@solidjs/web`,
 * so `solid-js` publishes NO `JSX` namespace members at all. Vendor packages built
 * against Solid 1 still reference `solid_js.JSX.Element` and
 * `JSX.IntrinsicElements[E]` — `@ark-ui/solid@5.39.2` does it in the `HTMLProps<E>`
 * alias that every single Ark part's props type is built from. With the namespace
 * missing, `HTMLProps<"div">` collapses to `never`, so every Ark component rejects
 * `class` and `children` and every callback parameter inferred through one becomes
 * an implicit `any`. That one absence was the great majority of the errors here
 * too, and they do not read as one cause: they read as a hundred unrelated
 * missing annotations.
 *
 * Every member forwards to the REAL `@solidjs/web` type. Nothing is widened to
 * `any` and nothing is invented, so vendor props stay genuinely checked — which is
 * the whole difference between this and a `@ts-expect-error` sweep.
 *
 * ── ⚠️ DO NOT IMPORT `JSX` FROM `solid-js` IN THIS PACKAGE'S OWN SOURCE ────────
 *
 * This shim is scoped to vendor code by convention, not by the compiler: it is
 * ambient, so it would just as happily serve a `solid-js` JSX import of ours. All
 * 21 of our own files that name `JSX` were moved to `@solidjs/web` first,
 * deliberately, so nothing of ours depends on this file. Keep it that way, or
 * deleting it when Ark UI ships Solid 2 types stops being a one-line change.
 */
import type { JSX as WebJSX } from "@solidjs/web";

declare module "solid-js" {
  export namespace JSX {
    type Element = WebJSX.Element;
    type IntrinsicElements = WebJSX.IntrinsicElements;
    type HTMLAttributes<T> = WebJSX.HTMLAttributes<T>;
    type CSSProperties = WebJSX.CSSProperties;
    type IntrinsicAttributes = WebJSX.IntrinsicAttributes;
    type ElementType = WebJSX.ElementType;
  }
}
