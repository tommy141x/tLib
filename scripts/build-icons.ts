/**
 * Generate server/http/icons.json from the Lucide set.
 *
 * The hub renders an icon per registered app, chosen by name at runtime, so
 * tLib cannot know at build time which ones it needs — it ships the whole set.
 *
 * Two transforms keep that affordable. Every Lucide icon carries the same five
 * presentation attributes on its elements; those INHERIT in SVG, so they are
 * stripped here and declared once on the <svg> the hub emits. Icons whose body
 * is then a single empty <g> wrapper are unwrapped. Together that is most of
 * the raw size, with identical rendering.
 *
 * Run: bun run scripts/build-icons.ts
 */

import { readFileSync, writeFileSync } from "node:fs";

const SRC = "./ui/src/node_modules/@iconify/json/json/lucide.json";
const OUT = "./server/http/icons.json";

/** The attribute string every Lucide element repeats. Hoisted to the <svg>. */
const PRESENTATION =
  ' fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"';

type IconifySet = {
  icons: Record<string, { body: string }>;
  aliases?: Record<string, { parent: string }>;
};

const set: IconifySet = JSON.parse(readFileSync(SRC, "utf8"));

function slim(body: string): string {
  let out = body.split(PRESENTATION).join("");
  // What is left of a pure wrapper is "<g>...</g>" — the group carried nothing
  // but the attributes just removed.
  while (out.startsWith("<g>") && out.endsWith("</g>")) {
    out = out.slice(3, -4);
  }
  return out;
}

const icons: Record<string, string> = {};
for (const [name, icon] of Object.entries(set.icons)) {
  icons[name] = slim(icon.body);
}

// Aliases are real names people will reach for; resolve them to their parent's
// body rather than making the lookup chase references at runtime.
let aliased = 0;
for (const [name, alias] of Object.entries(set.aliases ?? {})) {
  const parent = icons[alias.parent];
  if (parent !== undefined && icons[name] === undefined) {
    icons[name] = parent;
    aliased++;
  }
}

const sorted = Object.fromEntries(Object.entries(icons).sort(([a], [b]) => a.localeCompare(b)));
const json = JSON.stringify(sorted);
writeFileSync(OUT, json);

const rawBytes = Object.values(set.icons).reduce((a, i) => a + i.body.length, 0);
console.log(
  `${Object.keys(sorted).length} icons (${aliased} aliases) -> ${OUT}\n` +
    `  bodies ${(rawBytes / 1024).toFixed(0)}KB raw -> ${(json.length / 1024).toFixed(0)}KB on disk`
);
