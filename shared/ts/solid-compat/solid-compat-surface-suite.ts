/**
 * The shim's surface, measured against a consumer's installed vendor tree.
 * See README.md § Testing for the rule this enforces and why it is shared.
 *
 * The assertions are generic; the tree they run against is not —
 * `VENDOR_PACKAGES` runs 2 to 12 entries across consumers, and only
 * `@ark-ui/solid`/`@zag-js/solid` appear in every one. So each consumer runs
 * this against its own `node_modules`, which is also the only way to
 * re-measure at the union across all five.
 *
 * `{ describe, test, expect }` and the real-package imports are injected
 * rather than imported directly, because this file is physically inside
 * tLib: `await import("solid-js")` from here would resolve tLib's installed
 * 1.9.12 and silently measure the wrong surface (Solid 1 has more names than
 * Solid 2, so it would pass while testing nothing — the same trap as the
 * plugin's `createRequire`), and `vitest` is not installed in tLib at all.
 * The consumer's own imports resolve from its own root.
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
 * consumer passes vitest's own objects with no cast.
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
  /** The consumer's `VENDOR_PACKAGES`. */
  vendorPackages: readonly string[];

  /**
   * The consumer's own dynamic imports — see this file's header. Written as
   * `() => import("solid-js")` at the call site so they resolve from the
   * consumer's root. `solid-js/store` has no entry: Solid 2 has no
   * counterpart at all, so there is no real package to compare against.
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
   * Solid 1 type names this consumer's vendors still import that Solid 2
   * does not declare anywhere. Asserted as an exact set so a vendor upgrade
   * that changes it gets looked at. Inert, not broken: type imports are
   * erased before a bundler looks for a binding, and `skipLibCheck` hides
   * them from tsc.
   */
  undeclaredTypeImports: readonly string[];

  /**
   * Shim exports no vendor in this consumer's tree imports. Not dead code —
   * another consumer's vendors may want them, and only the union of all
   * five trees can say otherwise. Measured: a second consumer's first run
   * failed on `batch`/`createComputed`/`observable` as "unused" while all
   * three were live in ITS `node_modules` (`@tanstack/solid-table`,
   * `@solid-primitives/rootless`, `@solid-devtools/logger`, etc.) — a
   * per-project "unused" verdict is a false failure for a shared layer.
   *
   * An exact set, not an allowlist: a name that becomes locally wanted must be
   * removed from here, and a newly orphaned export added.
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
 * Named bindings in an import clause, `as` aliases reduced to the source name
 * (`{ Index as Index2 }` demands `Index`), each marked type-only or not. A
 * namespace or default import contributes no name.
 *
 * The type/value split is read off the import position, not the package:
 * deciding "is it a type?" by scanning installed `.d.ts` files reported
 * seven false positives as missing values (`Accessor`, `JSX`, `JSXElement`,
 * `Component`, `ComponentProps`, `Context`, `ParentProps`), every one from a
 * declaration file where nothing has a runtime.
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
 * with the reason each is not dead code.
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
          // AN IMPORT IN A DECLARATION FILE IS TYPE-POSITION WHETHER OR NOT IT
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

    // One assertion over all three files rather than one per file: an export is
    // shared between the shim files on purpose, so "which file declares it" is
    // not the question — "does any vendor anywhere want it" is.
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
      // `@solidjs/signals` IS IN THIS LIST DELIBERATELY. `solid-js`'s own
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
   * The gate itself, exercised. Everything above measures what the shim
   * contains; this measures who it is handed to. Driven directly rather than
   * through a build, because a build only answers for the importers it
   * happens to contain — a predecessor guard in the plugin sat after the
   * vendor check, needing an importer both inside a vendor package and
   * containing `/src/`, and nothing ever executed it in either direction.
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
      // Regression lock: gating the throw on the shim keys rather than the
      // dropped specifiers threw for bare `solid-js` too, a real Solid 2
      // package every application file imports.
      await expect(resolve("solid-js", `${base}/${srcDir}/lib/anything.ts`)).resolves.toBeNull();
    });

    test("a vendor importer gets the shim", async () => {
      // The vendor file is discovered, not hardcoded: a pinned content-hash
      // path like `@ark-ui/solid/dist/chunk/EIZK5ZYY.js` is correct for one
      // installed version and then silently tests nothing, since `walk`
      // returns `[]` for an absent path.
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
      // This is the aria-* boolean-attribute correction, not a Solid 1
      // bridge, so it must apply to our own code too when enabled.
      for (const importer of [`${base}/${srcDir}/routes/root.tsx`, `${modulesDir}/x/y.js`]) {
        const got = await resolve("@solidjs/web", importer.replaceAll("\\", "/"));
        if (ariaAttributeFix) expect(String(got)).toMatch(/solid-2-aria-attributes\.ts$/);
        else expect(String(got)).toMatch(/^(null|undefined)$/);
      }
    });
  });

  /**
   * The vendor shape that halted a consumer, held in place by text:
   * `@tanstack/solid-virtual` writes a store from inside a Solid 1
   * single-argument `createComputed`, mapped onto `createTrackedEffect`.
   * That shape walked into two faults, the second hidden behind the first,
   * taking every later update on the page down with `[REACTIVITY_HALTED]`.
   * Both repairs are easy to undo by tidying, so both are pinned here.
   *
   * Text assertions, not behavioural, because a behavioural version was
   * measured vacuous: driving a consumer's real Solid to create a tracked
   * effect and write a store from it reported the effect body never
   * executing even after an explicit `flush()`, because that consumer's
   * runner resolves `solid-js` under node conditions (the SSR build, where
   * effects don't run). Every consumer picks its own conditions, so a
   * shared suite cannot assume a reactive runtime is present; the runtime
   * half lives in a consumer that runs with `--conditions=browser`.
   */
  describe("the store-write repairs are still wired up", () => {
    test("every store write goes through the permit that re-arms the forbidden bit", () => {
      const core = readFileSync(join(SHIM_DIR, "solid-1-compat.ts"), "utf8");

      // Counted, not merely present: the setter has two arms (native
      // single-function call, legacy path form), and an unwrapped arm is
      // invisible until a vendor happens to use that spelling.
      const realSetCalls = [...core.matchAll(/realSet\(/g)].length;
      const permitted = [...core.matchAll(/withStoreWritePermit\(\s*\(\)\s*=>\s*\n?\s*realSet\(/g)];
      expect([realSetCalls, permitted.length]).toEqual([2, 2]);
    });

    test("the /store subpath hands back the shim's reconcile, not the real one", () => {
      const store = readFileSync(join(SHIM_DIR, "solid-1-compat-store.ts"), "utf8");

      // `@tanstack/solid-virtual` imports `{ createStore, reconcile }` only
      // from this subpath, so a wrapper in `solid-1-compat.ts` not
      // re-exported here is never reached.
      expect(store).toMatch(/export\s*\{\s*createStore,\s*reconcile\s*\}\s*from\s*"\.\/solid-1-compat"/);
    });
  });
}
