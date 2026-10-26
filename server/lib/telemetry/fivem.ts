// Typed handles to the FiveM runtime globals the telemetry module uses.
//
// Resolved lazily (a property read per call), NOT captured at module scope
// like `../marketplace/fivem.ts` and `../http/fivem.ts` do: a captured handle
// binds to whatever `globalThis` held at first import. A test stubbing the host
// in `beforeEach` installs it after that import, so a captured `fGetConvar`
// stays `undefined` — `tests/unit/telemetry-consent.test.ts` went 21-red on
// exactly this. In production this module installs eagerly from
// `server/main.ts`, before a consumer's `onResourceStart`, so the same capture
// bug would turn host readiness into a load-order question.
//
// `exports` is read through `globalThis` for the reason ../http/fivem.ts gives.

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
