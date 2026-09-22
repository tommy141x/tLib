// KVP key prefixing -- mirrors the Lua kvp module's namespace logic
// read/write still goes through native KVP calls (they're sync, can't abstract)

declare function GetConvar(name: string, defaultValue: string): string;

let _prefix: string | null = null;
let _resolved = false;

/** The namespace algorithm itself, free of convars and of the memo so the
 *  vectors in kvp.test.ts can pin it. A candidate that sanitizes away to
 *  nothing falls through to the next one rather than selecting an empty
 *  prefix — imports/kvp/client.lua resolves the same way, and tests/lua's
 *  kvp-prefix suite asserts these same cases against it. */
export function resolveKvpPrefix(candidates: string[]): string | null {
  for (const candidate of candidates) {
    const cleaned = candidate.replace(/[^a-zA-Z0-9_-]/g, "");
    if (cleaned) return cleaned;
  }
  return null;
}

function resolvePrefix(): string | null {
  if (_resolved) return _prefix;
  _resolved = true;
  _prefix = resolveKvpPrefix([GetConvar("tlib_community_id", ""), GetConvar("sv_projectName", "")]);
  return _prefix;
}

export function getKvpPrefix(): string | null {
  return resolvePrefix();
}

export function kvpKey(key: string): string {
  const prefix = resolvePrefix();
  return prefix ? `${prefix}_${key}` : key;
}
