// joaat ("Jenkins one-at-a-time") hashing, as RAGE uses it for asset and parameter names.
//
// Ported from CodeWalker.Core JenkHash. The lowercase fold is part of the algorithm as
// the game uses it - texture and shader lookups are case-insensitive because of it.

/**
 * joaat hash of `text`, lowercased first.
 *
 * Pass `preserveCase` for the rare call site that hashes an already-cased string;
 * everything in a resource file wants the default.
 */
export function joaat(text: string, preserveCase = false): number {
  const s = preserveCase ? text : text.toLowerCase();
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h + s.charCodeAt(i)) >>> 0;
    h = (h + (h << 10)) >>> 0;
    h = (h ^ (h >>> 6)) >>> 0;
  }
  h = (h + (h << 3)) >>> 0;
  h = (h ^ (h >>> 11)) >>> 0;
  h = (h + (h << 15)) >>> 0;
  return h >>> 0;
}

/** Format a hash the way CodeWalker and the game tools print it. */
export function hashToString(hash: number): string {
  return `0x${(hash >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
}

/**
 * A reverse lookup for hashes whose source string is known.
 *
 * Resource files store names as hashes, so the only way back to a readable name is a
 * dictionary of candidates. Callers seed this with names they already have (clip names
 * from the same file, texture names from a dictionary) rather than a global table.
 */
export class HashDictionary {
  private readonly names = new Map<number, string>();

  add(name: string): number {
    const h = joaat(name);
    this.names.set(h, name);
    return h;
  }

  addAll(names: Iterable<string>): this {
    for (const n of names) this.add(n);
    return this;
  }

  /** The original string, or `null` if this hash was never seeded. */
  get(hash: number): string | null {
    return this.names.get(hash >>> 0) ?? null;
  }

  /** The original string if known, otherwise the `0xXXXXXXXX` form. */
  label(hash: number): string {
    return this.get(hash) ?? hashToString(hash);
  }

  get size(): number {
    return this.names.size;
  }
}
