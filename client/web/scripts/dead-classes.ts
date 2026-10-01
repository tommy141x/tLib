/**
 * Fails when a class name in this bundle generates no CSS.
 *
 * The generator is built from this project's own uno.config.ts on purpose: the
 * bugs worth catching here are preset-specific spellings. `data-disabled:` and
 * `bg-linear-to-r` are correct Tailwind v4 / presetWind4, and produce nothing
 * at all under the presetWind3 this NUI bundle has to use for CEF 103.
 */
import { createGenerator } from "unocss";
import { findDeadClasses, formatDeadClasses } from "../../../shared/ts/build/index.ts";
import config from "../uno.config.ts";

/**
 * Class names carried for other people to style against, not for us to style.
 * tLib ships a NUI that server owners theme with their own CSS, so these hooks
 * are part of the public surface and are expected to match no rule here --
 * deleting them because nothing in this repo styles them would break consumers.
 *
 * `tlib-` is matched as a namespace rather than enumerated. The enumerated
 * version listed `tlib-nui-toast` and so passed, while its sibling
 * `tlib-nui-toasts` one line away was reported as dead -- the list silently
 * went stale every time a hook was added. Most of the namespace is declared in
 * nui.css and needs no entry here; this covers the handful that are pure
 * consumer hooks.
 */
const THEMING_HOOKS = [/^tlib-/, "mp-preview", "weapon-stats"];

const uno = await createGenerator(config);
/**
 * `cssRoots` reaches outside `src` because the stylesheets that declare these
 * names no longer live in this app. `nui.css` and `marketplace.css` moved into
 * `shared/ts` so that tELS, tDetector and tRadar can mount the marketplace
 * components -- nothing in a resource's own `src` is reachable from a sibling
 * resource. Without this, every `mp-*` class MarketplacePanel.tsx uses is
 * reported dead because its definition is simply out of scope.
 *
 * `roots` stays `src`: this check is about class names THIS bundle ships, and
 * the shared package's own usages are its own business.
 */
const dead = await findDeadClasses({
  uno,
  roots: ["src"],
  cssRoots: ["src", "../../shared/ts"],
  extraAlive: THEMING_HOOKS,
});

console.log(formatDeadClasses(dead));
if (dead.length > 0) process.exit(1);
