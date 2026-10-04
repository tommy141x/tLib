import { For, Show } from "solid-js";
import IconDownload from "~icons/lucide/download";
import IconLoaderCircle from "~icons/lucide/loader-circle";
import IconSearch from "~icons/lucide/search";
import IconTrash2 from "~icons/lucide/trash-2";
import { NuiButton } from "../../nui-kit/NuiButton";
import { InstallError } from "./InstallError";
import { inspectableIdentity } from "./inspection";
import {
  formatBytes,
  type InspectionState,
  type InstalledSound,
  type InstallState,
  type MarketplaceItem,
} from "./types";

interface InstalledEntry {
  key: string;
  displayName: string;
  item: MarketplaceItem | null;
  slug: string | null;
  installState: InstallState;
}

export function InstalledTab(props: {
  marketplaceItems: MarketplaceItem[];
  installedLayouts: string[];
  installedSounds: InstalledSound[];
  installStates: Record<string, InstallState>;
  loading: boolean;
  resource: string | null;
  inspection: InspectionState | null;
  onInspect: (type: "ui" | "sound", slug: string, name: string) => void;
  onInstall: (item: MarketplaceItem) => void;
  onUninstallBySlug: (type: "ui" | "sound", slug: string) => void;
}) {
  const mpBySlug = () => new Map(props.marketplaceItems.map((i) => [i.slug, i]));

  const uiEntries = (): InstalledEntry[] => {
    const bySlug = mpBySlug();
    const states = props.installStates;
    return props.installedLayouts
      .filter((name) => {
        const s = states[name];
        return !s || s.state !== "idle";
      })
      .map((name) => ({
        key: name,
        displayName: bySlug.get(name)?.name ?? name,
        item: bySlug.get(name) ?? null,
        slug: name in states ? name : null,
        installState: states[name] ?? { state: "installed" },
      }));
  };

  const soundEntries = (): InstalledEntry[] => {
    const bySlug = mpBySlug();
    const states = props.installStates;
    return props.installedSounds
      .filter((s) => {
        if (!s.slug) return true;
        const st = states[s.slug];
        return !st || st.state !== "idle";
      })
      .map((s) => ({
        key: s.filename,
        displayName: bySlug.get(s.slug)?.name ?? s.filename,
        item: bySlug.get(s.slug) ?? null,
        slug: s.slug || null,
        installState: (s.slug ? states[s.slug] : null) ?? { state: "installed" },
      }));
  };

  const hasAnything = () => uiEntries().length > 0 || soundEntries().length > 0;

  return (
    <Show
      when={!props.loading}
      fallback={
        <div class="flex items-center justify-center h-40 mp-muted">
          <IconLoaderCircle class="w-4 h-4 animate-spin" />
          <span role="status">Loading items…</span>
        </div>
      }
    >
      <Show
        when={hasAnything()}
        fallback={
          <div class="flex items-center justify-center h-40 text-sm mp-muted">
            Nothing installed.
          </div>
        }
      >
        <div class="flex flex-col gap-5">
          <Show when={uiEntries().length > 0}>
            <section class="flex flex-col gap-2">
              <span class="text-sm mp-muted">UIs</span>
              <div class="mp-grid">
                <For each={uiEntries()}>
                  {(e) => {
                    const mpItem = e.item;
                    return (
                      <InstalledItemCard
                        name={e.displayName}
                        item={mpItem}
                        installState={e.installState}
                        onInstall={mpItem ? () => props.onInstall(mpItem) : undefined}
                        onDelete={
                          e.slug ? () => props.onUninstallBySlug("ui", e.slug as string) : undefined
                        }
                        onInspect={
                          inspectableIdentity(props.resource, e.key)
                            ? () => props.onInspect("ui", e.key, e.displayName)
                            : undefined
                        }
                        inspectionBusy={props.inspection?.state === "loading"}
                        inspection={
                          props.inspection?.request.type === "ui" &&
                          props.inspection.request.slug === e.key
                            ? props.inspection
                            : null
                        }
                      />
                    );
                  }}
                </For>
              </div>
            </section>
          </Show>

          <Show when={soundEntries().length > 0}>
            <section class="flex flex-col gap-2">
              <span class="text-sm mp-muted">Sounds</span>
              <div class="mp-grid">
                <For each={soundEntries()}>
                  {(e) => {
                    const mpItem = e.item;
                    return (
                      <InstalledItemCard
                        name={e.displayName}
                        item={mpItem}
                        installState={e.installState}
                        onInstall={mpItem ? () => props.onInstall(mpItem) : undefined}
                        onDelete={
                          e.slug
                            ? () => props.onUninstallBySlug("sound", e.slug as string)
                            : undefined
                        }
                        onInspect={
                          inspectableIdentity(props.resource, e.slug)
                            ? () => props.onInspect("sound", e.slug!, e.displayName)
                            : undefined
                        }
                        inspectionBusy={props.inspection?.state === "loading"}
                        inspection={
                          props.inspection?.request.type === "sound" &&
                          props.inspection.request.slug === e.slug
                            ? props.inspection
                            : null
                        }
                      />
                    );
                  }}
                </For>
              </div>
            </section>
          </Show>
        </div>
      </Show>
    </Show>
  );
}

function InstalledItemCard(props: {
  name: string;
  item: MarketplaceItem | null;
  installState: InstallState;
  onInstall?: () => void;
  onDelete?: () => void;
  onInspect?: () => void;
  inspectionBusy: boolean;
  inspection: InspectionState | null;
}) {
  const s = () => props.installState;
  const busy = () => s().state === "installing" || s().state === "uninstalling";
  const managementBlocked = () => {
    const state = props.inspection;
    return state !== null && (state.state !== "ready" || state.summary.managementBlocked);
  };

  return (
    <div class="mp-card">
      <div class="flex items-start justify-between gap-2">
        <div class="flex flex-col min-w-0">
          <span class="text-sm font-semibold mp-fg truncate">{props.name}</span>
          <Show when={props.item}>
            {(item) => (
              <span class="text-sm mp-muted truncate">
                by {item().creator_name}
                {item().current_version ? ` · v${item().current_version}` : ""}
              </span>
            )}
          </Show>
        </div>
        <Show when={props.item?.size_bytes}>
          {(size) => <span class="text-sm mp-muted shrink-0">{formatBytes(size())}</span>}
        </Show>
      </div>

      <Show when={props.item?.description}>
        {(desc) => <p class="text-sm mp-muted line-clamp-2">{desc()}</p>}
      </Show>

      <Show
        when={props.inspection}
        fallback={
          <p class="mp-inspection-note">
            {props.onInspect
              ? "Ownership not checked. Inspection is read-only."
              : "Inspection unavailable: this local name has no supported marketplace identity. Files are unchanged."}
          </p>
        }
      >
        {(state) => <InspectionStatus value={state()} />}
      </Show>
      <NuiButton
        class="mp-action mp-inspect"
        disabled={busy() || props.inspectionBusy || !props.onInspect}
        aria-label={`Inspect installation: ${props.name}`}
        onClick={props.onInspect}
      >
        <Show when={props.inspection?.state === "loading"} fallback={<IconSearch />}>
          <IconLoaderCircle class="animate-spin" />
        </Show>
        {props.inspection?.state === "loading"
          ? "Inspecting…"
          : props.inspection
            ? "Inspect again"
            : "Inspect installation"}
      </NuiButton>

      <InstallError state={s()} />

      <div class="mp-card-footer">
        <span class="text-sm mp-muted">{props.item ? `${props.item.downloads} installs` : ""}</span>
        <div class="flex items-center gap-1">
          <Show when={props.onDelete}>
            {(onDelete) => (
              <NuiButton
                class="mp-action mp-delete"
                aria-label="Delete from server"
                disabled={busy() || managementBlocked()}
                aria-busy={busy() ? "true" : "false"}
                onClick={onDelete}
                title="Delete from server"
              >
                <Show when={s().state === "uninstalling"} fallback={<IconTrash2 class="w-3 h-3" />}>
                  <IconLoaderCircle class="w-3 h-3 animate-spin" />
                </Show>
                <Show when={s().state === "uninstalling"}>Deleting…</Show>
              </NuiButton>
            )}
          </Show>
          <Show when={props.onInstall}>
            {(onInstall) => (
              <NuiButton
                class="mp-action"
                tone={s().state === "installed" ? "default" : "primary"}
                disabled={busy() || managementBlocked()}
                aria-busy={busy() ? "true" : "false"}
                onClick={onInstall}
              >
                <Show when={s().state === "installing"} fallback={<IconDownload class="w-3 h-3" />}>
                  <IconLoaderCircle class="w-3 h-3 animate-spin" />
                </Show>
                {s().state === "installing" ? "Installing…" : "Reinstall"}
              </NuiButton>
            )}
          </Show>
        </div>
      </div>
    </div>
  );
}

function InspectionStatus(props: { value: InspectionState }) {
  const summary = () => {
    const value = props.value;
    return value.state === "ready" ? value.summary : null;
  };
  return (
    <div
      class="mp-inspection"
      role="status"
      aria-live="polite"
      aria-label={`Installation status: ${props.value.name}`}
    >
      <Show when={props.value.state === "loading"}>
        <strong>Checking installation</strong>
        <p>Reading local ownership and file state. No files are changed.</p>
      </Show>
      <Show when={props.value.state === "error"}>
        <strong>Inspection unavailable</strong>
        <p>
          No ownership conclusion was made. Check your admin permission and resource compatibility,
          then try again. Files are unchanged.
        </p>
      </Show>
      <Show when={summary()}>
        {(value) => (
          <>
            <strong>{value().label}</strong>
            <p>{value().description}</p>
            <Show when={value().policyUnavailable}>
              <p>Trusted built-in inventory is unavailable. Legacy adoption remains disabled.</p>
            </Show>
            <p class="mp-inspection-note">
              Read-only snapshot. Write operations still recheck ownership on the server.
            </p>
          </>
        )}
      </Show>
    </div>
  );
}
