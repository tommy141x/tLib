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

/**
 * Where a key sits: whose community, and which server. Both parts are optional
 * and neither is on by default — see `imports/kvp/client.lua`'s header, which is
 * the one statement of this contract.
 */
export interface KvpScope {
  /**
   * The community prefix. Already sanitized; `null` means none, which is the
   * usual case: it comes from `tlib_community_id` or `sv_projectName` and
   * NEITHER IS A STANDARD FiveM CONVAR, so most servers set no prefix at all.
   * It separates one owner's boxes from another's — it does not separate two
   * servers, and `serverScoped` below is what does.
   */
  community?: string | null;
  /**
   * This server's tag, as `tlib.kvp.serverTag()` computes it. `null` or `""`
   * means no server has been resolved, in which case a `serverScoped` key is
   * left UNSCOPED rather than gaining a bare trailing underscore — a dev session
   * or an environment that never received a tag then keeps what the player tuned
   * instead of silently reverting them.
   */
  serverTag?: string | null;
}

/**
 * Compose a KVP key. The one implementation of the composition, shared by the
 * Lua side (`shared/imports/kvp/client.lua`'s `kvp.key`) and by every
 * TypeScript caller.
 *
 * It exists because tRadio had the arithmetic three times — a `settingKvpKey`
 * wrapper in `cl_bridge.lua`, a second copy for scan state in the same file,
 * and `SettingsStore`'s `prefix` + `suffix` in TypeScript — and the comment on
 * the Lua one said out loud that "the two lists must agree or the engine reads a
 * key Lua never loaded". Agreement by inspection, across two runtimes, over
 * strings that are already persisted on players' machines.
 *
 * `tLib/tests/unit/kvp-prefix.test.ts` pins these against the same vectors
 * `tests/lua/kvp-views.lua` pins the Lua side against.
 */
export function composeKvpKey(key: string, scope: KvpScope = {}, serverScoped = false): string {
  let composed = key;
  if (serverScoped && scope.serverTag) composed = `${composed}_${scope.serverTag}`;
  return scope.community ? `${scope.community}_${composed}` : composed;
}

/**
 * A community-prefixed key and nothing more: `serverScoped` is deliberately not
 * reachable from here, because a server tag is a CLIENT fact
 * (`GetCurrentServerEndpoint`) and this side has no way to resolve one. A caller
 * that needs an isolated key has to compose it with `composeKvpKey` and a tag
 * handed down from the client.
 */
export function kvpKey(key: string): string {
  return composeKvpKey(key, { community: resolvePrefix() });
}
