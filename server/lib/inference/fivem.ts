// Typed handles to the FiveM runtime globals, resolved through globalThis.
//
// Same reason as server/realtime/fivem.ts: bun's CJS bundler wraps non-entry
// files in a scope where `exports` is the module object, which shadows FiveM's
// global `exports(name, fn)`.

type ExportsFn = (name: string, fn: (...args: unknown[]) => unknown) => void;
type OnFn = (event: string, handler: (...args: unknown[]) => void) => void;
type GetInvokingResourceFn = () => string | null;

const g = globalThis as unknown as {
  exports: ExportsFn;
  on: OnFn;
  GetInvokingResource?: GetInvokingResourceFn;
  GetResourcePath?: (resourceName: string) => string | null;
  GetCurrentResourceName?: () => string;
};

export const fExports: ExportsFn = g.exports;
export const fOn: OnFn = g.on;

/**
 * The resource on the other end of an export call.
 *
 * Taken from the runtime rather than the payload so an advertisement cannot be
 * filed under someone else's name, and so a stopping resource's entries can be
 * cleaned up without trusting it to have labelled them honestly.
 */
export function invokingResource(): string {
  try {
    return g.GetInvokingResource?.() ?? "";
  } catch {
    return "";
  }
}

/** Where a resource's files are, for deciding what it is allowed to launch. */
export function resourcePath(resourceName: string): string {
  try {
    return g.GetResourcePath?.(resourceName) ?? "";
  } catch {
    return "";
  }
}

export function currentResource(): string {
  try {
    return g.GetCurrentResourceName?.() ?? "tLib";
  } catch {
    return "tLib";
  }
}
