/**
 * Class-name joiner for every UI tree in this repo.
 *
 * `clsx` flattens conditionals and arrays; `unoMerge` then resolves conflicts so the LAST
 * utility wins. That second half is the reason this is not just `clsx`: a component that
 * hard-codes `px-3` must be overridable by a caller passing `px-6`, and without the merge
 * both classes ship and the winner is whichever UnoCSS happened to emit later in the
 * stylesheet — stable in a given build, and silently different in the next one.
 *
 * `unocss-merge`, not `tailwind-merge`. It reads UnoCSS's own conflict groups; tailwind-merge
 * hard-codes Tailwind's, which are close enough to look correct and wrong on anything from a
 * custom preset or shortcut.
 *
 * Lives here rather than in each tree because the shared components import it. A component in
 * `shared/ts` cannot reach a consumer's `src/lib/cn.ts`, so any component promoted out of a
 * consumer needs this resolvable from shared — that is what forced the move, not the four
 * duplicate copies on their own.
 *
 * `clsx` and `unocss-merge` are real `dependencies` of this package, deliberately not
 * `peerDependencies`. Bun auto-installs peers, which is how `shared/ts/node_modules` ended up
 * with its own `solid-js` and gave every consumer two copies of the Solid runtime. Duplicating
 * these two is harmless — both are pure string functions with no shared state or identity
 * checks — but the distinction matters for anything that is a singleton, so do not add a
 * stateful package here without making it a peer and deduping it in every consumer's vite
 * config.
 */

import type { ClassValue } from "clsx";
import clsx from "clsx";
import { unoMerge } from "unocss-merge";

export function cn(...classLists: ClassValue[]) {
  return unoMerge(clsx(classLists));
}
