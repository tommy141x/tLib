// Typed handles to the FiveM globals this module uses.
//
// Its own file for the reason every other module keeps one (see
// ../http/fivem.ts): bun's CJS bundler wraps non-entry files in a scope where
// `exports` is the CommonJS object and shadows FiveM's global `exports(name,
// fn)`, so the globals are reached through `globalThis` where the bundler leaves
// them alone. Per module rather than shared, so a module can be lifted out
// without dragging the others' globals with it.

type ExportsFn = (name: string, fn: (...args: unknown[]) => unknown) => void;

const g = globalThis as unknown as {
  exports: ExportsFn;
};

export const fExports: ExportsFn = g.exports;
