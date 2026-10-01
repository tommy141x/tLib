// The FiveM exports `server/sv_community_configs.lua` calls into.
//
// Every export here is async and follows the convention `../marketplace/bridge.ts`
// states: the Lua callback is the LAST argument, rather than returning a
// Promise, so no Lua consumer has to await userdata.
//
// The callback is always invoked exactly once, with `(ok, errorOrNil, value)`.
// Errors are strings, never thrown across the boundary — an exception crossing
// into the Lua VM surfaces as an unhelpful scheduler error with no stack.

import { fExports } from "../marketplace/fivem";
import {
  importConfig,
  listConfigs,
  matchConfigs,
  type PublishPayload,
  peekConfig,
  publishConfig,
} from "./api";

let installed = false;

type LuaCallback = (ok: boolean, err: string | null, value?: unknown) => void;

function isCallback(fn: unknown): fn is LuaCallback {
  return typeof fn === "function";
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Run an async API call and report it to Lua exactly once.
 *
 * `void` on the promise is deliberate: the export returns immediately and the
 * result arrives through the callback. An unhandled rejection here would take
 * down the resource's Node thread, so every path resolves through `settle`.
 */
function settle(work: Promise<unknown>, cb: LuaCallback): void {
  void work.then(
    (value) => cb(true, null, value),
    (e: unknown) => cb(false, errText(e))
  );
}

export function registerCommunityConfigsBridge(): void {
  if (installed) return;
  installed = true;

  //   exports.tLib:ccPublish(payloadJson, function(ok, err, id) end)
  //
  // The payload crosses as JSON rather than as a table because it carries the
  // model fingerprint — a nested map of ~30 bone names to 3-element arrays —
  // and Lua↔JS table marshalling turns a sparse array into an object with
  // numeric keys. JSON round-trips it unchanged.
  fExports("ccPublish", (payloadJson: unknown, cb: unknown) => {
    if (!isCallback(cb)) return;
    if (typeof payloadJson !== "string" || !payloadJson) {
      cb(false, "payload required");
      return;
    }

    let payload: PublishPayload;
    try {
      payload = JSON.parse(payloadJson) as PublishPayload;
    } catch {
      cb(false, "payload is not valid JSON");
      return;
    }
    settle(publishConfig(payload), cb);
  });

  //   exports.tLib:ccList(script, configType, key, limit, function(ok, err, itemsJson) end)
  //
  // `itemsJson` is a JSON string for the same marshalling reason as above:
  // every item carries a fingerprint and an LED-name array.
  fExports(
    "ccList",
    (script: unknown, configType: unknown, key: unknown, limit: unknown, cb: unknown) => {
      if (!isCallback(cb)) return;
      if (typeof script !== "string" || typeof configType !== "string") {
        cb(false, "script and configType required");
        return;
      }
      settle(
        listConfigs({
          script,
          configType,
          key: typeof key === "string" && key ? key : undefined,
          limit: typeof limit === "number" ? limit : undefined,
        }).then((items) => JSON.stringify(items)),
        cb
      );
    }
  );

  //   exports.tLib:ccMatch(script, configType, fpJson, key, limit, function(ok, err, itemsJson) end)
  //
  // Returns CANDIDATES. The caller scores them; see `api.ts`.
  fExports(
    "ccMatch",
    (
      script: unknown,
      configType: unknown,
      fpJson: unknown,
      key: unknown,
      limit: unknown,
      cb: unknown
    ) => {
      if (!isCallback(cb)) return;
      if (typeof script !== "string" || typeof configType !== "string") {
        cb(false, "script and configType required");
        return;
      }
      if (typeof fpJson !== "string" || !fpJson) {
        cb(false, "fingerprint required");
        return;
      }

      let fp: unknown;
      try {
        fp = JSON.parse(fpJson);
      } catch {
        cb(false, "fingerprint is not valid JSON");
        return;
      }

      settle(
        matchConfigs({
          script,
          configType,
          fp,
          key: typeof key === "string" && key ? key : undefined,
          limit: typeof limit === "number" ? limit : undefined,
        }).then((items) => JSON.stringify(items)),
        cb
      );
    }
  );

  //   exports.tLib:ccImport(id, function(ok, err, configJson) end)
  //
  // `configJson` is the raw published string; the consumer decodes it.
  fExports("ccImport", (id: unknown, cb: unknown) => {
    if (!isCallback(cb)) return;
    if (typeof id !== "string" || !id) {
      cb(false, "id required");
      return;
    }
    settle(importConfig(id), cb);
  });

  //   exports.tLib:ccPeek(id, function(ok, err, configJson) end)
  //
  // The same payload `ccImport` returns, from a route that does NOT increment
  // the config's import counter. Consumers that read a config to render or
  // preview it — rather than because a player chose to install it — must use
  // this one, or the counter stops meaning "installed".
  fExports("ccPeek", (id: unknown, cb: unknown) => {
    if (!isCallback(cb)) return;
    if (typeof id !== "string" || !id) {
      cb(false, "id required");
      return;
    }
    settle(peekConfig(id), cb);
  });
}
