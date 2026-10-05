import { Eye, EyeOff } from "lucide-solid";
import { For, Show } from "solid-js";
import { NuiButton } from "@/components/ui/nui-field";
import type { Component, Layout } from "@tlib/shared/hud-geometry";

const anchorLabel = (anchor: Layout["anchor"]) =>
  anchor === "center" ? "the centre" : `the ${anchor.replace("-", " ")}`;

/**
 * Everything the panel still needs to say. Selecting a row is the only reason
 * the list exists as a control: a widget dragged mostly off screen, or hidden,
 * is still findable here.
 */
export default function ComponentList(props: {
  components: Component[];
  layoutOf: (component: Component) => Layout;
  selected: string;
  finishing: boolean;
  onSelect: (key: string) => void;
  onToggleVisible: (component: Component) => void;
}) {
  const active = () => props.components.find((component) => component.key === props.selected);
  return (
    <Show
      when={props.components.length}
      fallback={<p class="tlib-layout__empty">No HUD components registered.</p>}
    >
      <ul class="tlib-layout__list">
        <For each={props.components}>
          {(component) => {
            const layout = () => props.layoutOf(component);
            const selected = () => props.selected === component.key;
            return (
              <li class={["tlib-layout__row", { "tlib-layout__row--selected": selected() }]}>
                <button
                  type="button"
                  class="tlib-layout__row-select"
                  aria-current={selected() ? "true" : undefined}
                  onClick={() => props.onSelect(component.key)}
                >
                  <span class="tlib-layout__row-name">{component.label}</span>
                  <span class="tlib-layout__row-owner">{component.owner}</span>
                </button>
                <NuiButton
                  class="tlib-layout__row-visible"
                  disabled={props.finishing || !component.canHide}
                  aria-label={
                    layout().visible ? `Hide ${component.label}` : `Show ${component.label}`
                  }
                  title={
                    component.canHide
                      ? layout().visible
                        ? "Hide component"
                        : "Show component"
                      : "This component cannot be hidden"
                  }
                  onClick={() => props.onToggleVisible(component)}
                >
                  <Show when={layout().visible} fallback={<EyeOff aria-hidden="true" />}>
                    <Eye aria-hidden="true" />
                  </Show>
                </NuiButton>
              </li>
            );
          }}
        </For>
      </ul>
      {/* Anchoring is derived from where you drop it, so it is reported, not chosen. */}
      <Show when={active()}>
        {(component) => (
          <p class="tlib-layout__pinned">
            Stays in {anchorLabel(props.layoutOf(component()).anchor)} at other resolutions
          </p>
        )}
      </Show>
    </Show>
  );
}
