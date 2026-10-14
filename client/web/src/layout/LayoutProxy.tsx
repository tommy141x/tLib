import {
  type Component,
  type Corner,
  type Layout,
  layoutRect,
  type Viewport,
} from "@tlib/shared/hud-geometry";
import { Eye, EyeOff } from "lucide-solid";
import { createMemo, For, Show } from "solid-js";
import { NuiButton } from "@/components/ui/nui-field";

const corners: Corner[] = ["nw", "ne", "sw", "se"];

/**
 * The grab target for one registered widget. tLib owns these outlines; the real
 * HUD keeps rendering in its own resource's NUI behind them.
 *
 * Position rides on `transform` so a drag never relayouts the page, while size
 * stays in `width`/`height` so the label does not scale with the widget.
 */
export default function LayoutProxy(props: {
  component: Component;
  layout: Layout;
  viewport: Viewport;
  selected: boolean;
  scaling: boolean;
  finishing: boolean;
  onGrab: (event: PointerEvent, component: Component, corner?: Corner) => void;
  onWheel: (event: WheelEvent, component: Component) => void;
  onToggleVisible: (component: Component) => void;
}) {
  const rect = createMemo(() => layoutRect(props.component, props.layout, props.viewport));
  const label = () => props.component.label;
  return (
    <div
      class={[
        "tlib-layout__proxy",
        {
          "tlib-layout__proxy--selected": props.selected,
          "tlib-layout__proxy--hidden": !props.layout.visible,
        },
      ]}
      style={{
        width: `${rect().width}px`,
        height: `${rect().height}px`,
        transform: `translate3d(${rect().left}px, ${rect().top}px, 0)`,
      }}
      onPointerDown={(event) => props.onGrab(event, props.component)}
      onWheel={(event) => props.onWheel(event, props.component)}
      aria-label={`${label()}${props.layout.visible ? "" : " (hidden)"}`}
    >
      <Show when={props.component.owner === "tLib" && props.component.id === "demo"}>
        <div class="tlib-layout__demo">
          <strong>TEST HUD</strong>
          <div>
            108 <small>KM/H</small>
          </div>
          <span>
            HEALTH <i /> 100%
          </span>
        </div>
      </Show>
      <div class="tlib-layout__tag">
        <span>{label()}</span>
        <Show when={props.component.canHide}>
          <NuiButton
            disabled={props.finishing}
            aria-label={props.layout.visible ? `Hide ${label()}` : `Show ${label()}`}
            title={props.layout.visible ? "Hide component" : "Show component"}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => props.onToggleVisible(props.component)}
          >
            <Show when={props.layout.visible} fallback={<EyeOff aria-hidden="true" />}>
              <Eye aria-hidden="true" />
            </Show>
          </NuiButton>
        </Show>
      </div>
      {/* Only while it is actually changing: a permanent readout is noise. */}
      <Show when={props.scaling}>
        <span class="tlib-layout__scale-badge" role="status">
          {Math.round(props.layout.scale * 100)}%
        </span>
      </Show>
      <Show when={props.selected && props.component.canScale}>
        <For each={corners}>
          {(corner) => (
            <div
              class={`tlib-layout__handle tlib-layout__handle--${corner}`}
              onPointerDown={(event) => props.onGrab(event, props.component, corner)}
            />
          )}
        </For>
      </Show>
    </div>
  );
}
