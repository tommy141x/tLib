// Typed handles to the FiveM runtime globals, resolved through globalThis.
//
// Same reason as server/lib/inference/fivem.ts and server/lib/realtime/fivem.ts:
// bun's CJS bundler wraps non-entry files in a scope where `exports` is the
// module object, which shadows FiveM's global `exports(name, fn)`.

type ExportsFn = (name: string, fn: (...args: unknown[]) => unknown) => void;
type OnFn = (event: string, handler: (...args: unknown[]) => void) => void;
type EmitFn = (event: string, ...args: unknown[]) => void;

const g = globalThis as unknown as {
  exports: ExportsFn;
  on: OnFn;
  emit: EmitFn;
  GetInvokingResource?: () => string | null;
  GetResourcePath?: (resourceName: string) => string | null;
  GetCurrentResourceName?: () => string;
  GetResourceMetadata?: (resourceName: string, key: string, index: number) => string | null;
};

export const fExports: ExportsFn = g.exports;
export const fOn: OnFn = g.on;
/** Used to feed tLib's own startup banner rather than printing extra lines. */
export const fEmit: EmitFn = g.emit;

/**
 * The resource on the other end of an export call.
 *
 * Taken from the runtime rather than the payload, so a caller cannot spawn under
 * someone else's name and a stopping resource's children can be reaped without
 * trusting it to have labelled them honestly.
 */
export function invokingResource(): string {
  try {
    return g.GetInvokingResource?.() ?? "";
  } catch {
    return "";
  }
}

/** Where a resource's files are, which is the boundary a spawn may not cross. */
export function resourcePath(resourceName: string): string {
  try {
    return g.GetResourcePath?.(resourceName) ?? "";
  } catch {
    return "";
  }
}

/**
 * Every `author` a resource's own fxmanifest declares.
 *
 * All of them, not index 0. These manifests carry two lines — a person and a
 * studio — and which one lands at index 0 differs between them: tDB and tRadio
 * open with `Tommy Johnston`, tAI with `TIMMYG Studios`. Reading only the first
 * would have made two of the three warn on every boot, which trains an operator
 * to ignore the warning.
 *
 * Worth reading and worth logging; not worth trusting. A resource writes its own
 * manifest, so this identifies an honest copy, never an attacker. Nothing
 * branches on the result — see `gate.ts`.
 */
export function resourceAuthors(resourceName: string): string[] {
  const found: string[] = [];
  try {
    // No count is exposed, so read until the metadata runs out. The bound is a
    // guard against a runtime that returns the same value forever, not a limit
    // anyone should hit.
    for (let index = 0; index < 8; index++) {
      const value = g.GetResourceMetadata?.(resourceName, "author", index);
      if (!value) break;
      found.push(value);
    }
  } catch {
    // An engine that will not answer reads as "declares nothing", which warns.
  }
  return found;
}

export function currentResource(): string {
  try {
    return g.GetCurrentResourceName?.() ?? "tLib";
  } catch {
    return "tLib";
  }
}
