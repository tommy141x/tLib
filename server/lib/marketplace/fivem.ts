// Typed handles to FiveM runtime globals used by the marketplace module.
// Same rationale as realtime/fivem.ts — the bundler shadows `exports` in
// non-entry files so we reach through globalThis.

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
