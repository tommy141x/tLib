/**
 * `solid-js`'s public types, PLUS the `JSX` namespace Solid 2 no longer ships.
 *
 * tsconfig.json maps `solid-js` here with `paths`; see the long note there for
 * why this is a redirect rather than a `declare module` augmentation.
 *
 * The re-export is a direct path into node_modules on purpose: writing
 * `export * from "solid-js"` here would resolve back through the same `paths`
 * entry and be circular. Everything real therefore comes from the package
 * itself and stays genuinely type-checked — nothing is widened or invented.
 */

/**
 * The missing namespace, aliased to the real `@solidjs/web` types.
 *
 * `@ark-ui/solid@5.39.2` builds EVERY part's props from
 * `HTMLProps<E> = JSX.IntrinsicElements[E]`, importing `JSX` from `solid-js`.
 * Without this it collapses, so every Ark component rejects `class` and
 * `children` — which reads as our call sites being wrong and is the namespace
 * being empty. This bundle uses Dialog, Tabs, Toast, Select, Checkbox, Field,
 * RadioGroup and Slider, and all eight depend on it.
 *
 * The namespace is re-exported WHOLE rather than member by member. ha-dash
 * lists six members because six were all its vendors touched; here that is not
 * enough, and the way it fails is the point: `lucide-solid` builds its props on
 * `Partial<JSX.SvgSVGAttributes<SVGSVGElement>>`, a seventh member, and with it
 * absent `LucideProps` silently keeps only its eight explicit keys. That showed
 * up as a single complaint about `role` at one call site — not as a props type
 * that had lost every standard SVG attribute. Re-exporting the namespace cannot
 * drift that way, and it is strictly more faithful: every member is the real
 * `@solidjs/web` type.
 */
export type { JSX } from "@solidjs/web";
export * from "../../node_modules/solid-js/types/index";
