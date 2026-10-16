import { cn } from "@tlib/shared/cn";
import type { Component } from "solid-js";
import { createSignal, For, Show } from "solid-js";
import IconExternalLink from "~icons/lucide/external-link";
import IconHouse from "~icons/lucide/house";
import IconLink from "~icons/lucide/link";
import { Button } from "./button";
import { createPopoverState, Popover, PopoverContent, PopoverTrigger } from "./popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";
import "./export-badge.css";

/**
 * ExportBadge — the Discovery config-export control, shared because tELS and tRadio
 * had each written it against the same producer, `sv_discovery.lua`'s
 * `inst:getExportTargets()`.
 *
 * Three constraints that are invisible from the code:
 *
 * - Focus is an `outline`, never a ring: presetWind3 compiles the ring family to a
 *   `box-shadow`, which CEF 103 clips to nothing inside the `overflow: hidden`
 *   panels both hosts use. The offset must stay the NEGATIVE spelling, because
 *   `unocss-merge` annihilates a positive one against the outline colour.
 * - There is no Escape handler here on purpose. Ark's dismissable layer calls
 *   `preventDefault()` on the keydown unconditionally, which is the channel the
 *   escape registry reads, so adding one produces two dismissals per press.
 * - Never pass an `id` to a `Popover*`/`Tooltip*` part — it replaces zag's
 *   generated one and Escape, outside-click and focus management die silently.
 *
 * Convergence history and the rest: docs/internal/export-badge.md
 */

/** Exactly one row of `inst:getExportTargets()` in `tLib/server/sv_discovery.lua`. */
export interface ExportTarget {
  /** The resource name. */
  name: string;
  /** The resource DECLARES the Discovery metadata key in its fxmanifest. */
  hasMetadata: boolean;
  /** The owning resource itself, which that function always lists first. */
  isLocal?: boolean;
}

export type ExportBadgeStringKey =
  | "export_label"
  | "export_title"
  | "export_source_tooltip"
  | "export_filter_placeholder"
  | "export_no_resources"
  | "export_local_suffix"
  | "export_confirm_prefix"
  | "export_cancel_btn"
  | "export_confirm_btn";

/**
 * English for every string this control can show. tLib must not own a consumer's
 * locale file, so the component takes a translator and falls back to these: a
 * missing translation is a cosmetic gap, never a blank control.
 */
export const DEFAULT_EXPORT_BADGE_STRINGS: Record<ExportBadgeStringKey, string> = {
  export_label: "Export",
  export_title: "Export config to another resource",
  export_source_tooltip:
    "Config loaded from this resource. Saves are stored as local overrides — the source resource is not modified.",
  export_filter_placeholder: "Filter resources...",
  export_no_resources: "No resources found",
  export_local_suffix: "(local)",
  export_confirm_prefix: "Move config to",
  export_cancel_btn: "Cancel",
  export_confirm_btn: "Confirm",
};

export type ExportBadgeTranslate = (key: ExportBadgeStringKey) => string | undefined;

/**
 * The longest list the picker renders. Past this a popover stops being a picker and
 * starts being a directory listing; a server with more started resources than this
 * is expected to type into the filter.
 */
const MAX_TARGETS = 30;

/**
 * The focus affordance, as one constant so there is one place to read it. Four
 * tokens and the negative offset spelling — see the header for why.
 */
const FOCUS_RING =
  "outline-none focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring/40 focus-visible:-outline-offset-1";

export interface ExportBadgeProps {
  /**
   * The resource this config was loaded FROM, or null/undefined for a local one.
   * Renders the source chip.
   */
  externalSource?: string | null;
  /** `inst:getExportTargets()`'s rows, as delivered to the host. */
  targets: ExportTarget[];
  /**
   * The picker has opened. Fetch the targets here rather than keeping a live list,
   * because a resource can start or stop between two openings.
   */
  onRequestTargets: () => void;
  /** Confirmed. Move this config into `targetResource`. */
  onExport: (targetResource: string) => void;
  /** Host translator. Falls back to `DEFAULT_EXPORT_BADGE_STRINGS` per key. */
  translate?: ExportBadgeTranslate;
  /**
   * Render the word "Export" beside the glyph. Default false — the icon-only
   * form, which is what a space-constrained toolbar slot needs.
   */
  showLabel?: boolean;
  /**
   * Which edge the badge is tabbed from. `"top"` rounds the top corners (a tab
   * rising out of a header, tELS); `"bottom"` rounds the bottom corners and
   * drops the top border (a tab hanging below one, tRadio). Default `"top"`.
   */
  edge?: "top" | "bottom";
  class?: string;
}

/**
 * Wraps a host translator so an untranslated key falls through to English. An
 * empty string counts as untranslated: a key present but blank is how a
 * translation is commonly half-done, and rendering "" loses the control.
 *
 * It cannot rescue a translator that answers with the KEY NAME when a string is
 * missing; such a host has to carry the key itself.
 */
export function makeExportBadgeTranslator(
  translate?: ExportBadgeTranslate
): (key: ExportBadgeStringKey) => string {
  return (key) => {
    const value = translate?.(key);
    if (typeof value === "string" && value !== "") return value;
    return DEFAULT_EXPORT_BADGE_STRINGS[key];
  };
}

export const ExportBadge: Component<ExportBadgeProps> = (props) => {
  const popover = createPopoverState();
  const [filter, setFilter] = createSignal("");
  const [confirming, setConfirming] = createSignal<string | null>(null);
  const T = () => makeExportBadgeTranslator(props.translate);

  const filtered = (): ExportTarget[] => {
    const q = filter().toLowerCase();
    const targets = props.targets;
    if (!q) return targets.slice(0, MAX_TARGETS);
    return targets.filter((t) => t.name.toLowerCase().includes(q)).slice(0, MAX_TARGETS);
  };

  function doExport(targetResource: string) {
    props.onExport(targetResource);
    popover.close();
    setConfirming(null);
  }

  return (
    <div
      class={cn("tlib-export-badge flex items-center gap-0.5", props.class)}
      data-edge={props.edge ?? "top"}
    >
      {/* The source chip */}
      <Show when={props.externalSource}>
        <Tooltip openDelay={200}>
          <TooltipTrigger
            asChild={(triggerProps) => (
              <span
                {...triggerProps()}
                class="tlib-export-chip flex items-center gap-1 font-mono bg-blue-500/15 text-blue-400 border border-blue-500/20"
              >
                <IconLink aria-hidden="true" />
                {props.externalSource}
              </span>
            )}
          />
          <TooltipContent>{T()("export_source_tooltip")}</TooltipContent>
        </Tooltip>
      </Show>

      {/* The trigger and its picker */}
      <Popover
        open={popover.isOpen()}
        onOpenChange={(e) => {
          popover.setOpen(e.open);
          if (e.open) {
            props.onRequestTargets();
            setFilter("");
            setConfirming(null);
          }
        }}
        positioning={{ placement: "bottom-end", offset: { mainAxis: 4 } }}
        closeOnInteractOutside
        closeOnEscape
      >
        <PopoverTrigger
          /* The stable handle `propeditor-gallery.ts` finds this control by. It
             used to match "the svg-only button", which stopped being unique when
             the toolbar gained an icon-only undo/redo pair. A glyph is not an
             identity; this is. */
          data-export-trigger=""
          class={`tlib-export-trigger flex items-center gap-1 font-mono font-semibold cursor-pointer bg-card/95 border border-border/60 text-muted-foreground hover:bg-secondary hover:text-foreground ${FOCUS_RING}`}
          title={T()("export_title")}
          aria-label={T()("export_title")}
        >
          <IconExternalLink aria-hidden="true" />
          <Show when={props.showLabel}>
            <span>{T()("export_label")}</span>
          </Show>
        </PopoverTrigger>

        <PopoverContent class="!w-64 !p-0" showArrow={false}>
          {/* Confirming MOVES this config out of the resource that owns it, so
              Cancel leads. Nothing is reordered by CSS: source order is keyboard
              order. */}
          <Show when={confirming()}>
            <div class="tlib-export-confirm p-3 space-y-2">
              <p class="text-foreground">
                {T()("export_confirm_prefix")}{" "}
                <span class="font-semibold text-blue-400">{confirming()}</span>?
              </p>
              <div class="flex gap-1">
                <Button
                  variant="secondary"
                  size="sm"
                  class="!h-7"
                  onClick={() => setConfirming(null)}
                >
                  {T()("export_cancel_btn")}
                </Button>
                <Button
                  size="sm"
                  class="!h-7"
                  // biome-ignore lint/style/noNonNullAssertion: non-null inside <Show when={confirming()}>
                  onClick={() => doExport(confirming()!)}
                >
                  {T()("export_confirm_btn")}
                </Button>
              </div>
            </div>
          </Show>

          {/* Filter and list */}
          <Show when={!confirming()}>
            <div class="p-1.5 border-b border-border">
              {/* `prop-input` is the shared input surface and already carries the
                  focus outline, so this field needs no FOCUS_RING of its own.
                  `type="text"` is explicit because the gallery finds the open
                  picker with `input[type="text"]`, which the implicit default does
                  not satisfy. */}
              <input
                type="text"
                class="prop-input w-full"
                placeholder={T()("export_filter_placeholder")}
                value={filter()}
                onInput={(e) => setFilter(e.currentTarget.value)}
                autofocus
              />
            </div>
            <div class="max-h-48 overflow-y-auto">
              <For
                each={filtered()}
                fallback={
                  <p class="tlib-export-empty px-3 py-2 text-muted-foreground">
                    {T()("export_no_resources")}
                  </p>
                }
              >
                {(target) => (
                  <button
                    type="button"
                    data-export-target={target.name}
                    class={`tlib-export-row w-full text-left font-mono flex items-center gap-1.5 text-foreground hover:bg-secondary/60 ${FOCUS_RING}${
                      target.isLocal ? " border-b border-border/30" : ""
                    }`}
                    onClick={() => setConfirming(target.name)}
                  >
                    {/* The owning resource, one that declares the metadata key, and
                        one that does not. The third is a gutter rather than
                        nothing, so the names stay in one column. */}
                    <Show when={target.isLocal}>
                      <IconHouse aria-hidden="true" class="text-green-400" />
                    </Show>
                    <Show when={!target.isLocal && target.hasMetadata}>
                      <IconLink aria-hidden="true" class="text-blue-400" />
                    </Show>
                    <Show when={!target.isLocal && !target.hasMetadata}>
                      <span class="tlib-export-row-gutter" />
                    </Show>
                    <span>
                      {target.isLocal
                        ? `${target.name} ${T()("export_local_suffix")}`
                        : target.name}
                    </span>
                  </button>
                )}
              </For>
            </div>
          </Show>
        </PopoverContent>
      </Popover>
    </div>
  );
};

export default ExportBadge;
