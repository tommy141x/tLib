/**
 * The shim's surface, measured against a CONSUMER's installed vendor tree.
 *
 * ── ⛔ WHY THIS IS SHARED LOGIC AND PER-PROJECT DATA ────────────────────────────
 *
 * Nothing in `solid-compat/` had a test of its own. The rule in README's
 * *Changing anything here* — "every export must have a vendor call site, count
 * it in `node_modules` or delete it" — was enforced by hand across 165 KB of
 * shim and five consumers, which is how `createResource` survived as ~170 lines
 * of dead code behind a live-looking justification: the counts in its docblock
 * were taken BEFORE the migration and never marked historical. Reading the
 * docblock actively argued FOR keeping it.
 *
 * ⚠️ THE ASSERTIONS ARE GENERIC; THE TREE THEY RUN AGAINST IS NOT. "What does the
 * installed vendor tree import" can only be answered by an installed tree, and
 * the trees genuinely differ — `VENDOR_PACKAGES` runs from 2 entries to 12 across
 * the supported set, and only `@ark-ui/solid` and `@zag-js/solid` appear in every
 * one. So the logic lives here, once, and each consumer runs it against its own
 * `node_modules`. That is also the only arrangement that satisfies README rule 2,
 * "re-measure at the UNION, across every consumer's installed tree" — no single
 * project can do that alone, and a copy per project is the fork this layer
 * exists to have ended.
 *
 * ── ⛔ TWO THINGS ARE INJECTED RATHER THAN IMPORTED, AND BOTH ARE FORCED ────────
 *
 * This file is physically inside tLib, so a bare import here resolves against
 * tLib — not against the consumer. Measured in `tLib/shared/ts/node_modules`:
 *
 *   · `solid-js` IS INSTALLED THERE, ON 1.9.12. So `await import("solid-js")`
 *     from this file would hand back the SOLID 1 surface and every "is this name
 *     supplied" answer below would be computed against the wrong package — and
 *     silently, because Solid 1 has MORE names than Solid 2, so the test would
 *     pass while measuring nothing. This is the same trap recorded in the plugin
 *     header, where `createRequire` resolving the "real" Solid from tLib kept a
 *     build green while 40 of one consumer's test files died at collection.
 *   · `vitest` IS NOT INSTALLED THERE AT ALL, so `import { describe } from
 *     "vitest"` would fail to resolve and this module could not even load. Were
 *     it installed, it would be a SECOND copy whose `describe` registers with no
 *     runner the consumer is watching — a suite that silently contributes zero
 *     tests, which is indistinguishable from one that passes.
 *
 * ⚠️ SO THE CONSUMER PASSES ITS OWN `{ describe, test, expect }` AND ITS OWN
 * DYNAMIC IMPORTS. Both then resolve from the consumer's root, where the real
 * Solid 2 and the real runner live. It also makes this runner-agnostic, which is
 * a free side effect rather than the goal.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { solid1CompatShim } from "./solid-1-compat-plugin";

/** This directory, so the shim files are found without a per-consumer path. */
const SHIM_DIR = fileURLToPath(new URL(".", import.meta.url));

const SHIMMED_SPECIFIERS = ["solid-js", "solid-js/web", "solid-js/store"] as const;
type Shimmed = (typeof SHIMMED_SPECIFIERS)[number];

/**
 * The subset of a test runner's API this suite uses, declared structurally so a
 * consumer passes vitest's own objects with no cast. Typing it as `unknown` and
 * casting inside would defeat the point: the whole reason these are injected is
 * that the real ones must come from the consumer.
 */
interface Matchers {
  toEqual(expected: unknown): void;
  toBeGreaterThan(expected: number): void;
  toMatch(expected: RegExp): void;
  readonly rejects: { toThrow(expected: RegExp): Promise<void> };
  readonly resolves: { toBeNull(): Promise<void> };
}

export interface SurfaceSuiteApi {
  describe(name: string, fn: () => void): void;
  test(name: string, fn: () => void | Promise<void>): void;
  expect(actual: unknown): Matchers;
}

export interface SurfaceSuiteOptions {
  /** The consumer's `VENDOR_PACKAGES`. Required; it is the whole point. */
  vendorPackages: readonly string[];

  /**
   * ⛔ THE CONSUMER'S OWN DYNAMIC IMPORTS — see this file's header. Written as
   * `() => import("solid-js")` at the CALL SITE so they resolve from the
   * consumer's root rather than from tLib's Solid 1.9.12.
   *
   * ⚠️ `solid-js/store` IS ABSENT ON PURPOSE. Solid 2 has no counterpart at all;
   * the store APIs moved into bare `solid-js`, so the shim file supplies that
   * whole surface and there is no real package to compare against.
   */
  realSurfaces: {
    "solid-js": () => Promise<object>;
    "@solidjs/web": () => Promise<object>;
  };

  /** Project root, where `node_modules` lives. Defaults to the runner's cwd. */
  root?: string;

  /** Whether this consumer passes `ariaAttributeFix: true`. Changes what the
   * `@solidjs/web` gate assertion expects, so it must match the real config. */
  ariaAttributeFix?: boolean;

  /** Application-code directory, relative to `root`. The gate must REFUSE to
   * shim a dropped specifier for an importer in here. */
  srcDir?: string;

  /**
   * A build-tooling file that is neither application code nor a vendor — the
   * gate must leave it alone rather than shim it. One of these (an mdx
   * emitter) cost a consumer 101 build errors naming it nowhere.
   */
  toolingFile?: string;

  /**
   * Floor for "the vendor scan found imports at all". Deliberately far below
   * any real count: it asserts the WALK RAN, not a particular dependency tree.
   * A consumer with a 2-entry vendor list should lower it, not delete it.
   */
  minimumVendorImports?: number;

  /**
   * Solid 1 TYPE names this consumer's vendors still import that Solid 2 does
   * not declare anywhere. Asserted as an EXACT set, so a vendor upgrade that
   * changes it has to be looked at rather than absorbed.
   *
   * ⚠️ INERT, NOT BROKEN: type imports are erased before a bundler looks for a
   * binding, so a missing one cannot resolve to `undefined` — and `skipLibCheck`
   * hides them from tsc. The list shrinking is how this layer ends.
   */
  undeclaredTypeImports: readonly string[];

  /**
   * ── ⛔ "UNUSED" IS A UNION QUESTION, AND THIS OPTION IS WHY ───────────────────
   *
   * Shim exports no vendor in THIS consumer's tree imports. They are not dead
   * code: another consumer's vendors want them, and only the union of all five
   * trees can say otherwise.
   *
   * ⚠️ THIS WAS FOUND BY RUNNING THE SUITE, NOT BY DESIGNING IT. Its first run
   * against a second consumer failed on `batch`, `createComputed` and
   * `observable` as "unused" — and all three are live elsewhere, measured in that
   * other consumer's `node_modules`:
   *
   *     batch          <- @solid-primitives/rootless, @solid-primitives/static-store,
   *                       @tanstack/solid-table
   *     createComputed <- @solid-devtools/logger, @solid-primitives/refs,
   *                       @tanstack/solid-form
   *     observable     <- @tanstack/solid-table
   *
   * ⛔ SO A PER-PROJECT "UNUSED" VERDICT IS A FALSE FAILURE FOR A SHARED LAYER,
   * and asserting it strictly would have pushed the narrower consumer to delete
   * exports the wider one needs. That is the exact opposite of what README rule 2
   * ("re-measure at the UNION, not at the one project in front of you") asks for.
   *
   * ⚠️ IT IS ASSERTED AS AN EXACT SET RATHER THAN AN ALLOWLIST. A name that
   * becomes locally wanted must be REMOVED from here, and a newly orphaned export
   * must be ADDED — either way the diff is visible and someone has to decide.
   * An allowlist would only ever grow, and would silence the `createResource`
   * case this suite exists to catch.
   *
   * ⛔ AN EXPORT IS ONLY DEAD WHEN IT APPEARS IN EVERY CONSUMER'S LIST. That is
   * the signal to delete it from the shim, and it cannot be seen from one repo.
   */
  exportsWantedOnlyByOtherConsumers: readonly string[];
}

const SOURCE_EXT = /\.(js|mjs|cjs|jsx|ts|tsx|mts|cts)$/;

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // an optional or absent package is not this suite's business
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      // A nested node_modules is a DIFFERENT package's tree; its imports are
      // attributable to it, not to the package being walked.
      if (entry !== "node_modules") walk(full, out);
    } else if (SOURCE_EXT.test(entry)) out.push(full);
  }
  return out;
}

/**
 * Named bindings in an import clause, `as` aliases reduced to the SOURCE name
 * (`{ Index as Index2 }` demands `Index`), each marked type-only or not. A
 * namespace or default import contributes no name, because neither pins an
 * export.
 *
 * ⚠️ THE TYPE/VALUE SPLIT IS READ OFF THE IMPORT POSITION, NOT OFF THE PACKAGE.
 * Deciding "is it a type?" by scanning installed `.d.ts` for a declaration
 * reported seven false positives as missing VALUES — `Accessor`, `JSX`,
 * `JSXElement`, `Component`, `ComponentProps`, `Context`, `ParentProps` — every
 * one sourced from a declaration file, where nothing has a runtime. The scan was
 * not even wrong about most of the declarations; the QUESTION was wrong. Keying
 * on position asks the only thing actionable here: can a VALUE be missing at
 * runtime.
 */
function namedBindings(clause: string, typeOnlyImport: boolean): [string, boolean][] {
  const braced = clause.match(/\{([\s\S]*)\}/);
  if (!braced) return [];
  const names: [string, boolean][] = [];
  for (const part of (braced[1] ?? "").split(",")) {
    const raw = part.trim();
    if (!raw) continue;
    const inlineType = /^type\s+/.test(raw);
    const name = raw
      .replace(/^type\s+/, "")
      .split(/\s+as\s+/)[0]
      ?.trim();
    if (name) names.push([name, typeOnlyImport || inlineType]);
  }
  return names;
}

const IMPORT_RE = /import\s*(type\s*)?([\s\S]*?)\s*from\s*["']([^"']+)["']/g;

type Demanded = { valueFiles: string[]; typeFiles: string[] };

/** Names a shim file declares ITSELF, i.e. excluding its `export *` passthrough
 * of the real package. These are the ones whose existence needs justifying. */
function shimLocalExports(file: string): string[] {
  const src = readFileSync(join(SHIM_DIR, file), "utf8");
  const names: string[] = [];
  for (const m of src.matchAll(
    /^export\s+(?:declare\s+)?(?:async\s+)?(?:function|const|let|class|type|interface)\s+(\w+)/gm,
  )) {
    if (m[1]) names.push(m[1]);
  }
  // `export { a, b as c } from "./x"` — the EXPORTED name is what consumers see.
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}\s*from\s*["'][^"']+["']/gm)) {
    for (const part of (m[1] ?? "").split(",")) {
      const t = part.trim();
      if (!t) continue;
      const parts = t.split(/\s+as\s+/);
      const exported = (parts[1] ?? parts[0])?.trim();
      if (exported) names.push(exported);
    }
  }
  return [...new Set(names)];
}

/**
 * Exports that exist for the SHIM ITSELF rather than for a vendor importer,
 * with the reason each is not dead code. Shared, because it is a fact about this
 * layer and not about any consumer's tree.
 */
const INTERNAL_OR_CORRECTIVE: Record<string, string> = {
  // Re-exported between shim files (`-web.ts` and `-store.ts` both pull from
  // `solid-1-compat.ts`), so the consumer is this layer and the vendor consumer
  // is counted against the OTHER specifier's demand.
  Show: "shared between the bare and /web spellings",
  Switch: "shared between the bare and /web spellings",
  Index: "shared between the bare and /web spellings",
  createStore: "shared between the bare and /store spellings",
  reconcile: "shared between the bare and /store spellings",
};

const SHIM_FILE_FOR: Record<Shimmed, string> = {
  "solid-js": "solid-1-compat.ts",
  "solid-js/web": "solid-1-compat-web.ts",
  "solid-js/store": "solid-1-compat-store.ts",
};

/**
 * Registers the suite. Call it from a one-line test file in the consumer:
 *
 *     solidCompatSurfaceSuite({ describe, test, expect }, {
 *       vendorPackages: VENDOR_PACKAGES,
 *       realSurfaces: {
 *         "solid-js": () => import("solid-js"),
 *         "@solidjs/web": () => import("@solidjs/web"),
 *       },
 *       undeclaredTypeImports: ["JSXElement"],
 *     });
 */
export function solidCompatSurfaceSuite(api: SurfaceSuiteApi, options: SurfaceSuiteOptions): void {
  const { describe, test, expect } = api;
  const {
    vendorPackages,
    realSurfaces,
    root = process.cwd(),
    ariaAttributeFix = false,
    srcDir = "src",
    toolingFile = "vite/some-plugin.ts",
    minimumVendorImports = 10,
    undeclaredTypeImports,
    exportsWantedOnlyByOtherConsumers,
  } = options;

  const modulesDir = join(root, "node_modules");

  /** specifier -> name -> the vendor files importing it, split by position. */
  const demand = ((): Map<Shimmed, Map<string, Demanded>> => {
    const bySpec = new Map<Shimmed, Map<string, Demanded>>();
    for (const spec of SHIMMED_SPECIFIERS) bySpec.set(spec, new Map());
    for (const pkg of vendorPackages) {
      for (const file of walk(join(modulesDir, pkg))) {
        let src: string;
        try {
          src = readFileSync(file, "utf8");
        } catch {
          continue;
        }
        for (const match of src.matchAll(IMPORT_RE)) {
          const spec = match[3] as Shimmed;
          if (!SHIMMED_SPECIFIERS.includes(spec)) continue;
          const byName = bySpec.get(spec);
          if (!byName) continue;
          // ⚠️ AN IMPORT IN A DECLARATION FILE IS TYPE-POSITION WHETHER OR NOT IT
          // SAYS `type`. A `.d.ts` has no runtime; nothing in it can resolve to
          // `undefined`. See `namedBindings` for the seven false positives this
          // prevents.
          const isDeclarationFile = /\.d\.(ts|cts|mts)$/.test(file);
          for (const [name, isType] of namedBindings(
            match[2] ?? "",
            Boolean(match[1]) || isDeclarationFile,
          )) {
            if (!byName.has(name)) byName.set(name, { valueFiles: [], typeFiles: [] });
            const entry = byName.get(name);
            if (!entry) continue;
            const rel = file.replaceAll("\\", "/");
            (isType ? entry.typeFiles : entry.valueFiles).push(rel);
          }
        }
      }
    }
    return bySpec;
  })();

  async function suppliedNames(spec: Shimmed): Promise<Set<string>> {
    const real =
      spec === "solid-js"
        ? Object.keys(await realSurfaces["solid-js"]())
        : spec === "solid-js/web"
          ? Object.keys(await realSurfaces["@solidjs/web"]())
          : [];
    return new Set([...real, ...shimLocalExports(SHIM_FILE_FOR[spec])]);
  }

  test("the vendor scan found imports at all (a silent empty walk passes every guard below)", () => {
    const total = [...demand.values()].reduce((n, m) => n + m.size, 0);
    expect(total).toBeGreaterThan(minimumVendorImports);
  });

  describe("every shim export is wanted by a vendor somewhere", () => {
    const wanted = new Set<string>();
    // A name is "wanted" if ANY shimmed specifier supplies it, because the three
    // files deliberately share implementations.
    for (const spec of SHIMMED_SPECIFIERS) {
      for (const name of demand.get(spec)?.keys() ?? []) wanted.add(name);
    }
    const orphaned = Object.values(SHIM_FILE_FOR)
      .flatMap((file) => shimLocalExports(file))
      .filter((name) => !wanted.has(name) && !(name in INTERNAL_OR_CORRECTIVE));

    /*
     * One assertion over all three files rather than one per file: an export is
     * shared between the shim files on purpose, so "which file declares it" is
     * not the question — "does any vendor anywhere want it" is. Asserting per
     * file also split the declared set three ways and made it unreadable.
     */
    test("exports with no vendor consumer in THIS tree are exactly the declared set", () => {
      expect([...new Set(orphaned)].sort()).toEqual([...exportsWantedOnlyByOtherConsumers].sort());
    });
  });

  describe("every name a vendor imports is actually supplied", () => {
    test("no vendor VALUE import resolves to undefined", async () => {
      const unsupplied: string[] = [];
      for (const spec of SHIMMED_SPECIFIERS) {
        const supplied = await suppliedNames(spec);
        for (const [name, { valueFiles }] of demand.get(spec) ?? []) {
          if (valueFiles.length === 0 || supplied.has(name)) continue;
          const extra = valueFiles.length > 1 ? ` (+${valueFiles.length - 1} more)` : "";
          unsupplied.push(`${spec} :: ${name} <- ${valueFiles[0]}${extra}`);
        }
      }
      expect(unsupplied).toEqual([]);
    });

    /** Type and interface names the installed Solid 2 packages actually declare,
     * read from their own `.d.ts` so the list is not hand-maintained. */
    function declaredTypeNames(): Set<string> {
      const names = new Set<string>();
      // ⚠️ `@solidjs/signals` IS IN THIS LIST DELIBERATELY. `solid-js`'s own
      // types re-export the reactive ones from there rather than declaring them,
      // so scanning only the two packages vendors NAME reports `Accessor` as
      // undeclared when it is declared one hop away. The scan is textual and
      // does not follow re-exports; naming the backing package is cheaper and
      // less fragile than resolving them.
      for (const pkg of ["solid-js", "@solidjs/web", "@solidjs/signals"]) {
        for (const file of walk(join(modulesDir, pkg))) {
          if (!/\.d\.(ts|cts|mts)$/.test(file)) continue;
          for (const m of readFileSync(file, "utf8").matchAll(
            /\b(?:export\s+)?(?:declare\s+)?(?:type|interface|namespace)\s+(\w+)/g,
          )) {
            if (m[1]) names.add(m[1]);
          }
        }
      }
      return names;
    }

    test("vendor type-only imports Solid 2 does not declare — a known, inert set", async () => {
      const types = declaredTypeNames();
      const found: string[] = [];
      for (const spec of SHIMMED_SPECIFIERS) {
        const supplied = new Set([...(await suppliedNames(spec)), ...types]);
        for (const [name, { valueFiles, typeFiles }] of demand.get(spec) ?? []) {
          if (valueFiles.length > 0 || typeFiles.length === 0) continue;
          if (supplied.has(name)) continue;
          found.push(name);
        }
      }
      expect([...new Set(found)].sort()).toEqual([...undeclaredTypeImports].sort());
    });
  });

  /**
   * THE GATE ITSELF, EXERCISED. Everything above measures what the shim
   * CONTAINS; this measures who it is HANDED TO, which is the actual rule ("the
   * shim serves vendor code only").
   *
   * ⚠️ WHY IT IS DRIVEN DIRECTLY RATHER THAN THROUGH A BUILD. A build tells you
   * the answer for the importers it happens to contain, and the interesting cases
   * are the ones no build contains. The predecessor guard in the plugin was
   * introduced as "THE MIGRATION'S ENFORCEMENT, NOT A DEBUG AID" and could not
   * fire — it sat after the vendor check, so reaching it needed an importer both
   * inside a vendor package AND containing `/src/`. Nothing executed it in either
   * direction, and nothing said so, because an enforcement mechanism that never
   * fires looks exactly like one that is never violated.
   */
  describe("the vendor-only gate is enforced, not merely documented", () => {
    const base = root.replaceAll("\\", "/");
    // `resolveId` only needs a Rollup `this` for the virtual-bypass branch,
    // which none of these cases take.
    const resolve = (source: string, importer: string) =>
      (
        solid1CompatShim({ vendorPackages, ariaAttributeFix }).resolveId as (
          this: unknown,
          s: string,
          i: string,
          o: unknown,
        ) => unknown
      ).call({}, source, importer, { ssr: false });

    test("application code asking for a specifier Solid 2 dropped fails loudly", async () => {
      for (const source of ["solid-js/web", "solid-js/store"]) {
        await expect(
          Promise.resolve().then(() => resolve(source, `${base}/${srcDir}/components/anything.tsx`)),
        ).rejects.toThrow(/vendor-only/);
      }
    });

    test("application code asking for bare solid-js is left completely alone", async () => {
      // ⚠️ THE REGRESSION THIS LOCKS. Gating the throw on the shim keys rather
      // than on the DROPPED specifiers threw for bare `solid-js` too — a real
      // Solid 2 package every application file imports — while claiming "Solid 2
      // has no such specifier" about it.
      await expect(resolve("solid-js", `${base}/${srcDir}/lib/anything.ts`)).resolves.toBeNull();
    });

    test("a vendor importer gets the shim", async () => {
      /**
       * ⚠️ THE VENDOR FILE IS DISCOVERED, NOT HARDCODED. A pinned path like
       * `@ark-ui/solid/dist/chunk/EIZK5ZYY.js` is a content hash: it is correct
       * for one installed version of one consumer and silently becomes a test of
       * nothing — `walk` returns `[]` for an absent path, so the assertion would
       * be skipped rather than failed.
       */
      const vendorFile = vendorPackages
        .map((pkg) => walk(join(modulesDir, pkg)).find((f) => /\.(js|mjs|cjs)$/.test(f)))
        .find((f): f is string => Boolean(f));
      expect(String(vendorFile)).toMatch(/node_modules/);
      const shimmed = await resolve("solid-js", (vendorFile as string).replaceAll("\\", "/"));
      expect(String(shimmed)).toMatch(/solid-1-compat\.ts$/);
    });

    test("a non-vendor, non-application importer is left alone rather than shimmed", async () => {
      await expect(resolve("solid-js", `${base}/${toolingFile}`)).resolves.toBeNull();
    });

    test(`@solidjs/web is ${ariaAttributeFix ? "shimmed for EVERY importer" : "left alone when ariaAttributeFix is off"}`, async () => {
      // Not a Solid 1 bridge — the `aria-*` boolean-attribute correction. If a
      // consumer that enables it ever starts getting `null` here, the correction
      // has silently stopped applying to its own code, which is most of what
      // renders.
      for (const importer of [`${base}/${srcDir}/routes/root.tsx`, `${modulesDir}/x/y.js`]) {
        const got = await resolve("@solidjs/web", importer.replaceAll("\\", "/"));
        if (ariaAttributeFix) expect(String(got)).toMatch(/solid-2-aria-attributes\.ts$/);
        else expect(String(got)).toMatch(/^(null|undefined)$/);
      }
    });
  });

  /**
   * ── THE VENDOR SHAPE THAT HALTED A CONSUMER, HELD IN PLACE BY TEXT ──────────
   *
   * `@tanstack/solid-virtual` writes a STORE from inside a Solid 1 single-argument
   * `createComputed`, which this layer maps onto `createTrackedEffect`. That one
   * shape walked into two separate faults, the second hidden behind the first,
   * and between them they took every later update in the page down with
   * `[REACTIVITY_HALTED]` — a click handler that runs and renders nothing. Both
   * repairs are easy to undo by tidying, so both are pinned here.
   *
   * ⛔ THESE ARE TEXT ASSERTIONS AND THAT IS NOT LAZINESS — A BEHAVIOURAL VERSION
   * WAS WRITTEN FIRST AND MEASURED VACUOUS. The obvious better test is to drive
   * the consumer's real Solid: create a tracked effect, write a store from it,
   * watch what the runtime does. Run against web-next it reported
   *
   *     before flush v= never ran | R1: never ran | R2: wrote
   *
   * — the effect body NEVER EXECUTED, even after an explicit `flush()`, and a
   * store write with a deliberately invalid key succeeded. That consumer's runner
   * resolves `solid-js` under node conditions, which is the SSR build, where
   * effects do not run and writes are inert. The test passed nothing and failed
   * nothing. ⚠️ EVERY CONSUMER PICKS ITS OWN CONDITIONS, so a shared suite cannot
   * assume a reactive runtime is present — the runtime half of this lives in a
   * consumer that runs its tests with `--conditions=browser`, where it can
   * actually observe the guard.
   */
  describe("the store-write repairs are still wired up", () => {
    test("every store write goes through the permit that re-arms the forbidden bit", () => {
      const core = readFileSync(join(SHIM_DIR, "solid-1-compat.ts"), "utf8");

      /*
       * ⛔ WHY THE PERMIT EXISTS AT ALL. `CONFIG_CHILDREN_FORBIDDEN` is not only
       * "no primitives here" — `devGuardStoreSetterWrite` reads it NEGATED:
       *
       *     if (context && !(context._config & CONFIG_CHILDREN_FORBIDDEN)) throw
       *
       * so the bit being SET is precisely what makes a vendor's store write legal
       * inside a tracked effect. It is also the bit this layer's nested-primitive
       * repair has to CLEAR. One bit, two opposite needs; the setter puts it back
       * for the duration of the write and for nothing else.
       *
       * ⚠️ COUNTED, NOT MERELY PRESENT. The setter has two arms — the native
       * single-function call and the legacy path form — and an unwrapped arm is
       * invisible until a vendor happens to use that spelling.
       */
      const realSetCalls = [...core.matchAll(/realSet\(/g)].length;
      const permitted = [...core.matchAll(/withStoreWritePermit\(\s*\(\)\s*=>\s*\n?\s*realSet\(/g)];
      expect([realSetCalls, permitted.length]).toEqual([2, 2]);
    });

    test("the /store subpath hands back the shim's reconcile, not the real one", () => {
      const store = readFileSync(join(SHIM_DIR, "solid-1-compat-store.ts"), "utf8");

      /*
       * ⛔ THE SUBPATH IS THE ONLY ROUTE `@tanstack/solid-virtual`'s reconcile
       * calls travel — it imports `{ createStore, reconcile }` from
       * `solid-js/store` and nothing else — so a wrapper in `solid-1-compat.ts`
       * that this file does not re-export is a wrapper that is never reached.
       * This line read `from "virtual:solid-1-compat-real/solid-js"` for exactly
       * as long as no installed vendor passed Solid 1's options-object second
       * argument, and the comment saying so stayed correct-looking afterwards.
       */
      expect(store).toMatch(/export\s*\{\s*createStore,\s*reconcile\s*\}\s*from\s*"\.\/solid-1-compat"/);
    });
  });
}
