/// <reference path="./solid-1-compat-virtual.d.ts" />
/*
 * ═══════════════════════════════════════════════════════════════════════════
 * SOLID 1 -> 2 COMPATIBILITY LAYER  ·  THE `solid-js` SHIM
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
 * Re-exports everything real `solid-js` 2.0 provides, plus shims for the
 * Solid 1.x names/shapes that 2.0 renamed or removed outright: `onMount`,
 * `mergeProps`, `splitProps`, `Index`, the `on()` dependency-tracking helper,
 * and a legacy single-arg `createEffect` fallback (2.0 requires
 * `(compute, apply)` and throws `[MISSING_EFFECT_FN]` without it).
 *
 * ── WHO REACHES THIS FILE, MEASURED ─────────────────────────────────────────
 *
 * A Vite resolveId plugin (see ./solid-1-compat-plugin.ts) redirects a bare
 * `from "solid-js"` import to this file ONLY when the importer lives under one
 * of the `VENDOR_PACKAGES` trees. An importer under `src/` does not get
 * redirected — it gets a thrown error, which is how that rule is enforced
 * rather than merely documented.
 *
 * `src/` holds up its end natively. Measured, per name, across every `.ts`/
 * `.tsx` under `src/`: the only specifiers it imports are `solid-js`,
 * `@solidjs/web` and `@solidjs/testing-library` — no `solid-js/web`, no
 * `solid-js/store`, no `solid-js/jsx-runtime` — and of the 27 distinct names it
 * takes from `solid-js`, every one is a real Solid 2 export. Zero `onMount`,
 * `mergeProps`, `splitProps`, `on`, `createResource`, `createComputed`,
 * `observable`, `batch`, `produce` or `Index`. `src/lib/solid-2-idioms.test.ts`
 * is the standing guard for both halves of that.
 *
 * Every export below therefore exists for a named vendor consumer, and the ones
 * that turned out to have none have been deleted (see the block comments where
 * `Suspense`/`SuspenseList`/`ErrorBoundary`, `produce`/`isProducer`,
 * `createResource`/`Resource`/`ResourceState`, `createRenderEffect` and
 * `mergeSources` used to be).
 *
 * ⚠️ THE VENDOR SIDE IS ALSO MEASURED, not inherited from whichever build error
 * first demanded a name. Every `import … from "solid-js" | "solid-js/web" |
 * "solid-js/store"` under the whole `VENDOR_PACKAGES` tree was enumerated by
 * name — 37 distinct names from bare `solid-js`, 18 from `solid-js/web`, 2 from
 * `solid-js/store` — and each export below is matched to at least one of them.
 * Re-run that enumeration before adding an export, and before trusting a
 * docblock here that cites a call-site count: a count taken mid-migration keeps
 * reading as current long after it stops being true, which is how
 * `createResource` survived as dead code with a live-looking justification.
 *
 * This file's OWN imports of the real package go through the
 * `virtual:solid-1-compat-real/*` specifiers below instead of the bare
 * names — see solid-1-compat-plugin.ts's header for why a plain bare import
 * here (even one explicitly excluded by importer path) silently resolved to
 * an EMPTY module under Vitest specifically: a conflict between this
 * plugin's own `enforce: "pre"` (required for the redirect itself) and
 * @solidjs/vite-plugin's own `enforce: "pre"` resolveId hooks for the same
 * specifier. The virtual specifier is resolved with a plain
 * `require.resolve`, bypassing the plugin-resolution chain entirely instead
 * of relying on a `return null` fallthrough.
 */
import {
  For,
  createComponent,
  createMemo,
  createRoot,
  children as realChildren,
  getOwner,
  runWithOwner,
  untrack,
  merge as realMerge,
  onSettled,
  createEffect as realCreateEffect,
  createStore as realCreateStore,
  createContext as realCreateContext,
  useContext as realUseContext,
  createSignal as realCreateSignal,
  createUniqueId as realCreateUniqueId,
  // Needed only by the shims at the end of this file (`createComputed`,
  // `observable`). `flush` was imported here for the first version of the `batch`
  // shim and is gone with it: migration.txt says to remove `batch` rather than
  // map it to `flush`, and mapping it threw "Cannot call flush() from inside
  // onSettled or createTrackedEffect". `Loading`/`Errored`/`Reveal` went the same
  // way as of 2026-10-03: they existed only to be aliased as `Suspense`/
  // `ErrorBoundary`/`SuspenseList`, which nothing imported.
  createRenderEffect as realCreateRenderEffect,
  createTrackedEffect,
  reconcile as realReconcile,
} from "virtual:solid-1-compat-real/solid-js";
export * from "virtual:solid-1-compat-real/solid-js";

/*
 * ── NO `mergeSources` RE-EXPORT, AND NO `solid-js/internal` IMPORT ───────────
 *
 * There was one, justified as RC-to-RC skew: "@solidjs/web@rc.8 still imports
 * `mergeSources` from bare solid-js, but solid-js core rc.13 only exposes it via
 * the `solid-js/internal` subpath now." Deleted 2026-10-03 because the skew it
 * bridged is not present in what is actually installed.
 *
 * Re-measured rather than re-assumed: the installed `@solidjs/web` is
 * **rc.13**, not rc.8, and the string `mergeSources` does not appear anywhere in
 * its `dist/`. Across the WHOLE of node_modules it appears in exactly nine
 * files, all of which DEFINE or re-export it — `@solidjs/signals`' store
 * internals and `solid-js`'s own `internal.js`/`internal.d.ts`. Nothing imports
 * it. So this was a shim for a version of a dependency the lockfile had already
 * moved past, kept alive by a comment that was correct when written.
 *
 * Its removal also drops this file's only dependency on `solid-js/internal`,
 * a subpath whose types the docs say carry "no semver guarantee".
 */

// Real Solid 2's `createUniqueId` (confirmed by reading
// `node_modules/solid-js/dist/server.dev.js` directly) now throws
// `createUniqueId cannot be used outside of a reactive context` when
// `getOwner()` returns null — it needs a real owner to derive a
// hydration-stable child id via `getNextChildId`. `@ark-ui/solid` (no Solid 2
// release) calls it from several machine/hook setup paths that run outside
// any component owner (confirmed live: `useTooltip` → `TooltipRoot`, caught
// via a `-m development` diagnostic build that kept the real, non-sanitized
// server error — production silently replaces every such throw with the
// generic "Internal Server Error" and blanks the whole page, since the root
// layout's single `<Loading>` has no error boundary of its own to isolate
// one broken island). Falls back to a monotonic counter (prefixed so it can
// never collide with a real owner-derived id) when there is no owner,
// restoring Solid 1's "just works anywhere" behavior for vendor code; uses
// the real, hydration-safe id whenever an owner is actually present.
// A truthy `getOwner()` is NOT sufficient on its own: real `createUniqueId`
// walks up through `_transparent`/`_parent` owners looking for one with a
// non-null `id` (`nextChildIdFor` in the same file), and throws "Cannot get
// child id from owner without an id" when that walk never finds one —
// confirmed live, a SECOND real failure mode distinct from the no-owner-at-
// all case above, hit by the exact same `@ark-ui/solid` call site once the
// no-owner case was fixed. Those internals (`_transparent`/`_parent`) are
// private and not safe to replicate here, so this catches the real call's
// throw directly rather than trying to pre-validate the owner shape.
let fallbackUniqueIdCounter = 0;
export function createUniqueId(): string {
  try {
    return realCreateUniqueId();
  } catch {
    return `solid-1-compat-uid-${fallbackUniqueIdCounter++}`;
  }
}

// --- 1:1 renames -----------------------------------------------------------
// `onMount` is NOT a plain alias for `onSettled`, despite the cheatsheet's
// rename table saying so: Solid 1 code universally nests
// `onMount(() => { ...; onCleanup(() => {...}); })`, and 2.0 forbids calling
// `onCleanup` from inside `onSettled`'s own callback
// ("[CLEANUP_IN_FORBIDDEN_SCOPE] Cannot use onCleanup inside
// createTrackedEffect or onSettled; return a cleanup function instead" —
// found live, in several component tests that pass under production SSR
// but assert cleanup behavior under a real mount/unmount, e.g.
// site-footer.test.tsx).
//
// The first fix attempt — wrap `fn` in its own `createRoot` called FROM
// INSIDE the `onSettled` callback, so a nested `onCleanup` has a legal owner
// to register against — traded one forbidden-scope error for another:
// `[PRIMITIVE_IN_FORBIDDEN_SCOPE] Cannot create reactive primitives inside
// createTrackedEffect or owner-backed onSettled` (`createRoot` itself
// creates a primitive). The repair guide's own instruction is "hoist the
// primitive to the component body" — so the root is created HERE, eagerly,
// at the point `onMount(fn)` itself is called (which IS the component body,
// same as Solid 1's `onMount` call site), and only `fn`'s INVOCATION is
// deferred into `onSettled`, via `runWithOwner` against that pre-made root
// (switching owner context, not creating a new primitive — legal inside the
// restricted scope).
export function onMount(fn: () => void | (() => void)) {
  let dispose: () => void;
  const owner = (createRoot as any)((d: () => void) => {
    dispose = d;
    return (getOwner as any)();
  });
  // ⚠️ THE `onSettled` CALL ITSELF MUST RUN UNDER `owner`, NOT JUST `fn`.
  //
  // `onSettled` decides its OWN safe-vs-unowned path synchronously, by
  // reading `getOwner()` at the moment it is CALLED — not from anything
  // inside its callback. The eager `createRoot` above sets `owner` as the
  // ambient owner only WHILE its own callback runs; once `createRoot`
  // returns, Solid restores whatever owner was ambient at `onMount`'s OWN
  // call site. So a plain `onSettled(...)` call made right after, like the
  // line this replaces, is evaluated against the CALLER's owner — not the
  // fresh one just captured.
  //
  // That caller is not always safe to assume owned. `@ark-ui/solid`'s
  // `useTooltip` → `@zag-js/solid`'s `useMachine` → this `onMount` chain
  // calls it from inside Solid's own `createRoot$1.transparent()`/`untrack()`
  // one-shot setup — a "transparent" root Solid marks CHILDREN_FORBIDDEN,
  // which `onSettled` treats as unowned regardless of whether an owner
  // object technically exists. Measured live: Tooltip (and anything else
  // reaching `useMachine`) threw `[SETTLED_CLEANUP_UNOWNED]` in dev — real
  // Solid's error, fired because THIS shim's own cleanup return landed in
  // that unowned branch, not a vendor bug.
  //
  // Wrapping the `onSettled` call in `runWithOwner(owner, ...)` makes OUR
  // freshly-created, ordinarily-configured root the ambient owner for
  // `onSettled`'s own synchronous check, so it takes the safe `trackedEffect`
  // path regardless of what restricted scope called `onMount`. `fn`'s
  // `runWithOwner(owner, fn)` below is then redundant (a `trackedEffect`
  // child already inherits `owner` as ambient when it fires) but kept for
  // defence in depth — it is a no-op context override, not a behavior change.
  return (runWithOwner as any)(owner, () =>
    onSettled(() => {
      const returned = (runWithOwner as any)(owner, fn);
      return () => {
        dispose();
        if (typeof returned === "function") returned();
      };
    }),
  );
}
// Solid 2's `createContext()` returns a callable context — the context IS
// now the provider component (`<MyContext value={x}>`, no `.Provider`
// sub-component: confirmed by reading the real implementation directly,
// `Object.keys(createContext())` is just `['id', 'defaultValue']`). Every
// vendor package here (ark-ui/solid's own `createContext()` wrapper, used
// pervasively for Dialog/Field/Combobox/Select context) still does
// `<Context.Provider value={x}>` and `const { Provider } = createContext()`,
// so `.Provider` resolving to `undefined` broke almost every ark-ui
// component ("createComponent: expected a component function but got
// undefined") and every `useContext` that depended on a Provider that
// silently failed to render ("Context must either be created with a default
// value..."). Fixed by aliasing `.Provider` back onto the context itself —
// calling the context directly with `{value, children}` props IS the new
// provider behavior, so self-reference is a correct, not approximate, shim.
//
// ── AND ITS CHILDREN ARE CONSTRUCTED UNTRACKED, FOR THE SAME REASON `Show`
//    AND `Switch` BELOW ARE ──────────────────────────────────────────────────
//
// Read the `Show`/`Switch` header first: this is the identical bug in a second
// host. Solid 2's JSX compiler HOISTS a `ref={expr}` expression out of the ref
// callback and into the enclosing `children` getter, and real Solid 2's
// provider reads that getter from inside a tracking memo —
// `node_modules/solid-js/dist/solid.dev.js`'s `createContext`:
//
//     function provider(props) {
//       return createRoot(() => {
//         setContext(provider, props.value);
//         return children(() => props.children);   // <- children() is a memo
//       });
//     }
//
// so every reactive value the children getter happens to touch becomes a
// dependency of the PROVIDER, and one change rebuilds the whole provided
// subtree from scratch instead of letting the element's own fine-grained
// effects update it in place.
//
// ⚠️ MEASURED, ON `@ark-ui/solid`'s `<Field>`. `FieldRoot` is
//   <FieldProvider value={field}>
//     <ark.div {...mergedProps} ref={composeRefs(field().refs.rootRef, props.ref)} />
//   </FieldProvider>
// and `field` is `useField`'s `createMemo` returning a FRESH OBJECT LITERAL on
// every recompute — so it is never `Object.is`-equal to its previous value, and
// it recomputes on every `invalid` / `required` / `disabled` change. With the
// real provider, flipping `invalid` from `false` to `true` on a
// `<Field.Root><Field.Input/></Field.Root>` was confirmed to DESTROY and
// re-create the `<input>`: the node captured before the flip had
// `isConnected === false` and `aria-invalid === null`, while a fresh query
// found a DIFFERENT element carrying `aria-invalid="true"` (exactly one in the
// document, so this is a replacement, not a duplicate). `getInputProps()`
// itself was correct the whole time — the attributes never reached the element
// anyone was holding.
//
// What that costs a person filling in a form: the control they are typing into
// is replaced the instant its validity changes, so blur validation and
// "the error clears as you type" both act on a dead node — focus, caret and
// any in-progress IME composition go with it.
//
// ⚠️ THE WRAPPER IS A PROXY WITH AN `apply` TRAP, NOT A NEW FUNCTION. In Solid
// 2 the context IS the provider, and `getContext` keys off `context.id`
// (confirmed by reading `@solidjs/signals`' `getContext`: `owner._context[
// context.id]`), while the real provider's own body calls
// `setContext(provider, ...)` against the function it closed over. Returning a
// fresh wrapper function would therefore be written under one key and read
// under another; a Proxy forwards `id`/`defaultValue` and stays `typeof
// "function"`, so identity is preserved and only the call is intercepted.
export function createContext<T>(defaultValue?: T, options?: unknown) {
  const real = (realCreateContext as any)(defaultValue, options);
  const ctx: any = new Proxy(real, {
    apply(target, _thisArg, args) {
      const props = args[0] ?? {};
      return (target as any)({
        // Forwarded as a getter, not a snapshot: a provider's `value` is
        // genuinely reactive and `setContext` must see the live one.
        get value() {
          return props.value;
        },
        // The one change vs. real Solid 2: untracked.
        get children() {
          return (untrack as any)(() => props.children);
        },
      });
    },
  });
  ctx.Provider = ctx;
  return ctx;
}
// Solid 1's `useContext` on a context with no default value and no Provider
// in scope just returned `undefined` — `@ark-ui/solid` deliberately relies on
// this for its own "optional" contexts (`strict: false`, no `defaultValue`,
// e.g. `FieldsetContext`, so a `<Field>` works standalone outside any
// `<Fieldset>`). Real Solid 2 throws `ContextNotFoundError` in exactly that
// situation instead (confirmed live: every licensing/moderator-application
// form test failed with the identical
// "Context must either be created with a default value..." throw, traced to
// `@ark-ui/solid`'s `useField` → `FieldRoot`, which calls an unprovided
// optional context). Neither class is exported from `solid-js` (confirmed:
// grep its whole dist for `NoOwnerError`/`ContextNotFoundError` — zero
// matches in any export list), so there is no `instanceof` to write against
// an import. This used to match on `.constructor.name` instead. Only swallows
// THESE specific errors — any other throw from inside `fn` still propagates,
// same as Solid 1.
//
// ── ⛔ `.constructor.name` IS NOT A STABLE IDENTIFIER IN A BUNDLE, AND IT
//    BROKE THE WHOLE SITE ON EVERY CLIENT-SIDE NAVIGATION WHILE SIGNED IN ───
//
// `constructor.name` is the MINIFIED class binding. Our production build's
// minifier renames `class NoOwnerError` to `class i` and
// `class ContextNotFoundError` to `class a` — confirmed by reading real
// Solid's own `getContext` in the shipped client bundle
// (`function Yn(e,t=I()){if(!t)throw new i;...throw new a}`), and again from
// the live page: the probe below reported the learned names as `"i"` and
// `"a"`. So in a minified build BOTH names missed the set and `throw error`
// below re-threw a `ContextNotFoundError` this function exists to swallow.
//
// What that cost, measured end to end on the built app with a real signed-in
// session: an `@ark-ui/solid` component on the signed-in render path (the
// account Menu in `components/layout/auth-menu.tsx`, and `RankingOptOut`'s
// Switch on `/profile` — the stack ran ark-ui's `create-anatomy` → this
// function → real `getContext`) threw out of a client-side navigation.
// `@tanstack/solid-router`'s GLOBAL `CatchBoundary` (`Matches.jsx`) caught it,
// which armed its `resetBoundary`; the next `matches`-store change then fired
// its `getResetKey` effect, which calls `setRetryKey({})` into a KEYED
// `<Show>` and so re-rendered `matchContent()` from scratch — including the
// root match's `shellComponent`, i.e. `routes/__root.tsx`'s `RootDocument`.
// A document shell compiles to `getNextElement()` with NO template, which is
// only legal while hydrating, so it threw `Hydration Mismatch. Unable to find
// DOM nodes for hydration key: undefined` straight back into the same
// boundary — a reset loop (measured: 3 iterations per click).
//
// Observable result: `document.styleSheets.length` 3 → 0, every
// `useHead`-owned tag (metas, canonical, all three stylesheets) removed from
// `<head>` by its disposal cleanup, and the body DOM left frozen on the
// previous route while `router.stores.matches` read correctly. The entire
// site unstyled and inert after a single in-site click. It reproduced ONLY
// minified (an unminified build of the same tree navigated cleanly) and ONLY
// signed in (the signed-out header renders a plain button, not the Menu),
// which is why nothing before this had caught it.
//
// ⚠️ SO THE CLASSES ARE LEARNED AT RUNTIME, FROM REAL SOLID ITSELF, and
// compared by constructor IDENTITY. `probeContextErrors` below provokes each
// of the two throws once at module init against a throwaway context and keeps
// the constructor it got. No identifier is involved, so no minifier can
// rename it. The name checks are KEPT below as a fallback for a future Solid
// that stops throwing from a probe (the sets then stay empty and behaviour is
// exactly what it was), and because an unminified/dev build answers them
// correctly anyway.
//
// ⛔ DO NOT "SIMPLIFY" THIS BACK TO A NAME, OR TO A MESSAGE TEST. The name is
// minified. The MESSAGE is the EMPTY STRING in a production build —
// `class NoOwnerError { constructor(){ super("") } }` in
// `@solidjs/signals/dist/prod/core/error.js`, confirmed by reading it — so
// matching on message text works in dev and silently matches nothing in
// production, which is the same bug one layer down.
// `NoOwnerError` ("Context can only be accessed under a reactive root",
// confirmed by reading `node_modules/solid-js/dist/server.dev.js`'s real
// `getContext` directly, and by a `-m development` diagnostic build that
// caught the real, non-sanitized error) is a SEPARATE real Solid 2 failure
// mode from `ContextNotFoundError` below — it fires when there is no owner
// at all, not merely a missing provider on an existing one. `@ark-ui/solid`
// (no Solid 2 release) calls `useContext` from the same kind of
// outside-any-owner machine/hook setup path as the `createUniqueId` case
// above (confirmed live: the homepage's tooltip machinery hits both in the
// same render). Solid 1 never distinguished "no owner" from "owner with no
// provider" — both silently returned the default/undefined — so vendor code
// written against that assumption needs both caught here.
const NO_CONTEXT_ERROR_NAMES = new Set(["ContextNotFoundError", "NoOwnerError"]);

/**
 * The two constructors real Solid's `getContext` throws, learned by provoking
 * both throws once rather than by naming them — see the long note above for
 * what naming them cost.
 *
 * ⚠️ BOTH PROBES USE ONE THROWAWAY CONTEXT WITH NO DEFAULT VALUE, which is
 * the only shape that reaches the second throw at all: real `getContext` falls
 * back to `ctx.defaultValue` first and throws `ContextNotFoundError` only when
 * that is `undefined` too.
 *
 * ⚠️ THE TWO PROBES DIFFER ONLY IN WHETHER THERE IS AN OWNER, because that is
 * the only thing that distinguishes the two errors. Module init has no owner,
 * so the bare call takes the `NoOwnerError` path; the `createRoot` call gives
 * it an owner with no provider, which takes the `ContextNotFoundError` path.
 * The root is disposed immediately — it exists for one synchronous read and
 * holds nothing.
 *
 * ⚠️ READING A CONTEXT CREATES NO REACTIVE PRIMITIVE (real `getContext` is a
 * plain property read off the owner, and `createContext` only allocates a
 * Symbol and an object), so this is safe at module scope and cannot trip
 * Solid 2's `PRIMITIVE_IN_FORBIDDEN_SCOPE` the way `onMount` above can.
 *
 * ⚠️ EVERY FAILURE HERE IS SILENT AND LEAVES THE SETS EMPTY, deliberately. A
 * probe that does not throw means this build's Solid does not have the failure
 * mode being compensated for, and `useContext` below then behaves exactly as
 * the name-only version did. A probe must never be able to break module
 * evaluation of the shim that every vendor package imports.
 */
const NO_OWNER_ERROR_CTORS = new Set<unknown>();
const CONTEXT_NOT_FOUND_ERROR_CTORS = new Set<unknown>();
(function probeContextErrors() {
  const ctorOf = (error: unknown) =>
    (error as { constructor?: unknown } | null | undefined)?.constructor;
  let probe: unknown;
  try {
    probe = (realCreateContext as any)();
  } catch {
    return;
  }
  try {
    (realUseContext as any)(probe);
  } catch (error) {
    const ctor = ctorOf(error);
    if (ctor) NO_OWNER_ERROR_CTORS.add(ctor);
  }
  try {
    (createRoot as any)((dispose: () => void) => {
      try {
        (realUseContext as any)(probe);
      } catch (error) {
        const ctor = ctorOf(error);
        // A `NoOwnerError` here would mean `createRoot` did not actually
        // establish an owner. Recording it as "context not found" too would
        // make the two indistinguishable and would return `undefined` where
        // the no-owner branch must return the context's `defaultValue`, so the
        // overlap is dropped rather than merged.
        if (ctor && !NO_OWNER_ERROR_CTORS.has(ctor)) CONTEXT_NOT_FOUND_ERROR_CTORS.add(ctor);
      }
      dispose();
    });
  } catch {
    /* no-op — see the note above on silent probe failure */
  }
})();

export function useContext<T>(ctx: unknown): T | undefined {
  try {
    return (realUseContext as any)(ctx);
  } catch (error) {
    const ctor = (error as { constructor?: unknown } | null | undefined)?.constructor;
    if (ctor !== undefined && NO_OWNER_ERROR_CTORS.has(ctor)) {
      // Same reasoning as the `name === "NoOwnerError"` branch below.
      return (ctx as { defaultValue?: T })?.defaultValue;
    }
    if (ctor !== undefined && CONTEXT_NOT_FOUND_ERROR_CTORS.has(ctor)) {
      return undefined;
    }
    const name = (error as { constructor?: { name?: string } })?.constructor?.name ?? "";
    if (name === "NoOwnerError") {
      // No owner means the real `getContext` can't even consult the
      // context's own `defaultValue` — but the context object itself
      // (confirmed: `Object.keys(createContext())` is `['id', 'defaultValue']`,
      // see `createContext` above) still carries it as a plain property, no
      // owner required to read it. Returning that default (rather than
      // `undefined`) is what Solid 1 always did for this exact "no owner,
      // no provider" case — ark-ui's `useLocaleContext` depends on getting
      // its real `defaultValue` function back (`() => ({dir, locale})`), not
      // `undefined`, or every `locale().dir` call site throws `locale is
      // not a function` (confirmed live).
      return (ctx as { defaultValue?: T })?.defaultValue;
    }
    if (NO_CONTEXT_ERROR_NAMES.has(name)) {
      return undefined;
    }
    throw error;
  }
}
export const mergeProps = realMerge;

/*
 * ── `Suspense`, `SuspenseList` AND `ErrorBoundary` ARE GONE FROM THIS FILE ───
 *
 * They were `Loading`, `Reveal` and `Errored` aliases (the renames
 * `migration.txt:317-320` prescribes). Deleted 2026-10-03 because NOTHING
 * imports them. Measured, not assumed: a scan of all 11,611 files under the
 * `VENDOR_PACKAGES` trees found zero imports and zero mentions of any of the
 * three outside of prose. The only hits at all were two comments in
 * `@tanstack/solid-router` — `renderRouterToStream.jsx` saying "if a
 * Suspense/resource never resolves", and `router.d.ts` saying "errors caught by
 * the Router ErrorBoundary" — neither of which is code. `src/` imports none of
 * them either (it uses `Loading` natively, 9 times, and has no error boundary
 * at all by the deliberate decision recorded in `src/routes/__root.tsx`).
 *
 * A shim export consumed by nobody is worse than dead weight: it is evidence
 * for a compatibility requirement that does not exist, and it makes the shim
 * look larger — i.e. the migration look less complete — than it is. If a vendor
 * package ever does need one, it is a one-line alias to re-add.
 */

// --- splitProps: old 2-tuple [picked, rest] shape --------------------------
// Both halves are thin Proxies over the real, instrumented `props` object —
// forwarding every read straight through is what keeps it reactive — rather
// than `omit()`'s own return value for the "rest" half. `omit()` returns an
// `OmitView` class instance meant to be consumed through Solid's OWN spread
// machinery (`spread()`/`assign()`), not a plain object. Solid 1 code using
// `splitProps` universally spreads "rest" with plain JSX `{...rest}`, which
// only copies a class instance's own enumerable fields — for `OmitView` that
// is its internal view-target property, not the props it represents. That
// surfaced as a genuinely strange bug: `lucide-solid`'s `Icon` component
// (and anything else spreading a split "rest") inserted that raw internal
// object into the DOM as if it were a child node, crashing happy-dom's
// `insertBefore` with "Cannot read properties of undefined (reading
// 'length')" deep inside Solid's reactive system — confirmed by logging the
// actual object happy-dom received: `{ t: <internal> }`, matching
// `OmitView`'s shape, not a real DOM node. A hand-rolled Proxy with
// `ownKeys`/`getOwnPropertyDescriptor` traps (required for `{...rest}` to
// enumerate anything at all — a Proxy without them spreads empty) reproduces
// Solid 1's actual splitProps contract: a complement view that is also a
// plain, safely-spreadable object.
export function splitProps(props: any, ...keyGroups: Array<readonly string[]>) {
  /*
   * ── ⛔ VARIADIC, BECAUSE SOLID 1's `splitProps` IS — AND THE ONE-ARRAY VERSION
   *      SILENTLY DELETED EVERY CHILD OF EVERY `<Motion>` ELEMENT ──────────────────
   *
   * This took `(props, keys)` — ONE key array — and returned `[picked, rest]`. Solid 1's
   * real signature is `splitProps(props, ...keyGroups)`, returning one bag per group plus
   * a final rest bag.
   *
   * ⛔ MEASURED. `solid-motionone/dist/index.jsx` opens with
   *
   *     const [options, , attrs] = splitProps(props, OPTION_KEYS, ATTR_KEYS);
   *
   * and then renders `<Dynamic {...attrs} ... />`. With only two elements returned,
   * `attrs` destructured to `undefined`, so `{...attrs}` spread NOTHING — no `children`,
   * no `class`, no `ref`. Every `<Motion.div>` on the site rendered as a bare
   * `<div style="opacity:0;filter:blur(6px)">` with an empty body.
   *
   * ⛔ AND IT WAS A 200 WITH A PERFECT `<head>`. `/blog` served the full document — title,
   * canonical, OG tags, the complete JSON-LD `@graph` describing three posts — above a
   * `<main>` containing three empty divs. Nothing errored, nothing logged. The only reason
   * it was caught at all is that the port was being verified by READING the rendered
   * output rather than by the build exiting 0.
   *
   * ⚠️ THE PRE-EXISTING ONE-ARRAY CALLERS ARE UNAFFECTED: with a single group this returns
   * `[picked, rest]` exactly as before, which is the shape every other vendor call site
   * (Ark UI's, chiefly) destructures.
   *
   * ⚠️ EACH GROUP EXCLUDES ONLY ITS OWN KEYS; `rest` excludes the UNION of all of them.
   * That is Solid 1's semantics — a key named in group 2 must not also appear in group 1's
   * bag, and must not appear in `rest`.
   */
  const groups = keyGroups.length > 0 ? keyGroups : [[] as readonly string[]];
  const allKeys = new Set<string>(groups.flat());

  const makePicked = (keys: readonly string[]) => {
    const keySet = new Set(keys);
    return makePickedProxy(props, keySet);
  };

  return [...groups.map(makePicked), makeRestProxy(props, allKeys)];
}

/** The `picked` half of `splitProps`, extracted so each key group gets its own bag. */
function makePickedProxy(props: any, keySet: Set<string>) {
  // Both Proxies wrap an empty, plain dummy object — NOT `props` itself —
  // and derive every trap result from `props` via closure instead of
  // `Reflect.*(target, ...)`. Wrapping `props` directly (the previous
  // approach) crashed with `TypeError: 'ownKeys' on proxy: trap result did
  // not include '<key>'` the moment any picked/excluded key happened to be
  // NON-CONFIGURABLE on the real props object (confirmed live: `@ark-ui/solid`
  // components define some merged/defaulted props, e.g. `asChild`, as
  // non-configurable). A Proxy's `ownKeys`/`getOwnPropertyDescriptor` traps
  // are legally forbidden from hiding a non-configurable own property of
  // their TARGET — filtering one out is a hard invariant violation, not a
  // policy choice. Using an empty dummy target sidesteps this entirely:
  // there is nothing non-configurable to collide with, so any subset of keys
  // can be freely included or excluded. Every returned descriptor is
  // `configurable: true`, which is what makes the `get` trap's live,
  // always-current read-through (rather than the snapshot `value` the
  // descriptor itself carries) spec-legal.
  return new Proxy(
    {},
    {
      get(_target, prop) {
        return keySet.has(prop as string) ? props[prop] : undefined;
      },
      has(_target, prop) {
        return keySet.has(prop as string) && prop in props;
      },
      ownKeys(_target) {
        return Reflect.ownKeys(props).filter((key) => keySet.has(key as string));
      },
      getOwnPropertyDescriptor(_target, prop) {
        if (!keySet.has(prop as string) || !(prop in props)) return undefined;
        // `get`, NOT a snapshot `value` — a real bug this shipped with and
        // broke `@ark-ui/solid`'s `<Field>` family specifically: zag-js's own
        // `mergeProps` calls `Object.getOwnPropertyDescriptors(source)` to
        // collect a source's shape, which reads every descriptor EAGERLY.
        // A literal `value: props[prop]` forces `props.children` to resolve
        // immediately, at DESCRIPTOR-ENUMERATION time — rendering
        // `<Field.Label>`/`<Field.RequiredIndicator>` before `<FieldProvider>`
        // ever wraps them, so `useFieldContext()` inside them always saw
        // "no provider yet" and returned `undefined` (confirmed live via a
        // minimal repro and provider-invocation tracing: the Provider never
        // even ran before children had already rendered). A `get` accessor is
        // captured, not called, by `getOwnPropertyDescriptors` — evaluation
        // stays deferred to whenever something actually reads the property.
        return { enumerable: true, configurable: true, get: () => props[prop] };
      },
    },
  );
}

/**
 * The `rest` half of `splitProps`.
 *
 * ⚠️ `keySet` here is the UNION of every key group, not one group's keys — a prop claimed
 * by any group must not also appear in the rest bag.
 */
function makeRestProxy(props: any, keySet: Set<string>) {
  // `keySet` only ever holds STRING keys (the caller's `keys` array), so
  // `!keySet.has(symbolProp)` is unconditionally `true` for every symbol —
  // every trap below was unconditionally forwarding `$PROXY`/`$RECORD`
  // lookups straight through to `props`. That is exactly the bug that broke
  // `Dynamic`'s `htmlFor`→`for` alias in `solid-1-compat-web.ts` (see its
  // matching comment): when `props` is itself a real Solid reactive view
  // (`$PROXY`-tagged), `@solidjs/web`'s own `spread()`/`collectProps()` sees
  // straight past a Proxy that answers `$PROXY in rest` truthfully, reading
  // the view's RECORD directly and never calling this Proxy's `get`/`ownKeys`
  // at all. Excluding every symbol explicitly — not just filtering by
  // `keySet`, which was never going to match a symbol either way — makes
  // `rest` present as a genuinely plain object with no such tag.
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop === "symbol") return undefined;
        return keySet.has(prop as string) ? undefined : props[prop];
      },
      has(_target, prop) {
        if (typeof prop === "symbol") return false;
        return !keySet.has(prop as string) && prop in props;
      },
      ownKeys(_target) {
        return Reflect.ownKeys(props).filter(
          (key) => typeof key !== "symbol" && !keySet.has(key as string),
        );
      },
      getOwnPropertyDescriptor(_target, prop) {
        if (typeof prop === "symbol") return undefined;
        if (keySet.has(prop as string) || !(prop in props)) return undefined;
        // See the matching comment on `picked`'s trap above — same fix,
        // same reason: a lazy `get`, not an eagerly-evaluated `value`.
        return { enumerable: true, configurable: true, get: () => props[prop] };
      },
    },
  );
}

// --- Show / Switch: construct children UNTRACKED --------------------------
// These are NOT renames. They are byte-for-byte reimplementations of real
// Solid 2's own `Show`/`Switch` (read directly out of
// `node_modules/solid-js/dist/solid.dev.js`, lines 1462-1535) with exactly
// ONE change: the read of `props.children` / `mp.children` is wrapped in
// `untrack`. Everything else — the `conditionValue`/`condition` memo pair,
// the `!a === !b` truthiness equality for the non-keyed case, the `sync: true`
// flags, the narrowing accessor handed to function children, the stale-read
// guard — is reproduced exactly so ordering and narrowing semantics are
// unchanged.
//
// WHY. In a component's compiled JSX, `children` is a GETTER whose body
// CONSTRUCTS the child (`get children() { return createComponent(Foo, ...) }`).
// Real Solid 2 reads that getter from inside its own tracking `createMemo`,
// so every reactive value the getter happens to touch becomes a dependency of
// `Show` itself — and when one changes, `Show` re-runs the getter and builds a
// BRAND NEW DOM element, discarding the live one. Solid 2 already treats this
// as wrong for the function-child form (`untrack(() => child(c))`, its own
// code); the plain-element form was simply left tracked. That asymmetry is the
// bug this restores symmetry to.
//
// WHAT IT BROKE, measured. Solid 2's JSX compiler HOISTS a `ref={expr}`
// expression out of the ref callback and into the enclosing `children` getter
// (Solid 1's compiler kept it inside the callback body, where it was never
// tracked — which is why Solid-1-era vendor code never hit this). `@ark-ui/
// solid`'s entire Dialog/Popover/Tooltip/Menu/Select/Accordion presence family
// is written as
//   <Show when={!presenceApi().unmounted}>
//     <ark.div {...mergedProps} ref={composeRefs(presenceApi().ref, props.ref)} />
//   </Show>
// and `presenceApi` is a `createMemo` returning a FRESH OBJECT LITERAL on every
// recompute (`@ark-ui/solid`'s `usePresence`), so it is never `Object.is`-equal
// to its previous value. Result, confirmed live with a MutationObserver on a
// single dialog close: the backdrop and content elements were destroyed and
// re-created THREE times, once per presence-prop change.
//
// Each rebuild left `@zag-js/presence`'s state machine holding `refs.node` =
// a detached earlier generation (confirmed: `isConnected === false`, and not
// identical to the element actually in the document). Its `trackExitAnimation`
// effect therefore attached `animationend`/`animationcancel` listeners to a
// dead node, those listeners never fired, `UNMOUNT` was never sent, the machine
// sat in `unmountSuspended` forever, `api().present` stayed true, and so
// `usePresence`'s `hidden: !api().present` never became true. The visible
// symptom was a `fixed inset-0` backdrop stuck at `opacity: 1` with
// `pointer-events: auto` swallowing every click on the page — the whole site
// bricked after opening and closing any overlay once.
//
// Vendor-scoped, like everything else here: `./solid-1-compat-plugin.ts`
// only redirects `solid-js` for importers inside `VENDOR_PACKAGES`, so our own
// `src/` keeps real Solid 2's `Show`/`Switch` untouched.
export function Show(props: any) {
  const keyed = props.keyed;
  const conditionValue = (createMemo as any)(() => props.when);
  const condition = keyed
    ? conditionValue
    : (createMemo as any)(conditionValue, { equals: (a: any, b: any) => !a === !b, sync: true });
  return (createMemo as any)(
    () => {
      const c = condition();
      if (c) {
        // The one change vs. real Solid 2: untracked.
        const child = (untrack as any)(() => props.children);
        const fn = typeof child === "function" && child.length > 0;
        return fn
          ? keyed
            ? (untrack as any)(() => child(c))
            : (untrack as any)(() =>
                child(() => {
                  if (!(untrack as any)(condition)) throw new Error(STALE_NARROW_ERROR("Show"));
                  return conditionValue();
                }),
              )
          : child;
      }
      return (untrack as any)(() => props.fallback);
    },
    { sync: true },
  );
}

export function Switch(props: any) {
  const chs = (realChildren as any)(() => props.children);
  const switchFunc = (createMemo as any)(
    () => {
      const mps = chs.toArray();
      let func: () => any = () => undefined;
      for (let i = 0; i < mps.length; i++) {
        const index = i;
        const mp = mps[i];
        if (mp == null) continue;
        const prevFunc = func;
        const conditionValue = (createMemo as any)(() => (prevFunc() ? undefined : mp.when));
        const condition = mp.keyed
          ? conditionValue
          : (createMemo as any)(conditionValue, {
              equals: (a: any, b: any) => !a === !b,
              sync: true,
            });
        func = () => {
          const prev = prevFunc();
          if (prev) return prev;
          const c = condition();
          return c ? [index, c, conditionValue, mp] : undefined;
        };
      }
      return func;
    },
    { sync: true },
  );
  return (createMemo as any)(
    () => {
      const sel = switchFunc()();
      if (!sel) return (untrack as any)(() => props.fallback);
      const [index, value, conditionValue, mp] = sel;
      // The one change vs. real Solid 2: untracked.
      const child = (untrack as any)(() => mp.children);
      const fn = typeof child === "function" && child.length > 0;
      return fn
        ? mp.keyed
          ? (untrack as any)(() => child(value))
          : (untrack as any)(() =>
              child(() => {
                if ((untrack as any)(switchFunc)()?.[0] !== index)
                  throw new Error(STALE_NARROW_ERROR("Match"));
                return conditionValue();
              }),
            )
        : child;
    },
    { sync: true },
  );
}

const STALE_NARROW_ERROR = (name: string) =>
  `Attempting to access a stale value from <${name}> that could possibly be undefined. This may occur because you are reading the accessor returned from the component at a time where it has already been unmounted. We recommend cleaning up any stale timers or async, or reading from the initial condition.`;

// --- Index: Solid 1 position-keyed list, now `<For keyed={false}>` --------
export function Index(props: any) {
  return createComponent(For as any, { ...props, keyed: false });
}

// --- on(): explicit-dependency wrapper for createMemo/createEffect --------
// 2.0 folds this into createEffect's two-phase (compute, apply) signature,
// but createMemo is still single-arg, so `on` can stay a plain function that
// reads its declared deps synchronously (which is what makes them track).
export function on(
  deps: any,
  fn: (input: any, prevInput: any, prev?: any) => any,
  options?: { defer?: boolean },
) {
  const isArray = Array.isArray(deps);
  let prevInput: any;
  let defer = options?.defer;
  return (prev: any) => {
    const input = isArray ? deps.map((d: any) => d()) : deps();
    if (defer) {
      defer = false;
      prevInput = input;
      return prev;
    }
    const result = fn(input, prevInput, prev);
    prevInput = input;
    return result;
  };
}

// --- createStore: restore the legacy multi-arg path setter -----------------
// 2.0's real setter is `set(draft => { ... })` only (draft-first, single arg).
// Solid 1 code calls `setState(key1, key2, ..., valueOrFn)` — including the
// very common `setState("key", reconcile(newValue))` shape (still a valid
// value since `reconcile` itself is unchanged in 2.0, just the setter that
// used to accept it inline). Detect the legacy multi-arg call and translate
// it into an equivalent draft mutation; a true single-function call (the 2.0
// native form) passes straight through.
//
// ⚠️ EVERY CALL HERE GOES THROUGH `withStoreWritePermit`. A Solid 1 vendor
// writes its store from inside a tracked callback as a matter of course, and
// this file's own tracked-effect wrapper takes away the runtime's permit for
// that — see the long note beside `storeWriteScopes` for the measurement and
// for why the permit is put back here rather than the clear being narrowed.
// The permit is inert outside such a body, so a write from a component or from
// an event handler still meets the real guard unchanged.
export function createStore<T extends object>(init: T, options?: any) {
  const [get, realSet] = (realCreateStore as any)(init, options);
  function set(...args: any[]) {
    if (args.length === 1 && typeof args[0] === "function") {
      return withStoreWritePermit(() => realSet(args[0]));
    }
    const value = args[args.length - 1];
    const path = args.slice(0, -1);
    return withStoreWritePermit(() =>
      realSet((draft: any) => {
        let target = draft;
        for (let i = 0; i < path.length - 1; i++) target = target[path[i]];
        const lastKey = path[path.length - 1];
        target[lastKey] = typeof value === "function" ? value(target[lastKey]) : value;
      }),
    );
  }
  return [get, set];
}

/*
 * ── ONE TRACKED CALLBACK, WITH NESTED PRIMITIVES ALLOWED ─────────────────────
 *
 * Solid 1's single-argument `createEffect` and its `createComputed` are both
 * "one callback that tracks what it reads AND performs the side effect", and in
 * Solid 2 the primitive for that is `createTrackedEffect` — see the two call
 * sites below for the measurements that rejected every other mapping
 * (`(compute, noop)` puts the body in the compute phase, where Solid 2 forbids
 * the writes Solid 1 code routinely makes, and `ownedWrite: true` cannot rescue
 * a STORE write because `StoreOptions` has no such field).
 *
 * ── ⛔ BUT A BARE `createTrackedEffect(compute)` THROWS THE MOMENT A VENDOR
 *      NESTS A PRIMITIVE, AND SOLID 1 CODE DOES THAT ROUTINELY ───────────────
 *
 * Its scope is marked CHILDREN_FORBIDDEN. The guard, read in
 * `node_modules/@solidjs/signals/dist/dev-shared.js`:
 *
 *     if (parent && parent._config & CONFIG_CHILDREN_FORBIDDEN) {
 *       throw new Error(PRIMITIVE_IN_FORBIDDEN_SCOPE_MESSAGE);
 *
 * ⛔ MEASURED — THIS PUT EVERY PAGE OF A CONSUMING SITE ON THE ERROR
 * BOUNDARY, and it was invisible to curl: each page SSR'd perfectly (a correct,
 * full-length 200 with no error markers in the HTML) and then threw during
 * HYDRATION. Captured over CDP by patching `Error` and reloading:
 *
 *     [PRIMITIVE_IN_FORBIDDEN_SCOPE] Cannot create reactive primitives inside
 *     createTrackedEffect or owner-backed onSettled
 *       at createEffect (solid-1-compat.ts)
 *       at node_modules/solid-motionone/dist/index.jsx:54
 *
 * Line 54 is solid-motionone's NESTED `createEffect(() => state.update(options()))`,
 * created inside its own outer mount effect — i.e. `<BlurFade>`, which is on
 * every page of that site.
 *
 * THE FIX: CLEAR THE FORBIDDEN BIT FOR THE DURATION OF THE BODY, AND CHANGE
 * NOTHING ELSE. The guard reads a flag on the OWNER; tracking is a separate
 * variable (`tracking`) that the owner's config has no bearing on. So the body
 * runs in the tracked effect's OWN scope — same owner, same listener — with only
 * the one bit that forbids children turned off while it runs, and restored
 * immediately after. That is Solid 1's semantics exactly: the body tracks what it
 * reads, and the primitives it creates are owned by the effect, so Solid disposes
 * them when the effect re-runs or is destroyed.
 *
 * ⚠️ IT IS INERT WHERE NOTHING NESTS. Measured on a consumer whose vendors do
 * not nest a primitive: zero `[PRIMITIVE_IN_FORBIDDEN_SCOPE]` across its 5,419
 * tests with or without this, so
 * for a project whose vendors never nest a primitive the save/restore is a
 * no-op. That is why the fix is unconditional here rather than configured: it
 * costs nothing where it is not needed and the absence of it is a hydration-time
 * crash where it is.
 *
 * ⛔ `runWithOwner(ownerCreatedOutside, …)` IS THE OBVIOUS ALTERNATIVE AND IT IS
 * A TRAP. It is how `onMount` above legalises the same guard, so it looks like
 * the house pattern — but `onMount` defers a ONE-SHOT callback that tracks
 * nothing, and this does not. Read it in `dev-shared.js:6936`:
 *
 *     const prevTracking = tracking;
 *     context = owner;
 *     tracking = false;        // ← every read inside is now UNTRACKED
 *
 * MEASURED, and far worse than the crash it replaces because nothing throws:
 * with the body wrapped in `runWithOwner` + a per-run `createRoot`, every page
 * rendered and hydrated cleanly and solid-motionone's nested
 * `createEffect(() => state.update(options()))` read `options()` untracked — so
 * it ran once and never again. Every `<BlurFade>` below the fold stayed frozen at
 * its `initial` style forever: scrolling an element into view left `opacity: 0`,
 * `filter: blur(6px)` and `getAnimations().length === 0`. A blank-looking page
 * with a perfect console. DO NOT REINTRODUCE `runWithOwner` HERE.
 */
/*
 * ── ⚠️ THE SAME BIT IS ALSO SOLID 2's WRITE PERMIT, AND CLEARING IT REVOKED
 *      ONE ─────────────────────────────────────────────────────────────────
 *
 * `CONFIG_CHILDREN_FORBIDDEN` is not only "no primitives here". It is how the
 * runtime recognises a tracked-effect scope AT ALL, and eight separate places
 * read it. Enumerated in `@solidjs/signals/dist/dev-shared.js`, rc.13:
 *
 *   3427, 5636  PRIMITIVE_IN_FORBIDDEN_SCOPE          — the one we want off
 *   6651        devGuardStoreSetterWrite              — EXEMPTS a store write
 *   6741        setSignal                             — EXEMPTS a signal write
 *   6968        markRefresh                           — EXEMPTS a refresh()
 *   6442        PENDING_ASYNC_FORBIDDEN_SCOPE
 *   6186, 6328, 6377  readerSeesCommitted / readNodeFast / read
 *                                                     — committed-vs-staged reads
 *
 * Read the store guard, which is the whole of it. Note the NEGATION:
 *
 *     function devGuardStoreSetterWrite() {
 *       if (context && !(context._config & CONFIG_CHILDREN_FORBIDDEN)) {
 *         … throw new Error(ownedScopeWriteMessage(context));
 *
 * So the bit being SET is precisely what makes a store write legal inside a
 * tracked effect. Clearing it for the duration of the body — which is what the
 * save/restore above does — hands the vendor a scope that may nest primitives
 * and may no longer write a store. The docblock above this function claimed
 * "only the one bit that forbids children turned off"; that was read off the
 * primitive guard alone and is wrong about the other seven call sites.
 *
 * ⛔ MEASURED on `@tanstack/solid-virtual`, which is the vendor in this set
 * that writes a store from a `createComputed` body (see `createComputed`):
 *
 *     [REACTIVE_WRITE_IN_OWNED_SCOPE] … (in trackedEffect)
 *       at devGuardStoreSetterWrite
 *       at set                     (the `createStore` shim below)
 *       at @tanstack/solid-virtual/dist/esm/index.js:42
 *     → [REACTIVITY_HALTED]
 *
 * and `REACTIVITY_HALTED` is the expensive half: after the first throw NOTHING
 * in the page updates again, so a later click handler runs and renders nothing.
 * tELS's editor gallery counted 14 of these across two scenarios, plus 4
 * overlays that never opened because the graph was already down.
 *
 * THE FIX: PUT THE BIT BACK FOR THE DURATION OF A STORE WRITE. The two needs
 * are disjoint in time — a primitive is created at one moment, a setter runs at
 * another — so each gets the bit in the state it needs and neither is traded
 * away. `storeWriteScopes` is how the setter below knows which owner node is
 * one of ours; re-arming any other node would legalise a write Solid 2 means
 * to reject.
 *
 * ⚠️ WHY ONLY THE STORE SETTER, AND NOT ALL SEVEN. Signals are already covered
 * by `CONFIG_OWNED_WRITE`, which `setSignal` tests FIRST and which the shimmed
 * `createSignal` below forces on every vendor signal; `markRefresh` and the
 * pending-async guard have no vendor call site in this set. The three READ
 * sites are a genuine remaining divergence — a read inside the body may see a
 * staged value where stock Solid 2 would hand back the committed one — and are
 * recorded in the README as unproven rather than patched, because no consumer
 * has produced a case and a speculative wrapper around every read is not free.
 *
 * ⛔ NOT: "stop clearing the bit, and clear it only inside the shim's own
 * primitive constructors instead". That looks strictly better and it has a
 * hole — `createMemo` is NOT shimmed in this file, it arrives through the
 * `export *` passthrough, so a vendor nesting a memo would start throwing
 * PRIMITIVE_IN_FORBIDDEN_SCOPE where it does not today. The nested-primitive
 * rescue is load-bearing for a consumer this tree cannot run (solid-motionone's
 * `<BlurFade>`), so it is not something to narrow on an argument.
 */
const CONFIG_CHILDREN_FORBIDDEN = 1 << 4; // dev-shared.js:104

/** Owner nodes this file cleared the bit on, and may therefore put it back. */
const storeWriteScopes = new WeakSet<object>();

/**
 * Runs `fn` with `CONFIG_CHILDREN_FORBIDDEN` restored, if and only if the
 * current owner is a tracked-effect node whose bit this file cleared. Anything
 * else is left exactly as Solid 2 built it.
 */
function withStoreWritePermit<T>(fn: () => T): T {
  const owner = (getOwner as any)() as { _config?: number } | null;
  if (!owner || !storeWriteScopes.has(owner)) return fn();
  owner._config! |= CONFIG_CHILDREN_FORBIDDEN;
  try {
    return fn();
  } finally {
    owner._config! &= ~CONFIG_CHILDREN_FORBIDDEN;
  }
}

function trackedEffectAllowingNestedPrimitives(compute: any, options?: any) {
  return (createTrackedEffect as any)(() => {
    // The tracked effect's own node, which is the owner the guard will consult.
    const owner = (getOwner as any)() as { _config?: number } | null;
    const forbidden =
      !!owner && typeof owner._config === "number" && !!(owner._config & CONFIG_CHILDREN_FORBIDDEN);
    if (forbidden) {
      owner!._config! &= ~CONFIG_CHILDREN_FORBIDDEN;
      storeWriteScopes.add(owner!);
    }
    try {
      // Returned verbatim: `createTrackedEffect` takes the return value as the
      // cleanup it runs before the next run and on disposal, which is where a
      // Solid 1 body's own returned teardown belongs.
      return compute();
    } finally {
      if (forbidden) {
        owner!._config! |= CONFIG_CHILDREN_FORBIDDEN;
        storeWriteScopes.delete(owner!);
      }
    }
  }, options);
}

// --- createEffect: restore the legacy single-arg form ----------------------
// Solid 1 code (often via `on(...)`) passes ONE function that both tracks and
// performs the side effect. Solid 2 requires (compute, apply).
//
// `ownedWrite` here used to be passed as a `createEffect` OPTION, on the
// theory that it would let the legacy single-arg body write state from what
// is now the "compute" phase. That was wrong: `ownedWrite` is a property of
// the SIGNAL being written (`createSignal(v, { ownedWrite: true })`), read
// off the signal's own config bits at `setSignal` time — `createEffect`
// doesn't forward it anywhere, and the option was a silent no-op (confirmed
// by grepping the real `@solidjs/signals` source: `ownedWrite` only appears
// next to `signal(...)`/`optimisticSignal(...)` calls, never near
// `createEffect`). The actual fix for vendor code hitting
// `[REACTIVE_WRITE_IN_OWNED_SCOPE]` is on the shimmed `createSignal` below,
// which now defaults every vendor-created signal to `ownedWrite: true` —
// restoring Solid 1's permissive "write a signal from wherever" behavior for
// code that was never written against this new guard.
export function createEffect(compute: any, effectFn?: any, options?: any) {
  if (effectFn === undefined) {
    // ⚠️ `createTrackedEffect`, FOR THE SAME REASON `createComputed` BELOW USES
    // IT. The obvious mapping — `(compute, () => {})`, the body as the compute
    // phase with an empty apply — is what this was, and it only worked because
    // the shimmed `createSignal` below forces `ownedWrite: true`: a Solid 1
    // single-argument effect routinely WRITES, and a compute phase is a
    // computation, where Solid 2 forbids writes. That prop fails for STORE
    // writes, which have no `ownedWrite` to set, and that is precisely how
    // @tanstack/solid-virtual broke (see `createComputed`). Solid 1's single-arg
    // `createEffect` IS "one tracked callback", which is what
    // `createTrackedEffect` is for.
    //
    // ⚠️ MEASURED BEFORE KEEPING IT: changed NOTHING observable — the full suite
    // reports the identical 5,405 passing / 14 failing either way, and zero
    // `[PRIMITIVE_IN_FORBIDDEN_SCOPE]` errors across all 5,419 tests, which is
    // the constraint `createTrackedEffect` adds (it cannot create nested
    // primitives). So this is adopted for correctness of the MAPPING rather than
    // to fix a symptom: it stops the shim depending on an escape hatch that does
    // not cover half the writes vendor code makes.
    return trackedEffectAllowingNestedPrimitives(compute, options);
  }
  return (realCreateEffect as any)(compute, effectFn, options);
}

// Solid 2 added `[REACTIVE_WRITE_IN_OWNED_SCOPE]`: writing a signal from
// inside a component/computation now throws unless the SIGNAL ITSELF was
// created with `{ ownedWrite: true }`. Vendor code (ark-ui's `composeRefs`,
// e.g. `setRefs(...)` called from inside its own ref-merging effect) was
// written against Solid 1, where this guard didn't exist, so none of its
// signals opt in. Defaulting every vendor-created signal to `ownedWrite:
// true` restores that permissiveness; an explicit `{ ownedWrite: false }`
// from vendor code (unlikely, but possible) still wins via the spread order.
export function createSignal(first: any, second?: any) {
  return (realCreateSignal as any)(first, { ownedWrite: true, ...second });
}

// ───────────────────────────────────────────────────────────────────────────
// THE `@tanstack/solid-*` ADAPTER FAMILY. Everything below this line exists for
// that vendor group specifically; it is not reached by a consumer that does not
// install it.
//
// ⚠️ EVERY EXPORT BELOW IS JUSTIFIED BY A VENDOR CALL SITE, AND THAT RULE HAS
// TEETH. These were originally justified by APPLICATION call sites instead,
// back when the redirect was unconditional and application code was still
// unmigrated. Two of them (`produce`, then `createResource`) turned out to have
// no consumer on either side once each name was counted, and are deleted. What
// remains survives on the vendor count alone: `batch` and `observable` for
// `@tanstack/solid-table`, `createComputed` for `-form`/`-table`/`-virtual`.
// "a project of ours uses it" is not a reason for anything in this file to
// exist — count it in `node_modules` or delete it.
// ───────────────────────────────────────────────────────────────────────────

// `batch` is GONE from 2.0 because its job is now the default: writes are
// collected onto the microtask queue and collapse into one update pass whether
// you ask for it or not. So a plain `fn()` would already be "batched".
//
// ── ⚠️ IT IS THE IDENTITY FUNCTION, AND `flush(fn)` WAS A MISTAKE ───────────
//
// This shim first mapped `batch(fn)` onto `flush(fn)`, reasoning that Solid 1's
// `batch` ran its dependent updates synchronously once the callback returned, and
// that `flush(fn)` is the Solid 2 primitive which does that.
//
// migration.txt says the opposite in as many words: "Remove `batch`. Consecutive
// writes already share the default microtask batch. Replacing each `batch` call
// with `flush` would change deferred work into synchronous work." Reading the
// documentation instead of reasoning from the primitives would have settled it
// first time.
//
// It also BROKE, not merely degraded. `@tanstack/solid-table` calls `batch` from
// inside its reactivity bridge, which this file routes through
// `createTrackedEffect` — and `flush` is not reentrant there:
//
//   Cannot call flush() from inside onSettled or createTrackedEffect. flush() is
//   not reentrant there. Writes made here are processed in the same flush's
//   continuation; to force a drain afterwards, defer it:
//   queueMicrotask(() => flush()).
//
// followed by `[REACTIVITY_HALTED]`, which stops every later update in the page
// rather than just the one. Measured on the solid-table render tests.
export function batch<T>(fn: () => T): T {
  return fn();
}

/*
 * ── `reconcile`: THE OPTIONS-OBJECT SECOND ARGUMENT, BACK AGAIN ─────────────
 *
 * Solid 1 took `reconcile(items, { key?: string | null, merge?: boolean })`.
 * Solid 2 kept `reconcile` with the same semantics and merely moved it out of
 * `solid-js/store` into core — but it also changed the second parameter to the
 * key ITSELF: `reconcile(value, key?: string | ((item) => any) | null)`, read
 * from `@solidjs/signals/dist/types/store/index.d.ts`. Hand it the Solid 1
 * object and the object BECOMES the key, and the diff walk then calls it:
 *
 *     let i = n === null ? null : typeof n === "string" ? e => e?.[n] : n;
 *     … const t = i(e);                   (prod/store/next/reconcile.js:44,66)
 *
 * — `TypeError: keyFn is not a function`, thrown inside a store setter inside a
 * tracked callback, so it takes the reactive system down with it rather than
 * failing locally.
 *
 * ── ⚠️ THIS WRAPPER WAS DELETED ONCE AND ITS REASON WENT STALE ──────────────
 *
 * The deletion note said, correctly when written: every `reconcile` call site
 * in every consumer's vendor tree was `@ark-ui/solid`'s one-argument
 * `setSnapshot(reconcile(stack.getSnapshot()))`, and the one package that
 * passes the object form, `@tanstack/solid-virtual`, "is installed in NO
 * consumer". A consumer installs it now. Re-measured 2026-10-04 at the union
 * of the installed trees:
 *
 *     @tanstack/solid-virtual/dist/esm/index.js:33   reconcile(…, { key: "index" })
 *     @tanstack/solid-virtual/dist/esm/index.js:42   reconcile(…, { key: "index" })
 *
 * ⚠️ IT WAS INVISIBLE UNDERNEATH AN EARLIER FAULT, which is the part worth
 * keeping. `devGuardStoreSetterWrite` rejected those same two writes at the
 * setter's front door — see the long note beside `storeWriteScopes` — so the
 * diff walk was never reached and the only error anyone saw was
 * `REACTIVE_WRITE_IN_OWNED_SCOPE`. Repairing that one turned all 14 of tELS's
 * editor-gallery page errors into 14 of `keyFn is not a function`: same count,
 * same two scenarios, same four overlays still unopened. A guard that throws
 * early conceals whatever stands behind it, so a shorter error list after one
 * repair is worth less than it looks.
 *
 * Solid 1's `merge` has no Solid 2 equivalent and is DROPPED rather than
 * approximated. That was the original wrapper's finding and it is carried
 * forward deliberately; no vendor in this set passes it.
 *
 * A one-argument call is unchanged in behaviour: `realReconcile(value,
 * undefined)` takes Solid 2's own `"id"` default, which was Solid 1's default
 * as well.
 *
 * ⚠️ `solid-1-compat-store.ts` MUST NOW TAKE IT FROM HERE, not from the real
 * package. `@tanstack/solid-virtual` imports `reconcile` from the
 * `solid-js/store` subpath, so that file is the only path its calls travel;
 * re-exporting the real one there leaves this wrapper unreached and the error
 * exactly as it was. The TS2305 hazard its own comment records is gone with
 * the wildcard-only resolution: this is a genuine named export now.
 */
export function reconcile(value: any, key?: any) {
  // Solid 1's options object. `null` IS a legal Solid 2 key (positional
  // matching, `n === null` above) and must not be mistaken for one, which is
  // why this tests for it explicitly rather than trusting `typeof`.
  if (key !== null && typeof key === "object") return (realReconcile as any)(value, key.key);
  return (realReconcile as any)(value, key);
}

/*
 * ── NO `produce`/`isProducer` SHIM ANY MORE ──────────────────────────────────
 *
 * `produce` is gone from 2.0 because the mutation form IS the native setter now:
 * a Solid 2 store setter takes `(draft) => { ... }` and applies the mutations,
 * which is exactly what `produce`'s callback was for (`migration.txt:195`,
 * "Delete `produce(...)` wrappers and pass the producer body directly to the
 * setter"). The shim was therefore an identity function plus a marker symbol so
 * the shimmed `createStore`'s path form could reject a producer rather than
 * assign its `undefined` return and silently delete a subtree.
 *
 * Both are deleted as of 2026-10-03, because BOTH consumers turned out to be
 * imaginary:
 *
 *  · VENDORS. No package under `VENDOR_PACKAGES` imports `produce` from
 *    `solid-js/store` — the only two names any of them import from that subpath
 *    are `createStore` and `reconcile` (`@ark-ui/solid`, `better-auth`,
 *    `@tanstack/solid-virtual`). `isProducer` is not mentioned in any vendor
 *    file at all.
 *  · OURS. The docblock this replaces claimed "there is exactly one `produce(`
 *    call site in src/ … theme-editor/editor.tsx:329". That was true when it was
 *    written and is not now: all five `setSlots` calls in that file pass a bare
 *    draft mutator, and the file carries its own note citing `migration.txt` for
 *    why. The claim had simply outlived the migration it was describing — which
 *    is the argument for deleting an unused shim export rather than keeping it
 *    "just in case": a stale justification reads exactly like a live one.
 */

/**
 * ── ⚠️ NO `createResource`, AND NO `Resource`/`ResourceState` TYPES ─────────
 *
 * There was a ~170-line reimplementation here. It is gone because NOTHING asks
 * for it. Measured, not assumed — the same two-sided count this file applies to
 * `produce` above, re-run for this name:
 *
 *  · VENDORS. Zero. Every `import … from "solid-js"`, `"solid-js/web"` and
 *    `"solid-js/store"` across the whole `VENDOR_PACKAGES` tree was enumerated
 *    by name; `createResource` appears in none of them, and no namespace
 *    importer (`@ark-ui/solid`, `@tanstack/solid-router`) reads it off the
 *    namespace object either. The 37 names vendors DO want from bare
 *    `solid-js` are all still exported above.
 *  · OURS. `src/` cannot reach this file at all — the resolve-time gate in
 *    solid-1-compat-plugin.ts hands `src/` the real Solid 2 package — and has
 *    no `createResource` call site left regardless: `src/lib/`
 *    solid-2-idioms.test.ts lists the name in SOLID_1_ONLY_NAMES and asserts
 *    no `src/` file imports it.
 *
 * ⚠️ IT WAS DEAD CODE WITH A LIVE-LOOKING JUSTIFICATION, which is the exact
 * trap the `produce` note above describes. Its docblock argued its own
 * behavioural costs against call-site counts — 18 files naming `Suspense`,
 * 41 using `createResource` — and every one of those counts
 * was from BEFORE the migration that removed them. A reader had no way to tell
 * that from the
 * text, and the three documented defects it disclosed (no Suspense
 * integration, no SSR participation, eager-then-deferred loads) were being
 * disclosed about code nothing executed.
 *
 * Solid 2 deleted the resource concept rather than renaming it: the
 * replacement is an `async` function read inside a memo, which suspends and
 * integrates with `Loading`/`Errored` boundaries. That is what `src/` uses.
 * If a vendor package ever does import `createResource`, restore this from
 * history (`git log -S createResource` in any consumer that predates the
 * shared copy) rather
 * than rewriting it — but note it can only ever be the non-suspending
 * approximation, for the reason above.
 */

// ── TWO MORE, FOR A VENDOR GROUP ONLY SOME CONSUMERS INSTALL ─────────────
//
// `@tanstack/solid-form` and `@tanstack/solid-table` are on only one of the
// five `vendorPackages` lists today. Both still
// import Solid 1 primitives 2.0 removed, and neither has a Solid 2 release —
// measured peer ranges: solid-form@2.0.0-alpha.2 is `solid-js: >=1.9.5`,
// solid-table@9.2.4 is `>=1.3`.
//
// ⚠️ THEY SURFACED ONE LAYER AT A TIME, which is how this whole vendor surface
// behaves: rolldown reports the first batch of missing exports and stops, so
// each round of fixes reveals the next. Never read a shorter error list as
// progress — enumerate the vendor tree instead (see this file's header).

// `createComputed` was Solid 1's EAGER effect: it ran its body synchronously at
// creation and again synchronously whenever a dependency changed, before the
// render pass — which is why libraries used it to derive state they then WROTE to
// a signal. That last part is the whole difficulty.
//
// ── ⚠️ `createTrackedEffect`, AND THE FIRST TWO ATTEMPTS WERE BOTH WRONG ──────
//
// ATTEMPT 1 — `createRenderEffect(fn, () => {})`, i.e. the body as the COMPUTE
// phase with an empty apply, matching how the `createEffect` shim above restores
// the single-argument call shape. It type-checks, it runs, and it is wrong in a
// way that HALTS THE REACTIVE SYSTEM. Solid 2 forbids writing reactive state from
// inside a computation, and the compute phase is a computation:
//
//   [REACTIVE_WRITE_IN_OWNED_SCOPE] Writing to reactive state inside an owned
//   scope (component, computation) is not allowed.
//   [REACTIVITY_HALTED] An uncaught error halted the reactive system.
//
// MEASURED on `@tanstack/solid-virtual`, which is built entirely on this shape:
// its `createComputed(...)` body calls `setVirtualItems(reconcile(...))` and
// `setTotalSize(...)` to publish the window. Every one of the three virtualizer
// render tests in src/lib/vendor-solid-2.test.tsx failed on it, and the failure
// was not local — `REACTIVITY_HALTED` means nothing else updates either.
//
// ATTEMPT 2 — keep the compute phase but make the writes legal with
// `ownedWrite: true`, which is how the shimmed `createSignal` below already
// rescues vendor signals. It cannot work here: half the writes are STORE writes,
// and `StoreOptions` is `{ name?, shallow? }` — read directly from
// `@solidjs/signals/dist/types/store/store.d.ts` — with no `ownedWrite` to set.
// A store write from a computation has no opt-out.
//
// So: `createTrackedEffect`, which is a SINGLE tracked callback whose writes are
// legal — its reference page states that "writes made inside it are queued into
// the same flush's continuation". That is exactly Solid 1's `createComputed`.
//
// ⚠️ YES, IT IS DEPRECATED, AND THAT IS THE RIGHT TOOL HERE RATHER THAN A
// CONTRADICTION. Its own page says "Deprecated: Do not use in new code …
// retained solely to ease 1.x migration". This file IS the 1.x migration, for
// packages we do not control and cannot rewrite. The same primitive was
// deliberately REFUSED for our own `src/` — where `createEffect` was split by
// hand at 79 call sites instead — because there it would have been a shim
// wearing a native name. The distinction is who owns the code, not which
// primitive is nicer.
//
// ⚠️ WHAT IT COSTS, from its own documentation rather than guessed: it "may run
// multiple times for a single change or show tearing", it "never holds a
// transition", and it "cannot observe a write staged earlier in the same flush by
// a signal it has not read yet". For a virtualizer republishing a window those
// are acceptable; they are also a reason this shim should disappear the day
// `@tanstack/solid-virtual` ships a Solid 2 release.
export function createComputed(compute: any, effectFn?: any, options?: any) {
  if (effectFn === undefined) {
    return trackedEffectAllowingNestedPrimitives(compute, options);
  }
  // A two-argument call is already Solid 2-shaped and is passed through.
  return (realCreateRenderEffect as any)(compute, effectFn, options);
}
/*
 * ── NO `createRenderEffect` SHIM, BECAUSE NOTHING ASKS FOR ONE ───────────────
 *
 * There was one here (the same single-argument rescue `createComputed` above
 * does, for the same reason). Deleted 2026-10-03: `createRenderEffect` is not
 * imported — and is not so much as MENTIONED — anywhere in the 11,611 files
 * under the `VENDOR_PACKAGES` trees, and `src/` does not use it either.
 *
 * It is also the one name on this file's old roster that real Solid 2 still
 * exports under its own name, so an unneeded shim for it was shadowing a live
 * API rather than restoring a dead one. The real export is two-phase now
 * (`compute, effectFn`, no `EffectBundle` overload) and is documented as
 * renderer plumbing — "app code should use `createEffect`" — so if a vendor
 * ever does import it, letting the real one through is the better default and
 * the shim can come back deliberately.
 *
 * `realCreateRenderEffect` is still imported above: `createComputed`'s
 * two-argument passthrough uses it.
 */

// `observable(accessor)` turned a signal into a TC39/RxJS-interop observable.
// 2.0 dropped it; `@tanstack/solid-table`'s `dist/reactivity.js` still imports
// it. Reimplemented on `createEffect` rather than stubbed, because the one
// consumer actually subscribes: solid-table bridges TanStack Table's own
// store-notification model onto it, and a no-op would leave every table
// rendering its first page of rows and never updating — a silent failure, not
// an error.
//
// The contract being matched is small and was read off Solid 1's own
// implementation rather than guessed: `subscribe` takes either a function or an
// observer object, pushes the current value immediately and on every change,
// never completes, and returns `{ unsubscribe }`. `Symbol.observable` is
// attached under its well-known-symbol lookup for interop libraries that probe
// for it.
export function observable<T>(accessor: () => T): any {
  const result = {
    subscribe(observer: any) {
      if (typeof observer !== "function" && typeof observer?.next !== "function") {
        throw new TypeError("Expected the observer to be an object or a function.");
      }
      const next = typeof observer === "function" ? observer : observer.next.bind(observer);
      let disposed = false;
      const dispose = (createRoot as any)((d: () => void) => {
        // Two-phase: track in the compute, push in the apply. An unsubscribe
        // that lands between the two must not deliver, hence the flag.
        (realCreateEffect as any)(
          () => accessor(),
          (value: T) => {
            if (!disposed) next(value);
          },
        );
        return d;
      });
      return {
        unsubscribe() {
          disposed = true;
          dispose();
        },
      };
    },
    // `Symbol.observable` is a stage-1 proposal, so TypeScript's
    // `SymbolConstructor` does not declare it; the `||` fallback is exactly why
    // this reads it defensively at runtime. Cast rather than widened.
    [(Symbol as unknown as { observable?: symbol }).observable ?? "@@observable"]() {
      return this;
    },
  };
  return result;
}
