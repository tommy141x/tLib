// Typed handles to the FiveM runtime globals, resolved through globalThis.
// See ../http/fivem.ts for why that indirection is required.

type ExportsFn = (name: string, fn: (...args: unknown[]) => unknown) => void;
type OnFn = (event: string, handler: (...args: unknown[]) => void) => void;
type GetResourcePathFn = (resourceName: string) => string | null;

const g = globalThis as unknown as {
  exports: ExportsFn;
  on: OnFn;
  GetResourcePath: GetResourcePathFn;
};

export const fExports: ExportsFn = g.exports;
export const fOn: OnFn = g.on;
export const fGetResourcePath: GetResourcePathFn = g.GetResourcePath;
