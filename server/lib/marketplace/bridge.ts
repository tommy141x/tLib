// The FiveM exports the Lua side calls into. HTTP work happens here on the Node
// runtime; server/sv_marketplace.lua wraps these with friendlier names and fires
// the consumer's onInstall callback.
//
// An async export takes a Lua callback as its last argument rather than
// returning a Promise, so no Lua consumer has to await userdata.
//
// EVERY EXPORT HERE IS A READ, AND THAT IS NOW THE RULE.
//
// A `fExports` name is callable by ANY resource on the customer's server with any
// arguments, with no ACE check and no `source` to attribute it to. That is the
// same reason `shared/ts/marketplace/catalogue.ts` forbids handing
// `TLIB_PUBLIC_KEY` to an export, and it is why installs and uninstalls do not go
// through this file: they are a net event in `server/sv_marketplace.lua`, gated on
// `tlib.admin`, and the disk work happens in the owning consumer's own bundle
// (`shared/ts/marketplace/agent.ts`).
//
// This file used to also export `mpInstallFromFile` and `mpUninstall`, which
// wrote and DELETED a registered consumer's installed content on any caller's
// say-so. Nothing in any resource in this estate called either of them — the
// coordinator has only ever dispatched to the agent — so they were an
// unauthenticated write surface that existed purely because the install path used
// to live here. `mpListTypes` and `mpUnregisterResource` went with them: also
// uncalled, and the latter's comment claimed Lua invoked it on resource stop when
// `./index.ts` has always handled that with its own `onResourceStop` listener.
//
// So: anything added here must be a read. A write belongs on a net event with the
// admin gate, dispatched to the agent.

import {
  assertItemBelongsToResource,
  CatalogueError,
} from "../../../shared/ts/marketplace/catalogue";
import { type BrowseParams, browseItems, likeItem, previewHtml, themeJson } from "./browse";
import { fExports } from "./fivem";
import { register as registerTarget } from "./registry";

let installed = false;

export function registerBridge(): void {
  if (installed) return;
  installed = true;

  //   exports.tLib:mpRegisterType(resourceName, type, installPath)
  //
  // The one write-shaped export, and it writes only to this process's in-memory
  // registry: it declares where a consumer's items land. The coordinator calls it
  // from `RegisterMarketplaceType`, which has already resolved the resource name
  // from `GetInvokingResource()` rather than from its arguments.
  fExports("mpRegisterType", (resourceName: unknown, type: unknown, installPath: unknown) => {
    if (typeof resourceName !== "string" || !resourceName) return false;
    if (typeof type !== "string" || !type) return false;
    if (typeof installPath !== "string" || !installPath) return false;
    registerTarget({ resourceName, type, installPath });
    return true;
  });

  //   exports.tLib:mpBrowse(paramsJson, function(ok, err, resultJson) end)
  //
  // The first of the four async exports here, and the one that states the
  // convention the other three follow — it is `../community-configs/bridge.ts`'s:
  // the Lua callback is the LAST argument, it is invoked exactly once, and no
  // rejection escapes into the Lua VM. (This said "the only async export in this
  // file", which stopped being true the moment `mpLike` was added.)
  fExports("mpBrowse", (paramsJson: unknown, cb: unknown) => {
    if (typeof cb !== "function") return;
    const done = cb as (ok: boolean, err: string | null, value?: unknown) => void;

    let params: BrowseParams = {};
    if (typeof paramsJson === "string" && paramsJson) {
      try {
        params = JSON.parse(paramsJson) as BrowseParams;
      } catch {
        done(false, "params is not valid JSON");
        return;
      }
    }

    void browseItems(params).then(
      (result) => done(true, null, JSON.stringify(result)),
      (e: unknown) => done(false, e instanceof Error ? e.message : String(e))
    );
  });

  //   exports.tLib:mpLike(slug, license, next, function(ok, err, stateJson) end)
  //
  // Like or un-like one item for one player. Same async convention as `mpBrowse`.
  //
  // `license` IS A PLAYER IDENTITY AND THIS EXPORT CANNOT CHECK IT: it is a FiveM
  // export, so any resource on the server can call it with any string. That is not
  // a hole this function can close, and it is why the one call site that matters
  // resolves the value from `GetPlayerIdentifierByType` for the `source` of a net
  // event. The backend's `UNIQUE(item_id, subject)` then guarantees one like per
  // license per item, which stops an ordinary PLAYER inflating a count; it does
  // not stop the OPERATOR, and the shared secret identifies a server, never a
  // person.
  //
  // DO NOT add a convar or an operator setting that feeds `license`. The
  // per-player property depends entirely on the native being the source.
  //
  fExports("mpLike", (slug: unknown, license: unknown, next: unknown, cb: unknown) => {
    if (typeof cb !== "function") return;
    const done = cb as (ok: boolean, err: string | null, value?: unknown) => void;
    if (typeof slug !== "string" || !slug) {
      done(false, "slug required");
      return;
    }
    if (typeof license !== "string" || !license) {
      done(false, "license required");
      return;
    }
    void likeItem(slug, license, next === true).then(
      (state) => done(true, null, JSON.stringify(state)),
      (e: unknown) => done(false, e instanceof Error ? e.message : String(e))
    );
  });

  //   exports.tLib:mpPreviewHtml(slug, function(ok, err, html) end)
  //
  fExports("mpPreviewHtml", (slug: unknown, cb: unknown) => {
    if (typeof cb !== "function") return;
    const done = cb as (ok: boolean, err: string | null, value?: unknown) => void;
    if (typeof slug !== "string" || !slug) {
      done(false, "slug required");
      return;
    }
    void previewHtml(slug).then(
      (html) => done(true, null, html),
      (e: unknown) => done(false, e instanceof Error ? e.message : String(e))
    );
  });

  //   exports.tLib:mpThemeJson(slug, function(ok, err, json) end)
  //
  // A `theme` item's published definition, for the dispatch-panel preview. A
  // READ, same async convention as the three above.
  fExports("mpThemeJson", (slug: unknown, cb: unknown) => {
    if (typeof cb !== "function") return;
    const done = cb as (ok: boolean, err: string | null, value?: unknown) => void;
    if (typeof slug !== "string" || !slug) {
      done(false, "slug required");
      return;
    }
    void themeJson(slug).then(
      (json) => done(true, null, json),
      (e: unknown) => done(false, e instanceof Error ? e.message : String(e))
    );
  });

  //   exports.tLib:mpAssertItemResource(resourceName, slug, function(ok, err) end)
  //
  // "Does this slug belong to this product?" The coordinator installs into the
  // resource's own registered `installPath`, so an item could never land in
  // another product's DIRECTORY -- the item's own `resource` field was the
  // unenforced part, and an install naming one product with another's slug passed
  // every check. FAILS CLOSED, and the Lua side must treat it that way: an
  // unreachable marketplace, a 404 or a body that is not an item all answer
  // `ok = false`, because "we could not check" is the state an attacker controls.
  //
  // The error passed back is the CatalogueError CODE, not a sentence, so the
  // coordinator can distinguish `item_resource_mismatch` (a refusal to name
  // plainly) from a transport failure (retryable) and word each one itself.
  //
  // Async, so the same convention as `mpBrowse`: the Lua callback is LAST, is
  // invoked exactly once with `(ok, errorOrNil)`, and no rejection escapes into
  // the Lua VM.
  fExports("mpAssertItemResource", (resourceName: unknown, slug: unknown, cb: unknown) => {
    if (typeof cb !== "function") return;
    const done = cb as (ok: boolean, err: string | null) => void;
    if (typeof resourceName !== "string" || !resourceName) {
      done(false, "resourceName required");
      return;
    }
    if (typeof slug !== "string" || !slug) {
      done(false, "slug required");
      return;
    }
    void assertItemBelongsToResource(slug, resourceName).then(
      () => done(true, null),
      (e: unknown) =>
        done(
          false,
          e instanceof CatalogueError ? e.code : e instanceof Error ? e.message : String(e)
        )
    );
  });
}
