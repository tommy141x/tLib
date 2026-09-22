import type { ClassValue } from "clsx";
import clsx from "clsx";
import { unoMerge } from "unocss-merge";

export function cn(...classLists: ClassValue[]) {
  return unoMerge(clsx(classLists));
}
