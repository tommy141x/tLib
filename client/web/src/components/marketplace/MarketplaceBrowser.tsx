/**
 * The marketplace BODY: toolbar, category tabs, card grid, pagination, preview
 * and the install/uninstall/inspect machinery. Everything except the chrome it
 * is mounted in.
 *
 * This exists because the browser has two mounts, and only one of them is a
 * modal:
 *
 * - `components/MarketplacePanel.tsx` wraps it in `.mp-backdrop` + `.mp-panel`
 *   and is what `exports.tLib:OpenMarketplace` opens. tRadio's in-game path
 *   still uses that.
 * - `components/Dialog.tsx` mounts it INSIDE a dialog tab panel, for a tab
 *   declared `view: "marketplace"`. That is the integrated path: `/tdet` and
 *   `/tradar` open a dialog, and the Marketplace tab has to live in that same
 *   dialog rather than close it and throw a second overlay on top.
 *
 * So nothing here may render a backdrop, a modal surface, or a second focus
 * trap. The host owns those. It also may not close itself — `onEscape` hands
 * the key back to whichever host is mounting it, because "Escape" means
 * "dismiss the modal" in one and "dismiss the dialog" in the other.
 *
 * Why browse/preview/install all go through Lua rather than a direct fetch is
 * explained in `@tlib/shared/marketplace/ui` (`browse.ts`) and in
 * `client/cl_marketplace.lua`: CEF's origin is `cfx-nui-tLib` and the
 * marketplace host sends no Access-Control-Allow-Origin.
 */

import type { JSX } from "@solidjs/web";
import { createEscapeLayer } from "@tlib/shared/escape-layer";
import { localInstallKind } from "@tlib/shared/marketplace/local-name";
import {
  browseMarketplace,
  ErrorPane,
  type InspectionRequest,
  type InspectionState,
  type InstalledSound,
  InstalledTab,
  type InstallState,
  ItemCard,
  inspectableIdentity,
  isBuiltin,
  likeMarketplaceItem,
  type MarketplaceItem,
  matchesInspectionReply,
  type OpenData,
  PreviewOverlay,
  patchInstalledNames,
  summarizeInspection,
} from "@tlib/shared/marketplace/ui";
// See the note on the Lucide imports in `../MarketplacePanel.tsx`: the package
// form in an app, `~icons/lucide` in `shared/ts/**`, and nothing mixed.
import IconLoaderCircle from "lucide-solid/icons/loader-circle";
import IconSearch from "lucide-solid/icons/search";
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { fetchNui, onNuiEvent } from "@/lib/nui";
import { NuiButton } from "../ui/nui-field";
import { MarketplaceSort } from "./MarketplaceSort";

let inspectionSequence = 0;

export interface MarketplaceBrowserProps {
  /** The open payload. `null` means nothing has been provided yet. */
  data: OpenData | null;
  /**
   * Whether this mount is visible and allowed to issue requests. Going false
   * aborts anything in flight; going true again re-applies `data` from scratch,
   * so leaving and returning to the tab re-browses rather than showing a stale
   * page.
   *
   * NEITHER FIRST-PARTY MOUNT EVER PASSES `false`, measured 2026-10-15, and the
   * reason is worth knowing before relying on this: both of them tie `active` to
   * the very condition that MOUNTS the component. `MarketplacePanel` passes
   * `active={open()}` inside `Show when={open()}`, and `Dialog.tsx` passes
   * `active={props.open}` inside a branch that renders only while the marketplace
   * tab is selected. So this path is correct and untested — a host that wants to
   * HIDE the browser rather than unmount it is what it is for, and that is a
   * host worth having, because unmounting is what loses an install result (see
   * the ledger in `@tlib/shared/marketplace/ui`).
   */
  active: boolean;
  /** Chrome rendered at the start of the header row (the modal's title). */
  header?: JSX.Element;
  /** Chrome rendered at the end of the header row (the modal's close button). */
  headerActions?: JSX.Element;
  /** Escape pressed with no preview open. A preview is always dismissed here first. */
  onEscape?: () => void;
  /** Extra classes on the root, e.g. `mp-embed`. */
  class?: string;
}

export function MarketplaceBrowser(props: MarketplaceBrowserProps) {
  const [tab, setTab] = createSignal<"uis" | "sounds" | "installed">("uis");
  const [resourceFilter, setResourceFilter] = createSignal<string | null>(null);
  const [baseUrl, setBaseUrl] = createSignal<string>("");
  const [search, setSearch] = createSignal("");
  const [items, setItems] = createSignal<MarketplaceItem[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [operationError, setOperationError] = createSignal<string | null>(null);
  const [installStates, setInstallStates] = createSignal<Record<string, InstallState>>({});
  const [installedLayouts, setInstalledLayouts] = createSignal<string[]>([]);
  const [installedSounds, setInstalledSounds] = createSignal<InstalledSound[]>([]);
  const [sort, setSort] = createSignal<"downloads" | "created_at">("downloads");
  const [installedMarketplaceItems, setInstalledMarketplaceItems] = createSignal<MarketplaceItem[]>(
    []
  );
  const [installedLoading, setInstalledLoading] = createSignal(false);
  const [previewItem, setPreviewItem] = createSignal<MarketplaceItem | null>(null);
  const [previewFn, setPreviewFn] = createSignal<string | null>(null);
  const [previewState, setPreviewState] = createSignal<Record<string, unknown> | null>(null);
  const [panelPreviewUrl, setPanelPreviewUrl] = createSignal<string | null>(null);

  /**
   * Slugs with a like round trip in flight, so the heart can say so and cannot
   * be double-pressed into two outbound requests.
   *
   * A SET OF SLUGS AND NOT ONE BOOLEAN. The grid renders a whole page of
   * cards; a single flag would disable every heart on the page while one of them
   * was waiting.
   */
  const [likePending, setLikePending] = createSignal<Record<string, true>>({});

  const [inspection, setInspection] = createSignal<InspectionState | null>(null);
  let inspectionTimeout: number | undefined;
  function clearInspection() {
    window.clearTimeout(inspectionTimeout);
    inspectionTimeout = undefined;
    setInspection(null);
  }

  function inspectInstallation(type: "ui" | "sound", slug: string, name: string) {
    const resource = resourceFilter();
    if (
      !props.active ||
      tab() !== "installed" ||
      inspection()?.state === "loading" ||
      !inspectableIdentity(resource, slug)
    )
      return;
    clearInspection();
    const request: InspectionRequest = {
      resource: resource!,
      type,
      slug,
      requestId: `mp-${Date.now().toString(36)}-${++inspectionSequence}`,
    };
    setInspection({ state: "loading", request, name });
    const fail = () => {
      const active = inspection();
      if (active?.request.requestId === request.requestId && active.state === "loading") {
        window.clearTimeout(inspectionTimeout);
        setInspection({ state: "error", request, name });
      }
    };
    inspectionTimeout = window.setTimeout(fail, 15000);
    void fetchNui("marketplaceInspect", request).then((ack) => {
      if (ack === null) fail();
    });
  }

  function inspectionBlocks(type: "ui" | "sound", slug: string) {
    const active = inspection();
    return (
      active?.request.type === type &&
      active.request.slug === slug &&
      (active.state !== "ready" || active.summary.managementBlocked)
    );
  }

  let searchDebounce: number | null = null;
  let browseRequest = 0;
  let installedRequest = 0;
  let browseAbort: AbortController | undefined;
  const pageSize = 50;
  const [pageOffset, setPageOffset] = createSignal(0);
  const [hasNextPage, setHasNextPage] = createSignal(false);

  function invalidateRequests() {
    clearInspection();
    ++browseRequest;
    ++installedRequest;
    browseAbort?.abort();
    if (searchDebounce) window.clearTimeout(searchDebounce);
    searchDebounce = null;
  }

  function setInstallState(slug: string, next: InstallState) {
    setInstallStates((prev) => ({ ...prev, [slug]: next }));
  }

  async function fetchItems(offset = 0) {
    const base = baseUrl();
    if (!base || !props.active) {
      // Kept after `handleSearchInput` stopped pre-lighting the spinner: a tab
      // switch or a reopen can still bail here with `loading` already true, and
      // the grid would sit on "Loading items…" with nothing in flight.
      setLoading(false);
      return;
    }
    const request = ++browseRequest;
    browseAbort?.abort();
    const controller = new AbortController();
    browseAbort = controller;
    const timeout = window.setTimeout(() => controller.abort(), 15000);
    setPageOffset(offset);
    const shownAt = Date.now();
    setLoading(true);
    setError(null);
    try {
      const activeTab = tab();
      const page = await browseMarketplace(
        {
          type: activeTab === "uis" ? "ui" : activeTab === "sounds" ? "sound" : undefined,
          resource: resourceFilter() ?? undefined,
          search: search() || undefined,
          sort: sort(),
          limit: pageSize,
          cursor: offset,
        },
        controller.signal
      );
      if (request !== browseRequest) return;
      setItems(page.items);
      // The server reports this now. Previously it was inferred from a full
      // page, which claimed a next page whenever the catalogue happened to be
      // an exact multiple of the page size.
      setHasNextPage(page.hasMore);
    } catch (e) {
      if (request !== browseRequest) return;
      setError(
        controller.signal.aborted
          ? "Marketplace request timed out"
          : e instanceof Error
            ? e.message
            : String(e)
      );
      setItems([]);
      setHasNextPage(false);
    } finally {
      window.clearTimeout(timeout);
      // A MINIMUM VISIBLE TIME, not a delay before showing. A spinner that
      // appears and vanishes inside ~100ms reads as a glitch rather than as
      // work, which is worse than never having shown one. The request is
      // already finished and the data already applied; only the indicator
      // waits, so nothing is slower than it was.
      const held = Math.max(0, 300 - (Date.now() - shownAt));
      const settle = () => {
        if (request === browseRequest) setLoading(false);
      };
      if (held === 0) settle();
      else window.setTimeout(settle, held);
    }
  }

  /**
   * The whole catalogue for one type, paged.
   *
   * ONE REQUEST USED TO BE THE WHOLE IMPLEMENTATION, at `limit: 100`, which is
   * also the server's clamp. Past the hundredth item of a type, an installed
   * layout got no catalogue entry: the Installed tab then showed it by its bare
   * directory name with no creator, no size and no Reinstall, and nothing said
   * why. Silent, and it gets worse with every item published.
   *
   * Sequential WITHIN a type and parallel ACROSS the two, which keeps at most two
   * requests outstanding against `READ_MAX_IN_FLIGHT = 3` in
   * `server/sv_marketplace.lua`. Paging both types concurrently would make that
   * budget a function of catalogue size and start getting "too many marketplace
   * requests in flight" refusals.
   *
   * `MAX_PAGES` is a stop, not a size estimate: an open panel must not be able to
   * issue unbounded outbound requests from the game server, and a cursor that
   * failed to advance would otherwise loop forever. Both are guarded — the cursor
   * check below is load-bearing because `nextCursor` is taken from the wire
   * whenever it is a number.
   *
   * A mid-sequence failure keeps the pages that DID arrive rather than discarding
   * them: a partial catalogue names most of the rows, where an empty one names
   * none.
   */
  async function catalogueForType(
    type: "ui" | "sound",
    resource: string | undefined,
    request: number
  ): Promise<MarketplaceItem[]> {
    const PAGE_SIZE = 100;
    const MAX_PAGES = 10;
    const items: MarketplaceItem[] = [];
    let cursor = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      let result: Awaited<ReturnType<typeof browseMarketplace>>;
      try {
        result = await browseMarketplace({ type, resource, limit: PAGE_SIZE, cursor });
      } catch {
        break;
      }
      if (request !== installedRequest) break;
      items.push(...result.items);
      if (!result.hasMore || result.items.length === 0) break;
      const next = result.nextCursor > cursor ? result.nextCursor : cursor + result.items.length;
      if (next <= cursor) break;
      cursor = next;
    }
    return items;
  }

  async function fetchInstalledItems() {
    const base = baseUrl();
    if (!base) return;
    const request = ++installedRequest;
    setInstalledLoading(true);
    try {
      const resource = resourceFilter() ?? undefined;
      // Two sequences rather than one unfiltered one: the Installed tab matches
      // catalogue entries to what is on disk by slug, and a `ui` and a `sound`
      // may share one. The per-request cap is per TYPE, so merging them would
      // halve what either can carry within a page.
      const pages = await Promise.all(
        (["ui", "sound"] as const).map((type) => catalogueForType(type, resource, request))
      );
      if (request === installedRequest) setInstalledMarketplaceItems(pages.flat());
      // No `catch`: `catalogueForType` handles the only fallible call and answers
      // with the pages it got. `finally` is what guarantees the spinner clears.
    } finally {
      if (request === installedRequest) setInstalledLoading(false);
    }
  }

  function applyOpenData(data: OpenData) {
    invalidateRequests();
    setBaseUrl(data.baseUrl);
    setResourceFilter(data.resource ?? null);
    setSearch("");
    setOperationError(null);
    setSort("downloads");
    setTab(data.initialTab ?? "uis");
    // THE HOST'S SNAPSHOT, PATCHED WITH WHAT THIS SESSION WATCHED HAPPEN.
    //
    // `data` is sent once per open and the signal holding it keeps that object,
    // so re-applying it after an unmount re-applies a `readdir` from before any
    // install this session performed. `patchInstalledNames` is the correction —
    // see the ledger's header in `@tlib/shared/marketplace/ui`. Without it,
    // leaving the Marketplace tab and coming back offered Install for an item
    // already on disk, which is the report `../local-name.ts` exists to answer.
    setInstalledLayouts(patchInstalledNames(data.installedLayouts ?? [], "ui"));
    const sounds = data.installedSounds ?? [];
    const soundNames = patchInstalledNames(
      sounds.map((entry) => entry.slug),
      "sound"
    );
    const bySlug = new Map(sounds.map((entry) => [entry.slug, entry]));
    setInstalledSounds(soundNames.map((slug) => bySlug.get(slug) ?? { slug, filename: slug }));
    setInstalledMarketplaceItems([]);
    setPreviewItem(null);
    setPreviewFn(data.previewFn ?? null);
    setPreviewState(data.previewState ?? null);
    setPanelPreviewUrl(data.panelPreviewUrl ?? null);
    // Cleared with the rest of the per-session state. A like whose round trip
    // was still out when the panel was re-fed left its slug in here, so the
    // heart on the re-rendered card came back already spinning and disabled —
    // until the old promise settled, which is up to the 25s reply timeout.
    setLikePending({});

    /**
     * SOUND SLUGS ONLY NOW REACH THIS SEED, and a layout's state is DERIVED
     * instead — see `itemInstallState` below.
     *
     * This record is keyed by MARKETPLACE SLUG: every write to it
     * (`handleInstall`, both NUI result handlers, `handleUninstallBySlug`) and
     * every read of it (`installStates()[item.slug]`) uses a slug. The seed was
     * the one place feeding it something else — `installedSlugs` used to carry
     * layout FOLDER NAMES, so the keys `QRX-720` and the lookups
     * `tradio-qrx-720` never met and all eleven shipped radio heads offered
     * Install for something already on disk. `client.lua` no longer sends them,
     * so the two keyspaces that were sharing this object are now one.
     */
    const seed: Record<string, InstallState> = {};
    for (const slug of patchInstalledNames(data.installedSlugs ?? [], "sound")) {
      seed[slug] = { state: "installed" };
    }
    setInstallStates(seed);

    if (tab() === "installed") void fetchInstalledItems();
    else void fetchItems();
  }

  // The only entry point. `applied` is identity, not a deep compare: every
  // payload arrives as a fresh object off an NUI message, and a host that
  // re-sends the same object means "nothing changed".
  let applied: OpenData | null = null;
  // The two-argument form replaces the `untrack` that used to wrap the body:
  // in Solid 2 only `compute` tracks, so the resets below — which write most of
  // the signals in this component — cannot re-trigger this effect, and the
  // phase split states that rather than relying on a wrapper to enforce it.
  createEffect(
    () => ({ data: props.data, active: props.active }),
    ({ data, active }) => {
      if (!active || !data) {
        if (applied) {
          applied = null;
          invalidateRequests();
          setPreviewItem(null);
        }
        return;
      }
      if (data === applied) return;
      applied = data;
      applyOpenData(data);
    }
  );

  onCleanup(
    onNuiEvent<unknown>("marketplaceInspectResult", (data) => {
      const active = inspection();
      if (
        !props.active ||
        tab() !== "installed" ||
        !active ||
        active.state !== "loading" ||
        !matchesInspectionReply(active.request, data)
      )
        return;
      window.clearTimeout(inspectionTimeout);
      inspectionTimeout = undefined;
      const summary = data.ok ? summarizeInspection(data.inspection, active.request) : null;
      setInspection(
        summary ? { ...active, state: "ready", summary } : { ...active, state: "error" }
      );
    })
  );

  onCleanup(
    onNuiEvent<{ ok: boolean; slug: string; error?: string; resource?: string; type?: string }>(
      "marketplaceInstallResult",
      (data) => {
        if (!data || typeof data.slug !== "string" || !props.active) return;
        if (data.resource && data.resource !== resourceFilter()) return;
        clearInspection();
        // Off the WIRE. `server/sv_marketplace.lua`'s `reply` has always carried
        // `type = p.itemType`; this component kept its own `pendingInstallTypes`
        // side-table to remember what it had asked for, which duplicated a field
        // already on the payload and could not survive the unmount the ledger in
        // `@tlib/shared/marketplace/ui` now covers.
        const type = data.type;
        if (data.ok) {
          setInstallState(data.slug, { state: "installed" });
          if (type === "ui") {
            setInstalledLayouts((prev) => (prev.includes(data.slug) ? prev : [...prev, data.slug]));
          } else if (type === "sound") {
            setInstalledSounds((prev) =>
              prev.some((s) => s.slug === data.slug)
                ? prev
                : [...prev, { slug: data.slug, filename: data.slug }]
            );
          }
        } else {
          setInstallState(data.slug, { state: "done", ok: false, error: data.error });
        }
      }
    )
  );

  onCleanup(
    onNuiEvent<{ ok: boolean; slug: string; error?: string; resource?: string }>(
      "marketplaceUninstallResult",
      (data) => {
        if (!data || typeof data.slug !== "string" || !props.active) return;
        if (data.resource && data.resource !== resourceFilter()) return;
        clearInspection();
        if (data.ok) {
          setInstallState(data.slug, { state: "idle" });
          setInstalledLayouts((prev) => prev.filter((l) => l !== data.slug));
          setInstalledSounds((prev) => prev.filter((s) => s.slug !== data.slug));
        } else {
          setInstallState(data.slug, { state: "installed" });
          setOperationError(data.error ?? "Could not uninstall this item");
        }
      }
    )
  );

  function handleSearchInput(value: string) {
    invalidateRequests();
    setSearch(value.slice(0, 200));
    // NO `setLoading(true)` HERE, AND THAT IS THE FIX. It used to fire on the
    // keystroke, 250ms before the request it was reporting even started, and the
    // grid is swapped wholesale for a centred spinner while `loading` is true —
    // so every character typed replaced the results with a spinner and back. The
    // debounce below is already the show-delay the spinner wanted.
    searchDebounce = window.setTimeout(() => void fetchItems(), 250);
  }

  function handleTabSwitch(next: "uis" | "sounds" | "installed") {
    const prev = tab();
    if (next === prev) return;
    invalidateRequests();
    setPreviewItem(null);
    setTab(next);
    if (next === "installed") {
      void fetchInstalledItems();
    } else {
      void fetchItems();
    }
  }

  /**
   * What this catalogue item's state is, taking an operation in flight first and
   * falling back to what is on disk.
   *
   * Why the layout answer is DERIVED and not seeded
   *
   * Because the two sides are named differently and only one of them is a slug.
   * `installedLayouts` is `readdir(layouts/)` — `QRX-720` — and `item.slug` is
   * product-namespaced and lowercased — `tradio-qrx-720`. A seeded record can
   * only hold one spelling, which is how every shipped layout came to read as
   * not-installed. `localInstallKind` compares both spellings and, crucially,
   * reports WHICH matched:
   *
   *   · `"managed"`  — the name IS the install target (`installFromData` is
   *                    handed the raw slug), so Delete can address it.
   *   · `"builtin"`  — only the prefix-stripped spelling is on disk, which the
   *                    installer never writes. The consumer shipped it: present,
   *                    and not removable by us. Neither Install nor Delete.
   *
   * SOUNDS ARE NOT DERIVED, deliberately. Their installed records are written
   * by `marketplace.upsertSound` from the catalogue slug, so the seed's key and
   * `item.slug` are the same string by construction and there is no second
   * naming to reconcile. Running them through the same match would invent the
   * possibility of a prefix-stripped sound directory that nothing creates.
   */
  function itemInstallState(item: MarketplaceItem): InstallState {
    const operation = installStates()[item.slug];
    if (operation) return operation;
    if (item.type === "ui") {
      const kind = localInstallKind(item, installedLayouts());
      if (kind === "builtin") return { state: "builtin" };
      if (kind === "managed") return { state: "installed" };
    }
    return { state: "idle" };
  }

  function handleInstall(item: MarketplaceItem) {
    // Defence in depth only: `canInstall` already removes the control, and
    // `ItemCard`/`PreviewOverlay` drop the handler outright for a built-in. This
    // is here because a reinstall writes `layouts/<raw slug>/` BESIDE the
    // shipped directory rather than over it, and a duplicate is not something a
    // later refactor should be able to reintroduce by re-enabling one button.
    if (isBuiltin(itemInstallState(item))) return;
    if ((item.type === "ui" || item.type === "sound") && inspectionBlocks(item.type, item.slug))
      return;
    clearInspection();
    const current = installStates()[item.slug]?.state;
    if (current === "installing" || current === "uninstalling") return;
    setInstallState(item.slug, { state: "installing" });
    void fetchNui("marketplaceInstall", {
      type: item.type,
      slug: item.slug,
      version: item.current_version,
      resource: resourceFilter() ?? "",
    });
  }

  function handleUninstall(item: MarketplaceItem) {
    // Same defence in depth, and the more important of the two: the uninstaller
    // addresses `<installPath>/<raw slug>` and requires an ownership receipt
    // beside it, so a Delete on a shipped built-in can only come back
    // `"tradio-qrx-720" is not installed`.
    if (isBuiltin(itemInstallState(item))) return;
    const current = installStates()[item.slug]?.state;
    if (current === "installing" || current === "uninstalling") return;
    setInstallState(item.slug, { state: "uninstalling" });
    void fetchNui("marketplaceUninstall", {
      type: item.type,
      slug: item.slug,
      resource: resourceFilter() ?? "",
    });
  }

  /**
   * Toggle this player's like on one item.
   *
   * NO OPTIMISTIC UPDATE, DELIBERATELY
   *
   * The count and the filled state are both replaced only with what the SERVER
   * answers. An optimistic ±1 would be wrong in two ways that both show:
   *
   *   · The authoritative count may have moved for other reasons — somebody else
   *     liked it a moment ago — so the server's number is more current rather
   *     than merely safer.
   *   · The write is idempotent by design. A second like writes nothing and
   *     answers the SAME count, so an optimistic increment would paint a number
   *     the next browse silently contradicts.
   *
   * The pending flag is what covers the latency instead, which is honest about
   * the fact that the answer is not in yet. Same reasoning the roadmap vote seam
   * records: reconcile against the server rather than keeping your own ±1.
   */
  function handleLike(item: MarketplaceItem, next: boolean) {
    if (likePending()[item.slug]) return;
    setLikePending((prev) => ({ ...prev, [item.slug]: true }));
    setOperationError(null);
    void likeMarketplaceItem(item.slug, next).then(
      (state) => {
        setLikePending((prev) => {
          const { [item.slug]: _done, ...rest } = prev;
          return rest;
        });
        // Patched by SLUG into whatever the list currently holds, rather than
        // by index or by re-fetching the page. The player may have paged or
        // changed the search while the round trip was out, in which case the
        // item is simply no longer there and `map` leaves the list alone — where
        // an index write would corrupt a different card and a re-fetch would
        // throw away a scroll position for one number.
        const patch = (list: MarketplaceItem[]) =>
          list.map((entry) =>
            entry.slug === item.slug ? { ...entry, likes: state.likes, liked: state.liked } : entry
          );
        setItems(patch);
        setInstalledMarketplaceItems(patch);
      },
      (e: unknown) => {
        setLikePending((prev) => {
          const { [item.slug]: _done, ...rest } = prev;
          return rest;
        });
        // The host's own sentence, not a generic one. The marketplace words
        // its refusals to be shown to a person — "A game server may only like as
        // a FiveM license…" is more use to whoever is looking at it than
        // "request failed", and the rate-limit refusal names the wait.
        setOperationError(e instanceof Error ? e.message : "Could not like this item");
      }
    );
  }

  function handleUninstallBySlug(type: "ui" | "sound", slug: string) {
    if (inspectionBlocks(type, slug)) return;
    clearInspection();
    const current = installStates()[slug]?.state;
    if (current === "installing" || current === "uninstalling") return;
    setInstallState(slug, { state: "uninstalling" });
    void fetchNui("marketplaceUninstall", { type, slug, resource: resourceFilter() ?? "" });
  }

  // A preview is dismissed in BOTH mounts, because it is this component's own
  // layer — that is what `onInternal` means. Only the outer Escape — nothing
  // open, dismiss the host — differs, and that is `onEscape`'s whole job. The
  // embedded mount passes none, so the key falls through to the dialog and
  // closes it, exactly as on any other tab.
  //
  // `depth: 1` puts this above a host that registers its own layer at 0, and
  // `active` is why the registry has that option at all: this component has two
  // mounts and the one on an unselected dialog tab must not shadow the dialog.
  //
  // `active` also requires there to be something to do. Owning the key and then
  // doing nothing is not the same as not owning it: the embedded mount passes no
  // `onEscape`, and if this layer claimed the press anyway the dialog would stop
  // closing on Escape while the Marketplace tab was open.
  const disposeEscapeLayer = createEscapeLayer({
    label: "marketplace-browser",
    depth: 1,
    active: () => props.active && (previewItem() !== null || props.onEscape !== undefined),
    onInternal: () => {
      if (!previewItem()) return false;
      setPreviewItem(null);
      return true;
    },
    onEscape: () => props.onEscape?.(),
  });
  onCleanup(() => {
    disposeEscapeLayer();
    invalidateRequests();
  });

  const isBrowseTab = () => tab() === "uis" || tab() === "sounds";

  return (
    <div class={`mp-root ${props.class ?? ""}`}>
      <div class="mp-header">
        {props.header}

        <Show when={isBrowseTab() && !previewItem()}>
          <div class="mp-toolbar">
            <div class="mp-search">
              <IconSearch class="mp-search-icon" />
              <input
                type="search"
                class="tlib-nui-control tlib-nui-input"
                aria-label="Search marketplace items"
                placeholder="Search items…"
                value={search()}
                onInput={(e) => handleSearchInput(e.currentTarget.value)}
              />
            </div>
            <MarketplaceSort
              value={sort()}
              onChange={(value) => {
                invalidateRequests();
                setSort(value);
                void fetchItems();
              }}
            />
          </div>
        </Show>

        {props.headerActions}
      </div>

      <div class="mp-tabs" aria-label="Marketplace category">
        {(["uis", "sounds", "installed"] as const).map((t) => (
          <NuiButton
            class="mp-tab"
            aria-pressed={tab() === t ? "true" : "false"}
            onClick={() => handleTabSwitch(t)}
          >
            {t === "uis" ? "UIs" : t === "sounds" ? "Sounds" : "Installed"}
          </NuiButton>
        ))}
      </div>

      <Show when={operationError()}>
        <div role="alert" class="mp-error-banner">
          <span>{operationError()}</span>
          <NuiButton onClick={() => setOperationError(null)}>Dismiss</NuiButton>
        </div>
      </Show>

      <div class="flex-1 min-h-0 relative overflow-hidden">
        <Show when={tab() === "installed"}>
          <div class="absolute inset-0 overflow-y-auto settings-scroll p-3">
            <InstalledTab
              marketplaceItems={installedMarketplaceItems()}
              installedLayouts={installedLayouts()}
              installedSounds={installedSounds()}
              installStates={installStates()}
              loading={installedLoading()}
              resource={resourceFilter()}
              inspection={inspection()}
              onInspect={inspectInstallation}
              onInstall={handleInstall}
              onUninstallBySlug={handleUninstallBySlug}
            />
          </div>
        </Show>

        <Show when={isBrowseTab()}>
          <Show
            when={previewItem()}
            fallback={
              <div class="absolute inset-0 overflow-y-auto settings-scroll p-3">
                <Show
                  when={!loading()}
                  fallback={
                    <div role="status" aria-label="Loading marketplace" class="mp-empty">
                      <IconLoaderCircle class="w-4 h-4 animate-spin" />
                      <span role="status">Loading items…</span>
                    </div>
                  }
                >
                  <Show when={!error()} fallback={<ErrorPane message={error() as string} />}>
                    <Show
                      when={items().length > 0}
                      fallback={
                        <div role="status" class="mp-empty">
                          No items found.
                        </div>
                      }
                    >
                      <div class="mp-grid">
                        <For each={items()}>
                          {(item) => (
                            <ItemCard
                              item={item}
                              installState={itemInstallState(item)}
                              onInstall={() => handleInstall(item)}
                              onUninstall={() => handleUninstall(item)}
                              onPreview={() => setPreviewItem(item)}
                              onLike={(next) => handleLike(item, next)}
                              likePending={likePending()[item.slug] === true}
                            />
                          )}
                        </For>
                      </div>
                    </Show>
                  </Show>
                  <div class="mp-pagination" aria-label="Marketplace pages">
                    <NuiButton
                      disabled={pageOffset() === 0}
                      onClick={() => void fetchItems(Math.max(0, pageOffset() - pageSize))}
                      class="mp-action"
                    >
                      Previous page
                    </NuiButton>
                    <span>Page {Math.floor(pageOffset() / pageSize) + 1}</span>
                    <NuiButton
                      disabled={!hasNextPage()}
                      onClick={() => void fetchItems(pageOffset() + pageSize)}
                      class="mp-action"
                    >
                      Next page
                    </NuiButton>
                    <Show when={error()}>
                      <NuiButton onClick={() => void fetchItems(pageOffset())} class="mp-action">
                        Retry
                      </NuiButton>
                    </Show>
                  </div>
                </Show>
              </div>
            }
          >
            {(item) => (
              <PreviewOverlay
                item={item()}
                baseUrl={baseUrl()}
                installState={itemInstallState(item())}
                onClose={() => setPreviewItem(null)}
                onInstall={() => handleInstall(item())}
                onUninstall={() => handleUninstall(item())}
                previewFn={previewFn()}
                previewState={previewState()}
                panelPreviewUrl={panelPreviewUrl()}
              />
            )}
          </Show>
        </Show>
      </div>
    </div>
  );
}
