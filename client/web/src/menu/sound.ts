import { inGame, post } from "./bridge";

// These are GTA's own frontend sounds, so the game owns playback and the browser
// only reports what happened. No rate limiting here: the input layer paces held
// keys itself on the ladder at client/input.lua:29-33 (200 -> 150 -> 100 -> 50 ->
// 25ms), and pointer input is human-paced. That floor is 40 steps/second, so this
// is a deliberate acceptance of the rate rather than a claim that it is slow --
// an earlier version of this comment cited 350/140ms, which is not in the code.
export type MenuSound = "nav" | "cycle" | "select" | "back" | "error";

export function play(sound: MenuSound) {
  if (!inGame) return;
  post("sound", { sound });
}
