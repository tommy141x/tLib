import { Show } from "solid-js";
import IconDownload from "~icons/lucide/download";
import IconEye from "~icons/lucide/eye";
import IconLoaderCircle from "~icons/lucide/loader-circle";
import IconPlay from "~icons/lucide/play";
import IconTrash2 from "~icons/lucide/trash-2";
import { NuiButton } from "../../nui-kit/NuiButton";
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
  const installError = () => {
    const st = s();
    return st.state === "done" && !st.ok ? (st.error ?? "Could not install this item") : undefined;
  };
  const busy = () => s().state === "installing" || s().state === "uninstalling";
  const isInstalled = () => s().state === "installed";

  const installLabel = () => {
    const st = s();
    if (st.state === "installing") return "Installing…";
    if (st.state === "installed") return "Reinstall";
    if (st.state === "done" && !st.ok) return "Retry";
    return "Install";
  };

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

          <Show when={isInstalled() || s().state === "uninstalling"}>
            <NuiButton
              class="mp-action mp-delete"
              aria-label="Delete from server"
              disabled={busy()}
              aria-busy={busy()}
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
            aria-busy={busy()}
            onClick={props.onInstall}
            title={installError()}
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
