import { inGame, post } from "./bridge";

// GTA's own frontend sounds; the game owns playback, the browser only reports what
// happened. No rate limiting here: client/input.lua paces held keys on a 200 -> 150 ->
// 100 -> 50 -> 25ms ladder (floor 40 steps/second), and pointer input is human-paced.
export type MenuSound = "nav" | "cycle" | "select" | "back" | "error";

export function play(sound: MenuSound) {
  if (!inGame) return;
  post("sound", { sound });
}
