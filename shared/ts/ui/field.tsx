import type { JSX } from "@solidjs/web";
import { cn } from "@tlib/shared/cn";
import { Show } from "solid-js";

/**
 * A caption, its control, and an optional line of explanation under it.
 *
 * The explanation is a first-class SLOT rather than a `title=` attribute, and that
 * is a NUI constraint rather than a preference: inside the game the cursor is the
 * game's and there is no OS tooltip to fall back on, so a hint that only exists on
 * hover is a hint nobody in the editor ever reads.
 *
 * Styling is `.section-label` and `.field-hint` from
 * `@tlib/shared/css/surface.css`, which the consumer must import. Both are on the
 * 11px floor at full `--muted-foreground`; see the scale at the top of that file
 * for why neither is smaller or dimmer.
 */
export function Field(props: {
  label: string;
  icon?: () => JSX.Element;
  hint?: string;
  /** Rendered hard against the right of the caption row — a counter, a value readout. */
  trailing?: JSX.Element;
  class?: string;
  children: JSX.Element;
}) {
  return (
    <div class={cn("flex flex-col gap-1.5", props.class)}>
      <div class="flex items-center justify-between gap-2">
        <span class="section-label font-mono">
          <Show when={props.icon}>{(icon) => icon()()}</Show>
          {props.label}
        </span>
        <Show when={props.trailing}>{props.trailing}</Show>
      </div>
      {props.children}
      <Show when={props.hint}>
        <p class="field-hint">{props.hint}</p>
      </Show>
    </div>
  );
}

/**
 * A titled block inside a panel. `Field` groups a control; this groups Fields.
 *
 * The title is `.section-label` promoted to `--foreground`, so a section heading
 * and the captions under it are the same typeface and size and differ only in
 * weight of colour. That is the whole hierarchy — it does not need a third step.
 */
export function Section(props: {
  title: string;
  icon?: () => JSX.Element;
  class?: string;
  children: JSX.Element;
}) {
  return (
    <section class={cn("flex flex-col gap-2.5", props.class)}>
      <h3 class="section-label m-0 !text-foreground">
        <Show when={props.icon}>{(icon) => icon()()}</Show>
        {props.title}
      </h3>
      {props.children}
    </section>
  );
}

export default Field;
