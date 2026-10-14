// Typed handles to the FiveM runtime globals the telemetry module uses.
//
// RESOLVED LAZILY, NOT CAPTURED AT MODULE SCOPE
//
// `../marketplace/fivem.ts` and `../http/fivem.ts` capture their globals in a
// `const` at module evaluation. That works for them and it is wrong here, for
// the reason `shared/ts/fs/server.ts` already documents: a captured handle is
// bound to whatever `globalThis` held the instant this file was first imported.
//
// Two consequences, one of which bit immediately:
//
//   • A suite that installs a host stub in `beforeEach` installs it AFTER the
//     import, so a captured `fGetConvar` is `undefined` and every consent test
//     exercises the "no convar" branch while claiming to test the others.
//     `tests/unit/telemetry-consent.test.ts` went 21-red on exactly that, and
//     the alternative — mutating `globalThis` before the import, with a dynamic
//     `await import` — makes the test harness decide module order, which is how
//     one suite ends up depending on another's load.
//   • In production the window is narrower but real: this module is installed
//     eagerly from `server/main.ts` so a consumer's Lua can call its exports
//     before `onResourceStart`, and a capture makes "has the host finished
//     installing its globals" a load-order question rather than a call-time one.
//
// The cost is one property read per call, on paths that run once a minute.
//
// `exports` is reached through `globalThis` for the usual reason as well: bun's
// CJS bundler wraps non-entry files in a scope where `exports` is the CommonJS
// module-exports object, which shadows FiveM's global `exports(name, fn)`.

type ExportsFn = (name: string, fn: (...args: unknown[]) => unknown) => void;
type OnFn = (event: string, handler: (...args: unknown[]) => void) => void;
type GetConvarFn = (name: string, defaultValue: string) => string;
type GetCurrentResourceNameFn = () => string;
type GetResourcePathFn = (resourceName: string) => string | null;
type PerformHttpRequestFn = (
  url: string,
  callback: (statusCode: number, body: string, headers: Record<string, string>) => void,
  method: string,
  data: string,
  headers: Record<string, string>
) => void;

interface Host {
  exports?: ExportsFn;
  on?: OnFn;
  GetConvar?: GetConvarFn;
  GetCurrentResourceName?: GetCurrentResourceNameFn;
  GetResourcePath?: GetResourcePathFn;
  PerformHttpRequest?: PerformHttpRequestFn;
}

const host = (): Host => globalThis as unknown as Host;

/**
 * Every accessor answers `undefined` when the host does not provide it, and
 * every caller is written to tolerate that. A diagnostics module that threw
 * because a global was missing would be a diagnostics module that could stop a
 * boot — the one thing it must never do.
 */
export const fExports = (name: string, fn: (...args: unknown[]) => unknown): void => {
  host().exports?.(name, fn);
};

export const fOn = (event: string, handler: (...args: unknown[]) => void): void => {
  host().on?.(event, handler);
};

export const fGetConvar = (name: string, defaultValue: string): string =>
  host().GetConvar?.(name, defaultValue) ?? defaultValue;

export const fGetCurrentResourceName = (): string => host().GetCurrentResourceName?.() ?? "";

export const fGetResourcePath = (resourceName: string): string | null =>
  host().GetResourcePath?.(resourceName) ?? null;

/** `undefined` when the host has no HTTP client, which `performPost` treats as a failure. */
export const fPerformHttpRequest = (
  url: string,
  callback: (statusCode: number, body: string, headers: Record<string, string>) => void,
  method: string,
  data: string,
  headers: Record<string, string>
): void => {
  const fn = host().PerformHttpRequest;
  if (!fn) {
    callback(0, "PerformHttpRequest is not available in this runtime", {});
    return;
  }
  fn(url, callback, method, data, headers);
};
