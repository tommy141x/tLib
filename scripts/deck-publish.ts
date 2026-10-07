#!/usr/bin/env bun
/**
 * deck-publish — build, validate and pack a resource's Stream Deck plugin, and
 * put the `.streamDeckPlugin` where the docs download link points.
 *
 *   bun run ../tLib/scripts/deck-publish.ts --id com.timmyg-studios.tradio
 *   bun run ../tLib/scripts/deck-publish.ts --id … --repo /path --no-install
 *
 * Same work the production build does — `scripts/prod.ts` calls the identical
 * `packDeckPlugin` — so this is the by-hand way to refresh the download without
 * cutting a release, and it is what `deck-stale`'s failure message tells you to
 * run. One implementation, two entry points: a second copy here is how the two
 * would drift, and a hand-packed artifact that differs from the one a release
 * produces is the problem this whole pipeline exists to end.
 *
 * It writes two tracked files: `docs/public/<id>.streamDeckPlugin` and the
 * content stamp `client/stream-deck/<id>.streamDeckPlugin.stamp.json`. Commit
 * BOTH — the stamp alone passes the gate while the download stays stale, and the
 * artifact alone fails it.
 */

import { resolve } from "node:path";
import { packDeckPlugin } from "../shared/ts/build/deck-pack.ts";

const argv = process.argv.slice(2);

function flag(name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  if (!v || v.startsWith("--")) {
    console.error(`${name} needs a value`);
    process.exit(3);
  }
  return v;
}

const pluginId = flag("--id");
if (!pluginId) {
  console.error("deck-publish: --id <plugin uuid> is required, e.g. --id com.timmyg-studios.tels");
  process.exit(3);
}

try {
  const result = packDeckPlugin({
    root: resolve(flag("--repo") ?? process.cwd()),
    pluginId,
    pluginDir: flag("--plugin-dir"),
    publicDir: flag("--public-dir"),
    // `--no-install` for a tree that already has node_modules. Default is to
    // install, because `bun run build` against a missing node_modules fails in a
    // way that reads as a broken rollup config.
    install: !argv.includes("--no-install"),
  });
  if (result.changed) {
    console.log(
      "\nThe published download CHANGED. Commit it and the stamp beside the plugin, then run " +
        "the website's `bun run docs-assets:sync` so tWeb's copy matches."
    );
  }
} catch (e) {
  console.error(`deck-publish: FAILED — ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
