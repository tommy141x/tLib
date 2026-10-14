/// <reference path="./solid-1-compat-virtual.d.ts" />
/**
 * The `solid-js/web` shim: Solid 2 moved the DOM runtime into `@solidjs/web`, so
 * a vendor `from "solid-js/web"` has nothing to resolve to and lands here.
 *
 * Vendor code only; `src/` cannot reach it. Everything this file corrects, and
 * the measurement behind each correction, is in README.md. `use()` is restored
 * because compiled Solid 1 output calls it directly even though Solid 2 dropped
 * `use:` directives in favour of ref callbacks.
 */
import {
  spread as realSpread,
  SVGElements,
  Namespaces,
  Dynamic as realDynamic,
  effect as realEffect,
  isServer,
} from "virtual:solid-1-compat-real/@solidjs/web";
// From core, not from `@solidjs/web`, which omits it from its client production
// build and so fails that build with MISSING_EXPORT.
import { sharedConfig } from "virtual:solid-1-compat-real/solid-js";

export * from "virtual:solid-1-compat-real/@solidjs/web";

// Vendors import the flow components from both spellings, so the shimmed
// `Show`/`Switch` have to win over the `export *` above. `Index` is here because
// Solid 2 removed it outright and there is nothing to fall through to.
export { Index, Show, Switch } from "./solid-1-compat";

export function use(fn: any, element: any, arg: any) {
  return fn(element, typeof arg === "function" ? arg : () => arg);
}

// `spread`'s arguments three and four changed position AND meaning between the
// two versions, so the name resolves and only the call is wrong. A
// three-argument call cannot be told apart by `typeof` and is read as Solid 1 on
// reachability: `solid-js/web` is absent from Solid 2's `exports` map, so
// nothing compiled against Solid 2 can reach this module. See README.md.
//
// `isSVG` and `skipChildren` — everything Solid 1's signature has after the
// accessor. A third entry can only be Solid 2's `name`.
const SOLID_1_TAIL_LENGTH = 2;

export function spread(node: any, accessor: any, ...rest: any[]) {
  // `rest[0]` is Solid 1's `isSVG`, which Solid 2 has no parameter for;
  // `rest[1]` is Solid 1's `skipChildren`, which is Solid 2's argument three.
  const skipChildren = rest[1];
  if (typeof skipChildren === "function" || rest.length > SOLID_1_TAIL_LENGTH) {
    return (realSpread as any)(node, accessor, ...rest);
  }
  return (realSpread as any)(node, accessor, skipChildren);
}

// `effect`'s second argument is Solid 1's initial `prev` and Solid 2's write
// half, so a Solid 1 compiler's accumulator object gets consumed as a function
// and `compute` runs with `prev === undefined`. Dispatch on `typeof` cannot
// collide: Solid 2's is always a function, Solid 1's never is. See README.md.
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

// Solid 1's JSX-safe spelling of `for`. Real Solid 2 writes a literal, inert
// `htmlfor` instead, and `@ark-ui/solid`'s `Field.Label` has no other spelling.
const HTML_FOR_ALIAS = "htmlFor";
const REAL_FOR = "for";

// Solid 2 applies the HTML boolean-attribute rule to every name, but ARIA's
// boolean states carry the literal string "true"/"false" rather than
// presence/absence. An explicit string passes through untouched.
function coerceAriaBoolean(prop: string, value: unknown): unknown {
  if (typeof value === "boolean" && prop.startsWith("aria-")) {
    return value ? "true" : "false";
  }
  return value;
}

/**
 * Solid 1's `Dynamic`: a component function or a plain tag name, no
 * server-component binding delivery. Solid 2's own one yields a marker object
 * rather than an element for a tag-name string. See README.md.
 */
export function Dynamic(props: any) {
  const comp = props.component;
  // An empty target, not `props` itself: a non-configurable own property cannot
  // legally be hidden by `ownKeys`/`getOwnPropertyDescriptor`.
  const rest = new Proxy(
    {},
    {
      // Every SYMBOL key is hidden, not just `component`. A real Solid props
      // view is tagged with `$PROXY`, and `spread()` uses that tag to read the
      // underlying record directly, bypassing these traps -- so forwarding it
      // let the unaliased `htmlfor` through while `Object.keys` looked correct.
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
  // The shape the real `Dynamic` expects. A Proxy rather than
  // `{ component, ...rest }` because an object spread snapshots every value and
  // would silently de-reactify the element.
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
    // No `document` here, and the client-only marker bug does not apply.
    if (isServer) {
      return (realDynamic as any)(full);
    }
    // `document.createElement` cannot CLAIM an existing SSR node, so during
    // hydration the path below built an orphan and Solid's `insert` kept the
    // real one -- a component inert on first load and fine after a navigation.
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
