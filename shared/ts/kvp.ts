// KVP key prefixing -- mirrors the Lua kvp module's namespace logic
// read/write still goes through native KVP calls (they're sync, can't abstract)

declare function GetConvar(name: string, defaultValue: string): string;

let _prefix: string | null = null;
let _resolved = false;

/** The namespace algorithm, free of convars and the memo so kvp.test.ts can
 *  pin it. A candidate that sanitizes to nothing falls through to the next
 *  rather than selecting an empty prefix; imports/kvp/client.lua resolves the
 *  same way and tests/lua's kvp-prefix suite asserts the same cases. */
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

/**
 * Where a key sits: whose community, and which server. Both parts are optional
 * and neither is on by default — see `imports/kvp/client.lua`'s header, which is
 * the one statement of this contract.
 */
export interface KvpScope {
  /**
   * The community prefix. Already sanitized; `null` (the usual case) means
   * none — it comes from `tlib_community_id` or `sv_projectName`, neither a
   * standard FiveM convar, so most servers set no prefix. Separates one
   * owner's boxes from another's, not two servers (`serverScoped` does that).
   */
  community?: string | null;
  /**
   * This server's tag, from `tlib.kvp.serverTag()`. `null`/`""` means
   * unresolved, in which case a `serverScoped` key is left unscoped rather
   * than gaining a bare trailing underscore — an environment that never got a
   * tag keeps what the player tuned instead of silently reverting it.
   */
  serverTag?: string | null;
}

/**
 * Compose a KVP key. The one implementation, shared by the Lua side
 * (`shared/imports/kvp/client.lua`'s `kvp.key`) and every TypeScript caller —
 * tRadio previously had this arithmetic three times (two in `cl_bridge.lua`,
 * one in `SettingsStore`), relying on agreement by inspection across two
 * runtimes over strings already persisted on players' machines.
 * `tLib/tests/unit/kvp-prefix.test.ts` and `tests/lua/kvp-views.lua` pin both
 * sides against the same vectors.
 */
export function composeKvpKey(key: string, scope: KvpScope = {}, serverScoped = false): string {
  let composed = key;
  if (serverScoped && scope.serverTag) composed = `${composed}_${scope.serverTag}`;
  return scope.community ? `${scope.community}_${composed}` : composed;
}

/**
 * A community-prefixed key, nothing more: `serverScoped` isn't reachable here
 * since a server tag is a client fact (`GetCurrentServerEndpoint`) this side
 * can't resolve. A caller needing an isolated key composes it with
 * `composeKvpKey` and a tag handed down from the client.
 */
export function kvpKey(key: string): string {
  return composeKvpKey(key, { community: resolvePrefix() });
}
