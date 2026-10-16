import { For, Match, Show, Switch } from "solid-js";
import IconDownload from "~icons/lucide/download";
import IconEye from "~icons/lucide/eye";
import IconHeart from "~icons/lucide/heart";
import IconLoaderCircle from "~icons/lucide/loader-circle";
import IconPlay from "~icons/lucide/play";
import IconTrash2 from "~icons/lucide/trash-2";
import { NuiButton } from "../../nui-kit/NuiButton";
import { CARD_COPY, cardIdentity, cardStats, likeAffordance, nextLikedState } from "../card-model";
import {
  BUILTIN_EXPLANATION,
  canInstall,
  canUninstall,
  INSTALL_ACTION_LABEL,
  installAction,
  installError,
  isBuiltin,
  isInstallBusy,
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
   * Toggle this player's like, or `undefined` if this host cannot. Optional on
   * purpose, and THE COUNT DOES NOT DEPEND ON IT: every surface shows the number,
   * and only a surface that can establish WHO is asking gets the button. The
   * argument is the state being asked FOR, not a toggle, so a retry after a
   * timeout cannot invert anything.
   */
  onLike?: (next: boolean) => void;
  /** True while a like round trip is in flight, so the control can say so. */
  likePending?: boolean;
}) {
  const s = () => props.installState;
  const errorMessage = () => installError(s());
  const busy = () => isInstallBusy(s());
  const removable = () => canUninstall(s());
  const builtin = () => isBuiltin(s());
  const installLabel = () => INSTALL_ACTION_LABEL[installAction(s())];

  // The card's content, from `../card-model`
  const identity = () => cardIdentity(props.item);
  const stats = () => cardStats(props.item).filter((stat) => stat.key !== "size");
  const like = () => likeAffordance(props.item, props.onLike !== undefined);
  // Through `cardStats` rather than off `item.size_bytes`, because `size_bytes`
  // goes through `num()` and so reads 0 both for "zero bytes" and for "nobody
  // measured this" — and this line printed a confident `0B` for the second. The
  // omit-a-zero rule is `cardStatsOf`'s, stated once there; `InstalledTab`
  // already guarded it by hand and this surface did not, so one catalogue item
  // described its own size two ways depending on which tab you were on.
  const size = () => cardStats(props.item).find((stat) => stat.key === "size")?.value;

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
        <Show when={size()}>
          {(bytes) => <span class="text-sm mp-muted shrink-0">{formatBytes(bytes())}</span>}
        </Show>
      </div>

      <Show when={identity().description}>
        <p class="text-sm mp-muted line-clamp-2">{identity().description}</p>
      </Show>

      <InstallError state={s()} />

      <div class="mp-card-footer">
        {/*
         */}
        <div class="mp-card-stats flex items-center gap-2 min-w-0">
          {/*
           */}
          <For each={stats()}>
            {(stat) => (
              <Switch>
                <Match when={stat.key === "downloads"}>
                  {/*
                   */}
                  <span class="text-sm mp-muted">{CARD_COPY.downloads(String(stat.value))}</span>
                </Match>

                <Match when={stat.key === "likes"}>
                  {/*
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
                      // only thing a sighted user has; a screen reader needs the
                      // attribute. A real string, not a boolean — under Solid 2
                      // `aria-pressed={true}` serialises to the empty string.
                      aria-pressed={props.item.liked ? "true" : "false"}
                      aria-busy={props.likePending ? "true" : "false"}
                      disabled={props.likePending}
                      // `nextLikedState` — the state being asked FOR, rather
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
                            // `currentColor` fill rather than a `fill-*`
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

          <Show when={removable()}>
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

          {/*
             STILL RENDERED FOR A BUILT-IN, as a disabled "Built in". The
            alternative considered was hiding it, and it is worse: the card would
            then carry a radio the owner can see in game, a preview button, and
            no statement at all about why it offers nothing. "Present, and not
            ours to remove" is a fact the card has to say out loud — this is the
            quiet built-in state the brief asked for, chosen over "installed
            minus the destructive action" precisely because that variant still
            reads as a thing the marketplace manages.

            `canInstall` folds `busy` in, so this is one predicate rather than
            `busy() || builtin()` spelled out on two surfaces.
          */}
          <NuiButton
            class="mp-action"
            tone={s().state === "installed" || builtin() ? "default" : "primary"}
            disabled={!canInstall(s())}
            aria-busy={busy() ? "true" : "false"}
            // `onClick` is dropped rather than guarded for a built-in: a
            // disabled NuiButton cannot be clicked, and a handler that is
            // present-but-refuses is a second place the rule can be got wrong.
            onClick={builtin() ? undefined : props.onInstall}
            title={builtin() ? BUILTIN_EXPLANATION : errorMessage()}
          >
            <Show
              when={s().state === "installing"}
              fallback={
                <Show when={!builtin()}>
                  <IconDownload class="w-3 h-3" />
                </Show>
              }
            >
              <IconLoaderCircle class="w-3 h-3 animate-spin" />
            </Show>
            {installLabel()}
          </NuiButton>
        </div>
      </div>
    </div>
  );
}
