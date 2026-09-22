import { Show } from "solid-js";
import { NuiCheckbox, NuiRange, NuiRangeValue } from "../../components/ui/nui-controls";
import { t } from "../i18n";
import { FormattedText, plainText } from "../text";
import type { MenuItem } from "../types";
import { Ban, ChevronLeft, ChevronRight, LoaderCircle } from "./lucide";
import { MenuIcon } from "./MenuIcon";

interface Props {
  item: MenuItem;
  active: boolean;
  pending: boolean;
  // Set only while a toggle's own action is in flight, so the checkmark reflects
  // the press immediately instead of waiting for the game to answer.
  toggleValue?: boolean;
  optionLabel?: string;
  optionIcon?: string;
  sliderValue?: number;
  onSliderInput: (value: number) => void;
  onSelect: () => void;
  onActivate: () => void;
  onCycle: (direction: number) => void;
}

// Source marks a submenu by writing "→→→" into the row's own right label, and
// *withholds* it (showing a LOCK instead) to mean "this branch is empty". tMenu
// keeps that signal but not that glyph: the arrows are stripped here and drawn
// as the same chevron every other submenu row uses, so a row that happens to
// carry the literal cannot look different from one that does not. The emptiness
// signal survives untouched, because it is carried by `disabled` + LOCK rather
// than by the arrows. The literal stays in the catalog, so parity still pins it.
const SUBMENU_ARROWS = /\s*→+\s*$/;
// Some labels are only partly arrows — "(adder) →→→", "Server #3 →→→" — so the
// run is stripped off the end rather than the whole string being compared.
const stripArrows = (label?: string) => label?.replace(SUBMENU_ARROWS, "") ?? "";

export function MenuRow(props: Props) {
  const on = () => Boolean(props.toggleValue ?? props.item.value);
  const rightLabel = () => stripArrows(props.item.rightLabel);
  const markedSubmenu = () => SUBMENU_ARROWS.test(props.item.rightLabel ?? "");
  // 'NONE' is a real catalog value meaning "no icon", and MenuIcon already draws
  // nothing for it — but as a non-empty string it still reads as truthy, which
  // used to suppress the chevron on every populated vehicle class.
  const rightIcon = () => {
    const name = props.optionIcon ?? props.item.rightIcon;
    return name && name.toUpperCase() !== "NONE" ? name : undefined;
  };
  // FormattedText translates the visible text for itself; the accessible name and
  // the tooltip are built from strings rather than rendered, so they ask here.
  const name = () => plainText(t(props.item.label));
  // The filled share, 0-1, computed here rather than written into an inline
  // gradient: the shared slider takes a token. A row with no bounds (or with
  // min == max) has nothing to fill, and 0 is the only honest answer.
  const sliderFill = () => {
    const min = props.item.min ?? 0,
      span = (props.item.max ?? 100) - min;
    return span > 0 ? ((props.sliderValue ?? min) - min) / span : 0;
  };
  // MenuAPI lets a row colour its own bar. One token now, rather than the whole
  // gradient plus a `color` on the wrapper the thumb used to read through.
  const barColor = () => {
    const bar = props.item.barColor;
    return bar ? `rgb(${bar.r}, ${bar.g}, ${bar.b})` : undefined;
  };
  return (
    <div
      class="menu-row"
      aria-busy={props.pending || undefined}
      classList={{
        "is-active": props.active,
        "is-disabled": props.item.disabled,
        "is-pending": props.pending,
        "is-danger": props.item.danger,
        "is-status": props.item.kind === "status",
      }}
    >
      <Show
        when={props.item.kind !== "status"}
        fallback={
          <div class="row-status">
            <FormattedText text={props.item.label} />
          </div>
        }
      >
        <button
          id={`item-${encodeURIComponent(props.item.id)}`}
          class="row-main"
          type="button"
          aria-current={props.active ? "true" : undefined}
          aria-pressed={props.item.kind === "toggle" ? on() : undefined}
          title={name()}
          aria-disabled={props.item.disabled || props.pending}
          aria-label={
            props.item.kind === "toggle"
              ? t(on() ? "{{ label }}, on" : "{{ label }}, off", { label: name() })
              : name()
          }
          onFocus={props.onSelect}
          onPointerMove={(event) => {
            if (event.movementX || event.movementY) props.onSelect();
          }}
          onClick={props.onActivate}
        >
          <Show when={props.item.icon}>
            <MenuIcon name={props.item.icon!} selected={props.active} />
          </Show>
          <span class="row-label truncate">
            <FormattedText text={props.item.label} />
          </span>
          <Show when={rightLabel()}>
            <span class="row-right-label">
              <FormattedText text={rightLabel()} />
            </span>
          </Show>
          <Show when={rightIcon()}>
            <MenuIcon name={rightIcon()!} selected={props.active} />
          </Show>
          {/* A row earns the chevron by being a submenu, or by having carried the
            arrows the catalog writes by hand. An explicit right icon still wins —
            that is how an empty branch shows its LOCK and no marker at all. */}
          <Show
            when={
              (props.item.kind === "submenu" || Boolean(props.item.nextMenu) || markedSubmenu()) &&
              !rightIcon()
            }
          >
            <span aria-hidden="true" class="row-chevron">
              <ChevronRight />
              <ChevronRight />
              <ChevronRight />
            </span>
          </Show>
          {/* Presentational only: the row's own button already carries aria-pressed
            and owns the press, so the checkbox is drawn, not operated. Same box,
            radius and glyph as a dialog's checkbox — see nui-controls. */}
          <Show when={props.item.kind === "toggle"}>
            <NuiCheckbox class="toggle" checked={on()} />
          </Show>
          {/* Only reserve the mark's width when it actually has a glyph, otherwise every
            action row's right-hand label is pushed 25px off the edge. */}
          <Show when={props.item.kind === "action" && (props.pending || props.item.disabled)}>
            <span class="action-mark" aria-hidden="true">
              <Show when={props.pending} fallback={<Ban />}>
                <LoaderCircle />
              </Show>
            </span>
          </Show>
        </button>
      </Show>
      <Show when={props.item.kind === "slider"}>
        {/* Still a native range, and deliberately so: it is the one slider shape
            that stays keyboard-reachable without putting a focusable widget the
            menu's navigation does not know about inside a row. The look is the
            shared one. `color` on the wrapper carries a bar colour through to
            the readout, as it always has. */}
        <div class="row-slider" style={barColor() ? { color: barColor() } : undefined}>
          <NuiRange
            aria-label={name()}
            min={props.item.min}
            max={props.item.max}
            step={props.item.step}
            value={props.sliderValue}
            fill={sliderFill()}
            color={barColor()}
            disabled={props.item.disabled || props.pending}
            onFocus={props.onSelect}
            onInput={(event) => {
              props.onSelect();
              props.onSliderInput(event.currentTarget.valueAsNumber);
            }}
          />
          <NuiRangeValue>{props.sliderValue}</NuiRangeValue>
        </div>
      </Show>
      <Show when={props.item.kind === "select" && props.item.display !== "list"}>
        <div class="row-choice">
          <button
            type="button"
            aria-label={t("Previous {{ label }}", { label: name() })}
            disabled={props.item.disabled || props.pending}
            onFocus={props.onSelect}
            onClick={() => {
              props.onSelect();
              props.onCycle(-1);
            }}
          >
            <ChevronLeft />
          </button>
          <button
            type="button"
            class="choice-value"
            disabled={props.item.disabled || props.pending}
            onFocus={props.onSelect}
            onClick={props.onActivate}
            title={t("Confirm selection")}
          >
            <FormattedText text={props.optionLabel} />
          </button>
          <button
            type="button"
            aria-label={t("Next {{ label }}", { label: name() })}
            disabled={props.item.disabled || props.pending}
            onFocus={props.onSelect}
            onClick={() => {
              props.onSelect();
              props.onCycle(1);
            }}
          >
            <ChevronRight />
          </button>
        </div>
      </Show>
    </div>
  );
}
