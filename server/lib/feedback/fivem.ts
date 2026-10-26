// Typed handles to the FiveM runtime globals, resolved through globalThis.
// See ../http/fivem.ts for why that indirection is required.

type ExportsFn = (name: string, fn: (...args: unknown[]) => unknown) => void;

const g = globalThis as unknown as {
  exports: ExportsFn;
};

export const fExports: ExportsFn = g.exports;
