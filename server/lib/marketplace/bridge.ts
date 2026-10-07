// The FiveM exports the Lua side calls into. All install and HTTP work happens
// here on the Node runtime; server/sv_marketplace.lua wraps these with
// friendlier names and fires the consumer's onInstall callback.
//
// An async export takes a Lua callback as its last argument rather than
// returning a Promise, so no Lua consumer has to await userdata.

import * as fs from "node:fs";
import * as path from "node:path";
import {
  assertItemBelongsToResource,
  CatalogueError,
} from "../../../shared/ts/marketplace/catalogue";
import { type BrowseParams, browseItems, likeItem, previewHtml } from "./browse";
import { fExports, fGetCurrentResourceName, fGetResourcePath } from "./fivem";
import { installFromData, uninstallItem } from "./installer";
import { list as listTargets, register as registerTarget, unregisterResource } from "./registry";

let installed = false;

export function registerBridge(): void {
  if (installed) return;
  installed = true;

  //   exports.tLib:mpRegisterType(resourceName, type, installPath)
  //
  // Files are written into resourceName, at installPath relative to its root.
  fExports("mpRegisterType", (resourceName: unknown, type: unknown, installPath: unknown) => {
    if (typeof resourceName !== "string" || !resourceName) return false;
    if (typeof type !== "string" || !type) return false;
    if (typeof installPath !== "string" || !installPath) return false;
    registerTarget({ resourceName, type, installPath });
    return true;
  });

  // Called by Lua when a consumer resource stops — drops its registered types.
  fExports("mpUnregisterResource", (resourceName: unknown) => {
    if (typeof resourceName !== "string" || !resourceName) return false;
    unregisterResource(resourceName);
    return true;
  });

  // Synchronously returns a JSON string of registered types, for diagnostics.
  fExports("mpListTypes", () => JSON.stringify(listTargets()));

  //   exports.tLib:mpBrowse(paramsJson, function(ok, err, resultJson) end)
  //
  // The only async export in this file, so it follows the convention stated in
  // `../community-configs/bridge.ts`: the Lua callback is the LAST argument and
  // is invoked exactly once with `(ok, errorOrNil, value)`. It never returns a
  // Promise — no Lua consumer should have to await userdata — and it never lets
  // a rejection escape, because an exception crossing into the Lua VM surfaces
  // as a scheduler error with no stack.
  //
  // Params and result both cross as JSON strings rather than tables: an empty
  // `items` list marshals into Lua as an empty table, indistinguishable from
  // an absent field, and `preview_waveform` is a numeric array that Lua↔JS
  // marshalling turns into an object with numeric keys.
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
  // Like or un-like one item for one player. Same async convention as
  // `mpBrowse`: the Lua callback is LAST, is invoked exactly once with
  // `(ok, errorOrNil, value)`, never returns a Promise and never lets a
  // rejection escape into the Lua VM.
  //
  // ══════════════════════════════════════════════════════════════════════════
  // ⚠️ `license` IS A PLAYER IDENTITY AND THIS EXPORT CANNOT CHECK IT.
  // ══════════════════════════════════════════════════════════════════════════
  //
  // It is a FiveM export, so ANY resource on the server can call it with any
  // string. That is not a hole this function can close — an export has no
  // caller identity to check — and it is why the ONE call site that matters,
  // `server/sv_marketplace.lua`, resolves the value from
  // `GetPlayerIdentifierByType(src, 'license')` for the `source` of a net event
  // rather than taking it from anywhere a client can reach.
  //
  // What the backend's `UNIQUE(item_id, subject)` then guarantees is "one like
  // per license per item", which stops an ordinary PLAYER inflating a count.
  // It does not stop the server OPERATOR, who can invent licenses here or call
  // the HTTP endpoint directly; the shared secret on that request is public by
  // design and identifies a server, never a person. tWeb's
  // `src/lib/marketplace/like-identity.ts` carries the whole argument.
  //
  // ⚠️ DO NOT add a convar or an operator setting that feeds `license`. The
  // per-player property depends entirely on the native being the source.
  //
  // The state comes back as a JSON string for the same reason `mpBrowse`'s page
  // does: Lua↔JS marshalling of small records is where fields quietly become
  // numeric-keyed tables, and a string cannot be misread.
  fExports("mpLike", (slug: unknown, license: unknown, next: unknown, cb: unknown) => {
    if (typeof cb !== "function") return;
    const done = cb as (ok: boolean, err: string | null, value?: unknown) => void;
    if (typeof slug !== "string" || !slug) {
      done(false, "slug required");
      return;
    }
    // Refused here as well as inside the transport, so a caller that forgot to
    // resolve an identity gets a sentence naming its own bug rather than a 400
    // from the host that reads, at the panel, as "the marketplace is down".
    if (typeof license !== "string" || !license) {
      done(false, "license required");
      return;
    }
    // ⚠️ `=== true`, so anything that is not an explicit "like" is an UN-like.
    // Lua marshals a missing boolean as `nil`, and the safe default for a
    // missing state is the one that adds nothing to a public count.
    void likeItem(slug, license, next === true).then(
      (state) => done(true, null, JSON.stringify(state)),
      (e: unknown) => done(false, e instanceof Error ? e.message : String(e))
    );
  });

  //   exports.tLib:mpPreviewHtml(slug, function(ok, err, html) end)
  //
  // Same async convention as `mpBrowse`. The answer is the preview document
  // itself, as text — the panel reads it, not just renders it, which is why it
  // cannot be a cross-origin `<iframe src>`. See `./browse.ts`.
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

  //   exports.tLib:mpAssertItemResource(resourceName, slug, function(ok, err) end)
  //
  // "Does this slug belong to this product?" — the question the coordinator
  // could not ask before `/api/v2/marketplace/items/:slug` was consumed here.
  //
  // ── Why this has to exist at all ────────────────────────────────────────────
  //
  // The coordinator keys registrations `resource:type` and installs into that
  // resource's own registered `installPath`, so a tELS item could never land in
  // tRadio's DIRECTORY. The item's own `resource` field was the unenforced part:
  // `tlib:marketplace:install('tRadar', 'ui', '<a-tELS-slug>')` passed every
  // check, and tLib fetched and installed it. Browse showed one product's
  // catalogue; install accepted a slug from any of them.
  //
  // ⚠️ FAILS CLOSED, and the Lua side must treat it that way: an unreachable
  // marketplace, a 404, a body that is not an item, or an item with no
  // `resource` all answer `ok = false`. "We could not check" is the state an
  // attacker controls and must not be the state that installs — the same
  // reasoning `assertBundleHash` already applies to a missing digest header.
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

  // Lua writes the downloaded zip to a temp file and Node reads it back off
  // disk, which sidesteps the Lua→JS binary string encoding problem.
  // tmpRelPath is relative to the tLib resource root, e.g. '.tmp/install-x.zip'.
  fExports(
    "mpInstallFromFile",
    (
      resourceName: unknown,
      type: unknown,
      slug: unknown,
      tmpRelPath: unknown,
      expectedHash: unknown,
      expectedSize: unknown
    ) => {
      if (typeof resourceName !== "string" || !resourceName)
        return JSON.stringify({ ok: false, error: "resourceName required" });
      if (typeof type !== "string" || !type)
        return JSON.stringify({ ok: false, error: "type required" });
      if (typeof slug !== "string" || !slug)
        return JSON.stringify({ ok: false, error: "slug required" });
      if (typeof tmpRelPath !== "string" || !tmpRelPath)
        return JSON.stringify({ ok: false, error: "tmpRelPath required" });

      const tLibRoot = fGetResourcePath(fGetCurrentResourceName());
      if (!tLibRoot)
        return JSON.stringify({ ok: false, error: "could not resolve tLib resource path" });

      const fullPath = path.join(tLibRoot, tmpRelPath);
      let buf: Buffer;
      try {
        buf = fs.readFileSync(fullPath);
      } catch (err) {
        return JSON.stringify({
          ok: false,
          error: `could not read temp file: ${err instanceof Error ? err.message : String(err)}`,
        });
      } finally {
        try {
          fs.unlinkSync(fullPath);
        } catch {
          /* best-effort cleanup */
        }
      }

      const hash = typeof expectedHash === "string" ? expectedHash : "";
      const size = typeof expectedSize === "number" ? expectedSize : 0;
      return JSON.stringify(installFromData(resourceName, type, slug, buf, hash, size));
    }
  );

  // Sync: delete installed files for a slug. Returns JSON of UninstallOutcome.
  fExports("mpUninstall", (resourceName: unknown, type: unknown, slug: unknown) => {
    if (typeof resourceName !== "string" || !resourceName)
      return JSON.stringify({ ok: false, error: "resourceName required" });
    if (typeof type !== "string") return JSON.stringify({ ok: false, error: "type required" });
    if (typeof slug !== "string") return JSON.stringify({ ok: false, error: "slug required" });
    return JSON.stringify(uninstallItem(resourceName, type, slug));
  });
}
