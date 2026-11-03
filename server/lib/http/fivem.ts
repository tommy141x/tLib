// fivem.ts — typed handles to the FiveM runtime globals.
//
// Why this exists: bun's CJS bundler wraps non-entry files in module scopes
// where `exports` is the CommonJS module-exports object, which shadows
// FiveM's global `exports(name, fn)` function. Calling `exports(...)` from a
// non-entry file bundles to `exports_bridge(...)` or similar and crashes at
// runtime. We resolve the globals through `globalThis` so the bundler leaves
// them alone.

type ExportsFn = (name: string, fn: (...args: unknown[]) => unknown) => void;
type EmitFn = (event: string, ...args: unknown[]) => void;
type OnFn = (event: string, handler: (...args: unknown[]) => void) => void;
type GetConvarFn = (name: string, defaultValue: string) => string;
type GetCurrentResourceNameFn = () => string;
type GetInvokingResourceFn = () => string | null;
type GetResourcePathFn = (resourceName: string) => string | null;
type LoadResourceFileFn = (resourceName: string, fileName: string) => string | null;
// The engine's own parsed view of a manifest. Used rather than reading
// fxmanifest.lua and matching on it: a regex over a manifest also matches the text
// inside comments, and these entries are what FXServer actually loaded.
type GetNumResourceMetadataFn = (resourceName: string, key: string) => number;
type GetResourceMetadataFn = (
  resourceName: string,
  key: string,
  index: number
) => string | null;

const g = globalThis as unknown as {
  exports: ExportsFn;
  emit: EmitFn;
  on: OnFn;
  GetConvar: GetConvarFn;
  GetCurrentResourceName: GetCurrentResourceNameFn;
  GetInvokingResource: GetInvokingResourceFn;
  GetResourcePath: GetResourcePathFn;
  LoadResourceFile: LoadResourceFileFn;
  GetNumResourceMetadata: GetNumResourceMetadataFn;
  GetResourceMetadata: GetResourceMetadataFn;
};

export const fExports: ExportsFn = g.exports;
export const fEmit: EmitFn = g.emit;
export const fOn: OnFn = g.on;
export const fGetConvar: GetConvarFn = g.GetConvar;
export const fGetCurrentResourceName: GetCurrentResourceNameFn = g.GetCurrentResourceName;
export const fGetInvokingResource: GetInvokingResourceFn = g.GetInvokingResource;
export const fGetResourcePath: GetResourcePathFn = g.GetResourcePath;
export const fLoadResourceFile: LoadResourceFileFn = g.LoadResourceFile;
export const fGetNumResourceMetadata: GetNumResourceMetadataFn = g.GetNumResourceMetadata;
export const fGetResourceMetadata: GetResourceMetadataFn = g.GetResourceMetadata;
