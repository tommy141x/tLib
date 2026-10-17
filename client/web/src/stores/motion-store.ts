/**
 * The reduced-motion switch, applied to this page's root.
 *
 * `@media (prefers-reduced-motion: reduce)` DOES NOT WORK IN A FiveM NUI.
 * CEF reports `no-preference` whatever the host OS is set to — measured — so
 * every such block in the shared sheets was coverage that could never fire,
 * and a player who needs reduced motion had no way to ask for one.
 *
 * The mechanism is a custom property rather than a class: `--motion` is declared
 * `1` on :root in `shared/css/theme-tokens.css` and every shared duration is
 * written `calc(Nms * var(--motion, 1))`, so setting it to `0` collapses all of
 * them at once and no rule needs a second spelling. A class would have meant a
 * parallel `.reduce-motion .x { animation: none }` for every animated selector,
 * which is the shape that goes stale the first time someone adds an animation.
 *
 * WRITES `1` BACK RATHER THAN REMOVING THE PROPERTY. A consumer theme may
 * have set `--motion` itself through `cssVars`, so clearing the inline value
 * would reveal theirs rather than restore the default. Being explicit in both
 * directions is what makes this idempotent.
 *
 * Imported for effect by App.tsx, like theme-store beside it.
 */

import { onNuiEvent } from "../lib/nui";

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
