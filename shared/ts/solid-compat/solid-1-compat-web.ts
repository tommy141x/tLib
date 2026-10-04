/// <reference path="./solid-1-compat-virtual.d.ts" />
/*
 * ═══════════════════════════════════════════════════════════════════════════
 * SOLID 1 -> 2 COMPATIBILITY LAYER  ·  THE `solid-js/web` SHIM
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
 * VENDOR COMPATIBILITY ONLY. Not reachable from `src/`.
 *
 * Companion to solid-1-compat.ts for the `solid-js/web` → `@solidjs/web`
 * relocation: Solid 2 moved the DOM runtime out of the `solid-js` package
 * entirely, so a vendor `from "solid-js/web"` has nothing to resolve to. This
 * module is what that specifier resolves to instead. Re-exports everything
 * real `@solidjs/web` provides, plus `use()`, the Solid 1 `use:` directive
 * helper that has no 2.0 equivalent (directives themselves are removed in
 * favor of ref callbacks, but this restores the helper's call shape so
 * compiled Solid-1 output invoking it directly still runs).
 *
 * Uses the `virtual:solid-1-compat-real/*` bypass for its own import of the
 * real package — see solid-1-compat.ts's header and
 * solid-1-compat-plugin.ts's for why a plain bare import breaks here.
 */
import {
  spread as realSpread,
  SVGElements,
  Namespaces,
  Dynamic as realDynamic,
  effect as realEffect,
  isServer,
} from "virtual:solid-1-compat-real/@solidjs/web";
// `sharedConfig` is NOT exported by @solidjs/web's CLIENT production build
// (`dist/web.js`) — only by its dev and server builds, which is why importing
// it from there fails the production build with MISSING_EXPORT. `solid-js`
// core exports it from every build (client prod, client dev, server), so the
// hydration flag is read from core instead.
import { sharedConfig } from "virtual:solid-1-compat-real/solid-js";

export * from "virtual:solid-1-compat-real/@solidjs/web";

// `@solidjs/web` re-exports the flow components (`Show`/`Switch`/`Match`/
// `For`) as well as `solid-js` does, and vendor code imports them from BOTH
// spellings — `@ark-ui/solid`'s json-tree-view chunk does
// `import { Index, Show } from "solid-js/web"`. The `Show`/`Switch` fix lives
// in solid-1-compat.ts (see its long header for the measured DOM-rebuild bug
// it fixes); re-export it here so the `solid-js/web` spelling gets the fixed
// version too rather than falling through to real Solid 2's tracked-children
// one via the `export *` above.
// ⚠️ `Index` IS IN THAT SAME IMPORT AND WAS MISSING FROM THIS LINE — a real
// hole, found by enumerating what vendors ask of each shimmed specifier rather
// than by waiting for a build to fail. `Show` and `Switch` are re-exported
// above because the SHIMMED versions are better than the real ones; `Index` is
// re-exported because there is no real one to fall through TO. Solid 2 removed
// it outright (confirmed against the installed package's export surface:
// absent from both `solid-js` and `@solidjs/web`), so the `export *` above
// cannot supply it and the two `@ark-ui/solid` chunks importing it this way
// would have resolved it to `undefined`.
//
// WHY NOTHING HAS BROKEN YET, stated so this does not read as a live bug fix:
// both importers are the json-tree-view chunk, and `src/` uses no Ark UI
// JsonTreeView — so the chunk is never pulled into a bundle. It is a landmine,
// not a fault: the first use of that one component would have failed, and
// `Index` being `undefined` surfaces as a JSX call on a non-function far from
// the import that caused it.
export { Index, Show, Switch } from "./solid-1-compat";

export function use(fn: any, element: any, arg: any) {
  return fn(element, typeof arg === "function" ? arg : () => arg);
}

// --- effect: the SECOND ARGUMENT CHANGED MEANING BETWEEN SOLID 1 AND 2 ------
//
// ⛔ THIS IS A SIGNATURE COLLISION, NOT A RENAME, WHICH IS WHY `export *` ABOVE
// LET IT THROUGH SILENTLY. `effect` exists under the same name in both
// versions, so nothing failed to resolve and no MISSING_EXPORT was reported —
// only the MEANING of argument two moved:
//
//   Solid 1 (`solid-js/web`):  effect(fn, initialPrev?)
//       `initialPrev` is the VALUE handed to `fn` on its first run; `fn`'s
//       return becomes the next run's argument. One function, tracked reads and
//       DOM writes in the same (render-phase) scope — it was literally
//       `createRenderEffect` re-exported.
//   Solid 2 (`@solidjs/web`):  effect(compute, effectFn, options?)
//       Confirmed by reading `node_modules/@solidjs/web/dist/web.js` /
//       `web.dev.js` directly: argument two is a FUNCTION, the write half of
//       `createRenderEffect(compute, effectFn, options)`, and nothing carries
//       an initial `prev` at all.
//
// Every Solid 1 JSX compiler emits exactly the colliding shape for any element
// with two or more dynamic bindings — an accumulator object of one slot per
// binding, passed as argument two so the first run has something to diff
// against:
//
//     effect(_p$ => {
//       _v$ !== _p$.e && setAttribute(el, "srcset", _p$.e = _v$);
//       ...
//       return _p$;
//     }, { e: undefined, t: undefined });
//
// Under Solid 2 that object is consumed as `effectFn` and `compute` is invoked
// with `prev === undefined`, so the FIRST line of the generated callback reads
// `.e` off `undefined`.
//
// ⚠️ MEASURED, NOT INFERRED. `/admin` served a perfect SSR document and then
// died during hydration behind the router's error boundary — nothing in the
// console, because the boundary caught it — with
// `TypeError: Cannot read properties of undefined (reading 'e')`. The stack,
// captured from a `-m development` build (production minification and the
// boundary's own message sanitising both hide it):
//
//     at Sn.s.e (assets/solid-<hash>.js)      <- @tanstack/charts' compiled
//                                                `<Chart>`: `s(r => { ...
//                                                i !== r.e && c(e, r.e = i)
//                                                ... }, { e: void 0, t: void 0 })`
//     at Object.i [as _fn] (assets/web.dev-<hash>.js)  <- @solidjs/web `effect`
//     ... Solid 2's render-effect scheduler ...
//
// The `'e'` is NOT a minified property name, which is what made the production
// trace so misleading: `e` is the literal first slot name the Solid 1 compiler
// assigns, and it is spelled `e` in the vendor's own published, pre-compiled
// source.
//
// ⛔ AND IT IS NOT ONE PACKAGE'S BUG. `@responsive-image/solid`'s
// `dist/index.js` carries the identical shape (`{ e: undefined, t: undefined,
// a: undefined }`, three `setAttribute`s off `_p$`) on its `<source>` element —
// latent only because that branch needs `imageTypes !== "auto"`. Any
// Solid-1-compiled vendor artifact with two dynamic bindings on one element
// hits this, so the fix belongs here, in the shim every such package already
// resolves `solid-js/web` through, and not in a per-package patch.
//
// THE MAPPING. Solid 2's `compute` already receives its own previous return
// value as `prev`, which is the whole of Solid 1's threading; the only gap is
// the FIRST call's value. So the Solid 1 shape becomes Solid 2's
// `(compute, effectFn)` with the vendor callback as the compute — same render
// phase, same tracked-reads-and-writes-together scope Solid 1 gave it — a no-op
// write half, and the supplied accumulator substituted for `prev` on run one.
//
// ⚠️ DISPATCH IS ON `typeof`, AND IT CANNOT COLLIDE. A Solid 2 caller's second
// argument is always a function (Solid 2's own scheduler calls it
// unconditionally, so a Solid 2 call with a non-function there is already
// broken today); a Solid 1 caller's is always a plain object literal or absent.
// A bare one-argument `effect(fn)` — Solid 1's other legal shape — therefore
// also lands on the compat path, which is right: under real Solid 2 it would
// crash in `effectFn(value, prev)` with `effectFn` undefined.
const NO_WRITE_PHASE = () => {};

export function effect(fn: any, second?: any, options?: any) {
  if (typeof second === "function") {
    return (realEffect as any)(fn, second, options);
  }
  let firstRun = true;
  return (realEffect as any)(
    (prev: any) => {
      if (firstRun) {
        firstRun = false;
        return fn(second);
      }
      return fn(prev);
    },
    NO_WRITE_PHASE,
    options,
  );
}

// --- Dynamic: Solid 1's simple "render this tag/component" semantics ------
// Solid 2's real `Dynamic` was rebuilt around a new server-component
// "flight"/binding-delivery system (`dynamic()`'s `bindingOf`/bound
// address tracking, in @solidjs/web's source). Passed a plain DOM tag-name
// STRING — exactly lucide-solid's `<Dynamic component={elementName} {...attrs}
// />` per-child-element pattern in Icon.jsx — that machinery does not produce
// a real element: it produced a bare `{ t: "<path d=... key=...></path>" }`
// object (an internal server/"flight" marker, going by the shape) that
// happy-dom's `insertBefore` then received as if it were a DOM node and
// crashed on, deep in Solid's reactive system
// ("REACTIVITY_HALTED" / "Cannot read properties of undefined (reading
// 'length')"). Confirmed by instrumenting happy-dom's `insertBefore` to log
// exactly what it was asked to insert. This is a real architectural
// incompatibility, not a rename — lucide-solid has no Solid 2-ready release
// (confirmed earlier: open upstream PR, not merged) and could not reasonably
// be expected to anticipate a rewrite of `<Dynamic>`'s delivery model.
// Re-implementing Solid 1's actual (much simpler) `Dynamic` — component
// function or plain tag name only, no flight/binding delivery — using Solid
// 2's own exported `spread`/`SVGElements`/`Namespaces` restores exactly the
// subset of behavior Solid-1-era code (lucide-solid and anything else still
// written this way) actually relies on, without touching the real
// `createComponent`/`dynamic()` that components written for Solid 2's actual
// server-component system still need.
// `htmlFor` was Solid 1's (and React's) JSX-safe spelling of the real DOM
// attribute `for` — confirmed genuinely gone from this Solid 2 RC build by
// grepping the whole real `@solidjs/web` package for "htmlFor" (zero
// matches) and by direct DOM inspection: a native `<label htmlFor="x">`
// written in real Solid 2 sets a literal, inert `htmlfor` attribute, not
// `for`. The correct fix for OUR OWN code is to write `for` directly, which
// is what real Solid 2 wants — NOT to patch the real framework back into
// Solid-1 shape (tried that first; reverted, since monkey-patching
// `@solidjs/web` itself defeats the entire point of a vendor-SCOPED compat
// shim: everyone, not just unfixable vendor code, would silently depend on
// a non-standard runtime). `@ark-ui/solid`'s `Field.Label` (no Solid 2
// release, can't be fixed) still writes `htmlFor` internally and has no
// other way to spell it, so the alias stays — scoped to exactly this
// shim, which only vendor code's compiled JSX passes through.
const HTML_FOR_ALIAS = "htmlFor";
const REAL_FOR = "for";

// Solid 1's `setAttribute` stringified any value unconditionally. Solid 2's
// real `setAttribute` (confirmed by reading it directly) now applies the
// correct NATIVE-HTML-boolean-attribute convention: `value === true` writes
// an empty string, `value === false` removes the attribute entirely — right
// for `disabled`/`required`/etc., but wrong for ARIA, whose boolean state
// attributes (`aria-expanded`, `aria-invalid`, `aria-hidden`, ...) are
// defined to carry the literal STRING `"true"`/`"false"`, not presence/
// absence. `@ark-ui/solid`'s own machines (no Solid 2 release) compute these
// as raw JS booleans and hand them straight to a spread, same as Solid 1
// always did — confirmed live: `aria-expanded` recomputed correctly to the
// boolean `true` on every state change (not a reactivity bug at all), but
// `trigger.getAttribute("aria-expanded")` read back `""`, matching
// `setAttribute`'s own documented boolean-to-empty-string coercion exactly.
// Coercing only `aria-*` keys here, and only when the value is a genuine
// boolean (an explicit string "true"/"false" passes through untouched).
function coerceAriaBoolean(prop: string, value: unknown): unknown {
  if (typeof value === "boolean" && prop.startsWith("aria-")) {
    return value ? "true" : "false";
  }
  return value;
}

export function Dynamic(props: any) {
  const comp = props.component;
  // Empty dummy target, not `props` itself — see solid-1-compat.ts's
  // `splitProps` header for why wrapping the real props object directly is
  // a Proxy-invariant crash waiting to happen (a non-configurable own
  // property can't be legally hidden by `ownKeys`/`getOwnPropertyDescriptor`).
  const rest = new Proxy(
    {},
    {
      // `props` here can itself be a REAL Solid reactive props view (e.g. a
      // merge of a literal `{component: ...}` with a spread `{...parentProps}`
      // — exactly ark-ui's `withAsProp` factory's own `<Dynamic component={...}
      // {...parentProps} />` call shape). Real Solid views are tagged with a
      // well-known `$PROXY` symbol, and `@solidjs/web`'s `spread()` checks for
      // it (`viewOf`/`collectProps`'s `$PROXY in source` branch) to read the
      // view's underlying RECORD directly via `$RECORD` — bypassing a plain
      // JS Proxy's `get`/`ownKeys` traps entirely once that record is found.
      // Confirmed live: `Object.keys(rest)` and `rest.for` both correctly
      // showed the aliased name BEFORE `spread()`, yet the element that came
      // out the other side still carried the literal unaliased `htmlfor`
      // attribute — because `prop in props` below, for `prop = $PROXY`,
      // forwarded straight through to the real `props` (which IS `$PROXY`-
      // tagged), so Solid's view-detection saw straight past this wrapper to
      // the record it wraps. Excluding every SYMBOL key here — not just
      // `component` — makes this Proxy present as a genuinely plain object
      // with no such tag, which routes `spread()` through the normal
      // SOURCE_PLAIN path that actually calls `get`/`ownKeys`.
      get(_target, prop) {
        if (typeof prop === "symbol") return undefined;
        if (prop === "component") return undefined;
        if (prop === REAL_FOR && !(REAL_FOR in props) && HTML_FOR_ALIAS in props) {
          return props[HTML_FOR_ALIAS];
        }
        return coerceAriaBoolean(prop as string, props[prop as string]);
      },
      has(_target, prop) {
        if (typeof prop === "symbol") return false;
        if (prop === "component") return false;
        if (prop === REAL_FOR && !(REAL_FOR in props) && HTML_FOR_ALIAS in props) return true;
        return prop in props;
      },
      ownKeys(_target) {
        return Reflect.ownKeys(props)
          .filter((key) => typeof key !== "symbol" && key !== "component")
          .map((key) => (key === HTML_FOR_ALIAS && !(REAL_FOR in props) ? REAL_FOR : key));
      },
      getOwnPropertyDescriptor(_target, prop) {
        if (typeof prop === "symbol") return undefined;
        if (prop === "component") return undefined;
        if (prop === REAL_FOR && !(REAL_FOR in props) && HTML_FOR_ALIAS in props) {
          return { enumerable: true, configurable: true, get: () => props[HTML_FOR_ALIAS] };
        }
        if (prop === HTML_FOR_ALIAS && !(REAL_FOR in props)) return undefined;
        if (!(prop in props)) return undefined;
        return {
          enumerable: true,
          configurable: true,
          get: () => coerceAriaBoolean(prop as string, props[prop as string]),
        };
      },
    },
  );
  // Same traps as `rest`, but `component` is visible — the shape the REAL
  // `Dynamic` expects. Built as a Proxy rather than `{component: comp, ...rest}`
  // because an object spread SNAPSHOTS every value and would silently
  // de-reactify the whole element.
  const full = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "component") return props.component;
        return (rest as any)[prop as any];
      },
      has(_t, prop) {
        if (prop === "component") return true;
        return prop in (rest as any);
      },
      ownKeys() {
        return ["component", ...(Reflect.ownKeys(rest as any) as string[])];
      },
      getOwnPropertyDescriptor(_t, prop) {
        if (prop === "component") {
          return { enumerable: true, configurable: true, get: () => props.component };
        }
        return Reflect.getOwnPropertyDescriptor(rest as any, prop as any);
      },
    },
  );
  if (typeof comp === "function") {
    return comp(rest);
  }
  if (typeof comp === "string") {
    // CLIENT: `document.createElement` directly, per this function's header —
    // the real `Dynamic`'s "flight"/binding delivery produced a bare marker
    // object here instead of a real DOM node, confirmed by instrumenting
    // happy-dom's `insertBefore`.
    //
    // SERVER: the opposite problem — `document` does not exist at all
    // (`ReferenceError: document is not defined`, confirmed live via a
    // `-m development` diagnostic build that kept the real, non-sanitized
    // error; production silently replaced it with "Internal Server Error"
    // and blanked the whole page, since this function was never exercised
    // server-side before — every prior check of it ran under Vitest's
    // happy-dom, which always provides `document`). The real `Dynamic`'s
    // server implementation (`node_modules/@solidjs/web/dist/server.dev.js`,
    // confirmed by reading it directly) is just
    // `createComponent(dynamic(() => props.component), omit(props,
    // "component"))` — no DOM API, no flight marker, since SSR output is
    // string-built regardless of tag vs. component. The CLIENT-only flight
    // bug this whole function exists to route around does not apply here, so
    // the server posture can safely delegate to the real implementation
    // instead of reimplementing SSR string-building by hand.
    if (isServer) {
      return (realDynamic as any)(full);
    }
    // HYDRATION: the `document.createElement` path below is correct for a
    // fresh client render and WRONG during hydration, where the element it
    // should produce already exists in the document as SSR output. Real
    // Solid's element creation CLAIMS that existing node (the hydration-key
    // machinery behind `sharedConfig.hydrating`/`claimInitial`); a bare
    // `document.createElement` cannot, and has no public API to. So during
    // the hydration pass this function built a brand-new ORPHAN element,
    // spread the real props onto the orphan, and returned it — and Solid's
    // `insert` kept the SSR node and dropped the orphan.
    //
    // Measured, on the landing page's FAQ accordion (9 `ark.button` item
    // triggers): all 9 elements this function created were `isConnected ===
    // false`, none was identical to any of the 9 live nodes in the document,
    // every orphan carried a working delegated `_$$click` handler, and every
    // LIVE node had `_$$click === undefined`. The accordion was therefore
    // completely inert on a fresh SSR load — a real click reached a live
    // button with no handler on it, so `@zag-js/accordion`'s machine never
    // received `TRIGGER.FOCUS`/`TRIGGER.CLICK` at all (confirmed by tracing
    // `useMachine`'s own `send`: zero events). Nothing threw, nothing
    // logged, and it came back to life after a client-side navigation, which
    // re-renders with `sharedConfig.hydrating` false and so takes the
    // `createElement` path legitimately. That "dead on first load, fine
    // after a nav" signature is the fingerprint of this bug.
    //
    // Delegating the hydration pass to the real `Dynamic` is safe: the
    // "flight marker instead of a DOM node" failure this function exists to
    // route around was observed under Vitest's happy-dom, and does NOT
    // reproduce in a real browser on a production build — verified after
    // this change by counting rendered `lucide-solid` output on the same
    // page (24 `svg.lucide` elements with 56 child nodes between them, i.e.
    // real `<path>`/`<circle>` children, not markers). The hand-rolled path
    // stays for every NON-hydrating client render, which is the case it was
    // written and tested against.
    if ((sharedConfig as any).hydrating) {
      return (realDynamic as any)(full);
    }
    const el = (SVGElements as Set<string>).has(comp)
      ? document.createElementNS((Namespaces as any).svg, comp)
      : document.createElement(comp);
    (realSpread as any)(el, rest);
    return el;
  }
  return undefined;
}
