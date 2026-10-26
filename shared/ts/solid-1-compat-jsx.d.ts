/**
 * The type-level half of the Solid 1 compat layer, for `shared/ts`.
 * `solid-compat/` shims Solid 1 at runtime for vendor code only; this file is
 * the type-checker counterpart (copied by portfolio-next, web-next, tCAD).
 * Solid 2 moved the DOM/JSX namespace out of `solid-js` into `@solidjs/web`,
 * so `solid-js` publishes no `JSX` members — but vendor packages built against
 * Solid 1, e.g. `@ark-ui/solid@5.39.2`'s `HTMLProps<E>` (which every Ark
 * part's props type is built from), still reference `solid_js.JSX.Element`.
 * Missing it collapses `HTMLProps<"div">` to `never`, rejecting `class` and
 * `children` everywhere and reading as a hundred unrelated errors rather than
 * one cause. Every member here forwards to the real `@solidjs/web` type —
 * nothing widened to `any` — so vendor props stay genuinely checked.
 *
 * Do not import `JSX` from `solid-js` in this package's own source: this shim
 * is ambient, so it would serve that import too. All 21 of our own files that
 * named `JSX` were moved to `@solidjs/web` first so nothing of ours depends on
 * this file — keep it that way, or deleting it once Ark ships Solid 2 types
 * stops being a one-line change.
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
