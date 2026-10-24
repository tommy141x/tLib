/**
 * The reduced-motion switch, applied to the importing page's root.
 *
 *     import "@tlib/shared/motion";
 *
 * Imported for effect, like a stylesheet: there is nothing to call and nothing
 * to wire. A page that imports it answers `setMotion`; one that does not, does
 * not.
 *
 * NOTE: `@media (prefers-reduced-motion: reduce)` DOES NOT WORK IN A FiveM NUI.
 * CEF reports `no-preference` whatever the host OS is set to — measured — so
 * every such block in the shared sheets was coverage that could never fire, and
 * a player who needs reduced motion had no way to ask for one.
 *
 * The mechanism is a custom property rather than a class: `--motion` is declared
 * `1` on :root in `shared/css/theme-tokens.css` and every shared duration is
 * written `calc(Nms * var(--motion, 1))`, so setting it to `0` collapses all of
 * them at once and no rule needs a second spelling. A class would have meant a
 * parallel `.reduce-motion .x { animation: none }` for every animated selector,
 * which is the shape that goes stale the first time someone adds an animation.
 *
 * It WRITES `1` BACK RATHER THAN REMOVING THE PROPERTY. A consumer theme may
 * have set `--motion` itself through `cssVars`, so clearing the inline value
 * would reveal theirs rather than restore the default. Being explicit in both
 * directions is what makes this idempotent.
 *
 * Why this lives in `shared/` and not in tLib's app:
 *
 * `client/cl_ui_effects.lua` resolves the preference once — player KVP over the
 * `tlib_reduce_motion` convar — and then has to PUBLISH it, because a consumer
 * with its own `ui_page` owns its own document and tLib cannot write a property
 * into it. Every consumer that animates anything therefore needs this listener,
 * and the second copy of it is the one that drifts from the first.
 *
 * A CONSUMER STILL HAS TO SEND THE MESSAGE. Reading the answer is
 * `exports.tLib:GetReduceMotion()` and the change event is `tlib:reduceMotion`;
 * both go out to this page as `{ action = 'setMotion', data = { motion } }`.
 * Importing this file alone does nothing in a resource whose Lua never speaks.
 */

import { onNuiEvent } from "./nui";

interface MotionMessage {
  /** 1 for full motion, 0 for none. Any other value is ignored. */
  motion: number;
}

export function applyMotion(value: number, element: HTMLElement = document.documentElement): void {
  element.style.setProperty("--motion", String(value));
}

onNuiEvent<MotionMessage>("setMotion", (data) => {
  const value = data?.motion;
  if (value !== 0 && value !== 1) return;
  applyMotion(value);
});
