// Demo mode's start-time sweep: put an install path back to the tree the
// resource shipped with.
//
// ── Why this is safe, and why it needs no allow-list ────────────────────────
//
// It deletes only what a `.marketplace-<slug>.json` receipt claims. A receipt is
// written by installFromData and names every file that install created, by hash.
// Content that SHIPPED with the resource is covered by the embedded
// ProtectedBuiltinInventory instead and is never receipt-owned — the installer
// refuses to write over it in the first place — so preinstalled marketplace
// content, the kind that appears in the catalogue but comes in the zip, is
// invisible to this function and survives untouched. That is a property of the
// receipt model, not a special case coded here, which is why there is no list of
// exceptions to keep in sync with the release.
//
// ── Why one bad slug must not stop the sweep ────────────────────────────────
//
// `owned()` throws rather than returns on a modified or unreceipted target —
// correct for an install, where the only safe move is to refuse. Here it would
// mean one hand-edited file leaving every later item installed, on a server
// whose entire promise is that a restart cleans it. So each slug is attempted
// independently and its failure is reported, not raised.

import * as fs from "node:fs";
import * as path from "node:path";
import { context, failure, type InstallFailure, type InstallTarget, stat } from "./core";
import { uninstallItem } from "./install";

const RECEIPT = /^\.marketplace-([a-z0-9][a-z0-9_-]*)\.json$/;

export interface ResetResult {
  ok: true;
  /** Slugs uninstalled, in the order attempted. */
  removed: string[];
  /** Slugs that could not be removed, with the reason. Never throws instead. */
  failed: { slug: string; error: string }[];
}
export type ResetOutcome = ResetResult | InstallFailure;

/**
 * Uninstall every marketplace item this target owns.
 *
 * @param target the same InstallTarget an install would use — one item type
 * @returns what was removed; `ok: false` only if the directory itself is unreadable
 */
export function resetInstalledToShipped(target: InstallTarget): ResetOutcome {
  const removed: string[] = [];
  const failed: { slug: string; error: string }[] = [];
  try {
    // context() validates installPath and every ancestor before we read it.
    // A throwaway slug is used purely to resolve the base directory; nothing
    // about `"probe"` reaches disk.
    const base = context(target, "probe").base;
    const dir = stat(base);
    if (!dir) return { ok: true, removed, failed };
    if (dir.isSymbolicLink() || !dir.isDirectory()) throw new Error("unsafe install directory");

    // Sorted so a sweep is reproducible and its log reads the same twice.
    const slugs: string[] = [];
    for (const entry of fs.readdirSync(base)) {
      const match = RECEIPT.exec(entry);
      if (!match) continue;
      // The same directory can back more than one item type. A receipt records
      // the type it was written for and uninstallItem checks it, so filtering
      // here keeps a cross-type receipt out of this target's failure list
      // rather than producing a spurious error for it.
      try {
        const raw = fs.readFileSync(path.join(base, entry), "utf8");
        if ((JSON.parse(raw) as { type?: unknown }).type !== target.type) continue;
      } catch {
        // Unreadable or unparseable: still ours to attempt, and uninstallItem
        // will produce the real diagnosis.
      }
      slugs.push(match[1]);
    }
    slugs.sort();

    for (const slug of slugs) {
      const outcome = uninstallItem(target, slug);
      if (outcome.ok) removed.push(slug);
      else failed.push({ slug, error: outcome.error });
    }
    return { ok: true, removed, failed };
  } catch (err) {
    return failure(err);
  }
}
