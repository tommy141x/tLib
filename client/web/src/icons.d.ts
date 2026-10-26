/**
 * `~icons/*` — unplugin-icons' virtual module namespace, typed for Solid 2. Replaces
 * `"unplugin-icons/types/solid"` in tsconfig `types`: its shipped declaration types props as
 * `ComponentProps<"svg">`, which under Solid 2's `ValidComponent` (no longer tag-name-aware)
 * resolves to `never`, breaking every `<IconStore class="…" />`. No JSX-namespace augmentation
 * fixes it — `ComponentProps` routes through `ValidComponent`, not `JSX.IntrinsicElements` — so
 * the shipped declaration has to be replaced outright. Same shape as `tLib/shared/ts/env.d.ts`.
 */
declare module "~icons/*" {
  import type { JSX } from "@solidjs/web";
  import type { Component } from "solid-js";

  const component: Component<JSX.SvgSVGAttributes<SVGSVGElement>>;
  export default component;
}
