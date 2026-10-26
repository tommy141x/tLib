/**
 * The reduced-motion switch, applied to the importing page's root.
 *
 *     import "@tlib/shared/motion";
 *
 * Imported for effect, like a stylesheet. `@media (prefers-reduced-motion:
 * reduce)` does not work in a FiveM NUI — CEF reports `no-preference`
 * regardless of host OS — so every such block in the shared sheets was dead
 * coverage. The mechanism here is a custom property, not a class: `--motion`
 * defaults to `1` on `:root` (`shared/css/theme-tokens.css`) and every shared
 * duration is `calc(Nms * var(--motion, 1))`, so setting it to `0` collapses
 * all of them without a parallel `.reduce-motion .x { animation: none }` per
 * selector. Writes `1` back rather than removing the property, since a
 * consumer theme may set `--motion` itself via `cssVars` and clearing the
 * inline value would reveal that instead of the default.
 *
 * Lives in `shared/` because `client/cl_ui_effects.lua` resolves the
 * preference once (player KVP over `tlib_reduce_motion`) and has to publish
 * it to every consumer's own `ui_page` document, which tLib can't write into
 * directly. A consumer still has to relay the message —
 * `exports.tLib:GetReduceMotion()` / the `tlib:reduceMotion` event, posted as
 * `{ action = 'setMotion', data = { motion } }` — importing this file alone
 * does nothing on its own.
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
