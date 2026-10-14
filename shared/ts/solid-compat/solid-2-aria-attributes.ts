/**
 * `@solidjs/web`, with one correction: `aria-*` and `role` are string-valued in
 * ARIA, not HTML booleans. Opt-in; see README.md for why and when to enable it.
 *
 * `spread` -> `assign` -> `assignProp` -> `setAttribute` is a module-local call
 * chain inside `@solidjs/web`, so a re-export cannot reach `setAttribute`
 * itself. The chain is intercepted at its entry points instead, which makes the
 * export list below load-bearing: miss one and the paths through it are
 * silently uncorrected.
 */
import * as real from "virtual:solid-1-compat-real/@solidjs/web";

export * from "virtual:solid-1-compat-real/@solidjs/web";

/**
 * `aria-hidden` is covered deliberately, and it is the one that looks wrong:
 * `aria-hidden="false"` overrides an inherited `aria-hidden="true"` while an
 * absent one inherits it, so dropping it hides a visible control from a screen
 * reader.
 */
function isAriaName(name: string): boolean {
  return name.startsWith("aria-") || name === "role";
}

function coerce(name: string, value: unknown): unknown {
  return typeof value === "boolean" && isAriaName(name) ? String(value) : value;
}

/**
 * Coerces in `get` rather than up front: a props source may be a function, an
 * array of sources, or an object whose keys are getters, and reading those
 * eagerly freezes the reactivity the laziness exists to provide.
 */
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

/* The direct path: a static attribute the compiler binds by name */

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

/* The spread path: `{...props}`, where the names are not known statically */

export function spread(node: Element, props: unknown, ...rest: unknown[]): unknown {
  return (real as any).spread(node, wrap(props), ...rest);
}

export function assign(node: Element, props: unknown, ...rest: unknown[]): unknown {
  return (real as any).assign(node, wrap(props), ...rest);
}

/* The server, because an SSR'd value disagreeing with the hydrated one is a
 * hydration mismatch on top of the accessibility bug */

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
