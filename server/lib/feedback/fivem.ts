// Typed handles to the FiveM globals this module uses.
//
// Its own file for the reason every other module keeps one (see
// ../http/fivem.ts): bun's CJS bundler wraps non-entry files in a scope where
// `exports` is the CommonJS object and shadows FiveM's global `exports(name,
// fn)`, so the globals are reached through `globalThis` where the bundler leaves
// them alone. Per module rather than shared, so a module can be lifted out
// without dragging the others' globals with it.

type ExportsFn = (name: string, fn: (...args: unknown[]) => unknown) => void;
type GetCurrentResourceNameFn = () => string;
type GetResourcePathFn = (resourceName: string) => string | null;
type PerformHttpRequestFn = (
  url: string,
  callback: (statusCode: number, body: string, headers: Record<string, string>) => void,
  method: string,
  data: string,
  headers: Record<string, string>
) => void;

const g = globalThis as unknown as {
  exports: ExportsFn;
  GetCurrentResourceName: GetCurrentResourceNameFn;
  GetResourcePath: GetResourcePathFn;
  PerformHttpRequest: PerformHttpRequestFn;
};

export const fExports: ExportsFn = g.exports;
export const fGetCurrentResourceName: GetCurrentResourceNameFn = g.GetCurrentResourceName;
export const fGetResourcePath: GetResourcePathFn = g.GetResourcePath;
export const fPerformHttpRequest: PerformHttpRequestFn = g.PerformHttpRequest;
