/*
 * ═══════════════════════════════════════════════════════════════════════════
 * SOLID 1 -> 2 COMPATIBILITY LAYER  ·  THE `aria-*` CORRECTION (opt-in, off by default)
 *
 * One shared copy, kept in tLib and consumed by five projects. `README.md` in
 * this directory documents the layer as a whole: what it solves, what each of
 * the five modules does, how a project adopts it, what `vendorPackages` is for
 * and how to derive one, and the debug environment variables. Read that first.
 *
 * ── TWO CONVENTIONS HOLD THROUGHOUT THESE FILES ──────────────────────────
 *
 *  · EVERY CLAIM WITH A NUMBER BEHIND IT IS A MEASUREMENT, and the number is
 *    the reason the code below is the shape it is. Several of them record
 *    failures that were expensive to diagnose and are silent when they recur.
 *    Re-measure before changing the code a number justifies; do not delete the
 *    number because the prose around it reads as history.
 *  · A MEASUREMENT IS STATED AT THE SCOPE IT WAS TAKEN AT. "Across the
 *    supported set" means every consumer's installed `node_modules` tree. A
 *    claim about `src/` is a claim about the consuming project's own `src/`,
 *    and a named project appears as the EVIDENCE for a claim, never as its
 *    subject. Re-measure at the union of all consumers before inheriting a
 *    conclusion into this shared copy.
 *
 * ── FORMATTING ─────────────────────────────────────────────────────
 *
 * `tLib/biome.json` excludes this directory, deliberately. biome and the
 * consumers' formatter (oxfmt, via `vp fmt`) disagree on import order and line
 * breaking here — measured, biome wants to rewrite all seven files — and the
 * churn would bury the annotations that are the only record of why each shim
 * is the shape it is.
 *
 * ⚠️ NOTHING FORMATS OR LINTS THIS DIRECTORY TODAY, AND THAT IS A GAP RATHER
 * THAN A DESIGN. Measured: every consumer's `fmt`/`lint` script names only its
 * own `src` and configs, and `vp fmt` refuses a path containing `..`, so a
 * consumer cannot point it here even by hand. Match the surrounding style when
 * you edit, and do not assume a green `vp fmt --check` in a consumer says
 * anything about these files. See README.md § Formatting.
 * ═══════════════════════════════════════════════════════════════════════════
 */
/**
 * `@solidjs/web`, with ONE correction: `aria-*` is not an HTML boolean attribute.
 *
 * ── ⚠️ OPT-IN. IT IS OFF UNLESS A PROJECT ASKS FOR IT ───────────────────────
 *
 * This module is only reached when a consumer passes
 * `solid1CompatShim({ ..., ariaAttributeFix: true })`. The default is `false`.
 * That is a scope decision, not a doubt about the fix: enabling it changes the
 * rendered `aria-*` output of every importer, and no build, typecheck or unit
 * test in these projects can observe that change. Enable it together with a
 * check that reads rendered output. See `Solid1CompatShimOptions` in
 * solid-1-compat-plugin.ts, and README.md § ariaAttributeFix.
 *
 * ── ⚠️ THIS IS NOT PART OF THE SOLID 1 COMPAT LAYER, AND THE DISTINCTION
 *    DECIDES WHO IT APPLIES TO ─────────────────────────────────────────────────
 *
 * Every other file named `solid-1-compat-*` in this directory exists to let
 * VENDOR code written for Solid 1 keep working, and is deliberately scoped to
 * packages under `node_modules`. This one is different: it corrects a behaviour
 * of Solid 2 itself that is wrong for every caller, application code included,
 * so when it is enabled `solid-1-compat-plugin.ts` redirects `@solidjs/web` to
 * this file for EVERY importer. A project's own JSX is as affected as Ark UI's.
 *
 * ── THE REGRESSION, WITH BOTH SIDES READ RATHER THAN INFERRED ────────────────
 *
 * Solid 1.9 (`node_modules/solid-js/web/dist/dev.js`):
 *
 *     function setAttribute(node, name, value) {
 *       if (value == null) node.removeAttribute(name);
 *       else node.setAttribute(name, value);
 *     }
 *
 * Solid 2 (`@solidjs/web/dist/web.dev.js`):
 *
 *     if (value == null || value === false) node.removeAttribute(name);
 *     else node.setAttribute(name, value === true ? "" : value);
 *
 * Solid 1 stripped only on `null`/`undefined`, so `aria-pressed={false}` was
 * string-coerced to `"false"` — correct. Solid 2 added the HTML
 * boolean-attribute rule and applied it to EVERY attribute name. Neither version
 * special-cases `aria-*`. The result:
 *
 *     aria-pressed={true}   ->  aria-pressed=""   (invalid: ARIA requires
 *                                                  "true" | "false" | "mixed")
 *     aria-pressed={false}  ->  attribute ABSENT  (to a screen reader that means
 *                                                  "not a toggle button", not
 *                                                  "a toggle button that is off")
 *
 * ── AND IT IS UNDOCUMENTED, WHICH IS WHY IT COUNTS AS A REGRESSION ──────────
 *
 * `assets/reference/solid/solidjs-web-rendering-and-dom.txt` — the DOM reference
 * for this exact package — contains ZERO occurrences of `aria-`. The only
 * boolean-stripping rule the docs describe anywhere is for `style`.
 * `migration.txt`'s `aria` hits are all incidental (`aria-busy`, `aria-current`
 * inside CSS examples); none of them describes this change. So there was no
 * migration step anybody could have followed, and nothing in the documentation a
 * reader could be referred to instead of this file.
 *
 * ── WHY A SHIM AND NOT A PATCH, AND WHAT THAT COSTS ────────────────────────
 *
 * Patching `@solidjs/web` would be one line in `setAttribute` and would catch
 * every path at once, because `spread` -> `assign` -> `assignProp` ->
 * `setAttribute` is an entirely MODULE-LOCAL call chain — those internals are
 * closed over and a re-export cannot reach them. We patch things to support
 * Solid 2, not Solid 2 to support us, so the chain is intercepted at its
 * ENTRY POINTS instead: the only way into it is through an export that the JSX
 * compiler emits a call to.
 *
 * ⚠️ THAT MAKES THE EXPORT LIST BELOW LOAD-BEARING RATHER THAN DEFENSIVE. Miss
 * one and the paths through it are silently uncorrected — which is exactly the
 * failure mode this whole file is about. `solid-2-aria-attributes.test.ts`
 * exercises the direct path and the spread path, on the client and on the
 * server, and fails on the unshimmed package.
 *
 * ── WHY THE PROPS WRAPPER IS LAZY ───────────────────────────────────────────
 *
 * `spread`/`ssrElement` receive props that may be a function, an array of
 * sources, or an object whose keys are GETTERS — that laziness is what makes a
 * spread reactive. Coercing eagerly would read every getter once, at spread
 * time, and freeze the result. So the wrapper is a `Proxy` that coerces in `get`,
 * at the moment the real implementation reads the key, and passes symbols
 * straight through untouched so store/`$PROXY` internals are unaffected.
 */
import * as real from "virtual:solid-1-compat-real/@solidjs/web";

export * from "virtual:solid-1-compat-real/@solidjs/web";

/**
 * Attribute names whose value is a STRING in ARIA even when it reads like a
 * boolean. `role` is here for the same reason: `role={false}` is meaningless, and
 * silently dropping it is worse than writing it.
 *
 * ⚠️ `aria-hidden` IS INCLUDED DELIBERATELY, and it is the one that looks wrong.
 * `aria-hidden="false"` and an absent `aria-hidden` are NOT equivalent: the first
 * overrides an inherited `aria-hidden="true"` from an ancestor, the second
 * inherits it. Dropping it is how a visible control inside a hidden container
 * stays invisible to a screen reader.
 */
function isAriaName(name: string): boolean {
  return name.startsWith("aria-") || name === "role";
}

function coerce(name: string, value: unknown): unknown {
  return typeof value === "boolean" && isAriaName(name) ? String(value) : value;
}

/** Lazily coerces `aria-*` booleans in whatever shape of props source this is. */
function wrap<T>(props: T): T {
  if (props == null) return props;
  if (typeof props === "function") {
    return ((...args: unknown[]) => wrap((props as (...a: unknown[]) => unknown)(...args))) as T;
  }
  if (Array.isArray(props)) return props.map((entry) => wrap(entry)) as unknown as T;
  if (typeof props !== "object") return props;
  return new Proxy(props as object, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      return typeof key === "string" ? coerce(key, value) : value;
    },
  }) as T;
}

/* ── The direct path: a static attribute the compiler binds by name ────────── */

export function setAttribute(node: Element, name: string, value: unknown): void {
  (real as any).setAttribute(node, name, coerce(name, value));
}

export function setAttributeNS(
  node: Element,
  namespace: string,
  name: string,
  value: unknown,
): void {
  (real as any).setAttributeNS(node, namespace, name, coerce(name, value));
}

/* ── The spread path: `{...props}`, where the names are not known statically ── */

export function spread(node: Element, props: unknown, ...rest: unknown[]): unknown {
  return (real as any).spread(node, wrap(props), ...rest);
}

export function assign(node: Element, props: unknown, ...rest: unknown[]): unknown {
  return (real as any).assign(node, wrap(props), ...rest);
}

/* ── The server. An SSR'd value that disagrees with the hydrated one is a ─────
 *    hydration mismatch on top of an accessibility bug, so both are covered.   */

export function ssrAttribute(key: string, value: unknown, ...rest: unknown[]): string {
  return (real as any).ssrAttribute(key, coerce(key, value), ...rest);
}

export function ssrElementAttribute(key: string, value: unknown, ...rest: unknown[]): string {
  return (real as any).ssrElementAttribute(key, coerce(key, value), ...rest);
}

export function ssrElement(
  tag: string,
  props: unknown,
  children: unknown,
  ...rest: unknown[]
): unknown {
  return (real as any).ssrElement(tag, wrap(props), children, ...rest);
}
