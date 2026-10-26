/**
 * Ambient declarations for `shared/ts`'s own typecheck (`tsconfig.json` here).
 * Needed since Phase 1 of the Solid 2 migration put shared/ts on Solid 2 while
 * every consumer (who used to supply these via their own tsconfig) is still on
 * Solid 1, so a consumer build can no longer prove anything about this
 * directory. Without these, `tsc -p shared/ts` opens with 16 "cannot find
 * module ~icons/..." and 3 CSS side-effect errors, burying any real error.
 * `~icons/*` is unplugin-icons' virtual module namespace; its own
 * `unplugin-icons/types/solid` shim augments Solid 1's JSX namespace, so it's
 * wrong here.
 */

declare module "~icons/*" {
  import type { JSX } from "@solidjs/web";
  import type { Component } from "solid-js";

  const component: Component<JSX.SvgSVGAttributes<SVGSVGElement>>;
  export default component;
}

declare module "*.css" {
  const content: string;
  export default content;
}
