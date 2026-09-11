// fivem.ts — typed handles to the FiveM runtime globals.
//
// Why this exists: bun's CJS bundler wraps non-entry files in module scopes
// where `exports` is the CommonJS module-exports object, which shadows
// FiveM's global `exports(name, fn)` function. Calling `exports(...)` from a
// non-entry file bundles to `exports_bridge(...)` or similar and crashes at
// runtime. We resolve the globals through `globalThis` so the bundler leaves
// them alone.
//
// Mirrors server/realtime/fivem.ts and server/marketplace/fivem.ts — each
// module keeps its own handle file rather than sharing one, so a module can be
// lifted out without dragging the others' globals along.

type ExportsFn = (name: string, fn: (...args: unknown[]) => unknown) => void;
type EmitFn = (event: string, ...args: unknown[]) => void;
type OnFn = (event: string, handler: (...args: unknown[]) => void) => void;
type GetConvarFn = (name: string, defaultValue: string) => string;
type GetCurrentResourceNameFn = () => string;
type GetInvokingResourceFn = () => string | null;

const g = globalThis as unknown as {
  exports: ExportsFn;
  emit: EmitFn;
  on: OnFn;
  GetConvar: GetConvarFn;
  GetCurrentResourceName: GetCurrentResourceNameFn;
  GetInvokingResource: GetInvokingResourceFn;
};

export const fExports: ExportsFn = g.exports;
export const fEmit: EmitFn = g.emit;
export const fOn: OnFn = g.on;
export const fGetConvar: GetConvarFn = g.GetConvar;
export const fGetCurrentResourceName: GetCurrentResourceNameFn = g.GetCurrentResourceName;
export const fGetInvokingResource: GetInvokingResourceFn = g.GetInvokingResource;
