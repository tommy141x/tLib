/**
 * What this NUI session has WATCHED happen to an item on disk.
 *
 * THE DEFECT IT CLOSES.
 *
 * An install is a download plus a disk write, and its result comes back as an
 * event. Both of the browser's mounts UNMOUNT the component rather than hiding
 * it — `MarketplacePanel` wraps it in `Show when={open()}`, `Dialog.tsx` renders
 * it only while the marketplace tab is the active one. So closing the panel or
 * switching dialog tabs during an install disposed the component's own
 * `onNuiEvent` subscriptions and the result was delivered to nobody. The install
 * still landed — tLib logged it, the consumer's lifecycle handler fired — and the
 * admin was told nothing.
 *
 * On the way back in it got worse. A remounted browser re-applies the host's
 * ORIGINAL payload, because `marketplaceData`/`openMarketplace` is sent once per
 * open and the signal holding it still has that object. `installedLayouts` is a
 * `readdir` from before the install, so the item read as not-installed and
 * offered Install for something now on disk — the same report `../local-name.ts`
 * exists to answer, arriving by a different route.
 *
 * WHY A MODULE, AND WHY NOT A HOST REFRESH.
 *
 * THIS FILE IS THE SCOPE. A listener has to outlive the component to see a result
 * the component is not mounted for, and module scope is the only scope that does;
 * giving it a module of its own rather than a corner of `./browse.ts` is what
 * states that, and keeps that file's one concern the request/reply wrapper.
 *
 * The obvious alternative is a "re-send what is installed" callback each consumer
 * answers, and it is a new contract across four resources for a problem that is
 * entirely tLib's. The host's payload stays the snapshot it is; this is the patch
 * over it.
 *
 * Only CONFIRMED outcomes are recorded. A failed install changed nothing on disk,
 * and the card's own `done`/`retry` state is the one part that genuinely should
 * not survive a reopen. Never cleared, and bounded by construction: one slug and
 * one boolean per item an admin acted on, in one session.
 */

import { onNuiEvent } from "../../nui";

export interface InstallLedgerEntry {
  /** The item type the coordinator echoed back, e.g. `ui` or `sound`. */
  type: string;
  /** True after a confirmed install, false after a confirmed uninstall. */
  installed: boolean;
}

const ledger = new Map<string, InstallLedgerEntry>();

interface OutcomeReply {
  ok?: boolean;
  slug?: unknown;
  type?: unknown;
}

// Subscribed at module load, which is the whole point: a component-scoped
// listener is what was missing the result.
//
// `type` comes off the WIRE. `server/sv_marketplace.lua`'s `reply` has always
// carried `type = p.itemType`, so the side-table `MarketplaceBrowser` kept to
// remember what it had asked for was duplicating a field already on the payload —
// and a side-table in the component could not survive the unmount above.
for (const [event, installed] of [
  ["marketplaceInstallResult", true],
  ["marketplaceUninstallResult", false],
] as const) {
  onNuiEvent<OutcomeReply>(event, (data) => {
    if (!data || data.ok !== true) return;
    if (typeof data.slug !== "string" || !data.slug) return;
    // Keyed LOWERCASE, which is also the on-disk name: `context()` in
    // `../installer/core.ts` writes `slug.toLowerCase()`, and the coordinator's
    // `slugName` already refuses anything else. So the key, the lookup below and
    // the directory the installer created are one string rather than three that
    // happen to agree.
    ledger.set(data.slug.toLowerCase(), {
      type: typeof data.type === "string" ? data.type : "",
      installed,
    });
  });
}

/** This session's confirmed outcomes. Read-only; the writer is the listener above. */
export function installLedger(): ReadonlyMap<string, InstallLedgerEntry> {
  return ledger;
}

/**
 * A host's list of installed local NAMES, with this session's outcomes applied.
 *
 * Appending the SLUG is exact, not an approximation: `installFromData` is handed
 * the raw slug, so that is the only name the marketplace ever writes and the only
 * one `../local-name.ts` reports as `"managed"`. `type` narrows which outcomes
 * apply, because one directory can back more than one item type. The existing
 * names are folded case-insensitively — a shipped directory is whatever its
 * author typed, a slug is always lowercase.
 */
export function patchInstalledNames(names: readonly string[], type: string): string[] {
  if (ledger.size === 0) return [...names];
  const out = names.filter((name) => {
    const entry = ledger.get(name.toLowerCase());
    return !entry || entry.type !== type || entry.installed;
  });
  const present = new Set(out.map((name) => name.toLowerCase()));
  for (const [slug, entry] of ledger) {
    if (entry.type === type && entry.installed && !present.has(slug)) out.push(slug);
  }
  return out;
}

/** Reset the ledger. ITS CONSUMER IS THE TEST SUITE — see `clearPreviewCache`. */
export function clearInstallLedger(): void {
  ledger.clear();
}
