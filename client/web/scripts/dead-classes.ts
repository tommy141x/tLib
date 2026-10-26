/**
 * `check:classes` for this bundle: fails when a class name generates no CSS.
 * `createGenerator` is called HERE (not in shared/ts/build/dead-classes.ts) so the
 * check uses this bundle's own preset and unocss version. Root `check:classes` (`cd
 * client/web && bun run check:classes`) dispatches here; also carries the surface.css
 * collision and blurred-box-shadow CSS-contract gates every consumer inherits.
 */
import { createGenerator } from "unocss";
import { runDeadClassCheck } from "../../../shared/ts/build/index.ts";
import config from "../uno.config.ts";

/**
 * Hooks tLib ships for server owners to theme, not for this repo to style —
 * expected to match no rule here. `tlib-` is a namespace match rather than an
 * enumerated list: enumerating once listed `tlib-nui-toast` but missed its sibling
 * `tlib-nui-toasts`, going stale silently. Most of the namespace is declared in
 * nui.css; this covers the remaining pure consumer hooks.
 */
const THEMING_HOOKS = [/^tlib-/, "mp-preview", "weapon-stats"];

/**
 * `cssRoots` includes `../../shared/ts` because nui.css and marketplace.css moved
 * there so tLS, tDetector and tRadar can mount the marketplace components — without
 * it every `mp-*` class MarketplacePanel.tsx uses reports dead. `roots` stays `src`:
 * this check is about class names this bundle ships.
 */
await runDeadClassCheck({
  uno: await createGenerator(config),
  cssRoots: ["src", "../../shared/ts"],
  extraAlive: THEMING_HOOKS,
});
