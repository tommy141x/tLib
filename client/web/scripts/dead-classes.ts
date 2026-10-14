/**
 * `check:classes` for this bundle — fails when a class name here generates no CSS.
 *
 * The mechanism, and why the check exists at all, is documented on
 * `runDeadClassCheck` in `shared/ts/build/dead-classes.ts`. `createGenerator`
 * is deliberately called HERE rather than inside that module: the check has to
 * answer for the preset and the `unocss` version THIS bundle ships, which is
 * the whole point of it.
 *
 * tLib's root `check:classes` is `cd client/web && bun run check:classes`, which
 * dispatches here, because this directory owns that `uno.config.ts`.
 * `runDeadClassCheck` also carries the two CSS-contract gates — surface.css
 * collisions and blurred box-shadows — that every consumer inherits.
 */
import { createGenerator } from "unocss";
import { runDeadClassCheck } from "../../../shared/ts/build/index.ts";
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

/**
 * `cssRoots` reaches outside `src` because the stylesheets that declare these
 * names no longer live in this app. `nui.css` and `marketplace.css` moved into
 * `shared/ts` so that tELS, tDetector and tRadar can mount the marketplace
 * components -- nothing in a resource's own `src` is reachable from a sibling
 * resource. Without this, every `mp-*` class MarketplacePanel.tsx uses is
 * reported dead because its definition is simply out of scope.
 *
 * `roots` stays the default `src`: this check is about class names THIS bundle
 * ships, and the shared package's own usages are its own business.
 */
await runDeadClassCheck({
  uno: await createGenerator(config),
  cssRoots: ["src", "../../shared/ts"],
  extraAlive: THEMING_HOOKS,
});
