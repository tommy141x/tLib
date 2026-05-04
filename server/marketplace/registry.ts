// In-memory registry of install types. Consumer resources call
// RegisterMarketplaceType(type, opts) to declare "this script accepts items
// of <type> and they should land under <installPath> in my resource folder."

export interface InstallTarget {
  /** Resource name that registered the type — owns the install path. */
  resourceName: string;
  /** Asset type identifier (e.g. 'ui-radio', 'ui-tels-hud', 'tone'). */
  type: string;
  /** Directory, relative to the resource root, where items land. */
  installPath: string;
}

const registry = new Map<string, InstallTarget>();

/** Register a type scoped to its resource. Two different resources can both register 'ui'. */
export function register(target: InstallTarget): void {
  const key = target.resourceName + ":" + target.type;
  const existing = registry.get(key);
  if (existing && existing.installPath !== target.installPath) {
    console.warn(
      `[tLib/marketplace] "${key}" re-registered with different installPath — last-writer-wins`
    );
  }
  registry.set(key, target);
}

/** Remove all types owned by a resource — called on resource stop. */
export function unregisterResource(resourceName: string): void {
  for (const [type, target] of registry) {
    if (target.resourceName === resourceName) registry.delete(type);
  }
}

export function get(resourceName: string, type: string): InstallTarget | null {
  return registry.get(resourceName + ":" + type) ?? null;
}

export function list(): InstallTarget[] {
  return Array.from(registry.values());
}
