/**
 * tLib's DOM test preload. Referenced by `client/web/bunfig.toml`'s
 * `[test] preload` and reached through `bun run test:dom` from the repo root.
 *
 * A preload rather than a per-file import because module top-level code runs
 * before any `beforeAll()` could install a DOM. It lives in `client/web` because
 * node resolution walks up from the importing file, so this is the only
 * directory in the repo where a component test resolves the same module graph
 * the shipped bundle is built from. `--conditions=browser` is set by the script
 * and is not optional: without it solid-js resolves to its SSR build, where a
 * bare signal test silently never recomputes.
 *
 * Every plugin below exists for a measured trap, and several of them fail
 * SILENTLY -- a green run that measured nothing. Read
 * docs/internal/dom-test-harness.md before changing any of them.
 */

import { mock } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import * as solidCompiler from "@solidjs/compiler";
import * as realSolidWeb from "@solidjs/web";
import { plugin } from "bun";
import * as realSolid from "solid-js";
import { VENDOR_PACKAGES } from "../vite/solid-compat-vendors";
import { DEFECTS } from "./_defects";

GlobalRegistrator.register({ url: "http://localhost/" });

const WEB = path.join(import.meta.dir, "..");
const SHARED_TS = path.join(WEB, "..", "..", "shared", "ts");

// Solid 1 vendor compatibility, for the bun test runtime
mock.module("virtual:solid-1-compat-real/solid-js", () => realSolid);
mock.module("virtual:solid-1-compat-real/@solidjs/web", () => realSolidWeb);

const SHIM_DIR = path.join(SHARED_TS, "solid-compat");
const VENDOR_PATH_RE = new RegExp(
  `[\\\\/]node_modules[\\\\/](?:${VENDOR_PACKAGES.map(
    // Escape the regex metacharacters a package name can contain (`.` and `+`)
    // FIRST, then turn the scope separator into a both-slashes class. The other
    // order re-escapes the `[` and `]` just inserted and the alternation
    // silently matches nothing — which the precondition below catches.
    (v) => v.replace(/[.+]/g, "\\$&").replace(/\//g, "[\\\\/]")
  ).join("|")})[\\\\/].*\\.(?:m|c)?js$`
);

/**
 * A precondition, not a statistic, and it runs every time rather than only when
 * a vendor happens to be imported: a plugin that rewrites nothing is
 * indistinguishable from one that is working, because the suites that never
 * touch Ark still pass.
 */
{
  for (const f of ["solid-1-compat.ts", "solid-1-compat-web.ts", "solid-1-compat-store.ts"]) {
    const p = path.join(SHIM_DIR, f);
    if (!fs.existsSync(p)) throw new Error(`[tests/_setup] compat shim missing: ${p}`);
  }
  const installed = VENDOR_PACKAGES.map((v) =>
    path.join(WEB, "node_modules", ...v.split("/"))
  ).filter((p) => fs.existsSync(p));
  if (installed.length === 0) {
    throw new Error(
      "[tests/_setup] none of the shim vendors are installed; the rewrite would silently do nothing."
    );
  }
  const sample = path.join(installed[0]!, "dist", "index.js");
  if (!VENDOR_PATH_RE.test(sample)) {
    throw new Error(`[tests/_setup] VENDOR_PATH_RE does not match a real vendor path: ${sample}`);
  }
}

let vendorFilesRewritten = 0;
plugin({
  name: "solid-1-compat-vendors",
  setup(build) {
    build.onLoad({ filter: VENDOR_PATH_RE }, (args) => {
      const source = fs.readFileSync(args.path, "utf8");
      const out = source
        .replace(
          /(["'])solid-js\/web\1/g,
          JSON.stringify(path.join(SHIM_DIR, "solid-1-compat-web.ts"))
        )
        .replace(
          /(["'])solid-js\/store\1/g,
          JSON.stringify(path.join(SHIM_DIR, "solid-1-compat-store.ts"))
        )
        .replace(/(["'])solid-js\1/g, JSON.stringify(path.join(SHIM_DIR, "solid-1-compat.ts")));
      if (out !== source) vendorFilesRewritten++;
      return { contents: out, loader: "js" };
    });
  },
});
/** Readable from a suite that wants to assert the rewrite really fired. */
(globalThis as Record<string, unknown>).__solidVendorFilesRewritten = () => vendorFilesRewritten;

// `resolve.dedupe`, for the bun test runtime. Without it a component in
// `shared/ts` resolves its own copy of solid-js, so its effects are created with
// NO OWNER: reactivity still works, which is what makes it dangerous, but
// nothing is ever disposed and every editor a suite mounts stays registered on
// the page-wide escape/undo registries forever. The test that would catch the
// bug is the test the bug breaks. See docs/internal/dom-test-harness.md.
const DEDUPE = ["solid-js", "@solidjs/web", "@ark-ui/solid"] as const;

/**
 * A precondition against drift: the list above IS production's, read out of
 * `vite.config.ts` rather than trusted, because the failure is silent in both
 * directions -- an entry missing here makes one suite's cleanups vanish, and an
 * entry missing there ships two runtimes in the bundle.
 */
{
  const config = fs.readFileSync(path.join(WEB, "vite.config.ts"), "utf8");
  const found = /dedupe:\s*\[([^\]]*)\]/.exec(config)?.[1];
  if (found === undefined) {
    throw new Error("[tests/_setup] could not find `dedupe:` in vite.config.ts");
  }
  const parsed = [...found.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]!);
  if (parsed.join(",") !== DEDUPE.join(",")) {
    throw new Error(
      `[tests/_setup] DEDUPE has drifted from vite.config.ts: harness ${JSON.stringify(DEDUPE)} vs build ${JSON.stringify(parsed)}`
    );
  }
}

/**
 * Resolve a specifier as if imported from `client/web`, to the exact FILE -- a
 * bare directory path bypasses the package's `exports` map, which is where each
 * of these decides between its browser and SSR build.
 */
const resolveCache = new Map<string, string>();
function resolveFromWeb(specifier: string): string {
  const hit = resolveCache.get(specifier);
  if (hit !== undefined) return hit;
  const resolved = Bun.resolveSync(specifier, WEB);
  resolveCache.set(specifier, resolved);
  return resolved;
}

/**
 * The precondition that proves `--conditions=browser` is in force. Without the
 * flag every specifier here resolves to Solid's SSR build, and only SOME of that
 * is loud: a component test throws `notSup()`, but a bare signal/memo test does
 * not throw at all -- the memo simply never recomputes and the assertion agrees
 * with whatever the initial value was. A green run that measured nothing.
 */
{
  const solid = resolveFromWeb("solid-js");
  if (/[\\/](server|server\.dev|server\.observe)\.js$/.test(solid)) {
    throw new Error(
      "[tests/_setup] solid-js resolved to its SSR build:\n" +
        `  ${solid}\n` +
        "Run this suite with `bun run test:dom`, which passes --conditions=browser. " +
        "Without it component tests throw and bare reactivity tests pass vacuously."
    );
  }
}

// Both halves of the shared TypeScript: the published `shared/ts/` and the
// estate-only `internal/shared-ts/`, which is where the prop editor lives. A
// pattern matching only the first left PropEditor.tsx undeduped the moment it
// moved, and the symptom was not a second Solid — it was
// `Cannot find module '@solid-primitives/utils'` out of
// `internal/shared-ts/node_modules`, which reads as a broken install.
const FIRST_PARTY_SHARED = /[\\/](?:shared[\\/]ts|internal[\\/]shared-ts)[\\/]/;
const EXCLUDED_FROM_DEDUPE = /[\\/](?:node_modules|solid-compat)[\\/]/;

let dedupedFiles = 0;
function dedupeSpecifiers(source: string, filePath: string): string {
  if (!FIRST_PARTY_SHARED.test(filePath) || EXCLUDED_FROM_DEDUPE.test(filePath)) return source;
  let out = source;
  for (const name of DEDUPE) {
    out = out.replace(
      new RegExp(`(["'])${name.replace(/[.+/]/g, "\\$&")}((?:/[^"']*)?)\\1`, "g"),
      (_m, _q, sub: string) => JSON.stringify(resolveFromWeb(name + sub))
    );
  }
  if (out !== source) dedupedFiles++;
  return out;
}
/** Readable from a suite that wants to assert the rewrite really fired. */
(globalThis as Record<string, unknown>).__dedupedFiles = () => dedupedFiles;

const controlName = process.env.DOM_CONTROL;
let controlPlanted = false;
if (controlName !== undefined && !(controlName in DEFECTS)) {
  throw new Error(
    `[tests/_setup] DOM_CONTROL=${JSON.stringify(controlName)} is not a known defect. ` +
      `Known: ${Object.keys(DEFECTS).join(", ")}`
  );
}
const ROOT = path.join(WEB, "..", "..");
const controlFile =
  controlName === undefined ? null : path.resolve(ROOT, DEFECTS[controlName]!.file);

function plantDefect(source: string, filePath: string): string {
  if (controlName === undefined || controlFile === null) return source;
  if (path.resolve(filePath) !== controlFile) return source;
  const defect = DEFECTS[controlName]!;
  const lf = source.replace(/\r\n/g, "\n");
  const occurrences = lf.split(defect.find).length - 1;
  if (occurrences !== defect.count) {
    throw new Error(
      `[tests/_setup] DOM_CONTROL=${controlName}: its \`find\` matched ${occurrences} time(s), ` +
        `declared ${defect.count}. A substitution that matched the wrong number of times hands ` +
        "the suite a module it did not mean to patch, so this is a gate failure, not a defect."
    );
  }
  controlPlanted = true;
  console.log(`[tests/_setup] PLANTED DOM_CONTROL=${controlName} in ${defect.file}`);
  return lf.split(defect.find).join(defect.replace);
}

/** Readable from a suite in the same process; the printed line above is the
 *  cross-process signal. */
(globalThis as Record<string, unknown>).__controlPlanted = () => controlPlanted;

const loadCache = new Map<string, { contents: string; loader: "js" | "ts" }>();
plugin({
  name: "solid-jsx-and-dedupe",
  setup(build) {
    build.onLoad({ filter: /\.tsx?$/ }, (args) => {
      const cached = loadCache.get(args.path);
      if (cached !== undefined) return cached;
      const source = plantDefect(fs.readFileSync(args.path, "utf8"), args.path);
      let result: { contents: string; loader: "js" | "ts" };
      if (args.path.endsWith(".tsx")) {
        const out = solidCompiler.transform(source, {
          generate: "dom",
          hydratable: false,
          filename: args.path,
          sourceMap: false,
        });
        result = { contents: dedupeSpecifiers(out.code, args.path), loader: "ts" };
      } else {
        result = { contents: dedupeSpecifiers(source, args.path), loader: "ts" };
      }
      loadCache.set(args.path, result);
      return result;
    });
  },
});

plugin({
  name: "css-noop",
  setup(build) {
    build.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }));
  },
});

const ICON_SPECIFIER = /["'](~icons\/[a-z0-9/-]+)["']/g;
function collectIconSpecifiers(dir: string, found = new Set<string>()): Set<string> {
  if (!fs.existsSync(dir)) return found;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectIconSpecifiers(full, found);
    else if (/\.(ts|tsx)$/.test(entry.name)) {
      for (const m of fs.readFileSync(full, "utf8").matchAll(ICON_SPECIFIER)) found.add(m[1]!);
    }
  }
  return found;
}
{
  const icons = collectIconSpecifiers(SHARED_TS, collectIconSpecifiers(path.join(WEB, "src")));
  if (icons.size === 0) {
    throw new Error("[tests/_setup] scanned 0 `~icons/*` specifiers; the stub would do nothing.");
  }
  for (const spec of icons) mock.module(spec, () => ({ default: () => null }));
}

{
  const AS = globalThis.AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal };
  if (typeof AS?.timeout === "function") {
    AS.timeout = AS.timeout.bind(globalThis.AbortSignal);
  }
}

//
// THE FIX BELONGS HERE AND NOT IN A COMPONENT. This makes the setter behave
// the way the spec — and the browser the NUI actually runs in — already does. A
// component rewritten to `String(n)` to dodge it would be carrying a workaround
// for a test-only DOM, and the next component to render a bare number would hit
// the same wall. Transcribed from `tRadio/scripts/test-setup.ts`, which measured
// it first.
{
  // The setter is not always an own property of the named class — happy-dom's
  // `DocumentFragment` reaches it through `Node`. Patching the class that OWNS it
  // (and deduping, since several classes can share one owner) keeps inheritance
  // intact instead of shadowing a subclass override.
  const patched = new Set<object>();
  const patch = (label: string, start: object | undefined) => {
    let proto: object | null = start ?? null;
    while (proto && !Object.getOwnPropertyDescriptor(proto, "textContent")?.set) {
      proto = Object.getPrototypeOf(proto);
    }
    const desc = proto ? Object.getOwnPropertyDescriptor(proto, "textContent") : undefined;
    const nativeSet = desc?.set;
    if (!proto || !nativeSet) {
      throw new Error(
        `[tests/_setup] no textContent setter on ${label}'s prototype chain; the DOM-spec coercion fix would silently do nothing.`
      );
    }
    if (patched.has(proto)) return;
    patched.add(proto);
    Object.defineProperty(proto, "textContent", {
      ...desc,
      set(this: object, value: unknown) {
        nativeSet.call(this, value === null || value === undefined ? "" : String(value));
      },
    });
  };
  patch("Element", (globalThis.Element as unknown as { prototype?: object })?.prototype);
  patch(
    "DocumentFragment",
    (globalThis.DocumentFragment as unknown as { prototype?: object })?.prototype
  );

  // Preconditions: the case the block exists for, and the two the spec leaves
  // alone — so a wrapper that stringified `null` into the literal text "null"
  // would fail here rather than in some unrelated suite.
  const probe = globalThis.document.createElement("span") as unknown as { textContent: unknown };
  probe.textContent = 0;
  if (probe.textContent !== "0") {
    throw new Error(
      `[tests/_setup] textContent coercion fix did not take: expected "0", got ${JSON.stringify(probe.textContent)}`
    );
  }
  probe.textContent = null;
  if (probe.textContent !== "") {
    throw new Error(
      `[tests/_setup] textContent = null must clear, got ${JSON.stringify(probe.textContent)}`
    );
  }
  const frag = globalThis.document.createDocumentFragment() as unknown as { textContent: unknown };
  frag.textContent = 0;
  if (frag.textContent !== "0") {
    throw new Error(
      `[tests/_setup] DocumentFragment textContent coercion did not take: got ${JSON.stringify(frag.textContent)}`
    );
  }
}
