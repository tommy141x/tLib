// KVP key prefixing -- mirrors the Lua kvp module's namespace logic
// read/write still goes through native KVP calls (they're sync, can't abstract)

declare function GetConvar(name: string, defaultValue: string): string;

let _prefix: string | null = null;
let _resolved = false;

function resolvePrefix(): string | null {
  if (_resolved) return _prefix;
  _resolved = true;

  const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "");

  let raw = GetConvar("tlib_community_id", "");
  if (raw) {
    const cleaned = sanitize(raw);
    if (cleaned) {
      _prefix = cleaned;
      return _prefix;
    }
  }

  raw = GetConvar("sv_projectName", "");
  if (raw) {
    const cleaned = sanitize(raw);
    if (cleaned) {
      _prefix = cleaned;
      return _prefix;
    }
  }

  return null;
}

export function getKvpPrefix(): string | null {
  return resolvePrefix();
}

export function kvpKey(key: string): string {
  const prefix = resolvePrefix();
  return prefix ? `${prefix}_${key}` : key;
}
