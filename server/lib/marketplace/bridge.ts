// FiveM exports the Lua side calls into; sv_marketplace.lua wraps these with
// friendlier names. Async exports take the Lua callback as their last argument.
//
// Every export here must be a READ: `fExports` has no ACE check and no `source`
// to attribute a caller, so installs/uninstalls go through a net event gated on
// `tlib.admin` instead, with disk work done by the owning consumer's own agent.
// `mpInstallFromFile`, `mpUninstall`, `mpListTypes`, `mpUnregisterResource` were
// removed from here: uncalled, unauthenticated write surface. A write belongs on
// a net event with the admin gate, dispatched to the agent — never added here.

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
  // The one write-shaped export, but it only writes this process's in-memory
  // registry. The caller (`RegisterMarketplaceType`) resolves resourceName from
  // `GetInvokingResource()`, not from its arguments.
  fExports("mpRegisterType", (resourceName: unknown, type: unknown, installPath: unknown) => {
    if (typeof resourceName !== "string" || !resourceName) return false;
    if (typeof type !== "string" || !type) return false;
    if (typeof installPath !== "string" || !installPath) return false;
    registerTarget({ resourceName, type, installPath });
    return true;
  });

  //   exports.tLib:mpBrowse(paramsJson, function(ok, err, resultJson) end)
  //
  // Async convention shared by every export below: Lua callback last, invoked
  // exactly once, no rejection escapes into the Lua VM.
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
  // `license` is a player identity this export cannot verify — any resource can
  // call it with any string. The one call site that matters resolves it from
  // `GetPlayerIdentifierByType` on a net event's `source`. Backend `UNIQUE(item_id,
  // subject)` then caps it at one like per license per item, stopping a player
  // from inflating the count — not an operator, since the shared secret
  // identifies a server, never a person. Never feed `license` from a convar or
  // operator setting; the per-player guarantee depends on the native being the source.
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
  // A `theme` item's published definition, for the dispatch-panel preview.
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
  // resource's registered installPath, so the item's own `resource` field was
  // the unenforced part — an install naming one product with another's slug
  // passed every other check. Fails closed: an unreachable marketplace, a 404,
  // or a non-item body all answer `ok = false`, since "could not check" is a
  // state an attacker controls. The error is the CatalogueError code, not a
  // sentence, so the coordinator can tell `item_resource_mismatch` (a real
  // refusal) from a retryable transport failure.
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
