/**
 * Ambient declarations for `shared/ts`'s OWN typecheck (`tsconfig.json` here).
 *
 * This package has never had a typecheck of its own — consumers compiled it, and
 * each consumer's tsconfig supplied these. Phase 1 of the Solid 2 migration needs
 * one anyway, because shared/ts is now on Solid 2 while every consumer is still on
 * Solid 1, so a consumer build cannot prove anything about this directory.
 *
 * Nothing here is a Solid concern. Both entries exist only so a real type error is
 * not buried: without them `tsc -p shared/ts` opens with 16 "cannot find module
 * ~icons/..." and 3 CSS side-effect errors, which is most of the first screen.
 *
 * `~icons/*` is unplugin-icons' virtual module namespace. The package ships
 * `unplugin-icons/types/solid`, but that augments Solid 1's JSX namespace, so it is
 * the wrong shim here; a component is all this needs to be.
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
