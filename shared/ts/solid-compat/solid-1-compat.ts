/// <reference path="./solid-1-compat-virtual.d.ts" />
/*
 * The `solid-js` shim — one of five modules in this Solid 1 -> 2 compat
 * layer. See README.md for what it solves, module roles and adoption steps.
 *
 * A call-site count taken mid-migration keeps reading as current long after it
 * stops being true: one such count left a ~170-line `createResource`
 * reimplementation in here as dead code. Re-measure across every consumer's
 * installed node_modules before trusting one.
 */
/**
 * Vendor compatibility only — not reachable from `src/`, which gets a thrown
 * error for the same specifier (./solid-1-compat-plugin.ts). Re-exports all of
 * real `solid-js` 2.0, plus shims for `onMount`, `mergeProps`, `splitProps`,
 * `Index`, `on()`, and a legacy single-arg `createEffect` (2.0's two-arg
 * `(compute, apply)` throws `[MISSING_EFFECT_FN]` without it).
 *
 * `src/` uses none of the above, guarded by `src/lib/solid-2-idioms.test.ts`.
 * Every export here is justified by a vendor call site across the whole
 * `VENDOR_PACKAGES` tree (37 names from bare `solid-js`, 18 from
 * `solid-js/web`, 2 from `solid-js/store`).
 *
 * This file's own real-package imports go through `virtual:solid-1-compat-real/*`
 * rather than bare specifiers — see README.md § "Why the shims import
 * virtual:solid-1-compat-real/*" for why a bare import here resolves to an
 * empty module under Vitest.
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
  // `createRenderEffect`, `observable`). `flush` was imported here for the
  // first version of the `batch` shim and is gone with it: migration.txt says
  // to remove `batch` rather than map it to `flush`, and mapping it threw
  // "Cannot call flush() from inside onSettled or createTrackedEffect".
  createRenderEffect as realCreateRenderEffect,
  createTrackedEffect,
  reconcile as realReconcile,
} from "virtual:solid-1-compat-real/solid-js";
export * from "virtual:solid-1-compat-real/solid-js";

// Real `createUniqueId` throws "createUniqueId cannot be used outside of a
// reactive context" when getOwner() is null (it needs an owner for
// getNextChildId). @ark-ui/solid calls it from owner-less machine/hook setup
// paths (e.g. useTooltip -> TooltipRoot); in production this blanks the whole
// page, since the root layout's <Loading> has no error boundary to isolate it.
//
// A truthy getOwner() is not enough either: the real walk up
// _transparent/_parent owners for one with a non-null id can still throw
// "Cannot get child id from owner without an id" — a second failure mode on
// the same call site. Those internals are private, so this catches the real
// throw rather than replicating the owner shape.
//
// Falls back to a monotonic counter (prefixed to avoid colliding with a real
// id) when there is no owner; uses the real id whenever one is present.
let fallbackUniqueIdCounter = 0;
export function createUniqueId(): string {
  try {
    return realCreateUniqueId();
  } catch {
    return `solid-1-compat-uid-${fallbackUniqueIdCounter++}`;
  }
}

// --- 1:1 renames -----------------------------------------------------------
// `onMount` is not a plain alias for `onSettled`: Solid 1 code universally
// nests `onMount(() => { ...; onCleanup(() => {...}); })`, and 2.0 throws
// `[CLEANUP_IN_FORBIDDEN_SCOPE]` for an `onCleanup` called from inside
// `onSettled`'s own callback.
//
// Wrapping `fn` in a `createRoot` called from inside `onSettled` (so the
// nested `onCleanup` has a legal owner) trades that for
// `[PRIMITIVE_IN_FORBIDDEN_SCOPE]`, since `createRoot` itself creates a
// primitive. Fix: create the root eagerly, at `onMount`'s own call site
// (= the component body), and defer only `fn`'s invocation into `onSettled`
// via `runWithOwner` against that pre-made root.
export function onMount(fn: () => void | (() => void)) {
  let dispose: () => void;
  const owner = (createRoot as any)((d: () => void) => {
    dispose = d;
    return (getOwner as any)();
  });
  // `onSettled` reads getOwner() synchronously, at call time, not from inside
  // its callback — so it must be called under `runWithOwner(owner, ...)` too,
  // not just `fn`. A plain `onSettled(...)` call here runs under whatever
  // owner was ambient at `onMount`'s own call site, which is not always safe:
  // `@ark-ui/solid`'s useTooltip -> @zag-js/solid's useMachine calls `onMount`
  // from inside Solid's own transparent-root one-shot setup, which
  // `onSettled` treats as unowned regardless of a technically-present owner
  // object — throwing real Solid's `[SETTLED_CLEANUP_UNOWNED]`.
  //
  // `runWithOwner(owner, fn)` below is then redundant (the trackedEffect
  // child already inherits `owner`) but kept for defence in depth.
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
// sub-component — `Object.keys(createContext())` is just `['id',
// 'defaultValue']`). `@ark-ui/solid` still does `<Context.Provider
// value={x}>`/`const { Provider } = createContext()` throughout Dialog/
// Field/Combobox/Select, so `.Provider` resolving to `undefined` broke
// almost every ark-ui component. Fixed by aliasing `.Provider` back onto the
// context itself — calling the context directly with `{value, children}` IS
// the new provider behavior.
//
// Children are read untracked, for the same reason `Show`/`Switch` below are
// (read that header first): Solid 2's compiler hoists a `ref={expr}` out of
// the ref callback into the enclosing `children` getter, and the real
// provider reads that getter inside a tracking memo, so any reactive value it
// touches becomes a dependency of the whole provider.
//
// Measured on `@ark-ui/solid`'s `<Field>`: `FieldProvider`'s `value` is a
// `createMemo` returning a fresh object literal every recompute, so flipping
// `invalid` destroyed and recreated the `<input>` (the pre-flip node ended up
// `isConnected === false`) instead of updating in place — the control a user
// is typing into gets replaced the instant its validity changes, losing
// focus, caret and any in-progress IME composition.
//
// The wrapper is a Proxy with an `apply` trap, not a new function: Solid 2's
// `getContext` keys off `context.id`, while the real provider's body calls
// `setContext(provider, ...)` against the function it closed over, so a fresh
// wrapper function would be written under one key and read under another. A
// Proxy forwards `id`/`defaultValue` and stays `typeof "function"`, so
// identity is preserved and only the call is intercepted.
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
// in scope returned `undefined` — `@ark-ui/solid` relies on this for its own
// "optional" contexts (`strict: false`, no `defaultValue`, e.g.
// `FieldsetContext`, so `<Field>` works standalone outside `<Fieldset>`).
// Real Solid 2 throws `ContextNotFoundError` instead. Neither error class is
// exported from `solid-js`, so there is no `instanceof` to write against an
// import — only these two errors are swallowed; any other throw from `fn`
// still propagates.
//
// `constructor.name` is not a stable identifier in a bundle, and matching on
// it broke the whole site on every client-side navigation while signed in.
// Our production build's
// minifier renames `class NoOwnerError` to `class i` and `class
// ContextNotFoundError` to `class a`, so in a minified build both names
// missed the set and `throw error` below re-threw an error this function
// exists to swallow. The message is no better: it is the empty string in a
// production build (`@solidjs/signals/dist/prod/core/error.js`), so matching
// on message text has the same failure mode.
//
// Measured end to end: an `@ark-ui/solid` component on the signed-in render
// path threw out of a client-side navigation; `@tanstack/solid-router`'s
// global `CatchBoundary` caught it and reset a keyed `<Show>`, re-rendering
// the root shell with `getNextElement()` (no template, legal only while
// hydrating) — which threw `Hydration Mismatch` right back into the same
// boundary, a 3-iteration reset loop. Result: every `useHead`-owned tag
// (metas, canonical, stylesheets) got disposed from `<head>`, leaving the
// site unstyled and inert after one click. Reproduced only minified and only
// signed in, which is why nothing before this had caught it.
//
// Fix: learn the two constructors at runtime by provoking both throws once
// (`probeContextErrors` below) and compare by identity — no identifier
// involved, so no minifier can rename it. The name checks are kept as a
// fallback for a future Solid that stops throwing from a probe.
//
// `NoOwnerError` ("Context can only be accessed under a reactive root") is a
// separate failure mode from `ContextNotFoundError`: it fires when there is
// no owner at all, not merely a missing provider on an existing one.
// `@ark-ui/solid` calls `useContext` from the same outside-any-owner setup
// paths as the `createUniqueId` case above. Solid 1 never distinguished "no
// owner" from "owner with no provider" — both returned the
// default/undefined — so vendor code written against that needs both caught.
const NO_CONTEXT_ERROR_NAMES = new Set(["ContextNotFoundError", "NoOwnerError"]);

/**
 * The two constructors real Solid's `getContext` throws, learned by provoking
 * both once against a throwaway context with no default value — the only
 * shape that reaches `ContextNotFoundError` at all, since `getContext` falls
 * back to `ctx.defaultValue` first.
 *
 * The two probes differ only in whether there is an owner: module init has
 * none (`NoOwnerError` path); the `createRoot` call gives one with no
 * provider (`ContextNotFoundError` path). The root is disposed immediately.
 *
 * Every failure here is silent and leaves the sets empty: a probe that does
 * not throw means this build's Solid lacks the failure mode, and `useContext`
 * below falls back to the name-only behaviour.
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
        // A NoOwnerError here would mean createRoot did not establish an
        // owner; recording it as "context not found" too would make the two
        // indistinguishable, so the overlap is dropped rather than merged.
        if (ctor && !NO_OWNER_ERROR_CTORS.has(ctor)) CONTEXT_NOT_FOUND_ERROR_CTORS.add(ctor);
      }
      dispose();
    });
  } catch {
    /* no-op — a probe that throws must not break this module's evaluation */
  }
})();

export function useContext<T>(ctx: unknown): T | undefined {
  try {
    return (realUseContext as any)(ctx);
  } catch (error) {
    const ctor = (error as { constructor?: unknown } | null | undefined)?.constructor;
    if (ctor !== undefined && NO_OWNER_ERROR_CTORS.has(ctor)) {
      return (ctx as { defaultValue?: T })?.defaultValue;
    }
    if (ctor !== undefined && CONTEXT_NOT_FOUND_ERROR_CTORS.has(ctor)) {
      return undefined;
    }
    const name = (error as { constructor?: { name?: string } })?.constructor?.name ?? "";
    if (name === "NoOwnerError") {
      // No owner means real getContext can't consult defaultValue, but the
      // context object itself still carries it as a plain property.
      // Returning that (Solid 1's behaviour) rather than undefined matters:
      // ark-ui's useLocaleContext needs its real defaultValue function back,
      // or every `locale().dir` call site throws "locale is not a function".
      return (ctx as { defaultValue?: T })?.defaultValue;
    }
    if (NO_CONTEXT_ERROR_NAMES.has(name)) {
      return undefined;
    }
    throw error;
  }
}
export const mergeProps = realMerge;

// --- splitProps: old 2-tuple [picked, rest] shape --------------------------
// Both halves are thin Proxies over the real `props` object, forwarding
// every read through to keep it reactive — rather than `omit()`'s own
// `OmitView` return value, which is meant to be consumed through Solid's own
// spread machinery, not plain JSX `{...rest}`. Spreading an `OmitView`
// instance copies only its internal view-target field, so `lucide-solid`'s
// `Icon` (and anything else spreading a split "rest") inserted that raw
// object into the DOM as a child node, crashing happy-dom's `insertBefore`.
export function splitProps(props: any, ...keyGroups: Array<readonly string[]>) {
  /*
   * Variadic, because Solid 1's `splitProps` is. A single-key-array version
   * returning only `[picked, rest]` silently deleted every child of every
   * `<Motion>` element: `solid-motionone/dist/index.jsx` calls
   * `splitProps(props, OPTION_KEYS, ATTR_KEYS)` destructuring three results,
   * so `attrs` came back `undefined` and `{...attrs}` spread nothing —
   * `<Motion.div>` rendered as an empty `<div style="opacity:0;...">`, with a
   * perfectly correct SSR `<head>` around it and nothing logged.
   *
   * A single-group call still returns `[picked, rest]`, which is what every
   * other vendor call site destructures. Each group excludes only its own
   * keys; `rest` excludes the union of all of them — Solid 1's semantics.
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
  // Wraps an empty dummy object, not `props` itself, deriving every trap
  // result from `props` via closure. Wrapping `props` directly crashed with
  // `TypeError: 'ownKeys' on proxy: trap result did not include '<key>'`
  // whenever a picked/excluded key was non-configurable on the real props
  // object (e.g. `@ark-ui/solid`'s `asChild`) — a Proxy's `ownKeys`/
  // `getOwnPropertyDescriptor` traps cannot legally hide a non-configurable
  // own property of their target. An empty dummy target has nothing to
  // collide with.
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
        // `get`, not a snapshot `value`: zag-js's own `mergeProps` calls
        // `Object.getOwnPropertyDescriptors(source)`, reading every
        // descriptor eagerly. A literal `value: props[prop]` forced
        // `props.children` to resolve at descriptor-enumeration time,
        // rendering `@ark-ui/solid`'s `<Field.Label>` before `<FieldProvider>`
        // wrapped it, so `useFieldContext()` always saw no provider yet. A
        // `get` accessor is captured, not called, so evaluation stays
        // deferred to the actual read.
        return { enumerable: true, configurable: true, get: () => props[prop] };
      },
    },
  );
}

/**
 * The `rest` half of `splitProps`.
 *
 * `keySet` here is the UNION of every key group, not one group's keys — a prop claimed
 * by any group must not also appear in the rest bag.
 */
function makeRestProxy(props: any, keySet: Set<string>) {
  // `keySet` only ever holds string keys, so every trap below was
  // unconditionally forwarding `$PROXY`/`$RECORD` symbol lookups straight
  // through to `props` — the same bug as Dynamic's `htmlFor`->`for` alias in
  // solid-1-compat-web.ts. When `props` is itself a `$PROXY`-tagged Solid
  // view, `@solidjs/web`'s `spread()` sees past a Proxy that answers
  // `$PROXY in rest` truthfully and reads the view's record directly,
  // skipping this Proxy's traps entirely. Excluding every symbol makes
  // `rest` present as a genuinely plain object.
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
// Byte-for-byte reimplementations of real Solid 2's own Show/Switch, with
// exactly one change: the read of `props.children`/`mp.children` is wrapped
// in `untrack`.
//
// Why: a component's compiled `children` getter CONSTRUCTS the child. Real
// Solid 2 reads that getter inside its own tracking memo, so any reactive
// value the getter touches becomes a dependency of `Show` itself, rebuilding
// a brand-new DOM element on change instead of updating the live one — an
// asymmetry with the function-child form, which Solid 2 already untracks.
//
// Measured: Solid 2's compiler hoists a `ref={expr}` out of the ref callback
// into the `children` getter (Solid 1's compiler kept it in the callback
// body, untracked, so Solid-1-era vendor code never hit this). `@ark-ui/
// solid`'s whole Dialog/Popover/Tooltip/Menu/Select/Accordion presence
// family is `<Show when={!presenceApi().unmounted}><ark.div ...
// ref={composeRefs(presenceApi().ref, props.ref)} /></Show>`, and
// `presenceApi` is a memo returning a fresh object literal every recompute —
// never `Object.is`-equal — so the backdrop/content elements were destroyed
// and recreated 3 times on a single dialog close. Each rebuild left
// `@zag-js/presence`'s state machine holding a detached node, so its exit
// listeners never fired, `UNMOUNT` was never sent, and a `fixed inset-0`
// backdrop stuck at `opacity: 1` with `pointer-events: auto`, swallowing
// every click after opening and closing any overlay once.
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
// 2.0's real setter is `set(draft => { ... })` only. Solid 1 code calls
// `setState(key1, key2, ..., valueOrFn)` — including `setState("key",
// reconcile(newValue))`. Detect the legacy multi-arg call and translate it
// into an equivalent draft mutation; a true single-function call passes
// straight through.
//
// Every call here goes through `withStoreWritePermit`: this file's tracked-
// effect wrapper removes the runtime's write permit for a store write made
// from inside a tracked callback (see `storeWriteScopes` below for why), and
// the permit is put back here for the duration of the write. It is inert
// outside such a body, so a write from a component or event handler still
// meets the real guard unchanged.
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
 * One tracked callback, with nested primitives allowed.
 *
 * Solid 1's single-arg `createEffect`/`createComputed` are both "one
 * callback that tracks AND performs the side effect"; Solid 2's primitive
 * for that is `createTrackedEffect`. `(compute, noop)` was rejected because
 * the compute phase forbids the writes Solid 1 code routinely makes, and
 * `ownedWrite: true` cannot rescue a store write (`StoreOptions` has no such
 * field).
 *
 * But a bare `createTrackedEffect(compute)` throws the moment a vendor
 * nests a primitive — its scope is marked CHILDREN_FORBIDDEN
 * (`@solidjs/signals/dist/dev-shared.js`). Measured: every page of a
 * consuming site SSR'd a correct 200 and then threw during hydration —
 * `[PRIMITIVE_IN_FORBIDDEN_SCOPE] Cannot create reactive primitives inside
 * createTrackedEffect or owner-backed onSettled`, from solid-motionone's
 * nested `createEffect(() => state.update(options()))` inside `<BlurFade>`,
 * on every page.
 *
 * Fix: clear the forbidden bit for the duration of the body only, and
 * restore it after. The guard reads a flag on the owner; tracking is a
 * separate variable the config has no bearing on, so the body still runs in
 * the tracked effect's own scope. Inert where nothing nests (measured: zero
 * `[PRIMITIVE_IN_FORBIDDEN_SCOPE]` across 5,419 tests on a consumer whose
 * vendors don't nest), which is why the fix is unconditional rather than
 * configured.
 *
 * `runWithOwner(ownerCreatedOutside, ...)` looks like the house pattern
 * (`onMount` above uses it) and is a trap here: `onMount` defers a one-shot
 * callback that tracks nothing, this does not — `runWithOwner` sets
 * `tracking = false`, so every read inside becomes untracked. Measured: with
 * that wrapping, solid-motionone's nested effect read `options()` untracked,
 * ran once, and every `<BlurFade>` below the fold stayed frozen at its
 * `initial` style forever, with a perfectly clean console. Do not
 * reintroduce `runWithOwner` here.
 */
/*
 * The same bit is also Solid 2's store-write permit, so clearing it
 * unconditionally revokes one. `CONFIG_CHILDREN_FORBIDDEN` gates eight call
 * sites in `@solidjs/signals/dist/dev-shared.js`, not only
 * PRIMITIVE_IN_FORBIDDEN_SCOPE: `devGuardStoreSetterWrite` and `setSignal`
 * exempt a write only while the bit is *set*; clearing it for the duration
 * of a tracked-effect body therefore also revokes a store write.
 *
 * Measured on `@tanstack/solid-virtual`, which writes a store from a
 * `createComputed` body: `[REACTIVE_WRITE_IN_OWNED_SCOPE] ... ->
 * [REACTIVITY_HALTED]` — after the first throw nothing on the page updates
 * again. tLS's editor gallery counted 14 of these across two scenarios.
 *
 * Fix: put the bit back for the duration of a store write specifically. The
 * two needs are disjoint in time — a primitive is created at one moment, a
 * setter runs at another. `storeWriteScopes` marks which owner node this
 * file cleared, so the setter below only re-arms a node it is responsible
 * for; re-arming any other node would legalise a write Solid 2 means to
 * reject.
 *
 * Only the store setter is exempted, not all eight sites: signals are
 * already covered by `CONFIG_OWNED_WRITE` (the shimmed `createSignal` below
 * forces it on every vendor signal); `markRefresh` and the pending-async
 * guard have no vendor call site here. The three read sites (committed-vs-
 * staged) are a known, unpatched divergence; no consumer has produced a case.
 *
 * Do not move the clear into the shim's own primitive constructors instead:
 * `createMemo` isn't shimmed here, it arrives via `export *`, so a vendor
 * nesting a memo would start throwing PRIMITIVE_IN_FORBIDDEN_SCOPE where it
 * does not today.
 */
const CONFIG_CHILDREN_FORBIDDEN = 1 << 4; // dev-shared.js

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
// `ownedWrite` as a `createEffect` option (the earlier attempt) is a silent
// no-op: it's a property of the signal being written
// (`createSignal(v, { ownedWrite: true })`), read off the signal's own
// config at `setSignal` time — `createEffect` never forwards it. The real
// fix for `[REACTIVE_WRITE_IN_OWNED_SCOPE]` is on the shimmed `createSignal`
// below, which defaults every vendor signal to `ownedWrite: true`.
export function createEffect(compute: any, effectFn?: any, options?: any) {
  if (effectFn === undefined) {
    // `createTrackedEffect`, for the same reason `createComputed` below uses
    // it: `(compute, () => {})` puts the body in the compute phase, where
    // Solid 2 forbids writes — and `ownedWrite` can't rescue a STORE write,
    // which is how @tanstack/solid-virtual broke (see `createComputed`).
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

// THE `@tanstack/solid-*` ADAPTER FAMILY. Everything below this line exists
// for that vendor group specifically: `batch`/`observable` for
// `@tanstack/solid-table`, `createComputed` for `-form`/`-table`/`-virtual`.

// `batch` is gone from 2.0 because its job is now the default: writes
// collapse into one update pass whether you ask for it or not, so a plain
// `fn()` is already "batched". It is the identity function.
//
// Mapping it onto `flush(fn)` (Solid 2's synchronous-drain primitive) was
// tried and is wrong per migration.txt ("Replacing each `batch` call with
// `flush` would change deferred work into synchronous work"), and it broke:
// `@tanstack/solid-table` calls `batch` from inside its reactivity bridge,
// which this file routes through `createTrackedEffect`, where `flush` is not
// reentrant — "Cannot call flush() from inside onSettled or
// createTrackedEffect" followed by `[REACTIVITY_HALTED]`, stopping every
// later update on the page. Measured on the solid-table render tests.
export function batch<T>(fn: () => T): T {
  return fn();
}

/*
 * `reconcile`: the options-object second argument, back again.
 *
 * Solid 1 took `reconcile(items, { key?, merge? })`. Solid 2 changed the
 * second parameter to the key itself (`reconcile(value, key?: string |
 * ((item) => any) | null)`), so handing it the Solid 1 object makes the
 * object *become* the key, and the diff walk calls it:
 * `TypeError: keyFn is not a function`, thrown inside a store setter inside
 * a tracked callback, taking the reactive system down with it.
 *
 * This wrapper was deleted once on the finding that no vendor passed the
 * object form; `@tanstack/solid-virtual` calls `reconcile(..., { key:
 * "index" })` twice. It stayed invisible under an earlier fault —
 * `devGuardStoreSetterWrite` rejected those same writes before the diff walk
 * ran, so fixing that guard turned 14 `REACTIVE_WRITE_IN_OWNED_SCOPE` errors
 * into 14 `keyFn is not a function` errors, same count and scenarios.
 *
 * Solid 1's `merge` option has no Solid 2 equivalent and is dropped; no
 * vendor in this set passes it. A one-argument call is unchanged (Solid 2's
 * own `"id"` default was Solid 1's default too).
 *
 * `solid-1-compat-store.ts` must take `reconcile` from here, not the real
 * package: `@tanstack/solid-virtual` imports it from `solid-js/store`, so
 * re-exporting the real one there leaves this wrapper unreached.
 */
export function reconcile(value: any, key?: any) {
  // `null` is a legal Solid 2 key (positional matching), so it must not be
  // mistaken for Solid 1's options object — tested explicitly, not by `typeof`.
  if (key !== null && typeof key === "object") return (realReconcile as any)(value, key.key);
  return (realReconcile as any)(value, key);
}

// `@tanstack/solid-form` and `@tanstack/solid-table` have no Solid 2 release
// (peer ranges: solid-form@2.0.0-alpha.2 is `solid-js: >=1.9.5`,
// solid-table@9.2.4 is `>=1.3`). Their missing exports surface one layer at a
// time, because rolldown reports the first batch and stops.

// `createComputed` was Solid 1's eager effect: ran synchronously at creation
// and on every dependency change, before the render pass — which is why
// libraries used it to derive state they then WROTE to a signal.
//
// `(compute, () => {})` (matching the `createEffect` shim above) type-checks
// and halts the reactive system: Solid 2 forbids writing from a computation.
// Measured on `@tanstack/solid-virtual`, built entirely on this shape — its
// `createComputed` body calls `setVirtualItems(reconcile(...))` — all three
// virtualizer render tests failed with `[REACTIVE_WRITE_IN_OWNED_SCOPE]` ->
// `[REACTIVITY_HALTED]`, which stops every later update too.
//
// `ownedWrite: true` (the `createSignal` rescue below) can't fix it either:
// half the writes are STORE writes, and `StoreOptions` has no `ownedWrite`
// field — a store write from a computation has no opt-out.
//
// So: `createTrackedEffect`, a single tracked callback whose writes are
// legal ("writes made inside it are queued into the same flush's
// continuation" — exactly Solid 1's `createComputed`).
//
// What it costs, from its own docs: it "may run multiple times for a single
// change or show tearing", "never holds a transition", and "cannot observe a
// write staged earlier in the same flush by a signal it has not read yet".
// Acceptable for a virtualizer republishing a window; also a reason this
// shim should disappear the day `@tanstack/solid-virtual` ships Solid 2.
export function createComputed(compute: any, effectFn?: any, options?: any) {
  if (effectFn === undefined) {
    return trackedEffectAllowingNestedPrimitives(compute, options);
  }
  // A two-argument call is already Solid 2-shaped and is passed through.
  return (realCreateRenderEffect as any)(compute, effectFn, options);
}
/*
 * `createRenderEffect`: the single-argument rescue is back. It was deleted
 * once on the finding that it had no vendor call site, re-measured wrong:
 * `@tanstack/solid-form@2.0.0-alpha.2` has four single-argument call sites
 * (`createField.lib.js`, `SolidFormApi.lib.js`). Counting a vendor tree with
 * a plain `rg` reports zero, since `node_modules` is gitignored and ripgrep
 * honours that (`rg --no-ignore` is required) — and even a non-ignoring
 * count would have missed this, since Solid 2 exports the name and only the
 * arity changed. Symptom: `TypeError: e.st is not a function` (the mangled
 * apply-phase callback, undefined because only a compute was passed).
 *
 * The mapping is `(fn, () => {})`, deliberately not what `createComputed`
 * above does: that shape was rejected there because `@tanstack/solid-virtual`
 * writes a store from its body, which solid-form does not — it writes
 * TanStack atoms, not Solid state. `createTrackedEffect`'s cost applies
 * here too: its first run is queued, not synchronous, whereas Solid 1's
 * `createRenderEffect` ran immediately at creation — which
 * `createInternalField`'s `_update()`/`_register()` depend on. A compute
 * phase keeps that timing.
 *
 * A two-argument call passes through, matching `createComputed`. Solid 1's
 * second parameter was the effect's initial value, not an apply function —
 * accepted as ambiguous since no vendor here passes one; if one ever does,
 * it arrives as a value called as a function, so it will not be silent.
 */
export function createRenderEffect(compute: any, effectFn?: any, options?: any) {
  if (effectFn === undefined) {
    return (realCreateRenderEffect as any)(compute, () => {}, options);
  }
  return (realCreateRenderEffect as any)(compute, effectFn, options);
}

// `observable(accessor)` turned a signal into a TC39/RxJS-interop observable.
// 2.0 dropped it; `@tanstack/solid-table`'s `dist/reactivity.js` still imports
// it. Reimplemented on `createEffect` rather than stubbed, because the one
// consumer actually subscribes: solid-table bridges TanStack Table's own
// store-notification model onto it, and a no-op would leave every table
// rendering its first page of rows and never updating — a silent failure, not
// an error.
//
// The contract, read off Solid 1's own implementation: `subscribe` takes
// either a function or an
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
