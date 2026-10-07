import { Show } from "solid-js";
import IconDownload from "~icons/lucide/download";
import IconEye from "~icons/lucide/eye";
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
        <span class="text-sm mp-muted">{props.item.downloads} installs</span>

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
