// Typed handles to FiveM runtime globals used by the marketplace module.
// Same rationale as realtime/fivem.ts — the bundler shadows `exports` in
// non-entry files so we reach through globalThis.

type ExportsFn = (name: string, fn: (...args: unknown[]) => unknown) => void;
type EmitFn = (event: string, ...args: unknown[]) => void;
type OnFn = (event: string, handler: (...args: unknown[]) => void) => void;
type GetConvarFn = (name: string, defaultValue: string) => string;
type GetCurrentResourceNameFn = () => string;
type GetResourcePathFn = (resourceName: string) => string | null;
type GetNumResourcesFn = () => number;
type GetResourceByFindIndexFn = (index: number) => string | null;
type GetNumResourceMetadataFn = (resource: string, key: string) => number;
type GetResourceMetadataFn = (resource: string, key: string, index: number) => string | null;
type PerformHttpRequestFn = (
  url: string,
  callback: (statusCode: number, body: string, headers: Record<string, string>) => void,
  method: string,
  data: string,
  headers: Record<string, string>
) => void;

const g = globalThis as unknown as {
  exports: ExportsFn;
  emit: EmitFn;
  on: OnFn;
  GetConvar: GetConvarFn;
  GetCurrentResourceName: GetCurrentResourceNameFn;
  GetResourcePath: GetResourcePathFn;
  GetNumResources: GetNumResourcesFn;
  GetResourceByFindIndex: GetResourceByFindIndexFn;
  GetNumResourceMetadata: GetNumResourceMetadataFn;
  GetResourceMetadata: GetResourceMetadataFn;
  PerformHttpRequest: PerformHttpRequestFn;
};

export const fExports: ExportsFn = g.exports;
export const fEmit: EmitFn = g.emit;
export const fOn: OnFn = g.on;
export const fGetConvar: GetConvarFn = g.GetConvar;
export const fGetCurrentResourceName: GetCurrentResourceNameFn = g.GetCurrentResourceName;
export const fGetResourcePath: GetResourcePathFn = g.GetResourcePath;
export const fGetNumResources: GetNumResourcesFn = g.GetNumResources;
export const fGetResourceByFindIndex: GetResourceByFindIndexFn = g.GetResourceByFindIndex;
export const fGetNumResourceMetadata: GetNumResourceMetadataFn = g.GetNumResourceMetadata;
export const fGetResourceMetadata: GetResourceMetadataFn = g.GetResourceMetadata;
export const fPerformHttpRequest: PerformHttpRequestFn = g.PerformHttpRequest;
