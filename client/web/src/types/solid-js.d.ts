/**
 * `solid-js`'s public types, PLUS the `JSX` namespace Solid 2 no longer ships.
 *
 * tsconfig.json maps `solid-js` here with `paths`; see the long note there for
 * why this is a redirect rather than a `declare module` augmentation.
 *
 * The re-export is a direct path into node_modules on purpose: writing
 * `export * from "solid-js"` here would resolve back through the same `paths`
 * entry and be circular. Everything real therefore comes from the package
 * itself and stays genuinely type-checked.
 */

/**
 * The missing namespace, aliased to the real `@solidjs/web` types.
 *
 * `@ark-ui/solid@5.39.2` builds every part's props from
 * `HTMLProps<E> = JSX.IntrinsicElements[E]`, imported from `solid-js`; without this it
 * collapses, rejecting `class`/`children` on every Ark component (Dialog, Tabs, Toast,
 * Select, Checkbox, Field, RadioGroup, Slider all depend on it).
 *
 * Re-exported WHOLE, not member by member: `lucide-solid` also needs `JSX.SvgSVGAttributes`,
 * and omitting that one member made `LucideProps` silently keep only its explicit keys —
 * surfacing as a single `role` complaint at one call site rather than a visibly broken type.
 */
export type { JSX } from "@solidjs/web";
export * from "../../node_modules/solid-js/types/index";
