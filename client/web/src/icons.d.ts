/**
 * `~icons/*` — unplugin-icons' virtual module namespace, typed for Solid 2.
 *
 * ⚠️ This REPLACES `"unplugin-icons/types/solid"` in this project's tsconfig
 * `types`, and the replacement is required rather than tidier. That shipped
 * declaration is
 *
 *     const component: (props: ComponentProps<"svg">) => JSX.Element
 *
 * with both names imported from `solid-js`. Under Solid 2, `ComponentProps<T>`
 * is `T extends Component<infer P> ? P : never`, and core's `ValidComponent` is
 * `Component<any>` — it no longer admits a tag name at all, because the
 * renderer package owns that now. So `ComponentProps<"svg">` is `never`, and
 * any `<IconStore class="…" />` reports `Type 'string' is not assignable to
 * type 'never'`.
 *
 * MEASURED: no JSX-namespace augmentation fixes this one. The augmentation in
 * `solid-1-compat-jsx.d.ts` restores `JSX.IntrinsicElements` on `solid-js` and
 * does fix Ark's `HTMLProps<E>` collapse, but `ComponentProps` in Solid 2 does
 * not route through `JSX.IntrinsicElements` — it routes through
 * `ValidComponent`, which is a different type in each package. The shipped
 * declaration itself has to go.
 *
 * Same shape as the one `tLib/shared/ts/env.d.ts` carries for the same reason:
 * a component is all this needs to be, and the props type comes from
 * `@solidjs/web`, which is where the JSX namespace lives now.
 */
declare module "~icons/*" {
  import type { Component } from "solid-js";
  import type { JSX } from "@solidjs/web";
  const component: Component<JSX.SvgSVGAttributes<SVGSVGElement>>;
  export default component;
}
