// Typed handles to the FiveM runtime globals, resolved through globalThis.
// See ../http/fivem.ts for why that indirection is required.

type ExportsFn = (name: string, fn: (...args: unknown[]) => unknown) => void;
type OnFn = (event: string, handler: (...args: unknown[]) => void) => void;
type GetInvokingResourceFn = () => string | null;

const g = globalThis as unknown as {
  exports: ExportsFn;
  on: OnFn;
  GetInvokingResource?: GetInvokingResourceFn;
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
