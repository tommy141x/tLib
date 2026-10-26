/**
 * The STANDALONE marketplace modal: backdrop, panel surface, title, close
 * button, and the `openMarketplace` / `closeMarketplace` NUI lifecycle.
 *
 * The browsing UI itself is no longer here — it is
 * `./marketplace/MarketplaceBrowser.tsx`, because it now has a second mount
 * that must NOT be a modal: `Dialog.tsx` renders the same component inside a
 * dialog tab declared `view: "marketplace"`. That header file explains the
 * split and why browse/preview/install go through Lua rather than fetch.
 *
 * This path stays because it is still how `exports.tLib:OpenMarketplace` opens
 * the marketplace with no host dialog around it — tRadio's in-game path.
 */

import type { OpenData } from "@tlib/shared/marketplace/ui";
// Lucide comes from `lucide-solid/icons/*` here, never `~icons/lucide`: this
// app bundles `lucide-solid` (deep per-icon paths; the barrel is ~400KB), but
// `shared/ts/**` consumers (tLS, tDetector, tRadar) have unplugin-icons and
// not `lucide-solid`. Rule: `~icons` in shared, the package in an app.
import IconStore from "lucide-solid/icons/store";
import IconX from "lucide-solid/icons/x";
import { createSignal, onCleanup, Show } from "solid-js";
import { fetchNui, onNuiEvent } from "@/lib/nui";
import { MarketplaceBrowser } from "./marketplace/MarketplaceBrowser";
import { NuiButton } from "./ui/nui-field";

export default function MarketplacePanel() {
  const [open, setOpen] = createSignal(false);
  const [data, setData] = createSignal<OpenData | null>(null);

  onCleanup(
    onNuiEvent<OpenData>("openMarketplace", (payload) => {
      // Order matters: the browser only applies a payload while it is active,
      // so it has to be open before the data lands.
      setOpen(true);
      setData(payload);
    })
  );

  onCleanup(
    onNuiEvent("closeMarketplace", () => {
      setOpen(false);
      setData(null);
    })
  );

  function handleClose() {
    setOpen(false);
    setData(null);
    void fetchNui("marketplaceClose", {});
  }

  return (
    <Show when={open()}>
      <div
        class="mp-backdrop"
        onClick={(e) => {
          if (e.target === e.currentTarget) handleClose();
        }}
      >
        <div
          class="tlib-nui-surface mp-panel tlib-nui-lit"
          role="dialog"
          aria-label="Marketplace"
          onClick={(e) => e.stopPropagation()}
        >
          <MarketplaceBrowser
            data={data()}
            active={open()}
            onEscape={handleClose}
            header={
              <span class="mp-title">
                <IconStore class="w-3 h-3 opacity-60" />
                Marketplace
                <Show when={data()?.resource}>
                  <span class="mp-resource">{data()?.resource}</span>
                </Show>
              </span>
            }
            headerActions={
              <NuiButton class="mp-close" aria-label="Close marketplace" onClick={handleClose}>
                <IconX class="w-3 h-3" />
              </NuiButton>
            }
          />
        </div>
      </div>
    </Show>
  );
}
