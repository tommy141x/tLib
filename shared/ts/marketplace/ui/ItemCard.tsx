import { For, Match, Show, Switch } from "solid-js";
import IconDownload from "~icons/lucide/download";
import IconEye from "~icons/lucide/eye";
import IconHeart from "~icons/lucide/heart";
import IconLoaderCircle from "~icons/lucide/loader-circle";
import IconPlay from "~icons/lucide/play";
import IconTrash2 from "~icons/lucide/trash-2";
import { NuiButton } from "../../nui-kit/NuiButton";
import {
  CARD_COPY,
  cardIdentity,
  cardStats,
  likeAffordance,
  nextLikedState,
} from "../card-model";
import {
  INSTALL_ACTION_LABEL,
  installAction,
  installError,
  isInstallBusy,
  isInstalled,
} from "../install-machine";
import { InstallError } from "./InstallError";
import { formatBytes, type InstallState, type MarketplaceItem } from "./types";

export function ItemCard(props: {
  item: MarketplaceItem;
  installState: InstallState;
  onInstall: () => void;
  onUninstall: () => void;
  onPreview: () => void;
  /**
   * Toggle this player's like, or `undefined` if this host cannot.
   *
   * ⚠️ OPTIONAL ON PURPOSE, AND THE COUNT DOES NOT DEPEND ON IT. Every surface
   * shows the number; only a surface that can establish WHO is asking gets the
   * button. A host that has no player identity in hand — a web preview, a staff
   * tool, a panel reached before the server answered — passes nothing and the
   * card renders a plain count.
   *
   * The argument is the state being asked FOR, not a toggle, so a caller that
   * retries after a timeout cannot invert anything.
   */
  onLike?: (next: boolean) => void;
  /** True while a like round trip is in flight, so the control can say so. */
  likePending?: boolean;
}) {
  const s = () => props.installState;
  // All four derived from `../install-machine`, which is also where the overlay
  // and the Installed tab read them from. The `installError` fallback used to
  // differ between this file and `InstallError.tsx`, so one item could word its
  // own failure two ways depending on which surface you were looking at.
  const errorMessage = () => installError(s());
  const busy = () => isInstallBusy(s());
  const installed = () => isInstalled(s());
  const installLabel = () => INSTALL_ACTION_LABEL[installAction(s())];

  // ── The card's content, from `../card-model` ───────────────────────────────
  //
  // This file used to BE the second definition of a card — tRadio's panel read
  // `cardStats` while this one re-derived the same facts inline, which is the
  // "shared module with one consumer" state that makes a contract look settled
  // without being tested by anything but itself. The identity, the stats, the
  // like affordance, the next-liked state and the default copy all come from
  // there now, so "does my card match" is a question with one answer.
  //
  // ⚠️ This is a REFACTOR and the rendered output is unchanged. The one place
  // the shared contract disagrees with what this card has always drawn is
  // `size`, which is argued at its call site below rather than quietly adopted.
  const identity = () => cardIdentity(props.item);
  /**
   * ⚠️ `size` is dropped from the stats ROW, not from the card: this layout has
   * always put it top-right, opposite the name, and `cardStats` describes which
   * facts a card shows and in what order — not where a host places them. Same
   * omission, for the same reason, as tRadio's panel.
   */
  const stats = () => cardStats(props.item).filter((stat) => stat.key !== "size");
  /**
   * `props.onLike !== undefined` is this surface's answer to "can we establish
   * who is asking". Presence, not truthiness, because a handler is a function
   * and a function is always truthy — but reading it as `!!props.onLike` would
   * invite someone to pass `null` and get a silently different answer.
   */
  const like = () => likeAffordance(props.item, props.onLike !== undefined);

  return (
    <div class="mp-card">
      <div class="flex items-start justify-between gap-2">
        <div class="flex flex-col min-w-0">
          <span class="text-sm font-semibold mp-fg truncate">{identity().name}</span>
          <span class="text-sm mp-muted truncate">
            by {identity().creator}
            {identity().version ? ` · v${identity().version}` : ""}
          </span>
        </div>
        {/*
          ⚠️ `props.item.size_bytes` directly and NOT the `size` entry from
          `cardStats`, which is a measured divergence rather than an oversight.
          `cardStats` omits `size` at zero — correct for a stats row, where a
          "0B" chip is noise — and this slot has always printed `formatBytes`
          unconditionally. Taking the value from the array would therefore blank
          this corner for any item the catalogue reports no size for, which is a
          rendered change, and this pass is a refactor. The FORMATTING is shared
          either way: `formatBytes` is the one in `./types` that every surface
          already uses.
        */}
        <span class="text-sm mp-muted shrink-0">{formatBytes(props.item.size_bytes)}</span>
      </div>

      <Show when={identity().description}>
        <p class="text-sm mp-muted line-clamp-2">{identity().description}</p>
      </Show>

      <InstallError state={s()} />

      <div class="mp-card-footer">
        {/*
          ⚠️ `mp-card-stats` IS REQUIRED, not decoration. `marketplace.css` has
          `.mp-card-footer > div { margin-left: auto }` — written when the footer
          held one `<span>` and one `<div>` of buttons — so wrapping the stats in
          a second `div` would push BOTH groups to the right and leave the left
          edge empty. The class is what cancels it.
        */}
        <div class="mp-card-stats flex items-center gap-2 min-w-0">
          {/*
            ⚠️ RENDER THE ARRAY. `cardStats` being ORDERED is the whole point of
            it — three cards showed overlapping subsets of these facts in three
            orders, so "does my card match" was not a question anybody could
            answer. Walking the array is what makes the answer mechanical.

            The two rules that used to be spelled out here, `downloads` printed
            at zero and `likes` gated on PRESENCE rather than truthiness, now
            live in `cardStats` and are asserted in
            `tests/unit/marketplace-card-contract.test.ts`. They are not
            restated: a rule written in two places is a rule that can disagree
            with itself, which is how the download count came to show on this
            surface and not on tRadio's.
          */}
          <For each={stats()}>
            {(stat) => (
              <Switch>
                <Match when={stat.key === "downloads"}>
                  {/*
                    `CARD_COPY` and not a literal. This surface is English-only
                    — every string in `ui/` is a literal — so it takes the
                    default copy; tRadio runs the same `CardStatKey` through
                    `t()` instead and must not import this. The split is
                    deliberate and is the same one `install-machine` makes
                    between `installAction` and `INSTALL_ACTION_LABEL`.
                  */}
                  <span class="text-sm mp-muted">
                    {CARD_COPY.downloads(String(stat.value))}
                  </span>
                </Match>

                <Match when={stat.key === "likes"}>
                  {/*
                    ⚠️ TWO RENDERINGS OF ONE NUMBER, and `likeAffordance` is
                    what decides which — a BUTTON only when this surface can
                    say who is asking AND the wire told us this player's state,
                    a plain COUNT otherwise. "Never a control that cannot
                    succeed" is the rule, and its reasoning now lives on
                    `likeAffordance` rather than in this file.

                    `"none"` cannot reach here by construction: it and
                    `cardStats` gate on the identical `likes !== undefined`, so
                    an affordance of `"none"` means there is no `likes` entry in
                    the array to iterate. The fallback is therefore the `"count"`
                    branch and not a third state.
                  */}
                  <Show
                    when={like() === "button"}
                    fallback={
                      <span class="text-sm mp-muted flex items-center gap-1">
                        <IconHeart class="w-3 h-3" />
                        {CARD_COPY.likes(String(stat.value))}
                      </span>
                    }
                  >
                    <NuiButton
                      class="mp-action mp-like"
                      aria-label={props.item.liked ? "Remove your like" : "Like this item"}
                      // ⚠️ `aria-pressed` and not a visual-only state. This is a
                      // toggle, and the filled-versus-outline distinction is the
                      // only thing a sighted user has; a screen reader needs the
                      // attribute. A real string, not a boolean — under Solid 2
                      // `aria-pressed={true}` serialises to the empty string.
                      aria-pressed={props.item.liked ? "true" : "false"}
                      aria-busy={props.likePending ? "true" : "false"}
                      disabled={props.likePending}
                      // ⚠️ `nextLikedState` — the state being asked FOR, rather
                      // than a bare "toggle" — so the handler is idempotent on
                      // retry. That matters because the round trip is NUI → Lua
                      // → game server → HTTP and can time out with the write
                      // already committed.
                      onClick={() => props.onLike?.(nextLikedState(props.item))}
                      title={props.item.liked ? "You like this" : "Like this item"}
                    >
                      <Show
                        when={props.likePending}
                        fallback={
                          <IconHeart
                            class="w-3 h-3"
                            // ⚠️ `currentColor` fill rather than a `fill-*`
                            // utility class: this component ships into CEF 103
                            // NUI frames, a browser, and a Workers-rendered
                            // page, and the only colour contract it is allowed
                            // to use is the `--nui-*` layer that `currentColor`
                            // already resolves through.
                            fill={props.item.liked ? "currentColor" : "none"}
                          />
                        }
                      >
                        <IconLoaderCircle class="w-3 h-3 animate-spin" />
                      </Show>
                      {CARD_COPY.likes(String(stat.value))}
                    </NuiButton>
                  </Show>
                </Match>
              </Switch>
            )}
          </For>
        </div>

        <div class="flex items-center gap-1">
          <NuiButton
            class="mp-action"
            onClick={props.onPreview}
            title={props.item.type === "sound" ? "Play preview" : "Show preview"}
          >
            <Show when={props.item.type === "sound"} fallback={<IconEye class="w-3 h-3" />}>
              <IconPlay class="w-3 h-3 ml-px" />
            </Show>
          </NuiButton>

          <Show when={installed() || s().state === "uninstalling"}>
            <NuiButton
              class="mp-action mp-delete"
              aria-label="Delete from server"
              disabled={busy()}
              aria-busy={busy() ? "true" : "false"}
              onClick={props.onUninstall}
              title="Delete from server"
            >
              <Show when={s().state === "uninstalling"} fallback={<IconTrash2 class="w-3 h-3" />}>
                <IconLoaderCircle class="w-3 h-3 animate-spin" />
              </Show>
              <Show when={s().state === "uninstalling"}>Deleting…</Show>
            </NuiButton>
          </Show>

          <NuiButton
            class="mp-action"
            tone={s().state === "installed" ? "default" : "primary"}
            disabled={busy()}
            aria-busy={busy() ? "true" : "false"}
            onClick={props.onInstall}
            title={errorMessage()}
          >
            <Show when={s().state === "installing"} fallback={<IconDownload class="w-3 h-3" />}>
              <IconLoaderCircle class="w-3 h-3 animate-spin" />
            </Show>
            {installLabel()}
          </NuiButton>
        </div>
      </div>
    </div>
  );
}
