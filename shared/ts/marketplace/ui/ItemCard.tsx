import { Show } from "solid-js";
import IconDownload from "~icons/lucide/download";
import IconEye from "~icons/lucide/eye";
import IconHeart from "~icons/lucide/heart";
import IconLoaderCircle from "~icons/lucide/loader-circle";
import IconPlay from "~icons/lucide/play";
import IconTrash2 from "~icons/lucide/trash-2";
import { NuiButton } from "../../nui-kit/NuiButton";
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

  return (
    <div class="mp-card">
      <div class="flex items-start justify-between gap-2">
        <div class="flex flex-col min-w-0">
          <span class="text-sm font-semibold mp-fg truncate">{props.item.name}</span>
          <span class="text-sm mp-muted truncate">
            by {props.item.creator_name}
            {props.item.current_version ? ` · v${props.item.current_version}` : ""}
          </span>
        </div>
        <span class="text-sm mp-muted shrink-0">{formatBytes(props.item.size_bytes)}</span>
      </div>

      <Show when={props.item.description}>
        <p class="text-sm mp-muted line-clamp-2">{props.item.description}</p>
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
          <span class="text-sm mp-muted">{props.item.downloads} installs</span>

          {/*
            ⚠️ PRESENCE, NOT TRUTHINESS: `likes !== undefined`, because `0` is a
            real like count and `undefined` means this HOST does not have likes
            (an older or self-hosted backend). `item.ts` carries the full
            argument. A `Show when={props.item.likes}` would hide the count on
            every item nobody has liked yet, which is most of a new catalogue.
          */}
          <Show when={props.item.likes !== undefined}>
            {/*
              ⚠️ TWO RENDERINGS OF ONE NUMBER, and which one you get depends on
              whether the surface can establish who is asking:

                · a BUTTON when `onLike` is supplied AND the wire told us this
                  player's state (`liked` present). Both are required — without
                  `liked` the button could only guess its own starting state, and
                  a heart that looks empty on something you liked yesterday
                  invites a press the server then refuses.
                · plain TEXT otherwise.

              "Never a control that cannot succeed" is the rule this implements.
              It is also the honest rendering of the backend's contract: v2 omits
              `liked` precisely when no identity was asserted, so an absent flag
              IS "we cannot act for anybody here".
            */}
            <Show
              when={props.onLike && props.item.liked !== undefined}
              fallback={
                <span class="text-sm mp-muted flex items-center gap-1">
                  <IconHeart class="w-3 h-3" />
                  {props.item.likes}
                </span>
              }
            >
              <NuiButton
                class="mp-action mp-like"
                aria-label={props.item.liked ? "Remove your like" : "Like this item"}
                // ⚠️ `aria-pressed` and not a visual-only state. This is a
                // toggle, and the filled-versus-outline distinction is the only
                // thing a sighted user has; a screen reader needs the attribute.
                aria-pressed={props.item.liked ? "true" : "false"}
                aria-busy={props.likePending ? "true" : "false"}
                disabled={props.likePending}
                // ⚠️ The NEXT state, computed from the current one, rather than
                // a bare "toggle". The handler is therefore idempotent on
                // retry, which matters because the round trip is NUI → Lua →
                // game server → HTTP and can time out with the write already
                // committed.
                onClick={() => props.onLike?.(!props.item.liked)}
                title={props.item.liked ? "You like this" : "Like this item"}
              >
                <Show
                  when={props.likePending}
                  fallback={
                    <IconHeart
                      class="w-3 h-3"
                      // ⚠️ `currentColor` fill rather than a `fill-*` utility
                      // class: this component ships into CEF 103 NUI frames, a
                      // browser, and a Workers-rendered page, and the only
                      // colour contract it is allowed to use is the `--nui-*`
                      // layer that `currentColor` already resolves through.
                      fill={props.item.liked ? "currentColor" : "none"}
                    />
                  }
                >
                  <IconLoaderCircle class="w-3 h-3 animate-spin" />
                </Show>
                {props.item.likes}
              </NuiButton>
            </Show>
          </Show>
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
